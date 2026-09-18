import React from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { Text, useTheme } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function CustomTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.container,
        {
          paddingBottom: Math.max(16, insets.bottom + 8),
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.surfaceVariant,
        },
      ]}
    >
      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key];
        const label =
          typeof options.tabBarLabel === 'string'
            ? options.tabBarLabel
            : options.title ?? route.name;

        const isFocused = state.index === index;

        const onPress = () => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!isFocused && !event.defaultPrevented) navigation.navigate(route.name);
        };

        const iconColor = isFocused ? theme.colors.onSecondaryContainer : theme.colors.onSurfaceVariant;
        const labelColor = isFocused ? theme.colors.onSurface : theme.colors.onSurfaceVariant;
        const bg = isFocused ? theme.colors.secondaryContainer : 'transparent';

        const icon = options.tabBarIcon?.({ focused: isFocused, color: iconColor, size: 22 });

        return (
          <Pressable
            key={route.key}
            accessibilityRole="button"
            onPress={onPress}
            android_ripple={{ color: 'transparent' }}
            style={styles.itemWrapper}
          >
            <View style={styles.itemInner}>
              <View style={[styles.iconPill, { backgroundColor: bg }]}> 
                {icon}
              </View>
              <Text style={[styles.label, { color: labelColor }]} numberOfLines={1}>{label}</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingTop: 10,
    paddingHorizontal: 12,
    borderTopWidth: 0,
  },
  itemWrapper: {
    flex: 1,
    paddingHorizontal: 8,
  },
  itemInner: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconPill: {
    width: 64,
    height: 32,
    borderRadius: 9999,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  label: {
    marginTop: 6,
    fontSize: 12,
    fontWeight: '600',
  },
});


