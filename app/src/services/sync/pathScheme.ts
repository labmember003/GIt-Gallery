/**
 * Canonical repo paths: the date, dimensions and identity live in the path
 * itself, so one `git/trees?recursive=1` call is enough to render a sorted,
 * correctly-laid-out timeline without fetching a single file.
 *
 *   gitgallery/library/2026/09/19/143022_4032x3024_a1b2c3d4.jpg
 *                      │    │  │  │      │         └─ identity (dedup + uniqueness)
 *                      │    │  │  │      └─ dimensions -> aspect ratio for layout
 *                      │    │  │  └─ capture time
 *                      └────┴──┴─ capture date
 *
 * Why this replaces the old `gitgallery/images/<album>/<original name>`:
 *
 *  - Paths sort lexicographically == chronologically, so the timeline needs no
 *    per-file metadata fetch and no server-side sort.
 *  - Aspect ratio is known before any image loads, so the grid can lay out at
 *    the right shape with no layout shift.
 *  - Original filenames collide (two albums both holding `IMG_1234.jpg` map to
 *    different paths only by luck of the album name); the identity suffix makes
 *    collisions impossible.
 *
 * The date MUST come from EXIF capture time, not upload time — otherwise a
 * backlog import all files under "today" and the timeline is meaningless.
 */
import * as Crypto from 'expo-crypto';

export const LIBRARY_ROOT = 'gitgallery/library';

/** Legacy layout, still read so existing uploads stay visible. */
export const LEGACY_IMAGE_ROOT = 'gitgallery/images';

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function extensionFor(filename: string | null | undefined): string {
  const match = (filename ?? '').match(/\.([A-Za-z0-9]{1,5})$/);
  return match ? match[1].toLowerCase() : 'jpg';
}

/** Short, stable, filename-safe identity derived from the asset fingerprint. */
export async function identityHash(fingerprint: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, fingerprint);
  return digest.replace(/[^a-f0-9]/gi, '').slice(0, 8).toLowerCase();
}

export type CanonicalPathParts = {
  captureDate: Date;
  width?: number | null;
  height?: number | null;
  filename?: string | null;
  /**
   * Extension of the bytes actually stored, when it differs from the source.
   * Compression re-encodes to JPEG, so a `.heic` or `.png` original ends up as
   * JPEG bytes — naming the blob after the source would describe it wrongly.
   */
  extension?: string | null;
  identity: string;
};

export function buildCanonicalPath(parts: CanonicalPathParts): string {
  const d = parts.captureDate;
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

  const dims =
    parts.width && parts.height && parts.width > 0 && parts.height > 0
      ? `_${Math.round(parts.width)}x${Math.round(parts.height)}`
      : '';

  const ext = (parts.extension || '').replace(/^\./, '').toLowerCase() || extensionFor(parts.filename);
  return `${LIBRARY_ROOT}/${yyyy}/${mm}/${dd}/${time}${dims}_${parts.identity}.${ext}`;
}

export { parseCanonicalPath, isCanonicalPath } from './pathMetadata';
export type { ParsedPath } from './pathMetadata';
