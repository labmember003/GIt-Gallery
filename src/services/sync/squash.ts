/**
 * History compaction.
 *
 * Every upload adds commits, and git keeps every version of every blob
 * forever. Tier-2 moved the big files out of git, so this is now about
 * hundreds of ~400 KB photos rather than multi-GB videos — real, but far less
 * urgent than originally scoped.
 *
 * The operation is a force-push, which is the single most destructive thing
 * this app does. The design is therefore built around one rule:
 *
 *   **The tree must be byte-identical before and after. Only history changes.**
 *
 * We never construct a new tree. We take the *existing* tree SHA and hang a
 * fresh parentless commit off it, so the file content cannot drift — a whole
 * class of "squash dropped my photos" bugs is impossible by construction.
 * Verification then re-reads the ref and compares tree SHA and file count.
 */
import { getOctokit, getRepoInfo } from './githubClient';
import { resolveBranch } from './utils';
import { invalidateRemoteHead } from './index';
import { RepoInfo } from './types';

export type SquashPreview = {
  commitCount: number;
  fileCount: number;
  treeSha: string;
  headSha: string;
  /** True when history is already a single commit — nothing to do. */
  alreadyCompact: boolean;
};

export type SquashResult = {
  before: { commitCount: number; fileCount: number; treeSha: string };
  after: { commitCount: number; fileCount: number; treeSha: string };
  newHead: string;
};

async function countCommits(repo: RepoInfo, branch: string): Promise<number> {
  const octokit = getOctokit();
  // 100 is plenty to decide "is this worth squashing"; exact counts beyond
  // that don't change the decision.
  const res = await octokit.rest.repos.listCommits({
    owner: repo.owner,
    repo: repo.name,
    sha: branch,
    per_page: 100,
  });
  return res.data.length;
}

/**
 * ⚠️ `GET /git/trees/{branch}` returns the **commit** SHA in its `sha` field,
 * not the tree's. Passing that to `createCommit` fails with
 * "Tree SHA is not a tree object" (422) — verified against the live API.
 *
 * The tree SHA has to come from the commit object itself.
 */
async function readTree(repo: RepoInfo, branch: string): Promise<{ treeSha: string; fileCount: number; truncated: boolean }> {
  const octokit = getOctokit();

  const ref = await octokit.rest.git.getRef({ owner: repo.owner, repo: repo.name, ref: `heads/${branch}` });
  const commit = await octokit.rest.git.getCommit({
    owner: repo.owner,
    repo: repo.name,
    commit_sha: ref.data.object.sha,
  });
  const treeSha = commit.data.tree.sha;

  const res = await octokit.rest.git.getTree({
    owner: repo.owner,
    repo: repo.name,
    tree_sha: treeSha,
    recursive: '1',
  });
  return {
    treeSha,
    fileCount: res.data.tree.filter((e) => e.type === 'blob').length,
    truncated: !!res.data.truncated,
  };
}

/** Read-only: what would a squash do? Safe to call from UI. */
export async function previewSquash(repo?: RepoInfo): Promise<SquashPreview> {
  const repoInfo = repo ?? getRepoInfo();
  const branch = resolveBranch(repoInfo.branch);
  const octokit = getOctokit();

  const ref = await octokit.rest.git.getRef({ owner: repoInfo.owner, repo: repoInfo.name, ref: `heads/${branch}` });
  const headSha = ref.data.object.sha;
  const [commitCount, tree] = await Promise.all([countCommits(repoInfo, branch), readTree(repoInfo, branch)]);

  return {
    commitCount,
    fileCount: tree.fileCount,
    treeSha: tree.treeSha,
    headSha,
    alreadyCompact: commitCount <= 1,
  };
}

/**
 * Collapse history into a single commit that points at the *current* tree.
 *
 * Refuses to run when:
 *  - history is already one commit (nothing to gain)
 *  - the repo has no files (a bug elsewhere shouldn't be cemented by a
 *    force-push over good history)
 *  - the tree listing was truncated, so file count can't be trusted
 *  - the branch moved between preview and push (someone else wrote)
 *
 * Throws rather than force-pushing whenever the post-conditions don't hold.
 */
export async function squashHistory(options?: { repo?: RepoInfo; message?: string }): Promise<SquashResult> {
  const repoInfo = options?.repo ?? getRepoInfo();
  const branch = resolveBranch(repoInfo.branch);
  const octokit = getOctokit();

  const before = await previewSquash(repoInfo);
  if (before.alreadyCompact) {
    throw new Error('History is already a single commit — nothing to squash.');
  }

  const beforeTree = await readTree(repoInfo, branch);
  if (beforeTree.truncated) {
    throw new Error('Tree listing was truncated; refusing to squash without a verifiable file count.');
  }
  if (beforeTree.fileCount === 0) {
    throw new Error('Refusing to squash: the repository has no files, which would destroy recoverable history.');
  }

  // Reuse the existing tree verbatim. Nothing is rebuilt, so content cannot
  // change — only the commit graph above it.
  const commit = await octokit.rest.git.createCommit({
    owner: repoInfo.owner,
    repo: repoInfo.name,
    message: options?.message ?? `Compact history (${beforeTree.fileCount} files)`,
    tree: beforeTree.treeSha,
    parents: [],
  });

  // Re-check the head immediately before the destructive step: if it moved,
  // another writer has commits we would silently discard.
  const recheck = await octokit.rest.git.getRef({ owner: repoInfo.owner, repo: repoInfo.name, ref: `heads/${branch}` });
  if (recheck.data.object.sha !== before.headSha) {
    throw new Error('Branch moved while squashing; aborted rather than discarding the other writer\'s commits.');
  }

  await octokit.rest.git.updateRef({
    owner: repoInfo.owner,
    repo: repoInfo.name,
    ref: `heads/${branch}`,
    sha: commit.data.sha,
    force: true,
  });

  // Post-condition: the tree and file count must be untouched.
  //
  // Note we deliberately do NOT re-read the commit count here. GitHub's commit
  // list is briefly stale after a force-push and returned the pre-squash count,
  // which produced a nonsense "6 commits to 6" message. The new commit is
  // parentless by construction, so the resulting history is exactly 1 commit —
  // asserting that against an eventually-consistent read adds no safety.
  const after = await previewSquash(repoInfo);
  if (after.treeSha !== beforeTree.treeSha) {
    throw new Error(`Squash changed the tree (${beforeTree.treeSha} -> ${after.treeSha}). Content may have been altered.`);
  }
  if (after.fileCount !== beforeTree.fileCount) {
    throw new Error(`Squash changed the file count (${beforeTree.fileCount} -> ${after.fileCount}).`);
  }

  invalidateRemoteHead();

  return {
    before: { commitCount: before.commitCount, fileCount: beforeTree.fileCount, treeSha: beforeTree.treeSha },
    // commitCount is 1 by construction (parentless commit), not by re-read.
    after: { commitCount: 1, fileCount: after.fileCount, treeSha: after.treeSha },
    newHead: commit.data.sha,
  };
}
