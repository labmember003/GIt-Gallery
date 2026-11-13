import { useEffect, useState } from 'react';
import { ensurePreviewUri } from '@/services/sync/cloudCache';
import type { MetaEntry, RepoInfo } from '@/services/sync/types';
import { useAppStore } from '@/store/appState';

/**
 * Cloud thumbnails for album screens.
 *
 * The gallery loads its previews one after another for the whole grid. Album
 * screens show a handful of covers or one album's items, so they load on
 * demand per tile, four at a time, and share results across screens.
 */

const LIMIT = 4;
const ready = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
const failed = new Set<string>();
let active = 0;
const waiting: Array<() => void> = [];

function slot<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      active += 1;
      fn().then(resolve, reject).finally(() => {
        active -= 1;
        waiting.shift()?.();
      });
    };
    if (active < LIMIT) start();
    else waiting.push(start);
  });
}

function repoInfo(): RepoInfo | null {
  const repo = useAppStore.getState().currentRepo;
  return repo ? { owner: repo.owner, name: repo.name, branch: repo.branch || 'main' } : null;
}

/** A stand-in index entry for a path the index has no record of. */
export function entryForPath(path: string, entry?: MetaEntry | null): MetaEntry {
  return entry ?? {
    fingerprint: path,
    repoPath: path,
    previewRepoPath: null,
    createdAt: null,
    fileSize: null,
    contentHash: null,
    uploadedAt: null,
  };
}

export function cachedPreview(path: string): string | null {
  return ready.get(path) ?? null;
}

export function loadPreview(path: string, entry?: MetaEntry | null): Promise<string | null> {
  const hit = ready.get(path);
  if (hit) return Promise.resolve(hit);
  if (failed.has(path)) return Promise.resolve(null);
  const running = inflight.get(path);
  if (running) return running;
  const repo = repoInfo();
  if (!repo) return Promise.resolve(null);
  const job = slot(() => ensurePreviewUri(entryForPath(path, entry), repo))
    .then((uri) => {
      ready.set(path, uri);
      return uri;
    })
    .catch(() => {
      failed.add(path);
      return null;
    })
    .finally(() => inflight.delete(path));
  inflight.set(path, job);
  return job;
}

/** Forget failures, e.g. after coming back online. */
export function retryFailedPreviews(): void {
  failed.clear();
}

export function useCloudPreview(path: string | null, entry?: MetaEntry | null): { uri: string | null; failed: boolean } {
  const [uri, setUri] = useState<string | null>(() => (path ? cachedPreview(path) : null));
  const [didFail, setDidFail] = useState(false);
  useEffect(() => {
    let live = true;
    setDidFail(false);
    if (!path) {
      setUri(null);
      return;
    }
    const hit = cachedPreview(path);
    if (hit) {
      setUri(hit);
      return;
    }
    setUri(null);
    loadPreview(path, entry).then((value) => {
      if (!live) return;
      setUri(value);
      setDidFail(!value);
    });
    return () => {
      live = false;
    };
  }, [path, entry]);
  return { uri, failed: didFail };
}
