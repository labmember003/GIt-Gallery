# GitGallery — Implementation Plan

> Companion to [`PROJECT-DOC.md`](./PROJECT-DOC.md). That doc is *what & why*; this one is *how & in what order*.
> **Total estimate: ~3–5 weeks** of focused AI-assisted work to a solid v1.
> **Last updated:** 2026-09-17

---

## Ground rules

1. **Never break a working app.** GitGalleryApp runs today. Every phase ends with the app still launching and syncing.
2. **Storage-layer changes are destructive-by-nature.** Anything touching force-push or delete gets tested against a **throwaway repo with junk photos** before it ever sees real data.
3. **UI work and storage work are independent** — they can interleave if we get bored of one.
4. Ship each phase behind a branch.
5. **Nothing is "done" until it has been run on a device.** Every task is verified by driving the emulator/simulator directly — build, install, exercise the flow, screenshot, read the screenshot back. Code that merely compiles is untested. Visual drift from Immich counts as a defect, not a nicety. Full rules in [`../CLAUDE.md`](../CLAUDE.md) §1.

---

## Phase 0 — Get the baseline running (½–1 day)

Nothing is real until the unmodified app runs on hardware.

| # | Task | Status |
|---|---|---|
| 0.1 | `npm install` in `app/` | ✅ Done — needed an isolated npm cache (`EACCES` on `~/.npm/_cacache`) |
| 0.2 | Create a **GitHub OAuth App** for Device Flow | 🔴 **Blocked — needs the user.** OAuth Apps can't be created via API. Must tick *Enable Device Flow*. |
| 0.3 | Wire client ID into `.env` as `EXPO_PUBLIC_GITHUB_CLIENT_ID` | ⏳ Blocked by 0.2 |
| 0.4 | `npx expo run:android` on emulator | ✅ Done — APK 63 MB, running on `emulator-5554` (Pixel 6 Pro, Android 16, 1440×3120 @560dpi) |
| 0.5 | `npx expo run:ios` | ⏳ Not attempted yet. **Unproven — upstream is Android-first.** |
| 0.6 | Create a **throwaway private test repo** + upload ~50 junk photos | ⏳ Blocked by 0.2 |
| 0.7 | Decide: fork in place vs. fresh repo | ✅ Done — `app/` is a fresh repo, `upstream` → Sumit189/GitGalleryApp, `origin` → personal |

**Verified on device:** Welcome renders → "Get Started" navigates → Sign In renders → sign-in fails cleanly with a visible error and a resolved spinner.

**Exit criteria:** app installs, signs in with *your* GitHub, uploads a photo to *your* test repo, shows it in the cloud gallery — on both Android and (ideally) iOS. **Partially met** — everything up to sign-in works; the rest is gated on 0.2.

**Risk:** iOS has never been validated upstream. If 0.5 turns into a swamp, defer iOS to Phase 5 and continue on Android.

### Bugs found during Phase 0

| # | Bug | Status |
|---|---|---|
| B1 | `app.json` `userInterfaceStyle: "light"` pinned the app to light mode, making the Settings "system" theme option permanently inert | ✅ Fixed → `"automatic"` |
| B2 | **Hydration race** — `appState.ts:96` hydrates SecureStore fire-and-forget while `AppNavigator.tsx:75` reads `authToken` synchronously on first render → flash of Welcome screen on every cold start for signed-in users | ⏳ Open — needs a token to verify visually. Fix = `hydrated` flag gating a splash. |
| B3 | `@material/material-color-utilities@0.4.0` ships a broken ESM build | ✅ Pinned to `0.2.7` |
| B4 | **Over-broad Android permissions** — manifest declared `READ_MEDIA_AUDIO`, `RECORD_AUDIO` and `CAMERA` (merged in from `expo-media-library` / `expo-image-picker` defaults), so a photo gallery prompted for *music and microphone* access | ✅ Fixed — stripped via `tools:node="remove"`; runtime request narrowed to `['photo','video']` at all call sites |
| B5 | ✅ **FIXED** — **Duplicate concurrent API requests** — two callers hydrate the meta index simultaneously with no in-flight dedup. Logs show identical GETs 6–26ms apart and a `PUT → 409` from two writers racing on `manifest.json` | ✅ Fixed via `requestCache.ts` coalescing. **Measured: cold hydrate 60 → 13 requests (4.6× fewer), 13 duplicates prevented.** Root cause was `ensureBaseState`/`ensureShardLoaded` in `metaIndex.ts` — their `if (cache)` guard only helps *after* a load finishes, so concurrent callers both passed it. |
| B6 | **Grid overflow** — `GalleryScreen.tsx:364` computed tile width as `floor(windowWidth / 3) - SPACING*2` without subtracting the list's own `padding: SPACING`. Total came to 415dp in a 411dp window, so the third column was clipped at the screen edge (measured: right margin 1px, col 3 19px narrower) | ✅ Fixed — subtract container padding; also switched `Dimensions.get()` (captured once in a `[]`-dep `useMemo`, so it never reflowed on rotation) to `useWindowDimensions()` |
| B7 | ✅ **FIXED** — **Silent async failures on FABs** — `onPress={manualSync}` passes a bare async fn, so any throw becomes an unhandled rejection: no toast, no log, no `cancelSelection()`. The button simply appears dead | ✅ Swept: dialog actions now toast on failure; `safeAsync` wrapper applied to all direct handlers |
| B8 | **Pre-existing iOS bug in permissions** — original code passed `{ accessPrivileges: 'all' }` to `getPermissionsAsync`, but that function takes **positional** args `(writeOnly?, granularPermissions?)` and `accessPrivileges` is a *response* field, not a request option. On Android it evaluated to `undefined` and worked by luck; on iOS (`requireFullAccess` defaults `true`) it would pass an object as `writeOnly` and throw `Cannot convert '[object Object]' to a Kotlin type` | ✅ Fixed — positional args; iOS full-access now via `presentPermissionsPickerAsync()` on the response |

### Native-config trap (bites anything native from here on)

This repo has a **committed `android/` directory**, so `app.json` plugin config only applies during `expo prebuild` — which never runs. `granularPermissions: ["photo"]` was sitting in `app.json` being silently ignored while the manifest declared audio access.

**Rule:** native changes must be made in `android/` directly. Runtime-read config (e.g. `userInterfaceStyle`) still works from `app.json`, so the two are not inconsistent — know which kind you are touching.

### Dev auth (Phase 0 workaround)

Device Flow needs a registered OAuth App plus a human entering a browser code on every reinstall. For local dev, `getDevToken()` / `getDevRepo()` in `config.ts` read a fine-grained PAT from gitignored `.env`, both behind `__DEV__` so they compile out of release builds. It never overrides a real signed-in token. **Device Flow still has to be built and tested before shipping** — this only unblocks everything downstream of sign-in.

⚠️ **Metro inlines `EXPO_PUBLIC_*` at bundle time and caches it.** Blanking `.env` does *not* revoke a token from a running app — kill Metro and purge its cache, or the old value keeps serving.

⚠️ **Verifying a fine-grained PAT's scope:** every fine-grained PAT has implicit *read* access to public repos, so a repo appearing in `/user/repos` (or returning 200) proves nothing. Test a **write-gated** endpoint instead — `GET /repos/{o}/{r}/collaborators` returns 200 with push access, 403 without.

---

## Phase 0.5 — Storage spike ✅ **DONE** (2026-09-18)

All four experiments run against the real API on a private repo. Total cost: **13 of 5000** requests.

| # | Experiment | Result |
|---|---|---|
| 0.5.1 | 150 MiB file → release asset on a **private** repo | ✅ **201**, `state: uploaded`, authenticated read-back **byte-identical**. **Tier 2 works.** |
| 0.5.2 | Binary-search the blob-API size ceiling | 🔴 **~35–40 MiB raw, not 100 MiB.** 35 MiB → 201, 40 MiB → **422 "input was too large to process"** |
| 0.5.3 | `Range: bytes=…` on an asset download | ✅ **206**, exact 1000 bytes, byte-match. **Tier 3 viable.** |
| 0.5.4 | ETag `If-None-Match` on a branch ref | ✅ **304** with `x-ratelimit-remaining` unchanged (4999 → 4999). **Free polling.** |

### 🔴 Decision changed by measurement: threshold is 25 MiB, not 50

The documented 100 MiB limit applies to **git push**, not the REST blob API. The real cliff is a **~50 MB request body** — about **37 MiB raw** once base64 adds ~33%.

| Raw | Base64 body | Result |
|---|---|---|
| 25 MiB | 33.3 MiB | ✅ 201 |
| 35 MiB | 46.7 MiB | ✅ 201 |
| **40 MiB** | **53.3 MiB** | ❌ 422 |
| 50 MiB | 66.6 MiB | ❌ 422 |

**Set the tier threshold to 25 MiB** (decision D10 revised). The previously planned 50 MiB would have failed in production — exactly the late-failure mode tiering exists to prevent.

### What this unblocks

- **Phase 3 compression stays cut.** Video routes to tier 2 at original quality; no transcoding.
- **Phase 1A-bis proceeds as designed** — stub pointers, `media-<year>` releases.
- **A7 free polling is real**, so background sync can poll aggressively at zero rate-limit cost.
- **Tier 3 stays deferred but is now proven possible** if the library ever outgrows the repo.

---

## Phase 1 — Storage engine rewrite (4–6 days)

Do this **before** the UI work. It's the part that's actually hard, and the part where a bug costs real photos. Also unblocks everything else — batching is what makes bulk import survivable.

### 1A. Batch commits via Git Data API ✅ **DONE** (2026-09-19)

**Problem:** `githubClient.ts:70` calls `repos.createOrUpdateFileContents` once per file → 1 commit *and* 1+ API request per photo. Uploading 500 photos = 500 commits and ~1,000 requests (of 5,000/hr).

**Fix:** replace with proper git plumbing —

```
createBlob(×N)  →  createTree(base_tree)  →  createCommit  →  updateRef
```

| # | Task |
|---|---|
| 1A.1 | New `src/services/sync/gitPlumbing.ts` — blob/tree/commit/ref helpers |
| 1A.2 | Batch uploader: group queued assets into chunks (~20–50 files or ~50 MB per commit) |
| 1A.3 | Rewrite `putFile` call sites in `sync/index.ts` to use the batch path |
| 1A.4 | Rate-limit governor: read `x-ratelimit-remaining`, back off before exhaustion |
| 1A.5 | Keep single-file path for the meta-index writes (small, frequent) |

**Measured on device — 8 photos uploaded:**

| | Before | After |
|---|---|---|
| Commits | **24** (3 per photo) | **3** total |
| Image requests | ~16 | 13 (8 blobs + 5 overhead) |

```
67a8d0a  Upload 8 items                              <- one batch commit
2e91bd9  Update meta shard 2026-09-19 (8 entries)    <- one bulk meta write
12bd619  Update GitGallery meta manifest
```

Commit count is now **constant per batch** rather than linear per photo. Extrapolated to 500 photos at `UPLOAD_BATCH_SIZE = 40`: ~13 batches → **~39 commits and ~600 requests**, against ~1,500 commits and ~1,000+ requests before.

**The meta index turned out to be the real bottleneck.** After batching the images, 6 photos still produced 12 meta commits, because `upsertMetaEntry` persisted its shard *and* rewrote the manifest on every single call. Added `upsertMetaEntries` (metaIndex.ts): apply all entries in memory, then write each touched shard once and the manifest once. That is what took 8 photos from 18 commits down to 3.

**Safety:** if a batch commit throws, those items simply aren't marked, and the existing per-file loop uploads them individually — slower but still correct. `updateRef` is called **without** force, so a concurrent writer causes a 422 and a retry rather than silently discarding their commits.

### 1A-bis. Tiered routing + stub pointers ✅ **DONE** (2026-09-18)

The core of decision D8/D9. Every upload is routed by size; oversized files go to release assets but **still get a git-tree entry** so the rest of the app never knows the difference.

| # | Task |
|---|---|
| 1A-bis.1 | `src/services/sync/tiering.ts` — size-based router (threshold from spike 0.5.2) |
| 1A-bis.2 | Release-asset uploader: ensure/create `media-<year>` release, upload asset, roll to `-b` near 1000 assets |
| 1A-bis.3 | Write `.ptr` stub blob into the tree at the canonical dated path |
| 1A-bis.4 | **Unified fetcher** — resolves tier 1 (blob) vs tier 2 (asset redirect) behind one interface |
| 1A-bis.5 | Authenticated asset download (signed redirect; no naive `<Image src>`) + local cache |
| 1A-bis.6 | Deletion path: remove stub **and** release asset, atomically enough to avoid orphans |

> **Design rule:** nothing above the fetcher may branch on tier. If a UI component knows what a release asset is, the abstraction has leaked.

**Verified on device with a 72.4 MiB photo** — past both the 25 MiB threshold and the ~37 MiB blob ceiling, so it could not have gone in as a blob:

```
git tree : gitgallery/images/Pictures/big_tier2.jpg.ptr   211 bytes
release  : media-2026  (auto-created)
asset    : 752062fd08e8_big_tier2.jpg   75,924,705 bytes   state=uploaded
```

Stub contents verified correct (`tier`, `release`, `assetId`, `name`, `size`, `contentHash`).

**Memory fix found while building this:** `prepareAsset` read every file into a base64 string before deciding anything. A 150 MB video becomes a ~200 MB JS string and OOMs the app before it ever reaches the network. Tier is now decided from the file size *first*, and tier-2 files stream from disk via `FileSystem.uploadAsync(BINARY_CONTENT)` — never buffered in JS.

**Ordering:** the asset is uploaded *before* the stub, so a crash between them leaves an orphaned asset (invisible, reclaimable) rather than a stub pointing at nothing (a broken entry the UI would try to render).

**Orphan risk:** a stub without its asset (or vice versa) is corruption. Add a repair/verify pass that reconciles stubs against the release asset list.

### 1B. Squash / history compaction ✅ **DONE** (2026-09-19)

**Problem:** only `resetBranchToEmptyCommit()` exists — a full **wipe**, not a compaction.

> **Priority note (revised):** with video routed to tier 2, git now holds only ~400 KB photos. Squashing is **still worth doing but much less urgent and far less risky** than originally scoped. If time is tight, this is the first thing to defer to Phase 5.

| # | Task |
|---|---|
| 1B.1 | `squashHistory()`: read current tree → create fresh orphan commit with same tree → `updateRef(force:true)` |
| 1B.2 | ✅ **DONE** — Settings → *Compact history*, preview-then-confirm. Automatic triggering deliberately not added. |
| 1B.3 | Pre-flight guard: verify tree SHA matches expectations, abort on mismatch |
| 1B.4 | Test on throwaway repo — verify **zero files lost** after squash |

> ⚠️ **Highest-risk task in the project.** Force-push with buggy squash logic = permanent photo loss. Guard rails and a test repo are non-negotiable.

### Results (executed against `gitgallery-test`, 2026-09-19)

```
BEFORE  commits= 22  files=47  tree=a0d5e0f  digest=df5ece3ef31496ed
AFTER   commits=  1  files=47  tree=a0d5e0f  digest=df5ece3ef31496ed
```

✅ tree SHA identical ✅ file count identical ✅ **every blob's path+sha+size identical** ✅ 22 → 1 commit. App verified fully functional afterwards.

### The design choice that makes data loss structurally impossible

**We never build a new tree.** The existing tree SHA is taken as-is and a fresh parentless commit is hung off it, so file content *cannot* drift — only the commit graph above it changes. That removes an entire class of "squash dropped my photos" bugs by construction, rather than by careful coding.

Guards, all verified:

| Guard | Behaviour |
|---|---|
| Already one commit | Refuses (`alreadyCompact`) — confirmed on the second run |
| Zero files | Refuses — will not cement an upstream bug over recoverable history |
| Truncated tree listing | Refuses — file count can't be verified |
| Branch moved mid-operation | Aborts rather than discarding another writer's commits |
| Post-conditions | Re-reads the ref; throws if tree SHA or file count changed |

### 🔴 A real bug the verification caught

The first implementation failed with `422 Tree SHA is not a tree object`. Cause: **`GET /git/trees/{branch}` returns the *commit* SHA in its `sha` field, not the tree's.** Passing that to `createCommit` is invalid.

Had the post-condition checks not been there, this would have been a force-push built on a bad assumption. `readTree` now resolves ref → commit → `commit.tree.sha`.

### UI (verified end-to-end on device)

Settings → **Compact history** previews the real numbers before asking, so the user confirms against facts rather than a generic warning:

> *6 commits will be replaced by a single commit. All 52 files stay exactly as they are — the existing tree is reused, so nothing is re-uploaded and no photo can be lost. Only past versions become unrecoverable.*

Then: **"History compacted: 4 commits to 1. All 55 files verified unchanged."**

Already-compact repos get an explanatory message and a single *Close*, rather than a dead disabled button.

### Three UI bugs caught by testing

1. **"6 commits to 6"** in the success message. GitHub's commit list is briefly **stale immediately after a force-push**, so re-reading returned the pre-squash count. Fixed by reporting `1` from construction — the new commit is parentless, so re-asserting it against an eventually-consistent read adds no safety.
2. **`Invalid prop 'compact' supplied to React.Fragment`** — Paper's `Dialog.Actions` clones its children and injects props, which a Fragment cannot accept. Replaced with a keyed array.
3. **"1 commits"** — pluralization.

### 1C. Size guard + repo sharding foundation (1 day)

| # | Task |
|---|---|
| 1C.1 | ~~Hard guard: reject >95 MB~~ → **superseded by 1A-bis**: oversized files route to tier 2 instead of being rejected |
| 1C.2 | Track cumulative repo size in local state; warn at 1 GB, act at ~4 GB |
| 1C.3 | Schema: allow **multiple repos** (e.g. `gallery-2025`, `gallery-2026`) in app state rather than a single `currentRepo` |
| 1C.4 | Router: capture-year → target repo |
| 1C.5 | Guard against the tree API's **100k entries / 7 MB** truncation — shard before hitting it |

> Even if multi-repo UI ships later, **the data model must support it now** (decision D7). Retrofitting is painful.

---

## Phase 2 — Indexing & timeline data layer (3–4 days)

> ⚠️ **Correction (verified on device, 2026-09-18).** An earlier version of this plan said the date-in-path scheme was "already half-built." **It is not.** Observed actual upload paths:
>
> ```
> gitgallery/images/Pictures/test_1.jpg          <- album-based, NO date
> gitgallery/meta/2026/09/18/meta_dict.json      <- only the META is date-bucketed
> ```
>
> The date-parsing regex in `metaIndex.ts` reads *meta shard* paths, not image paths — that's what the earlier claim was mistakenly inferred from. So everything below is **net-new work**, not completion of something existing.
>
> The current scheme also has a real defect: image filenames carry **no date and no uniqueness**, so they collide across albums and cannot produce a sorted timeline from one tree call.

| # | Task |
|---|---|
| 2.1 | ✅ **DONE** — canonical paths `gitgallery/library/YYYY/MM/DD/HHMMSS_WxH_<id8>.ext` from **real EXIF**, via `pathScheme.ts` + `exifDate.ts` |
| 2.2 | Backfill/repair pass for existing wrongly-named assets |
| 2.3 | Timeline hydration via a **single** `git/trees?recursive=1` call → full sorted file list, zero per-file fetches |
| 2.4 | Persist that listing into SQLite (`localStore`) as the timeline source of truth |
| 2.5 | Keep the JSON meta index only for what paths *can't* encode: GPS, favourite flag, ThumbHash |
| 2.6 | Day/month/year bucket counts computed locally → powers the Immich scrubber |
| 2.7 | 🆕 **Aspect ratio from the filename** → justified grid lays out correctly *before* any image loads (no layout shift) |
| 2.8 | ✅ **DONE** — **ThumbHash** in the index; tiles paint a recognisable blur before any image is fetched |
| 2.9 | 🆕 **Blob-SHA dedup** — compute `SHA1("blob "+size+"\0"+content)` locally; skip upload if known, just add a tree entry |
| 2.10 | 🆕 **Merkle diff sync** — skip any subtree whose SHA matches cache; sync becomes O(changed), not O(library) |
| 2.11 | ✅ **DONE & verified** — `getBranchHead()` does a conditional request; `hasRemoteChanged()` skips the reload when the branch hasn't moved. Confirmed on device: `[sync] remote unchanged (304, free) — skipping reload`, with `x-ratelimit-used` unchanged across two checks plus a full cloud hydrate. A refresh that finds nothing new costs **zero** requests. |

### 2.1 results (verified on device, 2026-09-19)

Nine files, read straight from one `git/trees?recursive=1` call with **zero file fetches**:

```
2019-07-22 07:03:59  800x800
2021-11-05 18:45:10  600x900
2023-04-11 09:12:33  900x600
2026-02-14 21:15:00  1000x562
```

Lexicographic order == chronological order, and aspect ratio is known before any image loads.

**🔴 The bug this exposed.** The first implementation trusted `asset.creationTime` / `getAssetInfoAsync().exif`, and **every photo came back stamped with the upload time** — the exact "backlog import all sorts as today" failure the plan warned about. Root cause: Android MediaStore's `datetaken` was NULL for 3 of 6 test photos despite valid EXIF, so expo fell through to `DATE_ADDED`.

**Fix:** `exifDate.ts` — a ~130-line JPEG APP1/TIFF reader that pulls `DateTimeOriginal` from the file itself. Reads only the **first 64 KB**, so it is cheap even for video, and needs **no `ACCESS_MEDIA_LOCATION`** (a permission we deliberately removed in B4). Verified against 5 real JPEGs spanning 2019–2026 before it ever went near the device.

**Still to do in Phase 2:** a migration/backfill pass — assets uploaded before this fix sit under the legacy `gitgallery/images/<album>/` layout with upload-time dates.

**Why this matters:** the tree call is *one request* for the entire library. That's what makes a 20,000-photo library feel instant and keeps us far under 5,000 req/hr.

**Limitation to remember:** paths give us **ordering only**. Albums map to folders (free), but GPS/map and anything content-based still need the JSON index or are simply out of scope.

### 2.8 results (verified on device, 2026-09-20)

**21–24 bytes per photo** (28–32 base64 chars) — ~640 KB for a 20,000-photo library. Encode 7 ms, decode-to-data-URL 2 ms.

Pipeline: `manipulateAsync` resizes to 64px natively → `jpeg-js` decodes the *tiny* image (decoding a full-size JPEG in JS would cost hundreds of ms) → `rgbaToThumbHash`. Rendering uses `thumbHashToDataURL`, which yields a PNG data URL that `<Image>` takes directly, layered beneath the real thumbnail so there is no empty flash.

The test run produced its own control group: photos uploaded **with** hashes painted recognisable blurs instantly, while photos uploaded **before** the feature sat blank until their thumbnails arrived over the network. Same screen, same moment.

**⏳ Known gap — no backfill.** Assets uploaded before this change have no `thumbHash` and fall back to the shimmer placeholder. A backfill pass would need to re-read each original, which is only practical for assets still on the device.

---

## Phase 3 — Compression pipeline ✅ **DONE** (2026-09-19)

**Problem:** `expo-image-manipulator` is used today *only* for thumbnails (`cloudCache.ts:338`), never before upload.

| # | Task |
|---|---|
| 3.1 | Pre-upload image pipeline: resize longest edge → 2048px (configurable), JPEG q≈80 |
| 3.2 | Settings UI: **Original / High / Balanced / Space-saver** presets |
| 3.3 | Preserve EXIF capture date through manipulation (**easy to lose — verify explicitly**) |
| 3.4 | ~~Video bitrate transcode~~ → **cut.** Video routes to tier 2 at original quality. |
| 3.5 | Only if a file exceeds even 2 GiB: skip with a clear user-facing reason (rare) |
| 3.6 | Show before/after size in the upload UI |
| 3.7 | 🆕 **Thumbnail atlases** — pack a day's 256px thumbs into one sprite sheet; seal the atlas once the day passes so past days never churn |

**Reality check:** photos were always a non-issue (a few hundred KB at 2048px/q80). **The hard part — video transcoding — is now deleted**, since tier 2 takes video at full quality. This phase shrank from 3–5 days to 2–3, and the ugliest quality trade-off in the original plan is gone.

### Results (verified on device)

| Source | Stored | Reduction |
|---|---|---|
| 4032×3024, 9.2 MB | 831 KB | **11.3×** |
| 4000×3000, 9.0 MB | 2048×1536, 831 KB | **11.1×** |

EXIF capture dates survived intact (2022-06-15, 2020-05-01), aspect ratio preserved to 3 decimals (1.333).

**Presets** (`compression.ts`), selectable in Settings → Upload quality: Original / High 3072px·q90 / **Balanced 2048px·q80 (default)** / Space saver 1440px·q70.

### Two ordering decisions that matter

1. **Compress before choosing a tier.** A 30 MB photo that shrinks to 400 KB belongs in tier 1, not a release asset. Tiering now runs on the bytes actually being sent.
2. **Build the path after compression.** First version recorded `4032x3024` for a file stored at 2048px. Aspect ratio was still right so layout worked, but the path is supposed to describe the *stored* asset. Now verified: a 4000×3000 source records `2048x1536`.

### ⚠️ Accepted trade-off: EXIF is stripped

`expo-image-manipulator` re-encodes and drops all metadata, with no supported way to re-inject it. This is tolerable **only** because the capture date is read from the original *before* compression and encoded into the path — the timeline stays correct. **Camera model and GPS are genuinely lost.** Users who care can select `Original`.

### Incidental fix — expected 404s were masking real errors

Octokit logs every non-2xx via `console.error`, and a large share of ours are *expected* "does this file exist yet?" probes. In dev these popped LogBox over the app and buried genuine failures. `getOctokit()` now filters 404s to debug and lets everything else through.

---

## Phase 4 — Immich UI re-skin (7–10 days)

The reason the project exists. Lucky break: **Immich mobile is Material 3 seed-based, and React Native Paper is also MD3** — so the theming maps over rather than needing reinvention.

### 4A. Design tokens — ✅ **DONE** (pulled forward; it was unblocked while auth wasn't)

| # | Task | Status |
|---|---|---|
| 4A.1 | Port Immich's seed palette — light `#4150AF`, dark `#ACCBFA` | ✅ `src/theme/immichTheme.ts` |
| 4A.2 | Build MD3 light/dark schemes in RN Paper from those seeds | ✅ via `@material/material-color-utilities` |
| 4A.3 | Match AppBar + header chrome to `theme_data.dart` | ✅ surface bg, primary centered title, zero elevation |
| 4A.4 | Optional: the other 9 presets | ⏳ Not done — single indigo preset for now |
| 4A.5 | Typography scale (titleLarge 26/w600, titleMedium 18/w600, …) | ⏳ Not done — deferred to 4B/4C |

**Why the palettes match rather than approximate:** RN Paper is MD3 and Flutter's `ColorScheme.fromSeed` is a port of the *same* Material Color Utilities library, so generating from the same seed yields the same tonal palette.

**Two details that matter:** Immich seeds light and dark from **different** brand colors (not one seed with brightness flipped), and the seed algorithm shifts primary to `#4756B5` — so Immich explicitly overrides primary back to the true brand color, and pins `onSurface` to `#221F20` in light. Both replicated.

**Verified by sampling rendered pixels on `emulator-5554`:**

| | Light | Dark |
|---|---|---|
| Button fill | `#4150AF` ✅ | `#ACCBFA` ✅ |
| Surface | `#FFFBFF` ✅ | `#1A1C1E` ✅ |

### 4B. Break up the monolith (2 days)

`GalleryScreen.tsx` is **1,568 lines** — a quarter of the entire codebase in one file. It must be decomposed before it can be re-skinned sanely.

| # | Task |
|---|---|
| 4B.1 | Extract `TimelineGrid`, `AssetTile`, `SelectionBar`, `UploadOverlay`, `DateHeader` |
| 4B.2 | Move data fetching into hooks (`useTimeline`, `useUploadQueue`) |
| 4B.3 | Keep behaviour identical — pure refactor, verified against Phase 0 baseline |

### 4C. Immich-style timeline (3–4 days)

Study `reference/immich/mobile/lib/presentation/widgets/timeline/`:

| # | Task | Immich reference |
|---|---|---|
| 4C.1 | ✅ **DONE** — date-segmented list with sticky month/day headers | `sliver_segmented_list.dart`, `header.widget.dart` |
| 4C.2 | Fast-scroll scrubber with date bubble | `scrubber.widget.dart` |
| 4C.3 | Pinch-to-zoom grid density | `timeline_pinch_zoom.dart` |
| 4C.4 | Drag multi-select | `timeline_drag_selection.dart` |
| 4C.5 | Sticky date headers | `timeline.widget.dart` |

### 4C.1 results (verified on device, 2026-09-19)

Renders as `September` → `Sat, Sep 19, 2026` → `Fri, Sep 18, 2026`, with sticky headers.

Values taken from Immich's source rather than eyeballed:

| | Immich | Ours |
|---|---|---|
| Month header | `labelLarge` @ 24px | 24px, weight 600 |
| Day header | `labelLarge` @ 15px | 15px, `onSurfaceVariant` |
| Header extent | `kTimelineHeaderExtent = 80` | 80 (month) / 44 (day) |
| Columns / spacing | 3 / 2.0 | 3 / 2 |

The month line only renders on the first section of a month, so a long scroll reads `September → Sat 19 → Fri 18 → …` instead of repeating the month.

`SectionList` has no `numColumns`, so `grouping.ts` pre-chunks each day into rows and renders a row as one item. Grouping is a pure function and was unit-tested (bucketing, row chunking, month-boundary detection, year-omission rule) before touching the device.

**🔴 Two bugs this surfaced:**

1. **Fabric mount crash** — `IllegalStateException: addViewAt: failed to insert view` / `IndexOutOfBoundsException: index=16 count=0`. Cause: children produced by `row.map()` had **no `key`**, so the reconciler mis-indexed the row. `removeClippedSubviews` was also disabled — it is unreliable on the new architecture and compounds this.
2. **"Unknown date" bucket** — 9 local photos had no `creationTime` (MediaStore's NULL `datetaken` again, now hitting the *local* grid rather than upload). Grouping now falls back to `modificationTime`; the bucket disappeared. The EXIF fix in 2.1 only runs at upload time, because reading EXIF for every asset during scroll would be far too expensive.

### 4D. Asset viewer + shell (2–3 days)

| # | Task |
|---|---|
| 4D.1 | ✅ **DONE** — full-screen viewer (`components/viewer/AssetViewer.tsx`): opaque black, true aspect ratio, tap-to-toggle chrome, top bar, bottom action bar. ⏳ swipe-between / pinch-zoom still to do |
| 4D.2 | Bottom detail sheet (date, size, dimensions, repo path) |
| 4D.3 | Immich-style bottom nav (Photos / Search / Albums / Library) |
| 4D.4 | Re-skin `SettingsScreen.tsx` (608 LOC) to match |
| 4D.5 | Empty states, loading skeletons, upload progress |

### 4D.1 results (verified on device, 2026-09-19)

Replaced 142 lines of inline modal JSX with a dedicated component. What the old one got wrong — all visible on device:

| Defect | Fix |
|---|---|
| Translucent backdrop, grid showing through | Opaque `#000` |
| **Hardcoded `aspectRatio: 3/4`** — every image letterboxed to the wrong shape | Image sized to the window, `resizeMode="contain"` |
| Horizontal padding stopped it filling | Edge-to-edge |
| Actions as outlined buttons floating mid-screen | Bottom action bar, icon + label |
| Stray source label in the corner | Removed |
| **Caption showed file mtime** — a 2026-02-14 photo captioned "Sep 19" | Prefers the EXIF-derived `createdAt` from the meta index, falling back to the canonical path |

Verified: caption read "Sat, Sep 19, 2026 · 14:30" against an image whose own EXIF label was `2026:09:19 14:30:22` — exact match. Destructive actions render red, normal actions white.

### B7 — silent async failures (swept)

`onPress={async () => …}` discards the returned promise, so a throw became an unhandled rejection with no toast, no log and no state change. This is why the upload button looked dead through three debugging rounds.

- Dialog actions were caught but only `console.error`'d — a **failed delete looked identical to a successful one**. They now surface a toast.
- Added a `safeAsync(label, fn)` wrapper and applied it to the remaining direct handlers. No unwrapped `onPress={async …}` remains in `GalleryScreen.tsx`.

---

## Phase 4E — Video, swipe, storage awareness ✅ **DONE** (2026-09-20)

Prompted by a blunt question — *do the remaining items actually add anything for a user?* — which exposed that the backlog was skewed toward engineering. Re-ranked by user value, and the top item turned out to be something not on the list at all.

### 🔴 Videos were invisible

`GalleryScreen` queried `mediaType: ['photo']` and there was no player anywhere. **A user could not see, select, upload or watch a single video** — while the entire tier-2 system (release assets, 2 GiB ceiling, stub pointers, the 72 MiB test) existed to serve exactly that.

Fixed: all three media queries now include video; tiles show a play icon + duration badge; `expo-video` powers playback in the viewer.

Verified on device — badge read `0:06`, playback ran to completion, and upload produced a canonical path:
```
gitgallery/library/2026/09/20/144233_640x480_af2386f2.mp4   39 KB
```

**A layout bug testing caught:** the player's native transport controls collided with our bottom action bar, squeezing the labels. For video the actions now move into the top bar and the player owns the bottom.

### Viewer swipe

Horizontal pager over the timeline-ordered list, so swiping follows the same order as the grid. Only the visible page mounts a player — otherwise every video in the list would spin up a decoder.

### Storage awareness (1C)

Settings → *Storage used* reports live size and warns before GitHub's limits. Thresholds verified by test; at ~400 KB/photo:

| Limit | Photos |
|---|---|
| 1 GB ("ideally under") | **2,622** |
| 5 GB ("strongly recommended under") | **13,108** |

That first number is reachable for a real camera roll, which is why this warns rather than staying silent. GitHub's own reported size is also checked, so history counts — not just the current tree.

---

## Phase 4F — Favourites & albums ✅ **DONE** (2026-09-20)

The two MEDIUM user-value items. Both verified end-to-end on device.

### Favourites

Heart action in the viewer, heart badge on tiles, and a filter toggle in the header. Verified: favouriting flipped the action label to "Favourited", the badge appeared on the tile, and the filter reduced the grid to just that photo.

### Albums

New **Albums** tab (third alongside Gallery and Settings), create/delete with confirmation, "Add to album" from the viewer, and a dismissible filter banner in the gallery. Verified: created "Goa Trip" from the viewer, Albums tab showed *"Goa Trip · 1 item"*, tapping it filtered the timeline to that one asset.

### Storage decision — local, not synced

Both are stored device-locally in SecureStore rather than written to the repo.

**Why:** a heart tap should be instant and work offline. Syncing would mean a git commit per tap, which is absurd for a toggle. **The cost is real and worth stating plainly: favourites and albums do not follow you to another device.** If multi-device becomes a goal, the fix is to fold them into the meta index and flush them with the existing batch — the same trick that took meta writes from 2 commits per photo to 2 per batch.

### Naming trap avoided

`selectedAlbumIds` already existed and means *device* albums (Camera, Pictures) used to decide what to sync. User-created albums are a different concept, so they live in `userAlbums` and the UI never says just "albums" where the two could be confused.

### 🔴 A bug testing caught

"Add to album" did nothing from the viewer. Cause: **Paper's `Portal` renders behind a React Native `Modal`**, and the viewer *is* a Modal — so the dialog opened invisibly underneath it. Fixed by closing the viewer before opening the picker.

---

## Phase 6 — iOS 🚧 **IN PROGRESS** (2026-09-20)

### ⚠️ SPM is not possible on this stack

Requested, but not achievable. Measured in `node_modules`:

| | Count |
|---|---|
| `.podspec` | **104** |
| `Package.swift` | **1** (an internal RN shim, not app-consumable) |

React Native itself, `expo-modules-core`, and all five Expo modules we use ship podspecs only. `expo prebuild --help` offers exactly one relevant flag — *"Skip installing npm packages and CocoaPods"* — there is no SPM path in the toolchain. Proceeding with CocoaPods (1.17.0, installed under rbenv 3.4.5; the `/usr/local/bin/pod` shim was broken, pointing at system Ruby 2.6).

### 🔒 Android protection

`android/` is fingerprinted before and after every native operation. `expo prebuild --platform ios` verified non-destructive:

```
BEFORE 26398f596b65956b5c8201bf8ffc0cde4d1bb9f4
AFTER  26398f596b65956b5c8201bf8ffc0cde4d1bb9f4
```

### 🔴 First iOS bug found before a single line ran

The generated `Info.plist` requests **`NSCameraUsageDescription`** and **`NSMicrophoneUsageDescription`**. On iOS that is worse than the Android equivalent: users are prompted for *microphone* access by a photo gallery, and App Store review flags unused permission strings.

Root cause is the same as Android's B4 — `expo-image-picker`'s config plugin. But the real finding is that **`expo-image-picker` is declared in `package.json` and never imported anywhere in `src/`.** It is dead weight that was quietly adding camera and microphone permissions to both platforms.

Removing the dependency fixes the cause on both platforms, rather than stripping symptoms per-platform as the Android fix did.

**Verified by a clean regeneration**, not a hand-edit — `prebuild --clean` rebuilt `Info.plist` from scratch after the dependency was gone:

| Key | Before | After |
|---|---|---|
| `NSCameraUsageDescription` | present | **gone** |
| `NSMicrophoneUsageDescription` | present | **gone** |
| `NSPhotoLibrary*UsageDescription` | present | retained |

**Android benefited too.** The rebuilt APK now declares no camera, no microphone and no audio-library access without relying on the `tools:node="remove"` suppressions, which stay only as defence-in-depth:

```
INTERNET · READ_MEDIA_IMAGES · READ_MEDIA_VIDEO · READ_MEDIA_VISUAL_USER_SELECTED
READ/WRITE_EXTERNAL_STORAGE · ACCESS_NETWORK_STATE · VIBRATE · USE_BIOMETRIC · SYSTEM_ALERT_WINDOW
```

This was a latent flaw in the *original* project: an unused dependency quietly requesting camera and microphone on both platforms. It only surfaced because generating the iOS project forced the question.

### Build result

**iOS built successfully on the first attempt — 0 errors, 1 warning** (a benign Hermes script-phase notice). 100 pods. The feared cascade of native breakage did not materialise.

### Android regression after the shared change

Required by the project rule that Android must not change. After removing the dependency:

- `android/` fingerprint unchanged: `26398f596b65956b5c8201bf8ffc0cde4d1bb9f4`
- Gradle `BUILD SUCCESSFUL`
- UI verified on device: Local · Cloud · September · Gallery · Albums · Settings, **0 crashes**

### Getting the app to actually render

The build succeeding was not the same as the app running. It came up white, and Metro's log showed the iOS bundle restarting at 0% indefinitely. `expo export --platform ios` produced a **3.93 MB Hermes bundle in a single pass**, which ruled out the JS graph and pointed at stale dev-server state; a clean Metro restart then served the dev bundle in **4.6 s**.

### Driving the simulator

There is no `adb` for the simulator, so flows were exercised through a small harness: Quartz `CGWindowListCopyWindowInfo` for the window rect, `cliclick` for pointer/key events, `simctl io screenshot` for readback.

One trap worth recording: the first mapping did its arithmetic in `bc` at `scale=1`, where `89/1179` truncates to `0.0`. Every tap therefore landed on the screen's left edge. Two taps *appeared* to succeed — the first grid thumbnail sits at the left edge, and tapping outside the dev menu dismisses it — which is exactly how a broken harness manufactures false confidence. Redone in float.

### Bugs found by the iOS test pass

| # | Bug | Root cause | Affects |
|---|---|---|---|
| D1 | Month header text clipped, descenders cut | Paper's `labelLarge` fixes `lineHeight: 20`; we overrode `fontSize` to 24 and not the line height. Flutter derives line height from font metrics, so Immich never hits it — a porting artifact | iOS visible, both fixed |
| D2 | Every device album named `L0`, then `100APPLE` | `deriveNameFromUri` is an Android folder-name heuristic; iOS uris are `ph://<uuid>/L0/001` and the disk path is a DCIM bucket. Now gated to Android, iOS uses `album.title` ("Recents", "Recently Saved") | iOS |
| D3 | Dark mode accents were MD3 baseline purple | `#6750A4` hardcoded as dark primary/primaryContainer in `GalleryScreen` and `SettingsScreen`, inherited from fork base `cc9a4ba` and missed by the Immich theme port. Now read from the scheme (`#004883`) | **both** |
| D4 | Favourite badge rendered under the selection tick | Both at `left: 6, top: 6`. Favourite moved to top-right — bottom-left is the video duration, bottom-right the uploaded cloud | **both** |
| D5 | Limited photo access showed an empty gallery | Under limited access PhotoKit exposes no dependable album, so a saved album filter matched nothing and `loadPage` bailed with `[]`. User grants 2 photos, sees none. Album filtering is now skipped in that mode | iOS |
| D6 | Limited access re-presented the picker every launch | `ensureMediaLibraryPermissions` auto-called `presentPermissionsPickerAsync()` whenever `accessPrivileges !== 'all'`, so a limited user could never reach the app. Now user-initiated only, `PHPhotoLibraryPreventAutomaticLimitedAccessAlert` suppresses the system alert, and a Settings row owns the route back to the picker | iOS |

D3 and D4 are pre-existing defects that were shipping on Android; the iOS pass is what surfaced them.

### Multi-select re-test (after granting the terminal Accessibility permission)

The earlier pass drove the simulator with `cliclick` lacking Accessibility, so anything needing precise taps or typing was suspect. With the permission granted, multi-select was re-run end to end.

Working already: long-press enters selection, taps add items, ticks render, selection spans date sections, Select All and cancel both work.

| # | Bug | Root cause | Affects |
|---|---|---|---|
| D7 | No selection count anywhere in multi-select — no way to know how many items were selected | Never rendered; the bar had only "Select All" and close. Fixed with an `N selected` chip **stacked above** the buttons, since an inline count like "100 selected" would collide with the FABs opposite | **both** |
| D8 | Last row unusable in selection mode — tick hidden and the tile untappable, the floating controls swallowed the touch | `contentContainerStyle` was `{ padding: SPACING, flexGrow: 1 }` with no bottom padding, while the Select All bar and FABs are `position: absolute, bottom: 16`. Fixed with dynamic bottom padding (88 normally, 168 in selection mode where a second FAB appears) | **both** |

**Two findings I initially got wrong, corrected by measurement rather than inspection:**

- *"The timeline does not scroll."* It does. Instrumenting the list gave frame **590pt** against content **2201pt**, and `onScroll` fired on drag. The early failed drags happened while content was still growing as thumbnails resolved (683 → 1313 → 1948 → 2201).
- *"Some tiles render collapsed."* One tile painted 84px tall instead of 374. But `onLayout` reported `tile=125x125 size=125` for every tile, and scrolling the item out of view and back painted it as a full 374 square. A transient first-paint artifact, not a layout or data bug.

Both were caught only because the layout was instrumented instead of eyeballed — a screenshot alone would have left two phantom bugs in this document.

### Verified on iOS

Timeline grouping and headers · viewer (opaque black, true aspect ratio, swipe pager) · video playback (frame-diff confirmed: 4.7% of pixels changed between samples, diff bbox exactly the video region) · favourites · albums create/filter/delete · Settings including upload-quality and appearance · Cloud tab reading the shared GitHub library · **upload end-to-end**, landing three commits in `labmember003/gitgallery-test` (blob, meta shard, manifest).

---

## Phase 5 — Polish & platform (3–5 days)

| # | Task |
|---|---|
| 5.1 | **iOS validation** (if deferred from Phase 0) — build, sign, test on device |
| 5.2 | Albums as folders (`library/albums/<name>/`) with Immich album UI |
| 5.3 | Date-range filter / "On this day" (cheap — we already have dates in paths) |
| 5.4 | Background sync reliability pass |
| 5.5 | Multi-repo sharding UI (surfacing the Phase 1C model) |
| 5.6 | App icon, splash, naming |
| 5.7 | EAS build config for release artifacts |

---

## Timeline summary

| Phase | Work | Estimate |
|---|---|---|
| 0 | Baseline running | ½–1 day |
| **0.5** | **Storage spike** 🔴 | **½–1 day** |
| 1 | Storage engine (batch, **tiering+stubs**, squash, sharding) | 6–9 days |
| 2 | Indexing & timeline data (+ThumbHash, dedup, Merkle) | 5–7 days |
| 3 | Compression (photos only) ⬇️ | 2–3 days |
| 4 | Immich UI re-skin | 7–10 days |
| 5 | Polish & platform | 3–5 days |
| | **Total** | **~24–36 days (4–6 weeks)** |
| 6 | *(stretch)* on-device ML search & faces | +1–2 weeks |

**Why it grew slightly:** tiering and stub pointers add real work to Phase 1, and Phase 2 absorbed four new optimizations. Phase 3 shrank. The net is ~3 days more for a **materially better product** — full-quality video, an instant timeline, free dedup, and O(changed) sync.

Sequencing note: Phase 4 is the biggest chunk but also the most parallelizable and the most *visible*. If motivation flags during storage work, 4A (tokens) is a cheap, satisfying win that can be pulled forward.

---

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| **GitHub Acceptable Use / account action** | 🔴 Critical | GitHub's docs say *"Git is not designed to serve as a backup tool"*; oversized repos draw Support intervention. Keep to personal scale, shard, and **never make this the only copy of your photos.** |
| **Force-push squash loses photos** | 🔴 Critical | Throwaway repo testing, pre-flight tree verification, manual trigger first. *Reduced:* git now holds only small photos. |
| **Stub/asset orphaning** 🆕 | 🟠 High | A `.ptr` without its asset is corruption — reconcile pass in 1A-bis.6 |
| Tier 2 doesn't work on private repos | 🟠 High | **Spike 0.5.1 answers this before any code.** If it fails, video compression returns and Phase 3 doubles. |
| iOS never validated upstream | 🟠 High | Budget extra time in Phase 0; Android-first fallback |
| Blob size ceiling lower than expected | 🟡 Medium | **Spike 0.5.2** sets the threshold empirically; start at 50 MiB |
| GitHub rate limit under bulk import | 🟡 Medium | Batch commits + rate-limit governor + tree indexing + free 304 polling |
| Repo size ceiling on a real library | 🟡 Medium | Sharding at 1C; tree API truncation guard at 1C.5 |
| EXIF date lost during compression | 🟡 Medium | Explicit test in 3.3 — silently breaks the whole timeline if missed |
| **GitGalleryApp has no LICENSE** | 🟡 Medium (legal) | Fine privately; resolve before publishing (see project doc §4) |
| On-device ML too slow/large | 🟢 Low | Phase 6 stretch only; incremental background embedding |
| Upstream is 10 months stale | 🟢 Low | We're forking anyway; Expo 54 is recent enough |

---

## Definition of done (v1)

- [ ] Signs in with GitHub Device Flow
- [ ] Uploads a 1,000-photo camera roll without hitting rate limits
- [ ] **A 500 MB video uploads at original quality and plays back** (tier 2 working end-to-end)
- [ ] **No file is ever rejected for size** — it routes to the right tier instead
- [ ] **Timeline renders instantly from one API call** via ThumbHash, with no layout shift
- [ ] Timeline loads in <2s from a warm cache, correctly date-grouped
- [ ] **Re-uploading an existing photo transfers zero bytes** (blob-SHA dedup)
- [ ] **An unchanged library syncs at zero rate-limit cost** (304 polling)
- [ ] Squash keeps repo history compact with zero file loss
- [ ] Visually reads as "an Immich-quality app," not a stock RN Paper app
- [ ] Runs on both Android and iOS
- [ ] Survives airplane mode → reconnect without losing queued uploads

---

## Open questions

1. **App name** — "GitGallery" is inherited from upstream. Rename before publishing?
2. **Publish or personal?** Drives urgency of the licensing question.
3. **Originals or compressed-only?** Optionally keep originals on-device and only compress the cloud copy.
4. **Sharding trigger** — per year, or per size threshold?
5. **Is iOS a must-have for v1**, or is Android-first acceptable?
6. 🆕 **Should photos have a tier-2 escape too?** e.g. keep full-resolution originals as release assets while git holds the 2048px version — best of both, at double the storage.
7. 🆕 **One release per year, or per month?** Year is simpler; month keeps asset lists shorter.
