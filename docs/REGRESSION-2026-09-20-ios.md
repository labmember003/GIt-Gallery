# iOS test pass — 2026-09-20

Same flows previously run on Android, driven on simulator `fi-test`
(`DDFD69F7-0C0B-4240-B7B5-B20AB89FB905`, iOS 26.4).

## Harness

No `adb` equivalent exists for the simulator, so one was built:

| Need | Tool |
|---|---|
| Window rect | Quartz `CGWindowListCopyWindowInfo` (no accessibility permission needed) |
| Tap / swipe / type | `cliclick` |
| Screen readback | `xcrun simctl io screenshot` |

Device-pixel → screen-point mapping: 27pt bezel all round, 44pt title bar above it.

**Harness bug worth remembering.** The first mapping did its arithmetic in `bc` at
`scale=1`, where `89/1179` truncates to `0.0`; every tap landed on the screen's left
edge. Two taps still *appeared* to work — the first grid thumbnail sits at the left
edge, and tapping anywhere outside the dev menu dismisses it. A broken harness that
produces two plausible successes is worse than one that fails outright. Redone in float.

## Result

| Area | Result |
|---|---|
| Native build | ✅ `BUILD SUCCEEDED`, 0 errors, 100 pods |
| Metro iOS bundle | ✅ after clean restart — 8.7 MB in 4.6 s (stale dev-server state, not the JS graph) |
| Timeline, month/day grouping | ✅ |
| Viewer: opaque black, true aspect, swipe pager | ✅ |
| Video playback | ✅ frame-diff confirmed: 4.7% pixels changed, bbox exactly the video region |
| Favourites (toggle, badge, persistence) | ✅ |
| Albums: create, filter, delete | ✅ |
| Settings: repo, quality, appearance, albums | ✅ |
| Cloud tab reading shared GitHub library | ✅ |
| Upload end-to-end | ✅ 3 commits in `labmember003/gitgallery-test` |
| Dark mode | ✅ after D3 |
| Limited photo access | ✅ after D5 + D6 |
| Crashes | 0 |
| Cloud delete (iOS) | ✅ 58 → 57 blobs |
| Download to device (iOS) | ✅ saved at original capture date |
| Compact history (iOS) | ✅ 48 commits → 1 parentless; all 78 blob SHAs identical |
| Reset all (iOS) | ✅ two-stage confirm; repo wiped to clean slate |
| Kill mid-upload | ✅ no crash, no orphan asset, state honest |
| Auto-retry after reconnect | ✅ added and verified (blobs 8 → 9, no user action) |
| Video ThumbHash (D12) | ✅ both tiers carry a hash; extractor shared via `sync/videoFrame.ts` |
| Scale / rate limit | ✅ 48 photos ≈ 33 units of 5,000/hr → ~0.7 units per photo |
| Warm-cache timeline | ✅ 0.6 s from first paint to populated |

## Bugs found

| # | Bug | Affects |
|---|---|---|
| D1 | Month header text clipped — `labelLarge` fixes `lineHeight: 20`, `fontSize` overridden to 24 | both |
| D2 | Every album named `L0` / `100APPLE` — Android folder heuristic applied to `ph://` uris | iOS |
| D3 | Dark accents were MD3 baseline purple `#6750A4`, hardcoded in the fork base and missed by the theme port | **both** |
| D4 | Favourite badge stacked under the selection tick (both at `left:6, top:6`) | **both** |
| D5 | Limited access → empty gallery (album filter matches nothing, code bailed with `[]`) | iOS |
| D6 | Limited access → picker re-presented every launch, app unreachable | iOS |
| D7 | No selection count in multi-select | **both** |
| D8 | Last row hidden under, and untappable behind, the floating selection bar / FABs | **both** |
| D9 | Every video rendered as a broken tile in the cloud grid (tier 1 and tier 2) — no frame extractor, so no preview JPEG was ever produced | **both** |
| D10 | Meta manifest write dropped on a 409 sha conflict, leaving the index behind the tree | **both** |
| D14 | Blobs named after the source format, not the stored bytes — `.heic`/`.png` files containing JPEG after compression | **both** |
| D11 | Sync failures invisible to the user — `lastError` never rendered, and the toast said "Synced" even when everything failed | **both** |

All eleven fixed and re-verified on device.

D7/D8 were found on a second pass, after the terminal was granted Accessibility permission — until then `cliclick` could not tap or type reliably, so every tap-dependent result was suspect. Two further suspected bugs ("list does not scroll", "tiles render collapsed") were **disproved** by instrumenting the layout: frame 590pt vs content 2201pt with `onScroll` firing, and `onLayout` reporting `125x125` for every tile.

## Android regression (required — shared code changed)

| Check | Result |
|---|---|
| `android/` fingerprint before/after `prebuild --platform ios` | `6e07ae12e40873b674613ded28affeec0266d02c` — **identical** |
| Light mode UI | ✅ unchanged apart from the intended D4 badge move |
| Dark mode UI | ⚠️ **intentionally changed** — accents now Immich blue `#004883` instead of Material purple (D3) |
| Album names ("Pictures") | ✅ still folder-derived; D2 gating did not affect Android |
| iOS-only Settings sections | ✅ correctly absent |
| `FATAL EXCEPTION` | 0 |
| ReactNativeJS errors | 0 |

**Flagged:** D3 and D4 change Android's appearance. Both are corrections — D3 restores the
Immich dark palette the theme port intended, D4 stops one badge hiding another — but they
are visible Android changes, not no-ops.
