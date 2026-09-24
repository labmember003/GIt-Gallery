/**
 * Repo size awareness.
 *
 * GitHub's guidance: keep a repository "ideally less than 1 GB, and less than
 * 5 GB is strongly recommended"; beyond that Support may ask you to trim it.
 *
 * That ceiling arrives sooner than people expect. At the default Balanced
 * preset a photo lands around 400 KB, so:
 *
 *   1 GB  ≈ 2,600 photos
 *   5 GB  ≈ 13,000 photos
 *
 * A real camera roll passes the first number easily, so the app has to notice
 * and say something rather than silently sailing past it.
 *
 * Tier-2 assets do **not** count: release assets live outside git.
 */
import { getOctokit, getRepoInfo } from './githubClient';
import { RepoInfo } from './types';

/** GitHub's "ideally under" figure. */
export const SIZE_IDEAL_BYTES = 1024 * 1024 * 1024;
/** GitHub's "strongly recommended under" figure. */
export const SIZE_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;

export type RepoSizeStatus = {
  /** Sum of blob sizes in the current tree. */
  trackedBytes: number;
  fileCount: number;
  /** GitHub's own reported repo size (includes history and packing). */
  reportedBytes: number | null;
  level: 'ok' | 'approaching' | 'over';
  message: string;
};

function formatGB(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export async function getRepoSizeStatus(repo?: RepoInfo): Promise<RepoSizeStatus> {
  const repoInfo = repo ?? getRepoInfo();
  const octokit = getOctokit();
  const branch = repoInfo.branch || 'main';

  const ref = await octokit.rest.git.getRef({ owner: repoInfo.owner, repo: repoInfo.name, ref: `heads/${branch}` });
  const commit = await octokit.rest.git.getCommit({
    owner: repoInfo.owner,
    repo: repoInfo.name,
    commit_sha: ref.data.object.sha,
  });
  const tree = await octokit.rest.git.getTree({
    owner: repoInfo.owner,
    repo: repoInfo.name,
    tree_sha: commit.data.tree.sha,
    recursive: '1',
  });

  const blobs = tree.data.tree.filter((e) => e.type === 'blob');
  const trackedBytes = blobs.reduce((sum, e) => sum + (e.size ?? 0), 0);

  let reportedBytes: number | null = null;
  try {
    const meta = await octokit.rest.repos.get({ owner: repoInfo.owner, repo: repoInfo.name });
    // `size` is in KB.
    reportedBytes = (meta.data.size ?? 0) * 1024;
  } catch {
    // Non-fatal: the tree total is enough to advise on.
  }

  const worst = Math.max(trackedBytes, reportedBytes ?? 0);
  let level: RepoSizeStatus['level'] = 'ok';
  let message = `${formatGB(trackedBytes)} across ${blobs.length} files. Well inside GitHub's limits.`;

  if (worst >= SIZE_LIMIT_BYTES) {
    level = 'over';
    message =
      `${formatGB(worst)} — past GitHub's strongly-recommended 5 GB limit. ` +
      `Start a new repo for recent photos; older ones stay readable where they are.`;
  } else if (worst >= SIZE_IDEAL_BYTES) {
    level = 'approaching';
    message =
      `${formatGB(worst)} — past GitHub's 1 GB "ideal" size (hard limit 5 GB). ` +
      `Consider splitting future uploads into a per-year repo.`;
  }

  return { trackedBytes, fileCount: blobs.length, reportedBytes, level, message };
}

/**
 * Suggested repo name when sharding by capture year.
 *
 * Sharding is per-year because the timeline is already date-ordered, so a
 * year boundary is the one split that never breaks browsing order.
 */
export function suggestedShardName(baseName: string, year: number): string {
  const stripped = baseName.replace(/-\d{4}$/, '');
  return `${stripped}-${year}`;
}
