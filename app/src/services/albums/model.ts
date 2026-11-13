/**
 * Albums, stored in the user's own repository at `gitgallery/albums.json`.
 *
 * Membership is by repo path, the one identifier every device and the web
 * companion agree on. Paths are kept without the tier-2 `.ptr` suffix, so a
 * video moved between tiers stays in its album, and so the web companion
 * (whose asset id is the path without `.ptr`) reads the same list.
 *
 * Edits are recorded as operations and replayed on top of whatever is in the
 * repo at write time. Two phones editing different albums, or adding
 * different photos to the same one, therefore merge instead of the last write
 * winning.
 */

export const ALBUMS_PATH = 'gitgallery/albums.json';
export const ALBUMS_VERSION = 1;

export type Album = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Repo path of the cover photo; null means "newest item". */
  cover: string | null;
  /** Repo paths, oldest addition first. */
  items: string[];
};

export type AlbumsDoc = {
  version: number;
  updatedAt: number;
  albums: Album[];
};

export type AlbumOp =
  | { type: 'create'; id: string; name: string; at: number }
  | { type: 'rename'; id: string; name: string; at: number }
  | { type: 'delete'; id: string; at: number }
  | { type: 'add'; id: string; paths: string[]; at: number }
  | { type: 'remove'; id: string; paths: string[]; at: number }
  | { type: 'cover'; id: string; path: string | null; at: number };

export function emptyDoc(): AlbumsDoc {
  return { version: ALBUMS_VERSION, updatedAt: 0, albums: [] };
}

export function normalizeAlbumPath(path: string): string {
  return String(path ?? '').replace(/^\/+/, '').replace(/\.ptr$/i, '');
}

export function newAlbumId(now = Date.now(), random = Math.random): string {
  return `a${now.toString(36)}${Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')}`;
}

export function cleanAlbumName(name: string): string {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** Case-insensitive, so "Goa" and "goa" can't both exist. */
export function isAlbumNameTaken(albums: Album[], name: string, exceptId?: string): boolean {
  const wanted = cleanAlbumName(name).toLocaleLowerCase();
  return albums.some((album) => album.id !== exceptId && album.name.toLocaleLowerCase() === wanted);
}

/** Accept whatever is in the repo, dropping anything malformed rather than failing. */
export function parseAlbumsDoc(raw: unknown): AlbumsDoc {
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!value || typeof value !== 'object') return emptyDoc();
  const input = value as Partial<AlbumsDoc>;
  const seen = new Set<string>();
  const albums: Album[] = [];
  for (const candidate of Array.isArray(input.albums) ? input.albums : []) {
    if (!candidate || typeof candidate !== 'object') continue;
    const album = candidate as Partial<Album>;
    if (typeof album.id !== 'string' || !album.id || seen.has(album.id)) continue;
    const name = cleanAlbumName(typeof album.name === 'string' ? album.name : '');
    if (!name) continue;
    seen.add(album.id);
    const items = Array.isArray(album.items)
      ? Array.from(new Set(album.items.filter((p): p is string => typeof p === 'string' && p.length > 0).map(normalizeAlbumPath)))
      : [];
    albums.push({
      id: album.id,
      name,
      createdAt: finite(album.createdAt),
      updatedAt: finite(album.updatedAt),
      cover: typeof album.cover === 'string' && album.cover ? normalizeAlbumPath(album.cover) : null,
      items,
    });
  }
  return { version: ALBUMS_VERSION, updatedAt: finite(input.updatedAt), albums };
}

export function serializeAlbumsDoc(doc: AlbumsDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Replay local edits on top of a document. Pure; never mutates `doc`. */
export function applyOps(doc: AlbumsDoc, ops: AlbumOp[]): AlbumsDoc {
  const albums = doc.albums.map((album) => ({ ...album, items: [...album.items] }));
  const byId = new Map(albums.map((album) => [album.id, album]));
  let updatedAt = doc.updatedAt;

  for (const op of ops) {
    updatedAt = Math.max(updatedAt, op.at);
    const album = byId.get(op.id);
    switch (op.type) {
      case 'create': {
        if (album) break;
        const name = cleanAlbumName(op.name);
        if (!name) break;
        const created: Album = { id: op.id, name, createdAt: op.at, updatedAt: op.at, cover: null, items: [] };
        albums.push(created);
        byId.set(created.id, created);
        break;
      }
      case 'rename': {
        const name = cleanAlbumName(op.name);
        if (!album || !name) break;
        album.name = name;
        album.updatedAt = op.at;
        break;
      }
      case 'delete': {
        if (!album) break;
        byId.delete(op.id);
        albums.splice(albums.indexOf(album), 1);
        break;
      }
      case 'add': {
        // Adding to an album another device deleted is dropped, not resurrected.
        if (!album) break;
        const present = new Set(album.items);
        for (const raw of op.paths) {
          const path = normalizeAlbumPath(raw);
          if (path && !present.has(path)) {
            present.add(path);
            album.items.push(path);
          }
        }
        album.updatedAt = op.at;
        break;
      }
      case 'remove': {
        if (!album) break;
        const drop = new Set(op.paths.map(normalizeAlbumPath));
        album.items = album.items.filter((path) => !drop.has(path));
        if (album.cover && drop.has(album.cover)) album.cover = null;
        album.updatedAt = op.at;
        break;
      }
      case 'cover': {
        if (!album) break;
        album.cover = op.path ? normalizeAlbumPath(op.path) : null;
        album.updatedAt = op.at;
        break;
      }
    }
  }

  return { version: ALBUMS_VERSION, updatedAt, albums };
}

/** Capture time encoded in a canonical library path, for ordering album items. */
export function captureTimeFromPath(path: string): number | null {
  const match = /gitgallery\/library\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})(\d{2})(\d{2})_/.exec(path);
  if (match) {
    const [, y, mo, d, h, mi, s] = match.map(Number);
    const t = Date.UTC(y, mo - 1, d, h, mi, s);
    return Number.isFinite(t) ? t : null;
  }
  const day = /gitgallery\/library\/(\d{4})\/(\d{2})\/(\d{2})\//.exec(path);
  if (day) return Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  return null;
}

/** Cover to show: the chosen one, else the newest item. */
export function coverPathFor(album: Album): string | null {
  if (album.cover && album.items.includes(album.cover)) return album.cover;
  let best: string | null = null;
  let bestTime = -Infinity;
  for (const path of album.items) {
    const t = captureTimeFromPath(path) ?? 0;
    if (t >= bestTime) {
      best = path;
      bestTime = t;
    }
  }
  return best;
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
