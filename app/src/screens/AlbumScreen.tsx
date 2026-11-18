import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Platform, Pressable, SectionList, StyleSheet, View, useWindowDimensions } from 'react-native';
import { ActivityIndicator, Button, Dialog, Portal, Snackbar, Text, useTheme } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAppStore } from '@/store/appState';
import {
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
import { ShareAlbumDialog } from '@/components/albums/ShareAlbumDialog';
import { SignInAgainBanner } from '@/components/SignInAgainBanner';
import { useAuthHealth } from '@/services/sync/githubClient';
import { deleteAlbumEverywhere, useShareStore } from '@/services/share';
import { HeaderIconButton } from '@/components/HeaderIconButton';

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
  const authEnded = useAuthHealth((s) => s.ended);
  const favorites = useAppStore((s) => s.favorites);
  const toggleFavorite = useAppStore((s) => s.toggleFavorite);
  const { width } = useWindowDimensions();
  const tileSize = Math.floor((width - SPACING * 2 * COLUMNS) / COLUMNS);

  const pending = useMemo(() => allPending.filter((p) => p.albumId === albumId), [allPending, albumId]);
  const [entries, setEntries] = useState<Record<string, MetaEntry>>({});
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Select was tapped: tiles show checkboxes even before anything is picked. */
  const [selecting, setSelecting] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [renameVisible, setRenameVisible] = useState(false);
  const [deleteVisible, setDeleteVisible] = useState(false);
  const [shareVisible, setShareVisible] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const shareStatus = useShareStore((s) => s.status[albumId]);
  const [toast, setToast] = useState<string | null>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [originals, setOriginals] = useState<Record<string, string>>({});
  const [videoFiles, setVideoFiles] = useState<Record<string, string>>({});
  const [titleInHeader, setTitleInHeader] = useState(false);
  const [syncProgress, setSyncProgress] = useState(() => getSyncStatus());
  const selectionMode = selecting || selected.size > 0;

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

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setSelecting(false);
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (selecting || selected.size > 0) {
        clearSelection();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [selecting, selected.size, clearSelection]);

  // Which set of header buttons is showing, to spot a switch between them.
  const headerMode = useRef<'select' | 'album' | null>(null);

  useLayoutEffect(() => {
    const mode = selectionMode ? 'select' : 'album';
    const options = selectionMode
      ? {
          headerTitle: selected.size > 0 ? `${selected.size} selected` : 'Select items',
          headerLeft: () => <HeaderIconButton icon="close" color={theme.colors.onSurface} label="Cancel selection" onPress={clearSelection} />,
          headerRight: () => (
            <HeaderIconButton icon="select-all" color={theme.colors.primary} label="Select all" onPress={() => setSelected(new Set(flat.map((i) => i.id)))} />
          ),
        }
      : {
          headerTitle: titleInHeader ? album?.name ?? '' : '',
          headerLeft: undefined,
          // Options open a dialog: a popup Menu anchored in the native header
          // stopped opening after its first use on iOS.
          headerRight: () => (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <HeaderIconButton icon="image-plus" color={theme.colors.primary} label="Add photos" onPress={openPicker} />
              <HeaderIconButton icon="dots-vertical" color={theme.colors.onSurfaceVariant} label="Album options" onPress={() => setMenuVisible(true)} />
            </View>
          ),
        };
    const switched = headerMode.current !== null && headerMode.current !== mode;
    headerMode.current = mode;
    // iOS builds the new bar button before the new buttons are measured, so
    // going from one button (select all) back to two kept the old width and
    // pushed ⋮ off screen. Dropping the buttons for a frame makes a fresh one.
    if (Platform.OS === 'ios' && switched) {
      navigation.setOptions({ ...options, headerRight: undefined });
      const frame = requestAnimationFrame(() => navigation.setOptions({ headerRight: options.headerRight }));
      return () => cancelAnimationFrame(frame);
    }
    navigation.setOptions(options);
  }, [navigation, selectionMode, selected.size, album?.name, titleInHeader, theme, openPicker, clearSelection, flat]);

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
            setToast('Saving…');
            await downloadRepoFiles([current.entry?.repoPath ?? current.path]);
            setToast('Saved to this device');
          } catch (error: any) {
            setToast(/Network request failed|timed out/i.test(String(error?.message)) ? "Couldn't download. Check your connection and try again." : "Couldn't save this to the device. Try again.");
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
    setToast(`Removed ${selectedItems.length} ${selectedItems.length === 1 ? 'item' : 'items'} from the album. ${selectedItems.length === 1 ? 'It is' : 'They are'} still in your library.`);
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
      {album.share ? (
        <Pressable onPress={() => setShareVisible(true)} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }} accessibilityRole="button" accessibilityLabel="Shared by link. Manage the link.">
          <MaterialCommunityIcons name="link-variant" size={16} color={theme.colors.primary} />
          <Text variant="bodySmall" style={{ marginLeft: 6, color: theme.colors.primary }}>
            {shareStatus?.phase === 'working' ? shareStatus.label : shareStatus?.phase === 'error' ? 'Sharing needs attention' : 'Shared by link'}
          </Text>
        </Pressable>
      ) : null}
      {count > 0 ? (
        <View style={{ flexDirection: 'row', marginTop: 16 }}>
          <ActionChip icon="image-plus" label="Add photos" onPress={openPicker} />
          <ActionChip icon="checkbox-multiple-marked-outline" label="Select" onPress={() => setSelecting(true)} />
          <ActionChip icon="share-variant" label="Share" onPress={() => setShareVisible(true)} />
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
      <SignInAgainBanner style={{ marginTop: 12 }} />
      {lastError && !authEnded ? (
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

      {selected.size > 0 ? (
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
        notice={toast}
        onIndexChange={(index) => {
          setViewerIndex(index);
          void loadForViewer(index);
        }}
      />

      <Portal>
        <Dialog visible={menuVisible} onDismiss={() => setMenuVisible(false)} style={{ borderRadius: 28, backgroundColor: theme.colors.surface }}>
          <Dialog.Title numberOfLines={1}>{album.name}</Dialog.Title>
          <Dialog.Content style={{ paddingHorizontal: 8 }}>
            {[
              { icon: 'share-variant-outline', label: album.share ? 'Share link' : 'Share', onPress: () => setShareVisible(true) },
              { icon: 'pencil-outline', label: 'Rename', onPress: () => setRenameVisible(true) },
              { icon: 'refresh', label: 'Sync now', onPress: () => void syncAlbums() },
              { icon: 'delete-outline', label: 'Delete album', danger: true, onPress: () => setDeleteVisible(true) },
            ].map((row) => (
              <Pressable
                key={row.label}
                onPress={() => {
                  setMenuVisible(false);
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
      </Portal>

      <ShareAlbumDialog visible={shareVisible} album={album} onDismiss={() => setShareVisible(false)} onToast={setToast} />

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
              {album.share ? ' Its share link stops working and the shared copies are removed.' : ''}
            </Text>
            {deleteError ? <Text variant="bodySmall" style={{ marginTop: 12, color: theme.colors.error }}>{deleteError}</Text> : null}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => { setDeleteVisible(false); setDeleteError(null); }}>Cancel</Button>
            <Button
              mode="contained"
              buttonColor={theme.colors.error}
              textColor={theme.colors.onError}
              style={{ marginLeft: 8, paddingHorizontal: 8 }}
              loading={deleting}
              disabled={deleting}
              onPress={async () => {
                setDeleting(true);
                setDeleteError(null);
                try {
                  await deleteAlbumEverywhere(album.id);
                  setDeleteVisible(false);
                } catch {
                  setDeleteError("Couldn't remove the shared copy, so the album was kept. Check your connection and try again.");
                } finally {
                  setDeleting(false);
                }
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
        style={{ marginHorizontal: 16, marginBottom: selected.size > 0 ? 104 : 16, borderRadius: 16 }}
      >
        {toast ?? ''}
      </Snackbar>
    </View>
  );
}
