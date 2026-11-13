import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Pressable, SectionList, StyleSheet, View, useWindowDimensions } from 'react-native';
import { ActivityIndicator, Button, Dialog, IconButton, Menu, Portal, Snackbar, Text, useTheme } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAppStore } from '@/store/appState';
import {
  deleteAlbum,
  removeFromAlbum,
  renameAlbum,
  retryPendingUploads,
  setAlbumCover,
  syncAlbums,
  useAlbumStore,
  type PendingDeviceItem,
} from '@/services/albums';
import { cachedPreview, entryForPath, loadPreview } from '@/services/albums/previews';
import { downloadRepoFiles, getMetaEntriesForPaths, getSyncStatus, subscribeSyncStatus } from '@/services/sync/index';
import { ensureOriginalFile, ensureOriginalUri } from '@/services/sync/cloudCache';
import { isVideoRepoPath } from '@/services/sync/tiering';
import { thumbHashDataUrl } from '@/services/sync/thumbhash';
import type { MetaEntry } from '@/services/sync/types';
import { buildTimelineSections, formatDayLabel, groupingTimestamp } from '@/components/timeline/grouping';
import { TimelineSectionHeader } from '@/components/timeline/TimelineSectionHeader';
import { AssetViewer, type ViewerAction, type ViewerItem } from '@/components/viewer/AssetViewer';
import { AlbumTile } from '@/components/albums/AlbumTile';
import { AlbumNameDialog } from '@/components/albums/AlbumNameDialog';

const COLUMNS = 3;
const SPACING = 1;

type GridItem =
  | { id: string; kind: 'cloud'; path: string; repoPath: string; createdAt: number | null; entry?: MetaEntry }
  | { id: string; kind: 'pending'; pending: PendingDeviceItem; creationTime: number };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dateRangeLabel(items: GridItem[]): string | null {
  let min = Infinity;
  let max = -Infinity;
  for (const item of items) {
    const t = groupingTimestamp(item as any);
    if (!t) continue;
    min = Math.min(min, t);
    max = Math.max(max, t);
  }
  if (!Number.isFinite(min)) return null;
  const a = new Date(min);
  const b = new Date(max);
  const fmt = (d: Date, withYear: boolean) => `${MONTHS[d.getMonth()]} ${d.getDate()}${withYear ? `, ${d.getFullYear()}` : ''}`;
  if (a.toDateString() === b.toDateString()) return fmt(a, true);
  if (a.getFullYear() === b.getFullYear()) return `${fmt(a, false)} – ${fmt(b, true)}`;
  return `${fmt(a, true)} – ${fmt(b, true)}`;
}

function timeCaption(ts: number | null): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  return `${formatDayLabel(d)} · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Immich's AlbumActionFilledButton: tonal pill, primary icon. */
function ActionChip({ icon, label, onPress }: { icon: string; label: string; onPress: () => void }) {
  const theme = useTheme();
  const colors = theme.colors as typeof theme.colors & { surfaceContainerHigh?: string; surfaceContainerHighest?: string };
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        height: 36,
        paddingHorizontal: 16,
        marginRight: 8,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: colors.surfaceContainerHighest ?? theme.colors.outlineVariant,
        backgroundColor: colors.surfaceContainerHigh ?? theme.colors.surfaceVariant,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <MaterialCommunityIcons name={icon as any} size={18} color={theme.colors.primary} />
      <Text variant="labelLarge" style={{ marginLeft: 8, color: theme.colors.onSurface }}>{label}</Text>
    </Pressable>
  );
}

export default function AlbumScreen({ navigation, route }: any) {
  const theme = useTheme();
  const albumId: string = route?.params?.albumId;
  const album = useAlbumStore((s) => s.albums.find((a) => a.id === albumId) ?? null);
  const allPending = useAlbumStore((s) => s.pending);
  const uploading = useAlbumStore((s) => s.uploading);
  const loaded = useAlbumStore((s) => s.loaded);
  const lastError = useAlbumStore((s) => s.lastError);
  const favorites = useAppStore((s) => s.favorites);
  const toggleFavorite = useAppStore((s) => s.toggleFavorite);
  const { width } = useWindowDimensions();
  const tileSize = Math.floor((width - SPACING * 2 * COLUMNS) / COLUMNS);

  const pending = useMemo(() => allPending.filter((p) => p.albumId === albumId), [allPending, albumId]);
  const [entries, setEntries] = useState<Record<string, MetaEntry>>({});
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [menuVisible, setMenuVisible] = useState(false);
  const [renameVisible, setRenameVisible] = useState(false);
  const [deleteVisible, setDeleteVisible] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [originals, setOriginals] = useState<Record<string, string>>({});
  const [videoFiles, setVideoFiles] = useState<Record<string, string>>({});
  const [titleInHeader, setTitleInHeader] = useState(false);
  const [syncProgress, setSyncProgress] = useState(() => getSyncStatus());
  const selectionMode = selected.size > 0;

  useEffect(() => subscribeSyncStatus(() => setSyncProgress({ ...getSyncStatus() })), []);

  // Gone (deleted here or on another device): leave rather than show a husk.
  useEffect(() => {
    if (loaded && !album) navigation.goBack();
  }, [loaded, album, navigation]);

  const itemsKey = album?.items.join('|') ?? '';
  useEffect(() => {
    if (!album || album.items.length === 0) return;
    let live = true;
    setEntriesLoading(true);
    getMetaEntriesForPaths(album.items)
      .then((found) => live && setEntries(found))
      .catch(() => {})
      .finally(() => live && setEntriesLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey]);

  const gridItems = useMemo<GridItem[]>(() => {
    if (!album) return [];
    const cloud: GridItem[] = album.items.map((path) => {
      const entry = entries[path];
      return { id: path, kind: 'cloud', path, repoPath: path, createdAt: entry?.createdAt ?? null, entry };
    });
    const local: GridItem[] = pending.map((p) => ({ id: `pending:${p.assetId}`, kind: 'pending', pending: p, creationTime: p.creationTime }));
    return [...local, ...cloud];
  }, [album, entries, pending]);

  const sections = useMemo(() => buildTimelineSections(gridItems as any[], COLUMNS), [gridItems]);
  const flat = useMemo(() => sections.flatMap((s) => s.data.flat()) as GridItem[], [sections]);
  const rangeLabel = useMemo(() => dateRangeLabel(gridItems), [gridItems]);
  const count = gridItems.length;

  const openPicker = useCallback(() => navigation.navigate('AlbumPicker', { albumId }), [navigation, albumId]);

  // A freshly created album has nothing to show: go straight to picking.
  const openedPickerRef = useRef(false);
  useEffect(() => {
    if (route?.params?.justCreated && !openedPickerRef.current) {
      openedPickerRef.current = true;
      navigation.setParams({ justCreated: undefined });
      openPicker();
    }
  }, [route?.params?.justCreated, navigation, openPicker]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selected.size > 0) {
        clearSelection();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [selected.size, clearSelection]);

  useLayoutEffect(() => {
    if (selectionMode) {
      navigation.setOptions({
        headerTitle: `${selected.size} selected`,
        headerLeft: () => <IconButton icon="close" iconColor={theme.colors.onSurface} accessibilityLabel="Cancel selection" onPress={clearSelection} />,
        headerRight: () => (
          <IconButton
            icon="select-all"
            iconColor={theme.colors.primary}
            accessibilityLabel="Select all"
            onPress={() => setSelected(new Set(flat.map((i) => i.id)))}
          />
        ),
      });
      return;
    }
    navigation.setOptions({
      headerTitle: titleInHeader ? album?.name ?? '' : '',
      headerLeft: undefined,
      headerRight: () => (
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <IconButton icon="image-plus" iconColor={theme.colors.primary} accessibilityLabel="Add photos" onPress={openPicker} />
          <Menu
            visible={menuVisible}
            onDismiss={() => setMenuVisible(false)}
            anchor={<IconButton icon="dots-vertical" iconColor={theme.colors.onSurfaceVariant} accessibilityLabel="Album options" onPress={() => setMenuVisible(true)} />}
            contentStyle={{ borderRadius: 16 }}
          >
            <Menu.Item leadingIcon="pencil-outline" title="Rename" onPress={() => { setMenuVisible(false); setRenameVisible(true); }} />
            <Menu.Item leadingIcon="refresh" title="Sync now" onPress={() => { setMenuVisible(false); void syncAlbums(); }} />
            <Menu.Item leadingIcon="delete-outline" title="Delete album" titleStyle={{ color: theme.colors.error }} onPress={() => { setMenuVisible(false); setDeleteVisible(true); }} />
          </Menu>
        </View>
      ),
    });
  }, [navigation, selectionMode, selected.size, album?.name, titleInHeader, menuVisible, theme, openPicker, clearSelection, flat]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ── Viewer ────────────────────────────────────────────────────────────────
  const viewerItems = useMemo<ViewerItem[]>(() => flat.map((item) => {
    if (item.kind === 'pending') {
      return {
        key: item.id,
        uri: item.pending.uri,
        isVideo: item.pending.mediaType === 'video',
        subtitle: timeCaption(item.pending.creationTime),
      };
    }
    const video = isVideoRepoPath(item.path);
    const file = videoFiles[item.path];
    return {
      key: item.id,
      uri: (video ? file : originals[item.path]) ?? cachedPreview(item.path) ?? thumbHashDataUrl(item.entry?.thumbHash) ?? '',
      isVideo: video && !!file,
      loading: video && !file,
      subtitle: timeCaption(groupingTimestamp(item as any)),
    };
  }), [flat, originals, videoFiles]);

  const loadForViewer = useCallback(async (index: number) => {
    const item = flat[index];
    if (!item || item.kind !== 'cloud') return;
    const repo = useAppStore.getState().currentRepo;
    if (!repo) return;
    const info = { owner: repo.owner, name: repo.name, branch: repo.branch || 'main' };
    const entry = entryForPath(item.entry?.repoPath ?? item.path, item.entry);
    try {
      if (isVideoRepoPath(item.path)) {
        if (videoFiles[item.path]) return;
        const file = await ensureOriginalFile(entry, info);
        setVideoFiles((prev) => ({ ...prev, [item.path]: file }));
      } else {
        if (originals[item.path]) return;
        await loadPreview(item.path, item.entry);
        const uri = await ensureOriginalUri(entry, info);
        setOriginals((prev) => ({ ...prev, [item.path]: uri }));
      }
    } catch (error: any) {
      console.warn('[album] could not load original', error?.message ?? error);
      setToast('Could not load this item. Check your connection.');
    }
  }, [flat, originals, videoFiles]);

  const openViewer = useCallback((id: string) => {
    const index = flat.findIndex((i) => i.id === id);
    if (index < 0) return;
    setViewerIndex(index);
    void loadForViewer(index);
  }, [flat, loadForViewer]);

  const current = viewerIndex != null ? flat[viewerIndex] : null;
  const closeViewer = useCallback(() => setViewerIndex(null), []);

  const viewerActions = useMemo<ViewerAction[]>(() => {
    if (!current) return [];
    const actions: ViewerAction[] = [];
    if (current.kind === 'cloud') {
      const favKey = current.entry?.repoPath ?? current.path;
      const isFav = favorites.includes(favKey);
      actions.push({ key: 'fav', icon: isFav ? 'heart' : 'heart-outline', label: isFav ? 'Favourited' : 'Favourite', onPress: () => toggleFavorite(favKey) });
      const isCover = album?.cover === current.path;
      actions.push({
        key: 'cover',
        icon: isCover ? 'image-check' : 'image-outline',
        label: isCover ? 'Cover' : 'Set cover',
        onPress: () => {
          setAlbumCover(albumId, current.path);
          setToast('Album cover updated');
        },
      });
      actions.push({
        key: 'download',
        icon: 'download-outline',
        label: 'Download',
        onPress: async () => {
          try {
            await downloadRepoFiles([current.entry?.repoPath ?? current.path]);
            setToast('Saved to this device');
          } catch (error: any) {
            setToast(`Download failed: ${error?.message ?? 'unknown error'}`);
          }
        },
      });
    }
    actions.push({
      key: 'remove',
      icon: 'image-remove',
      label: 'Remove',
      destructive: true,
      onPress: () => {
        if (current.kind === 'cloud') removeFromAlbum(albumId, [current.path]);
        else removeFromAlbum(albumId, [], [current.pending.assetId]);
        closeViewer();
        setToast('Removed from album. It is still in your library.');
      },
    });
    return actions;
  }, [current, favorites, toggleFavorite, album?.cover, albumId, closeViewer]);

  // ── Selection actions ─────────────────────────────────────────────────────
  const selectedItems = useMemo(() => flat.filter((i) => selected.has(i.id)), [flat, selected]);
  const removeSelected = useCallback(() => {
    const paths = selectedItems.filter((i) => i.kind === 'cloud').map((i) => (i as any).path as string);
    const assetIds = selectedItems.filter((i) => i.kind === 'pending').map((i) => (i as any).pending.assetId as string);
    removeFromAlbum(albumId, paths, assetIds);
    setToast(`Removed ${selectedItems.length} from album`);
    clearSelection();
  }, [selectedItems, albumId, clearSelection]);
  const downloadSelected = useCallback(async () => {
    const paths = selectedItems.filter((i) => i.kind === 'cloud').map((i) => ((i as any).entry?.repoPath ?? (i as any).path) as string);
    clearSelection();
    if (paths.length === 0) return;
    setToast(`Downloading ${paths.length}…`);
    try {
      await downloadRepoFiles(paths);
      setToast(`Saved ${paths.length} to this device`);
    } catch (error: any) {
      setToast(`Download failed: ${error?.message ?? 'unknown error'}`);
    }
  }, [selectedItems, clearSelection]);
  const coverFromSelection = selectedItems.length === 1 && selectedItems[0].kind === 'cloud' ? (selectedItems[0] as any).path as string : null;

  // ── Render ────────────────────────────────────────────────────────────────
  const renderRow = useCallback(({ item: row }: { item: GridItem[] }) => (
    <View style={{ flexDirection: 'row' }}>
      {row.map((item) => {
        const isSel = selected.has(item.id);
        const onPress = () => (selectionMode ? toggle(item.id) : openViewer(item.id));
        const onLongPress = () => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
          toggle(item.id);
        };
        if (item.kind === 'pending') {
          return (
            <AlbumTile
              key={item.id}
              size={tileSize}
              spacing={SPACING}
              source={{ kind: 'device', uri: item.pending.uri, isVideo: item.pending.mediaType === 'video', duration: item.pending.duration }}
              badge={uploading ? 'uploading' : 'waiting'}
              selectionMode={selectionMode}
              selected={isSel}
              onPress={onPress}
              onLongPress={onLongPress}
              accessibilityLabel="Photo waiting to upload"
            />
          );
        }
        return (
          <AlbumTile
            key={item.id}
            size={tileSize}
            spacing={SPACING}
            source={{ kind: 'cloud', path: item.path, entry: item.entry }}
            selectionMode={selectionMode}
            selected={isSel}
            onPress={onPress}
            onLongPress={onLongPress}
            accessibilityLabel={isVideoRepoPath(item.path) ? 'Video' : 'Photo'}
          />
        );
      })}
    </View>
  ), [selected, selectionMode, toggle, openViewer, tileSize, uploading]);

  if (!album) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.surface }}>
        <ActivityIndicator />
      </View>
    );
  }

  const uploadLabel = (() => {
    if (pending.length === 0) return null;
    if (uploading && syncProgress.running && syncProgress.lastBatchTotal > 0) {
      return `Uploading to GitHub · ${Math.min(syncProgress.lastBatchUploaded, syncProgress.lastBatchTotal)} of ${syncProgress.lastBatchTotal}`;
    }
    if (uploading) return `Uploading ${pending.length} to GitHub…`;
    return `${pending.length} waiting to upload`;
  })();

  const header = (
    <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12 }}>
      <Text variant="headlineMedium" numberOfLines={2} style={{ fontWeight: '600', color: theme.colors.onSurface }}>
        {album.name}
      </Text>
      <Text variant="bodyMedium" style={{ marginTop: 4, color: theme.colors.onSurfaceVariant }}>
        {[rangeLabel, `${count} ${count === 1 ? 'item' : 'items'}`].filter(Boolean).join(' · ')}
      </Text>
      {count > 0 ? (
        <View style={{ flexDirection: 'row', marginTop: 16 }}>
          <ActionChip icon="image-plus" label="Add photos" onPress={openPicker} />
          <ActionChip icon="checkbox-multiple-marked-outline" label="Select" onPress={() => flat[0] && setSelected(new Set([flat[0].id]))} />
        </View>
      ) : null}
      {uploadLabel ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 16, padding: 12, borderRadius: 16, backgroundColor: theme.colors.secondaryContainer }}>
          {uploading ? (
            <ActivityIndicator size={18} color={theme.colors.onSecondaryContainer} />
          ) : (
            <MaterialCommunityIcons name="cloud-upload-outline" size={20} color={theme.colors.onSecondaryContainer} />
          )}
          <Text variant="bodyMedium" style={{ flex: 1, marginLeft: 12, color: theme.colors.onSecondaryContainer }}>{uploadLabel}</Text>
          {!uploading ? (
            <Button compact onPress={() => void retryPendingUploads()} textColor={theme.colors.onSecondaryContainer}>Upload now</Button>
          ) : null}
        </View>
      ) : null}
      {lastError ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12 }}>
          <MaterialCommunityIcons name="cloud-off-outline" size={16} color={theme.colors.error} />
          <Text variant="bodySmall" style={{ flex: 1, marginLeft: 6, color: theme.colors.error }}>{lastError}</Text>
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
      <SectionList
        style={{ flex: 1 }}
        sections={sections as any}
        keyExtractor={(row: any, index) => `${row?.[0]?.id ?? 'row'}-${index}`}
        renderItem={renderRow as any}
        renderSectionHeader={({ section }: any) => <TimelineSectionHeader date={section.date} startsMonth={section.startsMonth} />}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={header}
        onScroll={(e) => {
          const show = e.nativeEvent.contentOffset.y > 56;
          if (show !== titleInHeader) setTitleInHeader(show);
        }}
        scrollEventThrottle={32}
        contentContainerStyle={{ paddingBottom: selectionMode ? 112 : 32, flexGrow: 1 }}
        ListEmptyComponent={
          entriesLoading ? (
            <View style={{ padding: 48, alignItems: 'center' }}>
              <ActivityIndicator />
            </View>
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, paddingBottom: 64 }}>
              <View style={{ width: 88, height: 88, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.primaryContainer }}>
                <MaterialCommunityIcons name="image-plus" size={44} color={theme.colors.onPrimaryContainer} />
              </View>
              <Text variant="titleLarge" style={{ marginTop: 20, fontWeight: '600', textAlign: 'center', color: theme.colors.onSurface }}>
                Add photos to {album.name}
              </Text>
              <Text variant="bodyMedium" style={{ marginTop: 8, textAlign: 'center', color: theme.colors.onSurfaceVariant }}>
                Pick from this phone or from your GitHub library. Photos that are not backed up yet are uploaded to GitHub first.
              </Text>
              <Button mode="contained" icon="image-plus" onPress={openPicker} style={{ marginTop: 24, borderRadius: 999 }} contentStyle={{ height: 48, paddingHorizontal: 8 }}>
                Add photos
              </Button>
            </View>
          )
        }
        removeClippedSubviews={false}
        initialNumToRender={8}
        windowSize={9}
      />

      {selectionMode ? (
        <View
          style={{
            position: 'absolute',
            left: 16,
            right: 16,
            bottom: 24,
            flexDirection: 'row',
            justifyContent: 'space-around',
            paddingVertical: 8,
            borderRadius: 28,
            backgroundColor: (theme.colors as any).surfaceContainerHigh ?? theme.colors.surfaceVariant,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.outlineVariant,
            elevation: 4,
            shadowColor: '#000',
            shadowOpacity: 0.15,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 2 },
          }}
        >
          {[
            { icon: 'download-outline', label: 'Download', onPress: downloadSelected, show: selectedItems.some((i) => i.kind === 'cloud') },
            { icon: 'image-outline', label: 'Set cover', onPress: () => { if (coverFromSelection) { setAlbumCover(albumId, coverFromSelection); setToast('Album cover updated'); } clearSelection(); }, show: !!coverFromSelection },
            { icon: 'image-remove', label: 'Remove', onPress: removeSelected, show: true, danger: true },
          ].filter((a) => a.show).map((a) => (
            <Pressable key={a.label} onPress={a.onPress} accessibilityRole="button" accessibilityLabel={a.label} style={{ alignItems: 'center', minWidth: 80, paddingVertical: 6 }}>
              <MaterialCommunityIcons name={a.icon as any} size={24} color={a.danger ? theme.colors.error : theme.colors.onSurface} />
              <Text variant="labelMedium" style={{ marginTop: 4, color: a.danger ? theme.colors.error : theme.colors.onSurface }}>{a.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <AssetViewer
        visible={viewerIndex != null}
        uri={viewerIndex != null ? viewerItems[viewerIndex]?.uri ?? null : null}
        items={viewerItems}
        initialIndex={viewerIndex ?? 0}
        actions={viewerActions}
        onClose={closeViewer}
        onIndexChange={(index) => {
          setViewerIndex(index);
          void loadForViewer(index);
        }}
      />

      <AlbumNameDialog
        visible={renameVisible}
        title="Rename album"
        confirmLabel="Rename"
        initialName={album.name}
        albumId={album.id}
        onDismiss={() => setRenameVisible(false)}
        onSubmit={(name) => {
          renameAlbum(album.id, name);
          setRenameVisible(false);
        }}
      />

      <Portal>
        <Dialog visible={deleteVisible} onDismiss={() => setDeleteVisible(false)} style={{ borderRadius: 28, backgroundColor: theme.colors.surface }}>
          <Dialog.Icon icon="delete-outline" color={theme.colors.error} />
          <Dialog.Title style={{ textAlign: 'center' }}>Delete "{album.name}"?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              Only the album is deleted. Its photos and videos stay in your library and on GitHub.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeleteVisible(false)}>Cancel</Button>
            <Button
              mode="contained"
              buttonColor={theme.colors.error}
              textColor={theme.colors.onError}
              style={{ marginLeft: 8, paddingHorizontal: 8 }}
              onPress={() => {
                setDeleteVisible(false);
                deleteAlbum(album.id);
              }}
            >
              Delete
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Snackbar
        visible={!!toast}
        onDismiss={() => setToast(null)}
        duration={2600}
        style={{ marginHorizontal: 16, marginBottom: selectionMode ? 104 : 16, borderRadius: 16 }}
      >
        {toast ?? ''}
      </Snackbar>
    </View>
  );
}
