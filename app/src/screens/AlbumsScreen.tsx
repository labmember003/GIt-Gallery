import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { FlatList, Image, Pressable, RefreshControl, View, useWindowDimensions } from 'react-native';
import { Button, Dialog, IconButton, Portal, Text, useTheme, type MD3Theme } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAppStore } from '@/store/appState';
import {
  coverPathFor,
  createAlbum,
  deleteAlbum,
  renameAlbum,
  syncAlbums,
  useAlbumStore,
  type Album,
  type PendingDeviceItem,
} from '@/services/albums';
import { useCloudPreview } from '@/services/albums/previews';
import { getMetaEntriesForPaths } from '@/services/sync/index';
import { thumbHashDataUrl } from '@/services/sync/thumbhash';
import type { MetaEntry } from '@/services/sync/types';
import { AlbumNameDialog } from '@/components/albums/AlbumNameDialog';

/**
 * The user's albums, as Immich lays them out: a grid of cover cards
 * (reference/immich/mobile/lib/presentation/widgets/album/album_selector.widget.dart
 * `_GridAlbumCard`: radius 16, 1px onSurface@10% border, cover over 2/3 of a
 * 0.7 aspect card, name titleSmall w600, count labelMedium).
 *
 * Albums live in the repository (`gitgallery/albums.json`), so they follow the
 * user to every device and survive a reinstall.
 */

const H_PADDING = 16;
const GAP = 8;

type Colors = MD3Theme['colors'] & {
  surfaceContainerLow?: string;
  surfaceContainerHighest?: string;
};

function AlbumCover({ path, entry, pending }: { path: string | null; entry?: MetaEntry; pending?: PendingDeviceItem }) {
  const theme = useTheme();
  const colors = theme.colors as Colors;
  const { uri } = useCloudPreview(path, entry);
  const placeholder = thumbHashDataUrl(entry?.thumbHash);
  const shown = uri ?? (path ? null : pending?.uri ?? null);
  return (
    <View style={{ flex: 1, backgroundColor: colors.surfaceContainerHighest ?? theme.colors.surfaceVariant, alignItems: 'center', justifyContent: 'center' }}>
      {placeholder && !shown ? (
        <Image source={{ uri: placeholder }} style={{ position: 'absolute', width: '100%', height: '100%' }} resizeMode="cover" />
      ) : null}
      {shown ? (
        <Image source={{ uri: shown }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
      ) : !placeholder ? (
        <MaterialCommunityIcons name="image-album" size={40} color={theme.colors.outline} />
      ) : null}
    </View>
  );
}

function AlbumCard({
  album,
  width,
  entry,
  pending,
  onPress,
  onLongPress,
}: {
  album: Album;
  width: number;
  entry?: MetaEntry;
  pending: PendingDeviceItem[];
  onPress: () => void;
  onLongPress: () => void;
}) {
  const theme = useTheme();
  const colors = theme.colors as Colors;
  const count = album.items.length + pending.length;
  const cover = coverPathFor(album);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${album.name}, ${count} ${count === 1 ? 'item' : 'items'}`}
      style={({ pressed }) => ({
        width,
        height: width / 0.7,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
        backgroundColor: colors.surfaceContainerLow ?? theme.colors.surface,
        overflow: 'hidden',
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View style={{ flex: 2 }}>
        <AlbumCover path={cover} entry={entry} pending={pending[0]} />
        {pending.length > 0 ? (
          <View style={{ position: 'absolute', right: 8, top: 8, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.6)' }}>
            <MaterialCommunityIcons name="cloud-upload-outline" size={14} color="#fff" />
            <Text style={{ color: '#fff', fontSize: 12, marginLeft: 4 }}>{pending.length}</Text>
          </View>
        ) : null}
      </View>
      <View style={{ flex: 1, padding: 12, justifyContent: 'space-evenly' }}>
        <Text variant="titleSmall" numberOfLines={2} style={{ fontWeight: '600', color: theme.colors.onSurface }}>
          {album.name}
        </Text>
        <Text variant="labelMedium" numberOfLines={1} style={{ color: theme.colors.onSurfaceVariant }}>
          {count} {count === 1 ? 'item' : 'items'}
        </Text>
      </View>
    </Pressable>
  );
}

function SyncLine() {
  const theme = useTheme();
  const repo = useAppStore((s) => s.currentRepo);
  const syncing = useAlbumStore((s) => s.syncing);
  const lastError = useAlbumStore((s) => s.lastError);
  const unsynced = useAlbumStore((s) => s.ops.length);
  const icon = lastError ? 'cloud-off-outline' : syncing || unsynced > 0 ? 'cloud-sync-outline' : 'cloud-check-outline';
  const text = lastError
    ? lastError
    : syncing || unsynced > 0
      ? 'Saving to GitHub…'
      : `Saved in ${repo ? `${repo.owner}/${repo.name}` : 'your repository'}`;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: H_PADDING, paddingTop: 4, paddingBottom: 12 }}>
      <MaterialCommunityIcons name={icon as any} size={16} color={lastError ? theme.colors.error : theme.colors.onSurfaceVariant} />
      <Text variant="bodySmall" style={{ flex: 1, marginLeft: 6, color: lastError ? theme.colors.error : theme.colors.onSurfaceVariant }}>
        {text}
      </Text>
    </View>
  );
}

export default function AlbumsScreen({ navigation }: any) {
  const theme = useTheme();
  const { width: windowWidth } = useWindowDimensions();
  const albums = useAlbumStore((s) => s.albums);
  const pending = useAlbumStore((s) => s.pending);
  const loaded = useAlbumStore((s) => s.loaded);

  const [createVisible, setCreateVisible] = useState(false);
  const [optionsFor, setOptionsFor] = useState<Album | null>(null);
  const [renameFor, setRenameFor] = useState<Album | null>(null);
  const [deleteFor, setDeleteFor] = useState<Album | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [coverEntries, setCoverEntries] = useState<Record<string, MetaEntry>>({});

  const sorted = useMemo(
    () => [...albums].sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name)),
    [albums],
  );
  const pendingByAlbum = useMemo(() => {
    const map = new Map<string, PendingDeviceItem[]>();
    for (const item of pending) map.set(item.albumId, [...(map.get(item.albumId) ?? []), item]);
    return map;
  }, [pending]);

  const coverKey = sorted.map((a) => coverPathFor(a) ?? '').join('|');
  useEffect(() => {
    const paths = sorted.map(coverPathFor).filter((p): p is string => !!p);
    if (paths.length === 0) return;
    let live = true;
    getMetaEntriesForPaths(paths)
      .then((found) => live && setCoverEntries(found))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverKey]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <IconButton icon="plus" iconColor={theme.colors.primary} accessibilityLabel="New album" onPress={() => setCreateVisible(true)} />
      ),
    });
  }, [navigation, theme.colors.primary]);

  const openAlbum = useCallback((album: Album) => navigation.navigate('Album', { albumId: album.id }), [navigation]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await syncAlbums();
    } finally {
      setRefreshing(false);
    }
  }, []);

  const cardWidth = Math.floor((windowWidth - H_PADDING * 2 - GAP) / 2);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
      <FlatList
        data={sorted}
        keyExtractor={(a) => a.id}
        numColumns={2}
        columnWrapperStyle={{ gap: GAP, paddingHorizontal: H_PADDING }}
        contentContainerStyle={{ gap: GAP, paddingBottom: 32, flexGrow: 1 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[theme.colors.primary]} tintColor={theme.colors.primary} />}
        ListHeaderComponent={sorted.length > 0 ? <SyncLine /> : null}
        renderItem={({ item }) => {
          const cover = coverPathFor(item);
          return (
            <AlbumCard
              album={item}
              width={cardWidth}
              entry={cover ? coverEntries[cover] : undefined}
              pending={pendingByAlbum.get(item.id) ?? []}
              onPress={() => openAlbum(item)}
              onLongPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
                setOptionsFor(item);
              }}
            />
          );
        }}
        ListEmptyComponent={
          loaded ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
              <View style={{ width: 96, height: 96, borderRadius: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.primaryContainer }}>
                <MaterialCommunityIcons name="image-album" size={48} color={theme.colors.onPrimaryContainer} />
              </View>
              <Text variant="titleLarge" style={{ marginTop: 20, fontWeight: '600', color: theme.colors.onSurface }}>
                Create your first album
              </Text>
              <Text variant="bodyMedium" style={{ marginTop: 8, textAlign: 'center', color: theme.colors.onSurfaceVariant, maxWidth: 320 }}>
                Group photos and videos from a trip or an event. Albums are saved in your GitHub repository, so they are there on every device you sign in to.
              </Text>
              <Button mode="contained" icon="plus" onPress={() => setCreateVisible(true)} style={{ marginTop: 24, borderRadius: 999 }} contentStyle={{ height: 48, paddingHorizontal: 8 }}>
                Create album
              </Button>
            </View>
          ) : null
        }
      />

      <AlbumNameDialog
        visible={createVisible}
        title="New album"
        confirmLabel="Create"
        onDismiss={() => setCreateVisible(false)}
        onSubmit={(name) => {
          const id = createAlbum(name);
          setCreateVisible(false);
          if (id) navigation.navigate('Album', { albumId: id, justCreated: true });
        }}
      />

      <AlbumNameDialog
        visible={!!renameFor}
        title="Rename album"
        confirmLabel="Rename"
        initialName={renameFor?.name ?? ''}
        albumId={renameFor?.id}
        onDismiss={() => setRenameFor(null)}
        onSubmit={(name) => {
          if (renameFor) renameAlbum(renameFor.id, name);
          setRenameFor(null);
        }}
      />

      <Portal>
        <Dialog visible={!!optionsFor} onDismiss={() => setOptionsFor(null)} style={{ borderRadius: 28, backgroundColor: theme.colors.surface }}>
          <Dialog.Title numberOfLines={1}>{optionsFor?.name}</Dialog.Title>
          <Dialog.Content style={{ paddingHorizontal: 8 }}>
            {[
              { icon: 'image-multiple-outline', label: 'Open', onPress: () => optionsFor && openAlbum(optionsFor) },
              { icon: 'pencil-outline', label: 'Rename', onPress: () => setRenameFor(optionsFor) },
              { icon: 'delete-outline', label: 'Delete album', danger: true, onPress: () => setDeleteFor(optionsFor) },
            ].map((row) => (
              <Pressable
                key={row.label}
                onPress={() => {
                  setOptionsFor(null);
                  row.onPress();
                }}
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, borderRadius: 16, backgroundColor: pressed ? theme.colors.surfaceVariant : 'transparent' })}
              >
                <MaterialCommunityIcons name={row.icon as any} size={22} color={row.danger ? theme.colors.error : theme.colors.onSurfaceVariant} />
                <Text variant="bodyLarge" style={{ marginLeft: 16, color: row.danger ? theme.colors.error : theme.colors.onSurface }}>{row.label}</Text>
              </Pressable>
            ))}
          </Dialog.Content>
        </Dialog>

        <Dialog visible={!!deleteFor} onDismiss={() => setDeleteFor(null)} style={{ borderRadius: 28, backgroundColor: theme.colors.surface }}>
          <Dialog.Icon icon="delete-outline" color={theme.colors.error} />
          <Dialog.Title style={{ textAlign: 'center' }}>Delete "{deleteFor?.name}"?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              Only the album is deleted. Its photos and videos stay in your library and on GitHub.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeleteFor(null)}>Cancel</Button>
            <Button
              mode="contained"
              buttonColor={theme.colors.error}
              textColor={theme.colors.onError}
              style={{ marginLeft: 8, paddingHorizontal: 8 }}
              onPress={() => {
                if (deleteFor) deleteAlbum(deleteFor.id);
                setDeleteFor(null);
              }}
            >
              Delete
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}
