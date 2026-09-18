import { Octokit } from '@octokit/rest';
import { Buffer } from 'buffer';
import { useAppStore } from '@/store/appState';
import { RepoInfo } from './types';
import { resolveBranch } from './utils';

let cachedClient: { token: string | null; client: Octokit | null } = {
  token: null,
  client: null,
};

export function getRepoInfo(): RepoInfo {
  const repo = useAppStore.getState().currentRepo;
  if (!repo) {
    throw new Error('No repository configured. Please select a repo in settings.');
  }
  return {
    owner: repo.owner,
    name: repo.name,
    branch: repo.branch || 'main',
  };
}

export function getOctokit(): Octokit {
  const token = useAppStore.getState().authToken;
  if (!token) {
    throw new Error('Not authenticated with GitHub.');
  }
  if (cachedClient.client && cachedClient.token === token) {
    return cachedClient.client;
  }
  const client = new Octokit({ auth: token });
  cachedClient = { token, client };
  return client;
}

export async function fetchFileSha(path: string, repo?: RepoInfo): Promise<string | undefined> {
  const octokit = getOctokit();
  const repoInfo = repo ?? getRepoInfo();
  const branch = resolveBranch(repoInfo.branch);
  try {
    const response = await octokit.repos.getContent({
      owner: repoInfo.owner,
      repo: repoInfo.name,
      path,
      ref: branch,
    });
    if (Array.isArray(response.data)) return undefined;
    return (response.data as any).sha;
  } catch (error: any) {
    if (error?.status === 404) {
      return undefined;
    }
    throw error;
  }
}

export async function putFile(params: {
  path: string;
  message: string;
  contentBase64: string;
  sha?: string;
  repo?: RepoInfo;
}): Promise<string | undefined> {
  const octokit = getOctokit();
  const repoInfo = params.repo ?? getRepoInfo();
  const branch = resolveBranch(repoInfo.branch);
  const sha = params.sha ?? (await fetchFileSha(params.path, repoInfo));

  const response = await octokit.repos.createOrUpdateFileContents({
    owner: repoInfo.owner,
    repo: repoInfo.name,
    branch,
    path: params.path,
    message: params.message,
    content: params.contentBase64,
    sha,
  });

  return response.data.content?.sha;
}

export async function deleteFile(path: string, message: string, repo?: RepoInfo): Promise<void> {
  const octokit = getOctokit();
  const repoInfo = repo ?? getRepoInfo();
  const branch = resolveBranch(repoInfo.branch);
  const sha = await fetchFileSha(path, repoInfo);
  if (!sha) {
    return;
  }
  await octokit.repos.deleteFile({
    owner: repoInfo.owner,
    repo: repoInfo.name,
    branch,
    path,
    sha,
    message,
  });
}

export async function resetBranchToEmptyCommit(message = 'Reset repository'): Promise<void> {
  const octokit = getOctokit();
  const repo = getRepoInfo();
  const branch = resolveBranch(repo.branch);
  const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const commitResponse = await octokit.git.createCommit({
    owner: repo.owner,
    repo: repo.name,
    message,
    tree: EMPTY_TREE_SHA,
    parents: [],
  });

  try {
    await octokit.git.updateRef({
      owner: repo.owner,
      repo: repo.name,
      ref: `heads/${branch}`,
      sha: commitResponse.data.sha,
      force: true,
    });
  } catch (error: any) {
    if (error?.status !== 422) {
      throw error;
    }
    await octokit.git.createRef({
      owner: repo.owner,
      repo: repo.name,
      ref: `refs/heads/${branch}`,
      sha: commitResponse.data.sha,
    });
  }
}

export async function downloadFile(path: string, repo?: RepoInfo): Promise<{ content: string; encoding: 'base64'; size: number } | null> {
  const octokit = getOctokit();
  const repoInfo = repo ?? getRepoInfo();
  const branch = resolveBranch(repoInfo.branch);
  try {
    const response = await octokit.repos.getContent({
      owner: repoInfo.owner,
      repo: repoInfo.name,
      path,
      ref: branch,
    });
    if (Array.isArray(response.data)) return null;
    const data = response.data as any;
    if (!data.content || data.encoding !== 'base64') {
      if (data.sha) {
        const blob = await octokit.git.getBlob({
          owner: repoInfo.owner,
          repo: repoInfo.name,
          file_sha: data.sha,
        });
        if (!blob?.data?.content || blob.data.encoding !== 'base64') {
          return null;
        }
        return {
          content: blob.data.content,
          encoding: 'base64',
          size: blob.data.size ?? Buffer.from(blob.data.content, 'base64').length,
        };
      }
      return null;
    }
    return {
      content: data.content,
      encoding: 'base64',
      size: data.size ?? Buffer.from(data.content, 'base64').length,
    };
  } catch (error: any) {
    if (error?.status === 404) return null;
    throw error;
  }
}

export function invalidateClient(): void {
  cachedClient = { token: null, client: null };
}
