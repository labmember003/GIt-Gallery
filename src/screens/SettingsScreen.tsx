import React, { useEffect, useState } from 'react';
import { View, ScrollView, Platform } from 'react-native';
import { Button, List, Switch, Divider, ActivityIndicator, Checkbox, RadioButton, Portal, Dialog, Text, useTheme } from 'react-native-paper';
import { useAppStore } from '@/store/appState';
import * as MediaLibrary from 'expo-media-library';
import * as SecureStore from 'expo-secure-store';
import { resetRepoAndCaches } from '@/services/sync/index';
import { ensureMediaLibraryPermissions } from '@/services/mediaPermissions';
import { getPersistedAndroidDownloadsDirectory, chooseAndroidDownloadsDirectory, clearAndroidDownloadsDirectory, describeAndroidDownloadsDirectory } from '@/services/sync/androidDownloads';

const sortIds = (ids: string[]) => [...ids].sort();

const areIdSetsEqual = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false;
  const sortedA = sortIds(a);
  const sortedB = sortIds(b);
  for (let i = 0; i < sortedA.length; i += 1) {
    if (sortedA[i] !== sortedB[i]) return false;
  }
  return true;
};

const isLikelyInternalId = (value: string | null | undefined, albumId: string) => {
  if (!value) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed === albumId) return true;
  if (/^\d{6,}$/.test(trimmed)) return true;
  return false;
};

const deriveNameFromUri = (uri: string | undefined | null) => {
  if (!uri) return null;
  try {
    const decoded = decodeURI(uri.replace(/^file:\/\//, ''));
    if (decoded.startsWith('content://')) return null;
    const parts = decoded.split(/[\\/]/).filter(Boolean);
    if (parts.length >= 2) {
      const parentSegments = parts.slice(0, -1);
      const genericNames = new Set([
        'storage',
        'emulated',
        'primary',
        '0',
        'android',
        'data',
        'obb',
        'files',
        'file',
        'media',
        'external',
        'images',
        'videos',
        'pictures',
        'photo',
        'photos',
      ]);
      for (let i = parentSegments.length - 1; i >= 0; i -= 1) {
        const candidate = parentSegments[i];
        if (!candidate) continue;
        const trimmed = candidate.trim();
        if (!trimmed) continue;
        const lowered = trimmed.toLowerCase();
        if (genericNames.has(lowered)) continue;
        if (/^\d{6,}$/.test(trimmed)) continue;
        return trimmed;
      }
      for (let i = parentSegments.length - 1; i >= 0; i -= 1) {
        const candidate = parentSegments[i];
        if (!candidate) continue;
        const trimmed = candidate.trim();
        if (trimmed) return trimmed;
      }
    }
  } catch {}
  return null;
};

const selectPreferredAlbumTitle = (
  albumId: string,
  candidates: Array<string | undefined | null>,
): string => {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (isLikelyInternalId(trimmed, albumId)) continue;
    return trimmed;
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return albumId;
};

export default function SettingsScreen({ navigation }: any) {
  const { currentRepo, setCurrentRepo, setAuthToken } = useAppStore();
  const autoSync = useAppStore((s) => s.autoSync);
  const setAutoSync = useAppStore((s) => s.setAutoSync);
  const autoDeleteAfterSync = useAppStore((s) => s.autoDeleteAfterSync);
  const setAutoDeleteAfterSync = useAppStore((s) => s.setAutoDeleteAfterSync);
  const selectedAlbumIds = useAppStore((s) => s.selectedAlbumIds);
  const setSelectedAlbumIds = useAppStore((s) => s.setSelectedAlbumIds);
  const albumRefreshToken = useAppStore((s) => s.albumRefreshToken);
  const themeMode = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const setGallerySource = useAppStore((s) => s.setGallerySource);
  const savedSelectionCacheRef = React.useRef<string[] | null>(null);

  const [permission, requestPermission] = MediaLibrary.usePermissions();
  const requestPermissionRef = React.useRef(requestPermission);
  useEffect(() => {
    requestPermissionRef.current = requestPermission;
  }, [requestPermission]);
  const [albums, setAlbums] = useState<MediaLibrary.Album[]>([]);
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [downloadDirectoryUri, setDownloadDirectoryUri] = useState<string | null>(null);
  const hasAutoSelectedRef = React.useRef(false);
  const [resetDialogVisible, setResetDialogVisible] = useState(false);
  const [resetDialogStage, setResetDialogStage] = useState<'warning' | 'confirm'>('warning');
  const paperTheme = useTheme();
  const darkPrimaryContainerHex = '#6750A4';
  const darkOnPrimaryContainerHex = '#FFFFFF';
  const primaryContainerColor = paperTheme.dark ? darkPrimaryContainerHex : paperTheme.colors.primaryContainer;
  const onPrimaryContainerColor = paperTheme.dark ? darkOnPrimaryContainerHex : paperTheme.colors.onPrimaryContainer;

  function changeRepo() {
    const parent = navigation.getParent?.();
    if (parent?.navigate) parent.navigate('RepoSetup');
    else navigation.navigate('RepoSetup');
  }

  function logout() {
    setAuthToken(null);
    setCurrentRepo(null);
    navigation.reset({ index: 0, routes: [{ name: 'Welcome' }] });
  }

  function confirmAndResetAll() {
    setResetDialogStage('warning');
    setResetDialogVisible(true);
  }

  const repoLabel = currentRepo ? `${currentRepo.owner}/${currentRepo.name}` : 'this repository';
  const isResetConfirmStage = resetDialogStage === 'confirm';

  const dismissResetDialog = () => {
    if (resetting) return;
    setResetDialogVisible(false);
    setResetDialogStage('warning');
  };

  const handleResetPrimaryAction = async () => {
    if (resetDialogStage === 'warning') {
      setResetDialogStage('confirm');
      return;
    }
    setResetting(true);
    try {
      await resetRepoAndCaches();
      const repo = useAppStore.getState().currentRepo;
      if (repo) setCurrentRepo({ ...repo, branch: 'main' });
      setGallerySource('local');
      setResetDialogVisible(false);
      setResetDialogStage('warning');
    } catch (error) {
      console.warn('Failed to reset repository', error);
    } finally {
      setResetting(false);
    }
  };

  const handleResetSecondaryAction = () => {
    if (resetting) return;
    if (resetDialogStage === 'confirm') {
      setResetDialogStage('warning');
      return;
    }
    dismissResetDialog();
  };

  useEffect(() => {
    savedSelectionCacheRef.current = selectedAlbumIds;
  }, [selectedAlbumIds]);

  useEffect(() => {
    if (Platform.OS === 'android') {
      (async () => {
        const uri = await getPersistedAndroidDownloadsDirectory();
        setDownloadDirectoryUri(uri);
      })();
    }
  }, []);

  const permissionSignature = `${permission?.granted ? '1' : '0'}:${permission?.accessPrivileges ?? 'none'}`;

  useEffect(() => {
    let cancelled = false;

    const refreshAlbums = async () => {
      if (!permission) return;

      let currentPermission = permission;
      if (!currentPermission.granted || currentPermission.accessPrivileges !== 'all') {
        currentPermission = await ensureMediaLibraryPermissions();
        if (!currentPermission.granted) {
          return;
        }
        await requestPermissionRef.current?.();
      }

      if (useAppStore.getState().autoDeleteAfterSync) {
        try {
          await MediaLibrary.requestPermissionsAsync();
        } catch {}
      }

      if (!currentPermission.granted) return;

      if (cancelled) return;
      setLoading(true);

      try {
        const { rememberAlbumName, albumNameCache } = useAppStore.getState();
        const trackAlbumName = rememberAlbumName ?? (() => {});
        const metadataById = new Map<string, { hasPhotos: boolean; derivedName: string | null }>();
        const resolveAlbumTitle = (
          album: MediaLibrary.Album,
          fallback?: string,
        ) => {
          const metadata = metadataById.get(album.id);
          const derivedName = metadata?.derivedName;
          const rawName = album.title ?? (album as any).name ?? null;
          return selectPreferredAlbumTitle(album.id, [derivedName, rawName, fallback, album.id]);
        };

        const applySelection = (ids: string[]) => {
          if (ids.length === 0) return false;
          const currentSelected = useAppStore.getState().selectedAlbumIds;
          if (!areIdSetsEqual(ids, currentSelected)) {
            setSelectedAlbumIds(ids);
          }
          savedSelectionCacheRef.current = ids;
          hasAutoSelectedRef.current = true;
          return true;
        };

        const loadSavedSelection = async () => {
          if (savedSelectionCacheRef.current && savedSelectionCacheRef.current.length > 0) {
            return savedSelectionCacheRef.current;
          }
          const raw = await SecureStore.getItemAsync('selectedAlbumIds').catch(() => null);
          if (!raw) {
            savedSelectionCacheRef.current = [];
            return [];
          }
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              const uniqueIds = Array.from(
                new Set(parsed.filter((value): value is string => typeof value === 'string')),
              );
              savedSelectionCacheRef.current = uniqueIds;
              return uniqueIds;
            }
          } catch {}
          savedSelectionCacheRef.current = [];
          return [];
        };

        const savedSelectionIds = hasAutoSelectedRef.current
          ? savedSelectionCacheRef.current ?? []
          : await loadSavedSelection();

        const currentSelectedIds = useAppStore.getState().selectedAlbumIds;
        const requiredIds = new Set<string>([...currentSelectedIds, ...savedSelectionIds]);

        const allAlbums = await (MediaLibrary.getAlbumsAsync as any)({ includeSmartAlbums: true });
        if (cancelled) return;

        const albumIndex = new Map<string, MediaLibrary.Album>();
        const displayMap = new Map<string, MediaLibrary.Album>();
        const nonEmptyAlbumIds: string[] = [];

        const albumMetadata = await Promise.all(
          (allAlbums as MediaLibrary.Album[]).map(async (album) => {
            let hasPhotos = false;
            let derivedName: string | null = null;
            try {
              const resp = await MediaLibrary.getAssetsAsync({ album, mediaType: ['photo'], first: 1 });
              const count = (resp as any)?.totalCount ?? resp.assets.length;
              hasPhotos = count > 0;
              if (hasPhotos) {
                const firstAsset = resp.assets?.[0];
                derivedName = deriveNameFromUri(firstAsset?.uri);
                if (!derivedName && firstAsset) {
                  try {
                    const assetInfo = await MediaLibrary.getAssetInfoAsync(firstAsset.id);
                    derivedName =
                      deriveNameFromUri((assetInfo as any)?.localUri ?? null) ??
                      deriveNameFromUri(assetInfo?.uri ?? null);
                  } catch {}
                }
              }
            } catch {}
            metadataById.set(album.id, { hasPhotos, derivedName });
            return { album, hasPhotos, derivedName };
          }),
        );
        if (cancelled) return;

        for (const { album, hasPhotos, derivedName } of albumMetadata) {
          albumIndex.set(album.id, album);
          const displayTitle = resolveAlbumTitle(album, albumNameCache?.[album.id] ?? derivedName ?? undefined);
          trackAlbumName(album.id, displayTitle);
          if (hasPhotos) {
            if (album.title !== displayTitle) {
              displayMap.set(album.id, { ...album, title: displayTitle } as MediaLibrary.Album);
            } else {
              displayMap.set(album.id, album);
            }
            nonEmptyAlbumIds.push(album.id);
          }
        }

        const missingIds = Array.from(requiredIds).filter((id) => id && !displayMap.has(id));
        if (missingIds.length > 0) {
          const hydrated = await Promise.all(
            missingIds.map(async (id) => {
              if (!id) return null;
              const metadata = metadataById.get(id);
              if (albumIndex.has(id)) {
                const existing = albumIndex.get(id)!;
                const existingTitle = resolveAlbumTitle(existing, albumNameCache?.[id] ?? metadata?.derivedName ?? undefined);
                trackAlbumName(id, existingTitle);
                const normalized = existing.title === existingTitle ? existing : ({ ...existing, title: existingTitle } as MediaLibrary.Album);
                return { id, album: normalized } as const;
              }
              let fetched: MediaLibrary.Album | null = null;
              try {
                fetched = await MediaLibrary.getAlbumAsync(id);
              } catch {}
              if (fetched) {
                albumIndex.set(id, fetched);
                let fetchedDerived: string | null = metadata?.derivedName ?? null;
                if (!fetchedDerived) {
                  try {
                    const resp = await MediaLibrary.getAssetsAsync({ album: fetched, mediaType: ['photo'], first: 1 });
                    const firstAsset = resp.assets?.[0];
                    fetchedDerived = deriveNameFromUri(firstAsset?.uri);
                    if (!fetchedDerived && firstAsset) {
                      try {
                        const assetInfo = await MediaLibrary.getAssetInfoAsync(firstAsset.id);
                        fetchedDerived =
                          deriveNameFromUri((assetInfo as any)?.localUri ?? null) ??
                          deriveNameFromUri(assetInfo?.uri ?? null);
                      } catch {}
                    }
                  } catch {}
                }
                metadataById.set(id, { hasPhotos: Boolean(fetched.assetCount ?? 0), derivedName: fetchedDerived });
                const fetchedTitle = resolveAlbumTitle(fetched, albumNameCache?.[id] ?? fetchedDerived ?? undefined);
                trackAlbumName(id, fetchedTitle);
                const normalized = fetched.title === fetchedTitle ? fetched : ({ ...fetched, title: fetchedTitle } as MediaLibrary.Album);
                return { id, album: normalized } as const;
              }
              const fallbackTitle = albumNameCache?.[id] ?? id;
              trackAlbumName(id, fallbackTitle);
              const placeholder = {
                id,
                title: fallbackTitle,
                assetCount: 0,
                type: 'album',
                startTime: null,
                endTime: null,
              } as unknown as MediaLibrary.Album;
              metadataById.set(id, { hasPhotos: false, derivedName: null });
              return { id, album: placeholder } as const;
            }),
          );
          if (cancelled) return;
          hydrated.forEach((entry) => {
            if (entry) {
              displayMap.set(entry.id, entry.album);
            }
          });
        }

        if (!cancelled) {
          const albumsToDisplay = Array.from(displayMap.values())
            .map((album) => {
              const ensuredTitle = resolveAlbumTitle(album, albumNameCache?.[album.id]);
              if (album.title === ensuredTitle) return album;
              return { ...album, title: ensuredTitle } as MediaLibrary.Album;
            })
            .sort((a, b) => {
              const titleA = a.title ?? '';
              const titleB = b.title ?? '';
              return titleA.localeCompare(titleB);
            });
          setAlbums(albumsToDisplay);
        }

        if (cancelled) return;

        if (!hasAutoSelectedRef.current) {
          const latestSelected = useAppStore.getState().selectedAlbumIds;
          if (latestSelected.length > 0) {
            hasAutoSelectedRef.current = true;
          } else if (!applySelection(savedSelectionIds)) {
            if (!applySelection(nonEmptyAlbumIds)) {
              hasAutoSelectedRef.current = true;
            }
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    refreshAlbums();

    return () => {
      cancelled = true;
    };
  }, [permissionSignature, albumRefreshToken]);

  function toggleAlbum(id: string) {
    if (selectedAlbumIds.includes(id)) {
      setSelectedAlbumIds(selectedAlbumIds.filter((x) => x !== id));
    } else {
      setSelectedAlbumIds([...selectedAlbumIds, id]);
    }
  }

  const downloadDirectoryLabel = Platform.OS === 'android'
    ? describeAndroidDownloadsDirectory(downloadDirectoryUri)
    : '';

  async function changeDownloadDirectory() {
    if (Platform.OS !== 'android') return;
    const uri = await chooseAndroidDownloadsDirectory();
    if (uri) {
      setDownloadDirectoryUri(uri);
    }
  }

  async function resetDownloadDirectory() {
    if (Platform.OS !== 'android') return;
    await clearAndroidDownloadsDirectory();
    setDownloadDirectoryUri(null);
  }


  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
      <List.Section>
        <List.Subheader>Repo & Sync</List.Subheader>
        <List.Item
          title={currentRepo ? `${currentRepo.owner}/${currentRepo.name}` : 'Not selected'}
          description={`Branch: ${currentRepo?.branch ?? '-'}`}
          right={() => <Button onPress={changeRepo}>Change</Button>}
          left={(props) => <List.Icon {...props} icon="source-repository" />}
        />
        <Divider />
        {Platform.OS === 'android' ? (
          <>
            <List.Item
              title="Download folder"
              description={downloadDirectoryLabel}
              left={(props) => <List.Icon {...props} icon="folder-download" />}
              right={() => (
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Button compact onPress={changeDownloadDirectory}>Change</Button>
                  {downloadDirectoryUri ? (
                    <Button compact onPress={resetDownloadDirectory} style={{ marginLeft: 8 }}>Reset</Button>
                  ) : null}
                </View>
              )}
            />
            <Divider />
          </>
        ) : null}
        <List.Item
          title="Auto sync"
          description="Automatically sync new photos from selected albums"
          right={() => <Switch value={autoSync} onValueChange={setAutoSync} />}
          left={(props) => <List.Icon {...props} icon="sync" />}
        />
        <Divider />
        <List.Item
          title="Auto delete after sync"
          description="Delete photos from device after successful cloud upload"
          right={() => <Switch value={autoDeleteAfterSync} onValueChange={setAutoDeleteAfterSync} />}
          left={(props) => <List.Icon {...props} icon="delete-sweep" />}
        />
        <Divider />
        <List.Item
          title="Reset all (dangerous)"
          description="Force wipe repo content and history; clear local caches"
          onPress={confirmAndResetAll}
          right={() => <Button mode="text" loading={resetting} disabled={resetting} onPress={confirmAndResetAll}>Reset</Button>}
          left={(props) => <List.Icon {...props} icon="alert" />}
        />
      </List.Section>

      <List.Section>
        <List.Subheader>Appearance</List.Subheader>
        <RadioButton.Group onValueChange={(v) => setTheme(v as any)} value={themeMode}>
          <List.Item
            title="System"
            onPress={() => setTheme('system')}
            right={() => <RadioButton value="system" />}
            left={(props) => <List.Icon {...props} icon="theme-light-dark" />}
          />
          <List.Item
            title="Light"
            onPress={() => setTheme('light')}
            right={() => <RadioButton value="light" />}
            left={(props) => <List.Icon {...props} icon="white-balance-sunny" />}
          />
          <List.Item
            title="Dark"
            onPress={() => setTheme('dark')}
            right={() => <RadioButton value="dark" />}
            left={(props) => <List.Icon {...props} icon="weather-night" />}
          />
        </RadioButton.Group>
      </List.Section>

      

      <List.Section>
        <List.Subheader>Albums to show & sync</List.Subheader>
        {loading ? (
          <ActivityIndicator />
        ) : (
          albums.map((a) => (
            <List.Item
              key={a.id}
              title={a.title}
              right={() => (
                <Checkbox
                  status={selectedAlbumIds.includes(a.id) ? 'checked' : 'unchecked'}
                  onPress={() => toggleAlbum(a.id)}
                />
              )}
              left={(props) => <List.Icon {...props} icon="folder" />}
            />
          ))
        )}
      </List.Section>

      <List.Section>
        <List.Subheader>Account</List.Subheader>
        <List.Item title="Logout" onPress={logout} left={(props) => <List.Icon {...props} icon="logout" />} />
      </List.Section>
      </ScrollView>
      <Portal>
        <Dialog
          visible={resetDialogVisible}
          onDismiss={dismissResetDialog}
          style={{ borderRadius: 24, marginHorizontal: 12 }}
        >
          <Dialog.Title>
            {resetDialogStage === 'warning' ? 'Reset everything?' : 'This cannot be undone'}
          </Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {isResetConfirmStage
                ? `All commits in ${repoLabel} will be permanently removed. This action cannot be reversed.`
                : `This will erase all ${repoLabel}'s content and history, and clear local caches.`}
            </Text>
            {isResetConfirmStage ? (
              <Text variant="bodySmall" style={{ marginTop: 12 }}>
                Local sync caches and metadata will be cleared so you can start from a clean slate.
              </Text>
            ) : null}
          </Dialog.Content>
          <Dialog.Actions style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
            <Button onPress={handleResetSecondaryAction} disabled={resetting} mode="text">
              {isResetConfirmStage ? 'Back' : 'Cancel'}
            </Button>
            <Button
              mode="contained"
              onPress={handleResetPrimaryAction}
              loading={isResetConfirmStage && resetting}
              disabled={isResetConfirmStage && resetting}
              buttonColor={isResetConfirmStage ? paperTheme.colors.errorContainer : primaryContainerColor}
              textColor={isResetConfirmStage ? paperTheme.colors.onErrorContainer : onPrimaryContainerColor}
              style={{ marginLeft: 8 }}
            >
              {isResetConfirmStage ? 'Reset' : 'Continue'}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}


