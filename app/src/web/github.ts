import type { MetaEntry, RepoInfo } from '../services/sync/types';
import { assetsFromTree, parseRepository } from './library';
import type { Library, MediaSource, TreeEntry, WebAsset } from './types';

type Tree = { sha: string; tree: TreeEntry[]; truncated?: boolean };
type Pointer = { tier: 2; assetId: number; size: number; preview?: string };
type CacheEntry = { promise: Promise<string>; url?: string; bytes: number };
const FULL_LIMIT = 80 * 1024 * 1024;
const PREVIEW_LIMIT = 12 * 1024 * 1024;

export class GitHubError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

function mimeType(path: string): string {
  const extension = path.replace(/\.ptr$/, '').split('.').pop()?.toLowerCase();
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  } as Record<string, string>)[extension ?? ''] ?? 'application/octet-stream';
}

async function boundedBlob(response: Response, limit: number): Promise<Blob> {
  const tooLarge = () => new Error('This file is too large for an in-browser preview. Open it on GitHub to download the original.');
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw tooLarge(); }
  if (!response.body) return new Blob();
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw tooLarge(); }
      chunks.push(new Uint8Array(value).buffer);
    }
    return new Blob(chunks, { type: response.headers.get('content-type') ?? '' });
  } finally { reader.releaseLock(); }
}

/** Browser-only, read-only adapter. Tokens never leave api.github.com or enter storage. */
export class GitHubSource implements MediaSource {
  private token: string;
  private controller = new AbortController();
  private entries = new Map<string, TreeEntry>();
  private cache = new Map<string, CacheEntry>();
  private active = 0;
  private waiting: Array<() => void> = [];
  readonly repo: RepoInfo;

  constructor(repository: string, token = '', branch = '', private fetcher: typeof fetch = (...args) => globalThis.fetch(...args), private account = 'public') {
    this.repo = { ...parseRepository(repository), branch: branch.trim() };
    this.token = token.trim();
  }

  private get base(): string {
    return `/repos/${encodeURIComponent(this.repo.owner)}/${encodeURIComponent(this.repo.name)}`;
  }

  private async request(path: string, accept = 'application/vnd.github+json'): Promise<Response> {
    this.controller.signal.throwIfAborted();
    const response = await this.fetcher(`https://api.github.com${path}`, {
      method: 'GET', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      signal: this.controller.signal,
      headers: { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
    });
    if (!response.ok) {
      const rateLimited = response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
      const message = rateLimited ? 'GitHub’s request limit has been reached. Try again later, or connect with a token for a higher limit.'
        : response.status === 401 ? 'GitHub could not verify that token. Check it and try again.'
        : response.status === 404 ? 'Repository, branch, or file not found. For a private repository, give your token access to that repository.'
        : response.status === 403 ? 'GitHub denied access. Check the token’s Contents: read permission and any organization approval.'
        : response.status === 409 ? 'This repository has no commits yet.'
        : `GitHub could not complete the request (${response.status}). Try again.`;
      throw new GitHubError(message, response.status);
    }
    return response;
  }

  private async tree(sha: string, recursive: boolean): Promise<Tree> {
    return (await this.request(`${this.base}/git/trees/${encodeURIComponent(sha)}${recursive ? '?recursive=1' : ''}`)).json();
  }

  private async listTree(): Promise<TreeEntry[]> {
    const first = await this.tree(this.repo.branch, true);
    if (!first.truncated) {
      if (first.tree.length > 50000) throw new Error('This library exceeds the browser preview’s 50,000-file limit. Choose a smaller library repository.');
      return first.tree;
    }
    // A recursive GitHub response may be truncated. Walk the relevant subtree instead.
    const root = await this.tree(first.sha, false);
    if (root.truncated) throw new Error('This repository directory is too large to list completely. Split the library across repositories.');
    const gallery = root.tree.find((entry) => entry.path === 'gitgallery' && entry.type === 'tree');
    if (!gallery) return [];
    const queue = [{ sha: gallery.sha, prefix: 'gitgallery' }];
    const result: TreeEntry[] = [];
    while (queue.length) {
      const batch = queue.splice(0, 4);
      const children = await mapLimit(batch, 4, (item) => this.tree(item.sha, false));
      for (let index = 0; index < batch.length; index++) {
        if (children[index].truncated) throw new Error('This repository directory is too large to list completely. Split the library across repositories.');
        for (const entry of children[index].tree) {
          if (batch[index].prefix === 'gitgallery' && !['library', 'images', 'meta'].includes(entry.path)) continue;
          const path = `${batch[index].prefix}/${entry.path}`;
          if (entry.type === 'tree') queue.push({ sha: entry.sha, prefix: path });
          else result.push({ ...entry, path });
        }
      }
      if (result.length > 50000) throw new Error('This library exceeds the browser preview’s 50,000-file limit. Choose a smaller library repository.');
    }
    return result;
  }

  private async file(path: string, maxBytes: number): Promise<Blob> {
    const entry = this.entries.get(path);
    if (!entry || entry.type !== 'blob') throw new Error('This file is no longer in the repository. Refresh the library.');
    if ((entry.size ?? 0) > maxBytes) throw new Error('This file is too large for an in-browser preview. Open it on GitHub to download the original.');
    const response = await this.request(`${this.base}/git/blobs/${encodeURIComponent(entry.sha)}`, 'application/vnd.github.raw+json');
    const blob = await boundedBlob(response, maxBytes);
    return new Blob([blob], { type: mimeType(path) });
  }

  async connect(): Promise<Library> {
    let account = this.account;
    if (this.token) account = (await (await this.request('/user')).json() as { login: string }).login;
    const repo = await (await this.request(this.base)).json() as { default_branch: string; full_name: string };
    if (!this.repo.branch) this.repo.branch = repo.default_branch;
    let entries: TreeEntry[];
    try { entries = await this.listTree(); }
    catch (error) { if (error instanceof GitHubError && error.status === 409) entries = []; else throw error; }
    this.entries = new Map(entries.map((entry) => [entry.path, entry]));
    const warnings: string[] = [];
    const shards = entries.filter((entry) => entry.type === 'blob' && entry.path.startsWith('gitgallery/meta/')
      && (entry.path.endsWith('/meta_dict.json') || /^gitgallery\/meta\/shards\/[^/]+\.json$/.test(entry.path)));
    let metadataFailed = false;
    const metadata = await mapLimit(shards, 3, async (entry): Promise<MetaEntry[]> => {
      try {
        const json = JSON.parse(await (await this.file(entry.path, 8 * 1024 * 1024)).text()) as { entries?: Record<string, MetaEntry> };
        return Object.values(json.entries ?? {}).filter((item) => item && typeof item.repoPath === 'string');
      } catch (error) {
        if (this.controller.signal.aborted) throw error;
        metadataFailed = true;
        return [];
      }
    });
    if (metadataFailed) warnings.push('Some metadata could not be loaded. Photos are still listed; a few capture dates or previews may be unavailable.');
    const assets = assetsFromTree(entries, metadata.flat());
    for (const entry of this.cache.values()) if (entry.url) URL.revokeObjectURL(entry.url);
    this.cache.clear();
    return { id: `${account}:${this.repo.owner}/${this.repo.name}@${this.repo.branch}`, name: repo.full_name,
      source: 'github', repo: { ...this.repo }, assets, warnings, initialCollection: { favorites: [], albums: [] } };
  }

  private async acquire(): Promise<void> {
    if (this.active < 4) { this.active++; return; }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void { const next = this.waiting.shift(); if (next) next(); else this.active--; }

  private async bytes(asset: WebAsset, preview: boolean): Promise<Blob> {
    if (preview && asset.previewPath) return this.file(asset.previewPath, PREVIEW_LIMIT);
    if (asset.repoPath.endsWith('.ptr')) {
      const pointer = JSON.parse(await (await this.file(asset.repoPath, 64 * 1024)).text()) as Pointer;
      if (pointer.tier !== 2 || !Number.isSafeInteger(pointer.assetId) || pointer.assetId <= 0 || !Number.isFinite(pointer.size) || pointer.size < 0) {
        throw new Error('This file has an invalid release pointer.');
      }
      if (preview) {
        if (pointer.preview && this.entries.has(pointer.preview)) return this.file(pointer.preview, PREVIEW_LIMIT);
        throw new Error('No thumbnail is available. Open the file to view it.');
      }
      if (pointer.size > FULL_LIMIT) throw new Error('This original exceeds the 80 MB browser preview limit. Open it on GitHub to download it.');
      try {
        const response = await this.request(`${this.base}/releases/assets/${pointer.assetId}`, 'application/octet-stream');
        const blob = await boundedBlob(response, FULL_LIMIT);
        if (blob.type.includes('json')) throw new Error('Release media unavailable');
        return new Blob([blob], { type: mimeType(asset.filename) });
      } catch (error) {
        if (this.controller.signal.aborted) throw error;
        throw new Error('This release asset could not be opened in the browser. Open it on GitHub to download it.');
      }
    }
    if (preview && asset.kind === 'video') throw new Error('No video thumbnail is available.');
    return this.file(asset.repoPath, preview ? PREVIEW_LIMIT : FULL_LIMIT);
  }

  load(asset: WebAsset, preview: boolean): Promise<string> {
    const key = `${asset.id}:${preview ? 'preview' : 'original'}`;
    const cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached.promise; }
    const entry: CacheEntry = { bytes: 0, promise: Promise.resolve('') };
    entry.promise = (async () => {
      await this.acquire();
      try {
        const blob = await this.bytes(asset, preview);
        this.controller.signal.throwIfAborted();
        entry.bytes = blob.size;
        entry.url = URL.createObjectURL(blob);
        let bytes = [...this.cache.values()].reduce((sum, item) => sum + item.bytes, 0);
        for (const [oldKey, old] of this.cache) {
          if (bytes <= 96 * 1024 * 1024) break;
          if (oldKey !== key && old.url) { URL.revokeObjectURL(old.url); this.cache.delete(oldKey); bytes -= old.bytes; }
        }
        return entry.url;
      } catch (error) { this.cache.delete(key); throw error; }
      finally { this.release(); }
    })();
    this.cache.set(key, entry);
    return entry.promise;
  }

  originalLink(asset: WebAsset): string {
    const root = `https://github.com/${encodeURIComponent(this.repo.owner)}/${encodeURIComponent(this.repo.name)}`;
    return asset.repoPath.endsWith('.ptr') ? `${root}/releases`
      : `${root}/blob/${encodeURIComponent(this.repo.branch)}/${asset.repoPath.split('/').map(encodeURIComponent).join('/')}`;
  }

  dispose(): void {
    this.controller.abort();
    this.token = '';
    for (const entry of this.cache.values()) if (entry.url) URL.revokeObjectURL(entry.url);
    this.cache.clear();
    this.entries.clear();
  }
}
