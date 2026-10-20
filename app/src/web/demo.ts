import data from './demo-data.json';
import type { Library, MediaSource } from './types';

export const demoLibrary: Library = {
  id: 'demo', name: 'Demo library', source: 'demo', repo: null, warnings: [],
  assets: data.map(({ date, favorite, album, duration, ...asset }) => ({
    ...asset, kind: asset.kind as 'photo' | 'video', createdAt: new Date(date).getTime(), duration: duration ?? undefined,
  })).sort((a, b) => b.createdAt - a.createdAt),
  initialCollection: {
    favorites: data.filter((asset) => asset.favorite).map((asset) => asset.id),
    albums: [...new Set(data.map((asset) => asset.album))].map((name, index) => ({
      id: `demo-album-${index}`, name, assetIds: data.filter((asset) => asset.album === name).map((asset) => asset.id),
    })),
  },
};

export const demoSource: MediaSource = {
  async load(asset, preview) {
    const url = preview ? asset.previewUrl : asset.url;
    if (!url) throw new Error('This demo file is unavailable.');
    return url;
  },
  originalLink: () => null,
  dispose: () => {},
};
