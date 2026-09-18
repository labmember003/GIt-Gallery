import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';

export type CurrentRepo = {
  owner: string;
  name: string;
  branch: string;
  lastSyncedSha?: string;
};

export type ThemePreference = 'system' | 'light' | 'dark';
export type GallerySource = 'local' | 'cloud';

type AppState = {
  authToken: string | null;
  currentRepo: CurrentRepo | null;
  autoSync: boolean;
  autoDeleteAfterSync: boolean;
  selectedAlbumIds: string[];
  selectionInitialized: boolean;
  albumRefreshToken: number;
  albumNameCache: Record<string, string>;
  theme: ThemePreference;
  gallerySource: GallerySource;
  setAuthToken: (token: string | null) => void;
  setCurrentRepo: (repo: CurrentRepo | null) => void;
  setAutoSync: (enabled: boolean) => void;
  setAutoDeleteAfterSync: (enabled: boolean) => void;
  setSelectedAlbumIds: (ids: string[]) => void;
  setSelectionInitialized: (initialized: boolean) => void;
  bumpAlbumRefreshToken: () => void;
  rememberAlbumName: (id: string, name: string) => void;
  setTheme: (theme: ThemePreference) => void;
  setGallerySource: (src: GallerySource) => void;
};

export const useAppStore = create<AppState>((set) => ({
  authToken: null,
  currentRepo: null,
  autoSync: false,
  autoDeleteAfterSync: false,
  selectedAlbumIds: [],
  selectionInitialized: false,
  albumRefreshToken: 0,
  albumNameCache: {},
  theme: 'system',
  gallerySource: 'local',
  setAuthToken: (token) => {
    if (token == null) SecureStore.deleteItemAsync('authToken').catch(() => {});
    else SecureStore.setItemAsync('authToken', JSON.stringify(token)).catch(() => {});
    set({ authToken: token });
  },
  setCurrentRepo: (repo) => {
    if (repo == null) SecureStore.deleteItemAsync('currentRepo').catch(() => {});
    else SecureStore.setItemAsync('currentRepo', JSON.stringify(repo)).catch(() => {});
    set({ currentRepo: repo });
  },
  setAutoSync: (enabled) => {
    SecureStore.setItemAsync('autoSync', JSON.stringify(enabled)).catch(() => {});
    set({ autoSync: enabled });
  },
  setAutoDeleteAfterSync: (enabled) => {
    SecureStore.setItemAsync('autoDeleteAfterSync', JSON.stringify(enabled)).catch(() => {});
    set({ autoDeleteAfterSync: enabled });
  },
  setSelectedAlbumIds: (ids) => {
    SecureStore.setItemAsync('selectedAlbumIds', JSON.stringify(ids)).catch(() => {});
    SecureStore.setItemAsync('selectionInitialized', JSON.stringify(true)).catch(() => {});
    set({ selectedAlbumIds: ids, selectionInitialized: true });
  },
  setSelectionInitialized: (initialized) => {
    SecureStore.setItemAsync('selectionInitialized', JSON.stringify(initialized)).catch(() => {});
    set({ selectionInitialized: initialized });
  },
  bumpAlbumRefreshToken: () => {
    set((state) => ({ albumRefreshToken: state.albumRefreshToken + 1 }));
  },
  rememberAlbumName: (id, name) => {
    set((state) => {
      if (!name || state.albumNameCache[id] === name) return state;
      const nextCache = { ...state.albumNameCache, [id]: name };
      SecureStore.setItemAsync('albumNameCache', JSON.stringify(nextCache)).catch(() => {});
      return { albumNameCache: nextCache };
    });
  },
  setTheme: (theme) => {
    SecureStore.setItemAsync('theme', JSON.stringify(theme)).catch(() => {});
    set({ theme });
  },
  setGallerySource: (src) => {
    SecureStore.setItemAsync('gallerySource', JSON.stringify(src)).catch(() => {});
    set({ gallerySource: src });
  },
}));

(async () => {
  try {
    const [tRaw, rRaw, aRaw, adRaw, idsRaw, themeRaw, albumNamesRaw, selInitRaw] = await Promise.all([
      SecureStore.getItemAsync('authToken'),
      SecureStore.getItemAsync('currentRepo'),
      SecureStore.getItemAsync('autoSync'),
      SecureStore.getItemAsync('autoDeleteAfterSync'),
      SecureStore.getItemAsync('selectedAlbumIds'),
      SecureStore.getItemAsync('theme'),
      SecureStore.getItemAsync('albumNameCache'),
      SecureStore.getItemAsync('selectionInitialized'),
    ]);
    const token = tRaw ? (JSON.parse(tRaw) as string) : null;
    const repo = rRaw ? (JSON.parse(rRaw) as CurrentRepo) : null;
    const autoSync = aRaw ? (JSON.parse(aRaw) as boolean) : false;
    const autoDeleteAfterSync = adRaw ? (JSON.parse(adRaw) as boolean) : false;
    const selectedAlbumIds = idsRaw ? (JSON.parse(idsRaw) as string[]) : [];
    const theme = themeRaw ? (JSON.parse(themeRaw) as ThemePreference) : 'system';
    const gallerySource = 'local';
    const albumNameCache = albumNamesRaw ? (JSON.parse(albumNamesRaw) as Record<string, string>) : {};
    let selectionInitialized = selInitRaw ? (JSON.parse(selInitRaw) as boolean) : false;
    if (!selectionInitialized && Array.isArray(selectedAlbumIds) && selectedAlbumIds.length > 0) {
      selectionInitialized = true;
      try { await SecureStore.setItemAsync('selectionInitialized', JSON.stringify(true)); } catch {}
    }
    useAppStore.setState({ authToken: token, currentRepo: repo, autoSync, autoDeleteAfterSync, selectedAlbumIds, selectionInitialized, theme, gallerySource, albumNameCache });
  } catch {}
})();


