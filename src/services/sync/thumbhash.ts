/**
 * ThumbHash placeholders.
 *
 * A ~25-byte hash encodes a recognisable blurred version of an image. Stored
 * in the meta index, it means one `git/trees` + index fetch is enough to paint
 * the entire timeline — every tile showing a blur of the real photo — before a
 * single image byte is downloaded. That is what gives Immich its "instant"
 * feel, and it is the cheapest large UX win available here.
 *
 * Cost: 21–24 bytes per photo (~640 KB for 20,000 photos). Measured encode
 * 7 ms, decode-to-data-URL 2 ms.
 */
import { extractVideoFrameBase64 } from './videoFrame';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { rgbaToThumbHash, thumbHashToDataURL } from 'thumbhash';
import { decode as decodeJpeg } from 'jpeg-js';

/**
 * ThumbHash requires a small input (≤100px). Resizing natively first matters:
 * decoding a full-size JPEG in JS would take hundreds of ms, while a 64px one
 * is negligible.
 */
const ENCODE_EDGE = 64;

function toRgba(raw: { width: number; height: number; data: Uint8Array }, maxEdge: number) {
  const scale = Math.min(maxEdge / raw.width, maxEdge / raw.height, 1);
  const w = Math.max(1, Math.round(raw.width * scale));
  const h = Math.max(1, Math.round(raw.height * scale));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(raw.width - 1, Math.floor(x / scale));
      const sy = Math.min(raw.height - 1, Math.floor(y / scale));
      const si = (sy * raw.width + sx) * 4;
      const di = (y * w + x) * 4;
      out[di] = raw.data[si];
      out[di + 1] = raw.data[si + 1];
      out[di + 2] = raw.data[si + 2];
      out[di + 3] = raw.data[si + 3];
    }
  }
  return { w, h, data: out };
}

/**
 * Encode a local image to a base64 ThumbHash, or null if it can't be produced.
 *
 * Never throws: a missing placeholder is a cosmetic loss, and must not fail an
 * upload.
 */
export async function encodeThumbHash(localUri: string, isVideo = false): Promise<string | null> {
  try {
    // A video cannot be decoded as an image, so it needs a frame extracted
    // first — the same reason its cloud preview was blank. Without this every
    // video tile also lost its blur placeholder.
    let b64: string | null | undefined;
    if (isVideo) {
      b64 = await extractVideoFrameBase64(localUri, ENCODE_EDGE, 0.8);
    } else {
      const small = await manipulateAsync(localUri, [{ resize: { width: ENCODE_EDGE } }], {
        compress: 0.8,
        format: SaveFormat.JPEG,
        base64: true,
      });
      b64 = (small as any)?.base64 as string | undefined;
    }
    if (!b64) return null;

    const { Buffer } = require('buffer');
    const bytes = Buffer.from(b64, 'base64');
    const raw = decodeJpeg(bytes, { useTArray: true }) as any;
    const rgba = toRgba({ width: raw.width, height: raw.height, data: raw.data }, ENCODE_EDGE);

    const hash = rgbaToThumbHash(rgba.w, rgba.h, rgba.data);
    return Buffer.from(hash).toString('base64');
  } catch (error) {
    console.warn('[thumbhash] encode failed; tile will have no placeholder', error);
    return null;
  }
}

/** Decoded data URLs are cached: the same tile re-renders constantly while scrolling. */
const dataUrlCache = new Map<string, string>();
const MAX_CACHED = 600;

/** Turn a stored base64 ThumbHash into a PNG data URL for `<Image source>`. */
export function thumbHashDataUrl(hashBase64: string | null | undefined): string | null {
  if (!hashBase64) return null;
  const cached = dataUrlCache.get(hashBase64);
  if (cached) return cached;
  try {
    const { Buffer } = require('buffer');
    const url = thumbHashToDataURL(new Uint8Array(Buffer.from(hashBase64, 'base64')));
    if (dataUrlCache.size >= MAX_CACHED) {
      // Cheap bound: drop the oldest insertion.
      const oldest = dataUrlCache.keys().next().value;
      if (oldest) dataUrlCache.delete(oldest);
    }
    dataUrlCache.set(hashBase64, url);
    return url;
  } catch {
    return null;
  }
}
