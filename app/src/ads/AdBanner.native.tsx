import React, { useState } from 'react';
import { Platform, View } from 'react-native';
import { useTheme } from 'react-native-paper';
import { BannerAd, BannerAdSize, TestIds } from 'react-native-google-mobile-ads';
import { useAdsReady } from '@/ads/ads';

// Debug builds show Google's test banner so we never click our own ads.
// Each platform has its own AdMob app and banner unit.
const RELEASE_UNIT = Platform.select({
  ios: 'ca-app-pub-7683902216769416/4819458588',
  default: 'ca-app-pub-7683902216769416/6781181014', // Android
});
const UNIT_ID = __DEV__ ? TestIds.ADAPTIVE_BANNER : RELEASE_UNIT;

/** Anchored adaptive banner above the tab bar. Takes no space until an ad has loaded. */
export default function AdBanner() {
  const theme = useTheme();
  const ready = useAdsReady();
  const [loaded, setLoaded] = useState(false);
  if (!ready) return null;
  return (
    <View
      style={loaded ? { backgroundColor: theme.colors.surface, alignItems: 'center' } : { height: 0, overflow: 'hidden' }}
      testID="ad-banner"
    >
      <BannerAd
        unitId={UNIT_ID}
        size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
        onAdLoaded={() => setLoaded(true)}
        onAdFailedToLoad={() => setLoaded(false)}
      />
    </View>
  );
}
