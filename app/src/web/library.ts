import { parseCanonicalPath } from '../services/sync/pathMetadata';
import type { MetaEntry } from '../services/sync/types';
import type { TreeEntry, WebAsset } from './types';

const MEDIA = /\.(jpe?g|png|webp|gif|avif|heic|heif|mp4|mov|m4v|webm)(\.ptr)?$/i;
const VIDEO = /\.(mp4|mov|m4v|webm)$/i;

export function isLibraryPath(path: string): boolean {
  return (path.startsWith('gitgallery/library/') || path.startsWith('gitgallery/images/'))
    && !path.split('/').some((part) => part === '..' || part === '.')
    && !path.endsWith('.preview.jpg') && MEDIA.test(path);
}

export function assetsFromTree(entries: TreeEntry[], metadata: MetaEntry[] = []): WebAsset[] {
  const paths = new Set(entries.filter((item) => item.type === 'blob').map((item) => item.path));
  const meta = new Map(metadata.map((item) => [item.repoPath.replace(/\.ptr$/, ''), item]));
  const seen = new Set<string>();
  return entries.filter((entry) => entry.type === 'blob' && isLibraryPath(entry.path))
    .filter((entry) => {
      const path = entry.path.replace(/\.ptr$/, '');
      if (seen.has(path)) return false;
      seen.add(path);
      return true;
    }).map((entry) => {
      const path = entry.path.replace(/\.ptr$/, '');
      const parsed = parseCanonicalPath(path);
      const info = meta.get(path);
      const fallbackPreview = `${path}.preview.jpg`;
      const previewPath = info?.previewRepoPath && paths.has(info.previewRepoPath)
        ? info.previewRepoPath : paths.has(fallbackPreview) ? fallbackPreview : null;
      const date = [info?.createdAt, parsed.captureDate?.getTime(), info?.uploadedAt]
        .find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0) ?? null;
      const originalName = (info as (MetaEntry & { originalFilename?: string }) | undefined)?.originalFilename;
      const filename = typeof originalName === 'string' && originalName.length > 0 && originalName.length <= 255
        ? originalName : path.split('/').pop() || 'Untitled';
      return {
        id: path, repoPath: entry.path, filename,
        title: filename.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '),
        kind: VIDEO.test(path) ? 'video' as const : 'photo' as const,
        createdAt: date && Number.isFinite(date) && date > 0 ? date : null,
        width: parsed.width, height: parsed.height,
        size: typeof info?.fileSize === 'number' && Number.isFinite(info.fileSize) && info.fileSize >= 0
          ? info.fileSize : entry.path.endsWith('.ptr') ? 0 : entry.size ?? 0,
        previewPath,
      };
    }).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.repoPath.localeCompare(b.repoPath));
}

export function parseRepository(value: string): { owner: string; name: string } {
  const parts = value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').split('/');
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part))) {
    throw new Error('Enter a repository as owner/name, for example alex/memories.');
  }
  return { owner: parts[0], name: parts[1].replace(/\.git$/, '') };
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}

export function assetMatches(asset: WebAsset, query: string): boolean {
  const date = asset.createdAt ? new Date(asset.createdAt) : null;
  const haystack = [asset.title, asset.filename, asset.repoPath, date?.toLocaleDateString('en-US', {
    month: 'long', year: 'numeric', day: 'numeric',
  }) ?? ''].join(' ').toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).every((word) => haystack.includes(word));
}
