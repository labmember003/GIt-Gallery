/**
 * GitHub Releases used as a tier-2 object store.
 *
 * Why releases at all: the git blob API rejects anything past a ~50 MB request
 * body (≈37 MiB raw once base64 adds its 33%) — measured, not documented.
 * Release assets take 2 GiB per file, do not enter git history, and have no
 * stated cap on total size or bandwidth.
 *
 * Uploads stream straight from the file URI via `FileSystem.uploadAsync`.
 * Reading a large video into a JS base64 string would blow memory long before
 * it reached the network.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { getOctokit, getRepoInfo } from './githubClient';
import { RepoInfo } from './types';

/** GitHub allows 1000 assets per release; roll over well before that. */
const MAX_ASSETS_PER_RELEASE = 900;

export type ReleaseAssetRef = {
  releaseTag: string;
  assetId: number;
  name: string;
  size: number;
};

type ReleaseInfo = { id: number; tag: string; assetCount: number };

/** Cache per repo+tag so each upload doesn't re-resolve the release. */
const releaseCache = new Map<string, ReleaseInfo>();

function cacheKey(repo: RepoInfo, tag: string): string {
  return `${repo.owner}/${repo.name}#${tag}`;
}

/** Tier-2 assets are grouped one release per capture year. */
export function releaseTagForDate(date: Date): string {
  return `media-${date.getUTCFullYear()}`;
}

async function fetchRelease(repo: RepoInfo, tag: string): Promise<ReleaseInfo | null> {
  const octokit = getOctokit();
  try {
    const res = await octokit.rest.repos.getReleaseByTag({ owner: repo.owner, repo: repo.name, tag });
    return { id: res.data.id, tag, assetCount: res.data.assets?.length ?? 0 };
  } catch (error: any) {
    if (error?.status === 404) return null;
    throw error;
  }
}

async function createRelease(repo: RepoInfo, tag: string): Promise<ReleaseInfo> {
  const octokit = getOctokit();
  const res = await octokit.rest.repos.createRelease({
    owner: repo.owner,
    repo: repo.name,
    tag_name: tag,
    name: tag,
    body: 'GitGallery media storage. Managed by the app — do not edit by hand.',
    draft: false,
    prerelease: false,
  });
  return { id: res.data.id, tag, assetCount: 0 };
}

/**
 * Resolve (or create) the release for a tag, rolling to `-b`, `-c`, … as each
 * approaches GitHub's 1000-asset ceiling.
 */
export async function ensureRelease(tag: string, repo?: RepoInfo): Promise<ReleaseInfo> {
  const repoInfo = repo ?? getRepoInfo();
  const suffixes = ['', '-b', '-c', '-d', '-e'];

  for (const suffix of suffixes) {
    const candidate = `${tag}${suffix}`;
    const key = cacheKey(repoInfo, candidate);

    const cached = releaseCache.get(key);
    if (cached && cached.assetCount < MAX_ASSETS_PER_RELEASE) return cached;

    const existing = cached ?? (await fetchRelease(repoInfo, candidate));
    if (!existing) {
      const created = await createRelease(repoInfo, candidate);
      releaseCache.set(key, created);
      return created;
    }
    releaseCache.set(key, existing);
    if (existing.assetCount < MAX_ASSETS_PER_RELEASE) return existing;
    // else: full, try the next suffix
  }

  throw new Error(`All release buckets for "${tag}" are full (${suffixes.length} × ${MAX_ASSETS_PER_RELEASE} assets).`);
}

/**
 * Upload a local file as a release asset, streaming from disk.
 *
 * Asset names share a flat namespace per release, so the caller must pass a
 * name that already carries enough entropy to be unique (we use the content
 * hash). A colliding name returns 422 from GitHub.
 */
/**
 * Upload one file as a release asset.
 *
 * A 201 is NOT proof the bytes arrived. GitHub creates the asset record first
 * and reports `state: "starter"` until the body is fully received; if the
 * upload is truncated the record is later garbage-collected. Observed with a
 * 523 MB video: HTTP 201, a plausible `id` and `size` in the body, and the
 * asset simply absent from the release afterwards — so the caller committed a
 * `.ptr` stub pointing at an asset that never existed. The file was gone while
 * the library still listed it, which is the worst possible failure here.
 *
 * So the response is verified before it is trusted: state must be `uploaded`
 * and the size must match the source. A failed upload is cleaned up and raised,
 * which leaves the item un-uploaded and retryable instead of silently lost.
 */
export async function uploadReleaseAsset(params: {
  releaseId: number;
  name: string;
  localUri: string;
  contentType?: string;
  /** Source size in bytes; the upload is rejected unless GitHub echoes it back. */
  expectedSize?: number;
  repo?: RepoInfo;
}): Promise<ReleaseAssetRef> {
  const repoInfo = params.repo ?? getRepoInfo();
  const token = (getOctokit() as any).auth?.token ?? null;
  const authToken = token ?? (await resolveToken());

  const url =
    `https://uploads.github.com/repos/${repoInfo.owner}/${repoInfo.name}` +
    `/releases/${params.releaseId}/assets?name=${encodeURIComponent(params.name)}`;

  const result = await FileSystem.uploadAsync(url, params.localUri, {
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': params.contentType ?? 'application/octet-stream',
      Accept: 'application/vnd.github+json',
    },
  });

  if (result.status !== 201) {
    throw new Error(`Release asset upload failed (HTTP ${result.status}): ${result.body?.slice(0, 200)}`);
  }

  const body = JSON.parse(result.body);

  const state = String(body?.state ?? '');
  const sizeMismatch =
    typeof params.expectedSize === 'number' &&
    params.expectedSize > 0 &&
    body?.size !== params.expectedSize;

  if (state !== 'uploaded' || sizeMismatch) {
    // Don't leave a half-written asset squatting on the name — a retry would
    // then fail with 422 "already_exists" and the item could never upload.
    if (body?.id) await deleteReleaseAsset(body.id, repoInfo).catch(() => {});
    throw new Error(
      `Release asset upload incomplete (state=${state || 'unknown'}, ` +
      `size=${body?.size} expected=${params.expectedSize ?? 'n/a'})`,
    );
  }

  bumpAssetCount(repoInfo, params.releaseId);

  return { releaseTag: '', assetId: body.id, name: body.name, size: body.size };
}

function bumpAssetCount(repo: RepoInfo, releaseId: number): void {
  for (const [key, info] of releaseCache.entries()) {
    if (info.id === releaseId && key.startsWith(`${repo.owner}/${repo.name}#`)) {
      releaseCache.set(key, { ...info, assetCount: info.assetCount + 1 });
      return;
    }
  }
}

/** Octokit hides the token; fall back to the store when it isn't exposed. */
async function resolveToken(): Promise<string> {
  const { useAppStore } = await import('@/store/appState');
  const token = useAppStore.getState().authToken;
  if (!token) throw new Error('Not authenticated with GitHub.');
  return token;
}

/**
 * Download a release asset to a local file.
 *
 * Private-repo assets require the API endpoint with
 * `Accept: application/octet-stream`, which 302s to a signed URL. A plain
 * browser-style URL will not work.
 */
export async function downloadReleaseAsset(params: {
  assetId: number;
  destUri: string;
  repo?: RepoInfo;
}): Promise<string> {
  const repoInfo = params.repo ?? getRepoInfo();
  const authToken = await resolveToken();
  const url = `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.name}/releases/assets/${params.assetId}`;

  const result = await FileSystem.downloadAsync(url, params.destUri, {
    headers: { Authorization: `Bearer ${authToken}`, Accept: 'application/octet-stream' },
  });

  if (result.status !== 200) {
    throw new Error(`Release asset download failed (HTTP ${result.status})`);
  }
  return result.uri;
}

export async function deleteReleaseAsset(assetId: number, repo?: RepoInfo): Promise<void> {
  const repoInfo = repo ?? getRepoInfo();
  const octokit = getOctokit();
  try {
    await octokit.rest.repos.deleteReleaseAsset({ owner: repoInfo.owner, repo: repoInfo.name, asset_id: assetId });
  } catch (error: any) {
    if (error?.status !== 404) throw error;
  }
}

export function invalidateReleaseCache(): void {
  releaseCache.clear();
}
