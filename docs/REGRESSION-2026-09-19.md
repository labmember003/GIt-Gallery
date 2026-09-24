# Regression pass — 2026-09-19

Device: `emulator-5554`, Pixel 6 Pro, Android 16, 1440×3120 @560dpi.
Run from a **clean slate**: app data wiped (`pm clear`) and the repo reset to an empty tree with all releases deleted.

## Results

| # | Test | Result |
|---|---|---|
| R01 | Cloud tab groups by date | ✅ after fix (see C1) |
| R02 | Tier-2 read path resolves via stub | ✅ after fix (see C2) |
| R04 | Cold start after data wipe — dev token, no Welcome flash | ✅ |
| R04b | Permission prompt wording | ✅ "photos and videos", no audio |
| R05 | Local grid, date-grouped | ✅ September / Sat, Sep 19, 2026 |
| R06 | Sync-all: 23 photos incl. 72 MiB tier-2 | ✅ 29 tier-1 blobs, 1 stub, 1 preview, asset in `media-2026` |
| R06b | EXIF dates honoured across years | ✅ 2019, 2021, 2023, 2024, 2025, 2026 |
| R07 | Cloud thumbnails render | ✅ no broken images |
| R08/R09 | Section order newest-first | ✅ after fix (see C3) |
| R10 | Asset viewer opens | ⚠️ works, but not Immich-grade (see U1) |
| R11 | Settings screen | ✅ correct repo, theming, toggles |
| R12 | In-app dark theme | ✅ surface exactly `#1A1C1E` |
| R13 | Dark-mode gallery | ✅ headers legible, grid correct |
| R14 | Rotation | ➖ N/A — `app.json` locks `"orientation": "portrait"` |
| — | Crashes across the whole pass | ✅ zero `FATAL` / `addViewAt` |

## Regressions this pass caught (all introduced by me)

**C1 — Cloud tab: every photo in "Unknown date".**
`buildTimelineSections` read `item.creationTime`, but cloud entries are `MetaEntry` with `createdAt`/`repoPath` and no `creationTime`. The `SectionList` swap was only ever verified against the *local* list. Key extraction had the same flaw and fell back to a row-index key that collides inside a section.
*Fix:* `groupingTimestamp` now handles both shapes and can recover the date from a canonical path; `groupingKey` gives stable identity across both.

**C2 — Tier-2 files uploaded but could never be displayed.**
The write path was built in 1A-bis; the read path never was. The grid requested the original filename, which for a tier-2 file does not exist in the tree (only `<name>.ptr` does) — a guaranteed 404 and a broken-image tile.
*Fix, in two parts:* (a) resolve through the stub to the release asset; (b) — the important one — **commit a preview JPEG** alongside the stub. Without (b), drawing one thumbnail meant downloading a 72 MiB release asset. Tier-2 meta entries now also index the `.ptr` path, so reads no longer start with a wasted 404.

**C3 — Timeline ordered oldest-first.**
Grouping preserved input order. MediaLibrary happens to return newest-first, so local looked right; the cloud list comes back in meta-cache order and rendered 2024 at the top. Immich is newest-first.
*Fix:* sort sections and their items explicitly, undated last — no longer dependent on caller order.

## Correction — pull-to-refresh is NOT broken

An earlier note called pull-to-refresh broken. **It is not.** Forcing `refreshing={true}` renders the spinner correctly, so the control is wired and functional — `adb input swipe` and even a 24-step `input motionevent` drag simply cannot produce the overscroll gesture Android's SwipeRefreshLayout requires.

Two legitimate improvements were kept from the investigation: the list now has an explicit `style={{ flex: 1 }}`, and refresh uses `VirtualizedList`'s built-in `refreshing`/`onRefresh` props instead of a `refreshControl` element.

**Confirmed working** by the user on a real device (2026-09-20).

**Testing limitation to remember:** pull-to-refresh cannot be verified through adb — it needs a real finger. Do not infer breakage from a non-firing synthetic gesture.

## Known gaps (not regressions)

**U1 — Asset viewer is not Immich-grade.** Functional (opens, Delete/Download, close) but: translucent backdrop instead of opaque black, image letterboxed rather than filling, a stray "Cloud" label bottom-left, floating outlined buttons instead of a bottom action bar. → Phase 4D.

**B5** duplicate concurrent API requests · **B7** silent-async FAB pattern still repeats elsewhere in `GalleryScreen.tsx` · **iOS has never been built.**

## Testing notes worth keeping

- **Fast Refresh is not reliable for this codebase.** The newest-first fix did not apply on `/reload`; only a full `am force-stop` + relaunch picked it up. Verify behaviour changes after a full restart.
- **Hardcoded tap coordinates rot.** Section headers pushed the first tile from y=794 to y=1228, so several "the button does nothing" investigations were really stale coordinates. Read bounds from `uiautomator dump` instead of reusing numbers.
- **Deleting every blob via the tree API 404s** (empty tree). Reset a branch with git's empty-tree SHA `4b825dc642cb6eb9a060e54bf8d69288fbee4904` instead.
