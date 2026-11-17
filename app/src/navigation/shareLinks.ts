import { useEffect } from 'react';
import { Linking } from 'react-native';
import { createNavigationContainerRef } from '@react-navigation/native';
import { parseShareUrl, type ShareRef } from '@/services/share/format';

export const navigationRef = createNavigationContainerRef<any>();

let pending: ShareRef | null = null;
let ready = false;

function open(ref: ShareRef) {
  if (!ready || !navigationRef.isReady()) {
    pending = ref;
    return;
  }
  pending = null;
  navigationRef.navigate('SharedAlbum', ref);
}

export function handleIncomingUrl(url: string | null | undefined): boolean {
  const ref = url ? parseShareUrl(url) : null;
  if (!ref) return false;
  open(ref);
  return true;
}

/** Call once navigation and persisted state are both ready. */
export function markNavigationReady(): void {
  ready = true;
  if (pending) open(pending);
}

/**
 * Share links arrive as universal links / App Links
 * (https://gitgallery-umber.vercel.app/s/<owner>/<id>#<key>) or through the
 * app's own scheme from the web page's "Open in app" button. Both carry the
 * key in the fragment, which the OS passes through unchanged.
 */
export function useShareLinks(): void {
  useEffect(() => {
    Linking.getInitialURL().then(handleIncomingUrl).catch(() => {});
    const sub = Linking.addEventListener('url', ({ url }) => handleIncomingUrl(url));
    return () => sub.remove();
  }, []);
}
