# GitGallery screenshots

44 original emulator screenshots of the app's existing screens, populated with a curated demo library of 36 photographs and 3 playable video clips.

| Platform | Installed device | Resolution | Captures |
| --- | --- | --- | --- |
| [Android](android/) | Pixel 6 Pro emulator | 1440 × 3120 | 21 |
| [iOS](ios/) | iPhone 16 simulator, iOS 26.4 | 1179 × 2556 | 23 |

All PNGs are direct captures using ADB or `xcrun simctl io screenshot`, with no added frames, overlays, or image edits. Both devices and their runtimes were already installed.

Start with these:

| Screenshot | Android | iOS | What it shows |
| --- | --- | --- | --- |
| 01 — Gallery, light | [PNG](android/01-gallery-light.png) | [PNG](ios/01-gallery-light.png) | Coastal photographs, favourites, video thumbnails, and backup badges |
| 13 — Gallery, dark | [PNG](android/13-gallery-dark.png) | [PNG](ios/13-gallery-dark.png) | The same library in the dark theme |
| 21 — Travel timeline | [PNG](android/21-travel-timeline-dark.png) | [PNG](ios/21-travel-timeline-dark.png) | Alpine lakes, mountains, blossoms, and multiple capture dates |
| 03 — Riviera viewer | [PNG](android/03-riviera-viewer.png) | [PNG](ios/03-riviera-viewer.png) | Full-screen photography and cloud actions |
| 20 — City viewer | [PNG](android/20-city-viewer.png) | [PNG](ios/20-city-viewer.png) | A city skyline at night |
| 08 — Video player | [PNG](android/08-ocean-video-player.png) | [PNG](ios/08-ocean-video-player.png) | Actual ocean footage playing in the app |
| 15 — Favourites | [PNG](android/15-favourites-dark.png) | [PNG](ios/15-favourites-dark.png) | A curated favourites timeline |
| 18 — Mountain album | [PNG](android/18-mountain-album-dark.png) | [PNG](ios/18-mountain-album-dark.png) | Browsing an album |
| 16 — Multi-selection | [PNG](android/16-multi-select-dark.png) | [PNG](ios/16-multi-select-dark.png) | Selecting several photos |
| 11 — Upload quality | [PNG](android/11-upload-quality-light.png) | [PNG](ios/11-upload-quality-light.png) | Compression choices and appearance settings |
| 22 — Welcome | — | [PNG](ios/22-welcome-light.png) | Welcome screen |
| 23 — Sign in | — | [PNG](ios/23-sign-in-light.png) | GitHub sign-in screen |

The remaining captures include light/dark alternatives, album lists, an alpine photo viewer, repository settings, and the add-to-album dialog.

The capture builds used the separate identifier `com.gitgallery.screenshots`, preserving the existing app installations. The repository, upload status, and cloud index were offline demo data. Photos, videos, and albums were installed in each emulator's actual media library. No GitHub sign-in or repository operation was needed.

All temporary authentication and data fixtures were removed from the app source after capture, with the original files restored byte-for-byte. The isolated builds and reusable media inputs are kept outside the repository at `/private/tmp/gitgallery-screenshot-session/`; the demo app remains installed on both emulators. No commit or push was made. The normal Android release APK was rebuilt after restoring the source; the iOS capture build used a separate derived-data directory outside the repository.

Media source URLs are recorded in [media-sources.json](media-sources.json). Screenshot dimensions and SHA-256 checksums are recorded in the [Android manifest](android/capture-manifest.json) and [iOS manifest](ios/capture-manifest.json).
