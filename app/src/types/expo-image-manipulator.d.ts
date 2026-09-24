declare module 'expo-image-manipulator' {
  export const SaveFormat: any;
  export function manipulateAsync(
    uri: string,
    actions: any[],
    options?: { compress?: number; format?: any; base64?: boolean },
  ): Promise<{ base64?: string; uri?: string; width?: number; height?: number }>;
}


