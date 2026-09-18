import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import type { MetaEntry, RepoInfo } from './types';
import { resolveBranch } from './utils';
import { downloadFile } from './githubClient';

const baseDir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
if (!baseDir) {
  throw new Error('No cache directory available');
}

const ROOT_DIR = normalizeDir(`${baseDir}gitgallery/cloud-cache`);
const MANIFEST_NAME = 'manifest.json';
const PREVIEW_WIDTH = 1280;
const PREVIEW_COMPRESS = 0.72;
const PREVIEW_TOUCH_INTERVAL = 30_000;
const VIEW_TOUCH_INTERVAL = 5_000;
const PRUNE_INTERVAL_MS = 4 * 60 * 60 * 1000;
const ENTRY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ENTRY_MAX_AGE_WITH_ORIGINAL_MS = 60 * 24 * 60 * 60 * 1000;
const CACHE_SIZE_LIMIT_BYTES = 400 * 1024 * 1024;

const repoPruneTracker = new Map<string, number>();
const entryLocks = new Map<string, Promise<void>>();
const warmedRepos = new Set<string>();

export async function ensurePreviewUri(entry: MetaEntry, repo: RepoInfo): Promise<string> {
  return withEntry(entry, repo, async (ctx) => {
    const { manifest } = ctx;
    const existing = manifest.preview?.file;
    if (existing && await ctx.hasFile(existing)) {
      const now = Date.now();
      if (!manifest.lastAccessed || now - manifest.lastAccessed > PREVIEW_TOUCH_INTERVAL) {
        ctx.touchAccess(now);
      }
      return await toImageUri(ctx.filePath(existing));
    }

    const preview = await buildPreview(ctx.dir, entry, repo);
    ctx.setPreview(preview);

    if (manifest.original && !(await ctx.hasFile(manifest.original.file))) {
      ctx.clearOriginal();
    }

    return await toImageUri(ctx.filePath(preview.file));
  });
}

export async function ensureOriginalUri(entry: MetaEntry, repo: RepoInfo): Promise<string> {
  return withEntry(entry, repo, async (ctx) => {
    const { manifest } = ctx;
    const original = manifest.original?.file;
    if (original && await ctx.hasFile(original)) {
      const now = Date.now();
      if (!manifest.lastViewed || now - manifest.lastViewed > VIEW_TOUCH_INTERVAL) {
        ctx.touchView(now);
      }
      return await toImageUri(ctx.filePath(original));
    }

    const downloaded = await fetchBase64(entry.repoPath ? [entry.repoPath] : [], repo, []);
    const ext = guessExtension(downloaded.usedPath) ?? 'bin';
    const fileName = `original.${ext}`;
    const path = ctx.filePath(fileName);
    await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
    await writeBase64(path, downloaded.content);
    ctx.setOriginal({ file: fileName, updatedAt: Date.now() });
    return await toImageUri(path);
  });
}

export async function purgeRepoCache(repo: RepoInfo): Promise<void> {
  const dir = await repoDirectory(repo, false);
  if (!dir) return;
  const keyPrefix = repoLockPrefix(repo);
  const release = await acquireLock(`${keyPrefix}__purge`);
  try {
    await FileSystem.deleteAsync(dir, { idempotent: true });
  } finally {
    release();
  }
}

export async function warmRepoCache(repo: RepoInfo): Promise<void> {
  const key = repoKey(repo);
  if (warmedRepos.has(key)) return;
  warmedRepos.add(key);
  await maybePruneRepo(repo);
}

type CacheManifest = {
  fingerprint: string;
  tag: string;
  preview?: { file: string; updatedAt: number };
  original?: { file: string; updatedAt: number };
  lastAccessed?: number;
  lastViewed?: number;
};

type Base64Result = { content: string; size: number; usedPath: string };

type PreviewBuild = { file: string; updatedAt: number };

type EntryContext = {
  dir: string;
  manifest: CacheManifest;
  filePath: (file: string) => string;
  hasFile: (file?: string | null) => Promise<boolean>;
  setPreview: (preview: PreviewBuild) => void;
  setOriginal: (original: { file: string; updatedAt: number }) => void;
  clearOriginal: () => void;
  touchAccess: (time?: number) => void;
  touchView: (time?: number) => void;
  markDirty: () => void;
};

async function withEntry<T>(entry: MetaEntry, repo: RepoInfo, handler: (ctx: EntryContext) => Promise<T>): Promise<T> {
  await maybePruneRepo(repo);
  const key = entryLockKey(repo, entry.fingerprint);
  const release = await acquireLock(key);
  try {
    const dir = await ensureEntryDir(repo, entry.fingerprint);
    const manifestPath = joinPath(dir, MANIFEST_NAME);
    const tag = buildTag(entry);
    let manifest = await synchronizeManifest(manifestPath, entry.fingerprint, tag);
    let dirty = false;
    if (!manifest) {
      manifest = { fingerprint: entry.fingerprint, tag };
      dirty = true;
    }

    const markDirty = () => { dirty = true; };
    const filePath = (file: string) => joinPath(dir, file);
    const hasFile = (file?: string | null) => (file ? fileExists(filePath(file)) : Promise.resolve(false));
    const setPreview = (preview: PreviewBuild) => {
      manifest.preview = { file: preview.file, updatedAt: preview.updatedAt };
      manifest.lastAccessed = preview.updatedAt;
      markDirty();
    };
    const setOriginal = (original: { file: string; updatedAt: number }) => {
      manifest.original = { file: original.file, updatedAt: original.updatedAt };
      manifest.lastViewed = original.updatedAt;
      manifest.lastAccessed = original.updatedAt;
      markDirty();
    };
    const clearOriginal = () => {
      if (manifest.original || manifest.lastViewed) {
        delete manifest.original;
        delete manifest.lastViewed;
        markDirty();
      }
    };
    const touchAccess = (time = Date.now()) => {
      if (manifest.lastAccessed !== time) {
        manifest.lastAccessed = time;
        markDirty();
      }
    };
    const touchView = (time = Date.now()) => {
      let changed = false;
      if (manifest.lastViewed !== time) {
        manifest.lastViewed = time;
        changed = true;
      }
      if (manifest.lastAccessed !== time) {
        manifest.lastAccessed = time;
        changed = true;
      }
      if (changed) {
        markDirty();
      }
    };

    const context: EntryContext = {
      dir,
      manifest,
      filePath,
      hasFile,
      setPreview,
      setOriginal,
      clearOriginal,
      touchAccess,
      touchView,
      markDirty,
    };

    const result = await handler(context);
    if (dirty) {
      await writeManifest(manifestPath, manifest);
    }
    return result;
  } finally {
    release();
  }
}

function normalizeDir(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function joinPath(base: string, child: string): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const trimmedChild = child.replace(/^\/+/, '');
  return `${trimmedBase}/${trimmedChild}`;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
}

function repoKey(repo: RepoInfo): string {
  const branch = resolveBranch(repo.branch);
  return `${sanitizeSegment(repo.owner)}__${sanitizeSegment(repo.name)}__${sanitizeSegment(branch)}`;
}

function repoLockPrefix(repo: RepoInfo): string {
  return `${repoKey(repo)}::`;
}

function entryLockKey(repo: RepoInfo, fingerprint: string): string {
  return `${repoLockPrefix(repo)}${fingerprint}`;
}

async function acquireLock(key: string): Promise<() => void> {
  const prior = entryLocks.get(key) ?? Promise.resolve();
  let releaseResolver: (() => void) | undefined;
  const current = prior.then(() => new Promise<void>((resolve) => {
    releaseResolver = resolve;
  }));
  entryLocks.set(key, current);
  await prior.catch(() => {});
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseResolver?.();
    if (entryLocks.get(key) === current) {
      entryLocks.delete(key);
    }
  };
}

async function ensureRoot(): Promise<void> {
  await FileSystem.makeDirectoryAsync(ROOT_DIR, { intermediates: true }).catch(() => {});
}

async function repoDirectory(repo: RepoInfo, create = true): Promise<string | null> {
  await ensureRoot();
  const dir = joinPath(ROOT_DIR, repoKey(repo));
  if (!create) {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists || !info.isDirectory) return null;
    return dir;
  }
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
  return dir;
}

async function ensureEntryDir(repo: RepoInfo, fingerprint: string): Promise<string> {
  const repoDir = await repoDirectory(repo, true);
  if (!repoDir) {
    throw new Error('Failed to resolve cache directory');
  }
  const entryDir = joinPath(repoDir, sanitizeSegment(fingerprint));
  await FileSystem.makeDirectoryAsync(entryDir, { intermediates: true }).catch(() => {});
  return entryDir;
}

async function readManifest(path: string): Promise<CacheManifest | null> {
  try {
    const raw = await FileSystem.readAsStringAsync(path, { encoding: FileSystem.EncodingType.UTF8 });
    const parsed = JSON.parse(raw) as CacheManifest;
    if (!parsed?.fingerprint || !parsed?.tag) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeManifest(path: string, manifest: CacheManifest): Promise<void> {
  const payload = JSON.stringify(manifest);
  await FileSystem.writeAsStringAsync(path, payload, { encoding: FileSystem.EncodingType.UTF8 });
}

async function synchronizeManifest(path: string, fingerprint: string, tag: string): Promise<CacheManifest | null> {
  const manifest = await readManifest(path);
  if (!manifest) {
    return null;
  }
  if (manifest.fingerprint !== fingerprint || manifest.tag !== tag) {
    const dir = path.slice(0, path.lastIndexOf('/'));
    await FileSystem.deleteAsync(dir, { idempotent: true }).catch(() => {});
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
    return null;
  }
  return manifest;
}

function buildTag(entry: MetaEntry): string {
  const hash = entry.contentHash ?? 'nohash';
  const size = entry.fileSize ?? -1;
  const repoPath = entry.repoPath ?? 'nop';
  const uploadedAt = entry.uploadedAt ?? -1;
  return `${hash}|${size}|${repoPath}|${uploadedAt}`;
}

async function fileExists(path: string): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(path);
  return info.exists && !info.isDirectory;
}

function guessExtension(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.split('.');
  if (parts.length < 2) return null;
  return parts.pop()?.toLowerCase() ?? null;
}

async function writeBase64(path: string, base64: string): Promise<void> {
  await FileSystem.writeAsStringAsync(path, base64, { encoding: FileSystem.EncodingType.Base64 });
}

async function buildPreview(dir: string, entry: MetaEntry, repo: RepoInfo): Promise<PreviewBuild> {
  let tempOriginalPath: string | null = null;
  let tempOriginalExt: string | null = null;
  let originalFetch: Base64Result | null = null;
  try {
    if (entry.repoPath) {
      try {
        originalFetch = await fetchBase64([entry.repoPath], repo, entry.previewRepoPath ? [entry.previewRepoPath] : []);
        tempOriginalExt = guessExtension(originalFetch.usedPath) ?? 'bin';
        tempOriginalPath = joinPath(dir, `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.${tempOriginalExt}`);
        await writeBase64(tempOriginalPath, originalFetch.content);
        const manip = await manipulateAsync(tempOriginalPath, [{ resize: { width: PREVIEW_WIDTH } }], { compress: PREVIEW_COMPRESS, format: SaveFormat.JPEG });
        const previewFile = 'preview.jpg';
        const previewPath = joinPath(dir, previewFile);
        await FileSystem.deleteAsync(previewPath, { idempotent: true }).catch(() => {});
        const { uri } = manip;
        if (!uri) {
          throw new Error('Image manipulator returned no URI');
        }
        await FileSystem.copyAsync({ from: uri, to: previewPath });
        await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
        const updatedAt = Date.now();
        return { file: previewFile, updatedAt };
      } catch (error) {
        if (!entry.previewRepoPath) {
          throw error;
        }
      }
    }
    if (entry.previewRepoPath) {
      const fallback = await fetchBase64([entry.previewRepoPath], repo, []);
      const ext = guessExtension(fallback.usedPath) ?? 'jpg';
      const previewFile = `preview.${ext}`;
      const previewPath = joinPath(dir, previewFile);
      await FileSystem.deleteAsync(previewPath, { idempotent: true }).catch(() => {});
      await writeBase64(previewPath, fallback.content);
      return { file: previewFile, updatedAt: Date.now() };
    }
    if (tempOriginalPath && originalFetch) {
      const ext = tempOriginalExt ?? guessExtension(originalFetch.usedPath) ?? 'bin';
      const previewFile = `preview.${ext}`;
      const previewPath = joinPath(dir, previewFile);
      await FileSystem.deleteAsync(previewPath, { idempotent: true }).catch(() => {});
      await FileSystem.copyAsync({ from: tempOriginalPath, to: previewPath });
      return { file: previewFile, updatedAt: Date.now() };
    }
    throw new Error('Unable to build preview');
  } finally {
    if (tempOriginalPath) {
      await FileSystem.deleteAsync(tempOriginalPath, { idempotent: true }).catch(() => {});
    }
  }
}

async function fetchBase64(primary: string[], repo: RepoInfo, fallback: string[]): Promise<Base64Result> {
  const paths: string[] = [];
  for (const p of primary) paths.push(p);
  for (const p of fallback) paths.push(p);
  if (paths.length === 0) {
    throw new Error('No path provided');
  }
  const errors: unknown[] = [];
  for (const candidate of paths) {
    for (const variant of buildPathVariants(candidate)) {
      try {
        const result = await downloadFile(variant, repo);
        if (result?.content) {
          return { content: result.content, size: result.size, usedPath: variant };
        }
      } catch (error) {
        errors.push(error);
      }
    }
  }
  const message = errors.length > 0 ? String(errors[errors.length - 1]) : 'Unknown download failure';
  throw new Error(message);
}

function buildPathVariants(path: string): string[] {
  const variants = new Set<string>();
  variants.add(path);
  try {
    const decoded = decodeURIComponent(path);
    if (decoded !== path) variants.add(decoded);
  } catch {}
  try {
    const segments = path.split('/');
    const encodedSegments = segments.map((seg) => {
      try {
        return encodeURIComponent(decodeURIComponent(seg));
      } catch {
        return encodeURIComponent(seg);
      }
    });
    const reEncoded = encodedSegments.join('/');
    if (reEncoded !== path) variants.add(reEncoded);
  } catch {}
  try {
    const normalized = path.normalize('NFC');
    if (normalized !== path) variants.add(normalized);
  } catch {}
  return Array.from(variants);
}

async function toImageUri(path: string): Promise<string> {
  if (Platform.OS === 'android') {
    try {
      return await FileSystem.getContentUriAsync(path);
    } catch {}
  }
  return path;
}

async function maybePruneRepo(repo: RepoInfo): Promise<void> {
  const key = repoKey(repo);
  const now = Date.now();
  const last = repoPruneTracker.get(key);
  if (last && now - last < PRUNE_INTERVAL_MS) {
    return;
  }
  repoPruneTracker.set(key, now);
  const dir = await repoDirectory(repo, false);
  if (!dir) return;
  let entries: string[];
  try {
    entries = await FileSystem.readDirectoryAsync(dir);
  } catch {
    return;
  }
  if (entries.length === 0) return;
  let totalSize = 0;
  const stats: Array<{ key: string; dir: string; size: number; lastUsed: number; fingerprint: string | null }> = [];
  for (const item of entries) {
    const entryDir = joinPath(dir, item);
    const manifestPath = joinPath(entryDir, MANIFEST_NAME);
    const manifest = await readManifest(manifestPath);
    if (!manifest) {
      await FileSystem.deleteAsync(entryDir, { idempotent: true }).catch(() => {});
      continue;
    }
    const previewSize = manifest.preview ? await fileSize(joinPath(entryDir, manifest.preview.file)) : 0;
    const originalSize = manifest.original ? await fileSize(joinPath(entryDir, manifest.original.file)) : 0;
    const entrySize = previewSize + originalSize;
    totalSize += entrySize;
    const lastUsed = Math.max(manifest.lastViewed ?? 0, manifest.lastAccessed ?? 0, manifest.preview?.updatedAt ?? 0, manifest.original?.updatedAt ?? 0);
    stats.push({ key: entryLockKey(repo, manifest.fingerprint), dir: entryDir, size: entrySize, lastUsed, fingerprint: manifest.fingerprint });
    const age = now - lastUsed;
    const maxAge = manifest.original ? ENTRY_MAX_AGE_WITH_ORIGINAL_MS : ENTRY_MAX_AGE_MS;
    if (age > maxAge) {
      await removeEntry(stats[stats.length - 1]!);
    }
  }
  if (totalSize <= CACHE_SIZE_LIMIT_BYTES) {
    return;
  }
  stats.sort((a, b) => a.lastUsed - b.lastUsed);
  let currentSize = totalSize;
  for (const stat of stats) {
    if (currentSize <= CACHE_SIZE_LIMIT_BYTES * 0.8) break;
    await removeEntry(stat);
    currentSize -= stat.size;
  }
}

async function removeEntry(stat: { key: string; dir: string }): Promise<void> {
  const release = await acquireLock(stat.key);
  try {
    await FileSystem.deleteAsync(stat.dir, { idempotent: true }).catch(() => {});
  } finally {
    release();
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists || info.isDirectory) return 0;
    return info.size ?? 0;
  } catch {
    return 0;
  }
}
