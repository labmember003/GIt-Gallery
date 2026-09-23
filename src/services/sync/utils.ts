import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import { buildPreviewBase64, tierForSize } from './tiering';
import { buildCanonicalPath, identityHash } from './pathScheme';
import { compressForUpload } from './compression';
import { encodeThumbHash } from './thumbhash';
import { useAppStore } from '@/store/appState';
import { bytesFromBase64, extractExifDate, parseExifDateString } from './exifDate';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import type { PreparedAsset } from './types';

const DEFAULT_BRANCH = 'main';
const albumNameCache = new Map<string, string>();

export function makeFingerprint(asset: MediaLibrary.Asset): string {
  const filename = asset.filename || `asset-${asset.id}`;
  const createdAt = asset.creationTime ?? asset.modificationTime ?? 0;
  const fileSize = (asset as any).fileSize ?? 0;
  return `${filename}|${createdAt}|${fileSize}`;
}

/** How much of the file to read when hunting for the EXIF header. */
const EXIF_HEADER_BYTES = 64 * 1024;

/**
 * Best available capture time, in priority order.
 *
 * The file's own EXIF comes first because Android MediaStore's `datetaken` is
 * unreliable — measured NULL for 3 of 6 test photos that all had valid EXIF,
 * in which case expo falls back to DATE_ADDED (when the file arrived on the
 * device, not when the photo was taken).
 *
 * Getting this wrong is not cosmetic: falling through to "now" buckets an
 * entire backlog import under today and makes the timeline meaningless. That
 * is why "now" is the last resort only.
 *
 * Only the first 64 KB is read, so this is cheap even for large video.
 */
export async function resolveCaptureDate(
  asset: MediaLibrary.Asset,
  info: MediaLibrary.AssetInfo | null,
  localUri?: string | null,
): Promise<Date> {
  if (localUri) {
    try {
      const headerBase64 = await FileSystem.readAsStringAsync(localUri, {
        encoding: FileSystem.EncodingType.Base64,
        position: 0,
        length: EXIF_HEADER_BYTES,
      });
      const fromFile = extractExifDate(bytesFromBase64(headerBase64));
      if (fromFile) return fromFile;
    } catch {
      // Unreadable header is fine — fall through to the platform values.
    }
  }

  const exif = (info as any)?.exif ?? null;
  const fromPlatform =
    parseExifDateString(exif?.DateTimeOriginal ?? null) ??
    parseExifDateString(exif?.DateTimeDigitized ?? null) ??
    parseExifDateString(exif?.DateTime ?? null);
  if (fromPlatform) return fromPlatform;

  const ts = asset.creationTime || asset.modificationTime || 0;
  if (ts > 0) return new Date(ts);
  return new Date();
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/, '/');
}

export function sanitizeFilename(filename: string, fallback = 'asset'): string {
  try {
    let next = filename.normalize('NFC');
    next = next.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
    next = next.replace(/[\\/]/g, '-');
    next = next.replace(/[:*?"<>|]/g, '-');
    next = next.replace(/\s+/g, ' ').trim();
    next = next.replace(/[^a-zA-Z0-9._ -]+/g, '-');
    next = next.replace(/^-+|-+$/g, '');
    if (!next || next === '.' || next === '..') {
      return fallback;
    }
    return next;
  } catch {
    return fallback;
  }
}

function sanitizeFolderName(name: string): string {
  const sanitized = sanitizeFilename(name, 'Unsorted');
  return sanitized || 'Unsorted';
}

function buildFileSegment(filename: string | null | undefined, fingerprint: string): string {
  const original = filename && filename.trim().length > 0 ? filename : '';
  const sanitized = sanitizeFilename(original, `asset-${fingerprint}`);
  if (sanitized.includes('.')) {
    return sanitized;
  }
  return `${sanitized}.jpg`;
}

function extractFolderFromUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const lower = uri.toLowerCase();
  if (!lower.startsWith('file://')) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(uri);
    const withoutScheme = decoded.replace(/^file:\/\//i, '');
    const parts = withoutScheme.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return parts[parts.length - 2];
  } catch {
    return null;
  }
}

async function resolveFolderName(
  asset: MediaLibrary.Asset,
  info: MediaLibrary.AssetInfo,
  localUri: string | null,
): Promise<string> {
  const fromUri = extractFolderFromUri(localUri);
  if (fromUri) {
    return fromUri;
  }

  const rawAlbumId = (info as any)?.albumId ?? (asset as any)?.albumId ?? null;
  const albumKey = rawAlbumId ? String(rawAlbumId) : null;
  if (albumKey) {
    const cached = albumNameCache.get(albumKey);
    if (cached) return cached;
    try {
      const album = await MediaLibrary.getAlbumAsync(albumKey);
      if (album?.title) {
        albumNameCache.set(albumKey, album.title);
        return album.title;
      }
    } catch (error) {
      console.warn('Failed to resolve album name', error);
    }
  }

  const infoAlbums = (info as any)?.albums;
  if (Array.isArray(infoAlbums) && infoAlbums.length > 0) {
    const candidate = infoAlbums[0]?.title ?? infoAlbums[0]?.name;
    if (candidate) {
      return candidate;
    }
  }

  return 'Unsorted';
}

export function determineRepoPath(folderName: string, filename: string, fingerprint: string): string {
  const folderSegment = sanitizeFolderName(folderName);
  const fileSegment = buildFileSegment(filename, fingerprint);
  return normalizePath(`gitgallery/images/${folderSegment}/${fileSegment}`);
}

async function loadAssetInfo(asset: MediaLibrary.Asset): Promise<MediaLibrary.AssetInfo | null> {
  try {
    return await MediaLibrary.getAssetInfoAsync(asset);
  } catch (error: any) {
    const message = error?.message ?? String(error ?? '');
    const missingAccessMediaLocation = message.includes('ACCESS_MEDIA_LOCATION');
    if (missingAccessMediaLocation) {
      return {
        ...(asset as any),
        localUri: (asset as any).localUri ?? asset.uri ?? null,
        uri: asset.uri,
        filename: asset.filename ?? null,
      } as MediaLibrary.AssetInfo;
    }
    throw error;
  }
}

export async function prepareAsset(asset: MediaLibrary.Asset): Promise<PreparedAsset | null> {
  try {
    const info = await loadAssetInfo(asset);
    const localUri = info?.localUri || info?.uri || asset.uri;
    if (!localUri) return null;
    if (localUri.startsWith('data:')) {
      console.warn('Skipping asset due to inline data URI');
      return null;
    }

    const fingerprint = makeFingerprint(asset);
    const captureDate = await resolveCaptureDate(asset, info as any, localUri);
    const identity = await identityHash(fingerprint);


    // Compress BEFORE choosing a tier: a 30 MB photo that shrinks to 400 KB
    // belongs in tier 1, not in a release asset. The capture date was already
    // read from the ORIGINAL above, which matters because re-encoding strips
    // EXIF — the date survives in the repo path regardless.
    const preset = useAppStore.getState().compressionPreset;
    const compressed = await compressForUpload({
      localUri,
      filename: (info as any)?.filename ?? asset.filename ?? null,
      mediaType: (asset as any)?.mediaType ?? null,
      width: (info as any)?.width ?? asset.width ?? null,
      height: (info as any)?.height ?? asset.height ?? null,
      preset,
    });

    const uploadUri = compressed.uri;
    const fileSize = compressed.size || ((asset as any).fileSize ?? null);

    // Built after compression so the recorded dimensions describe the file that
    // is actually stored, not the pre-resize source. Aspect ratio is unchanged
    // either way, but the path should not claim 4032x3024 for a 2048px file.
    const repoPath = buildCanonicalPath({
      captureDate,
      width: compressed.width ?? (info as any)?.width ?? asset.width ?? null,
      height: compressed.height ?? (info as any)?.height ?? asset.height ?? null,
      filename: (info as any)?.filename ?? asset.filename ?? null,
      // Compression re-encodes to JPEG, so a .heic or .png source is stored as
      // JPEG bytes. Without this the blob is named .heic while containing JPEG
      // — fine for in-app decoders that sniff content, wrong for anything that
      // trusts the extension (GitHub's preview, a download, the photo library).
      extension: compressed.outputExtension,
      identity,
    });

    // Decide the tier from the bytes we will actually send. Reading a large
    // video into a base64 string would OOM the app before we ever learn it
    // belongs in tier 2.
    const tier = tierForSize(fileSize);

    let contentBase64: string | null = null;
    let contentHash: string | null = null;

    if (tier === 1) {
      contentBase64 = await FileSystem.readAsStringAsync(uploadUri, { encoding: FileSystem.EncodingType.Base64 });
      contentHash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        contentBase64,
        { encoding: Crypto.CryptoEncoding.BASE64 }
      );
    } else {
      // Tier 2 streams from disk, so there is no in-memory buffer to hash.
      // Identity comes from the stable fingerprint plus size instead; a real
      // content hash would mean reading the whole file just to compute it.
      contentHash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        `${fingerprint}:${fileSize ?? 0}`
      );
    }

    // Cheap (~7ms) and done once at upload; the payoff is an instantly-painted
    // timeline for every future viewer of this library.
    const isVideo = (asset as any)?.mediaType === 'video';
    const thumbHash = await encodeThumbHash(uploadUri, isVideo);

    // A tier-1 video is committed as the raw .mp4 blob, which the grid cannot
    // decode as an image — every video showed a broken tile. Tier 2 already
    // builds its own preview inside uploadTier2, so only tier 1 needs one here.
    const previewBase64 =
      isVideo && tier === 1 ? await buildPreviewBase64(uploadUri, true) : null;

    return {
      asset,
      previewBase64,
      thumbHash,
      localUri: uploadUri,
      originalUri: localUri,
      compressedFrom: compressed.isTemporary ? compressed.originalSize : null,
      repoPath,
      fingerprint,
      creationTime: captureDate.getTime(),
      fileSize,
      contentBase64,
      contentHash,
      tier,
    };
  } catch (error) {
    console.warn('Failed to prepare asset for upload', error);
    return null;
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function resolveBranch(branch?: string | null): string {
  return branch && branch.trim().length > 0 ? branch : DEFAULT_BRANCH;
}

let ensuredDownloadDirectory: string | null = null;
let ensuringPromise: Promise<string> | null = null;

async function ensureDownloadDirectory(): Promise<string> {
  if (ensuredDownloadDirectory) {
    return ensuredDownloadDirectory;
  }
  if (ensuringPromise) {
    return ensuringPromise;
  }
  ensuringPromise = (async () => {
    const base = Platform.OS === 'android'
      ? FileSystem.documentDirectory ?? FileSystem.cacheDirectory
      : FileSystem.documentDirectory ?? FileSystem.cacheDirectory;
    if (!base) {
      throw new Error('No writable directory available for downloads');
    }
    const downloadDir = `${base}Download/GitGallery/`;
    try {
      await FileSystem.makeDirectoryAsync(downloadDir, { intermediates: true });
    } catch (error: any) {
      if (error?.code !== 'E_DIRECTORY_EXISTS') {
        console.warn('Failed to ensure download directory', error);
      }
    }
    ensuredDownloadDirectory = downloadDir;
    return downloadDir;
  })();
  try {
    return await ensuringPromise;
  } finally {
    ensuringPromise = null;
  }
}

export async function temporaryDownloadPath(filename: string): Promise<string> {
  const baseDir = await ensureDownloadDirectory();
  const safe = sanitizeFilename(filename);
  const ext = filename.includes('.') ? filename.split('.').pop() : 'bin';
  const finalName = `${safe}-${Date.now()}.${ext}`;
  return `${baseDir}${finalName}`;
}
