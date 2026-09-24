import React from 'react';
import { Provider as PaperProvider } from 'react-native-paper';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { useColorScheme } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import AppNavigator from './src/navigation/AppNavigator';
import { useAppStore } from '@/store/appState';
import { immichDarkTheme, immichLightTheme } from '@/theme/immichTheme';

export default function App() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const themePref = useAppStore((s) => s.theme);
  const effectiveDark = themePref === 'system' ? isDark : themePref === 'dark';
  const paperTheme = effectiveDark ? immichDarkTheme : immichLightTheme;

  // Keep react-navigation's chrome on the same palette as Paper, otherwise the
  // header and screen backgrounds drift apart.
  const navBase = effectiveDark ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...navBase,
    colors: {
      ...navBase.colors,
      primary: paperTheme.colors.primary,
      background: paperTheme.colors.surface,
      card: paperTheme.colors.surface,
      text: paperTheme.colors.onSurface,
      border: paperTheme.colors.outlineVariant,
    },
  };

  return (
    <PaperProvider theme={paperTheme}>
      <NavigationContainer theme={navTheme}>
        <StatusBar style={effectiveDark ? 'light' : 'dark'} />
        <AppNavigator />
      </NavigationContainer>
    </PaperProvider>
  );
}
