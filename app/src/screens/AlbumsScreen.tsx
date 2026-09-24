import React, { useMemo, useState } from 'react';
import { FlatList, View } from 'react-native';
import { Button, Dialog, FAB, List, Portal, Text, TextInput, useTheme } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useAppStore } from '@/store/appState';

/**
 * User-created albums.
 *
 * Kept deliberately separate from the "Albums to show & sync" list in
 * Settings: that one selects *device* albums (Camera, Pictures) to decide what
 * gets synced, whereas these are collections the user curates in the app.
 * Conflating the two would be confusing, so the wording here always says
 * "album" in the curated sense.
 */
export default function AlbumsScreen({ navigation }: any) {
  const theme = useTheme();
  const userAlbums = useAppStore((s) => s.userAlbums);
  const createAlbum = useAppStore((s) => s.createAlbum);
  const deleteAlbum = useAppStore((s) => s.deleteAlbum);

  const [createVisible, setCreateVisible] = useState(false);
  const [newName, setNewName] = useState('');
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const entries = useMemo(
    () => Object.entries(userAlbums).sort(([a], [b]) => a.localeCompare(b)),
    [userAlbums],
  );

  const nameTaken = !!userAlbums[newName.trim()];

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface }}>
      {entries.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <MaterialCommunityIcons name="image-album" size={56} color={theme.colors.onSurfaceVariant} />
          <Text variant="titleMedium" style={{ marginTop: 16, color: theme.colors.onSurface }}>
            No albums yet
          </Text>
          <Text style={{ marginTop: 8, textAlign: 'center', color: theme.colors.onSurfaceVariant }}>
            Create one, then add photos to it from the gallery or while viewing a photo.
          </Text>
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={([name]) => name}
          renderItem={({ item: [name, keys] }) => (
            <List.Item
              title={name}
              description={`${keys.length} ${keys.length === 1 ? 'item' : 'items'}`}
              left={(props) => <List.Icon {...props} icon="image-multiple" />}
              onPress={() => navigation?.navigate?.('GitGallery', { albumFilter: name })}
              right={() => (
                <Button
                  mode="text"
                  textColor={theme.colors.error}
                  onPress={() => setPendingDelete(name)}
                  accessibilityLabel={`Delete album ${name}`}
                >
                  Delete
                </Button>
              )}
            />
          )}
        />
      )}

      <FAB
        icon="plus"
        label="New album"
        style={{ position: 'absolute', right: 16, bottom: 16 }}
        onPress={() => {
          setNewName('');
          setCreateVisible(true);
        }}
      />

      <Portal>
        <Dialog visible={createVisible} onDismiss={() => setCreateVisible(false)}>
          <Dialog.Title>New album</Dialog.Title>
          <Dialog.Content>
            <TextInput
              mode="outlined"
              label="Album name"
              value={newName}
              onChangeText={setNewName}
              autoFocus
              error={nameTaken}
            />
            {nameTaken ? (
              <Text style={{ color: theme.colors.error, marginTop: 8 }}>An album with that name already exists.</Text>
            ) : null}
          </Dialog.Content>
          <Dialog.Actions>
            {[
              <Button key="cancel" onPress={() => setCreateVisible(false)}>
                Cancel
              </Button>,
              <Button
                key="create"
                mode="contained"
                disabled={!newName.trim() || nameTaken}
                onPress={() => {
                  createAlbum(newName);
                  setCreateVisible(false);
                }}
              >
                Create
              </Button>,
            ]}
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={!!pendingDelete} onDismiss={() => setPendingDelete(null)}>
          <Dialog.Title>Delete album?</Dialog.Title>
          <Dialog.Content>
            <Text>
              "{pendingDelete}" will be removed. The photos themselves stay exactly where they are — only the album
              grouping goes away.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            {[
              <Button key="cancel" onPress={() => setPendingDelete(null)}>
                Cancel
              </Button>,
              <Button
                key="delete"
                mode="contained"
                buttonColor={theme.colors.errorContainer}
                textColor={theme.colors.onErrorContainer}
                onPress={() => {
                  if (pendingDelete) deleteAlbum(pendingDelete);
                  setPendingDelete(null);
                }}
              >
                Delete
              </Button>,
            ]}
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}
