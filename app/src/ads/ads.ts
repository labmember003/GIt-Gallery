// The web has no ads: it gets these no-op versions. Metro picks ads.native.ts on Android and iOS.
export function startAds(): void {}
export function useAdsReady(): boolean {
  return false;
}
export function useAdPrivacyChoices(): (() => void) | null {
  return null;
}
