import { Buffer } from 'buffer';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { useAppStore } from '@/store/appState';
import type { SyncStatus, UploadIndex, UploadIndexEntry, MetaEntry, PreparedAsset, CompletionEvent } from './types';
import { SimpleEmitter, EventEmitter } from './events';
import * as localStore from '../localStore';
import type { AssetRecord } from '../localStore';
import { makeFingerprint, prepareAsset, temporaryDownloadPath, resolveBranch, sanitizeFilename } from './utils';
import { JobQueue } from './jobQueue';
import { getOctokit, getRepoInfo, fetchFileSha, putFile, deleteFile, downloadFile, resetBranchToEmptyCommit } from './githubClient';
import { loadMetaIndex, upsertMetaEntry, getCachedMetaEntries, getMetaEntryFromCache, invalidateMetaCache, removeMetaEntries } from './metaIndex';
import type { Octokit } from '@octokit/rest';
import { ensureMediaLibraryPermissions } from '../mediaPermissions';
import { ensureAndroidDownloadsDirectory } from './androidDownloads';

const uploadIndexEmitter = new SimpleEmitter();
const syncStatusEmitter = new SimpleEmitter();
const cacheInvalidatedEmitter = new SimpleEmitter();
const completionEmitter = new EventEmitter<{ completion: CompletionEvent }>();

const uploadIndexCache = new Map<string, UploadIndexEntry>();
let syncStatus: SyncStatus = {
  running: false,
  pendingUploads: 0,
  completedUploads: 0,
  isDeleting: false,
  lastBatchTotal: 0,
  lastBatchUploaded: 0,
  lastBatchType: null,
  lastError: null,
};

let lastCompletion: CompletionEvent | null = null;
const queue = new JobQueue();
let metaReady = false;

const autoSyncBlocklist = new Set<string>();
let autoSyncBlocklistLoaded = false;
let autoSyncBlocklistLoading: Promise<void> | null = null;

type CancelToken = { cancelled: boolean };
let activeCancelToken: CancelToken | null = null;

async function ensureAutoSyncBlocklist(): Promise<void> {
  if (autoSyncBlocklistLoaded) return;
  if (autoSyncBlocklistLoading) {
    await autoSyncBlocklistLoading;
    return;
  }
  autoSyncBlocklistLoading = (async () => {
    try {
      const fingerprints = await localStore.getAutoSyncBlocklist();
      autoSyncBlocklist.clear();
      for (const fingerprint of fingerprints) {
        if (fingerprint) {
          autoSyncBlocklist.add(fingerprint);
        }
      }
      autoSyncBlocklistLoaded = true;
    } finally {
      autoSyncBlocklistLoading = null;
    }
  })();
  await autoSyncBlocklistLoading;
}

function isAutoSyncBlockedFingerprint(fingerprint: string): boolean {
  return autoSyncBlocklist.has(fingerprint);
}

async function blockAutoSyncFingerprint(fingerprint: string | null | undefined): Promise<void> {
  if (!fingerprint) return;
  await ensureAutoSyncBlocklist();
  if (autoSyncBlocklist.has(fingerprint)) return;
  try {
    await localStore.addAutoSyncBlock(fingerprint);
  } catch (error) {
    console.warn('Failed to persist auto-sync block', error);
  }
  autoSyncBlocklist.add(fingerprint);
}

async function unblockAutoSyncFingerprint(fingerprint: string | null | undefined): Promise<void> {
  if (!fingerprint) return;
  await ensureAutoSyncBlocklist();
  if (!autoSyncBlocklist.has(fingerprint)) return;
  try {
    await localStore.removeAutoSyncBlock(fingerprint);
  } catch (error) {
    console.warn('Failed to remove auto-sync block', error);
  }
  autoSyncBlocklist.delete(fingerprint);
}

function resetAutoSyncBlocklistCache(): void {
  autoSyncBlocklist.clear();
  autoSyncBlocklistLoaded = false;
  autoSyncBlocklistLoading = null;
}

export function cancelActiveSync(): void {
  if (activeCancelToken && !activeCancelToken.cancelled) {
    activeCancelToken.cancelled = true;
  }
}

function guessMimeTypeFromExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'heic':
    case 'heif':
      return 'image/heic';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'tiff':
    case 'tif':
      return 'image/tiff';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

function buildAndroidDownloadName(baseName: string, timestamp: number): { fileName: string; mimeType: string } {
  const sanitized = sanitizeFilename(baseName) || `download-${timestamp}`;
  const parts = sanitized.split('.');
  let namePart = sanitized;
  let ext = '';

  if (parts.length > 1) {
    ext = parts.pop() ?? '';
    namePart = parts.join('.') || `download-${timestamp}`;
  } else {
    const originalExt = baseName.includes('.') ? baseName.split('.').pop() ?? '' : '';
    ext = originalExt;
  }

  if (!ext) {
    ext = 'bin';
  }

  const finalName = `${namePart}-${timestamp}.${ext}`;
  return { fileName: finalName, mimeType: guessMimeTypeFromExtension(ext) };
}

async function placeDownloadedAssetInAlbum(asset: MediaLibrary.Asset): Promise<void> {
  const preferredAlbums = ['Download', 'Downloads'];
  try {
    for (const name of preferredAlbums) {
      const existing = await MediaLibrary.getAlbumAsync(name);
      if (existing) {
        await MediaLibrary.addAssetsToAlbumAsync([asset], existing, false);
        return;
      }
    }

    await MediaLibrary.createAlbumAsync(preferredAlbums[0], asset, false);
  } catch (_error) {}
}

function setSyncStatus(patch: Partial<SyncStatus>): void {
  syncStatus = { ...syncStatus, ...patch };
  syncStatusEmitter.emit();
}

function recordCompletion(event: CompletionEvent): void {
  lastCompletion = event;
  completionEmitter.emit('completion', event);
}

async function refreshUploadIndexCache(): Promise<void> {
  const records = await localStore.getAssets();
  uploadIndexCache.clear();
  for (const record of records) {
    const entry: UploadIndexEntry = {
      uploaded: !!record.uploaded,
      repoPath: record.repoPath ?? null,
      fileSize: record.fileSize ?? null,
      creationTime: record.createdAt ?? null,
      fingerprint: record.fingerprint,
      contentHash: record.contentHash ?? null,
      lastSeenAt: record.lastSeenAt ?? null,
      lastUploadedAt: record.lastUploadedAt ?? null,
      lastError: record.lastError ?? null,
    };
    if (record.assetId) {
      uploadIndexCache.set(record.assetId, entry);
    }
    uploadIndexCache.set(record.fingerprint, entry);
  }
  uploadIndexEmitter.emit();
}

async function ensureUploadIndexCache(): Promise<void> {
  if (uploadIndexCache.size === 0) {
    await refreshUploadIndexCache();
  }
}

function updateIndexCacheForRecord(record: AssetRecord): void {
  const entry: UploadIndexEntry = {
    uploaded: !!record.uploaded,
    repoPath: record.repoPath ?? null,
    fileSize: record.fileSize ?? null,
    creationTime: record.createdAt ?? null,
    fingerprint: record.fingerprint,
    contentHash: record.contentHash ?? null,
    lastSeenAt: record.lastSeenAt ?? null,
    lastUploadedAt: record.lastUploadedAt ?? null,
    lastError: record.lastError ?? null,
  };
  if (record.assetId) {
    uploadIndexCache.set(record.assetId, entry);
  }
  uploadIndexCache.set(record.fingerprint, entry);
  uploadIndexEmitter.emit();
}

function removeFromIndexCache(fingerprint: string, assetId?: string | null): void {
  uploadIndexCache.delete(fingerprint);
  if (assetId) uploadIndexCache.delete(assetId);
  uploadIndexEmitter.emit();
}

function mergeMetaEntriesIntoUploadIndex(): void {
  const metaEntries = getCachedMetaEntries();
  let changed = false;

  for (const entry of metaEntries) {
    if (!entry.fingerprint) continue;
    const current = uploadIndexCache.get(entry.fingerprint);
    const next: UploadIndexEntry = {
      uploaded: true,
      repoPath: entry.repoPath ?? null,
      fileSize: entry.fileSize ?? null,
      creationTime: entry.createdAt ?? null,
      fingerprint: entry.fingerprint,
      contentHash: entry.contentHash ?? null,
      lastUploadedAt: entry.uploadedAt ?? null,
      lastSeenAt: entry.uploadedAt ?? entry.createdAt ?? null,
      lastError: null,
    };

    if (!current) {
      uploadIndexCache.set(entry.fingerprint, next);
      changed = true;
      continue;
    }

    if (!current.uploaded || current.repoPath !== next.repoPath || current.contentHash !== next.contentHash) {
      uploadIndexCache.set(entry.fingerprint, { ...current, ...next, uploaded: true });
      changed = true;
    }
  }

  if (changed) {
    uploadIndexEmitter.emit();
  }
}

async function ensureMetaLoaded(force = false): Promise<void> {
  if (force) {
    invalidateMetaCache();
    metaReady = false;
  }
  if (metaReady) return;
  const octokit = getOctokit();
  const repo = getRepoInfo();
  await loadMetaIndex(octokit, repo);
  metaReady = true;
}

type UploadBatchOptions = {
  allowBlocked?: boolean;
  source?: 'auto' | 'visible' | 'manual' | 'retry' | string;
  cancelToken?: CancelToken;
};

async function prepareAssetsForUpload(assets: MediaLibrary.Asset[], options?: UploadBatchOptions): Promise<PreparedAsset[]> {
  const skipBlocked = !options?.allowBlocked;
  if (skipBlocked) {
    await ensureAutoSyncBlocklist();
    await ensureUploadIndexCache();
  }

  const prepared: PreparedAsset[] = [];
  const preparedFingerprints = new Set<string>();
  const skipped: Array<{ id: string; reason: string }> = [];
  const retryable: MediaLibrary.Asset[] = [];

  const tryRegister = (entry: PreparedAsset | null) => {
    if (!entry) return false;
    if (preparedFingerprints.has(entry.fingerprint)) {
      return true;
    }
    preparedFingerprints.add(entry.fingerprint);
    prepared.push(entry);
    const index = skipped.findIndex((item) => item.id === entry.asset.id && item.reason === 'notPrepared');
    if (index >= 0) {
      skipped.splice(index, 1);
    }
    return true;
  };

  for (const asset of assets) {
    if (options?.cancelToken?.cancelled) {
      break;
    }
    let fingerprint: string | null = null;
    if (skipBlocked) {
      fingerprint = makeFingerprint(asset);
      if (isAutoSyncBlockedFingerprint(fingerprint)) {
        skipped.push({ id: asset.id, reason: 'blocked' });
        continue;
      }
      const cached = uploadIndexCache.get(asset.id) || uploadIndexCache.get(fingerprint);
      if (cached?.uploaded) {
        skipped.push({ id: asset.id, reason: 'already uploaded' });
        continue;
      }
    }

    const entry = await prepareAsset(asset);
    if (!tryRegister(entry)) {
      skipped.push({ id: asset.id, reason: 'notPrepared' });
      retryable.push(asset);
    }
  }

  if (retryable.length > 0) {
    for (const asset of retryable) {
      if (options?.cancelToken?.cancelled) {
        break;
      }
      try {
        await MediaLibrary.getAssetInfoAsync(asset, { shouldDownloadFromNetwork: true } as any);
      } catch (error) {
        console.warn('Retry download request failed', error);
      }
    }

    // Time delay to give the OS a moment to finish persisting the originals locally before re-reading.
    await new Promise((resolve) => setTimeout(resolve, 350));

    for (const asset of retryable) {
      if (options?.cancelToken?.cancelled) {
        break;
      }
      const entry = await prepareAsset(asset);
      if (!tryRegister(entry)) {
        console.warn('Skipping asset after retry; still no readable file', asset.id);
        skipped.push({ id: asset.id, reason: 'no entry after retry' });
      }
    }
  }

  if (skipped.length > 0) {
    const sourceLabel = options?.source ?? 'auto';
    console.log(`[auto-sync] skipped assets (${sourceLabel}):`, skipped.length, skipped.slice(0, 10));
  }
  return prepared;
}

async function uploadPreparedAsset(client: Octokit, repo: ReturnType<typeof getRepoInfo>, prepared: PreparedAsset): Promise<void> {
  const { fingerprint, repoPath, contentBase64, fileSize, creationTime, contentHash } = prepared;
  await localStore.saveAsset({
    fingerprint,
    assetId: prepared.asset.id,
    repoPath,
    uploaded: false,
    fileSize,
    createdAt: creationTime ?? null,
    contentHash: contentHash ?? null,
    lastSeenAt: Date.now(),
    previewHash: null,
    lastUploadedAt: null,
    lastError: null,
  });
    updateIndexCacheForRecord({
    fingerprint,
    assetId: prepared.asset.id,
    repoPath,
    uploaded: false,
    fileSize,
    createdAt: creationTime ?? null,
    contentHash: contentHash ?? null,
    lastSeenAt: Date.now(),
        previewHash: null,
    lastUploadedAt: null,
    lastError: null,
      });

  const sha = await fetchFileSha(repoPath, repo);
  await putFile({
    path: repoPath,
    message: `Upload ${fingerprint}`,
    contentBase64,
    sha,
    repo,
  });

  await localStore.markUploaded(fingerprint, repoPath, contentHash ?? null);
  updateIndexCacheForRecord({
    fingerprint,
    assetId: prepared.asset.id,
    repoPath,
    uploaded: true,
    fileSize,
    createdAt: creationTime ?? null,
    contentHash: contentHash ?? null,
    lastSeenAt: Date.now(),
    previewHash: null,
    lastUploadedAt: Date.now(),
    lastError: null,
  });

  await unblockAutoSyncFingerprint(fingerprint);

  const metaEntry: MetaEntry = {
    fingerprint,
    repoPath,
    createdAt: creationTime ?? null,
    fileSize: fileSize ?? null,
    previewRepoPath: null,
    contentHash: contentHash ?? null,
    uploadedAt: Date.now(),
    assetId: prepared.asset.id,
  };
  await upsertMetaEntry(client, repo, metaEntry);
}

async function processUploadBatch(assets: MediaLibrary.Asset[], options?: UploadBatchOptions): Promise<void> {
  if (assets.length === 0) return;
  const cancelToken: CancelToken = options?.cancelToken ?? { cancelled: false };
  const batchOptions: UploadBatchOptions = { ...options, cancelToken };
  activeCancelToken = cancelToken;
  const client = getOctokit();
  const repo = getRepoInfo();
  await ensureMetaLoaded();
  await ensureMediaLibraryPermissions();

  setSyncStatus({
    running: true,
    lastBatchType: 'upload',
    lastBatchTotal: assets.length,
    lastBatchUploaded: 0,
    lastError: null,
    pendingUploads: assets.length,
  });

  const prepared = await prepareAssetsForUpload(assets, batchOptions);
  if (cancelToken.cancelled) {
    if (activeCancelToken === cancelToken) activeCancelToken = null;
    setSyncStatus({
      running: false,
      lastBatchTotal: 0,
      lastBatchUploaded: 0,
      lastBatchType: null,
      pendingUploads: 0,
      lastError: 'Sync cancelled by user',
    });
    return;
  }
  if (prepared.length === 0) {
    if (activeCancelToken === cancelToken) activeCancelToken = null;
    setSyncStatus({ running: false, lastBatchTotal: 0, lastBatchUploaded: 0, lastBatchType: null, pendingUploads: 0 });
    return;
  }

  const shouldAutoDelete = useAppStore.getState().autoDeleteAfterSync;
  const deleteCandidates = shouldAutoDelete ? new Set<string>() : null;

  if (prepared.length !== assets.length) {
    setSyncStatus({
      running: true,
      lastBatchType: 'upload',
      lastBatchTotal: prepared.length,
      lastBatchUploaded: 0,
      lastError: null,
      pendingUploads: prepared.length,
    });
  }

  let processed = 0;
  let failed = 0;
  let cancelled = false;

  for (const item of prepared) {
    if (cancelToken.cancelled) {
      cancelled = true;
      break;
    }
    processed += 1;
    try {
      await uploadPreparedAsset(client, repo, item);
      if (deleteCandidates && item.asset?.id) {
        deleteCandidates.add(item.asset.id);
      }
      setSyncStatus({
        completedUploads: syncStatus.completedUploads + 1,
        lastBatchUploaded: processed,
        pendingUploads: Math.max(0, syncStatus.pendingUploads - 1),
      });
    } catch (error: any) {
      failed += 1;
      setSyncStatus({
        lastError: error?.message ?? String(error),
        lastBatchUploaded: processed,
        pendingUploads: Math.max(0, syncStatus.pendingUploads - 1),
      });
      await localStore.recordFailure(item.fingerprint, error?.message ?? 'Upload failed');
      updateIndexCacheForRecord({
        fingerprint: item.fingerprint,
        assetId: item.asset.id,
        repoPath: item.repoPath,
        uploaded: false,
        fileSize: item.fileSize ?? null,
        createdAt: item.creationTime ?? null,
        contentHash: item.contentHash ?? null,
        lastSeenAt: Date.now(),
        previewHash: null,
        lastUploadedAt: null,
        lastError: error?.message ?? 'Upload failed',
      });
    }
  }

  if (cancelToken.cancelled) {
    setSyncStatus({
      running: false,
      lastBatchTotal: 0,
      lastBatchUploaded: processed,
      lastBatchType: null,
      pendingUploads: 0,
      lastError: 'Sync cancelled by user',
    });
  } else {
    setSyncStatus({ running: false, lastBatchTotal: 0, lastBatchUploaded: 0, lastBatchType: null, pendingUploads: 0 });
    recordCompletion({ type: 'upload', total: prepared.length, failed, timestamp: Date.now() });
  }

  if (deleteCandidates && deleteCandidates.size > 0) {
    try {
      await MediaLibrary.deleteAssetsAsync(Array.from(deleteCandidates));
    } catch (error) {
      console.warn('Failed to auto-delete uploaded assets', error);
    }
  }

  if (activeCancelToken === cancelToken) {
    activeCancelToken = null;
  }
}

async function collectAssetsFromSelectedAlbums(maxTotal?: number, options?: { includeUploaded?: boolean }): Promise<MediaLibrary.Asset[]> {
  const selected = useAppStore.getState().selectedAlbumIds;
  const selectionInitialized = useAppStore.getState().selectionInitialized ?? false;
  const permission = await ensureMediaLibraryPermissions(false);
  if (!permission.granted) {
    return [];
  }

  const target = Number.isFinite(maxTotal ?? NaN) && maxTotal && maxTotal > 0
    ? Math.floor(maxTotal)
    : Number.POSITIVE_INFINITY;
  const includeUploaded = options?.includeUploaded ?? true;
  if (!includeUploaded) {
    await ensureUploadIndexCache();
    await ensureMetaLoaded(false);
  }
  const pageSize = 60;
  const uniqueAssets = new Map<string, MediaLibrary.Asset>();

  async function ingest(options: MediaLibrary.AssetsOptions): Promise<void> {
    let after: string | undefined;
    let guard = 0;
    while (uniqueAssets.size < target) {
      try {
        const response = await MediaLibrary.getAssetsAsync({
          ...options,
          first: pageSize,
          ...(after ? { after } : {}),
        });
        const assets = response.assets ?? [];
        if (assets.length === 0) {
          break;
        }
        for (const asset of assets) {
          if (uniqueAssets.has(asset.id)) continue;
          if (!includeUploaded && isAssetUploadedAsset(asset)) continue;
          uniqueAssets.set(asset.id, asset);
        }
        if (uniqueAssets.size >= target) {
          break;
        }

        const hasNext = !!response.hasNextPage;
        const endCursor = response.endCursor ?? assets[assets.length - 1]?.id ?? null;
        if (!hasNext || !endCursor || endCursor === after) {
          break;
        }
        after = endCursor;
        guard += 1;
        if (guard > 200) {
          console.warn('[auto-sync] pagination guard tripped; breaking to avoid loop');
          break;
        }
      } catch (error) {
        console.warn('Failed to load media assets', error);
        break;
      }
    }
  }

  const allAlbums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true }).catch(() => [] as MediaLibrary.Album[]);
  const albumMap = new Map<string, MediaLibrary.Album>();
  for (const album of allAlbums) {
    albumMap.set(album.id, album);
  }

  const originalSelectedCount = Array.isArray(selected) ? selected.length : 0;
  const selectedIds = Array.isArray(selected) ? selected.filter((id) => albumMap.has(id)) : [];

  if (selectionInitialized && (originalSelectedCount === 0 || (originalSelectedCount > 0 && selectedIds.length === 0))) {
    return [];
  }

  if (!selectedIds || selectedIds.length === 0) {
    await ingest({
      mediaType: ['photo'],
      sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    });
  } else {
    for (const albumId of selectedIds) {
      if (uniqueAssets.size >= target) break;
      const album = albumMap.get(albumId);
      if (!album) continue;
      await ingest({
        mediaType: ['photo'],
        album,
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
      });
    }
  }

  const newestFirst = Array.from(uniqueAssets.values()).sort((a, b) => (b.creationTime ?? 0) - (a.creationTime ?? 0));
  return newestFirst;
}

export async function getUploadIndex(): Promise<UploadIndex> {
  await ensureUploadIndexCache();
  const index: UploadIndex = {};
  for (const [key, entry] of uploadIndexCache.entries()) {
    if (entry.repoPath && entry.repoPath.startsWith('gitgallery/')) {
      index[key] = entry;
    } else if (!index[key]) {
      index[key] = entry;
    }
  }
  return index;
}

export function subscribeUploadIndex(listener: () => void): () => void {
  return uploadIndexEmitter.subscribe(listener);
}

export function getSyncStatus(): SyncStatus {
  return syncStatus;
}

export function subscribeSyncStatus(listener: () => void): () => void {
  return syncStatusEmitter.subscribe(listener);
}

export function subscribeCacheInvalidated(listener: () => void): () => void {
  return cacheInvalidatedEmitter.subscribe(listener);
}

export function isAssetUploadedAsset(asset: MediaLibrary.Asset): boolean {
  const fingerprint = makeFingerprint(asset);
  if (isAutoSyncBlockedFingerprint(fingerprint)) {
    return false;
  }
  const entry = uploadIndexCache.get(asset.id) || uploadIndexCache.get(fingerprint);
  if (entry?.uploaded) return true;
  const metaEntry = getMetaEntryFromCache(fingerprint) || getMetaEntryFromCache(asset.id);
  return !!metaEntry;
}

export async function hydrateRecentMeta(maxAgeHours = 24, force = false): Promise<void> {
  const wasReady = metaReady;
  let needsFresh = force || !metaReady;

  if (!needsFresh && maxAgeHours > 0 && lastCompletion) {
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    needsFresh = Date.now() - lastCompletion.timestamp > maxAgeMs;
  }

  await ensureMetaLoaded(needsFresh);
  mergeMetaEntriesIntoUploadIndex();

  if (!wasReady || needsFresh) {
    uploadIndexEmitter.emit();
  }
}

export async function getCloudEntriesEnsured(limit = 300): Promise<MetaEntry[]> {
  await ensureMetaLoaded(false);
  mergeMetaEntriesIntoUploadIndex();
  return getCachedMetaEntries(limit);
}

export async function runSyncOnce(): Promise<void> {
  const perm = await ensureMediaLibraryPermissions();
  if (!perm.granted) {
    setSyncStatus({ lastError: 'Media library permission not granted' });
    return;
  }

  const assets = await collectAssetsFromSelectedAlbums(undefined, { includeUploaded: false });
  if (assets.length === 0) {
    setSyncStatus({ lastError: 'No photos found in selected albums' });
    return;
  }

  await queue.enqueue(() => processUploadBatch(assets, { allowBlocked: true, source: 'auto' }));
}

export async function runSyncForAssets(assets: MediaLibrary.Asset[], options?: UploadBatchOptions): Promise<void> {
  if (!assets || assets.length === 0) {
    return;
  }

  const perm = await ensureMediaLibraryPermissions();
  if (!perm.granted) {
    setSyncStatus({ lastError: 'Media library permission not granted' });
    return;
  }

  await queue.enqueue(() => processUploadBatch(assets, options));
}

export async function syncVisibleAssets(assets: MediaLibrary.Asset[]): Promise<void> {
  await runSyncForAssets(assets, { allowBlocked: false, source: 'visible' });
}

export async function getRepoEntryForAsset(asset: MediaLibrary.Asset): Promise<MetaEntry | null> {
  await ensureMetaLoaded(false);
  const fingerprint = makeFingerprint(asset);
  const entry = getMetaEntryFromCache(fingerprint) || getMetaEntryFromCache(asset.id);
  if (entry) return entry;
  const record = await localStore.getAsset(fingerprint);
  if (record?.repoPath) {
    return getMetaEntryFromCache(record.repoPath);
  }
  return null;
}

export async function deleteRepoFile(path: string, options?: { skipStatus?: boolean; skipInvalidation?: boolean }): Promise<void> {
  const repo = getRepoInfo();
  const client = getOctokit();
  await ensureMetaLoaded(false);

  const shouldReportStatus = !options?.skipStatus;
  if (shouldReportStatus) {
    setSyncStatus({ running: true, isDeleting: true, lastBatchType: 'delete', lastBatchTotal: 1, lastBatchUploaded: 0 });
  }

  try {
    await deleteFile(path, `Delete ${path}`, repo);
    const cached = getMetaEntryFromCache(path);
    if (cached) {
      await removeMetaEntries(client, repo, [cached.fingerprint]);
      const existing = await localStore.getAsset(cached.fingerprint);
      await localStore.deleteAsset(cached.fingerprint);
      removeFromIndexCache(cached.fingerprint, existing?.assetId ?? null);
      await blockAutoSyncFingerprint(cached.fingerprint);
    }
    if (!options?.skipInvalidation) {
      cacheInvalidatedEmitter.emit();
    }
    if (shouldReportStatus) {
      recordCompletion({ type: 'delete', total: 1, failed: 0, timestamp: Date.now() });
    }
  } catch (error) {
    if (shouldReportStatus) {
      setSyncStatus({ lastError: (error as any)?.message ?? String(error) });
      recordCompletion({ type: 'delete', total: 1, failed: 1, timestamp: Date.now() });
    }
    throw error;
  } finally {
    if (shouldReportStatus) {
      setSyncStatus({ running: false, isDeleting: false, lastBatchType: null, lastBatchTotal: 0, lastBatchUploaded: 0 });
    }
  }
}

export async function deleteRepoFilesBulk(paths: string[]): Promise<{ deleted: string[]; failed: string[] }> {
  if (paths.length === 0) return { deleted: [], failed: [] };
  const deleted: string[] = [];
  const failed: string[] = [];
  const total = paths.length;
  let processed = 0;
  let lastErrorMessage: string | null = null;

  setSyncStatus({
    running: true,
    isDeleting: true,
    lastBatchType: 'delete',
    lastBatchTotal: total,
    lastBatchUploaded: 0,
    lastError: null,
  });

  for (const path of paths) {
    try {
      await deleteRepoFile(path, { skipStatus: true, skipInvalidation: true });
      deleted.push(path);
    } catch (error) {
      console.warn('Failed to delete path', path, error);
      failed.push(path);
      lastErrorMessage = (error as any)?.message ?? String(error);
      setSyncStatus({ lastError: lastErrorMessage });
    }
    processed += 1;
    setSyncStatus({
      running: true,
      isDeleting: true,
      lastBatchType: 'delete',
      lastBatchTotal: total,
      lastBatchUploaded: processed,
      lastError: lastErrorMessage,
    });
  }
  if (deleted.length > 0) {
    cacheInvalidatedEmitter.emit();
  }
  recordCompletion({ type: 'delete', total, failed: failed.length, timestamp: Date.now() });
  setSyncStatus({ running: false, isDeleting: false, lastBatchType: null, lastBatchTotal: 0, lastBatchUploaded: 0, lastError: lastErrorMessage });
  return { deleted, failed };
}

export async function deleteAssets(assets: MediaLibrary.Asset[]): Promise<void> {
  if (!assets || assets.length === 0) return;
  await ensureMetaLoaded(false);
  for (const asset of assets) {
    const entry = await getRepoEntryForAsset(asset);
    if (entry?.repoPath) {
      await deleteRepoFile(entry.repoPath);
    }
  }
}

export async function downloadRepoFiles(paths: string[]): Promise<string[]> {
  const repo = getRepoInfo();
  const downloaded: string[] = [];

  const isAndroid = Platform.OS === 'android';
  let androidDirectoryUri: string | null = null;
  const saf = isAndroid ? FileSystem.StorageAccessFramework : null;

  if (isAndroid) {
    androidDirectoryUri = await ensureAndroidDownloadsDirectory();
    if (!androidDirectoryUri) {
      setSyncStatus({ lastError: 'Download directory permission not granted' });
    }
  } else {
    const permission = await ensureMediaLibraryPermissions(true);
    if (!permission.granted) {
      setSyncStatus({ lastError: 'Media library permission not granted' });
      return downloaded;
    }
  }
  setSyncStatus({ running: true, lastBatchType: 'download', lastBatchTotal: paths.length, lastBatchUploaded: 0 });
  let processed = 0;

  for (const path of paths) {
    try {
      const file = await downloadFile(path, repo);
      if (!file) {
        continue;
      }
      const timestamp = Date.now();
      const baseName = path.split('/').pop() ?? `download-${timestamp}`;

      if (isAndroid && androidDirectoryUri && saf) {
        const { fileName, mimeType } = buildAndroidDownloadName(baseName, timestamp);
        try {
          const safUri = await saf.createFileAsync(androidDirectoryUri, fileName, mimeType);
          await saf.writeAsStringAsync(safUri, file.content, { encoding: FileSystem.EncodingType.Base64 });
          downloaded.push(safUri);
          continue;
        } catch (_error) {
          // Fall back to app storage if SAF write fails
        }
      }
      const localPath = await temporaryDownloadPath(baseName);
      await FileSystem.writeAsStringAsync(localPath, file.content, { encoding: FileSystem.EncodingType.Base64 });
      if (!isAndroid) {
        try {
          const asset = await MediaLibrary.createAssetAsync(localPath);
          await placeDownloadedAssetInAlbum(asset);
          downloaded.push(asset.id);
          try {
            await FileSystem.deleteAsync(localPath, { idempotent: true });
          } catch (_cleanupError) {}
          continue;
        } catch (_assetError) {}
      }
      downloaded.push(localPath);
    } catch (_error) {
    } finally {
      processed += 1;
      setSyncStatus({ lastBatchUploaded: processed });
    }
  }

  setSyncStatus({ running: false, lastBatchType: null, lastBatchTotal: 0, lastBatchUploaded: 0 });
  recordCompletion({ type: 'download', total: paths.length, failed: paths.length - downloaded.length, timestamp: Date.now() });
  return downloaded;
}

export function subscribeCompletion(listener: (event: CompletionEvent) => void): () => void {
  return completionEmitter.on('completion', listener);
}

export function getLastCompletion(): CompletionEvent | null {
  return lastCompletion;
}

export async function verifyAndCleanUploadIndex(): Promise<void> {
  await ensureUploadIndexCache();
  await ensureMetaLoaded(false);
  const metaEntries = getCachedMetaEntries();
  const fingerprints = new Set(metaEntries.map((entry) => entry.fingerprint));
  const records = await localStore.getAssets();
  for (const record of records) {
    if (record.uploaded && !fingerprints.has(record.fingerprint)) {
      await localStore.deleteAsset(record.fingerprint);
      removeFromIndexCache(record.fingerprint, record.assetId ?? undefined);
    }
  }
}

export async function clearCache(): Promise<void> {
  await localStore.resetStore();
  await localStore.setKey('legacy:migrationCompleted', '1');
  resetAutoSyncBlocklistCache();
  uploadIndexCache.clear();
  uploadIndexEmitter.emit();
  invalidateMetaCache();
  metaReady = false;
  cacheInvalidatedEmitter.emit();
}

export async function resetRepoAndCaches(): Promise<void> {
  try {
    const timestamp = new Date().toISOString();
    await resetBranchToEmptyCommit(`Reset GitGallery repository - ${timestamp}`);
  } catch (error) {
    console.warn('Failed to reset repository branch', error);
    throw error;
  }

  await clearCache();
}
