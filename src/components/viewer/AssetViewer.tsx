import React from 'react';
import { FlatList, Image, Modal, StatusBar, TouchableWithoutFeedback, View, useWindowDimensions } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Text } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Full-screen asset viewer, modelled on Immich's.
 *
 * What the previous inline version got wrong, all visible on device:
 *  - a translucent backdrop that let the grid show through
 *  - a hardcoded `aspectRatio: 3/4`, so every image was letterboxed into the
 *    wrong shape regardless of its real dimensions
 *  - horizontal padding that stopped the image ever filling the screen
 *  - actions as inline outlined buttons floating mid-screen
 *  - a stray source label in the corner
 *
 * Immich's viewer is: opaque black, image edge-to-edge, chrome that toggles on
 * tap, and a bottom action bar. That is what this implements.
 */

export type ViewerAction = {
  key: string;
  icon: string;
  label: string;
  onPress: () => void;
  destructive?: boolean;
};

/** One swipeable page in the viewer. */
export type ViewerItem = {
  key: string;
  uri: string;
  isVideo?: boolean;
  subtitle?: string | null;
};

type Props = {
  visible: boolean;
  /** Full set to page through. Falls back to the single `uri` when absent. */
  items?: ViewerItem[];
  /** Index within `items` to open at. */
  initialIndex?: number;
  uri: string | null;
  /** Real pixel dimensions, used so the image is never distorted. */
  width?: number | null;
  height?: number | null;
  /** Small caption under the title, e.g. the capture date. */
  subtitle?: string | null;
  /** Render a player instead of a still. */
  isVideo?: boolean;
  actions: ViewerAction[];
  onClose: () => void;
};

const CHROME_BG = 'rgba(0,0,0,0.55)';

/**
 * Video branch.
 *
 * Kept in its own component because `useVideoPlayer` must not be called
 * conditionally — mounting this only when a video is open keeps the hook
 * unconditional within it.
 */
function VideoSurface({ uri, style }: { uri: string; style: { width: number; height: number } }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.play();
  });
  return <VideoView style={style} player={player} allowsFullscreen nativeControls contentFit="contain" />;
}

function AssetViewerImpl({ visible, items, initialIndex = 0, uri, width, height, subtitle, isVideo, actions, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const [chromeVisible, setChromeVisible] = React.useState(true);
  const pages = items ?? [];
  const [pageIndex, setPageIndex] = React.useState(initialIndex);

  React.useEffect(() => {
    if (visible) setPageIndex(initialIndex);
  }, [visible, initialIndex]);

  const current = pages[pageIndex];
  const effectiveSubtitle = current?.subtitle ?? subtitle;
  const effectiveIsVideo = current ? !!current.isVideo : !!isVideo;

  // Chrome should always come back when a new asset is opened.
  React.useEffect(() => {
    if (visible) setChromeVisible(true);
  }, [visible, uri]);

  // `contain` already preserves the true ratio; giving the image the full
  // window means portrait, landscape and square all fill correctly.
  const imageStyle = React.useMemo(
    () => ({ width: window.width, height: window.height }),
    [window.width, window.height],
  );

  return (
    <Modal visible={visible} transparent={false} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <StatusBar hidden={!chromeVisible} barStyle="light-content" backgroundColor="#000" />
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {pages.length > 1 ? (
          // Horizontal pager so you can move between photos without closing
          // and re-tapping — table stakes for a gallery.
          <FlatList
            data={pages}
            keyExtractor={(p) => p.key}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={Math.min(initialIndex, pages.length - 1)}
            getItemLayout={(_, index) => ({ length: window.width, offset: window.width * index, index })}
            onMomentumScrollEnd={(e) => {
              const next = Math.round(e.nativeEvent.contentOffset.x / window.width);
              if (next !== pageIndex) setPageIndex(next);
            }}
            renderItem={({ item, index }) => (
              <TouchableWithoutFeedback onPress={() => !item.isVideo && setChromeVisible((v) => !v)}>
                <View style={{ width: window.width, height: window.height, alignItems: 'center', justifyContent: 'center' }}>
                  {item.isVideo ? (
                    // Only the visible page gets a player; mounting one per
                    // page would spin up a decoder for every photo in the list.
                    index === pageIndex ? (
                      <VideoSurface uri={item.uri} style={imageStyle} />
                    ) : (
                      <View style={imageStyle} />
                    )
                  ) : (
                    <Image source={{ uri: item.uri }} style={imageStyle} resizeMode="contain" />
                  )}
                </View>
              </TouchableWithoutFeedback>
            )}
          />
        ) : (
          <TouchableWithoutFeedback onPress={() => !isVideo && setChromeVisible((v) => !v)}>
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
              {uri && isVideo ? (
                <VideoSurface uri={uri} style={imageStyle} />
              ) : uri ? (
                <Image
                  source={{ uri }}
                  style={imageStyle}
                  resizeMode="contain"
                  accessibilityLabel="Full size photo"
                />
              ) : (
                <Text style={{ color: '#fff', opacity: 0.6 }}>Loading…</Text>
              )}
            </View>
          </TouchableWithoutFeedback>
        )}

        {chromeVisible ? (
          <>
            {/* Top bar: close + caption */}
            <View
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                paddingTop: insets.top + 8,
                paddingBottom: 12,
                paddingHorizontal: 8,
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: CHROME_BG,
              }}
            >
              <TouchableWithoutFeedback onPress={onClose}>
                <View
                  style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
                  accessibilityRole="button"
                  accessibilityLabel="Close viewer"
                >
                  <MaterialCommunityIcons name="close" size={26} color="#fff" />
                </View>
              </TouchableWithoutFeedback>
              {effectiveSubtitle ? (
                <Text numberOfLines={1} style={{ color: '#fff', fontSize: 15, marginLeft: 4, flex: 1 }}>
                  {effectiveSubtitle}
                </Text>
              ) : null}

              {/*
                For video the player draws its own transport controls along the
                bottom, which collided with our action bar and squeezed the
                labels. Actions move up here instead and the player owns the
                bottom of the screen.
              */}
              {effectiveIsVideo
                ? actions.map((action) => (
                    <TouchableWithoutFeedback key={action.key} onPress={action.onPress}>
                      <View
                        style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
                        accessibilityRole="button"
                        accessibilityLabel={action.label}
                      >
                        <MaterialCommunityIcons
                          name={action.icon as any}
                          size={22}
                          color={action.destructive ? '#EF5350' : '#fff'}
                        />
                      </View>
                    </TouchableWithoutFeedback>
                  ))
                : null}
            </View>

            {/* Bottom action bar */}
            {actions.length > 0 && !effectiveIsVideo ? (
              <View
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 0,
                  paddingBottom: insets.bottom + 10,
                  paddingTop: 12,
                  flexDirection: 'row',
                  justifyContent: 'space-around',
                  backgroundColor: CHROME_BG,
                }}
              >
                {actions.map((action) => (
                  <TouchableWithoutFeedback key={action.key} onPress={action.onPress}>
                    <View
                      style={{ alignItems: 'center', minWidth: 72, paddingVertical: 4 }}
                      accessibilityRole="button"
                      accessibilityLabel={action.label}
                    >
                      <MaterialCommunityIcons
                        name={action.icon as any}
                        size={24}
                        color={action.destructive ? '#EF5350' : '#fff'}
                      />
                      <Text
                        style={{
                          color: action.destructive ? '#EF5350' : '#fff',
                          fontSize: 12,
                          marginTop: 4,
                        }}
                      >
                        {action.label}
                      </Text>
                    </View>
                  </TouchableWithoutFeedback>
                ))}
              </View>
            ) : null}
          </>
        ) : null}
      </View>
    </Modal>
  );
}

export const AssetViewer = React.memo(AssetViewerImpl);
