import React, { useEffect, useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { Button, Dialog, Portal, ProgressBar, Text, useTheme } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import type { Album } from '@/services/albums';
import { shareAlbum, shareUrl, stopSharing, syncShare, useShareStore } from '@/services/share';

type Props = {
  visible: boolean;
  album: Album;
  onDismiss: () => void;
  onToast: (message: string) => void;
};

/** Create, show and revoke an album's share link. */
export function ShareAlbumDialog({ visible, album, onDismiss, onToast }: Props) {
  const theme = useTheme();
  const status = useShareStore((s) => s.status[album.id]) ?? { phase: 'idle' as const };
  const [confirmStop, setConfirmStop] = useState(false);
  // Feedback lives on the button: a snackbar would sit behind this dialog.
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const link = album.share ? shareUrl({ owner: album.share.owner, id: album.share.id, key: album.share.key }) : null;
  const count = album.items.length;
  const what = count === 1 ? 'the 1 item' : `the ${count} photos and videos`;

  const openSheet = async (url: string) => {
    try {
      // iOS sends `message` and `url` separately, so the link would appear twice.
      await Share.share(Platform.OS === 'ios' ? { message: `${album.name} on GitGallery`, url } : { message: `${album.name} on GitGallery: ${url}` });
    } catch {}
  };

  const create = async () => {
    try {
      const url = await shareAlbum(album.id);
      await openSheet(url);
    } catch {
      // The status line shows what went wrong.
    }
  };

  const body = () => {
    if (status.phase === 'working') {
      return (
        <View>
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>{status.label}</Text>
          <ProgressBar progress={status.total > 0 ? status.done / status.total : 0} indeterminate={status.total === 0} style={{ marginTop: 16, height: 6, borderRadius: 3 }} />
          <Text variant="bodySmall" style={{ marginTop: 12, color: theme.colors.onSurfaceVariant }}>
            Everything is encrypted on this phone before it is uploaded. You can close this; it keeps going.
          </Text>
        </View>
      );
    }
    if (confirmStop) {
      return (
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
          The link stops working and the encrypted copies are deleted from your gitgallery-shares repository. People who already saved photos keep them. Your album and photos stay as they are.
        </Text>
      );
    }
    if (link) {
      return (
        <View>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <MaterialCommunityIcons name="link-variant" size={20} color={theme.colors.primary} />
            <Text variant="bodyMedium" style={{ marginLeft: 8, color: theme.colors.onSurface }}>Anyone with this link can view and save {what} in this album.</Text>
          </View>
          <View style={{ marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: theme.colors.surfaceVariant }}>
            <Text selectable variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>{link}</Text>
          </View>
          {status.phase === 'error' ? (
            <View style={{ marginTop: 12 }}>
              <Text variant="bodySmall" style={{ color: theme.colors.error }}>{status.message}</Text>
              <Button compact onPress={() => void syncShare(album.id)} style={{ alignSelf: 'flex-start', marginTop: 4 }}>Try again</Button>
            </View>
          ) : null}
          {/* Kept out of the button row so the main actions never wrap on narrow phones. */}
          <Button
            compact
            icon="link-variant-off"
            textColor={theme.colors.error}
            onPress={() => setConfirmStop(true)}
            style={{ alignSelf: 'flex-start', marginTop: 8, marginLeft: -8 }}
          >
            Stop sharing
          </Button>
        </View>
      );
    }
    return (
      <View>
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
          Anyone with the link can view and save {what} in this album, in full quality, in the GitGallery app or a browser. They don't need GitHub.
        </Text>
        <View style={{ flexDirection: 'row', marginTop: 16 }}>
          <MaterialCommunityIcons name="lock-outline" size={18} color={theme.colors.onSurfaceVariant} style={{ marginTop: 2 }} />
          <Text variant="bodySmall" style={{ flex: 1, marginLeft: 8, color: theme.colors.onSurfaceVariant }}>
            GitGallery stores encrypted copies in a public repository in your GitHub, gitgallery-shares. The key is only in the link, so nobody else can open them. Photos you add to the album later are shared too.
          </Text>
        </View>
        {status.phase === 'error' ? (
          <Text variant="bodySmall" style={{ marginTop: 12, color: theme.colors.error }}>{status.message}</Text>
        ) : null}
      </View>
    );
  };

  const actions = () => {
    if (status.phase === 'working') return <Button onPress={onDismiss}>Close</Button>;
    // Arrays rather than fragments: Dialog.Actions passes props to each child.
    if (confirmStop) {
      return [
          <Button key="back" onPress={() => setConfirmStop(false)}>Back</Button>,
          <Button
            key="stop"
            mode="contained"
            buttonColor={theme.colors.error}
            textColor={theme.colors.onError}
            style={{ marginLeft: 8 }}
            onPress={async () => {
              setConfirmStop(false);
              try {
                await stopSharing(album.id);
                onToast('Sharing stopped. The link no longer works.');
                onDismiss();
              } catch {}
            }}
          >
            Stop sharing
          </Button>,
      ];
    }
    if (link) {
      return [
        <Button
          key="copy"
          onPress={async () => {
            await Clipboard.setStringAsync(link);
            setCopied(true);
          }}
          accessibilityLabel={copied ? 'Link copied' : 'Copy link'}
        >
          {copied ? 'Copied' : 'Copy link'}
        </Button>,
        <Button key="share" mode="contained" icon="share-variant" onPress={() => void openSheet(link)} style={{ marginLeft: 8 }}>
          Share
        </Button>,
      ];
    }
    return [
      <Button key="cancel" onPress={onDismiss}>Cancel</Button>,
      <Button key="create" mode="contained" icon="link-variant" disabled={count === 0} onPress={create} style={{ marginLeft: 8 }}>
        Create link
      </Button>,
    ];
  };

  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onDismiss} style={{ borderRadius: 28, backgroundColor: theme.colors.surface }}>
        <Dialog.Icon icon={confirmStop ? 'link-variant-off' : 'share-variant'} />
        <Dialog.Title style={{ textAlign: 'center' }}>{confirmStop ? 'Stop sharing?' : `Share "${album.name}"`}</Dialog.Title>
        <Dialog.Content>{body()}</Dialog.Content>
        <Dialog.Actions>{actions()}</Dialog.Actions>
      </Dialog>
    </Portal>
  );
}
