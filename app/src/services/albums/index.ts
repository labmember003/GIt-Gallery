import { AppState } from 'react-native';
import { create } from 'zustand';
import { Buffer } from 'buffer';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';
import * as SecureStore from 'expo-secure-store';
import { useAppStore, type CurrentRepo } from '@/store/appState';
import { getOctokit } from '@/services/sync/githubClient';
import { resolveBranch } from '@/services/sync/utils';
import {
  getSyncStatus,
  invalidateRemoteHead,
  resolveRepoPathForAsset,
  runSyncForAssets,
  subscribeCompletion,
} from '@/services/sync/index';
import {
  ALBUMS_PATH,
  applyOps,
  cleanAlbumName,
  emptyDoc,
  isAlbumNameTaken,
  newAlbumId,
  normalizeAlbumPath,
  parseAlbumsDoc,
  serializeAlbumsDoc,
  type Album,
  type AlbumOp,
  type AlbumsDoc,
} from './model';

export type { Album } from './model';
export { coverPathFor, captureTimeFromPath, isAlbumNameTaken, normalizeAlbumPath } from './model';

/**
 * A device photo added to an album before it was uploaded. It becomes a repo
 * path in the album once its upload lands; until then the album shows it from
 * the device with an "uploading" mark.
 */
export type PendingDeviceItem = {
  albumId: string;
  assetId: string;
  uri: string;
  mediaType: 'photo' | 'video';
  width: number;
  height: number;
  creationTime: number;
  duration: number;
  addedAt: number;
  /**
   * The fields an upload needs. Kept whole because re-reading a photo by id
   * (`getAssetInfoAsync`) fails on Android without ACCESS_MEDIA_LOCATION, the
   * same reason services/sync keeps snapshots for interrupted uploads.
   */
  asset?: MediaLibrary.Asset;
};

function assetSnapshot(asset: MediaLibrary.Asset): MediaLibrary.Asset {
  const { id, filename, uri, mediaType, mediaSubtypes, width, height, creationTime, modificationTime, duration, albumId } = asset;
  return { id, filename, uri, mediaType, mediaSubtypes, width, height, creationTime, modificationTime, duration, albumId } as MediaLibrary.Asset;
}

/** The snapshot, or a minimal stand-in good enough for an id lookup. */
function assetFor(item: PendingDeviceItem): MediaLibrary.Asset {
  return item.asset ?? ({
    id: item.assetId,
    uri: item.uri,
    filename: '',
    mediaType: item.mediaType,
    width: item.width,
    height: item.height,
    creationTime: item.creationTime,
    modificationTime: item.creationTime,
    duration: item.duration,
  } as unknown as MediaLibrary.Asset);
}

/**
 * Is the asset still on the device? Android throws for lack of
 * ACCESS_MEDIA_LOCATION even when it exists, so only a clean "not found"
 * counts as gone.
 */
async function assetStillExists(assetId: string): Promise<boolean> {
  try {
    return !!(await MediaLibrary.getAssetInfoAsync(assetId));
  } catch {
    return true;
  }
}

type Persisted = {
  doc: AlbumsDoc;
  sha: string | null;
  ops: AlbumOp[];
  pending: PendingDeviceItem[];
  pulledAt: number;
};

type AlbumsState = Persisted & {
  repoKey: string | null;
  /** `doc` with unsynced `ops` applied: what every screen renders. */
  albums: Album[];
  loaded: boolean;
  syncing: boolean;
  /** Last sync failure, phrased for people. Cleared by the next success. */
  lastError: string | null;
  uploading: boolean;
};

const initial = (): Persisted => ({ doc: emptyDoc(), sha: null, ops: [], pending: [], pulledAt: 0 });

export const useAlbumStore = create<AlbumsState>(() => ({
  ...initial(),
  repoKey: null,
  albums: [],
  loaded: false,
  syncing: false,
  lastError: null,
  uploading: false,
}));

function update(partial: Partial<AlbumsState>, persistNow = true): void {
  useAlbumStore.setState((state) => {
    const next = { ...state, ...partial };
    if ('doc' in partial || 'ops' in partial) next.albums = applyOps(next.doc, next.ops).albums;
    return next;
  });
  if (persistNow) void persist();
}

function repoKeyFor(repo: CurrentRepo | null): string | null {
  return repo ? `${repo.owner}/${repo.name}@${repo.branch || 'main'}` : null;
}

function storePath(repoKey: string): string {
  const safe = repoKey.replace(/[^A-Za-z0-9._-]+/g, '_');
  return `${FileSystem.documentDirectory}gitgallery/albums/${safe}.json`;
}

async function persist(): Promise<void> {
  const { repoKey, doc, sha, ops, pending, pulledAt } = useAlbumStore.getState();
  if (!repoKey) return;
  const data: Persisted = { doc, sha, ops, pending, pulledAt };
  try {
    const path = storePath(repoKey);
    await FileSystem.makeDirectoryAsync(path.slice(0, path.lastIndexOf('/')), { intermediates: true }).catch(() => {});
    await FileSystem.writeAsStringAsync(path, JSON.stringify(data));
  } catch (error: any) {
    console.warn('[albums] could not save locally', error?.message ?? error);
  }
}

async function readPersisted(repoKey: string): Promise<Persisted> {
  try {
    const raw = await FileSystem.readAsStringAsync(storePath(repoKey));
    const value = JSON.parse(raw) as Partial<Persisted>;
    return {
      doc: parseAlbumsDoc(value.doc),
      sha: typeof value.sha === 'string' ? value.sha : null,
      ops: Array.isArray(value.ops) ? value.ops : [],
      pending: Array.isArray(value.pending) ? value.pending.filter((p) => p && typeof p.assetId === 'string') : [],
      pulledAt: typeof value.pulledAt === 'number' ? value.pulledAt : 0,
    };
  } catch {
    return initial();
  }
}

// ── Remote file ──────────────────────────────────────────────────────────────

function currentRepoInfo() {
  const repo = useAppStore.getState().currentRepo;
  if (!repo) throw new Error('No repository selected');
  return { owner: repo.owner, name: repo.name, branch: resolveBranch(repo.branch || 'main') };
}

async function fetchRemote(): Promise<{ doc: AlbumsDoc; sha: string | null }> {
  const octokit = getOctokit();
  const repo = currentRepoInfo();
  try {
    const res = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner: repo.owner,
      repo: repo.name,
      path: ALBUMS_PATH,
      ref: repo.branch,
      // The API sends max-age=60; without this the platform HTTP cache can
      // hand back a minute-old copy and every write would hit a stale sha.
      headers: { 'cache-control': 'no-cache' },
    });
    const data = res.data as any;
    if (Array.isArray(data) || !data?.sha) return { doc: emptyDoc(), sha: null };
    let content: string = data.content ?? '';
    if (!content) {
      // Files over 1 MB come back without content; read the blob instead.
      const blob = await octokit.git.getBlob({ owner: repo.owner, repo: repo.name, file_sha: data.sha });
      content = blob.data.content ?? '';
    }
    const text = Buffer.from(content.replace(/\s+/g, ''), 'base64').toString('utf-8');
    return { doc: parseAlbumsDoc(text), sha: data.sha };
  } catch (error: any) {
    if (error?.status === 404) return { doc: emptyDoc(), sha: null };
    throw error;
  }
}

async function writeRemote(doc: AlbumsDoc, sha: string | null, message: string): Promise<string | null> {
  const octokit = getOctokit();
  const repo = currentRepoInfo();
  const res = await octokit.repos.createOrUpdateFileContents({
    owner: repo.owner,
    repo: repo.name,
    branch: repo.branch,
    path: ALBUMS_PATH,
    message,
    content: Buffer.from(serializeAlbumsDoc(doc), 'utf-8').toString('base64'),
    ...(sha ? { sha } : {}),
  });
  invalidateRemoteHead();
  return (res.data as any)?.content?.sha ?? null;
}

function isConflict(error: any): boolean {
  if (error?.status === 409) return true;
  return error?.status === 422 && /sha/i.test(String(error?.message ?? ''));
}

function describeError(error: any): string {
  const text = String(error?.message ?? error ?? '');
  if (/Network request failed|network connection|offline|timed out|ENOTFOUND|getaddrinfo/i.test(text)) {
    return 'Offline. Album changes are saved on this phone and will sync when you are back online.';
  }
  if (error?.status === 401) return 'GitHub sign-in expired. Sign out and back in from Settings.';
  if (error?.status === 403 && /rate limit/i.test(text)) return 'GitHub rate limit reached. Albums will sync shortly.';
  if (error?.status === 403 || error?.status === 404) return 'GitHub refused the album update. Check that you can write to this repository.';
  return 'Album changes could not be synced yet. They are saved on this phone.';
}

function commitMessage(ops: AlbumOp[], albums: Album[]): string {
  const nameOf = (id: string, fallback?: string) => albums.find((a) => a.id === id)?.name ?? fallback ?? 'album';
  if (ops.length === 1) {
    const op = ops[0];
    switch (op.type) {
      case 'create': return `Create album "${cleanAlbumName(op.name)}"`;
      case 'rename': return `Rename album to "${cleanAlbumName(op.name)}"`;
      case 'delete': return 'Delete an album';
      case 'add': return `Add ${op.paths.length} item${op.paths.length === 1 ? '' : 's'} to "${nameOf(op.id)}"`;
      case 'remove': return `Remove ${op.paths.length} item${op.paths.length === 1 ? '' : 's'} from "${nameOf(op.id)}"`;
      case 'cover': return `Change the cover of "${nameOf(op.id)}"`;
    }
  }
  return `Update albums (${ops.length} changes)`;
}

// ── Sync ─────────────────────────────────────────────────────────────────────

const RETRY_MIN_MS = 10_000;
const RETRY_MAX_MS = 5 * 60_000;
let retryDelayMs = RETRY_MIN_MS;
let syncPromise: Promise<void> | null = null;
let syncAgain = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSync(delayMs = 700): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncAlbums();
  }, delayMs);
}

/**
 * Push local edits and pull everyone else's. Safe to call any time; calls
 * made while a sync is running are folded into one more pass.
 */
export function syncAlbums(): Promise<void> {
  if (syncPromise) {
    syncAgain = true;
    return syncPromise;
  }
  syncPromise = (async () => {
    do {
      syncAgain = false;
      await syncOnce();
    } while (syncAgain);
  })().finally(() => {
    syncPromise = null;
  });
  return syncPromise;
}

async function syncOnce(): Promise<void> {
  const repoKey = useAlbumStore.getState().repoKey;
  if (!repoKey || !useAppStore.getState().authToken) return;
  update({ syncing: true }, false);
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const remote = await fetchRemote();
      if (useAlbumStore.getState().repoKey !== repoKey) return;
      const ops = useAlbumStore.getState().ops;
      if (ops.length === 0) {
        update({ doc: remote.doc, sha: remote.sha, pulledAt: Date.now() });
        break;
      }
      const next = { ...applyOps(remote.doc, ops), updatedAt: Date.now() };
      try {
        const sha = await writeRemote(next, remote.sha, commitMessage(ops, next.albums));
        if (useAlbumStore.getState().repoKey !== repoKey) return;
        // Edits made while the write was in flight stay queued for the next pass.
        const later = useAlbumStore.getState().ops.slice(ops.length);
        update({ doc: next, sha, ops: later, pulledAt: Date.now() });
        if (later.length > 0) syncAgain = true;
        break;
      } catch (error) {
        if (isConflict(error) && attempt < 3) continue;
        throw error;
      }
    }
    update({ lastError: null }, false);
    retryDelayMs = RETRY_MIN_MS;
  } catch (error: any) {
    console.warn('[albums] sync failed', error?.status ?? '', error?.message ?? error);
    update({ lastError: describeError(error) }, false);
    // Unsynced edits retry on their own, backing off, so coming back online
    // syncs without the user having to do anything.
    if (useAlbumStore.getState().ops.length > 0) {
      scheduleSync(retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
    }
  } finally {
    update({ syncing: false }, false);
  }
}

function pushOp(op: AlbumOp): void {
  update({ ops: [...useAlbumStore.getState().ops, op] });
  scheduleSync();
}

// ── Public edits ─────────────────────────────────────────────────────────────

export function createAlbum(name: string): string | null {
  const clean = cleanAlbumName(name);
  if (!clean || isAlbumNameTaken(useAlbumStore.getState().albums, clean)) return null;
  const id = newAlbumId();
  pushOp({ type: 'create', id, name: clean, at: Date.now() });
  return id;
}

export function renameAlbum(id: string, name: string): boolean {
  const clean = cleanAlbumName(name);
  if (!clean || isAlbumNameTaken(useAlbumStore.getState().albums, clean, id)) return false;
  pushOp({ type: 'rename', id, name: clean, at: Date.now() });
  return true;
}

export function deleteAlbum(id: string): void {
  update({ pending: useAlbumStore.getState().pending.filter((p) => p.albumId !== id) });
  pushOp({ type: 'delete', id, at: Date.now() });
}

export function addPathsToAlbum(id: string, paths: string[]): number {
  const album = useAlbumStore.getState().albums.find((a) => a.id === id);
  if (!album) return 0;
  const present = new Set(album.items);
  const fresh = Array.from(new Set(paths.map(normalizeAlbumPath))).filter((p) => p && !present.has(p));
  if (fresh.length > 0) pushOp({ type: 'add', id, paths: fresh, at: Date.now() });
  return fresh.length;
}

/** Remove repo paths and/or not-yet-uploaded device items from an album. */
export function removeFromAlbum(id: string, paths: string[], pendingAssetIds: string[] = []): void {
  if (pendingAssetIds.length > 0) {
    const drop = new Set(pendingAssetIds);
    update({ pending: useAlbumStore.getState().pending.filter((p) => !(p.albumId === id && drop.has(p.assetId))) });
  }
  if (paths.length > 0) pushOp({ type: 'remove', id, paths, at: Date.now() });
}

export function setAlbumCover(id: string, path: string | null): void {
  pushOp({ type: 'cover', id, path, at: Date.now() });
}

/**
 * Add photos from the device. Ones already backed up join the album at once;
 * the rest upload first and join as each lands, even if the app restarts in
 * between.
 */
export async function addDeviceAssetsToAlbum(
  albumId: string,
  assets: MediaLibrary.Asset[],
): Promise<{ added: number; uploading: number }> {
  const ready: string[] = [];
  const needUpload: MediaLibrary.Asset[] = [];
  for (const asset of assets) {
    const path = await resolveRepoPathForAsset(asset).catch(() => null);
    if (path) ready.push(path);
    else needUpload.push(asset);
  }
  const added = ready.length > 0 ? addPathsToAlbum(albumId, ready) : 0;
  if (needUpload.length > 0) {
    const existing = useAlbumStore.getState().pending;
    const known = new Set(existing.map((p) => `${p.albumId}:${p.assetId}`));
    const now = Date.now();
    const fresh: PendingDeviceItem[] = needUpload
      .filter((asset) => !known.has(`${albumId}:${asset.id}`))
      .map((asset) => ({
        albumId,
        assetId: asset.id,
        uri: asset.uri,
        mediaType: asset.mediaType === 'video' ? 'video' : 'photo',
        width: asset.width ?? 0,
        height: asset.height ?? 0,
        creationTime: asset.creationTime ?? now,
        duration: asset.duration ?? 0,
        addedAt: now,
        asset: assetSnapshot(asset),
      }));
    update({ pending: [...existing, ...fresh] });
    void uploadAndResolve(needUpload);
  }
  return { added, uploading: needUpload.length };
}

let uploadChain: Promise<void> = Promise.resolve();

function uploadAndResolve(assets: MediaLibrary.Asset[]): Promise<void> {
  uploadChain = uploadChain.then(async () => {
    update({ uploading: true }, false);
    try {
      await runSyncForAssets(assets, { allowBlocked: true, source: 'album' });
    } catch (error: any) {
      console.warn('[albums] upload for album failed', error?.message ?? error);
    } finally {
      update({ uploading: false }, false);
    }
    await resolvePending();
  });
  return uploadChain;
}

/** Retry uploads for device items still waiting (after a restart or failure). */
export async function retryPendingUploads(): Promise<void> {
  const pending = useAlbumStore.getState().pending;
  if (pending.length === 0 || useAlbumStore.getState().uploading) return;
  await resolvePending();
  const left = useAlbumStore.getState().pending;
  if (left.length === 0) return;
  const byId = new Map<string, MediaLibrary.Asset>();
  for (const item of left) if (item.asset && !byId.has(item.assetId)) byId.set(item.assetId, item.asset);
  if (byId.size > 0) await uploadAndResolve([...byId.values()]);
}

let resolving: Promise<void> | null = null;

/** Turn uploaded device items into album paths. */
export function resolvePending(): Promise<void> {
  if (resolving) return resolving;
  resolving = (async () => {
    const snapshot = useAlbumStore.getState().pending;
    if (snapshot.length === 0) return;
    const albumIds = new Set(useAlbumStore.getState().albums.map((a) => a.id));
    const done = new Set<string>();
    const adds = new Map<string, string[]>();
    for (const item of snapshot) {
      const key = `${item.albumId}:${item.assetId}`;
      if (!albumIds.has(item.albumId)) {
        done.add(key);
        continue;
      }
      const path = await resolveRepoPathForAsset(assetFor(item)).catch(() => null);
      if (path) {
        done.add(key);
        adds.set(item.albumId, [...(adds.get(item.albumId) ?? []), path]);
      } else if (!(await assetStillExists(item.assetId))) {
        // Deleted from the device before it uploaded.
        done.add(key);
      }
    }
    if (done.size > 0) {
      update({ pending: useAlbumStore.getState().pending.filter((p) => !done.has(`${p.albumId}:${p.assetId}`)) });
    }
    for (const [albumId, paths] of adds) addPathsToAlbum(albumId, paths);
  })().finally(() => {
    resolving = null;
  });
  return resolving;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * Albums from before they synced lived in SecureStore as name -> keys, where a
 * key was a device asset id or a repo path. Fold them in once.
 */
async function migrateLegacyAlbums(): Promise<void> {
  const legacy = useAppStore.getState().userAlbums ?? {};
  const names = Object.keys(legacy);
  if (names.length === 0) return;
  for (const name of names) {
    const existing = useAlbumStore.getState().albums.find(
      (a) => a.name.toLocaleLowerCase() === cleanAlbumName(name).toLocaleLowerCase(),
    );
    const id = existing?.id ?? createAlbum(name);
    if (!id) continue;
    const keys = legacy[name] ?? [];
    const paths = keys.filter((k) => k.startsWith('gitgallery/'));
    if (paths.length > 0) addPathsToAlbum(id, paths);
    const assetIds = keys.filter((k) => !k.startsWith('gitgallery/'));
    const assets: MediaLibrary.Asset[] = [];
    for (const assetId of assetIds) {
      // Uploaded ones resolve by id alone; the rest need their fields to upload.
      const known = await resolveRepoPathForAsset({ id: assetId } as MediaLibrary.Asset).catch(() => null);
      if (known) {
        addPathsToAlbum(id, [known]);
        continue;
      }
      const info = await MediaLibrary.getAssetInfoAsync(assetId).catch(() => null);
      if (info) assets.push(info as MediaLibrary.Asset);
    }
    if (assets.length > 0) await addDeviceAssetsToAlbum(id, assets);
  }
  useAppStore.setState({ userAlbums: {} });
  await SecureStore.deleteItemAsync('userAlbums').catch(() => {});
}

let loadingKey: string | null = null;

/** Point the album store at the signed-in repo. Idempotent. */
export async function loadAlbumsForRepo(repo: CurrentRepo | null): Promise<void> {
  const key = repoKeyFor(repo);
  if (key === useAlbumStore.getState().repoKey && (useAlbumStore.getState().loaded || loadingKey === key)) return;
  loadingKey = key;
  if (!key) {
    useAlbumStore.setState({ ...initial(), repoKey: null, albums: [], loaded: false, lastError: null });
    return;
  }
  const saved = await readPersisted(key);
  if (loadingKey !== key) return;
  useAlbumStore.setState({
    ...saved,
    repoKey: key,
    albums: applyOps(saved.doc, saved.ops).albums,
    loaded: true,
    lastError: null,
  });
  await migrateLegacyAlbums().catch((error) => console.warn('[albums] migration failed', error?.message ?? error));
  await syncAlbums();
  void retryPendingUploads().catch(() => {});
}

let lifecycleStarted = false;

/** Foreground pulls and upload completions keep albums current. */
export function startAlbumLifecycle(): void {
  if (lifecycleStarted) return;
  lifecycleStarted = true;
  AppState.addEventListener('change', (state) => {
    if (state !== 'active') return;
    const { repoKey, pulledAt, ops } = useAlbumStore.getState();
    if (!repoKey) return;
    if (ops.length > 0 || Date.now() - pulledAt > 15_000) void syncAlbums();
    void retryPendingUploads().catch(() => {});
  });
  subscribeCompletion((event) => {
    if (event.type === 'upload' && useAlbumStore.getState().pending.length > 0) void resolvePending();
  });
}

export function isUploadRunning(): boolean {
  return getSyncStatus().running;
}
