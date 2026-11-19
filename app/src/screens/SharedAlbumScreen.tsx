import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Image, Pressable, SectionList, View, useWindowDimensions } from 'react-native';
import { ActivityIndicator, Button, Snackbar, Text, useTheme } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as MediaLibrary from 'expo-media-library';
import { useAppStore } from '@/store/appState';
import { joinSharedAlbum, leaveSharedAlbum, useAlbumStore } from '@/services/albums';
import { cachedSharedAlbum, fetchSharedAlbum, sharedOriginal, sharedPreview, type ShareItem, type ShareManifest, type ShareRef } from '@/services/share';
import { buildTimelineSections, formatDayLabel } from '@/components/timeline/grouping';
import { TimelineSectionHeader } from '@/components/timeline/TimelineSectionHeader';
import { AssetViewer, type ViewerAction, type ViewerItem } from '@/components/viewer/AssetViewer';

/**
 * Someone's shared album, opened from its link. Read-only: everything here is
 * downloaded from the owner's public gitgallery-shares repository and
 * decrypted on this phone with the key from the link.
 */

const COLUMNS = 3;
const SPACING = 1;

type GridItem = ShareItem & { creationTime: number | null };

const Tile = memo(function Tile({ refInfo, item, size, onPress }: { refInfo: ShareRef; item: ShareItem; size: number; onPress: () => void }) {
  const theme = useTheme();
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    sharedPreview(refInfo, item).then((u) => live && setUri(u)).catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [refInfo, item]);
  return (
    <Pressable onPress={onPress} style={{ width: size, height: size, margin: SPACING, backgroundColor: theme.colors.surfaceVariant }} accessibilityRole="imagebutton" accessibilityLabel={item.kind === 'video' ? 'Video' : 'Photo'}>
      {uri ? <Image source={{ uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" /> : null}
      {failed ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <MaterialCommunityIcons name="image-off-outline" size={size * 0.3} color={theme.colors.onSurfaceVariant} />
        </View>
      ) : null}
      {item.kind === 'video' ? (
        <View pointerEvents="none" style={{ position: 'absolute', right: 5, top: 5 }}>
          <MaterialCommunityIcons name="play-circle" size={18} color="#fff" />
        </View>
      ) : null}
    </Pressable>
  );
});

export default function SharedAlbumScreen({ navigation, route }: any) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const tile = Math.floor((width - SPACING * 2 * COLUMNS) / COLUMNS);
  const refInfo = useMemo<ShareRef>(() => ({ owner: route.params.owner, id: route.params.id, key: route.params.key }), [route.params]);
  const signedIn = useAppStore((s) => !!s.authToken && !!s.currentRepo);
  const joined = useAlbumStore((s) => s.joined.some((j) => j.owner === refInfo.owner && j.id === refInfo.id));
  const ownAlbum = useAlbumStore((s) => s.albums.some((a) => a.share?.id === refInfo.id && a.share?.owner === refInfo.owner));

  // Seen this session: show it at once and refresh behind it.
  const [manifest, setManifest] = useState<ShareManifest | null>(() => cachedSharedAlbum(refInfo));
  const [error, setError] = useState<{ message: string; retry: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [originals, setOriginals] = useState<Record<string, string>>({});
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setManifest(await fetchSharedAlbum(refInfo));
    } catch (e: any) {
      if (e?.status !== 404 && cachedSharedAlbum(refInfo)) return; // keep showing what we have
      if (e?.status === 404) setManifest(null); // gone: don't keep its old title in the header
      const offline = /Network request failed|timed out/i.test(String(e?.message)) || (typeof e?.status === 'number' && e.status >= 500);
      setError(e?.status === 404
        ? { message: 'This shared album is no longer available. The owner may have stopped sharing it.', retry: false }
        : offline ? { message: "Couldn't reach GitHub. Check your connection and try again.", retry: true }
        : { message: 'This link could not be opened. Check that you copied the whole link.', retry: false });
    } finally {
      setLoading(false);
    }
  }, [refInfo]);

  useEffect(() => {
    void load();
  }, [load]);

  useLayoutEffect(() => {
    navigation.setOptions({ title: manifest?.title ?? 'Shared album' });
  }, [navigation, manifest?.title]);

  const items = useMemo<GridItem[]>(() => (manifest?.items ?? []).map((i) => ({ ...i, creationTime: i.takenAt })), [manifest]);
  const sections = useMemo(() => buildTimelineSections(items.map((i) => ({ ...i, id: i.id })) as any[], COLUMNS), [items]);
  const flat = useMemo(() => sections.flatMap((s) => s.data.flat()) as GridItem[], [sections]);

  const loadOriginal = useCallback(async (index: number) => {
    const item = flat[index];
    if (!item || originals[item.id]) return;
    sharedPreview(refInfo, item).then((u) => setPreviews((p) => ({ ...p, [item.id]: u }))).catch(() => {});
    try {
      const uri = await sharedOriginal(refInfo, item, (f) => setProgress((p) => ({ ...p, [item.id]: f })));
      setOriginals((o) => ({ ...o, [item.id]: uri }));
    } catch {
      setToast('Could not download this item. Check your connection.');
    }
  }, [flat, originals, refInfo]);

  const viewerItems = useMemo<ViewerItem[]>(() => flat.map((item) => {
    const original = originals[item.id];
    const d = item.takenAt ? new Date(item.takenAt) : null;
    const when = d ? `${formatDayLabel(d)} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : null;
    const fraction = progress[item.id];
    const downloading = item.kind === 'video' && !original && fraction != null && fraction < 1;
    return {
      key: item.id,
      uri: (item.kind === 'video' ? original : original ?? previews[item.id]) ?? previews[item.id] ?? '',
      isVideo: item.kind === 'video' && !!original,
      loading: item.kind === 'video' && !original,
      subtitle: downloading ? `Downloading ${Math.round(fraction * 100)}%` : when,
    };
  }), [flat, originals, previews, progress]);

  const current = viewerIndex != null ? flat[viewerIndex] : null;
  const viewerActions = useMemo<ViewerAction[]>(() => {
    if (!current) return [];
    return [{
      key: 'save',
      icon: 'download-outline',
      label: 'Save to phone',
      onPress: async () => {
        try {
          const perm = await MediaLibrary.requestPermissionsAsync(true);
          if (!perm.granted) {
            setToast('Allow GitGallery to add photos to save this.');
            return;
          }
          setToast('Saving…');
          const uri = originals[current.id] ?? (await sharedOriginal(refInfo, current));
          await MediaLibrary.saveToLibraryAsync(uri);
          setToast('Saved to your phone');
        } catch {
          setToast("Couldn't save this. Check your connection and try again.");
        }
      },
    }];
  }, [current, originals, refInfo]);

  const header = manifest ? (
    <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12 }}>
      <Text variant="headlineMedium" numberOfLines={2} style={{ fontWeight: '600', color: theme.colors.onSurface }}>{manifest.title}</Text>
      <Text variant="bodyMedium" style={{ marginTop: 4, color: theme.colors.onSurfaceVariant }}>
        Shared by @{manifest.owner} · {manifest.items.length} {manifest.items.length === 1 ? 'item' : 'items'}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
        <MaterialCommunityIcons name="eye-outline" size={16} color={theme.colors.onSurfaceVariant} />
        <Text variant="bodySmall" style={{ marginLeft: 6, color: theme.colors.onSurfaceVariant }}>View only · end-to-end encrypted</Text>
      </View>
      {signedIn && !ownAlbum ? (
        <Button
          mode={joined ? 'outlined' : 'contained'}
          icon={joined ? 'check' : 'image-album'}
          style={{ alignSelf: 'flex-start', marginTop: 16, borderRadius: 999 }}
          onPress={() => {
            if (joined) {
              leaveSharedAlbum(refInfo.owner, refInfo.id);
              setToast('Removed from your albums');
            } else {
              joinSharedAlbum({ owner: refInfo.owner, id: refInfo.id, key: refInfo.key, title: manifest.title, joinedAt: Date.now() });
              setToast('Added to your albums');
            }
          }}
        >
          {joined ? 'In your albums' : 'Add to my albums'}
        </Button>
      ) : null}
    </View>
  ) : null;

  if (loading && !manifest) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surface }}>
        <ActivityIndicator />
        <Text variant="bodyMedium" style={{ marginTop: 12, color: theme.colors.onSurfaceVariant }}>Opening shared album…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: theme.colors.surface }}>
        <MaterialCommunityIcons name="link-variant-off" size={48} color={theme.colors.onSurfaceVariant} />
        <Text variant="titleMedium" style={{ marginTop: 12, textAlign: 'center', color: theme.colors.onSurface }}>{error.message}</Text>
        {error.retry ? <Button mode="contained-tonal" onPress={load} style={{ marginTop: 16 }}>Try again</Button> : null}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
      <SectionList
        sections={sections as any}
        keyExtractor={(row: any, index) => `${row?.[0]?.id ?? 'row'}-${index}`}
        renderItem={({ item: row }: any) => (
          <View style={{ flexDirection: 'row' }}>
            {row.map((item: GridItem) => (
              <Tile
                key={item.id}
                refInfo={refInfo}
                item={item}
                size={tile}
                onPress={() => {
                  const index = flat.findIndex((f) => f.id === item.id);
                  setViewerIndex(index);
                  void loadOriginal(index);
                }}
              />
            ))}
          </View>
        )}
        renderSectionHeader={({ section }: any) => <TimelineSectionHeader date={section.date} startsMonth={section.startsMonth} />}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={header}
        refreshing={loading}
        onRefresh={load}
        contentContainerStyle={{ paddingBottom: 32 }}
        ListEmptyComponent={
          <Text variant="bodyMedium" style={{ textAlign: 'center', padding: 32, color: theme.colors.onSurfaceVariant }}>This album is empty.</Text>
        }
      />
      <AssetViewer
        visible={viewerIndex != null}
        uri={viewerIndex != null ? viewerItems[viewerIndex]?.uri ?? null : null}
        items={viewerItems}
        initialIndex={viewerIndex ?? 0}
        actions={viewerActions}
        onClose={() => setViewerIndex(null)}
        notice={toast}
        onIndexChange={(index) => {
          setViewerIndex(index);
          void loadOriginal(index);
        }}
      />
      <Snackbar visible={!!toast} onDismiss={() => setToast(null)} duration={2600} style={{ marginHorizontal: 16, marginBottom: 16, borderRadius: 16 }}>
        {toast ?? ''}
      </Snackbar>
    </View>
  );
}
