import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { getDevRepo, getDevToken } from '@/services/config';
import { DEFAULT_PRESET, type CompressionPreset } from '@/services/sync/compression';

export type CurrentRepo = {
  owner: string;
  name: string;
  branch: string;
  lastSyncedSha?: string;
};

export type ThemePreference = 'system' | 'light' | 'dark';
export type GallerySource = 'local' | 'cloud';
export type { CompressionPreset } from '@/services/sync/compression';

type AppState = {
  /**
   * False until persisted state has been read back from SecureStore.
   *
   * Hydration is async, so without this the navigator renders its first frame
   * against the *default* state and shows onboarding to an already-signed-in
   * user for a frame or two before correcting itself.
   */
  hydrated: boolean;
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
  /** Image quality used for uploads. See services/sync/compression.ts. */
  compressionPreset: CompressionPreset;
  /**
   * Favourited asset keys (local asset id, or repo path for cloud items).
   *
   * Deliberately device-local rather than written to the repo: a heart tap
   * should be instant and work offline, and syncing it would mean a git commit
   * per tap. The trade-off is that favourites do not follow you to another
   * device — worth revisiting if multi-device becomes a goal.
   */
  favorites: string[];
  /**
   * User-created albums: name -> asset keys.
   *
   * Distinct from `selectedAlbumIds`, which refers to *device* albums (Camera,
   * Pictures) used to decide what to sync. These are collections the user
   * curates inside the app.
   *
   * Local, like favourites — instant and offline, at the cost of not following
   * you to another device.
   */
  userAlbums: Record<string, string[]>;
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
  setCompressionPreset: (preset: CompressionPreset) => void;
  toggleFavorite: (key: string) => void;
  isFavorite: (key: string) => boolean;
  createAlbum: (name: string) => void;
  deleteAlbum: (name: string) => void;
  addToAlbum: (name: string, keys: string[]) => void;
  removeFromAlbum: (name: string, key: string) => void;
};

export const useAppStore = create<AppState>((set, get) => ({
  hydrated: false,
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
  compressionPreset: DEFAULT_PRESET,
  favorites: [],
  userAlbums: {},
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
  setCompressionPreset: (preset) => {
    SecureStore.setItemAsync('compressionPreset', JSON.stringify(preset)).catch(() => {});
    set({ compressionPreset: preset });
  },
  toggleFavorite: (key) => {
    set((state) => {
      const next = state.favorites.includes(key)
        ? state.favorites.filter((k) => k !== key)
        : [...state.favorites, key];
      SecureStore.setItemAsync('favorites', JSON.stringify(next)).catch(() => {});
      return { favorites: next };
    });
  },
  isFavorite: (key) => get().favorites.includes(key),
  createAlbum: (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set((state) => {
      if (state.userAlbums[trimmed]) return state;
      const next = { ...state.userAlbums, [trimmed]: [] };
      SecureStore.setItemAsync('userAlbums', JSON.stringify(next)).catch(() => {});
      return { userAlbums: next };
    });
  },
  deleteAlbum: (name) => {
    set((state) => {
      if (!(name in state.userAlbums)) return state;
      const next = { ...state.userAlbums };
      delete next[name];
      SecureStore.setItemAsync('userAlbums', JSON.stringify(next)).catch(() => {});
      return { userAlbums: next };
    });
  },
  addToAlbum: (name, keys) => {
    set((state) => {
      const existing = state.userAlbums[name] ?? [];
      // Set-union so adding the same photo twice is a no-op.
      const merged = Array.from(new Set([...existing, ...keys]));
      const next = { ...state.userAlbums, [name]: merged };
      SecureStore.setItemAsync('userAlbums', JSON.stringify(next)).catch(() => {});
      return { userAlbums: next };
    });
  },
  removeFromAlbum: (name, key) => {
    set((state) => {
      const existing = state.userAlbums[name];
      if (!existing) return state;
      const next = { ...state.userAlbums, [name]: existing.filter((k) => k !== key) };
      SecureStore.setItemAsync('userAlbums', JSON.stringify(next)).catch(() => {});
      return { userAlbums: next };
    });
  },
}));

(async () => {
  try {
    const [tRaw, rRaw, aRaw, adRaw, idsRaw, themeRaw, albumNamesRaw, selInitRaw, presetRaw, favRaw, albumsRaw] = await Promise.all([
      SecureStore.getItemAsync('authToken'),
      SecureStore.getItemAsync('currentRepo'),
      SecureStore.getItemAsync('autoSync'),
      SecureStore.getItemAsync('autoDeleteAfterSync'),
      SecureStore.getItemAsync('selectedAlbumIds'),
      SecureStore.getItemAsync('theme'),
      SecureStore.getItemAsync('albumNameCache'),
      SecureStore.getItemAsync('selectionInitialized'),
      SecureStore.getItemAsync('compressionPreset'),
      SecureStore.getItemAsync('favorites'),
      SecureStore.getItemAsync('userAlbums'),
    ]);
    let token = tRaw ? (JSON.parse(tRaw) as string) : null;
    let repo = rRaw ? (JSON.parse(rRaw) as CurrentRepo) : null;

    // Dev-only: fall back to the .env PAT so local builds skip Device Flow.
    // Never overrides a real signed-in token, and compiles out of release
    // builds via the __DEV__ guard inside getDevToken/getDevRepo.
    if (!token) {
      const devToken = getDevToken();
      if (devToken) {
        token = devToken;
        const devRepo = getDevRepo();
        if (!repo && devRepo) {
          repo = { owner: devRepo.owner, name: devRepo.name, branch: 'main' };
        }
      }
    }
    const autoSync = aRaw ? (JSON.parse(aRaw) as boolean) : false;
    const autoDeleteAfterSync = adRaw ? (JSON.parse(adRaw) as boolean) : false;
    const selectedAlbumIds = idsRaw ? (JSON.parse(idsRaw) as string[]) : [];
    const theme = themeRaw ? (JSON.parse(themeRaw) as ThemePreference) : 'system';
    const gallerySource = 'local';
    const compressionPreset = presetRaw ? (JSON.parse(presetRaw) as CompressionPreset) : DEFAULT_PRESET;
    const favorites = favRaw ? (JSON.parse(favRaw) as string[]) : [];
    const userAlbums = albumsRaw ? (JSON.parse(albumsRaw) as Record<string, string[]>) : {};
    const albumNameCache = albumNamesRaw ? (JSON.parse(albumNamesRaw) as Record<string, string>) : {};
    let selectionInitialized = selInitRaw ? (JSON.parse(selInitRaw) as boolean) : false;
    if (!selectionInitialized && Array.isArray(selectedAlbumIds) && selectedAlbumIds.length > 0) {
      selectionInitialized = true;
      try { await SecureStore.setItemAsync('selectionInitialized', JSON.stringify(true)); } catch {}
    }
    useAppStore.setState({ hydrated: true, authToken: token, currentRepo: repo, autoSync, autoDeleteAfterSync, selectedAlbumIds, selectionInitialized, theme, gallerySource, albumNameCache, compressionPreset, favorites, userAlbums });
  } catch {
    // A failed read must still unblock the UI, otherwise the splash never ends.
    useAppStore.setState({ hydrated: true });
  }
})();


