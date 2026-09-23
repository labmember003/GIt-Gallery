import React, { useCallback, useEffect, useState, useMemo, memo } from 'react';
import { View, Image, FlatList, SectionList, Dimensions, TouchableOpacity, Modal, BackHandler, Platform, TouchableWithoutFeedback, StyleSheet, Animated, Easing, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { buildTimelineSections, groupingKey, formatDuration } from '@/components/timeline/grouping';
import { TimelineSectionHeader } from '@/components/timeline/TimelineSectionHeader';
import { AssetViewer, type ViewerAction } from '@/components/viewer/AssetViewer';
import { thumbHashDataUrl } from '@/services/sync/thumbhash';
import { getMetaEntryFromCache } from '@/services/sync/metaIndex';
import { hasRemoteChanged } from '@/services/sync/index';
import { makeFingerprint } from '@/services/sync/utils';
import { parseCanonicalPath } from '@/services/sync/pathScheme';
import { formatDayLabel, groupingTimestamp } from '@/components/timeline/grouping';
import { Button, Text, FAB, ProgressBar, ActivityIndicator, useTheme, SegmentedButtons, Snackbar, Portal, Dialog, TextInput } from 'react-native-paper';
import * as MediaLibrary from 'expo-media-library';
import * as Haptics from 'expo-haptics';
import { useAppStore } from '@/store/appState';
import { getUploadIndex, subscribeUploadIndex, getSyncStatus, subscribeSyncStatus, isAssetUploadedAsset, hydrateRecentMeta, runSyncOnce, runSyncForAssets, getRepoEntryForAsset, deleteRepoFile, deleteRepoFilesBulk, deleteAssets, getCloudEntriesEnsured, downloadRepoFiles, subscribeCompletion, getLastCompletion, verifyAndCleanUploadIndex, subscribeCacheInvalidated, cancelActiveSync } from '@/services/sync/index';
import type { MetaEntry, RepoInfo } from '@/services/sync/types';
import { ensurePreviewUri, ensureOriginalUri, warmRepoCache } from '@/services/sync/cloudCache';
import { ensureMediaLibraryPermissions, mediaPermissionOptions } from '@/services/mediaPermissions';
import { MaterialCommunityIcons } from '@expo/vector-icons';

const SPACING = 2;

type DialogTone = 'primary' | 'error' | 'neutral';

type MaterialDialogAction = {
  label: string;
  variant?: 'text' | 'outlined' | 'contained';
  tone?: DialogTone;
  dismiss?: boolean;
  onPress?: () => void | Promise<void>;
};

type MaterialDialogState = {
  visible: boolean;
  title: string;
  message?: string;
  tone?: DialogTone;
  icon?: string;
  actions: MaterialDialogAction[];
};

/**
 * Turn a raw sync failure into something a person can act on.
 *
 * `syncStatus.lastError` holds whatever the API layer threw, e.g.
 * `PUT /repos/<owner>/<repo>/contents/... - 409`. In development LogBox
 * happens to show that, which masked the real problem: in a release build the
 * sync just ends and NOTHING is shown. Going offline and tapping upload looked
 * like the button did nothing at all.
 */
function describeSyncError(raw?: string | null): string {
  const text = String(raw ?? '');
  if (/Network request failed|Unable to resolve host|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|getaddrinfo|offline/i.test(text)) {
    return 'no internet connection';
  }
  if (/rate limit/i.test(text)) return 'GitHub rate limit reached, try again shortly';
  if (/Bad credentials|\b401\b|\b403\b/i.test(text)) return 'GitHub rejected the token, check Settings';
  if (/does not match|\b409\b|\b422\b/i.test(text)) return 'the library changed during sync, try again';
  return 'some items could not be uploaded';
}

function normalizeRepoPath(path: string): string {
  let value = path;
  while (true) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch {
      break;
    }
  }
    return value.replace(/\/+/g, '/');
}

export default function GalleryScreen({ route }: any) {
  const theme = useTheme();
  const currentRepo = useAppStore((s) => s.currentRepo);
  const autoSyncEnabled = useAppStore((s) => s.autoSync);
  const selectedAlbumIds = useAppStore((s) => s.selectedAlbumIds);
  const selectionInitialized = useAppStore((s) => s.selectionInitialized ?? false);
  const gallerySource = useAppStore((s) => s.gallerySource);

  const [permission, requestPermission] = MediaLibrary.usePermissions(mediaPermissionOptions as any);
  const [assets, setAssets] = useState<MediaLibrary.Asset[]>([]);








  const [cloudItems, setCloudItems] = useState<MetaEntry[]>([]);
  const [cloudThumbs, setCloudThumbs] = useState<Record<string, string>>({});
  const [endCursor, setEndCursor] = useState<string | null>(null);
  const [hasNext, setHasNext] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingGrid, setLoadingGrid] = useState(false);
  const [selected, setSelected] = useState<MediaLibrary.Asset | null>(null);
  const [selectedCloudUri, setSelectedCloudUri] = useState<string | null>(null);
  const [selectedCloudPath, setSelectedCloudPath] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [indexVersion, setIndexVersion] = useState(0);
  const [syncVersion, setSyncVersion] = useState(0);
  const [selectionMode, setSelectionMode] = useState(false);
  const [toastText, setToastText] = useState<string>('');
  const [toastVisible, setToastVisible] = useState(false);
  const loadingRef = React.useRef(false);
  const [failedThumbKeys, setFailedThumbKeys] = useState<Set<string>>(new Set());
  const reloadingCloudItemsRef = React.useRef(false);
  const failedThumbIdsRef = React.useRef<Set<string>>(new Set());
  const lastVerificationRef = React.useRef(0);
  const loadingMoreRef = React.useRef(false);
  const placeholderAnim = React.useRef(new Animated.Value(0)).current;
  const pendingCloudDeletesRef = React.useRef<Set<string>>(new Set());
  const [dialogState, setDialogState] = useState<MaterialDialogState>({ visible: false, title: '', message: undefined, tone: undefined, icon: undefined, actions: [] });

  // Read the accent straight off the theme in both modes. immichTheme seeds
  // light from #4150AF and dark from #ACCBFA, so the scheme already has the
  // right colors. The fork base pinned these to MD3 baseline purple
  // (#6750A4) whenever theme.dark was set, which discarded the Immich dark
  // scheme and made every dark-mode accent stock Material purple.
  const primaryColor = theme.colors.primary;
  const onPrimaryColor = theme.colors.onPrimary;
  const primaryContainerColor = theme.colors.primaryContainer;
  const onPrimaryContainerColor = theme.colors.onPrimaryContainer;

  const cancelSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectionMode(false);
  }, []);

  useEffect(() => {
    cancelSelection();
    setSelected(null);
    setSelectedCloudUri(null);
    setSelectedCloudPath(null);
  }, [gallerySource, cancelSelection]);
  const repoInfo = useMemo<RepoInfo | null>(() => {
    if (!currentRepo) return null;
    return {
      owner: currentRepo.owner,
      name: currentRepo.name,
      branch: currentRepo.branch || 'main',
    };
  }, [currentRepo]);

  useEffect(() => {
    if (!repoInfo) return;
    warmRepoCache(repoInfo).catch(() => {});
  }, [repoInfo]);

  const initialSyncReposRef = React.useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!autoSyncEnabled || gallerySource !== 'local' || !currentRepo) return;
    const key = `${currentRepo.owner}/${currentRepo.name}/${currentRepo.branch || 'main'}`;
    if (initialSyncReposRef.current.has(key)) return;
    initialSyncReposRef.current.add(key);
    (async () => {
      try {
        await runSyncOnce();
        await hydrateRecentMeta(7, false);
      } catch (error) {
        initialSyncReposRef.current.delete(key);
      }
    })();
  }, [gallerySource, currentRepo, autoSyncEnabled]);

  const removeCloudEntries = useCallback((paths: string[]) => {
    if (!paths || paths.length === 0) return;
    const normalizedRepoPaths = new Set(paths.map((p) => normalizeRepoPath(p)));
    const normalizedTargets = new Set<string>(normalizedRepoPaths);
    const removedFingerprints: string[] = [];
    const previewRemovals: string[] = [];
    setCloudItems((prev) => {
      if (prev.length === 0) return prev;
      let changed = false;
      const next: typeof prev = [];
      for (const item of prev) {
        const normalizedPath = normalizeRepoPath(item.repoPath);
        if (normalizedRepoPaths.has(normalizedPath)) {
          changed = true;
          removedFingerprints.push(item.fingerprint);
          if (item.previewRepoPath) {
            previewRemovals.push(item.previewRepoPath);
          }
          continue;
        }
        next.push(item);
      }
      return changed ? next : prev;
    });

    const pendingDeletes = pendingCloudDeletesRef.current;
    for (const repoPath of normalizedRepoPaths) {
      pendingDeletes.add(repoPath);
    }

    if (previewRemovals.length > 0) {
      for (const preview of previewRemovals) {
        normalizedTargets.add(normalizeRepoPath(preview));
      }
    }

    if (removedFingerprints.length > 0) {
      setCloudThumbs((prev) => {
        if (Object.keys(prev).length === 0) return prev;
        let changed = false;
        const next = { ...prev };
        for (const fingerprint of removedFingerprints) {
          if (fingerprint in next) {
            delete next[fingerprint];
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      setFailedThumbKeys((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        let changed = false;
        for (const fingerprint of removedFingerprints) {
          if (next.delete(fingerprint)) {
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      for (const fingerprint of removedFingerprints) {
        failedThumbIdsRef.current.delete(fingerprint);
      }
    }

    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      let changed = false;
      for (const path of paths) {
        if (next.delete(path)) {
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    setSelectedCloudPath((prev) => {
      if (prev && normalizedTargets.has(normalizeRepoPath(prev))) {
        setSelectedCloudUri(null);
        return null;
      }
      return prev;
    });
  }, [setSelectedCloudUri]);

  const showToast = useCallback((message: string) => {
    setToastText(message);
    setToastVisible(true);
  }, []);

  const closeDialog = useCallback(() => {
    setDialogState((prev) => (prev.visible ? { ...prev, visible: false } : prev));
  }, []);

  const showDialog = useCallback((config: Omit<MaterialDialogState, 'visible'>) => {
    setDialogState({ visible: true, ...config });
  }, []);

  const dialogPalettes = useMemo<Record<DialogTone, { icon: string; container: string; onContainer: string; outline: string }>>(
    () => ({
      primary: {
        icon: primaryColor,
        container: primaryContainerColor,
        onContainer: onPrimaryContainerColor,
        outline: primaryColor,
      },
      error: {
        icon: theme.colors.error,
        container: theme.colors.errorContainer,
        onContainer: theme.colors.onErrorContainer,
        outline: theme.colors.error,
      },
      neutral: {
        icon: theme.colors.secondary,
        container: theme.colors.secondaryContainer,
        onContainer: theme.colors.onSecondaryContainer,
        outline: theme.colors.outlineVariant,
      },
    }),
    [primaryColor, primaryContainerColor, onPrimaryContainerColor, theme.colors.error, theme.colors.errorContainer, theme.colors.onErrorContainer, theme.colors.secondary, theme.colors.secondaryContainer, theme.colors.onSecondaryContainer, theme.colors.outlineVariant],
  );

  const activeDialogPalette = dialogPalettes[dialogState.tone ?? 'primary'];

  /**
   * Wrap an async press handler so a rejection surfaces instead of vanishing.
   *
   * `onPress={async () => …}` discards the returned promise, so any throw
   * becomes an unhandled rejection: no toast, no log, no state change — the
   * control simply looks dead. That is exactly how the upload button appeared
   * broken for three debugging rounds.
   */
  const safeAsync = useCallback(
    (label: string, fn: () => Promise<unknown>) => () => {
      fn().catch((error: any) => {
        console.error(`[${label}] failed`, error);
        showToast(`${label} failed: ${error?.message ?? 'unknown error'}`);
      });
    },
    [],
  );

  const handleDialogAction = useCallback(
    (action: MaterialDialogAction) => {
      if (action.dismiss !== false) {
        closeDialog();
      }
      if (action.onPress) {
        // Failures must be visible. Logging alone means a failed delete looks
        // exactly like a successful one — the dialog closes and nothing happens.
        const report = (error: any) => {
          console.error('Dialog action error', error);
          showToast(`${action.label} failed: ${error?.message ?? 'unknown error'}`);
        };
        try {
          const maybePromise = action.onPress();
          if (maybePromise && typeof (maybePromise as Promise<unknown>).catch === 'function') {
            (maybePromise as Promise<unknown>).catch(report);
          }
        } catch (error) {
          report(error);
        }
      }
    },
    [closeDialog],
  );

  const refreshCloudItems = useCallback(async ({ force = false, showSpinner = true } = {}) => {
    if (reloadingCloudItemsRef.current) return;
    // A forced refresh that finds nothing new still costs a full shard reload.
    // The conditional ref check answers "did anything change?" for free (304),
    // so skip the work when the branch hasn't moved.
    if (force && cloudItems.length > 0 && !(await hasRemoteChanged())) {
      return;
    }
    if (!currentRepo) {
      setCloudItems([]);
      setCloudThumbs({});
      setFailedThumbKeys(new Set());
      failedThumbIdsRef.current.clear();
      setIndexVersion((v) => v + 1);
      return;
    }
    reloadingCloudItemsRef.current = true;
    if (force) {
      setFailedThumbKeys(new Set());
      failedThumbIdsRef.current.clear();
    }
    if (showSpinner) {
      setLoadingGrid(true);
    }
    try {
      await hydrateRecentMeta(30, force);
      const items = await getCloudEntriesEnsured(300);
      let effectiveItems = items;
      const pendingDeletes = pendingCloudDeletesRef.current;
      if (pendingDeletes.size > 0) {
        const seenPaths = new Set<string>();
        for (const item of items) {
          seenPaths.add(normalizeRepoPath(item.repoPath));
        }
        for (const path of Array.from(pendingDeletes)) {
          if (!seenPaths.has(path)) {
            pendingDeletes.delete(path);
          }
        }
        effectiveItems = items.filter((item) => !pendingDeletes.has(normalizeRepoPath(item.repoPath)));
      }
      setCloudItems(effectiveItems);

      const validFingerprints = new Set<string>(effectiveItems.map((item) => item.fingerprint));
      setCloudThumbs((prev) => {
        if (Object.keys(prev).length === 0) return prev;
        const next: Record<string, string> = {};
        let changed = false;
        for (const [key, value] of Object.entries(prev)) {
          if (validFingerprints.has(key)) {
            next[key] = value;
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      setFailedThumbKeys((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set<string>();
        let changed = false;
        for (const key of prev) {
          if (validFingerprints.has(key)) {
            next.add(key);
          } else {
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      const failureRef = failedThumbIdsRef.current;
      for (const key of Array.from(failureRef)) {
        if (!validFingerprints.has(key)) {
          failureRef.delete(key);
        }
      }

      setIndexVersion((v) => v + 1);
    } finally {
      if (showSpinner) {
        setLoadingGrid(false);
      }
      reloadingCloudItemsRef.current = false;
    }
  }, [currentRepo]);

  const numColumns = 3;
  const { width: windowWidth } = useWindowDimensions();
  // Each tile carries `margin: SPACING` on all four sides and the list itself
  // has `padding: SPACING`. Both have to come out of the available width or the
  // last column overflows and gets clipped at the screen edge.
  const size = useMemo(() => {
    const available = windowWidth - SPACING * 2;
    return Math.floor(available / numColumns) - SPACING * 2;
  }, [windowWidth, numColumns]);

  useEffect(() => {
    const animation = Animated.loop(
      Animated.timing(placeholderAnim, {
        toValue: 1,
        duration: 1400,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
      { resetBeforeIteration: true },
    );
    animation.start();
    return () => {
      animation.stop();
    };
  }, [placeholderAnim]);

  const shimmerTranslate = useMemo(
    () => placeholderAnim.interpolate({
      inputRange: [0, 1],
      outputRange: [-size * 1.2, size * 1.2],
    }),
    [placeholderAnim, size],
  );

  const placeholderBaseColor = useMemo(
    () => (theme.dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)'),
    [theme.dark],
  );

  const placeholderContainerStyle = useMemo(
    () => ({
      flex: 1,
      borderRadius: 12,
      overflow: 'hidden' as const,
      backgroundColor: placeholderBaseColor,
    }),
    [placeholderBaseColor],
  );

  const placeholderHighlightColors = useMemo(
    () =>
      theme.dark
        ? ['rgba(255,255,255,0)', 'rgba(255,255,255,0.35)', 'rgba(255,255,255,0)']
        : ['rgba(255,255,255,0)', 'rgba(255,255,255,0.7)', 'rgba(255,255,255,0)'],
    [theme.dark],
  );

  const shimmerAnimatedStyle = useMemo(
    () => [
      StyleSheet.absoluteFillObject,
      {
        justifyContent: 'center' as const,
        opacity: theme.dark ? 0.38 : 0.6,
        transform: [{ translateX: shimmerTranslate }],
      },
    ],
    [shimmerTranslate, theme.dark],
  );

  const shimmerGradientStyle = useMemo(
    () => ({
      width: Math.max(size * 0.9, 160),
      height: size * 1.3,
      alignSelf: 'center' as const,
      borderRadius: Math.max(size * 0.5, 64),
      transform: [{ rotate: '20deg' }],
    }),
    [size],
  );

  const loadPage = useCallback(async (reset = false): Promise<MediaLibrary.Asset[]> => {
    if (gallerySource === 'cloud') {
      await refreshCloudItems({ force: reset, showSpinner: true });
      return [];
    }
    if (!permission?.granted) return [];
    setLoadingGrid(true);
    const currentSelectedIds = useAppStore.getState().selectedAlbumIds;
    const currentSelectionInitialized = useAppStore.getState().selectionInitialized ?? false;
    
    const rememberAlbumName = (useAppStore.getState().rememberAlbumName as ((id: string, name: string) => void) | undefined);
    const albumNameCache = useAppStore.getState().albumNameCache ?? {};

    const allAvailableAlbums = await (MediaLibrary.getAlbumsAsync as any)({ includeSmartAlbums: true }).catch(() => []);
    const albumMap = new Map<string, MediaLibrary.Album>();
    for (const alb of allAvailableAlbums as MediaLibrary.Album[]) {
      albumMap.set(alb.id, alb);
      if (rememberAlbumName) {
        rememberAlbumName(alb.id, alb.title ?? (alb as any).name ?? alb.id);
      }
    }

    if (currentSelectedIds.length > 0) {
      const missingAlbumIds = currentSelectedIds.filter((id) => !albumMap.has(id));
      if (missingAlbumIds.length > 0) {
        const fetchedAlbums = await Promise.all(
          missingAlbumIds.map(async (id) => {
            try {
              return await MediaLibrary.getAlbumAsync(id);
            } catch {
              return null;
            }
          }),
        );
        fetchedAlbums.forEach((album, index) => {
          const albumId = missingAlbumIds[index];
          if (album) {
            albumMap.set(albumId, album);
            if (rememberAlbumName) {
              rememberAlbumName(albumId, album.title ?? (album as any).name ?? albumId);
            }
          } else if (rememberAlbumName) {
            const cachedName = albumNameCache[albumId] ?? albumId;
            rememberAlbumName(albumId, cachedName);
          }
        });
      }
    }

    // iOS "limited" access: the user hand-picks which assets this app may
    // see, and PhotoKit then exposes no album those assets dependably belong
    // to. A previously saved album filter therefore matches nothing, and the
    // early-bail just below emptied the grid even though photos *had* been
    // granted — the user picks 2 photos and the app shows none. Album
    // filtering is meaningless in this mode, so drop it and show everything
    // we are permitted to see.
    const limitedAccess =
      Platform.OS === 'ios' && (permission as any)?.accessPrivileges === 'limited';
    const selectionActive =
      !limitedAccess && (currentSelectionInitialized || currentSelectedIds?.length > 0);
    const workingSelectedIds = selectionActive ? currentSelectedIds.filter((id) => albumMap.has(id)) : [];

    if (selectionActive && workingSelectedIds.length === 0) {
      setEndCursor(null);
      setHasNext(false);
      setAssets([]);
      setLoadingGrid(false);
      if (reset && gallerySource === 'local') {
        useAppStore.getState().bumpAlbumRefreshToken();
      }
      return [];
    }
    
    let newAssets: MediaLibrary.Asset[] = [];
    let resp: { assets: MediaLibrary.Asset[]; endCursor: string | null; hasNextPage: boolean; totalCount?: number } | null = null;
    
    if (workingSelectedIds.length === 0) {
      const options: MediaLibrary.AssetsOptions = {
        mediaType: ['photo', 'video'],
        first: 60,
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
        ...(reset ? {} : { after: endCursor ?? undefined }),
      };
      resp = await MediaLibrary.getAssetsAsync(options);
      newAssets = resp.assets;
      resp = { ...resp, assets: newAssets, hasNextPage: resp.hasNextPage };
    } else if (workingSelectedIds.length === 1) {
      const album = albumMap.get(workingSelectedIds[0]);
      if (album) {
        const options: MediaLibrary.AssetsOptions = {
          mediaType: ['photo', 'video'],
          first: 60,
          sortBy: [[MediaLibrary.SortBy.creationTime, false]],
          album,
          ...(reset ? {} : { after: endCursor ?? undefined }),
        };
        resp = await MediaLibrary.getAssetsAsync(options);
        newAssets = resp.assets;
        resp = { ...resp, assets: newAssets, hasNextPage: resp.hasNextPage };
      } else {
        resp = { assets: [], endCursor: null, hasNextPage: false, totalCount: 0 };
        newAssets = [];
      }
    } else {
      const assetMap = new Map<string, MediaLibrary.Asset>();
      const ids = Array.from(new Set(workingSelectedIds));
      const concurrency = 6;
      let indexPtr = 0;
      async function worker() {
        while (indexPtr < ids.length) {
          const i = indexPtr++;
          const albumId = ids[i];
          try {
            const album = albumMap.get(albumId);
            if (!album) {
              continue;
            }
            const options: MediaLibrary.AssetsOptions = {
              mediaType: ['photo', 'video'],
              first: 60,
              sortBy: [[MediaLibrary.SortBy.creationTime, false]],
              album,
            };
            const r = await MediaLibrary.getAssetsAsync(options);
            for (const asset of r.assets) assetMap.set(asset.id, asset);
          } catch (e) {
            // Ignore failures for missing or inaccessible albums; they remain in selection for visibility.
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));
      newAssets = Array.from(assetMap.values());
      newAssets.sort((a, b) => (b.creationTime ?? 0) - (a.creationTime ?? 0));
      resp = { assets: newAssets, endCursor: null, hasNextPage: false, totalCount: newAssets.length };
    }

    setEndCursor(resp?.endCursor ?? null);
    setHasNext(resp?.hasNextPage ?? false);
    setAssets((prev) => (reset ? newAssets : [...prev, ...newAssets]));
    setLoadingGrid(false);
    if (reset && gallerySource === 'local') {
      useAppStore.getState().bumpAlbumRefreshToken();
    }
    return newAssets;
  }, [permission?.granted, endCursor, gallerySource, refreshCloudItems]);

  const selectedAlbumIdsKey = React.useMemo(() => JSON.stringify([...selectedAlbumIds].sort()), [selectedAlbumIds]);
  const prevKeyRef = React.useRef<string>('');
  const hasLoadedRef = React.useRef(false);
  /**
   * One permission request per mount.
   *
   * This effect depends on `currentRepo` and `selectedAlbumIdsKey`, both of
   * which change as the store hydrates from SecureStore at startup. It is
   * async and had no re-entrancy guard, so while the first system dialog was
   * still awaiting an answer the effect re-ran with `permission` still null
   * and fired another request. Measured on a real S24 via
   * GrantPermissionsViewModel: three dialogs on a first launch.
   */
  const permissionRequestedRef = React.useRef(false);

  useEffect(() => {
    if (gallerySource !== 'local') {
      prevKeyRef.current = '';
      hasLoadedRef.current = false;
      return;
    }
    if (loadingRef.current) return;
    
    (async () => {
      // `null` means the hook has not resolved yet — NOT that permission was
      // denied. Prompting here asked for access on every launch and reload even
      // when all three permissions already read granted=true, because
      // `permission` starts null on every JS load. Wait for it to resolve; the
      // effect re-runs when it does.
      if (!permission) return;

      if (!permission.granted && !permissionRequestedRef.current) {
        permissionRequestedRef.current = true;
        await requestPermission();
        return;
      }

      let ensuredPermission = permission;
      // `accessPrivileges` is iOS-only — it distinguishes full access from
      // "limited". On Android it is undefined, so `!== 'all'` was always true
      // and this branch re-requested permission that had *just* been granted,
      // producing a SECOND system prompt on first launch. Seen on a real S24:
      // grant "Allow all", get asked again immediately.
      const needsFullAccess =
        Platform.OS === 'ios' && ensuredPermission.accessPrivileges !== 'all';
      if (!ensuredPermission.granted || needsFullAccess) {
        ensuredPermission = await ensureMediaLibraryPermissions();
        if (!ensuredPermission.granted) {
          return;
        }
        await requestPermission();
      }
      
      const keyChanged = selectedAlbumIdsKey !== prevKeyRef.current;
      if (!keyChanged && hasLoadedRef.current) return;
      
      prevKeyRef.current = selectedAlbumIdsKey;
      hasLoadedRef.current = true;
      loadingRef.current = true;
      
      try {
        const now = Date.now();
        if (now - lastVerificationRef.current > 5000 && currentRepo) {
          lastVerificationRef.current = now;
          verifyAndCleanUploadIndex().catch(() => {});
        }
        setEndCursor(null);
        setAssets([]);
        setHasNext(true);
        const loadedAssets = await loadPage(true);
        await hydrateRecentMeta(30);
      } finally {
        loadingRef.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission, permission?.granted, selectedAlbumIdsKey, gallerySource, currentRepo]);

  useEffect(() => {
    if (gallerySource !== 'cloud' || !repoInfo) return undefined;
    const toFetch = cloudItems
      .filter((item) => !cloudThumbs[item.fingerprint] && !failedThumbIdsRef.current.has(item.fingerprint))
      .slice(0, 60);
    if (toFetch.length === 0) {
      return undefined;
    }
    let cancelled = false;
    (async () => {
      for (const item of toFetch) {
        if (cancelled) break;
        try {
          const uri = await ensurePreviewUri(item, repoInfo);
          if (cancelled) break;
          setCloudThumbs((prev) => {
            if (prev[item.fingerprint] === uri) return prev;
            return { ...prev, [item.fingerprint]: uri };
          });
          failedThumbIdsRef.current.delete(item.fingerprint);
          setFailedThumbKeys((prev) => {
            if (!prev.has(item.fingerprint)) return prev;
            const next = new Set(prev);
            next.delete(item.fingerprint);
            return next;
          });
        } catch {
          failedThumbIdsRef.current.add(item.fingerprint);
          if (!cancelled) {
            setFailedThumbKeys((prev) => {
              if (prev.has(item.fingerprint)) return prev;
              const next = new Set(prev);
              next.add(item.fingerprint);
              return next;
            });
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gallerySource, cloudItems, repoInfo]);

  // Subscribe to upload index and sync status to force re-render for overlays/progress
  useEffect(() => {
    const unsubIndex = subscribeUploadIndex(() => setIndexVersion((v) => v + 1));
    const unsubStatus = subscribeSyncStatus(() => setSyncVersion((v) => v + 1));
    getUploadIndex().catch(() => {});
    return () => {
      unsubIndex();
      unsubStatus();
    };
  }, []);


  useEffect(() => {
    const unsub = subscribeCompletion(async () => {
      const c = getLastCompletion();
      if (c && c.type === 'upload' && c.total > 0) {
        // A sync that failed used to report "Synced" all the same.
        const failed = c.failed ?? 0;
        if (failed > 0) {
          const reason = describeSyncError(getSyncStatus().lastError);
          setToastText(
            failed >= c.total
              ? `Upload failed — ${reason}`
              : `${c.total - failed} of ${c.total} uploaded — ${reason}`,
          );
        } else {
          setToastText('Synced');
        }
        setToastVisible(true);
        if (gallerySource === 'cloud') {
          await refreshCloudItems({ force: true, showSpinner: false });
        }
        const autoDelete = useAppStore.getState().autoDeleteAfterSync;
        if (autoDelete && gallerySource === 'local') {
          try {
            await loadPage(true);
          } catch (error) {
            console.warn('Failed to refresh local assets after auto delete', error);
          }
        }
      } else if (c && c.type === 'download') {
        setToastText('Download completed');
        setToastVisible(true);
      }
    });
    return () => unsub();
  }, [gallerySource, refreshCloudItems, loadPage]);
  
  useEffect(() => {
    if (gallerySource !== 'cloud') {
      return undefined;
    }

    refreshCloudItems({ force: true, showSpinner: true }).catch(() => {});

    const unsubUpload = subscribeUploadIndex(() => {
      refreshCloudItems({ force: false, showSpinner: false }).catch(() => {});
    });
    const unsubInvalidated = subscribeCacheInvalidated(() => {
      refreshCloudItems({ force: true, showSpinner: false }).catch(() => {});
    });

    return () => {
      unsubUpload();
      unsubInvalidated();
    };
  }, [gallerySource, refreshCloudItems]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      if (gallerySource === 'cloud') {
        await refreshCloudItems({ force: true, showSpinner: false });
      } else {
        if (currentRepo) {
          verifyAndCleanUploadIndex().catch(() => {});
        }
        const shouldSync = useAppStore.getState().autoSync;
        let syncPromise: Promise<void> | null = null;
        if (shouldSync && currentRepo) {
          syncPromise = runSyncOnce().catch((error) => {
            console.warn('Auto-sync refresh run failed', error);
          });
        }
        setEndCursor(null);
        setAssets([]);
        await loadPage(true);
        await hydrateRecentMeta(30, true); // Force meta cache invalidation so cloud badges clear
        if (syncPromise) {
          await syncPromise;
        }
        await hydrateRecentMeta(7, false);
      }
    } finally {
      setRefreshing(false);
    }
  }, [loadPage, gallerySource, currentRepo, refreshCloudItems]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selectionMode || selectedIds.size > 0) {
        cancelSelection();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [selectionMode, selectedIds, cancelSelection]);

  async function manualSync() {
    try {
      await manualSyncInner();
    } catch (error: any) {
      // Passing a bare async fn to onPress swallows throws as unhandled
      // rejections: no toast, no cancelSelection, no log — the button just
      // appears dead. Surface it instead.
      console.error('[manualSync] failed', error?.message ?? error, error?.stack);
      showToast(`Sync failed: ${error?.message ?? 'unknown error'}`);
    }
  }

  async function manualSyncInner() {
    if (assets.length === 0) {
      if (loadingGrid) {
        showToast('Still loading photos. Please wait and try again.');
        return;
      }
      showToast('No photos available to sync right now.');
      return;
    }
    if (selectedIds.size > 0) {
      const subset = assets.filter((asset) => selectedIds.has(asset.id));
      const pending = subset.filter((asset) => !isAssetUploadedAsset(asset));
      if (pending.length === 0) {
        showToast('Everything selected is already synced.');
      } else {
        await runSyncForAssets(pending, { allowBlocked: true, source: 'manual' });
        await hydrateRecentMeta(7, false);
      }
      cancelSelection();
      return;
    }
    showDialog({
      title: 'Sync all photos?',
      message: 'No photos selected. Sync all recent photos from selected albums?',
      tone: 'primary',
      icon: 'cloud-upload',
      actions: [
        { label: 'Cancel', tone: 'neutral' },
        {
          label: 'Sync all',
          tone: 'primary',
          variant: 'contained',
          onPress: async () => {
            await runSyncOnce();
            await hydrateRecentMeta(7, false);
          },
        },
      ],
    });
  }

  async function deleteSelected() {
    if (selectedIds.size === 0) return;
    if (gallerySource === 'cloud') {
      const paths = Array.from(selectedIds);
      showDialog({
        title: `Delete ${paths.length} ${paths.length === 1 ? 'photo' : 'photos'} from cloud?`,
        message: 'This will remove them from your GitHub repo.',
        tone: 'error',
        icon: 'delete-alert',
        actions: [
          { label: 'Cancel', tone: 'neutral' },
          {
            label: 'Delete',
            tone: 'error',
            variant: 'contained',
            onPress: async () => {
              try {
                const { deleted, failed } = await deleteRepoFilesBulk(paths);

                cancelSelection();

                if (deleted.length > 0) {
                  removeCloudEntries(deleted);
                }

                await refreshCloudItems({ force: true, showSpinner: false });

                if (failed.length > 0) {
                  showToast(`${deleted.length} deleted, ${failed.length} failed.`);
                } else if (deleted.length > 0) {
                  const suffix = deleted.length > 1 ? 'photos' : 'photo';
                  showToast(`Deleted ${deleted.length} ${suffix}.`);
                } else {
                  showToast('No photos were deleted.');
                }
              } catch (e: any) {
                console.error('[Delete] Error during deletion:', e);
                showToast(`Failed to delete photos: ${e?.message || 'Unknown error'}`);
              }
            },
          },
        ],
      });
    } else {
      const subset = assets.filter((a) => selectedIds.has(a.id) && isAssetUploadedAsset(a));
      const actions: MaterialDialogAction[] = [
        { label: 'Cancel', tone: 'neutral' },
      ];
      if (subset.length > 0) {
        actions.push({
          label: 'Cloud only',
          tone: 'primary',
          onPress: async () => {
            await deleteAssets(subset);
            cancelSelection();
            await hydrateRecentMeta(7, false);
          },
        });
      }
      actions.push({
        label: 'Local device',
        tone: 'error',
        variant: 'contained',
        onPress: async () => {
          const ids = Array.from(selectedIds);
          try { await MediaLibrary.deleteAssetsAsync(ids as any); } catch {}
          cancelSelection();
          setEndCursor(null);
          setAssets([]);
          await loadPage(true);
        },
      });

      showDialog({
        title: 'Delete from...',
        message: 'Choose where to delete selected photos from.',
        tone: 'error',
        icon: 'trash-can-outline',
        actions,
      });
    }
  }

  const handleCancelSyncPress = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    cancelActiveSync();
  }, [cancelActiveSync]);

  const selectAll = useCallback(() => {
    if (gallerySource === 'cloud') {
      const next = new Set<string>(cloudItems.map((c) => c.repoPath));
      setSelectedIds(next);
      setSelectionMode(next.size > 0);
    } else {
      const next = new Set<string>(assets.map((a) => a.id));
      setSelectedIds(next);
      setSelectionMode(next.size > 0);
    }
  }, [gallerySource, cloudItems, assets]);

  const handleGallerySourceChange = useCallback((value: 'local' | 'cloud') => {
    if (value === gallerySource) return;
    cancelSelection();
    setSelected(null);
    setSelectedCloudUri(null);
    setSelectedCloudPath(null);
    (useAppStore.getState().setGallerySource as any)(value);
  }, [gallerySource, cancelSelection]);

  // Memoized styles
  const itemContainerStyle = useMemo(() => ({ width: size, height: size, margin: SPACING }), [size]);
  const imageStyle = useMemo(() => ({ width: '100%' as any, height: '100%' as any }), []);
  const checkIconStyle = useMemo(() => ({
    position: 'absolute' as const,
    left: 6,
    top: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.9)',
  }), []);
  const cloudIconStyle = useMemo(() => ({
    position: 'absolute' as const,
    right: 4,
    bottom: 4,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 10,
    padding: 2,
  }), []);
  const cloudItemContainerStyle = useMemo(() => ({
    width: size,
    height: size,
    margin: SPACING,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  }), [size]);
  const selectionAccentColor = useMemo(() => primaryContainerColor, [primaryContainerColor]);
  const selectionAccentContentColor = useMemo(() => onPrimaryContainerColor, [onPrimaryContainerColor]);
  const selectionContainerStyle = useMemo(() => ({
    position: 'absolute' as const,
    left: 16,
    bottom: 16,
    alignItems: 'flex-start' as const,
    shadowColor: '#000',
    shadowOpacity: theme.dark ? 0.35 : 0.14,
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 10,
    elevation: 9,
  }), [theme.dark]);
  const selectionCountChipStyle = useMemo(() => ({
    alignSelf: 'flex-start' as const,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    marginBottom: 8,
    backgroundColor: selectionAccentColor,
  }), [selectionAccentColor]);
  const selectionPrimaryStyle = useMemo(() => ({
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: selectionAccentColor,
    borderTopLeftRadius: 999,
    borderBottomLeftRadius: 999,
    borderTopRightRadius: 18,
    borderBottomRightRadius: 18,
    minHeight: 48,
  }), [selectionAccentColor]);
  const selectionSecondaryStyle = useMemo(() => ({
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginLeft: 4,
    backgroundColor: selectionAccentColor,
    borderTopLeftRadius: 18,
    borderBottomLeftRadius: 18,
    borderTopRightRadius: 999,
    borderBottomRightRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 12,
    minHeight: 48,
    minWidth: 56,
  }), [selectionAccentColor]);
  const selectionPrimaryTextStyle = useMemo(() => ({
    color: selectionAccentContentColor,
    fontWeight: '600' as const,
    letterSpacing: 0.2,
    textTransform: 'none' as const,
  }), [selectionAccentContentColor]);
  const selectionPrimaryIconStyle = useMemo(() => ({
    marginRight: 12,
  }), []);

  // Memoized callbacks for item interactions
  const handleItemPress = useCallback((item: MediaLibrary.Asset) => {
    if (selectionMode) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
    } else {
      setSelected(item);
    }
  }, [selectionMode]);

  const handleItemLongPress = useCallback((item: MediaLibrary.Asset) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSelectionMode(true);
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.add(item.id);
      return next;
    });
  }, []);

  const handleCloudItemPress = useCallback(async (item: MetaEntry) => {
    if (selectionMode) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(item.repoPath)) next.delete(item.repoPath);
        else next.add(item.repoPath);
        return next;
      });
    } else {
      const fingerprint = item.fingerprint;
      const cachedPreview = cloudThumbs[fingerprint];
      if (cachedPreview) {
        setSelectedCloudUri(cachedPreview);
      } else {
        setSelectedCloudUri(null);
      }
      setSelectedCloudPath(item.repoPath);
      if (!repoInfo) {
        return;
      }
      try {
        const originalUri = await ensureOriginalUri(item, repoInfo);
        setSelectedCloudUri(originalUri);
        failedThumbIdsRef.current.delete(fingerprint);
        setFailedThumbKeys((prev) => {
          if (!prev.has(fingerprint)) return prev;
          const next = new Set(prev);
          next.delete(fingerprint);
          return next;
        });
      } catch {
        failedThumbIdsRef.current.add(fingerprint);
        setFailedThumbKeys((prev) => {
          if (prev.has(fingerprint)) return prev;
          const next = new Set(prev);
          next.add(fingerprint);
          return next;
        });
        if (!cachedPreview) {
          setSelectedCloudUri(null);
        }
      }
    }
  }, [selectionMode, cloudThumbs, repoInfo]);

  const handleCloudItemLongPress = useCallback((item: MetaEntry) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSelectionMode(true);
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.add(item.repoPath);
      return next;
    });
  }, []);

  // Memoized check icon style with theme color
  const checkIconStyleWithColor = useMemo(() => ({
    ...checkIconStyle,
    backgroundColor: primaryColor,
  }), [checkIconStyle, primaryColor]);

  // Memoized render functions
  const favorites = useAppStore((st) => st.favorites);
  const userAlbums = useAppStore((st) => st.userAlbums);
  const addToAlbum = useAppStore((st) => st.addToAlbum);
  const createAlbum = useAppStore((st) => st.createAlbum);
  const [albumPicker, setAlbumPicker] = useState<{ visible: boolean; keys: string[] }>({ visible: false, keys: [] });
  const [newAlbumName, setNewAlbumName] = useState('');
  /** When set, the timeline shows only this album. */
  const [albumFilter, setAlbumFilter] = useState<string | null>(null);

  // The Albums tab navigates here with a filter; picking the same album twice
  // should re-apply it, so this keys off the param rather than mount.
  const routeAlbumFilter = route?.params?.albumFilter ?? null;
  useEffect(() => {
    if (routeAlbumFilter) setAlbumFilter(routeAlbumFilter);
  }, [routeAlbumFilter]);
  const toggleFavorite = useAppStore((st) => st.toggleFavorite);
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  /** Stable key for favouriting, matching whichever source is active. */
  const favKeyFor = useCallback(
    (entry: any) => (entry?.id ? String(entry.id) : (entry?.repoPath ?? '')),
    [],
  );
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  // Top-RIGHT, not top-left: the selection check also sits at (6,6), so a
  // favourited photo in selection mode stacked the heart under the tick.
  // Bottom-left is the video duration and bottom-right the uploaded cloud,
  // which leaves this the one free corner.
  const favoriteBadgeStyle = useMemo(
    () => ({
      position: 'absolute' as const,
      right: 6,
      top: 6,
      borderRadius: 999,
      padding: 3,
      backgroundColor: 'rgba(0,0,0,0.45)',
    }),
    [],
  );

  const videoBadgeStyle = useMemo(
    () => ({
      position: 'absolute' as const,
      left: 6,
      bottom: 6,
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 10,
      backgroundColor: 'rgba(0,0,0,0.6)',
    }),
    [],
  );

  const renderItem = useCallback(({ item }: { item: MediaLibrary.Asset }) => {
    const uploaded = isAssetUploadedAsset(item);
    const isSelected = selectedIds.has(item.id);
    const isVideo = (item as any)?.mediaType === 'video';

    return (
      <TouchableOpacity
        onPress={() => handleItemPress(item)}
        onLongPress={() => handleItemLongPress(item)}
        delayLongPress={150}
        activeOpacity={0.8}
        style={itemContainerStyle}
      >
        <View style={{ width: '100%', height: '100%', position: 'relative' }} pointerEvents="box-none">
          <Image
            source={{ uri: item.uri }}
            style={imageStyle}
            resizeMode="cover"
          />
          {isSelected && (
            <View style={checkIconStyleWithColor} pointerEvents="none">
              <MaterialCommunityIcons name="check" size={16} color={onPrimaryColor} />
            </View>
          )}
          {uploaded && (
            <View style={cloudIconStyle} pointerEvents="none">
              <MaterialCommunityIcons name="cloud-check" size={16} color="#fff" />
            </View>
          )}
          {favoriteSet.has(String(item.id)) && (
            <View style={favoriteBadgeStyle} pointerEvents="none">
              <MaterialCommunityIcons name="heart" size={14} color="#EF5350" />
            </View>
          )}
          {isVideo && (
            // Without this a video is indistinguishable from a photo in the
            // grid — you only find out after tapping.
            <View style={videoBadgeStyle} pointerEvents="none">
              <MaterialCommunityIcons name="play" size={12} color="#fff" />
              <Text style={{ color: '#fff', fontSize: 11, marginLeft: 3 }}>
                {formatDuration((item as any)?.duration)}
              </Text>
            </View>
          )}
        </View>
      </TouchableOpacity>
    );
  }, [itemContainerStyle, imageStyle, checkIconStyleWithColor, cloudIconStyle, videoBadgeStyle, selectedIds, handleItemPress, handleItemLongPress, indexVersion, favoriteSet, favoriteBadgeStyle]);

  const renderCloudItem = useCallback(({ item }: { item: MetaEntry }) => {
    const thumbKey = item.fingerprint;
    const uri = cloudThumbs[thumbKey];
    const isFailed = failedThumbKeys.has(thumbKey);
    // ~25-byte hash from the index, decoded locally. Lets the tile show a
    // recognisable blur of the real photo before any image is fetched.
    const placeholderUri = thumbHashDataUrl(item.thumbHash);
    const isSelected = selectedIds.has(item.repoPath);

    return (
      <TouchableOpacity
        onPress={() => handleCloudItemPress(item)}
        onLongPress={() => handleCloudItemLongPress(item)}
        delayLongPress={150}
        activeOpacity={0.8}
        style={cloudItemContainerStyle}
      >
        <View style={{ width: '100%', height: '100%', position: 'relative' }} pointerEvents="box-none">
          {placeholderUri ? (
            <Image
              source={{ uri: placeholderUri }}
              style={[imageStyle, { position: 'absolute', top: 0, left: 0 }]}
              resizeMode="cover"
            />
          ) : null}
          {uri ? (
            <View style={{ width: '100%', height: '100%' }} pointerEvents="none">
            <Image
              source={{ uri }}
              style={imageStyle}
              resizeMode="cover"
              onError={() => {
                failedThumbIdsRef.current.add(thumbKey);
                setFailedThumbKeys((prev) => {
                  if (prev.has(thumbKey)) return prev;
                  const next = new Set(prev);
                  next.add(thumbKey);
                  return next;
                });
              }}
            />
            </View>
          ) : isFailed ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.1)' }} pointerEvents="none">
              <MaterialCommunityIcons name="image-off" size={size * 0.4} color="rgba(0,0,0,0.3)" />
            </View>
          ) : placeholderUri ? null : (
            <View pointerEvents="none" style={placeholderContainerStyle}>
              <Animated.View style={shimmerAnimatedStyle}>
                <LinearGradient
                  colors={placeholderHighlightColors}
                  locations={[0, 0.5, 1]}
                  start={{ x: 0, y: 0.5 }}
                  end={{ x: 1, y: 0.5 }}
                  style={shimmerGradientStyle}
                />
              </Animated.View>
            </View>
          )}
          {isSelected && (
            <View style={checkIconStyleWithColor} pointerEvents="none">
              <MaterialCommunityIcons name="check" size={16} color={onPrimaryColor} />
            </View>
          )}
        </View>
      </TouchableOpacity>
    );
  }, [cloudItemContainerStyle, imageStyle, checkIconStyleWithColor, cloudThumbs, failedThumbKeys, selectedIds, handleCloudItemPress, handleCloudItemLongPress, placeholderContainerStyle, shimmerAnimatedStyle, placeholderHighlightColors, shimmerGradientStyle, size]);

  // Memoized FlatList callbacks
  const keyExtractor = useCallback((i: any, index: number) => {
    if (gallerySource === 'cloud') {
      // Use fingerprint for cloud items to ensure uniqueness (fingerprint is unique per file)
      // Fallback to repoPath + index if fingerprint not available
      return i.fingerprint || `${i.repoPath}-${index}`;
    }
    return i.id;
  }, [gallerySource]);
  const handleEndReached = useCallback(() => {
    if (gallerySource !== 'local') return;
    if (loadingMoreRef.current) return;
    if (!hasNext) return;
    if (loadingGrid) return;
    loadingMoreRef.current = true;
    loadPage(false).finally(() => {
      // Small delay to prevent rapid successive calls
      setTimeout(() => {
        loadingMoreRef.current = false;
      }, 100);
    });
  }, [hasNext, loadPage, loadingGrid, gallerySource]);
  const emptyListMessage = useMemo(() => {
    if (gallerySource === 'local') {
      // Under limited access no folder filter is applied, so naming one would
      // send the user to Settings to fix something that is not the cause.
      if (Platform.OS === 'ios' && (permission as any)?.accessPrivileges === 'limited') {
        return 'No photos shared with GitGallery yet. Allow access to more in iOS Settings > Privacy > Photos.';
      }
      return selectedAlbumIds.length > 0 ? 'No Photos in Selected Folder' : 'No Photos Found';
    }
    return 'No Cloud Photos Yet';
  }, [gallerySource, selectedAlbumIds.length, permission]);

  const listEmptyComponent = useMemo(() => (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      {loadingGrid ? null : <Text>{emptyListMessage}</Text>}
    </View>
  ), [loadingGrid, emptyListMessage]);

  // ── Asset viewer wiring ───────────────────────────────────────────────────
  const closeViewer = useCallback(() => {
    setSelected(null);
    setSelectedCloudUri(null);
    setSelectedCloudPath(null);
  }, []);

  const viewerSubtitle = useMemo(() => {
    // Prefer the EXIF-derived capture date recorded at upload. MediaLibrary's
    // creationTime is frequently just the file's mtime, which would caption a
    // 2019 photo with today's date.
    let ts: number | null = null;
    if (selected) {
      const entry = getMetaEntryFromCache(makeFingerprint(selected as any));
      ts = entry?.createdAt ?? groupingTimestamp(selected as any);
    } else if (selectedCloudPath) {
      const entry = getMetaEntryFromCache(selectedCloudPath);
      ts = entry?.createdAt ?? parseCanonicalPath(selectedCloudPath).captureDate?.getTime() ?? null;
    }
    if (!ts) return null;
    const d = new Date(ts);
    return `${formatDayLabel(d)} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }, [selected, selectedCloudPath]);

  const viewerActions = useMemo(() => {
    const actions: ViewerAction[] = [];

    const favTarget = selected ? String(selected.id) : selectedCloudPath ?? null;
    if (favTarget) {
      const isFav = favoriteSet.has(favTarget);
      actions.push({
        key: 'favorite',
        icon: isFav ? 'heart' : 'heart-outline',
        label: isFav ? 'Favourited' : 'Favourite',
        onPress: () => toggleFavorite(favTarget),
      });
    }

    if (favTarget) {
      actions.push({
        key: 'add-to-album',
        icon: 'image-album',
        label: 'Add to album',
        // The viewer is a Modal and Paper's Portal renders behind it, so a
        // dialog opened on top of the viewer is invisible. Close first.
        onPress: () => {
          closeViewer();
          setAlbumPicker({ visible: true, keys: [favTarget] });
        },
      });
    }

    if (selected && gallerySource === 'local') {
      actions.push({
        key: 'delete-local',
        icon: 'trash-can-outline',
        label: 'Delete',
        destructive: true,
        onPress: () =>
          showDialog({
            title: 'Delete from device?',
            message: 'This will remove the photo from your device.',
            tone: 'error',
            icon: 'trash-can-outline',
            actions: [
              { label: 'Cancel', tone: 'neutral' },
              {
                label: 'Delete',
                tone: 'error',
                variant: 'contained',
                onPress: async () => {
                  try {
                    await MediaLibrary.deleteAssetsAsync([selected.id] as any);
                  } catch {}
                  closeViewer();
                  setEndCursor(null);
                  setAssets([]);
                  await loadPage(true);
                },
              },
            ],
          }),
      });
    }

    if (selected && isAssetUploadedAsset(selected)) {
      actions.push({
        key: 'delete-cloud',
        icon: 'cloud-off-outline',
        label: 'Remove from cloud',
        destructive: true,
        onPress: async () => {
          const entry = await getRepoEntryForAsset(selected);
          if (!entry) return;
          showDialog({
            title: 'Delete from cloud?',
            message: 'This will remove the file from your repo.',
            tone: 'error',
            icon: 'cloud-off-outline',
            actions: [
              { label: 'Cancel', tone: 'neutral' },
              {
                label: 'Delete',
                tone: 'error',
                variant: 'contained',
                onPress: async () => {
                  await deleteRepoFile(entry.repoPath);
                  removeCloudEntries([entry.repoPath]);
                  closeViewer();
                  await refreshCloudItems({ force: true, showSpinner: false });
                },
              },
            ],
          });
        },
      });
    }

    if (selectedCloudPath) {
      actions.push({
        key: 'download',
        icon: 'download-outline',
        label: 'Download',
        onPress: async () => {
          try {
            await downloadRepoFiles([selectedCloudPath] as any);
            showToast('Download completed');
          } catch (error: any) {
            showToast(`Download failed: ${error?.message ?? 'unknown error'}`);
          }
        },
      });
      actions.push({
        key: 'delete-cloud-item',
        icon: 'trash-can-outline',
        label: 'Delete',
        destructive: true,
        onPress: () =>
          showDialog({
            title: 'Delete from cloud?',
            message: 'This will remove the file from your repo.',
            tone: 'error',
            icon: 'cloud-off-outline',
            actions: [
              { label: 'Cancel', tone: 'neutral' },
              {
                label: 'Delete',
                tone: 'error',
                variant: 'contained',
                onPress: async () => {
                  await deleteRepoFile(selectedCloudPath);
                  removeCloudEntries([selectedCloudPath]);
                  closeViewer();
                  await refreshCloudItems({ force: true, showSpinner: false });
                },
              },
            ],
          }),
      });
    }

    return actions;
  }, [selected, selectedCloudPath, gallerySource, closeViewer, loadPage, refreshCloudItems, favoriteSet, toggleFavorite]);

  // The upload FAB, and in selection mode the delete FAB and the Select All
  // bar, all float over the list on `position: absolute`. With only the
  // uniform SPACING padding the bottom row sat underneath them: its selection
  // tick was hidden and it could not be tapped at all, because the floating
  // controls swallowed the touch. Reserve enough room to scroll it clear.
  //   one FAB   : bottom 16 + 56 height          -> 72
  //   selection : second FAB at bottom 86 + 56   -> 142, plus the count chip
  const hasSelection = selectedIds.size > 0;
  const contentContainerStyleMemo = useMemo(
    () => ({ padding: SPACING, paddingBottom: SPACING + (hasSelection ? 168 : 88), flexGrow: 1 }),
    [hasSelection],
  );

  // Immich groups the timeline by capture day, with a larger header at each
  // month boundary. SectionList has no numColumns, so grouping.ts pre-chunks
  // each day into rows and a row renders as one item.
  const activeItems = gallerySource === 'cloud' ? (cloudItems as any[]) : (assets as any[]);
  const timelineSections = useMemo(() => {
    const source = activeItems ?? [];
    let filtered = favoritesOnly ? source.filter((e: any) => favoriteSet.has(favKeyFor(e))) : source;
    if (albumFilter) {
      const members = new Set(userAlbums[albumFilter] ?? []);
      filtered = filtered.filter((e: any) => members.has(favKeyFor(e)));
    }
    return buildTimelineSections(filtered, numColumns);
  }, [activeItems, numColumns, favoritesOnly, favoriteSet, favKeyFor, albumFilter, userAlbums]);

  /**
   * Pages for the viewer, in the same order the grid shows them, so swiping
   * follows the timeline rather than some unrelated ordering.
   */
  const viewerItems = useMemo(() => {
    const flat = timelineSections.flatMap((section: any) => section.data.flat());
    return flat.map((entry: any) => {
      const ts = groupingTimestamp(entry);
      const d = ts ? new Date(ts) : null;
      return {
        key: groupingKey(entry, entry?.uri ?? 'item'),
        uri: gallerySource === 'cloud' ? cloudThumbs[entry.fingerprint] ?? '' : entry.uri,
        isVideo: entry?.mediaType === 'video',
        subtitle: d
          ? `${formatDayLabel(d)} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
          : null,
      };
    }).filter((p: any) => !!p.uri);
  }, [timelineSections, gallerySource, cloudThumbs]);

  const viewerIndex = useMemo(() => {
    const target = selected ? groupingKey(selected as any, '') : selectedCloudPath ?? '';
    const i = viewerItems.findIndex((p: any) => p.key === target);
    return i >= 0 ? i : 0;
  }, [viewerItems, selected, selectedCloudPath]);

  const renderSectionHeader = useCallback(
    ({ section }: any) => <TimelineSectionHeader date={section.date} startsMonth={section.startsMonth} />,
    [],
  );

  const renderTimelineRow = useCallback(
    ({ item: row, section }: any) => (
      <View style={{ flexDirection: 'row' }}>
        {row.map((entry: any, columnIndex: number) => {
          const child =
            gallerySource === 'cloud'
              ? (renderCloudItem as any)({ item: entry, index: columnIndex, section })
              : (renderItem as any)({ item: entry, index: columnIndex, section });
          // Children of a .map() need a stable key. Without one, Fabric's
          // reconciler mis-indexes the row and crashes mounting with
          // "addViewAt: failed to insert view / IndexOutOfBoundsException".
          const key = groupingKey(entry, `${section?.key}-${columnIndex}`);
          return (
            <React.Fragment key={key}>
              {child}
            </React.Fragment>
          );
        })}
      </View>
    ),
    [gallerySource, renderCloudItem, renderItem],
  );

  const sectionKeyExtractor = useCallback(
    (row: any[], index: number) => `${groupingKey(row?.[0], 'row')}-${index}`,
    [],
  );
  const getItemLayoutMemo = useCallback((data: any, index: number) => ({
    length: size + SPACING * 2,
    offset: (size + SPACING * 2) * Math.floor(index / numColumns),
    index,
  }), [size, numColumns]);
  const selectionToken = useMemo(() => Array.from(selectedIds).sort().join('|'), [selectedIds]);
  const flatListExtraData = useMemo(() => ({ indexVersion, selectionToken }), [indexVersion, selectionToken]);
  const syncStatus = getSyncStatus();
  const showProgress = syncStatus.lastBatchTotal > 0 && (syncStatus.running || syncStatus.isDeleting);
  const progress = showProgress && syncStatus.lastBatchTotal > 0
    ? Math.min(Math.max(syncStatus.lastBatchUploaded / syncStatus.lastBatchTotal, 0), 1)
    : 0;
  const progressLabel = syncStatus.isDeleting ? 'Deleting' : 'Syncing';
  const isSyncingUpload = syncStatus.running && syncStatus.lastBatchType === 'upload';

  return (
    <View style={{ flex: 1 }}>
      {/* Source selector + favourites filter */}
      <View style={{ paddingHorizontal: 8, paddingTop: 8, paddingBottom: 4, flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
        <SegmentedButtons
          value={gallerySource}
          onValueChange={(v) => handleGallerySourceChange(v as 'local' | 'cloud')}
          buttons={[
            { value: 'local', label: 'Local' },
            { value: 'cloud', label: 'Cloud' },
          ]}
        />
        </View>
        <TouchableOpacity
          onPress={() => setFavoritesOnly((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={favoritesOnly ? 'Show all photos' : 'Show favourites only'}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: 4 }}
        >
          <MaterialCommunityIcons
            name={favoritesOnly ? 'heart' : 'heart-outline'}
            size={24}
            color={favoritesOnly ? '#EF5350' : theme.colors.onSurfaceVariant}
          />
        </TouchableOpacity>
      </View>
      {showProgress ? (
        <View style={{ position: 'absolute', right: 96, bottom: 16, alignItems: 'flex-end', zIndex: 10 }}>
          <View style={{ minWidth: 200, maxWidth: 320, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.75)' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
              <ActivityIndicator animating size={16} color="#fff" />
              <Text style={{ color: '#fff', marginLeft: 8 }}>
                {progressLabel} {syncStatus.lastBatchUploaded}/{syncStatus.lastBatchTotal}
              </Text>
            </View>
            <ProgressBar progress={progress} color={primaryColor} style={{ height: 6, borderRadius: 4 }} />
          </View>
        </View>
      ) : null}
      <SectionList
        // Without an explicit flex the list sizes to its content instead of
        // becoming the scroller, which leaves RefreshControl with no drag to
        // detect — pull-to-refresh silently never fires.
        style={{ flex: 1 }}
        sections={timelineSections as any}
        keyExtractor={sectionKeyExtractor}
        renderItem={renderTimelineRow}
        renderSectionHeader={renderSectionHeader}
        stickySectionHeadersEnabled
        extraData={flatListExtraData}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.3}
        // VirtualizedList builds its own RefreshControl from these props.
        // Passing a `refreshControl` element instead silently fails to fire on
        // the new architecture (newArchEnabled: true) — the list scrolls and
        // reaches offset 0, but the drag never reaches the control.
        refreshing={refreshing}
        onRefresh={onRefresh}
        ListEmptyComponent={listEmptyComponent}
        contentContainerStyle={contentContainerStyleMemo}
        removeClippedSubviews={false}
        maxToRenderPerBatch={8}
        updateCellsBatchingPeriod={50}
        windowSize={10}
        initialNumToRender={8}
      />
      {loadingGrid ? (
        <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size={32} />
        </View>
      ) : null}
      {/* Image detail modal */}
      {albumFilter ? (
        <View
          style={{
            position: 'absolute',
            top: 64,
            left: 12,
            right: 12,
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 999,
            backgroundColor: theme.colors.primaryContainer,
            zIndex: 20,
          }}
        >
          <MaterialCommunityIcons name="image-album" size={16} color={theme.colors.onPrimaryContainer} />
          <Text style={{ flex: 1, marginLeft: 8, color: theme.colors.onPrimaryContainer }} numberOfLines={1}>
            {albumFilter}
          </Text>
          <TouchableOpacity onPress={() => setAlbumFilter(null)} accessibilityLabel="Clear album filter">
            <MaterialCommunityIcons name="close" size={18} color={theme.colors.onPrimaryContainer} />
          </TouchableOpacity>
        </View>
      ) : null}

      <Portal>
        <Dialog
          visible={albumPicker.visible}
          onDismiss={() => setAlbumPicker({ visible: false, keys: [] })}
        >
          <Dialog.Title>Add to album</Dialog.Title>
          <Dialog.Content>
            {Object.keys(userAlbums).length === 0 ? (
              <Text style={{ marginBottom: 12 }}>No albums yet — name one below to create it.</Text>
            ) : (
              Object.keys(userAlbums)
                .sort((a, b) => a.localeCompare(b))
                .map((name) => (
                  <Button
                    key={name}
                    mode="text"
                    contentStyle={{ justifyContent: 'flex-start' }}
                    onPress={() => {
                      addToAlbum(name, albumPicker.keys);
                      setAlbumPicker({ visible: false, keys: [] });
                      showToast(`Added to "${name}"`);
                    }}
                  >
                    {name}
                  </Button>
                ))
            )}
            <TextInput
              mode="outlined"
              label="New album"
              value={newAlbumName}
              onChangeText={setNewAlbumName}
              style={{ marginTop: 8 }}
            />
          </Dialog.Content>
          <Dialog.Actions>
            {[
              <Button key="cancel" onPress={() => setAlbumPicker({ visible: false, keys: [] })}>
                Cancel
              </Button>,
              <Button
                key="create"
                mode="contained"
                disabled={!newAlbumName.trim()}
                onPress={() => {
                  const name = newAlbumName.trim();
                  createAlbum(name);
                  addToAlbum(name, albumPicker.keys);
                  setNewAlbumName('');
                  setAlbumPicker({ visible: false, keys: [] });
                  showToast(`Added to "${name}"`);
                }}
              >
                Create & add
              </Button>,
            ]}
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <AssetViewer
        visible={!!selected || !!selectedCloudUri}
        uri={selected ? selected.uri : selectedCloudUri}
        width={selected?.width ?? null}
        height={selected?.height ?? null}
        items={viewerItems}
        initialIndex={viewerIndex}
        subtitle={viewerSubtitle}
        isVideo={(selected as any)?.mediaType === 'video'}
        actions={viewerActions}
        onClose={closeViewer}
      />
      {(() => {
        const baseFabStyle = { position: 'absolute' as const, right: 16, bottom: 16 };

        if (gallerySource === 'local') {
          if (isSyncingUpload) {
            return (
              <FAB
                icon="close"
                style={[baseFabStyle, { backgroundColor: theme.colors.errorContainer }]}
                color={theme.colors.onErrorContainer}
                onPress={handleCancelSyncPress}
              />
            );
          }
          return (
            <>
              <FAB
                icon="cloud-upload"
                style={[baseFabStyle, { backgroundColor: primaryContainerColor }]}
                color={onPrimaryContainerColor}
                onPress={manualSync}
              />
              {selectedIds.size > 0 ? (
                <FAB
                  icon="delete"
                  style={{ position: 'absolute', right: 16, bottom: 86, backgroundColor: theme.colors.errorContainer }}
                  color={theme.colors.onErrorContainer}
                  onPress={deleteSelected}
                />
              ) : null}
            </>
          );
        }
        
        if (gallerySource === 'cloud' && selectedIds.size > 0 && !isSyncingUpload) {
          return (
            <>
              <FAB
                icon="delete"
                style={{ position: 'absolute', right: 16, bottom: 16, backgroundColor: theme.colors.errorContainer }}
                color={theme.colors.onErrorContainer}
                onPress={deleteSelected}
              />
              <FAB
                icon="download"
                style={{ position: 'absolute', right: 16, bottom: 86, backgroundColor: primaryContainerColor }}
                color={onPrimaryContainerColor}
                onPress={safeAsync('Download', async () => {
                  const paths = Array.from(selectedIds);
                  if (paths.length > 0) await downloadRepoFiles(paths as any);
                })}
              />
            </>
          );
        }
        
        return null;
      })()}
      {selectedIds.size > 0 && !showProgress ? (
        <View style={selectionContainerStyle}>
          {/*
            Stacked above the buttons rather than beside them: the row already
            sits opposite the FABs, and a count like "100 selected" would run
            into them. Without this there was no way at all to tell how many
            items were selected.
          */}
          <View style={selectionCountChipStyle}>
            <Text variant="labelLarge" style={selectionPrimaryTextStyle}>
              {selectedIds.size} selected
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={selectAll}
            style={selectionPrimaryStyle}
            accessibilityRole="button"
            accessibilityLabel="Select all"
            accessibilityHint="Selects all items in the current view"
          >
            <MaterialCommunityIcons
              name="check"
              size={20}
              color={selectionAccentContentColor}
              style={selectionPrimaryIconStyle}
            />
            <Text variant="labelLarge" style={selectionPrimaryTextStyle}>Select All</Text>
          </TouchableOpacity>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={cancelSelection}
            style={selectionSecondaryStyle}
            accessibilityRole="button"
            accessibilityLabel="Cancel selection"
            accessibilityHint="Clears the current selection"
          >
            <MaterialCommunityIcons name="close" size={20} color={selectionAccentContentColor} />
          </TouchableOpacity>
          </View>
        </View>
      ) : null}
      <Portal>
        <Dialog
          visible={dialogState.visible}
          onDismiss={closeDialog}
          style={{ backgroundColor: theme.colors.surface, borderRadius: 28, marginHorizontal: 12 }}
        >
          {dialogState.icon ? <Dialog.Icon icon={dialogState.icon} color={activeDialogPalette.icon} size={28} /> : null}
          <Dialog.Title style={{ color: theme.colors.onSurface }}>{dialogState.title}</Dialog.Title>
          {dialogState.message ? (
            <Dialog.Content>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                {dialogState.message}
              </Text>
            </Dialog.Content>
          ) : null}
          <Dialog.Actions style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
            {dialogState.actions.map((action, index) => {
              const variant = action.variant ?? 'text';
              const actionTone = action.tone ?? 'primary';
              const palette = dialogPalettes[actionTone];
              const isContained = variant === 'contained';
              const isOutlined = variant === 'outlined';
              return (
                <Button
                  key={`${action.label}-${index}`}
                  mode={variant}
                  onPress={() => handleDialogAction(action)}
                  style={[{ marginLeft: index > 0 ? 8 : 0 }, isOutlined ? { borderColor: palette.outline, borderWidth: StyleSheet.hairlineWidth } : null]}
                  buttonColor={isContained ? palette.container : undefined}
                  textColor={isContained ? palette.onContainer : palette.icon}
                  contentStyle={{ paddingHorizontal: 12 }}
                >
                  {action.label}
                </Button>
              );
            })}
          </Dialog.Actions>
        </Dialog>
      </Portal>
      <Snackbar
        visible={toastVisible}
        onDismiss={() => setToastVisible(false)}
        duration={2400}
        style={{
          marginHorizontal: 16,
          marginBottom: 96,
          borderRadius: 16,
          backgroundColor: theme.colors.inverseSurface,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.outlineVariant,
        }}
        action={{ label: 'Dismiss', onPress: () => setToastVisible(false), textColor: theme.colors.inverseOnSurface }}
      >
        <Text variant="bodyMedium" style={{ color: theme.colors.inverseOnSurface }}>
          {toastText}
        </Text>
      </Snackbar>
    </View>
  );
}


