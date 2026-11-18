import React from 'react';
import { View } from 'react-native';
import { Button, Text, useTheme } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useAppStore } from '@/store/appState';
import { useAuthHealth } from '@/services/sync/githubClient';

/**
 * Shown when GitHub has ended this phone's sign-in. Signing in again keeps the
 * selected library, so the app comes straight back here afterwards.
 */
export function SignInAgainBanner({ style }: { style?: object }) {
  const theme = useTheme();
  const ended = useAuthHealth((s) => s.ended);
  if (!ended) return null;
  return (
    <View
      style={[{ flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 16, backgroundColor: theme.colors.errorContainer }, style]}
      accessibilityRole="alert"
    >
      <MaterialCommunityIcons name="account-alert-outline" size={22} color={theme.colors.onErrorContainer} />
      <Text variant="bodyMedium" style={{ flex: 1, marginHorizontal: 10, color: theme.colors.onErrorContainer }}>
        GitHub signed you out. Your photos are safe.
      </Text>
      <Button
        mode="contained"
        compact
        buttonColor={theme.colors.onErrorContainer}
        textColor={theme.colors.errorContainer}
        onPress={() => useAppStore.getState().setAuthToken(null)}
      >
        Sign in again
      </Button>
    </View>
  );
}
