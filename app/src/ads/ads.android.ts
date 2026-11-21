import { useEffect, useState } from 'react';
import mobileAds, { AdsConsent, AdsConsentPrivacyOptionsRequirementStatus } from 'react-native-google-mobile-ads';

// Consent first (Google UMP shows the GDPR form only where the law needs it), then the Mobile Ads SDK.
// Banners wait for `ready`, so nothing is requested before consent is known.
let ready = false;
let privacyRequired = false;
let started = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

async function refresh(): Promise<void> {
  try {
    const info = await AdsConsent.getConsentInfo();
    privacyRequired =
      info.privacyOptionsRequirementStatus === AdsConsentPrivacyOptionsRequirementStatus.REQUIRED;
    if (info.canRequestAds && !ready) {
      await mobileAds().initialize();
      ready = true;
    }
  } catch {
    // Offline or the form failed: try again on the next launch; no ads meanwhile.
  }
  emit();
}

export function startAds(): void {
  if (started) return;
  started = true;
  void refresh(); // consent from an earlier session lets ads start right away
  AdsConsent.gatherConsent()
    .catch(() => undefined)
    .finally(() => void refresh());
}

function useAdsState<T>(read: () => T): T {
  const [value, setValue] = useState(read);
  useEffect(() => {
    const l = () => setValue(read());
    listeners.add(l);
    l();
    return () => {
      listeners.delete(l);
    };
  }, [read]);
  return value;
}

const readReady = () => ready;
const readPrivacy = () => privacyRequired;

export function useAdsReady(): boolean {
  return useAdsState(readReady);
}

export function useAdPrivacyChoices(): (() => void) | null {
  const required = useAdsState(readPrivacy);
  return required ? () => void AdsConsent.showPrivacyOptionsForm().finally(() => void refresh()) : null;
}
