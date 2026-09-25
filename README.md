# GitGallery

A photo/video gallery app that stores your library in **your own private GitHub repo**, with an **Immich-quality UI**.

No server. No Docker. No monthly bill.

> **Status: v1 complete.** Android + iOS, tested on emulator/simulator and on real hardware
> (iPhone 13, Galaxy S24 Ultra, ~15,000-asset library). GitHub sign-in works end to end.

---

## The idea in one paragraph

Immich is a brilliant self-hosted photo app, but it needs a server (Postgres + Redis + S3 + an ML service). GitGalleryApp is a tiny Expo app that commits photos straight into a private GitHub repo — no server at all — but its UI is plain. This project takes **GitGalleryApp's architecture** and gives it **Immich's interface**, plus the storage optimizations needed to make GitHub behave like a real photo backend.

---

## Start here

| Doc | What's in it |
|---|---|
| **[docs/PROJECT-DOC.md](docs/PROJECT-DOC.md)** | What we're building and why. Architecture, hard constraints, feature scope, decisions log. |
| **[docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md)** | How and in what order. 6 phases, with risks and a definition of done. |
| **[docs/BIG-BRAIN-IDEAS.md](docs/BIG-BRAIN-IDEAS.md)** | ⚡ Architecture exploits that beat most of the constraints below. **Read before starting Phase 1** — two of them reshape the plan. |
| **[docs/CHAT-LOG.md](docs/CHAT-LOG.md)** | The full conversation this came from, start to finish. |
| **[docs/REGRESSION-2026-09-19.md](docs/REGRESSION-2026-09-19.md)** | Android regression pass — results, regressions caught, known gaps. |
| **[docs/REGRESSION-2026-09-20-ios.md](docs/REGRESSION-2026-09-20-ios.md)** | iOS regression pass — the 16 bugs found on device and how each was fixed. |

---

## Reference code

Two repos are read alongside this one. **Neither is committed here** — `reference/` is gitignored.
Recreate them locally if you want them:

| Repo | Size | Role | Get it |
|---|---|---|---|
| GitGalleryApp | 2.9 MB | **The fork base.** Expo + RN + Octokit, ~6,250 LOC. | `git fetch upstream` |
| immich | 162 MB | **UI reference only.** The Flutter timeline & theme. | `git clone --depth 1 https://github.com/immich-app/immich reference/immich` |

> ⚠️ **GitGalleryApp has no LICENSE file** — default copyright applies. Fine for private use;
> resolve before publishing. Immich is AGPL-3.0 (strong copyleft — learn from it, don't paste
> from it), which is why its tree is never vendored into this repo.

---

## How storage works

Files are **tiered by size**, and the git tree stays the single source of truth for both tiers:

```
library/2026/09/17/143022_4032x3024_a1b2c3.jpg       ← tier 1: the photo itself, in git
library/2026/09/17/150811_3840x2160_62s_d4e5f6.mp4.ptr ← tier 2: 200-byte pointer in git
                                                        └→ 500 MB video in release "media-2026"
```

Tier 1 (photos, ~95% of files) lives in git, so it keeps the sorted tree, free dedup, zero-cost albums and Merkle sync. Tier 2 (video, RAW — anything over the threshold) goes to **release assets**, which allow **2 GiB per file** and don't touch git history. The `.ptr` stub keeps the folder, date and dimensions in the tree, so one API call still returns the whole library correctly ordered — and nothing above the fetcher knows tiers exist.

*(Same pattern Git LFS uses: pointer in the tree, bytes elsewhere.)*

---

## The core challenge

GitHub is not a database. It cannot answer *"give me photos 500–550, sorted by date."* Everything in this project follows from working around that:

| Constraint | Our answer |
|---|---|
| No query engine | Path encodes capture date, dimensions & content hash → one `git/trees?recursive=1` call returns a pre-sorted, pre-laid-out library |
| 5,000 API req/hour | Batch commits via git plumbing + **304 conditional requests are free** |
| 100 MB file cap | **Release assets allow 2 GiB** and don't touch git history |
| History keeps every binary forever | Largely moot if blobs live outside git; rolling compaction otherwise |
| Repo size ceiling | Index-only repo stays tiny; shard by year beyond that |
| No ML / vector search | **Not dead** — move the ML on-device (Phase 6 stretch) |

See **[BIG-BRAIN-IDEAS.md](docs/BIG-BRAIN-IDEAS.md)** for how each of these is actually beaten.

---

## Platforms

Android and iOS, both shipped and both tested on real hardware. Web & desktop out of scope.

---

## Running it

```bash
cd app
npm install
npx expo run:android     # or: npx expo run:ios
```

iOS needs CocoaPods (`cd ios && pod install`) and a signing team in Xcode for a physical device.

Android needs `android/local.properties` pointing at your SDK — it is gitignored, and `gradlew`
fails with *SDK location not found* without it:

```bash
echo "sdk.dir=$HOME/Library/Android/sdk" > app/android/local.properties
```

**Release APK:**

```bash
cd app/android && ./gradlew assembleRelease
# -> app/build/outputs/apk/release/app-release.apk
```

> ⚠️ Two things about that APK. It is signed with the **debug keystore** (`signingConfig
> signingConfigs.debug`, the Expo template default) — fine for sideloading, not for distribution.
> And `EXPO_PUBLIC_*` values are **inlined into the JS bundle at build time**, so remove
> `EXPO_PUBLIC_GITHUB_TOKEN` from `.env` before building or your PAT ships inside the APK.
> `__DEV__` gates the code path, not the string literal.

Sign-in is GitHub **Device Flow** — the app shows a code, you approve it at
`github.com/login/device`. That needs an OAuth App client ID in `app/.env`:

```
EXPO_PUBLIC_GITHUB_CLIENT_ID=Ov23li...      # OAuth App, "Device Flow" enabled
EXPO_PUBLIC_GITHUB_TEST_REPO=you/some-repo  # dev only
EXPO_PUBLIC_GITHUB_TOKEN=github_pat_...     # dev only — skips the sign-in screen
```

`.env` is gitignored. The two dev keys are a convenience for local builds; the token fallback is
guarded by `if (!token)`, so a real signed-in session always wins.

> ⚠️ Sign-in currently requests the `repo` scope, which is **read/write to every repository you
> own** — GitHub OAuth Apps have no narrower option. Scoping it to one repo means switching to a
> GitHub App with per-repository installation. Revoke any time at
> `github.com/settings/applications`.

---

## What's not done

- **Select All** only covers the page of the timeline that has loaded, not the whole library.
- **Scope narrowing** — see the warning above.
- On-device ML search / face grouping — deliberately deferred (Phase 6 stretch).
