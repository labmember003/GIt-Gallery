import { Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';

/**
 * Media types this app may ask for.
 *
 * Without narrowing, expo-media-library requests every type the manifest
 * declares — on Android 13+ that means a photo gallery prompting for *music
 * and audio*. Keep this in sync with the manifest's READ_MEDIA_* permissions.
 */
const GRANULAR_PERMISSIONS: MediaLibrary.GranularPermission[] = ['photo', 'video'];

/**
 * NOTE ON THE API SHAPE — this has bitten us twice.
 *
 *   getPermissionsAsync(writeOnly?: boolean, granularPermissions?: GranularPermission[])
 *   requestPermissionsAsync(writeOnly?: boolean, granularPermissions?: GranularPermission[])
 *
 * Both take POSITIONAL arguments. Passing an options object makes the first
 * argument an object where a boolean is expected, and the native side fails
 * with "Cannot convert '[object Object]' to a Kotlin type" — surfaced only as
 * a rejected promise, so the calling button just appears dead.
 *
 * `usePermissions()` is the exception: it *does* take an options object.
 *
 * There is no `accessPrivileges` request option. It only exists on the
 * *response*; full-access on iOS is obtained by inspecting the response and
 * calling `presentPermissionsPickerAsync()`.
 */
export async function ensureMediaLibraryPermissions(): Promise<MediaLibrary.PermissionResponse> {
  const current = await MediaLibrary.getPermissionsAsync(false, GRANULAR_PERMISSIONS);
  if (current.granted) return current;
  return MediaLibrary.requestPermissionsAsync(false, GRANULAR_PERMISSIONS);
}

/**
 * Ask iOS to re-open the "which photos may this app see" picker.
 *
 * USER-INITIATED ONLY. This used to run automatically from
 * `ensureMediaLibraryPermissions` whenever `accessPrivileges !== 'all'`,
 * which made "Limit Access" unusable: every screen that checked permissions
 * re-presented the picker, so the picker reappeared on each launch and the
 * user could never actually reach the gallery. Limited access is a choice we
 * honour — we show the assets we were given — not a state to nag out of.
 */
export async function presentFullAccessPicker(): Promise<MediaLibrary.PermissionResponse> {
  try {
    await MediaLibrary.presentPermissionsPickerAsync();
  } catch (error) {
    console.warn('Failed to present photo permissions picker', error);
  }
  return MediaLibrary.getPermissionsAsync(false, GRANULAR_PERMISSIONS);
}

/** Options for `MediaLibrary.usePermissions()` — this one *is* an options object. */
export const mediaPermissionOptions = {
  granularPermissions: GRANULAR_PERMISSIONS,
};
