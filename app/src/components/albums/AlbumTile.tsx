import React, { memo } from 'react';
import { ActivityIndicator, Image, Pressable, View } from 'react-native';
import { Text, useTheme } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useCloudPreview } from '@/services/albums/previews';
import { thumbHashDataUrl } from '@/services/sync/thumbhash';
import { isVideoRepoPath } from '@/services/sync/tiering';
import { formatDuration } from '@/components/timeline/grouping';
import type { MetaEntry } from '@/services/sync/types';

export type TileSource =
  | { kind: 'cloud'; path: string; entry?: MetaEntry | null }
  | { kind: 'device'; uri: string; isVideo: boolean; duration?: number | null };

export type TileBadge = 'uploading' | 'waiting' | 'backed-up' | 'in-album' | null;

type Props = {
  size: number;
  spacing: number;
  source: TileSource;
  selectionMode?: boolean;
  selected?: boolean;
  /** Shown but not pickable, e.g. already in the album. */
  disabled?: boolean;
  badge?: TileBadge;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityLabel?: string;
};

function CloudImage({ path, entry, size }: { path: string; entry?: MetaEntry | null; size: number }) {
  const theme = useTheme();
  const { uri, failed } = useCloudPreview(path, entry);
  const placeholder = thumbHashDataUrl(entry?.thumbHash);
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surfaceVariant }}>
      {placeholder ? (
        <Image source={{ uri: placeholder }} style={{ position: 'absolute', width: '100%', height: '100%' }} resizeMode="cover" />
      ) : null}
      {uri ? (
        <Image source={{ uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
      ) : failed ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <MaterialCommunityIcons name="image-off-outline" size={size * 0.3} color={theme.colors.onSurfaceVariant} />
        </View>
      ) : null}
    </View>
  );
}

function AlbumTileImpl({ size, spacing, source, selectionMode, selected, disabled, badge, onPress, onLongPress, accessibilityLabel }: Props) {
  const theme = useTheme();
  const isVideo = source.kind === 'cloud' ? isVideoRepoPath(source.path) : source.isVideo;
  const inset = selected ? Math.round(size * 0.08) : 0;

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      onLongPress={disabled ? undefined : onLongPress}
      delayLongPress={250}
      accessibilityRole="imagebutton"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      style={{ width: size, height: size, margin: spacing, backgroundColor: selected ? theme.colors.primaryContainer : 'transparent' }}
    >
      <View
        style={{
          flex: 1,
          margin: inset,
          borderRadius: selected ? 12 : 0,
          overflow: 'hidden',
          opacity: disabled ? 0.45 : 1,
        }}
      >
        {source.kind === 'cloud' ? (
          <CloudImage path={source.path} entry={source.entry} size={size} />
        ) : (
          <Image source={{ uri: source.uri }} style={{ width: '100%', height: '100%', backgroundColor: theme.colors.surfaceVariant }} resizeMode="cover" />
        )}

        {isVideo ? (
          <View
            pointerEvents="none"
            style={{ position: 'absolute', right: 5, top: 5, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.55)' }}
          >
            {source.kind === 'device' && source.duration ? (
              <Text style={{ color: '#fff', fontSize: 11, marginRight: 2 }}>{formatDuration(source.duration)}</Text>
            ) : null}
            <MaterialCommunityIcons name="play-circle" size={14} color="#fff" />
          </View>
        ) : null}

        {badge === 'uploading' || badge === 'waiting' ? (
          <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, top: 0, backgroundColor: 'rgba(0,0,0,0.28)', alignItems: 'center', justifyContent: 'center' }}>
            {badge === 'uploading' ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <MaterialCommunityIcons name="cloud-upload-outline" size={22} color="#fff" />
            )}
          </View>
        ) : null}
        {badge === 'backed-up' ? (
          <View pointerEvents="none" style={{ position: 'absolute', right: 5, bottom: 5 }}>
            <MaterialCommunityIcons name="cloud-check" size={16} color="#fff" style={{ textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 3 }} />
          </View>
        ) : null}
      </View>

      {badge === 'in-album' ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: 6, top: 6, borderRadius: 12, backgroundColor: theme.colors.surface }}>
          <MaterialCommunityIcons name="check-circle" size={22} color={theme.colors.outline} />
        </View>
      ) : selectionMode ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: 6, top: 6 }}>
          {selected ? (
            <View style={{ borderRadius: 12, backgroundColor: theme.colors.surface }}>
              <MaterialCommunityIcons name="check-circle" size={22} color={theme.colors.primary} />
            </View>
          ) : (
            <MaterialCommunityIcons name="checkbox-blank-circle-outline" size={22} color="#fff" style={{ textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 3 }} />
          )}
        </View>
      ) : null}
    </Pressable>
  );
}

export const AlbumTile = memo(AlbumTileImpl);
