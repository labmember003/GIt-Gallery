import type { Collection } from './types';

export const collectionKey = (namespace: string) => `gitgallery.web.collection.v1:${namespace}`;

export function parseCollection(raw: string | null, fallback: Collection): Collection {
  if (!raw) return fallback;
  try {
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object') return fallback;
    const value = data as Partial<Collection>;
    if (!Array.isArray(value.favorites) || !Array.isArray(value.albums)) return fallback;
    return {
      favorites: [...new Set(value.favorites.filter((id): id is string => typeof id === 'string'))],
      albums: value.albums.filter((album) => album && typeof album.id === 'string'
        && typeof album.name === 'string' && Array.isArray(album.assetIds))
        .map((album) => ({ id: album.id, name: album.name, assetIds: [...new Set(album.assetIds.filter((id) => typeof id === 'string'))] })),
    };
  } catch { return fallback; }
}

export function loadCollection(namespace: string, fallback: Collection): Collection {
  try { return parseCollection(localStorage.getItem(collectionKey(namespace)), fallback); }
  catch { return fallback; }
}

export function persistCollection(namespace: string, value: Collection): boolean {
  try { localStorage.setItem(collectionKey(namespace), JSON.stringify(value)); return true; }
  catch { return false; }
}

/**
 * Add albums from the repository (made in the phone app) that this browser
 * does not have yet. Albums already here, and browser-only ones, are kept.
 */
export function withRepoAlbums(local: Collection, repo: Collection): Collection {
  const known = new Set(local.albums.map((album) => album.id));
  const extra = repo.albums.filter((album) => !known.has(album.id));
  return extra.length > 0 ? { ...local, albums: [...local.albums, ...extra] } : local;
}
