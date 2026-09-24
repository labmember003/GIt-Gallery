/**
 * Immich-derived Material 3 theme for React Native Paper.
 *
 * Ported from Immich's Flutter theme so the two read as the same product:
 *   reference/immich/mobile/lib/constants/colors.dart
 *   reference/immich/mobile/lib/theme/color_scheme.dart
 *   reference/immich/mobile/lib/theme/theme_data.dart
 *
 * Immich builds its schemes with Flutter's `ColorScheme.fromSeed(...)`, which is
 * a port of the same Material Color Utilities library used here, so the generated
 * tonal palettes match rather than approximate. Immich then overrides `primary`
 * back to the exact brand color (the seed shifts it to #4756B5 otherwise) and
 * pins `onSurface` in light mode — both replicated below.
 */
import {
  argbFromHex,
  hexFromArgb,
  themeFromSourceColor,
  type Theme as McuTheme,
} from '@material/material-color-utilities';
import { MD3DarkTheme, MD3LightTheme, type MD3Theme } from 'react-native-paper';

/** colors.dart:5-6 */
export const IMMICH_BRAND_LIGHT = '#4150AF';
export const IMMICH_BRAND_DARK = '#ACCBFA';

/** color_scheme.dart:9 — Color.fromARGB(255, 34, 31, 32) */
const IMMICH_ON_SURFACE_LIGHT = '#221F20';

/**
 * MD3 surface-container tones. Flutter's ColorScheme exposes these; MCU 0.2.7
 * only gives the core roles, so they're read off the neutral tonal palette at
 * the tones the MD3 spec defines.
 */
const NEUTRAL_TONES = {
  light: { lowest: 100, low: 96, base: 94, high: 92, highest: 90 },
  dark: { lowest: 4, low: 10, base: 12, high: 17, highest: 22 },
} as const;

type SurfaceContainers = {
  surfaceContainerLowest: string;
  surfaceContainerLow: string;
  surfaceContainer: string;
  surfaceContainerHigh: string;
  surfaceContainerHighest: string;
};

function surfaceContainers(theme: McuTheme, isDark: boolean): SurfaceContainers {
  const neutral = theme.palettes.neutral;
  const tones = isDark ? NEUTRAL_TONES.dark : NEUTRAL_TONES.light;
  return {
    surfaceContainerLowest: hexFromArgb(neutral.tone(tones.lowest)),
    surfaceContainerLow: hexFromArgb(neutral.tone(tones.low)),
    surfaceContainer: hexFromArgb(neutral.tone(tones.base)),
    surfaceContainerHigh: hexFromArgb(neutral.tone(tones.high)),
    surfaceContainerHighest: hexFromArgb(neutral.tone(tones.highest)),
  };
}

/** Paper expects `rgba()`; MCU emits `#rrggbb`. */
function withAlpha(hex: string, alpha: number): string {
  const argb = argbFromHex(hex);
  const r = (argb >> 16) & 0xff;
  const g = (argb >> 8) & 0xff;
  const b = argb & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function buildTheme(seed: string, isDark: boolean): MD3Theme {
  const base = isDark ? MD3DarkTheme : MD3LightTheme;
  const mcu = themeFromSourceColor(argbFromHex(seed));
  const scheme = isDark ? mcu.schemes.dark : mcu.schemes.light;
  const hex = (role: keyof typeof scheme) => hexFromArgb(scheme[role] as number);

  const containers = surfaceContainers(mcu, isDark);
  const onSurface = isDark ? hex('onSurface') : IMMICH_ON_SURFACE_LIGHT;

  return {
    ...base,
    colors: {
      ...base.colors,

      // color_scheme.dart:6-13 — primary is pinned to the brand color, not the
      // seed-derived tone.
      primary: seed,
      onPrimary: hex('onPrimary'),
      primaryContainer: hex('primaryContainer'),
      onPrimaryContainer: hex('onPrimaryContainer'),

      secondary: hex('secondary'),
      onSecondary: hex('onSecondary'),
      secondaryContainer: hex('secondaryContainer'),
      onSecondaryContainer: hex('onSecondaryContainer'),

      tertiary: hex('tertiary'),
      onTertiary: hex('onTertiary'),
      tertiaryContainer: hex('tertiaryContainer'),
      onTertiaryContainer: hex('onTertiaryContainer'),

      error: hex('error'),
      onError: hex('onError'),
      errorContainer: hex('errorContainer'),
      onErrorContainer: hex('onErrorContainer'),

      background: hex('background'),
      onBackground: hex('onBackground'),
      surface: hex('surface'),
      onSurface,
      surfaceVariant: hex('surfaceVariant'),
      onSurfaceVariant: hex('onSurfaceVariant'),

      outline: hex('outline'),
      outlineVariant: hex('outlineVariant'),
      shadow: hex('shadow'),
      scrim: hex('scrim'),
      inverseSurface: hex('inverseSurface'),
      inverseOnSurface: hex('inverseOnSurface'),
      inversePrimary: hex('inversePrimary'),

      // Paper derives elevated surfaces from these; MD3 maps them onto the
      // surface-container tones.
      elevation: {
        level0: 'transparent',
        level1: containers.surfaceContainerLow,
        level2: containers.surfaceContainer,
        level3: containers.surfaceContainerHigh,
        level4: containers.surfaceContainerHigh,
        level5: containers.surfaceContainerHighest,
      },

      surfaceDisabled: withAlpha(onSurface, 0.12),
      onSurfaceDisabled: withAlpha(onSurface, 0.38),
      backdrop: withAlpha(hex('scrim'), 0.4),
    },
  };
}

/**
 * Immich seeds light and dark from *different* brand colors rather than
 * flipping brightness on one seed (color_scheme.dart:6-13).
 */
export const immichLightTheme = buildTheme(IMMICH_BRAND_LIGHT, false);
export const immichDarkTheme = buildTheme(IMMICH_BRAND_DARK, true);

/** Extra surface roles Paper's type doesn't carry, for screens that need them. */
export const immichSurfaces = {
  light: surfaceContainers(themeFromSourceColor(argbFromHex(IMMICH_BRAND_LIGHT)), false),
  dark: surfaceContainers(themeFromSourceColor(argbFromHex(IMMICH_BRAND_DARK)), true),
};
