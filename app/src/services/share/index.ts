import { AppState } from 'react-native';
import { NO_CACHE } from '@/services/sync/githubClient';
import { create } from 'zustand';
import { Buffer } from 'buffer';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { getOctokit } from '@/services/sync/githubClient';
import { getMetaEntriesForPaths } from '@/services/sync/index';
import { ensureOriginalFile, ensurePreviewFile } from '@/services/sync/cloudCache';
import { isVideoRepoPath } from '@/services/sync/tiering';
import { parseCanonicalPath } from '@/services/sync/pathMetadata';
import { useAppStore } from '@/store/appState';
import { entryForPath } from '@/services/albums/previews';
import { deleteAlbum, flushAlbums, setAlbumShare, useAlbumStore, type Album, type AlbumShare } from '@/services/albums';
import {
  CHUNK_SIZE,
  PART_CHUNKS,
  SHARE_REPO,
  SHARE_REPO_DESCRIPTION,
  chunkCount,
  concat,
  fromBase64Url,
  newShareId,
  objectId,
  openChunk,
  openManifest,
  partFile,
  rawUrl,
  recordLength,
  sealChunk,
  sealManifest,
  sharePath,
  shareUrl,
  toBase64Url,
  type ShareItem,
  type ShareManifest,
  type ShareRef,
} from './format';

export { parseShareUrl, shareUrl } from './format';
export type { ShareItem, ShareManifest, ShareRef } from './format';

const random = (n: number) => Crypto.getRandomBytes(n);
/** Items written per commit, so progress is durable and a failure costs little. */
const ITEMS_PER_COMMIT = 4;

// ── Status for the UI ────────────────────────────────────────────────────────

export type ShareStatus =
  | { phase: 'idle' }
  | { phase: 'working'; done: number; total: number; label: string }
  | { phase: 'error'; message: string };

export const useShareStore = create<{ status: Record<string, ShareStatus> }>(() => ({ status: {} }));

function setStatus(albumId: string, status: ShareStatus) {
  useShareStore.setState((s) => ({ status: { ...s.status, [albumId]: status } }));
}

function describe(error: any): string {
  const text = String(error?.message ?? error ?? '');
  if (/Network request failed|network connection|offline|timed out/i.test(text)) return 'You are offline. The share will finish when you are back online.';
  if (error?.status === 401) return 'GitHub sign-in expired. Sign out and back in from Settings.';
  if (error?.status === 403 && /rate limit/i.test(text)) return 'GitHub rate limit reached. Try again in a few minutes.';
  if (/private/i.test(text) && /gitgallery-shares/.test(text)) return text;
  return 'Could not update the shared album. Try again.';
}

// ── GitHub helpers ───────────────────────────────────────────────────────────

let loginCache: { token: string; login: string } | null = null;

async function currentLogin(): Promise<string> {
  const token = useAppStore.getState().authToken ?? '';
  if (loginCache?.token === token) return loginCache.login;
  const res = await getOctokit().rest.users.getAuthenticated();
  loginCache = { token, login: res.data.login };
  return res.data.login;
}

async function ensureShareRepo(login: string): Promise<string> {
  const octokit = getOctokit();
  try {
    const res = await octokit.rest.repos.get({ owner: login, repo: SHARE_REPO });
    if (res.data.private) {
      throw new Error(`Your ${SHARE_REPO} repository is private, so share links can't open it. Make it public on GitHub, or rename it so GitGallery can create a new one.`);
    }
    return res.data.default_branch || 'main';
  } catch (error: any) {
    if (error?.status !== 404) throw error;
  }
  const created = await octokit.rest.repos.createForAuthenticatedUser({
    name: SHARE_REPO,
    description: SHARE_REPO_DESCRIPTION,
    private: false,
    auto_init: true,
    has_issues: false,
    has_projects: false,
    has_wiki: false,
  });
  return created.data.default_branch || 'main';
}

async function createBlob(owner: string, bytes: Uint8Array): Promise<string> {
  return createBlobBase64(owner, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'));
}

async function createBlobBase64(owner: string, content: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await getOctokit().git.createBlob({ owner, repo: SHARE_REPO, content, encoding: 'base64' });
      return res.data.sha;
    } catch (error: any) {
      // A repository created seconds ago can briefly answer 409 "empty".
      if (error?.status === 409 && attempt < 5) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

type Change = { path: string; sha: string | null };

/** The branch moved under us (another device). The caller re-reads and redoes the pass. */
class ShareConflict extends Error {}

/**
 * The share's state at one commit: every stored file under `shares/<id>/` and
 * the manifest. Read through the content-addressed Git data API, which (unlike
 * the contents API right after a commit) is never stale.
 */
type Snapshot = { head: string; tree: string; files: Map<string, string>; manifest: ShareManifest | null };

async function retryEmptyRepo<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      // A repository created seconds ago can briefly answer 409 "empty".
      if (error?.status === 409 && attempt < 5) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

async function subtree(owner: string, treeSha: string, name: string): Promise<string | null> {
  const res = await getOctokit().git.getTree({ owner, repo: SHARE_REPO, tree_sha: treeSha });
  return res.data.tree.find((e: any) => e.path === name && e.type === 'tree')?.sha ?? null;
}

async function readSnapshot(owner: string, branch: string, shareId: string, key: Uint8Array): Promise<Snapshot> {
  const octokit = getOctokit();
  const ref = await retryEmptyRepo(() => octokit.git.getRef({ owner, repo: SHARE_REPO, ref: `heads/${branch}`, headers: NO_CACHE }));
  const head = ref.data.object.sha;
  const commitRes = await octokit.git.getCommit({ owner, repo: SHARE_REPO, commit_sha: head });
  const tree = commitRes.data.tree.sha;
  const files = new Map<string, string>();
  const shares = await subtree(owner, tree, 'shares');
  const dir = shares ? await subtree(owner, shares, shareId) : null;
  if (dir) {
    const listing = await octokit.git.getTree({ owner, repo: SHARE_REPO, tree_sha: dir, recursive: 'true' });
    for (const entry of listing.data.tree as any[]) {
      if (entry.type === 'blob' && entry.path && entry.sha) files.set(sharePath(shareId, entry.path), entry.sha);
    }
  }
  let manifest: ShareManifest | null = null;
  const manifestSha = files.get(sharePath(shareId, 'manifest.bin'));
  if (manifestSha) {
    const blob = await octokit.git.getBlob({ owner, repo: SHARE_REPO, file_sha: manifestSha });
    manifest = openManifest(key, new Uint8Array(Buffer.from((blob.data.content ?? '').replace(/\s+/g, ''), 'base64')));
  }
  return { head, tree, files, manifest };
}

/**
 * One commit on top of exactly `snap.head`. A 422 means another device moved
 * the branch; that surfaces as ShareConflict so the whole pass is redone from
 * a fresh snapshot rather than overwriting the other device's manifest.
 *
 * `squash` makes it a new root commit (force-pushed), dropping history. Used
 * when a share stops, so its encrypted files leave the repository's history
 * too, not just its current files.
 */
async function commitOnSnapshot(owner: string, branch: string, snap: Snapshot, changes: Change[], message: string, squash = false): Promise<void> {
  if (changes.length === 0) return;
  const octokit = getOctokit();
  const tree = await octokit.git.createTree({
    owner,
    repo: SHARE_REPO,
    base_tree: snap.tree,
    tree: changes.map((c) => ({ path: c.path, mode: '100644' as const, type: 'blob' as const, sha: c.sha })),
  });
  const made = await octokit.git.createCommit({ owner, repo: SHARE_REPO, message, tree: tree.data.sha, parents: squash ? [] : [snap.head] });
  try {
    await octokit.git.updateRef({ owner, repo: SHARE_REPO, ref: `heads/${branch}`, sha: made.data.sha, force: squash });
  } catch (error: any) {
    if (error?.status === 422) throw new ShareConflict('The shared album changed on another device');
    throw error;
  }
}

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));
const MAX_UPLOADS_IN_FLIGHT = 2;

/**
 * Encrypt a local file chunk by chunk into Git blobs of PART_CHUNKS chunks
 * each. Sealed chunks go straight to a temp file and the native module
 * base64-encodes it; doing that in JS cost as much as the encryption. The
 * loop yields between chunks so progress renders and the app stays usable.
 */
async function sealFileToBlobs(
  owner: string,
  key: Uint8Array,
  id: string,
  uri: string,
  onProgress?: (fraction: number) => void,
): Promise<{ size: number; shas: string[] }> {
  const file = new File(uri);
  const size = file.size;
  const count = chunkCount(size);
  const source = file.open();
  const part = new File(Paths.cache, `share-part-${id.replace(/[^a-z0-9]/gi, '')}.bin`);
  const uploads: Promise<string>[] = [];
  let settled = 0;
  // Progress counts encryption and upload as halves of the work, so 100% means it is on GitHub.
  let sealedChunks = 0;
  let uploadedChunks = 0;
  const report = () => onProgress?.((sealedChunks + uploadedChunks) / (2 * count));
  let out: ReturnType<File['open']> | null = null;
  try {
    source.offset = 0;
    let inPart = 0;
    for (let i = 0; i < count; i++) {
      if (!out) {
        if (part.exists) part.delete();
        part.create();
        out = part.open();
        inPart = 0;
      }
      const len = i < count - 1 ? CHUNK_SIZE : size - CHUNK_SIZE * (count - 1);
      const plain = len > 0 ? source.readBytes(len) : new Uint8Array(0);
      out.writeBytes(sealChunk(key, random(24), id, i, i === count - 1, plain));
      inPart += 1;
      if (inPart === PART_CHUNKS || i === count - 1) {
        out.close();
        out = null;
        const content = await Promise.resolve(part.base64());
        // Upload in the background while the next part is encrypted; the
        // network is native, so the two overlap. A few in flight at most.
        const partChunks = inPart;
        const upload = createBlobBase64(owner, content);
        upload.then(() => {
          uploadedChunks += partChunks;
          report();
        }, () => {}); // failures surface below via Promise.all; this avoids an "unhandled rejection" in between
        uploads.push(upload);
        if (uploads.length - settled >= MAX_UPLOADS_IN_FLIGHT) await uploads[settled++];
      }
      sealedChunks = i + 1;
      report();
      await yieldToUi();
    }
    // Keeps part order: blob i is part i.
    const shas = await Promise.all(uploads);
    return { size, shas };
  } finally {
    out?.close();
    source.close();
    if (part.exists) part.delete();
  }
}

async function srcHash(path: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `gitgallery-share-src:${path}`);
  return digest.slice(0, 20);
}

function extOf(path: string): string {
  return (path.replace(/\.ptr$/, '').split('.').pop() ?? 'bin').toLowerCase();
}

function itemFiles(shareId: string, item: ShareItem): string[] {
  const out: string[] = [];
  for (let p = 0; p < item.preview.parts; p++) out.push(sharePath(shareId, partFile(item.id, 'p', p)));
  for (let p = 0; p < item.original.parts; p++) out.push(sharePath(shareId, partFile(item.id, 'o', p)));
  return out;
}

// ── Owner: create, keep in sync, stop ────────────────────────────────────────

function albumById(id: string): Album | undefined {
  return useAlbumStore.getState().albums.find((a) => a.id === id);
}

/** Create the link if needed and publish the album. Returns the share URL. */
export async function shareAlbum(albumId: string): Promise<string> {
  const album = albumById(albumId);
  if (!album) throw new Error('Album not found');
  let share = album.share ?? null;
  if (!share) {
    setStatus(albumId, { phase: 'working', done: 0, total: album.items.length, label: 'Creating the link…' });
    const login = await currentLogin();
    share = { id: newShareId(random), key: toBase64Url(random(32)), owner: login, createdAt: Date.now() };
    setAlbumShare(albumId, share);
    // Save the key in the library before anything is published under it.
    await flushAlbums();
  }
  await syncShare(albumId);
  const status = useShareStore.getState().status[albumId];
  if (status?.phase === 'error') throw new Error(status.message);
  return shareUrl({ owner: share.owner, id: share.id, key: share.key });
}

const running = new Map<string, Promise<void>>();
const again = new Set<string>();

/** Bring the shared copy in line with the album. Calls during a run fold into one more pass. */
export function syncShare(albumId: string): Promise<void> {
  const current = running.get(albumId);
  if (current) {
    again.add(albumId);
    return current;
  }
  const run = (async () => {
    do {
      again.delete(albumId);
      try {
        await syncShareOnce(albumId);
        setStatus(albumId, { phase: 'idle' });
      } catch (error: any) {
        console.warn('[share] sync failed', error?.status ?? '', error?.message ?? error);
        setStatus(albumId, { phase: 'error', message: describe(error) });
        break;
      }
    } while (again.has(albumId));
  })().finally(() => running.delete(albumId));
  running.set(albumId, run);
  return run;
}

function progressLabel(stage: 'download' | 'encrypt', n: number, total: number, fraction: number): string {
  const which = total > 1 ? ` ${n} of ${total}` : '';
  if (stage === 'download') return `Getting${which || ' the original'} from your library…`;
  return `Encrypting and uploading${which} · ${Math.round(fraction * 100)}%`;
}

/** Encrypted uploads that are not committed yet, so a retried pass never uploads twice. */
const prepared = new Map<string, { item: ShareItem; changes: Change[] }>();

async function prepareItem(
  login: string,
  share: AlbumShare,
  key: Uint8Array,
  path: string,
  src: string,
  meta: Awaited<ReturnType<typeof getMetaEntriesForPaths>>,
  repoInfo: { owner: string; name: string; branch: string },
  onProgress?: (stage: 'download' | 'encrypt', fraction: number) => void,
): Promise<{ item: ShareItem; changes: Change[] }> {
  const cacheKey = `${share.id}:${src}`;
  const hit = prepared.get(cacheKey);
  if (hit) return hit;
  const entry = entryForPath(meta[path]?.repoPath ?? path, meta[path]);
  const id = toBase64Url(random(9)).toLowerCase().replace(/[^a-z0-9]/g, 'x');
  onProgress?.('download', 0);
  const previewUri = await ensurePreviewFile(entry, repoInfo);
  const originalUri = await ensureOriginalFile(entry, repoInfo);
  onProgress?.('encrypt', 0);
  const preview = await sealFileToBlobs(login, key, objectId(id, 'p'), previewUri);
  const original = await sealFileToBlobs(login, key, objectId(id, 'o'), originalUri, (f) => onProgress?.('encrypt', f));
  const parsed = parseCanonicalPath(path);
  const result = {
    item: {
      id,
      src,
      kind: isVideoRepoPath(path) ? ('video' as const) : ('photo' as const),
      w: parsed.width,
      h: parsed.height,
      takenAt: meta[path]?.createdAt ?? parsed.captureDate?.getTime() ?? null,
      ext: extOf(path),
      preview: { size: preview.size, parts: preview.shas.length },
      original: { size: original.size, parts: original.shas.length },
    },
    changes: [
      ...preview.shas.map((sha, p) => ({ path: sharePath(share.id, partFile(id, 'p', p)), sha })),
      ...original.shas.map((sha, p) => ({ path: sharePath(share.id, partFile(id, 'o', p)), sha })),
    ],
  };
  prepared.set(cacheKey, result);
  return result;
}

async function syncShareOnce(albumId: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await syncPass(albumId);
      return;
    } catch (error) {
      if (!(error instanceof ShareConflict) || attempt >= 5) throw error;
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
}

/**
 * Bring the stored copy in line with the album, a few items per commit so
 * progress survives an interruption. Each commit is computed from a fresh
 * snapshot, and anything under the share's folder the new manifest doesn't
 * reference (removed photos, uploads from an interrupted run) is deleted.
 */
async function syncPass(albumId: string): Promise<void> {
  const start = albumById(albumId);
  const share = start?.share;
  if (!start || !share) return;
  const login = await currentLogin();
  // Another GitHub account on this phone can't write to the owner's share.
  if (login.toLowerCase() !== share.owner.toLowerCase()) return;
  const branch = await ensureShareRepo(login);
  const key = fromBase64Url(share.key);
  const manifestPath = sharePath(share.id, 'manifest.bin');
  const repo = useAppStore.getState().currentRepo;
  if (!repo) throw new Error('No library selected');
  const repoInfo = { owner: repo.owner, name: repo.name, branch: repo.branch || 'main' };

  let total: number | null = null;
  let done = 0;
  for (;;) {
    // Re-read the album too: it may have changed while a batch uploaded.
    const album = albumById(albumId);
    if (!album || album.share?.id !== share.id) return;
    const srcByPath = new Map<string, string>();
    for (const path of album.items) srcByPath.set(path, await srcHash(path));
    const wanted = new Set(srcByPath.values());

    const snap = await readSnapshot(login, branch, share.id, key);
    const now = Date.now();
    const base: ShareManifest = snap.manifest ?? { v: 1, title: album.name, owner: login, createdAt: now, updatedAt: now, cover: null, items: [] };
    const seen = new Set<string>();
    let items = base.items.filter((i) => wanted.has(i.src) && !seen.has(i.src) && seen.add(i.src));
    const toAdd = album.items.filter((p) => !seen.has(srcByPath.get(p)!));
    if (total === null) total = toAdd.length;

    const batch = toAdd.slice(0, ITEMS_PER_COMMIT);
    const changes: Change[] = [];
    if (batch.length > 0) {
      const meta = await getMetaEntriesForPaths(batch);
      for (const [k, path] of batch.entries()) {
        const n = done + k + 1;
        const ready = await prepareItem(login, share, key, path, srcByPath.get(path)!, meta, repoInfo, (stage, f) => {
          setStatus(albumId, { phase: 'working', done: n - 1 + f, total: total!, label: progressLabel(stage, n, total!, f) });
        });
        items = [...items, ready.item];
        changes.push(...ready.changes);
      }
    }

    const referenced = new Set([manifestPath, ...items.flatMap((i) => itemFiles(share.id, i))]);
    for (const path of snap.files.keys()) if (!referenced.has(path)) changes.push({ path, sha: null });

    const coverSrc = album.cover ? srcByPath.get(album.cover) ?? null : null;
    const cover = (coverSrc && items.find((i) => i.src === coverSrc)?.id) || null;
    const sameItems = !!snap.manifest && items.length === snap.manifest.items.length;
    const unchanged = changes.length === 0 && sameItems && base.title === album.name && (base.cover ?? null) === cover;
    if (unchanged) return;

    const next: ShareManifest = { ...base, title: album.name, owner: login, updatedAt: Date.now(), cover, items };
    changes.push({ path: manifestPath, sha: await createBlob(login, sealManifest(key, next, random).bytes) });
    const message = batch.length > 0 ? `Share ${done + batch.length} of ${total} items in ${share.id}` : `Update shared album ${share.id}`;
    await commitOnSnapshot(login, branch, snap, changes, message);
    for (const path of batch) prepared.delete(`${share.id}:${srcByPath.get(path)}`);
    done += batch.length;
    if (toAdd.length <= batch.length) return;
  }
}

/** Delete the shared copy and forget the link. */
export async function stopSharing(albumId: string): Promise<void> {
  const album = albumById(albumId);
  const share = album?.share;
  if (!share) return;
  setStatus(albumId, { phase: 'working', done: 0, total: 0, label: 'Removing the shared copy…' });
  try {
    await running.get(albumId)?.catch(() => {});
    const login = await currentLogin();
    if (login.toLowerCase() === share.owner.toLowerCase()) {
      let branch: string | null = null;
      try {
        const res = await getOctokit().rest.repos.get({ owner: login, repo: SHARE_REPO });
        branch = res.data.default_branch || 'main';
      } catch (error: any) {
        if (error?.status !== 404) throw error;
      }
      if (branch) {
        const snap = await readSnapshot(login, branch, share.id, fromBase64Url(share.key));
        const gone = [...snap.files.keys()].map((path) => ({ path, sha: null }));
        await commitOnSnapshot(login, branch, snap, gone, `Stop sharing ${share.id}`, true);
      }
    }
    for (const k of [...prepared.keys()]) if (k.startsWith(`${share.id}:`)) prepared.delete(k);
    setAlbumShare(albumId, null);
    setStatus(albumId, { phase: 'idle' });
  } catch (error: any) {
    setStatus(albumId, { phase: 'error', message: describe(error) });
    throw error;
  }
}

/** Deleting a shared album takes its link down first, so no copy outlives it. */
export async function deleteAlbumEverywhere(albumId: string): Promise<void> {
  if (albumById(albumId)?.share) await stopSharing(albumId);
  deleteAlbum(albumId);
}

let lifecycleStarted = false;
const signatures = new Map<string, string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let caughtUpFor: string | null = null;

/**
 * Re-publish a shared album a few seconds after its photos, name or cover
 * change, and once per library load, so a copy that fell behind (an edit on
 * another device, a failed run before the app was closed) catches up.
 */
export function startShareLifecycle(): void {
  if (lifecycleStarted) return;
  lifecycleStarted = true;
  // In development a hot reload re-runs this module; drop the previous
  // instance's listeners so edits don't trigger one sync per reload.
  const holder = globalThis as { __ggShareLifecycle?: () => void };
  holder.__ggShareLifecycle?.();
  const unsubscribe = useAlbumStore.subscribe((state) => {
    if (state.loaded && state.repoKey && caughtUpFor !== state.repoKey) {
      caughtUpFor = state.repoKey;
      const shared = state.albums.filter((a) => a.share).map((a) => a.id);
      if (shared.length > 0) setTimeout(() => shared.forEach((id) => void syncShare(id)), 5000);
    }
    for (const album of state.albums) {
      if (!album.share) {
        signatures.delete(album.id);
        continue;
      }
      const sig = `${album.share.id}|${album.name}|${album.cover ?? ''}|${album.items.join(',')}`;
      const previous = signatures.get(album.id);
      signatures.set(album.id, sig);
      if (previous === undefined || previous === sig) continue;
      clearTimeout(timers.get(album.id));
      timers.set(album.id, setTimeout(() => void syncShare(album.id), 4000));
    }
  });
  const appState = AppState.addEventListener('change', (s) => {
    if (s !== 'active') return;
    for (const [albumId, status] of Object.entries(useShareStore.getState().status)) {
      if (status.phase === 'error') void syncShare(albumId);
    }
  });
  holder.__ggShareLifecycle = () => {
    unsubscribe();
    appState.remove();
  };
}

export function shareOf(album: Album | null | undefined): AlbumShare | null {
  return album?.share ?? null;
}

// ── Viewer: open someone's link ──────────────────────────────────────────────

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  if (res.status === 404) throw Object.assign(new Error('This shared album is no longer available.'), { status: 404 });
  if (!res.ok) throw Object.assign(new Error(`GitHub answered ${res.status}`), { status: res.status });
  return new Uint8Array(await res.arrayBuffer());
}

const manifests = new Map<string, ShareManifest>();

export async function fetchSharedAlbum(ref: ShareRef): Promise<ShareManifest> {
  let bytes: Uint8Array;
  try {
    bytes = await fetchBytes(`${rawUrl(ref.owner, sharePath(ref.id, 'manifest.bin'))}?t=${Date.now()}`);
  } catch (error: any) {
    if (error?.status === 404) manifests.delete(`${ref.owner}/${ref.id}`);
    throw error;
  }
  const manifest = openManifest(fromBase64Url(ref.key), bytes);
  manifests.set(`${ref.owner}/${ref.id}`, manifest);
  return manifest;
}

/** Last manifest fetched this session, for covers on the Albums tab. */
export function cachedSharedAlbum(ref: ShareRef): ShareManifest | null {
  return manifests.get(`${ref.owner}/${ref.id}`) ?? null;
}

function cacheDir(ref: ShareRef): Directory {
  const dir = new Directory(Paths.cache, 'shared', `${ref.owner}-${ref.id}`);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

const inflight = new Map<string, Promise<string>>();
let activeDownloads = 0;
const queue: Array<() => void> = [];

function slot<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      activeDownloads++;
      fn().then(resolve, reject).finally(() => {
        activeDownloads--;
        queue.shift()?.();
      });
    };
    if (activeDownloads < 4) start();
    else queue.push(start);
  });
}

/**
 * Download and decrypt one stored object to a cache file, part by part, so a
 * long video never sits in memory whole.
 */
async function openToFile(ref: ShareRef, item: ShareItem, kind: 'p' | 'o', onProgress?: (fraction: number) => void): Promise<string> {
  const name = kind === 'p' ? `${item.id}.preview.jpg` : `${item.id}.${item.ext}`;
  const out = new File(cacheDir(ref), name);
  if (out.exists && out.size === (kind === 'p' ? item.preview.size : item.original.size)) return out.uri;
  const cacheKey = `${ref.owner}/${ref.id}/${name}`;
  const running = inflight.get(cacheKey);
  if (running) return running;
  const job = slot(async () => {
    const key = fromBase64Url(ref.key);
    const info = kind === 'p' ? item.preview : item.original;
    const id = objectId(item.id, kind);
    const count = chunkCount(info.size);
    const tmp = new File(cacheDir(ref), `${name}.part`);
    if (tmp.exists) tmp.delete();
    tmp.create();
    const handle = tmp.open();
    try {
      let index = 0;
      const download = new File(cacheDir(ref), `${name}.download`);
      for (let p = 0; p < info.parts; p++) {
        // Native download, then the bytes through JSI: RN's fetch().arrayBuffer() is slow for 8 MB bodies.
        if (download.exists) download.delete();
        try {
          await File.downloadFileAsync(rawUrl(ref.owner, sharePath(ref.id, partFile(item.id, kind, p))), download);
        } catch (error: any) {
          throw Object.assign(new Error('Could not download this item'), { status: /404/.test(String(error?.message)) ? 404 : undefined });
        }
        const bytes = await download.bytes();
        download.delete();
        let read = 0;
        while (read < bytes.length) {
          const len = recordLength(info.size, index);
          handle.writeBytes(openChunk(key, id, index, index === count - 1, bytes.subarray(read, read + len)));
          read += len;
          index++;
          onProgress?.(index / count);
          await yieldToUi();
        }
      }
      if (index !== count) throw new Error('Shared file is incomplete');
    } finally {
      handle.close();
    }
    if (out.exists) out.delete();
    tmp.move(out);
    return out.uri;
  }).finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, job);
  return job;
}

export function sharedPreview(ref: ShareRef, item: ShareItem): Promise<string> {
  return openToFile(ref, item, 'p');
}

export function sharedOriginal(ref: ShareRef, item: ShareItem, onProgress?: (fraction: number) => void): Promise<string> {
  return openToFile(ref, item, 'o', onProgress);
}
