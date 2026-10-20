import type { RepoInfo } from '../services/sync/types';

export type WebAsset = {
  id: string;
  repoPath: string;
  filename: string;
  title: string;
  kind: 'photo' | 'video';
  createdAt: number | null;
  width: number | null;
  height: number | null;
  size: number;
  previewPath: string | null;
  url?: string;
  previewUrl?: string;
  duration?: number;
};

export type Album = { id: string; name: string; assetIds: string[] };
export type Collection = { favorites: string[]; albums: Album[] };
export type Library = {
  id: string;
  name: string;
  source: 'demo' | 'github';
  repo: RepoInfo | null;
  assets: WebAsset[];
  warnings: string[];
  initialCollection: Collection;
};

export type TreeEntry = { path: string; type: string; sha: string; size?: number };
export type MediaSource = {
  load(asset: WebAsset, preview: boolean): Promise<string>;
  originalLink(asset: WebAsset): string | null;
  dispose(): void;
};
