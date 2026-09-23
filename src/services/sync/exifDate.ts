/**
 * Minimal JPEG EXIF reader — extracts the capture date and nothing else.
 *
 * Why not use the platform:
 *
 *  - Android MediaStore's `datetaken` is unreliable. Measured: NULL for 3 of 6
 *    test photos that all carried valid EXIF. When it's NULL, expo falls back
 *    to DATE_ADDED, i.e. the moment the file landed on the device.
 *  - `getAssetInfoAsync().exif` is not dependable either, and the fuller EXIF
 *    path wants ACCESS_MEDIA_LOCATION — a permission we deliberately removed.
 *
 * Getting this wrong is not cosmetic: fall back to "now" and an entire backlog
 * import buckets under today, which makes the whole timeline meaningless.
 *
 * Only the first ~64 KB of the file is needed, so this never reads a whole
 * video into memory.
 */

const TAG_DATETIME = 0x0132; // IFD0
const TAG_EXIF_IFD_POINTER = 0x8769; // IFD0 -> Exif IFD
const TAG_DATETIME_ORIGINAL = 0x9003; // Exif IFD
const TAG_DATETIME_DIGITIZED = 0x9004; // Exif IFD

const TYPE_ASCII = 2;

/** "YYYY:MM:DD HH:MM:SS" — the EXIF format, which `new Date()` cannot parse. */
export function parseExifDateString(value: string | null): Date | null {
  if (!value) return null;
  const m = value.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss] = m;
  // A camera writes local wall-clock time with no zone, so construct local.
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss));
  if (Number.isNaN(date.getTime())) return null;
  // Guard against obviously bogus values (some devices write 0000:00:00).
  const year = date.getFullYear();
  if (year < 1970 || year > 2100) return null;
  return date;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    const code = view.getUint8(offset + i);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

type IfdScan = { dateTime?: string; dateTimeOriginal?: string; dateTimeDigitized?: string; exifIfdOffset?: number };

function scanIfd(view: DataView, tiffStart: number, ifdOffset: number, little: boolean): IfdScan {
  const result: IfdScan = {};
  const base = tiffStart + ifdOffset;
  if (base + 2 > view.byteLength) return result;

  const count = view.getUint16(base, little);
  for (let i = 0; i < count; i++) {
    const entry = base + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;

    const tag = view.getUint16(entry, little);
    const type = view.getUint16(entry + 2, little);
    const num = view.getUint32(entry + 4, little);

    if (tag === TAG_EXIF_IFD_POINTER) {
      result.exifIfdOffset = view.getUint32(entry + 8, little);
      continue;
    }
    if (type !== TYPE_ASCII) continue;

    // ASCII values longer than 4 bytes live at an offset instead of inline.
    const valueOffset = num > 4 ? tiffStart + view.getUint32(entry + 8, little) : entry + 8;
    if (valueOffset + num > view.byteLength) continue;
    const text = readAscii(view, valueOffset, num);

    if (tag === TAG_DATETIME) result.dateTime = text;
    else if (tag === TAG_DATETIME_ORIGINAL) result.dateTimeOriginal = text;
    else if (tag === TAG_DATETIME_DIGITIZED) result.dateTimeDigitized = text;
  }
  return result;
}

/**
 * Pull the capture date out of a JPEG header.
 *
 * `bytes` only needs to cover the APP1 segment — the first 64 KB is plenty.
 * Returns null for non-JPEG input or when no usable date is present.
 */
export function extractExifDate(bytes: Uint8Array): Date | null {
  if (bytes.length < 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // SOI
  if (view.getUint16(0, false) !== 0xffd8) return null;

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset, false);
    if ((marker & 0xff00) !== 0xff00) break; // not a marker; bail
    const size = view.getUint16(offset + 2, false);
    if (size < 2) break;

    if (marker === 0xffe1) {
      const app1 = offset + 4;
      // "Exif\0\0"
      if (app1 + 6 <= view.byteLength && readAscii(view, app1, 4) === 'Exif') {
        const tiff = app1 + 6;
        if (tiff + 8 > view.byteLength) return null;

        const byteOrder = view.getUint16(tiff, false);
        const little = byteOrder === 0x4949; // 'II'
        if (!little && byteOrder !== 0x4d4d) return null; // not 'MM' either

        if (view.getUint16(tiff + 2, little) !== 0x002a) return null;
        const ifd0Offset = view.getUint32(tiff + 4, little);

        const ifd0 = scanIfd(view, tiff, ifd0Offset, little);
        const exif = ifd0.exifIfdOffset ? scanIfd(view, tiff, ifd0.exifIfdOffset, little) : {};

        return (
          parseExifDateString(exif.dateTimeOriginal ?? null) ??
          parseExifDateString(exif.dateTimeDigitized ?? null) ??
          parseExifDateString(ifd0.dateTime ?? null)
        );
      }
    }

    if (marker === 0xffda) break; // start of scan: image data follows, no more headers
    offset += 2 + size;
  }
  return null;
}

/** Decode a base64 chunk into bytes without pulling in a polyfill at call sites. */
export function bytesFromBase64(base64: string): Uint8Array {
  const { Buffer } = require('buffer');
  const buf = Buffer.from(base64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
