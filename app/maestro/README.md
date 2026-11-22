# UI flows (Maestro)

Release checks that drive the real app on a device. Run them on the build
that will ship (release signing, R8) before every store upload.

## Android

1. Boot the emulator and install the release build:
   ```bash
   cd app/android && ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a
   adb -s emulator-5554 install -r app/build/outputs/apk/release/app-release.apk
   ```
2. Sign in with the test account `applicationsplit` (a person approves the
   GitHub code) and open the library `gitgallery-e2e-nov7`. Never run these
   against a real library: they create and delete albums and share links.
3. Put one new photo on the phone so the sync has something to upload (see
   the top of `gallery-viewer-sync.yaml`).
4. Run the flows, logout last because it ends the sign-in:
   ```bash
   maestro --device emulator-5554 test maestro/android/album-lifecycle.yaml
   maestro --device emulator-5554 test maestro/android/gallery-viewer-sync.yaml
   maestro --device emulator-5554 test maestro/android/share-link.yaml
   maestro --device emulator-5554 test maestro/android/settings-dark-mode.yaml
   maestro --device emulator-5554 test maestro/android/logout-demo.yaml
   ```
5. Look at every screenshot the flows take (`~/.maestro/tests/<run>/`).

Messages that show for about 2 seconds (such as "Copied" or "Sharing
stopped") are tapped with `waitToSettleTimeoutMs`, because Maestro otherwise
waits for the screen to settle and the message is gone before it checks.

## iOS

`maestro/ios/ads-consent-banner.yaml` checks Google's IDFA explainer, Apple's tracking prompt and the test banner
from a fresh install (`xcrun simctl uninstall booted com.gitgallery.app` first: the tracking prompt shows once per
install). Debug builds load only Google's test ads; simulators are test devices automatically (their advertising ID is
all zeros, so they can't be added in AdMob, and the code also marks them with `EMULATOR`). A real iPhone must be added
in AdMob > Settings > Test devices first: a debug build prints its ID as `[GitGallery] AdMob test device IDFA: ...`.
