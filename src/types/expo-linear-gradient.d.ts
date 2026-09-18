declare module 'expo-linear-gradient' {
  import * as React from 'react';
  import type { ViewProps } from 'react-native';

  export interface LinearGradientPoint {
    x: number;
    y: number;
  }

  export interface LinearGradientProps extends ViewProps {
    colors: readonly string[];
    locations?: readonly number[];
    start?: LinearGradientPoint | null;
    end?: LinearGradientPoint | null;
  }

  export declare class LinearGradient extends React.Component<LinearGradientProps> {}
}
