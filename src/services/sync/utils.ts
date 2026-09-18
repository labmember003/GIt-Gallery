import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
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
    const folderName = await resolveFolderName(asset, info as any, localUri);
    const repoPath = determineRepoPath(folderName, (info as any)?.filename ?? asset.filename ?? fingerprint, fingerprint);

    const fileInfo = (await FileSystem.getInfoAsync(localUri)) as any;
    const fileSize = typeof fileInfo?.size === 'number' ? fileInfo.size : (asset as any).fileSize ?? null;

    const contentBase64 = await FileSystem.readAsStringAsync(localUri, { encoding: FileSystem.EncodingType.Base64 });
    const contentHash = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      contentBase64,
      { encoding: Crypto.CryptoEncoding.BASE64 }
    );

    return {
      asset,
      localUri,
      repoPath,
      fingerprint,
      creationTime: asset.creationTime ?? asset.modificationTime ?? null,
      fileSize,
      contentBase64,
      contentHash,
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
