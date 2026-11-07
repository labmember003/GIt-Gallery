import { Octokit } from '@octokit/rest';
import { Buffer } from 'buffer';
import * as FileSystem from 'expo-file-system/legacy';
import { useAppStore } from '@/store/appState';
import { RepoInfo } from './types';
import { resolveBranch } from './utils';
import { clearEtagCache, clearInFlight, coalesce, conditionalRequest } from './requestCache';

let cachedClient: { token: string | null; client: Octokit | null } = {
  token: null,
  client: null,
};

/**
 * Every API call gets a deadline. Without one, a stalled request held a sync at
 * "0/N" indefinitely; on device one blob upload ran 124 s before GitHub
 * answered at all. Requests with a body get extra time in proportion to its
 * size, so a large upload that is still moving is not cut off.
 */
const REQUEST_TIMEOUT_MS = 120_000;
const UPLOAD_BASE_TIMEOUT_MS = 60_000;
const MIN_UPLOAD_BYTES_PER_SEC = 32 * 1024;

export function requestTimeoutMs(body: unknown): number {
  if (typeof body !== 'string' || body.length === 0) return REQUEST_TIMEOUT_MS;
  return UPLOAD_BASE_TIMEOUT_MS + Math.ceil((body.length / MIN_UPLOAD_BYTES_PER_SEC) * 1000);
}

/**
 * `fetch` with a deadline. The error says "timed out" so the sync's retry
 * policy treats it as transient.
 */
export async function fetchWithTimeout(input: any, init: any = {}): Promise<Response> {
  const timeoutMs = requestTimeoutMs(init.body);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const upstream: AbortSignal | undefined = init.signal;
  const forwardAbort = () => controller.abort();
  upstream?.addEventListener?.('abort', forwardAbort);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw error;
  } finally {
    clearTimeout(timer);
    upstream?.removeEventListener?.('abort', forwardAbort);
  }
}

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
  const client = new Octokit({
    auth: token,
    request: { fetch: fetchWithTimeout },
    /**
     * Octokit logs every non-2xx as console.error. A large share of ours are
     * *expected*: 404s from "does this file exist yet?" probes before a create,
     * and 304s from the conditional branch-head check (`hasRemoteChanged`).
     * In dev those pop LogBox over the app — over the viewer's action bar — and
     * bury genuine failures in noise. Drop them and let everything else through.
     */
    log: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => {
        if (/ - (304|404) /.test(message)) return;
        console.warn(message);
      },
      error: (message: string) => {
        if (/ - (304|404) /.test(message)) return;
        console.error(message);
      },
    },
  });
  cachedClient = { token, client };
  return client;
}

export async function fetchFileSha(path: string, repo?: RepoInfo): Promise<string | undefined> {
  const repoInfo = repo ?? getRepoInfo();
  const branch = resolveBranch(repoInfo.branch);
  // Coalesced: concurrent callers asking for the same path share one request.
  return coalesce(`sha:${repoInfo.owner}/${repoInfo.name}@${branch}:${path}`, async () => {
  const octokit = getOctokit();
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
  });
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

/**
 * Stream a repo file straight to disk through the raw media type. Videos must
 * not round-trip through a base64 string in JS: an 11 MB clip is a 15 MB string.
 */
export async function downloadRepoFileToPath(path: string, destUri: string, repo?: RepoInfo): Promise<string> {
  const repoInfo = repo ?? getRepoInfo();
  const token = useAppStore.getState().authToken;
  if (!token) {
    throw new Error('Not authenticated with GitHub.');
  }
  const branch = resolveBranch(repoInfo.branch);
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.name}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
  const result = await FileSystem.downloadAsync(url, destUri, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw' },
  });
  if (result.status !== 200) {
    await FileSystem.deleteAsync(destUri, { idempotent: true }).catch(() => {});
    throw new Error(`Download failed (HTTP ${result.status})`);
  }
  return result.uri;
}

export async function downloadFile(path: string, repo?: RepoInfo): Promise<{ content: string; encoding: 'base64'; size: number } | null> {
  const repoInfo = repo ?? getRepoInfo();
  const branch = resolveBranch(repoInfo.branch);
  // Coalesced: the grid frequently asks for the same blob from several tiles
  // in the same frame.
  return coalesce(`get:${repoInfo.owner}/${repoInfo.name}@${branch}:${path}`, async () => {
  const octokit = getOctokit();
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
  });
}

/**
 * Current branch head SHA using a conditional request.
 *
 * An unchanged branch returns 304, which GitHub does not bill against the
 * rate limit — so background change-detection is effectively free.
 */
export async function getBranchHead(repo?: RepoInfo): Promise<{ sha: string; fromCache: boolean }> {
  const repoInfo = repo ?? getRepoInfo();
  const branch = resolveBranch(repoInfo.branch);
  const key = `ref:${repoInfo.owner}/${repoInfo.name}@${branch}`;

  const result = await conditionalRequest<string>(key, async (etag) => {
    const octokit = getOctokit();
    const res = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
      owner: repoInfo.owner,
      repo: repoInfo.name,
      ref: `heads/${branch}`,
      headers: etag ? { 'if-none-match': etag } : {},
    });
    return { value: (res.data as any).object.sha as string, etag: res.headers?.etag ?? null };
  });

  return { sha: result.value, fromCache: result.fromCache };
}

export function invalidateClient(): void {
  cachedClient = { token: null, client: null };
  // A different token means a different identity; cached etags and in-flight
  // requests from the previous session must not leak across it.
  clearInFlight();
  clearEtagCache();
}
