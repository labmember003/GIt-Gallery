import React, { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, View } from 'react-native';
import { Button, Dialog, HelperText, Portal, Text, TextInput, useTheme } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import type * as MediaLibrary from 'expo-media-library';
import {
  addDeviceAssetsToAlbum,
  addPathsToAlbum,
  coverPathFor,
  createAlbum,
  isAlbumNameTaken,
  useAlbumStore,
  type Album,
} from '@/services/albums';
import { useCloudPreview } from '@/services/albums/previews';

export type AlbumTarget = { device?: MediaLibrary.Asset[]; paths?: string[] };

type Props = {
  visible: boolean;
  target: AlbumTarget | null;
  onDismiss: () => void;
  /** Called with a confirmation line for a toast. */
  onDone: (message: string) => void;
};

function Thumb({ album }: { album: Album }) {
  const theme = useTheme();
  const pendingUri = useAlbumStore((s) => s.pending.find((p) => p.albumId === album.id)?.uri ?? null);
  const cover = coverPathFor(album);
  const { uri } = useCloudPreview(cover);
  const shown = uri ?? (cover ? null : pendingUri);
  return (
    <View style={{ width: 48, height: 48, borderRadius: 10, overflow: 'hidden', backgroundColor: theme.colors.surfaceVariant, alignItems: 'center', justifyContent: 'center' }}>
      {shown ? (
        <Image source={{ uri: shown }} style={{ width: 48, height: 48 }} />
      ) : (
        <MaterialCommunityIcons name="image-album" size={22} color={theme.colors.outline} />
      )}
    </View>
  );
}

/** "Add to album": pick an album or name a new one. */
export function AddToAlbumDialog({ visible, target, onDismiss, onDone }: Props) {
  const theme = useTheme();
  const albums = useAlbumStore((s) => s.albums);
  const pending = useAlbumStore((s) => s.pending);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (visible) {
      setCreating(albums.length === 0);
      setName('');
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const sorted = useMemo(() => [...albums].sort((a, b) => b.updatedAt - a.updatedAt), [albums]);
  const count = (target?.device?.length ?? 0) + (target?.paths?.length ?? 0);
  const taken = name.trim().length > 0 && isAlbumNameTaken(albums, name);

  const addTo = async (albumId: string, albumName: string) => {
    if (!target || busy) return;
    setBusy(true);
    try {
      let added = 0;
      let uploading = 0;
      if (target.paths?.length) added += addPathsToAlbum(albumId, target.paths);
      if (target.device?.length) {
        const result = await addDeviceAssetsToAlbum(albumId, target.device);
        added += result.added;
        uploading += result.uploading;
      }
      onDismiss();
      if (uploading > 0) onDone(`Uploading ${uploading} to GitHub, then adding to "${albumName}"`);
      else if (added > 0) onDone(added === 1 ? `Added to "${albumName}"` : `Added ${added} to "${albumName}"`);
      else onDone(`Already in "${albumName}"`);
    } catch (error: any) {
      onDismiss();
      onDone(`Could not add to album: ${error?.message ?? 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  };

  const createAndAdd = async () => {
    const clean = name.trim();
    if (!clean || taken) return;
    const id = createAlbum(clean);
    if (id) await addTo(id, clean);
  };

  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onDismiss} style={{ borderRadius: 28, backgroundColor: theme.colors.surface, maxHeight: '80%' }}>
        <Dialog.Title>{count > 1 ? `Add ${count} items to album` : 'Add to album'}</Dialog.Title>
        {creating ? (
          <Dialog.Content>
            <TextInput
              mode="outlined"
              label="New album name"
              placeholder="e.g. Goa 2026"
              value={name}
              onChangeText={setName}
              autoFocus
              maxLength={80}
              error={taken}
              onSubmitEditing={createAndAdd}
            />
            <HelperText type="error" visible={taken}>You already have an album with that name.</HelperText>
          </Dialog.Content>
        ) : (
          <Dialog.ScrollArea style={{ paddingHorizontal: 8, borderColor: 'transparent' }}>
            <ScrollView contentContainerStyle={{ paddingVertical: 4 }}>
              <Pressable
                onPress={() => setCreating(true)}
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', padding: 8, borderRadius: 16, backgroundColor: pressed ? theme.colors.surfaceVariant : 'transparent' })}
                accessibilityRole="button"
                accessibilityLabel="New album"
              >
                <View style={{ width: 48, height: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.primaryContainer }}>
                  <MaterialCommunityIcons name="plus" size={26} color={theme.colors.onPrimaryContainer} />
                </View>
                <Text variant="titleSmall" style={{ marginLeft: 14, color: theme.colors.primary }}>New album</Text>
              </Pressable>
              {sorted.map((album) => {
                const n = album.items.length + pending.filter((p) => p.albumId === album.id).length;
                return (
                  <Pressable
                    key={album.id}
                    onPress={() => addTo(album.id, album.name)}
                    disabled={busy}
                    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', padding: 8, borderRadius: 16, backgroundColor: pressed ? theme.colors.surfaceVariant : 'transparent' })}
                    accessibilityRole="button"
                    accessibilityLabel={`Add to ${album.name}`}
                  >
                    <Thumb album={album} />
                    <View style={{ flex: 1, marginLeft: 14 }}>
                      <Text variant="titleSmall" numberOfLines={1} style={{ color: theme.colors.onSurface }}>{album.name}</Text>
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>{n} {n === 1 ? 'item' : 'items'}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          </Dialog.ScrollArea>
        )}
        <Dialog.Actions>
          {creating && albums.length > 0 ? <Button onPress={() => setCreating(false)}>Back</Button> : null}
          <Button onPress={onDismiss}>Cancel</Button>
          {creating ? (
            <Button mode="contained" disabled={!name.trim() || taken || busy} loading={busy} onPress={createAndAdd} style={{ marginLeft: 8, paddingHorizontal: 8 }}>
              Create & add
            </Button>
          ) : null}
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}
