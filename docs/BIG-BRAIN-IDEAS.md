# GitGallery — Big-Brain Ideas

> Exploits of GitHub's actual architecture that make it behave like a real photo backend.
> Seeded by the "put the date in the filename" insight — that one turned out to be the *small* version of a much bigger idea.
> **Every claim below is marked ✅ verified against GitHub's official docs, or ⚠️ needs a spike.**
> **Last updated:** 2026-09-17

---

## Confidence legend

| Mark | Meaning |
|---|---|
| ✅ | Verified against docs.github.com — safe to design around |
| ⚠️ | Plausible, mechanism is sound, but **must be prototyped before committing** |
| 🧪 | Speculative — interesting, unproven |

---

# S-TIER — these change the architecture

## S1. Release assets are a free object store — **2 GiB per file, no total size limit** ✅

**This is the single biggest finding.** From GitHub's official docs:

> Each file in a release must be under **2 GiB**. Up to **1000 release assets** per release. *"There is no limit on the total size of a release, nor bandwidth usage."*

Compare to what we were designing around:

| | Git file | Release asset |
|---|---|---|
| Max size | **100 MiB** | **2 GiB** (20× bigger) |
| Counts toward repo size | Yes | **No** — lives outside git |
| Bloats history forever | Yes | **No** |
| Total size limit | ~1–5 GB recommended | **None stated** |
| Bandwidth limit | — | **None stated** |

### Why bytes don't *all* live in releases

Four constraints keep photos in git rather than routing everything to release assets:

- **1000 assets per release** → 20,000 photos would need 20+ releases to manage and route across
- **Flat namespace** — assets have no directory structure, so `2026/09/17/` is unavailable
- **Enumeration costs ~200 requests** (100/page) where the git tree does it in **one**
- **The tree stack only works on git blobs** — sorted timeline, blob-SHA dedup, zero-cost albums, Merkle diff

(Request cost is *not* a differentiator: a release-asset upload and a `createBlob` are both ~1 request.)

> **Why not Git LFS instead?** Same 2 GiB file ceiling, but the free tier allows only 1 GB storage and 1 GB/month bandwidth. Release assets have neither limit.

### ✅ The design: tier by size

| Tier | What | Stored where | Why |
|---|---|---|---|
| **1** | Photos + small video (**< threshold**) | **git blobs** | Keeps tree, dedup, albums, Merkle sync |
| **2** | Anything over the threshold (video, RAW) | **release assets** | The only things that breach 100 MiB |
| **3** | *(optional)* sealed monthly packs | release assets | Only if the library outgrows the repo |

Photos are ~95% by count but tiny; video is ~5% by count but dominates bytes. Each goes where it's strongest, and **release assets get created rarely** — only for files that genuinely need them.

**Does tier 3 ever trigger?** A 2048px q80 photo is ~400 KB. Year-sharded at ~2,000 photos/year ≈ **800 MB/repo** — inside GitHub's "ideally under 1 GB." For a normal library, tier 3 never fires. It only matters for a 10,000+/year shooter.

> **Sizing rule:** JPEGs are already compressed, so git's zlib/delta gains ≈ **0%**. Repo size ≈ sum of file sizes. Never plan around compression savings.

### ✅ The stub-pointer trick — how tier-2 files keep their folder and date

This is the piece that makes flat release namespaces a non-issue.

**Every tier-2 file still gets a real entry in the git tree at its correct path** — just a tiny pointer file instead of the bytes:

```
library/2026/09/17/143022_3840x2160_62s_a1b2c3.mp4.ptr     ← ~200 bytes, in git
```

```json
{ "tier": 2, "release": "media-2026", "assetId": 184203941,
  "name": "2026-09-17_143022_a1b2c3.mp4",
  "size": 524288000, "sha256": "a1b2c3…" }
```

The actual 500 MB video sits in release `media-2026` under a flat unique name.

**This is exactly how Git LFS works** — pointer in the tree, bytes elsewhere. Proven pattern.

**What it buys:**

- ✅ One `git/trees?recursive=1` call still returns **every asset** — tier 1 and tier 2 alike — at the right path, in date order
- ✅ Filename metadata (date, dimensions, duration, hash) survives for tier-2 files
- ✅ Albums, Merkle diff, dedup work **uniformly** — they operate on the stub blob, so they don't care which tier the bytes are in
- ✅ **You never enumerate release assets** — the tree already told you everything. That 200-request problem disappears.
- ✅ `.ptr` suffix doesn't disturb chronological sorting (the time prefix still dominates)

Tier is an implementation detail. Every layer above the fetcher sees one uniform library.

**Release organization:** one release per year (`tag: media-2026`), rolling to `media-2026-b` if it nears 1000 assets. Video is rare enough that a year fits easily.

### ✅ Spike results (measured 2026-09-18, private repo, real API)

| # | Experiment | Result |
|---|---|---|
| 0.5.1 | 150 MiB file as a release asset to a **private** repo | ✅ **HTTP 201**, `state: uploaded`; authenticated read-back **byte-identical**. Tier 2 confirmed. |
| 0.5.2 | Binary-search the blob-API ceiling | ❌ **~35–40 MiB raw, NOT 100 MiB.** 35 MiB → 201; 40 MiB → **422 "input was too large to process"** |
| 0.5.3 | `Range: bytes=1048576-1049575` on an asset download | ✅ **HTTP 206**, exactly 1000 bytes, **bytes match source**. Tier 3 viable. |
| 0.5.4 | ETag + `If-None-Match` on a branch ref | ✅ **304**, `x-ratelimit-remaining` unchanged (4999 → 4999). Free polling confirmed. |

Whole spike cost **13 of 5000** requests.

### 🔴 The blob ceiling is ~⅓ of the documented limit

GitHub documents a 100 MiB file limit, but that applies to **git push**, not the REST blob API. Measured behaviour:

| Raw | Base64 payload | Result |
|---|---|---|
| 25 MiB | 33.3 MiB | ✅ 201 |
| 35 MiB | 46.7 MiB | ✅ 201 |
| **40 MiB** | **53.3 MiB** | ❌ **422** |
| 50 MiB | 66.6 MiB | ❌ 422 |

The cliff sits at roughly a **50 MB request body**, i.e. ~37 MiB raw after base64's ~33% inflation. This validates the warning that the practical cap was well under 100 MiB — it is worse than expected.

**Tier threshold: 25 MiB**, not 50. That leaves headroom below the ~37 MiB cliff for base64 variance and JSON overhead. Anything larger routes to tier 2.

### Picking the threshold ⚠️

~~Start at 50 MiB and tune upward~~ — **resolved by measurement: use 25 MiB.** The real cliff is ~37 MiB raw (a ~50 MB request body), so 50 MiB would have failed in production. Getting this wrong means late upload failures, which is exactly what tiering exists to prevent.

### The remaining catch (be honest)

- Private-repo assets need an authenticated call to the asset endpoint (returns a signed redirect). Works, but no naive `<Image src>` — needs a fetch layer.
- Tier-2 files are less "browsable on github.com" than plain tree files. Trade-off.
- ⚠️ **See the Acceptable Use warning at the bottom. This idea carries the most ToS risk of anything here.**

### Scorecard

| Constraint | Under tiering |
|---|---|
| 100 MB file cap | ✅ **Dead** — oversized files route to tier 2 |
| Video compression quality loss | ✅ **Dead** — 2 GiB ceiling, no transcode needed |
| Git history bloat | ⚠️ **Still real** — photos stay in git, so squash is still needed (but now over 400 KB files, not 4 GB ones — far less urgent, far less risky) |
| Repo size ceiling | ⚠️ **Reduced, not gone** — year-sharding still required |

### S1b. Tier 3 — pack many photos into one asset + **HTTP Range reads** ⚠️

*Only needed if the library outgrows the repo (see sizing math above). Not v1.*

Since one asset can be 2 GiB, pack a month of photos into a single archive, store each photo's `(offset, length)` in the index, and fetch an individual photo with a **Range request** — one request, a few hundred KB, no full download.

That's a custom object store on GitHub's CDN. It collapses "1 upload request per photo" into "1 per month."

**Design constraint to respect now:** you can't append to a packed archive without re-uploading the whole thing. So the **current month stays loose in git (tier 1) and is sealed into a pack once the month ends** — hot tier / cold tier. Past months are immutable and never rewritten.

⚠️ Release asset downloads redirect to `objects.githubusercontent.com` (S3-backed), which *should* honor `Range` — **verify with curl before building on it.** If Range doesn't work, this idea dies and tiers 1–2 still stand.

---

## S2. On-device ML brings back smart search and faces — **I was wrong to call these dead**

Earlier I said semantic search and face recognition were impossible because they need a vector DB and ML compute, and GitHub can't do that. The first half is true. **The conclusion was wrong** — because the compute doesn't have to be on a server. It can be on the phone.

**The phone is the ML server.**

| Capability | How |
|---|---|
| Semantic search ("photos of my dog on a beach") | Run **MobileCLIP** / a small CLIP variant on-device at upload time → store the embedding in the index |
| Face detection | **Free, built into both OSes** — Android ML Kit, iOS Vision framework |
| Face clustering ("people" view) | Cluster face embeddings locally |
| OCR / text-in-image search | Also free on-device (ML Kit / Vision) |

**Cost of the index:** a 512-dim embedding quantized to int8 = **512 bytes/photo**. 20,000 photos = **~10 MB**. Trivially fits in the repo.

**Search runs locally** — vector math over 20k rows is milliseconds on an M-class phone. No server, no Postgres, no pgvector.

**Feasible in this stack:** `react-native-executorch`, `onnxruntime-react-native`, or TFLite. GitGalleryApp already uses `expo-dev-client`, so **native modules are already unlocked** — no ejection needed.

**Honest caveats:**
- Embedding a 20,000-photo backlog is **hours of on-device compute**. Must run incrementally, on charge, in background.
- Adds meaningful app size (model weights, tens of MB).
- Accuracy below server-class CLIP — good, not Immich-grade.
- This is a **Phase 6+ stretch goal**, not v1. But it's *possible*, and that's the correction.

---

## S3. ThumbHash in the index → the **entire timeline renders instantly from one API request** ⚠️

[ThumbHash](https://evanw.github.io/thumbhash/) encodes a recognizable blurry preview of an image in **~25 bytes**.

Store one per photo in the index (or even in the filename — 25 bytes → ~34 base64 chars, well under the 255-char filename limit).

**Result:** one `git/trees?recursive=1` call returns your whole library, and you can immediately render a **full, scrollable, visually-correct timeline** — every tile showing a blurred preview of the actual photo — having downloaded **zero images**. Real thumbnails then stream in over the blur.

That *is* the Immich "instant timeline" feel. (Immich uses thumbhash for exactly this.)

Combined with S4 below, a single request gives you: **date, aspect ratio, and a renderable preview for every photo in the library.**

---

# A-TIER — big multipliers

## A4. The filename can carry far more than the date ✅

Your original insight, pushed further. Instead of just the date:

```
library/2026/09/17/143022_4032x3024_a1b2c3d4.jpg
                   │      │         └─ short content hash (dedup key)
                   │      └─ dimensions → aspect ratio
                   └─ capture time (EXIF, not upload time)
```

Because the tree API returns every path in one call, this gives you — **before downloading a single byte**:

- ✅ Chronological ordering (lexicographic sort = chronological)
- ✅ **Aspect ratio → lay out a justified/masonry grid with correct tile shapes, no image loads, no layout shift**
- ✅ Video duration (same trick, `_12s_`)
- ✅ A dedup key

The aspect-ratio one is underrated: it's what lets the grid render at the right shape instantly instead of popping as images arrive.

**Limit:** 255-char filenames, ~4096-char paths. Plenty. Don't get greedy — anything variable-length or private belongs in the index, not the filename.

---

## A5. Git blob SHAs give you **free dedup and free albums** ✅

Git is content-addressed: a blob's identity *is* `SHA1("blob " + size + "\0" + content)`. You can compute that **locally, before uploading**.

**Free dedup:** if the SHA already exists in your index, the photo is already in the repo — even at a different path. Add a tree entry pointing at the existing blob. **Zero bytes uploaded.** (Immich needs a Postgres checksum table for this; git hands it to you.)

**Free albums — this is the elegant one:** a tree entry is just `(name → blob SHA)`. Point 500 album paths at 500 existing blobs and the album costs **zero additional storage**. Photos live in many albums simultaneously with no duplication, no symlinks, no junction table.

```
library/2026/09/17/143022_a1b2c3.jpg   ─┐
                                        ├─→ same blob, stored once
albums/Goa Trip/143022_a1b2c3.jpg      ─┘
```

---

## A6. Merkle-tree diffing = incremental sync for free ✅

Git trees are a Merkle tree: **a directory's SHA changes if and only if something inside it changed.**

So to sync, you don't scan the library. You walk from the root, and **any subtree whose SHA matches your cached copy is skipped entirely** — provably unchanged, no requests.

Sync cost becomes **O(what changed)**, not O(library size). Finding "3 new photos in a 50,000-photo library" touches a handful of nodes.

This is genuinely better than what a naive REST backend gives you — Immich has to do timestamp bookkeeping to get the same result.

---

## A7. Conditional requests are **literally free** ✅

Straight from GitHub's docs:

> *"Making a conditional request does not count against your primary rate limit if a `304` response is returned and the request was made while correctly authorized."*

So: store the `ETag` from `GET /repos/{o}/{r}/git/refs/heads/main`, send `If-None-Match` on every poll. Nothing changed → **304, zero rate-limit cost.**

**You can poll for changes as often as you like, forever, for free.** Background sync becomes effectively unmetered. Combine with A6: one free request detects "anything changed?", then Merkle-diff only if it did.

---

## A8. GraphQL fetches N files in **one request** ✅

REST = one request per file. GitHub's GraphQL API is a **separate rate limit pool**, and aliasing lets you pull many objects in a single query:

```graphql
{ repository(owner:"me", name:"gallery") {
    a: object(expression:"main:library/2026/09/17/meta.json") { ...on Blob { text } }
    b: object(expression:"main:library/2026/09/16/meta.json") { ...on Blob { text } }
    # ... 50 more aliases
}}
```

One request, one point. ⚠️ Node/complexity limits apply — batch ~20–50 aliases and measure, don't assume 1000 works.

---

## A9. Thumbnail atlases — 1 request = 100 thumbnails ⚠️

Pack a day's (or month's) 256px thumbnails into a **single JPEG sprite sheet**, slice client-side. 100 thumbnails in one request instead of 100.

**The churn problem and its fix:** rewriting an atlas every time a photo is added creates history churn. Solution: *today's* atlas is hot and rewritten a few times; **once a day passes its atlas is sealed forever** and never rewritten. Past days = immutable = zero churn.

(With S3 shipped, atlases matter less for *placeholders* — but they're still the efficient way to deliver real thumbnails.)

---

# B-TIER — solid wins

## B10. Rolling compaction instead of full squash 🧪

Don't squash everything. Squash commits **older than 30 days**; keep recent history intact.

You get the size benefit *and* keep ~30 days of free undo/version-history ("I cropped this last week, restore the original"). Git gives that for free — full squashing throws it away.

Still relevant under tiering: tier-1 photos live in git, so history does accumulate — just over 400 KB files rather than multi-GB videos.

## B11. `trash/` as a separate ref = free soft-delete ✅

Deleting = moving the tree entry to a `trash/` prefix (or a separate ref). The blob is untouched, so "restore" is instant and free. A real 30-day trash bin for zero bytes.

## B12. The git protocol bypasses the REST rate limit entirely ⚠️

`git fetch`/`clone` over HTTPS does **not** consume REST API quota — different subsystem. A **partial clone** (`--filter=blob:none`) pulls the entire tree structure — your whole timeline index — while downloading **zero photo bytes**.

`isomorphic-git` is pure JS and runs in React Native. ⚠️ Performance in RN is the open question — prototype before betting on it. Big prize if it works: unmetered bulk sync.

## B13. Shard by year to stay under the tree API limit ✅

The recursive tree API truncates at **100,000 entries or 7 MB**. A lifetime library will hit that.

Sharding into `refs/heads/year-2025`, `year-2026` (or separate repos) keeps each tree fetch small *and* fast. Also a natural path to the multi-repo model already in the plan (decision D7).

---

# ⚠️ The honest risk: GitHub's Acceptable Use

These ideas are clever, but they push GitHub toward being a personal CDN, and that has real consequences. From GitHub's own docs:

> *"Git is not designed to serve as a backup tool"* — and repositories that grow excessively large can *"impact our infrastructure,"* prompting GitHub Support to reach out asking for corrective action.

**S1 (releases as an object store) carries the most risk** — "no limit on total size" is written for *software distribution*, not for parking a 200 GB photo library.

**How to stay reasonable:**
- Keep it personal-scale (tens of GB, not hundreds)
- Shard across repos rather than one enormous one
- Don't automate pathological traffic; respect rate limits even where 304s are free
- **Never make this your only backup.** GitHub can suspend an account. Treat it as a *sync + viewing layer*, with a real backup elsewhere.

This isn't a reason not to build it. It *is* a reason not to trust it with the only copy of your photos.

---

# Recommended re-plan

| Idea | Effort | Payoff | When |
|---|---|---|---|
| **A7** free conditional polling | Hours | Unmetered sync | Phase 1 — do immediately |
| **A4** rich filenames | ~1 day | Instant grid layout, dedup key | Phase 2 |
| **A5** blob-SHA dedup + free albums | 1–2 days | Zero-cost dupes & albums | Phase 2 |
| **A6** Merkle diff sync | 2 days | O(changed) sync | Phase 2 |
| **S3** ThumbHash | 1–2 days | **Instant timeline** | Phase 2 — huge UX/effort ratio |
| **S1** tiered storage + stub pointers | 3–5 days | **Kills the 100 MB cap & video transcoding** | **Spike in Phase 0, build in Phase 1** |
| **A8** GraphQL batching | 1–2 days | N files/request | Phase 2 |
| **A9** thumbnail atlases | 2–3 days | 100× fewer thumb requests | Phase 3 |
| **S1b** tier 3 packs + Range reads | 2–3 days | 1 upload/month | Deferred — only if the library outgrows the repo |
| **B12** isomorphic-git | 3–5 days | Bypass rate limit | Phase 5, if needed |
| **S2** on-device ML | 1–2 weeks | **Search + faces return** | Phase 6 stretch |

**Do first (Phase 0 spike):**
1. Upload a ~500 MB video as a release asset to a **private** repo, then read it back authenticated — proves tier 2.
2. Binary-search the **actual** blob-API size ceiling (base64 inflation may bite well before 100 MiB) — sets the tier threshold.
3. `curl -r 0-1000` against an asset download URL — decides whether tier 3 is ever viable.

Answers 1 and 2 determine the shape of the entire upload pipeline. Do them before writing Phase 1 code.
