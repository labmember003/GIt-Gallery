import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import * as localStore from '../localStore';

const DIRECTORY_KEY: localStore.LocalStoreKey = 'downloads:directoryUri';

function getSaf(): typeof FileSystem.StorageAccessFramework | null {
  if (Platform.OS !== 'android') {
    return null;
  }
  const saf = FileSystem.StorageAccessFramework;
  return saf ?? null;
}

async function getPersistedUri(): Promise<string | null> {
  const saf = getSaf();
  if (!saf) {
    return null;
  }
  const persisted = await localStore.getKey(DIRECTORY_KEY);
  if (!persisted) {
    return null;
  }
  try {
    await saf.readDirectoryAsync(persisted);
    return persisted;
  } catch {
    await localStore.deleteKey(DIRECTORY_KEY);
    return null;
  }
}

async function requestDirectory(initialUri?: string): Promise<string | null> {
  const saf = getSaf();
  if (!saf) {
    return null;
  }
  const permissions = await saf.requestDirectoryPermissionsAsync(initialUri);
  if (!permissions.granted || !permissions.directoryUri) {
    return null;
  }
  await localStore.setKey(DIRECTORY_KEY, permissions.directoryUri);
  return permissions.directoryUri;
}

export async function getPersistedAndroidDownloadsDirectory(): Promise<string | null> {
  return getPersistedUri();
}

export async function chooseAndroidDownloadsDirectory(): Promise<string | null> {
  const saf = getSaf();
  if (!saf) {
    return null;
  }
  const current = await getPersistedUri();
  const rootUri = current || (saf.getUriForDirectoryInRoot ? saf.getUriForDirectoryInRoot('downloads') : undefined);
  return requestDirectory(rootUri);
}

export async function clearAndroidDownloadsDirectory(): Promise<void> {
  if (!getSaf()) {
    return;
  }
  await localStore.deleteKey(DIRECTORY_KEY);
}

export function describeAndroidDownloadsDirectory(uri: string | null): string {
  if (!uri) {
    return 'App private storage (prompt on download)';
  }
  try {
    const decoded = decodeURIComponent(uri);
    const treeIndex = decoded.indexOf('/tree/');
    if (treeIndex >= 0) {
      const treePart = decoded.substring(treeIndex + 6);
      return treePart.replace(':', ' / ');
    }
    return decoded;
  } catch {
    return uri;
  }
}

export async function ensureAndroidDownloadsDirectory(): Promise<string | null> {
  const saf = getSaf();
  if (!saf) {
    return null;
  }
  const persisted = await getPersistedUri();
  if (persisted) {
    return persisted;
  }
  const rootUri = saf.getUriForDirectoryInRoot ? saf.getUriForDirectoryInRoot('downloads') : undefined;
  return requestDirectory(rootUri);
}
