// The Google Mobile Ads SDK is linked on Android only (ads are Android-only for now), so the iOS app is unchanged.
module.exports = {
  dependencies: {
    'react-native-google-mobile-ads': {
      platforms: { ios: null },
    },
  },
};
