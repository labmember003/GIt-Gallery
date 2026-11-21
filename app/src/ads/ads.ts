// Ads run on Android only for now. iOS and the web get these no-op versions;
// Metro picks ads.android.ts on Android.
export function startAds(): void {}
export function useAdsReady(): boolean {
  return false;
}
export function useAdPrivacyChoices(): (() => void) | null {
  return null;
}
