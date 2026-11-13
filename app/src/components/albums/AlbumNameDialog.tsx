import React, { useEffect, useState } from 'react';
import { Button, Dialog, HelperText, Portal, TextInput, useTheme } from 'react-native-paper';
import { isAlbumNameTaken, useAlbumStore } from '@/services/albums';

type Props = {
  visible: boolean;
  title: string;
  confirmLabel: string;
  initialName?: string;
  /** Album being renamed, so its own name doesn't count as taken. */
  albumId?: string;
  onDismiss: () => void;
  onSubmit: (name: string) => void;
};

/** Name an album: used for both "New album" and "Rename". */
export function AlbumNameDialog({ visible, title, confirmLabel, initialName = '', albumId, onDismiss, onSubmit }: Props) {
  const theme = useTheme();
  const albums = useAlbumStore((s) => s.albums);
  const [name, setName] = useState(initialName);

  useEffect(() => {
    if (visible) setName(initialName);
  }, [visible, initialName]);

  const trimmed = name.trim();
  const taken = trimmed.length > 0 && isAlbumNameTaken(albums, trimmed, albumId);
  const unchanged = !!albumId && trimmed === initialName.trim();
  const canSubmit = trimmed.length > 0 && !taken && !unchanged;

  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onDismiss} style={{ borderRadius: 28, backgroundColor: theme.colors.surface }}>
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Content>
          <TextInput
            mode="outlined"
            label="Album name"
            placeholder="e.g. Goa 2026"
            value={name}
            onChangeText={setName}
            autoFocus
            maxLength={80}
            returnKeyType="done"
            onSubmitEditing={() => canSubmit && onSubmit(trimmed)}
            error={taken}
          />
          <HelperText type="error" visible={taken}>
            You already have an album with that name.
          </HelperText>
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={onDismiss}>Cancel</Button>
          <Button mode="contained" disabled={!canSubmit} onPress={() => onSubmit(trimmed)} style={{ marginLeft: 8, paddingHorizontal: 8 }}>
            {confirmLabel}
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}
