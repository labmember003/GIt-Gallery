import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Image, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { Button, Chip, Surface, Text, useTheme } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { AssetViewer, type ViewerAction, type ViewerItem } from '@/components/viewer/AssetViewer';
import { formatDuration } from '@/components/timeline/grouping';
import demoData from '../web/demo-data.json';

/**
 * A read-only sample library, reachable from the welcome screen without
 * signing in.
 *
 * Signing in needs a GitHub account, and GitHub asks an unrecognised device for
 * an emailed or two-factor code, so App Review (and anyone curious) could not
 * see the app at all. This shows the same curated library as the web demo,
 * served from the web app's /demo folder, so the app itself stays small.
 */

const DEMO_BASE_URL = 'https://gitgallery-umber.vercel.app/';
const SPACING = 2;
const COLUMNS = 3;

type DemoRecord = {
  id: string;
  title: string;
  kind: string;
  date: string;
  width: number;
  height: number;
  url: string;
  previewUrl: string | null;
  duration: number | null;
  album: string;
  favorite: boolean;
};

type DemoAsset = {
  id: string;
  title: string;
  isVideo: boolean;
  createdAt: number;
  uri: string;
  thumb: string;
  duration: number | null;
  album: string;
};

const absolute = (path: string) => DEMO_BASE_URL + path.replace(/^\.?\//, '');

const ASSETS: DemoAsset[] = (demoData as DemoRecord[])
  .map((a) => ({
    id: a.id,
    title: a.title,
    isVideo: a.kind === 'video',
    createdAt: new Date(a.date).getTime(),
    uri: absolute(a.url),
    thumb: absolute(a.previewUrl ?? a.url),
    duration: a.duration,
    album: a.album,
  }))
  .sort((a, b) => b.createdAt - a.createdAt);

const ALBUMS = Array.from(new Set(ASSETS.map((a) => a.album)));
const INITIAL_FAVOURITES = new Set((demoData as DemoRecord[]).filter((a) => a.favorite).map((a) => a.id));

type Filter = { kind: 'all' } | { kind: 'favourites' } | { kind: 'album'; name: string };
type Row = { type: 'header'; key: string; title: string } | { type: 'tiles'; key: string; items: DemoAsset[] };

const monthTitle = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const dayTitle = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

function buildRows(assets: DemoAsset[]): Row[] {
  const rows: Row[] = [];
  let month = '';
  let bucket: DemoAsset[] = [];
  const flush = () => {
    for (let i = 0; i < bucket.length; i += COLUMNS) {
      rows.push({ type: 'tiles', key: `${month}-${i}`, items: bucket.slice(i, i + COLUMNS) });
    }
    bucket = [];
  };
  for (const asset of assets) {
    const title = monthTitle(asset.createdAt);
    if (title !== month) {
      flush();
      month = title;
      rows.push({ type: 'header', key: `h-${title}`, title });
    }
    bucket.push(asset);
  }
  flush();
  return rows;
}

type Props = NativeStackScreenProps<any>;

export default function DemoGalleryScreen({ navigation }: Props) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const [filter, setFilter] = useState<Filter>({ kind: 'all' });
  const [favourites, setFavourites] = useState<Set<string>>(() => new Set(INITIAL_FAVOURITES));
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [pageIndex, setPageIndex] = useState(0);

  const tile = Math.floor((width - SPACING * 2) / COLUMNS) - SPACING * 2;

  const visible = useMemo(() => {
    if (filter.kind === 'favourites') return ASSETS.filter((a) => favourites.has(a.id));
    if (filter.kind === 'album') return ASSETS.filter((a) => a.album === filter.name);
    return ASSETS;
  }, [filter, favourites]);

  const rows = useMemo(() => buildRows(visible), [visible]);

  const viewerItems = useMemo<ViewerItem[]>(
    () => visible.map((a) => ({ key: a.id, uri: a.uri, isVideo: a.isVideo, subtitle: `${a.title} · ${dayTitle(a.createdAt)}` })),
    [visible],
  );

  const goToSignIn = useCallback(() => {
    setViewerIndex(null);
    // `initial: false` keeps Welcome underneath, so Sign in still has a Back button.
    navigation.navigate('Onboarding', { screen: 'SignIn', initial: false });
  }, [navigation]);

  const toggleFavourite = useCallback((id: string) => {
    setFavourites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const current = viewerIndex === null ? null : visible[pageIndex] ?? null;
  const viewerActions = useMemo<ViewerAction[]>(() => {
    if (!current) return [];
    const isFav = favourites.has(current.id);
    return [
      { key: 'favourite', icon: isFav ? 'heart' : 'heart-outline', label: isFav ? 'Unfavourite' : 'Favourite', onPress: () => toggleFavourite(current.id) },
      { key: 'backup', icon: 'cloud-upload-outline', label: 'Back up yours', onPress: goToSignIn },
    ];
  }, [current, favourites, toggleFavourite, goToSignIn]);

  const open = useCallback(
    (asset: DemoAsset) => {
      const index = visible.findIndex((a) => a.id === asset.id);
      setPageIndex(index);
      setViewerIndex(index);
    },
    [visible],
  );

  const chips: { label: string; icon: string; value: Filter }[] = [
    { label: 'All', icon: 'image-multiple', value: { kind: 'all' } },
    { label: 'Favourites', icon: 'heart', value: { kind: 'favourites' } },
    ...ALBUMS.map((name) => ({ label: name, icon: 'image-album', value: { kind: 'album', name } as Filter })),
  ];
  const isSelected = (value: Filter) =>
    value.kind === filter.kind && (value.kind !== 'album' || (filter.kind === 'album' && filter.name === value.name));

  const header = (
    <View>
      <Surface style={{ margin: 12, padding: 16, borderRadius: 16, backgroundColor: theme.colors.primaryContainer }} elevation={0}>
        <Text variant="titleMedium" style={{ color: theme.colors.onPrimaryContainer }}>This is a sample library</Text>
        <Text style={{ color: theme.colors.onPrimaryContainer, marginTop: 4, opacity: 0.9 }}>
          Browse it to see how GitGallery works. To back up your own photos and videos to a private GitHub repository you own, sign in with GitHub.
        </Text>
        <Button mode="contained" icon="github" style={{ alignSelf: 'flex-start', marginTop: 12 }} onPress={goToSignIn}>
          Sign in with GitHub
        </Button>
      </Surface>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, gap: 8, paddingBottom: 8 }}>
        {chips.map((chip) => (
          <Chip key={chip.label} icon={chip.icon} selected={isSelected(chip.value)} showSelectedOverlay onPress={() => setFilter(chip.value)}>
            {chip.label}
          </Chip>
        ))}
      </ScrollView>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <Text style={{ textAlign: 'center', marginTop: 32, opacity: 0.7 }}>No favourites yet. Tap the heart on a photo.</Text>
        }
        contentContainerStyle={{ paddingBottom: 32 }}
        renderItem={({ item: row }) =>
          row.type === 'header' ? (
            <Text variant="titleMedium" style={{ paddingHorizontal: 14, paddingTop: 14, paddingBottom: 8, fontWeight: '600' }}>
              {row.title}
            </Text>
          ) : (
            <View style={{ flexDirection: 'row', paddingHorizontal: SPACING }}>
              {row.items.map((asset) => (
                <Pressable
                  key={asset.id}
                  onPress={() => open(asset)}
                  accessibilityRole="imagebutton"
                  accessibilityLabel={`${asset.isVideo ? 'Video' : 'Photo'}: ${asset.title}`}
                  style={{ margin: SPACING }}
                >
                  <Image source={{ uri: asset.thumb }} style={{ width: tile, height: tile, backgroundColor: theme.colors.surfaceVariant }} />
                  {asset.isVideo ? (
                    <View style={{ position: 'absolute', right: 4, top: 4, flexDirection: 'row', alignItems: 'center', gap: 3, paddingLeft: 6, paddingRight: 3, paddingVertical: 1, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.45)' }}>
                      <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>
                        {formatDuration(asset.duration)}
                      </Text>
                      <MaterialCommunityIcons name="play-circle" size={16} color="#fff" />
                    </View>
                  ) : null}
                  {favourites.has(asset.id) ? (
                    <MaterialCommunityIcons name="heart" size={16} color="#fff" style={{ position: 'absolute', left: 5, bottom: 5, textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 3 }} />
                  ) : null}
                </Pressable>
              ))}
            </View>
          )
        }
      />
      <AssetViewer
        visible={viewerIndex !== null}
        uri={current?.uri ?? null}
        items={viewerItems}
        initialIndex={viewerIndex ?? 0}
        isVideo={current?.isVideo}
        subtitle={current ? `${current.title} · ${dayTitle(current.createdAt)}` : null}
        actions={viewerActions}
        onClose={() => setViewerIndex(null)}
        onIndexChange={setPageIndex}
      />
    </View>
  );
}
