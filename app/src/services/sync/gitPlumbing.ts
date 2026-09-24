/**
 * Batched commits via GitHub's Git Data API.
 *
 * The contents API (`createOrUpdateFileContents`) costs one commit **and** ~2
 * requests per file. Measured on device: uploading a single photo produced
 * three commits (image, meta shard, manifest). At 500 photos that is ~1,500
 * commits and ~1,000 requests against a 5,000/hr budget.
 *
 * Git plumbing collapses that:
 *
 *   createBlob × N  →  createTree  →  createCommit  →  updateRef
 *
 * N files become N+3 requests and exactly one commit.
 *
 * Size limit: the blob API rejects anything past a ~50 MB request body
 * (≈37 MiB raw after base64). Oversized files must be routed to tier 2 before
 * they reach this module — see `tiering.ts`.
 */
import { getOctokit, getRepoInfo } from './githubClient';
import { resolveBranch } from './utils';
import { RepoInfo } from './types';

/** One file in a batch. `contentBase64` must already be under the blob ceiling. */
export type BatchEntry = {
  path: string;
  contentBase64: string;
};

export type BatchResult = {
  commitSha: string;
  treeSha: string;
  filesWritten: number;
  requestsUsed: number;
};

/** Git's mode for a normal non-executable file. */
const FILE_MODE = '100644' as const;

/**
 * Blob creation is the only per-file cost, so run a few in parallel — but not
 * too many: each carries a base64 payload, and GitHub applies secondary rate
 * limits to bursts of concurrent writes.
 */
const BLOB_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Write many files in a single commit.
 *
 * The new tree is created with `base_tree` set to the current commit's tree, so
 * only the changed paths need listing — everything else is inherited rather
 * than re-uploaded.
 *
 * `updateRef` is called WITHOUT force: if the branch moved while we were
 * building (another device, a concurrent sync), GitHub rejects with 422 rather
 * than silently discarding those commits. Callers should re-read and retry.
 */
export async function commitBatch(params: {
  entries: BatchEntry[];
  message: string;
  repo?: RepoInfo;
}): Promise<BatchResult | null> {
  const { entries, message } = params;
  if (entries.length === 0) return null;

  const octokit = getOctokit();
  const repo = params.repo ?? getRepoInfo();
  const branch = resolveBranch(repo.branch);
  const owner = repo.owner;
  const repoName = repo.name;

  // 1. Current branch head (and its tree) to build on top of.
  const ref = await octokit.git.getRef({ owner, repo: repoName, ref: `heads/${branch}` });
  const parentSha = ref.data.object.sha;
  const parentCommit = await octokit.git.getCommit({ owner, repo: repoName, commit_sha: parentSha });
  const baseTreeSha = parentCommit.data.tree.sha;

  // 2. One blob per file.
  const blobShas = await mapWithConcurrency(entries, BLOB_CONCURRENCY, async (entry) => {
    const blob = await octokit.git.createBlob({
      owner,
      repo: repoName,
      content: entry.contentBase64,
      encoding: 'base64',
    });
    return blob.data.sha;
  });

  // 3. One tree listing only the changed paths.
  const tree = await octokit.git.createTree({
    owner,
    repo: repoName,
    base_tree: baseTreeSha,
    tree: entries.map((entry, i) => ({
      path: entry.path,
      mode: FILE_MODE,
      type: 'blob' as const,
      sha: blobShas[i],
    })),
  });

  // 4. One commit.
  const commit = await octokit.git.createCommit({
    owner,
    repo: repoName,
    message,
    tree: tree.data.sha,
    parents: [parentSha],
  });

  // 5. Move the branch. No force — a 422 here means someone else moved it.
  await octokit.git.updateRef({
    owner,
    repo: repoName,
    ref: `heads/${branch}`,
    sha: commit.data.sha,
  });

  return {
    commitSha: commit.data.sha,
    treeSha: tree.data.sha,
    filesWritten: entries.length,
    // getRef + getCommit + N blobs + createTree + createCommit + updateRef
    requestsUsed: entries.length + 5,
  };
}

/**
 * `commitBatch` with retry for the concurrent-update case.
 *
 * A 422 from `updateRef` means the branch advanced under us. The blobs we
 * created are still valid (git objects are content-addressed and orphans are
 * harmless), so a retry only has to rebuild the tree on the new head.
 */
export async function commitBatchWithRetry(params: {
  entries: BatchEntry[];
  message: string;
  repo?: RepoInfo;
  maxAttempts?: number;
}): Promise<BatchResult | null> {
  const maxAttempts = params.maxAttempts ?? 3;
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await commitBatch(params);
    } catch (error: any) {
      lastError = error;
      const isRaceCondition = error?.status === 422 || error?.status === 409;
      if (!isRaceCondition || attempt === maxAttempts) throw error;
      // Small backoff so a competing writer can finish.
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw lastError;
}

/** Remaining requests in the current hour, or null if GitHub didn't say. */
export async function getRateLimitRemaining(): Promise<number | null> {
  try {
    const octokit = getOctokit();
    const res = await octokit.rest.rateLimit.get();
    return res.data.rate?.remaining ?? null;
  } catch {
    return null;
  }
}
