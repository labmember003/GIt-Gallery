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
   * Albums from before they were stored in the repo (name -> device asset ids
   * or repo paths). Read once by services/albums, which moves them into
   * `gitgallery/albums.json` and clears this.
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
}));

/**
 * Read one persisted value. Each key fails on its own: a single unreadable or
 * corrupt entry used to reject the whole hydration, which fell back to the
 * defaults and showed a signed-in user the welcome screen.
 */
async function readStored<T>(key: string): Promise<T | null> {
  try {
    const raw = await SecureStore.getItemAsync(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (error: any) {
    console.warn(`[appState] could not read "${key}"`, error?.message ?? error);
    return null;
  }
}

(async () => {
  try {
    const [token0, repo0, autoSync0, autoDelete0, ids0, theme0, albumNames0, selInit0, preset0, fav0, albums0] = await Promise.all([
      readStored<string>('authToken'),
      readStored<CurrentRepo>('currentRepo'),
      readStored<boolean>('autoSync'),
      readStored<boolean>('autoDeleteAfterSync'),
      readStored<string[]>('selectedAlbumIds'),
      readStored<ThemePreference>('theme'),
      readStored<Record<string, string>>('albumNameCache'),
      readStored<boolean>('selectionInitialized'),
      readStored<CompressionPreset>('compressionPreset'),
      readStored<string[]>('favorites'),
      readStored<Record<string, string[]>>('userAlbums'),
    ]);
    let token = token0;
    let repo = repo0;

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
    const autoSync = autoSync0 ?? false;
    const autoDeleteAfterSync = autoDelete0 ?? false;
    const selectedAlbumIds = Array.isArray(ids0) ? ids0 : [];
    const theme = theme0 ?? 'system';
    const gallerySource = 'local';
    const compressionPreset = preset0 ?? DEFAULT_PRESET;
    const favorites = Array.isArray(fav0) ? fav0 : [];
    const userAlbums = albums0 && typeof albums0 === 'object' ? albums0 : {};
    const albumNameCache = albumNames0 && typeof albumNames0 === 'object' ? albumNames0 : {};
    let selectionInitialized = selInit0 ?? false;
    if (!selectionInitialized && Array.isArray(selectedAlbumIds) && selectedAlbumIds.length > 0) {
      selectionInitialized = true;
      try { await SecureStore.setItemAsync('selectionInitialized', JSON.stringify(true)); } catch {}
    }
    useAppStore.setState({ hydrated: true, authToken: token, currentRepo: repo, autoSync, autoDeleteAfterSync, selectedAlbumIds, selectionInitialized, theme, gallerySource, albumNameCache, compressionPreset, favorites, userAlbums });
  } catch (error: any) {
    // A failed read must still unblock the UI, otherwise the splash never ends.
    console.warn('[appState] hydration failed', error?.message ?? error);
    useAppStore.setState({ hydrated: true });
  }
})();


