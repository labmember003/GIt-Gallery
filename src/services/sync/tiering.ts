/**
 * Storage tiering: route each file by size.
 *
 *   tier 1  — git blob         (photos, small video)
 *   tier 2  — release asset    (anything the blob API would reject)
 *
 * A tier-2 file still gets a real git-tree entry at its canonical path, holding
 * a small JSON pointer instead of the bytes — the same pattern Git LFS uses.
 * That keeps one `git/trees?recursive=1` call authoritative for the whole
 * library, so the timeline, albums, dedup and Merkle-diff sync never need to
 * know which tier a file lives in.
 */
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { extractVideoFrameBase64, isVideoAsset } from './videoFrame';
import { downloadReleaseAsset, ensureRelease, releaseTagForDate, uploadReleaseAsset } from './releases';
import { putFile } from './githubClient';
import { RepoInfo } from './types';

/**
 * Measured 2026-09-18 against the live API, NOT taken from the docs.
 *
 *   35 MiB raw (46.7 MiB base64) -> 201
 *   40 MiB raw (53.3 MiB base64) -> 422 "input was too large to process"
 *
 * The real ceiling is a ~50 MB request body, i.e. ~37 MiB raw after base64's
 * ~33% inflation. GitHub's documented 100 MiB applies to `git push`, not this
 * API. 25 MiB leaves room for JSON overhead and per-file variance.
 */
export const TIER2_THRESHOLD_BYTES = 25 * 1024 * 1024;

/** Marks a tree entry as a pointer rather than the file itself. */
export const STUB_SUFFIX = '.ptr';

export type StubPointer = {
  tier: 2;
  release: string;
  assetId: number;
  name: string;
  size: number;
  contentHash?: string | null;
  /** Repo path of the small JPEG the grid renders, when one could be made. */
  preview?: string | null;
};

export type Tier = 1 | 2;

export function tierForSize(fileSize: number | null | undefined): Tier {
  if (typeof fileSize !== 'number' || Number.isNaN(fileSize)) return 1;
  return fileSize > TIER2_THRESHOLD_BYTES ? 2 : 1;
}

export function isStubPath(path: string): boolean {
  return path.endsWith(STUB_SUFFIX);
}

/** `…/x.mp4` -> `…/x.mp4.ptr`. Sorting is unaffected: the time prefix dominates. */
export function stubPathFor(repoPath: string): string {
  return `${repoPath}${STUB_SUFFIX}`;
}

/** `…/x.mp4.ptr` -> `…/x.mp4`, so callers can show the real filename. */
export function originalPathForStub(stubPath: string): string {
  return isStubPath(stubPath) ? stubPath.slice(0, -STUB_SUFFIX.length) : stubPath;
}

export function parseStub(json: string): StubPointer | null {
  try {
    const parsed = JSON.parse(json);
    if (parsed?.tier === 2 && typeof parsed.assetId === 'number') return parsed as StubPointer;
    return null;
  } catch {
    return null;
  }
}

/**
 * Release asset names are a flat namespace per release, so the name must carry
 * its own uniqueness — the content hash provides it. Slashes and spaces are
 * stripped because the name travels in a query string.
 */
export function releaseAssetName(repoPath: string, contentHash: string | null | undefined): string {
  const base = repoPath.split('/').pop() ?? 'asset';
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_');
  const shortHash = (contentHash ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'nohash';
  return `${shortHash}_${safe}`;
}

/**
 * Upload one tier-2 file: stream the bytes into a release asset, then commit a
 * pointer blob at the canonical tree path.
 *
 * The asset is uploaded *before* the stub so a crash in between leaves an
 * orphaned asset (invisible, reclaimable) rather than a stub pointing at
 * nothing (a broken entry the UI would try to render).
 */
/** Preview geometry, matched to the existing cloud preview cache. */
const PREVIEW_WIDTH = 1280;
const PREVIEW_COMPRESS = 0.72;

/** `…/x.mp4.ptr` -> `…/x.mp4.preview.jpg` */
export function previewPathFor(repoPath: string): string {
  return `${repoPath}.preview.jpg`;
}

/**
 * Small JPEG derived from the original, committed as a normal git blob.
 *
 * Without this the grid has no way to draw a tier-2 item except by pulling the
 * whole release asset — a 72 MiB download to paint one thumbnail, which in
 * practice just renders a broken-image placeholder. The preview keeps the grid
 * cheap; the full asset is only fetched when the item is opened.
 *
 * Video is handled separately. Handing an .mp4 to the image manipulator fails
 * with "Error decoding image data <NSData 62006315 bytes>" — it tries to
 * decode the whole movie as a still — so a video tile came back as a broken
 * image in the cloud grid. `expo-video` (already a dependency, for playback)
 * can extract a frame, and `VideoThumbnail` is a `SharedRef<'image'>`, which
 * the manipulator's contextual API accepts directly.
 *
 * Returns null when no preview can be produced; the caller degrades to no
 * preview rather than failing the upload.
 */
export async function buildPreviewBase64(localUri: string, isVideo = false): Promise<string | null> {
  try {
    if (isVideo) return await extractVideoFrameBase64(localUri, PREVIEW_WIDTH, PREVIEW_COMPRESS);
    const result = await manipulateAsync(
      localUri,
      [{ resize: { width: PREVIEW_WIDTH } }],
      { compress: PREVIEW_COMPRESS, format: SaveFormat.JPEG, base64: true },
    );
    return (result as any)?.base64 ?? null;
  } catch (error) {
    console.warn('[tiering] preview generation failed; item will have no thumbnail', error);
    return null;
  }
}

export async function uploadTier2(params: {
  repoPath: string;
  localUri: string;
  fileSize: number;
  contentHash?: string | null;
  captureDate?: Date | null;
  contentType?: string;
  repo?: RepoInfo;
}): Promise<{ stubPath: string; pointer: StubPointer; previewPath: string | null }> {
  const tag = releaseTagForDate(params.captureDate ?? new Date());
  const release = await ensureRelease(tag, params.repo);
  const name = releaseAssetName(params.repoPath, params.contentHash);

  const asset = await uploadReleaseAsset({
    releaseId: release.id,
    name,
    localUri: params.localUri,
    contentType: params.contentType,
    // Verified against the response — a stub must never point at bytes that
    // did not fully arrive.
    expectedSize: params.fileSize,
    repo: params.repo,
  });

  const pointer: StubPointer = {
    tier: 2,
    release: release.tag,
    assetId: asset.assetId,
    name: asset.name,
    size: asset.size || params.fileSize,
    contentHash: params.contentHash ?? null,
  };

  const stubPath = stubPathFor(params.repoPath);

  // Preview first: a stub with no thumbnail renders as a broken image, so the
  // grid is better served by having it available the moment the stub appears.
  const previewBase64 = await buildPreviewBase64(params.localUri, isVideoAsset(params.contentType, params.localUri));
  const previewPath = previewBase64 ? previewPathFor(params.repoPath) : null;
  if (previewBase64 && previewPath) {
    pointer.preview = previewPath;
    await putFile({
      path: previewPath,
      message: `Preview for ${name}`,
      contentBase64: previewBase64,
      repo: params.repo,
    });
  }

  await putFile({
    path: stubPath,
    message: `Upload ${name} (tier 2)`,
    contentBase64: base64FromUtf8(JSON.stringify(pointer, null, 2)),
    repo: params.repo,
  });

  return { stubPath, pointer, previewPath };
}

/** Fetch a tier-2 file's bytes to a local path. Tier 1 is handled by the caller. */
export async function fetchTier2ToFile(pointer: StubPointer, destUri: string, repo?: RepoInfo): Promise<string> {
  return downloadReleaseAsset({ assetId: pointer.assetId, destUri, repo });
}

/** Hermes has no Buffer by default; the `buffer` polyfill is already a dependency. */
function base64FromUtf8(text: string): string {
  const { Buffer } = require('buffer');
  return Buffer.from(text, 'utf8').toString('base64');
}
