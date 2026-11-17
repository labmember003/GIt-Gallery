import {
  chunkCount, fromBase64Url, objectId, openBytes, openManifest, partFile, rawUrl, sharePath,
  type ShareItem, type ShareManifest, type ShareRef,
} from '../services/share/format';
import type { MediaSource, WebAsset } from './types';

/**
 * A shared album opened from its link, in the browser. Files come from the
 * owner's public gitgallery-shares repository and are decrypted here with the
 * key from the link's fragment, which never leaves the page.
 */

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', webm: 'video/webm', '3gp': 'video/3gpp',
};

export class ShareGoneError extends Error {}
/** Worth retrying: GitHub was unreachable or answered with an error. */
export class ShareNetworkError extends Error {}

async function fetchBytes(url: string, fetcher: typeof fetch): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetcher(url, { cache: 'no-store' });
  } catch {
    throw new ShareNetworkError('Could not reach GitHub. Check your connection and try again.');
  }
  if (res.status === 404) throw new ShareGoneError('This shared album is no longer available. The owner may have stopped sharing it.');
  if (!res.ok) throw new ShareNetworkError('GitHub is not answering right now. Try again in a minute.');
  return new Uint8Array(await res.arrayBuffer());
}

export async function loadSharedManifest(ref: ShareRef, fetcher: typeof fetch = fetch): Promise<ShareManifest> {
  const bytes = await fetchBytes(`${rawUrl(ref.owner, sharePath(ref.id, 'manifest.bin'))}?t=${Date.now()}`, fetcher);
  try {
    return openManifest(fromBase64Url(ref.key), bytes);
  } catch {
    throw new Error('This link could not be opened. Check that you copied the whole link.');
  }
}

export function sharedAssets(manifest: ShareManifest): WebAsset[] {
  return manifest.items.map((item, index) => ({
    id: item.id,
    repoPath: item.id,
    filename: `${manifest.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'shared'} ${index + 1}.${item.ext}`,
    // The viewer already shows "3 / 6"; numbering the title too read as "Goa 2026 6".
    title: manifest.title,
    kind: item.kind,
    createdAt: item.takenAt,
    width: item.w,
    height: item.h,
    size: item.original.size,
    previewPath: null,
  }));
}

export class SharedSource implements MediaSource {
  private urls = new Map<string, Promise<string>>();
  private byId: Map<string, ShareItem>;
  private key: Uint8Array;
  constructor(private ref: ShareRef, manifest: ShareManifest, private fetcher: typeof fetch = fetch) {
    this.byId = new Map(manifest.items.map((item) => [item.id, item]));
    this.key = fromBase64Url(ref.key);
  }

  load(asset: WebAsset, preview: boolean): Promise<string> {
    const item = this.byId.get(asset.id);
    if (!item) return Promise.reject(new Error('Item not found'));
    const kind = preview ? 'p' : 'o';
    const cacheKey = `${kind}:${item.id}`;
    let job = this.urls.get(cacheKey);
    if (!job) {
      job = this.decrypt(item, kind);
      job.catch(() => this.urls.delete(cacheKey));
      this.urls.set(cacheKey, job);
    }
    return job;
  }

  private async decrypt(item: ShareItem, kind: 'p' | 'o'): Promise<string> {
    const info = kind === 'p' ? item.preview : item.original;
    const parts: Uint8Array[] = [];
    for (let p = 0; p < info.parts; p++) parts.push(await fetchBytes(rawUrl(this.ref.owner, sharePath(this.ref.id, partFile(item.id, kind, p))), this.fetcher));
    if (chunkCount(info.size) === 0) throw new Error('Empty file');
    const plain = openBytes(this.key, objectId(item.id, kind), info.size, parts);
    const type = kind === 'p' ? 'image/jpeg' : MIME[item.ext] ?? 'application/octet-stream';
    return URL.createObjectURL(new Blob([plain as BlobPart], { type }));
  }

  originalLink(): string | null {
    return null;
  }

  dispose(): void {
    for (const job of this.urls.values()) job.then((url) => URL.revokeObjectURL(url)).catch(() => {});
    this.urls.clear();
  }
}
