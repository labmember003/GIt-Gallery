import { xchacha20poly1305 } from '@noble/ciphers/chacha';

/**
 * Shared albums: format, links and encryption. Pure, so phone, web and tests
 * share it.
 *
 * Photos live in the owner's private library, which GitHub cannot share by
 * link. Sharing therefore publishes encrypted copies to a public repository in
 * the owner's own account (`gitgallery-shares`). The key travels only in the
 * link's fragment (after `#`), which browsers never send to a server, so
 * GitHub, the website and anyone browsing the repository see ciphertext.
 *
 * Stored objects are sequences of independently sealed chunks
 * (XChaCha20-Poly1305, random 24-byte nonce each). The associated data binds
 * each chunk to its object, its position and whether it is the last one, so
 * chunks cannot be swapped between files, reordered or cut off unnoticed.
 * Chunking lets a 500 MB video be encrypted and decrypted a megabyte at a
 * time, and splits it into parts small enough for Git blobs.
 */

export const SHARE_REPO = 'gitgallery-shares';
export const SHARE_REPO_DESCRIPTION = 'Encrypted shared albums from GitGallery. Files here can only be opened with a share link.';
export const SHARE_WEB_ORIGIN = 'https://gitgallery-umber.vercel.app';
export const CHUNK_SIZE = 1024 * 1024;
/** Chunks per stored part: keeps each Git blob around 8 MB. */
export const PART_CHUNKS = 8;
const NONCE = 24;
const TAG = 16;
export const RECORD_OVERHEAD = NONCE + TAG;

export type ShareRef = { owner: string; id: string; key: string };

export type ShareItem = {
  /** Random id; also names the stored files. */
  id: string;
  /** Truncated SHA-256 of the owner's library path, so the owner can diff without revealing names. */
  src: string;
  kind: 'photo' | 'video';
  w: number | null;
  h: number | null;
  takenAt: number | null;
  ext: string;
  preview: { size: number; parts: number };
  original: { size: number; parts: number };
};

export type ShareManifest = {
  v: 1;
  title: string;
  owner: string;
  createdAt: number;
  updatedAt: number;
  cover: string | null;
  items: ShareItem[];
};

// ── Base64url ────────────────────────────────────────────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error('Invalid share key');
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (value >> bits) & 255;
    }
  }
  return out.slice(0, o);
}

// ── Links ────────────────────────────────────────────────────────────────────

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const ID_RE = /^[a-z0-9]{8,40}$/;

export function shareUrl(ref: ShareRef): string {
  return `${SHARE_WEB_ORIGIN}/s/${ref.owner}/${ref.id}#${ref.key}`;
}

/** Accepts the web link and the app's own scheme (`gitgallery://share/...`). */
export function parseShareUrl(url: string): ShareRef | null {
  const text = String(url ?? '').trim();
  const match =
    /^https?:\/\/[^/]+\/s\/([^/#?]+)\/([^/#?]+)\/?(?:\?[^#]*)?#(?:k=)?([A-Za-z0-9_-]{43})$/.exec(text) ??
    /^gitgallery:\/\/share\/([^/#?]+)\/([^/#?]+)\/?(?:\?[^#]*)?#(?:k=)?([A-Za-z0-9_-]{43})$/.exec(text);
  if (!match) return null;
  const [, owner, id, key] = match;
  if (!OWNER_RE.test(owner) || !ID_RE.test(id)) return null;
  if (fromBase64Url(key).length !== 32) return null;
  return { owner, id, key };
}

export function sharePath(id: string, file: string): string {
  return `shares/${id}/${file}`;
}

export function partFile(itemId: string, kind: 'p' | 'o', part: number): string {
  return `${kind}/${itemId}.${part}.bin`;
}

/**
 * Public, CDN-served location of a stored file at a commit. Viewers pin the
 * commit once per load (`resolveShareCommit`): raw.githubusercontent.com can
 * keep resolving `HEAD` to an older commit for a few minutes, which would show
 * a stopped share or miss newly added photos. A commit SHA is never stale, and
 * every file then comes from the same commit.
 */
export function rawUrl(owner: string, path: string, commit = 'HEAD'): string {
  return `https://raw.githubusercontent.com/${owner}/${SHARE_REPO}/${commit}/${path}`;
}

/**
 * The share repo's current commit, from the public API (no sign-in; the
 * `Accept` value keeps it a simple CORS request). Falls back to `HEAD` when the
 * API is unreachable or rate-limited, so viewing never depends on it.
 */
export async function resolveShareCommit(owner: string, fetcher: typeof fetch = fetch): Promise<string> {
  try {
    const res = await fetcher(`https://api.github.com/repos/${owner}/${SHARE_REPO}/commits/HEAD`, {
      headers: { Accept: 'application/vnd.github.sha' },
      cache: 'no-store',
    } as RequestInit);
    if (!res.ok) return 'HEAD';
    const sha = (await res.text()).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : 'HEAD';
  } catch {
    return 'HEAD';
  }
}

// ── Sealing ──────────────────────────────────────────────────────────────────

function aad(objectId: string, index: number, last: boolean): Uint8Array {
  return new TextEncoder().encode(`gitgallery-share:v1:${objectId}:${index}:${last ? 1 : 0}`);
}

export function sealChunk(key: Uint8Array, nonce: Uint8Array, objectId: string, index: number, last: boolean, plain: Uint8Array): Uint8Array {
  const sealed = xchacha20poly1305(key, nonce, aad(objectId, index, last)).encrypt(plain);
  const out = new Uint8Array(NONCE + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, NONCE);
  return out;
}

export function openChunk(key: Uint8Array, objectId: string, index: number, last: boolean, record: Uint8Array): Uint8Array {
  const nonce = record.subarray(0, NONCE);
  return xchacha20poly1305(key, nonce, aad(objectId, index, last)).decrypt(record.subarray(NONCE));
}

/** Number of chunks for a plaintext size (an empty file is one empty chunk). */
export function chunkCount(size: number): number {
  return Math.max(1, Math.ceil(size / CHUNK_SIZE));
}

/** Encrypted length of chunk `index` of an object of `size` bytes. */
export function recordLength(size: number, index: number): number {
  const count = chunkCount(size);
  const plain = index < count - 1 ? CHUNK_SIZE : size - CHUNK_SIZE * (count - 1);
  return plain + RECORD_OVERHEAD;
}

export function partCount(size: number): number {
  return Math.ceil(chunkCount(size) / PART_CHUNKS);
}

/** Seal a small object held in memory (manifest, previews) as one part. */
export function sealBytes(key: Uint8Array, objectId: string, plain: Uint8Array, randomBytes: (n: number) => Uint8Array): Uint8Array[] {
  const count = chunkCount(plain.length);
  const records: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = plain.subarray(i * CHUNK_SIZE, Math.min(plain.length, (i + 1) * CHUNK_SIZE));
    records.push(sealChunk(key, randomBytes(NONCE), objectId, i, i === count - 1, chunk));
  }
  const parts: Uint8Array[] = [];
  for (let p = 0; p < records.length; p += PART_CHUNKS) parts.push(concat(records.slice(p, p + PART_CHUNKS)));
  return parts;
}

/** Open an object from its parts, given its plaintext size. */
export function openBytes(key: Uint8Array, objectId: string, size: number, parts: Uint8Array[]): Uint8Array {
  const all = concat(parts);
  const count = chunkCount(size);
  const out = new Uint8Array(size);
  let read = 0;
  let written = 0;
  for (let i = 0; i < count; i++) {
    const len = recordLength(size, i);
    const plain = openChunk(key, objectId, i, i === count - 1, all.subarray(read, read + len));
    out.set(plain, written);
    read += len;
    written += plain.length;
  }
  if (read !== all.length) throw new Error('Shared file has unexpected trailing data');
  return out;
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function sealManifest(key: Uint8Array, manifest: ShareManifest, randomBytes: (n: number) => Uint8Array): { bytes: Uint8Array; size: number } {
  const plain = new TextEncoder().encode(JSON.stringify(manifest));
  // The manifest is stored as size (8 hex chars) + one part, so it opens alone.
  const header = new TextEncoder().encode(plain.length.toString(16).padStart(8, '0'));
  return { bytes: concat([header, ...sealBytes(key, 'manifest', plain, randomBytes)]), size: plain.length };
}

export function openManifest(key: Uint8Array, bytes: Uint8Array): ShareManifest {
  const size = parseInt(new TextDecoder().decode(bytes.subarray(0, 8)), 16);
  if (!Number.isFinite(size) || size < 0) throw new Error('Not a GitGallery shared album');
  const plain = openBytes(key, 'manifest', size, [bytes.subarray(8)]);
  const value = JSON.parse(new TextDecoder().decode(plain)) as ShareManifest;
  if (value?.v !== 1 || !Array.isArray(value.items)) throw new Error('Unsupported shared album');
  return value;
}

export function objectId(itemId: string, kind: 'p' | 'o'): string {
  return `${kind}:${itemId}`;
}

export function newShareId(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(12);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('') + Array.from(randomBytes(4), (b) => (b % 36).toString(36)).join('');
}
