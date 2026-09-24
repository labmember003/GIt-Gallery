# GitGallery — Project Document

> **Working name:** GitGallery
> **One line:** A photo/video gallery app that stores your library in *your own private GitHub repo*, with an Immich-quality UI.
> **Status:** Built and self-tested on **both** platforms. Android feature-complete for v1; iOS builds via CocoaPods and passes the same flow-for-flow test pass (2026-09-20).
> **Last updated:** 2026-09-17

---

## 1. Why this project exists

The starting question was: *"Immich is great, can I just point it at GitHub instead of running a server?"*

After digging into both codebases, the answer is **no — not by modifying Immich**, but **yes — by building on GitGalleryApp and borrowing Immich's UI**. This document records why, so the decision doesn't get re-litigated later.

### The goal

- Store photos/videos in a **private GitHub repo** (free tier), not a self-hosted server, not Google Photos.
- **No infrastructure to run.** No Postgres, no Docker, no VPS, no electricity bill.
- **Immich-grade UI/UX** — because Immich's interface is genuinely excellent and is the reason we started here.
- Ship on **Android + iOS**.

### The non-goal

Feature parity with Immich. We are explicitly trading away the features that require a real backend (see §5).

---

## 2. Why *not* refactor Immich

Immich's architecture is:

| Layer | Technology |
|---|---|
| Server / API | TypeScript, NestJS |
| Database | PostgreSQL + **pgvector** (ML embeddings) |
| Job queues | Redis / BullMQ |
| Object storage | Local FS or S3 |
| ML service | Python (face detection, CLIP embeddings) |
| Mobile | Flutter / Dart |
| Web | Svelte / SvelteKit |

The mistake that's easy to make is thinking of this as *"UI + auth + storage"*, where you swap the last two and keep the first. In reality **every screen is wired to a backend capability**, and that wiring — not the widgets — is the bulk of the code.

**The concrete example that makes it click — the main timeline:**

- **Immich today:** you scroll → app asks the server *"give me assets 500–550, sorted by capture date, grouped into day buckets."* Postgres answers instantly via an indexed query. That's what a database is for.
- **With GitHub as backend:** there is no query engine. A git repo cannot answer that question. The only way to render that screen is to pull a metadata index, load it into a **local SQLite DB on the device**, and reimplement pagination / sorting / grouping client-side.

That's not a hack — it's the *only* way, and it's precisely why GitGalleryApp already maintains a local cache + sharded index (verified in its source, see §4).

So "keep Immich's UI" would still mean **rewriting the entire data layer beneath every screen**: timeline, search, albums, sharing, faces. The UI is roughly 20% of the effort; the data/state layer that knows how to fetch, cache, paginate and search is the other 80% — and that is exactly the part that has to be thrown away.

**Verdict:** forking Immich = months of work, most of it deleting things. Forking GitGalleryApp = weeks, most of it building things. We fork GitGalleryApp.

---

## 3. Hard constraints of a GitHub-as-storage backend

These are physics, not opinions. Every design decision downstream is shaped by them.

| Constraint | Value | Consequence |
|---|---|---|
| REST API rate limit | 5,000 req/hour (authenticated user) | Cannot do per-file API calls at camera-roll scale. Must batch. **304s are free** — see below. |
| Single file size (git blob) | 100 MiB hard cap | Oversized files route to **release assets** instead. |
| Release asset size | **2 GiB/file, 1000/release, no total size or bandwidth limit** | This is the escape hatch for video. |
| Recommended repo size | ~1 GB ideal, <5 GB strongly recommended | A lifetime library needs **sharding across repos**. |
| Query capability | **None** | All indexing/sorting/search must be client-side. |
| Git history | Every version of every binary retained forever | Needs a squash strategy (less urgent once video leaves git). |
| Tree API (recursive) | Truncates at 100,000 entries / 7 MB | Reinforces year-sharding. |
| ML / vector search | Not possible **server-side** | Deferred to **on-device** ML, not abandoned. |

> Full detail and verification for everything below lives in **[BIG-BRAIN-IDEAS.md](./BIG-BRAIN-IDEAS.md)**.

### 3.1 Storage tiering — the core architectural decision

Rather than forcing everything through git, **route each file by size**:

| Tier | What | Stored where | Notes |
|---|---|---|---|
| **1** | Photos + small video (**under threshold**) | git blobs | ~95% of files by count |
| **2** | Oversized video / RAW | **release assets** | ~5% by count, most of the bytes |
| **3** | *(deferred)* sealed monthly packs | release assets | Only if the library outgrows the repo |

**Threshold: 25 MiB** — measured, not assumed. The blob API rejects ~40 MiB raw (422); the real limit is a ~50 MB request body ≈ 37 MiB raw after base64. The documented 100 MiB applies to git push, not this API.

**Does tier 3 ever trigger?** A 2048px q80 photo is ~400 KB → year-sharded at ~2,000 photos/year ≈ **800 MB/repo**, inside GitHub's ideal. For a normal library tier 3 never fires.

### 3.2 Stub pointers — how tier-2 files keep their folder and date

Release assets have a **flat namespace**, which would destroy the path-encoding scheme. The fix: **every tier-2 file still gets a real git-tree entry at its correct path**, holding a ~200-byte pointer instead of the bytes.

```
library/2026/09/17/143022_3840x2160_62s_a1b2c3.mp4.ptr   ← in git
    → { "tier": 2, "release": "media-2026", "assetId": 184203941, "size": 524288000 }
```

This is the **Git LFS pattern** — pointer in the tree, bytes elsewhere. Consequences:

- One tree call still returns **every asset**, both tiers, correctly dated and ordered
- Albums, dedup, and Merkle sync operate on the stub and **don't care about tier**
- **Release assets never need enumerating** (which would cost ~200 requests)

**Tier is an implementation detail below the fetcher. Every layer above sees one uniform library.**

### 3.3 Other mitigations

1. **No query engine → the path and filename carry the metadata.** Store at `library/YYYY/MM/DD/HHMMSS_WxH_<hash>.jpg` from the **EXIF capture date, not upload time** (a backlog import would otherwise all sort as "today"). One `git/trees?recursive=1` call then yields ordering, **aspect ratio for instant grid layout**, and a dedup key — with zero per-file fetches.
2. **Compression is now photo-only.** Resize to ~2048px + JPEG q≈80 → a few hundred KB. **Video no longer needs transcoding** — it routes to tier 2 at original quality. This removes the ugliest trade-off in the original plan.
3. **History bloat → squash + force-push**, over 400 KB photos rather than multi-GB videos: still worth doing, far less urgent, far less risky. Squashing removes *superseded* versions but doesn't shrink the live set — sharding is the real ceiling fix.
4. **Free change detection.** `304 Not Modified` responses **don't count against the rate limit** (documented). ETag-poll the branch ref for free, then Merkle-diff only when the SHA moves.

---

## 4. What GitGalleryApp actually is (verified from source)

Cloned at `reference/GitGalleryApp` — commit `b27971c`, last activity **2025-11-05** (~10 months stale).

**Stack:** Expo SDK 54 · React Native 0.81 · React 19 · TypeScript · Zustand (state) · React Native Paper (UI) · Octokit (GitHub API) · expo-sqlite (local cache) · expo-media-library.

**Size:** ~6,250 LOC across 24 files in `src/`. Small enough to fully understand and aggressively refactor.

| File | LOC | Role |
|---|---|---|
| `src/screens/GalleryScreen.tsx` | 1,568 | **Monolith.** The whole gallery UI. Primary refactor target. |
| `src/services/sync/index.ts` | 977 | Sync orchestration |
| `src/services/sync/metaIndex.ts` | 748 | Sharded metadata index |
| `src/screens/SettingsScreen.tsx` | 608 | Settings |
| `src/services/sync/cloudCache.ts` | 508 | Local preview cache (400 MB cap) |
| `src/services/localStore/index.ts` | 470 | SQLite local store |
| `src/services/sync/githubClient.ts` | 179 | Octokit wrapper |
| `src/services/auth.ts` | 65 | GitHub Device Flow OAuth |

### What it already does well (keep these)

- **GitHub Device Flow auth** — no manual token pasting. Reusable as-is.
- **Date-bucketed *meta* index** — meta shards are stored by date (`gitgallery/meta/manifest.json` + `gitgallery/meta/YYYY/MM/DD/meta_dict.json`). Verified on device.
- **Local SQLite cache + preview generation** — `cloudCache.ts` already resizes/compresses for thumbnails via `expo-image-manipulator`.
- **Resumable job queue, offline queue, conflict detection.**

### What's missing or wrong (our work)

| Gap | Evidence | Impact |
|---|---|---|
| **One commit per file** | `githubClient.ts:70` uses `repos.createOrUpdateFileContents` — no `createTree`/`createBlob` batching anywhere | History bloat + burns rate limit (1 req/file) |
| **No squash strategy** | Only `resetBranchToEmptyCommit()` exists — that's a full **wipe**, not a squash | Repo grows unbounded |
| **No pre-upload compression** | `manipulateAsync` used only in `cloudCache.ts:338` for *previews* | 100 MB failures on video/RAW |
| **No file-size guard** | Only `CACHE_SIZE_LIMIT_BYTES` (local cache) exists | Uploads fail late instead of being caught early |
| **No repo sharding** | Single `currentRepo` in state | Hits GitHub repo size ceiling eventually |
| **Android-only in practice** | iOS "planned" per README | ✅ Resolved — iOS built and tested 2026-09-20 |
| **UI is functional, not beautiful** | RN Paper defaults | This is the whole reason we're here |

### ⚠️ Legal note

**GitGalleryApp has no LICENSE file.** Under default copyright that means no granted rights to fork, modify, or redistribute. Fine for private personal use and learning; **must be resolved before publishing anything** — either ask the author for a license, or reimplement from scratch using it only as reference. Immich is AGPL-3.0, which is permissive enough to *learn from* but note AGPL is strongly copyleft if code is copied directly.

---

## 5. Feature scope

### ✅ In scope (v1)

- GitHub Device Flow sign-in
- Private repo setup / selection
- Local device gallery + cloud (repo-backed) gallery
- Upload with pre-compression, resumable queue, offline support
- Immich-style timeline: date-grouped, scrubber, multi-select
- Albums (map naturally to folders — git gives this for free)
- Delete / restore
- Light + dark theme matching Immich
- Immich-style asset viewer (swipe, zoom, detail sheet)

- **Video at original quality** — routed to tier 2, no transcoding (was previously a compromise; tiering fixed it)

### ⚠️ Compromised / best-effort

- **Sharing** — GitHub private repos have no granular share model; best we can do is repo collaborator access or generating a public link to a *copy*
- **Multi-user** — effectively single-user per repo
- **Library size** — needs repo sharding to scale past a few GB

### 🔬 Deferred stretch (Phase 6 — possible, not v1)

- **Semantic search** — via **on-device** MobileCLIP embeddings stored in the index (~512 B/photo quantized). Search is local vector math.
- **Face detection & clustering** — free on-device via Android ML Kit / iOS Vision.
- **OCR / text-in-image search** — same on-device route.

> These were originally marked impossible. That was wrong: GitHub can't do the ML, but **the phone can**. Cost is upload-time compute and app size, not infrastructure. See BIG-BRAIN-IDEAS §S2.

### ❌ Out of scope (accepted)

- Server-side ML of any kind
- Map view *(only if GPS is stored in the index — filenames can't carry it)*
- Live server-side transcoding
- Web app (mobile-first; Immich's web UI stays as reference only)

---

## 6. Design system — borrowing Immich's look

Immich's mobile theme lives at `reference/immich/mobile/lib/theme/` and is **Material 3 seed-based**, which maps cleanly onto React Native Paper (also MD3). This is lucky — the re-skin is mostly tokens, not a rewrite.

**Brand seed colors** (from `mobile/lib/constants/colors.dart`):

```
immichBrandColorLight = #4150AF   (indigo)
immichBrandColorDark  = #ACCBFA   (light blue)
```

Immich ships 10 selectable presets (indigo, deepPurple, pink, red, orange, yellow, lime, green, cyan, slateGray), each generated via `ColorScheme.fromSeed()`. We replicate indigo as default and optionally the rest.

**Key UI references to study:**

| What | Path in `reference/immich/` |
|---|---|
| Theme / color scheme | `mobile/lib/theme/color_scheme.dart`, `theme_data.dart` |
| Timeline widget + segments | `mobile/lib/presentation/widgets/timeline/` |
| Fast-scroll scrubber | `mobile/lib/presentation/widgets/timeline/scrubber.widget.dart` |
| Segmented grid list | `mobile/lib/presentation/widgets/timeline/sliver_segmented_list.dart` |
| Drag-select | `mobile/lib/presentation/widgets/timeline/timeline_drag_selection.dart` |
| Pinch-to-zoom grid density | `mobile/lib/presentation/widgets/timeline/timeline_pinch_zoom.dart` |

> Note: Immich mobile is **Flutter**, we are **React Native**. We are copying *design and interaction patterns*, not code. (Also worth knowing: Immich mobile is **not** Kotlin Multiplatform — the Kotlin/Swift in that repo is thin native glue only.)

---

## 7. Target platforms

| Platform | Status | Notes |
|---|---|---|
| Android | Primary | Feature-complete for v1; verified on emulator |
| iOS | Supported | Builds (CocoaPods, 100 pods, 0 errors) and verified on simulator: timeline, viewer, video, favourites, albums, settings, cloud read, upload end-to-end. Limited-photo-access mode explicitly handled |
| Web | Out of scope | Expo web exists but untested; Immich web is reference only |
| Desktop | Out of scope | Immich itself has no desktop app either |

---

## 8. Development environment (verified on this machine)

**Hardware:** Apple M3 Pro · 36 GB RAM · macOS 26.5.1 · 57 GB free disk — comfortably sufficient.

| Tool | Status |
|---|---|
| Xcode 26.6 | ✅ installed — iOS builds ready |
| Android Studio + SDK | ✅ installed (build-tools, emulator, cmake) |
| Node v22.15.0 | ✅ |
| pnpm 10.29.2 | ✅ |
| Docker 28.4 (OrbStack) | ✅ (not needed for this project) |
| git 2.50.1 | ✅ |
| **Flutter** | ❌ not installed — **only needed if we ever run Immich's app for UI reference** |
| **mise** | ❌ not installed — not needed |

Since we're building in React Native/Expo, **no new tooling is strictly required.** Flutter is optional (only to run Immich side-by-side for visual comparison).

Budget ~5–10 GB over time for emulator images, Xcode caches, node_modules.

---

## 9. Repo layout of this workspace

```
GIt-Gallery/                       ← the git repo root
├── README.md                      ← start here
├── CLAUDE.md                      ← working rules for Claude Code
├── app/                           ← the Expo app — this is what ships
│   ├── src/ · ios/ · android/
│   └── .env                       ← gitignored: dev PAT + OAuth client ID
├── docs/
│   ├── PROJECT-DOC.md             ← this file (what & why)
│   ├── IMPLEMENTATION-PLAN.md     ← how & when
│   ├── BIG-BRAIN-IDEAS.md         ← the tricks that make GitHub behave like a backend
│   ├── CHAT-LOG.md                ← full origin conversation
│   └── REGRESSION-*.md            ← per-platform test passes
└── reference/                     ← gitignored, local only
    ├── GitGalleryApp/             ← 2.9 MB · fork base — same as the `upstream` remote
    └── immich/                    ← 162 MB · AGPL, UI reference only, never vendored
```

`reference/` is excluded on purpose: `immich` is a 162 MB AGPL-3.0 third-party tree kept as a
*visual* reference, and `GitGalleryApp` is already reachable via `git fetch upstream`. Both are
recreatable — the commands are in the root `.gitignore`.

**Remotes:**

| Remote | URL | Note |
|---|---|---|
| `origin` | `git@github-personal:labmember003/GIt-Gallery.git` | **Use the `github-personal` host alias** — plain `git@github.com` resolves to the *work* SSH identity on this machine |
| `upstream` | `ssh://git@github.com/Sumit189/GitGalleryApp.git` | fork source, read-only |

Commits must carry the personal identity (`Avishisht Gupta <avishishtgupta@gmail.com>`); it is set
per-repo because the machine's global config is the work email.

---

## 10. Key decisions log

| # | Decision | Rationale |
|---|---|---|
| D1 | Build on GitGalleryApp, not Immich | Immich's value is its backend+UI pairing; swapping the backend destroys 80% of the code. GitGalleryApp is 6k LOC and already GitHub-native. |
| D2 | Copy Immich's *design*, not its code | Different framework (Flutter vs RN); also avoids AGPL entanglement. |
| D3 | Path encodes capture date | Turns "sort the timeline" into a single tree API call, no per-file fetches, rate-limit friendly. |
| D4 | Batch commits via Git Data API + periodic squash | Fixes both history bloat and the 1-request-per-file rate limit problem in one change. |
| D5 | Compress **photos only** before upload | Keeps tier 1 small. Video no longer needs it (see D8). |
| D6 | ~~Drop ML search & faces~~ → **defer to on-device** | *Revised.* GitHub can't do ML, but the phone can. Not v1, but not impossible. |
| D7 | Design repo sharding in from day one | Retrofitting a multi-repo model later is painful. |
| D8 | **Tier storage by file size** (git / release assets) | Release assets allow 2 GiB with no total-size limit and don't touch git history — this kills the 100 MB cap *and* video transcoding. Putting *everything* in releases was rejected: 1000-assets-per-release, flat namespace, and losing the tree stack. |
| D9 | **Stub pointers in git for tier-2 files** | Preserves path/date/dimension encoding and keeps albums, dedup and Merkle sync tier-agnostic. Same pattern Git LFS uses. |
| D10 | Tier threshold is **25 MiB** (measured, 2026-09-18) | The blob API's real cliff is a ~50 MB request body ≈ **37 MiB raw** after base64 — *not* the documented 100 MiB, which applies to git push. 35 MiB→201, 40 MiB→422. 25 MiB leaves headroom. The originally planned 50 MiB would have failed in production. |
