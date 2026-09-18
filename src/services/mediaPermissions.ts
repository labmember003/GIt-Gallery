import { Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';

export async function ensureMediaLibraryPermissions(requireFullAccess = Platform.OS === 'ios'): Promise<MediaLibrary.PermissionResponse> {
  const permissionOptions = requireFullAccess ? { accessPrivileges: 'all' as const } : undefined;
  let current = await MediaLibrary.getPermissionsAsync(permissionOptions as any);
  const needsRequest = !current.granted || (requireFullAccess && current.accessPrivileges !== 'all');

  if (needsRequest) {
    current = await MediaLibrary.requestPermissionsAsync(permissionOptions as any);
  }

  if (requireFullAccess && current.granted && current.accessPrivileges !== 'all') {
    try {
      await (MediaLibrary as any).presentPermissionsPickerAsync?.();
      current = await MediaLibrary.getPermissionsAsync(permissionOptions as any);
    } catch (error) {
      console.warn('Failed to present permissions picker for full photo access', error);
    }
  }
  return current;
}
