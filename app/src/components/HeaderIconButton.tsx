import React from 'react';
import { Platform, Pressable } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';

/**
 * iOS pins a custom header view's top edge instead of centring it in the glass
 * pill, so anything taller than 36 pt sits low: a 40 pt button by 2 pt, Paper's
 * IconButton (52 pt with its margins) by 8 pt. At 36 pt the icon is on the
 * pill's centre line (measured on the simulator, 0 px off). Android's toolbar
 * centres its views. hitSlop keeps the touch target at 48 pt.
 */
const SIZE = { width: 40, height: Platform.OS === 'ios' ? 36 : 40, alignItems: 'center', justifyContent: 'center' } as const;

type Props = {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  color: string;
  label: string;
  onPress: () => void;
};

/** An icon button for native stack headers (use instead of Paper's IconButton there). */
export function HeaderIconButton({ icon, color, label, onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      android_ripple={{ borderless: true, radius: 22 }}
      style={({ pressed }) => [SIZE, Platform.OS === 'ios' && pressed ? { opacity: 0.4 } : null]}
    >
      <MaterialCommunityIcons name={icon} size={24} color={color} />
    </Pressable>
  );
}
