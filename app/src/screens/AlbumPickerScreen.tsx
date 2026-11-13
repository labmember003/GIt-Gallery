import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FlatList, View, useWindowDimensions } from 'react-native';
import { ActivityIndicator, Button, IconButton, SegmentedButtons, Text, useTheme } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import * as Haptics from 'expo-haptics';
import { addDeviceAssetsToAlbum, addPathsToAlbum, normalizeAlbumPath, useAlbumStore } from '@/services/albums';
import { getCloudEntriesEnsured, isAssetUploadedAsset, loadMoreCloudEntries, subscribeUploadIndex } from '@/services/sync/index';
import { ensureMediaLibraryPermissions } from '@/services/mediaPermissions';
import type { MetaEntry } from '@/services/sync/types';
import { AlbumTile } from '@/components/albums/AlbumTile';

/**
 * Pick photos for an album, from this phone or from what is already on
 * GitHub. Phone photos that are not backed up are uploaded, then join the
 * album; that is the "upload into this album" path.
 */

const COLUMNS = 4;
const SPACING = 1;
const PAGE = 120;

type Source = 'device' | 'cloud';

export default function AlbumPickerScreen({ navigation, route }: any) {
  const theme = useTheme();
  const albumId: string = route?.params?.albumId;
  const album = useAlbumStore((s) => s.albums.find((a) => a.id === albumId) ?? null);
  const pending = useAlbumStore((s) => s.pending);
  const { width } = useWindowDimensions();
  const tile = Math.floor((width - SPACING * 2 * COLUMNS) / COLUMNS);

  const [source, setSource] = useState<Source>('device');
  const [selectedDevice, setSelectedDevice] = useState<Map<string, MediaLibrary.Asset>>(new Map());
  const [selectedCloud, setSelectedCloud] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  // Device photos
  const [assets, setAssets] = useState<MediaLibrary.Asset[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [deviceLoading, setDeviceLoading] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [, setIndexTick] = useState(0);
  const loadingRef = useRef(false);

  // Cloud photos
  const [cloud, setCloud] = useState<MetaEntry[]>([]);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudHasMore, setCloudHasMore] = useState(true);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const cloudLoadingRef = useRef(false);

  const inAlbum = useMemo(() => new Set(album?.items ?? []), [album]);
  const pendingIds = useMemo(() => new Set(pending.filter((p) => p.albumId === albumId).map((p) => p.assetId)), [pending, albumId]);

  useEffect(() => subscribeUploadIndex(() => setIndexTick((t) => t + 1)), []);

  const loadDevice = useCallback(async (reset = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setDeviceLoading(true);
    try {
      const perm = await ensureMediaLibraryPermissions();
      if (!perm.granted) {
        setPermissionDenied(true);
        return;
      }
      setPermissionDenied(false);
      const page = await MediaLibrary.getAssetsAsync({
        first: PAGE,
        after: reset ? undefined : cursor,
        mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
      });
      setAssets((prev) => (reset ? page.assets : [...prev, ...page.assets]));
      setCursor(page.endCursor);
      setHasMore(page.hasNextPage);
    } catch (error: any) {
      console.warn('[album-picker] device page failed', error?.message ?? error);
    } finally {
      loadingRef.current = false;
      setDeviceLoading(false);
    }
  }, [cursor]);

  const loadCloud = useCallback(async (more = false) => {
    if (cloudLoadingRef.current) return;
    cloudLoadingRef.current = true;
    setCloudLoading(true);
    setCloudError(null);
    try {
      if (more) {
        const remaining = await loadMoreCloudEntries(6);
        setCloudHasMore(remaining);
      }
      const entries = await getCloudEntriesEnsured(100_000);
      const byPath = new Map<string, MetaEntry>();
      for (const entry of entries) {
        if (!entry.repoPath?.startsWith('gitgallery/')) continue;
        byPath.set(normalizeAlbumPath(entry.repoPath), entry);
      }
      const list = [...byPath.values()].sort((a, b) => (b.createdAt ?? b.uploadedAt ?? 0) - (a.createdAt ?? a.uploadedAt ?? 0));
      setCloud(list);
    } catch (error: any) {
      console.warn('[album-picker] cloud list failed', error?.message ?? error);
      setCloudError('Could not load your GitHub library. Check your connection.');
    } finally {
      cloudLoadingRef.current = false;
      setCloudLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDevice(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (source === 'cloud' && cloud.length === 0) void loadCloud(false);
  }, [source, cloud.length, loadCloud]);

  const total = selectedDevice.size + selectedCloud.size;

  const confirm = useCallback(async () => {
    if (total === 0 || busy) return;
    setBusy(true);
    try {
      if (selectedCloud.size > 0) addPathsToAlbum(albumId, [...selectedCloud]);
      if (selectedDevice.size > 0) await addDeviceAssetsToAlbum(albumId, [...selectedDevice.values()]);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      navigation.goBack();
    } finally {
      setBusy(false);
    }
  }, [total, busy, selectedCloud, selectedDevice, albumId, navigation]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: total > 0 ? `${total} selected` : `Add to ${album?.name ?? 'album'}`,
      // Presented as a sheet on iOS, which has no back button of its own.
      headerLeft: () => (
        <IconButton icon="close" iconColor={theme.colors.onSurface} accessibilityLabel="Cancel" onPress={() => navigation.goBack()} />
      ),
      headerRight: () => (
        <Button mode="text" disabled={total === 0 || busy} loading={busy} onPress={confirm} labelStyle={{ fontWeight: '700' }}>
          Add
        </Button>
      ),
    });
  }, [navigation, total, busy, confirm, album?.name, theme.colors.onSurface]);

  const toggleDevice = useCallback((asset: MediaLibrary.Asset) => {
    Haptics.selectionAsync().catch(() => {});
    setSelectedDevice((prev) => {
      const next = new Map(prev);
      if (next.has(asset.id)) next.delete(asset.id);
      else next.set(asset.id, asset);
      return next;
    });
  }, []);

  const toggleCloud = useCallback((path: string) => {
    Haptics.selectionAsync().catch(() => {});
    setSelectedCloud((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const notBackedUp = useMemo(
    () => [...selectedDevice.values()].filter((a) => !isAssetUploadedAsset(a)).length,
    [selectedDevice],
  );

  const empty = (icon: string, title: string, body: string, action?: { label: string; onPress: () => void }) => (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
      <MaterialCommunityIcons name={icon as any} size={48} color={theme.colors.onSurfaceVariant} />
      <Text variant="titleMedium" style={{ marginTop: 12, textAlign: 'center', color: theme.colors.onSurface }}>{title}</Text>
      <Text variant="bodyMedium" style={{ marginTop: 6, textAlign: 'center', color: theme.colors.onSurfaceVariant }}>{body}</Text>
      {action ? <Button mode="contained-tonal" onPress={action.onPress} style={{ marginTop: 16 }}>{action.label}</Button> : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 }}>
        <SegmentedButtons
          value={source}
          onValueChange={(v) => setSource(v as Source)}
          buttons={[
            { value: 'device', label: 'On this phone', icon: 'cellphone' },
            { value: 'cloud', label: 'On GitHub', icon: 'github' },
          ]}
        />
      </View>

      {source === 'device' ? (
        permissionDenied ? (
          empty('image-lock-outline', 'Allow photo access', 'GitGallery needs access to your photos to add them to albums.', { label: 'Allow access', onPress: () => void loadDevice(true) })
        ) : (
          <FlatList
            key="device"
            data={assets}
            keyExtractor={(a) => a.id}
            numColumns={COLUMNS}
            contentContainerStyle={{ paddingBottom: total > 0 ? 120 : 24, flexGrow: 1 }}
            onEndReached={() => hasMore && void loadDevice(false)}
            onEndReachedThreshold={0.6}
            initialNumToRender={24}
            windowSize={7}
            renderItem={({ item }) => {
              const waiting = pendingIds.has(item.id);
              return (
                <AlbumTile
                  size={tile}
                  spacing={SPACING}
                  source={{ kind: 'device', uri: item.uri, isVideo: item.mediaType === 'video', duration: item.duration }}
                  selectionMode
                  selected={selectedDevice.has(item.id)}
                  disabled={waiting}
                  badge={waiting ? 'in-album' : isAssetUploadedAsset(item) ? 'backed-up' : null}
                  onPress={() => toggleDevice(item)}
                  onLongPress={() => toggleDevice(item)}
                  accessibilityLabel={item.mediaType === 'video' ? 'Video' : 'Photo'}
                />
              );
            }}
            ListEmptyComponent={deviceLoading ? <ActivityIndicator style={{ marginTop: 48 }} /> : empty('image-off-outline', 'No photos on this phone', 'Photos you take or save will show up here.')}
            ListFooterComponent={deviceLoading && assets.length > 0 ? <ActivityIndicator style={{ margin: 16 }} /> : null}
          />
        )
      ) : (
        <FlatList
          key="cloud"
          data={cloud}
          keyExtractor={(e) => e.repoPath}
          numColumns={COLUMNS}
          contentContainerStyle={{ paddingBottom: total > 0 ? 120 : 24, flexGrow: 1 }}
          onEndReached={() => cloudHasMore && void loadCloud(true)}
          onEndReachedThreshold={0.6}
          initialNumToRender={24}
          windowSize={5}
          renderItem={({ item }) => {
            const path = normalizeAlbumPath(item.repoPath);
            const already = inAlbum.has(path);
            return (
              <AlbumTile
                size={tile}
                spacing={SPACING}
                source={{ kind: 'cloud', path, entry: item }}
                selectionMode
                selected={selectedCloud.has(path)}
                disabled={already}
                badge={already ? 'in-album' : null}
                onPress={() => toggleCloud(path)}
                onLongPress={() => toggleCloud(path)}
              />
            );
          }}
          ListEmptyComponent={
            cloudLoading ? (
              <ActivityIndicator style={{ marginTop: 48 }} />
            ) : cloudError ? (
              empty('cloud-off-outline', 'Library unavailable', cloudError, { label: 'Try again', onPress: () => void loadCloud(false) })
            ) : (
              empty('cloud-outline', 'Nothing on GitHub yet', 'Switch to "On this phone" to pick photos; they will be uploaded to GitHub.')
            )
          }
          ListFooterComponent={cloudLoading && cloud.length > 0 ? <ActivityIndicator style={{ margin: 16 }} /> : null}
        />
      )}

      {total > 0 ? (
        <View
          style={{
            position: 'absolute',
            left: 16,
            right: 16,
            bottom: 24,
            borderRadius: 28,
            padding: 12,
            paddingLeft: 20,
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: theme.colors.inverseSurface,
            elevation: 6,
            shadowColor: '#000',
            shadowOpacity: 0.2,
            shadowRadius: 10,
            shadowOffset: { width: 0, height: 3 },
          }}
        >
          <View style={{ flex: 1 }}>
            <Text variant="titleSmall" style={{ color: theme.colors.inverseOnSurface }}>
              {total} selected
            </Text>
            {notBackedUp > 0 ? (
              <Text variant="bodySmall" style={{ color: theme.colors.inverseOnSurface, opacity: 0.8 }}>
                {notBackedUp} will be uploaded to GitHub
              </Text>
            ) : null}
          </View>
          <Button
            mode="contained"
            icon={notBackedUp > 0 ? 'cloud-upload' : 'plus'}
            onPress={confirm}
            loading={busy}
            disabled={busy}
            buttonColor={theme.colors.inversePrimary}
            textColor={theme.colors.onPrimaryContainer}
            style={{ borderRadius: 999 }}
          >
            {notBackedUp > 0 ? 'Upload & add' : 'Add'}
          </Button>
        </View>
      ) : null}
    </View>
  );
}
