# Browser uploads

Signed-in users choose **Upload** in Photos or an album, select files, or drop them onto the gallery. The queue shows preparation, received parts, saving, completion and individual errors. **Retry remaining** resumes received parts. **Stop uploads** stops remaining work; files already committed stay in the library. Uploads from an album also add their IDs to that browser's album. The library refreshes after the batch.

Original bytes are preserved. Supported extensions are JPG/JPEG, PNG, WebP, GIF, HEIC/HEIF, AVIF, MP4/MOV/M4V and WebM. The web limit is **500 MiB per file**, with up to 200 files in a batch. Keep the tab open. After reload, reselecting the same file resumes its received parts while its upload manifest and session remain valid. A completed original is recognised through repository metadata, including after a new session. Background uploads and persistent browser file handles are not implemented.

Browser-supported photos/videos receive a JPEG preview up to 1280 pixels on the longest edge and 512 KiB. Unsupported codecs still upload their originals; previews/playback depend on the browser. JPEG capture dates use the existing pure EXIF reader; other files fall back to their last-modified date. Unknown dimensions are recorded as zero. Albums/favourites remain browser-local. Native application files and dependencies are unchanged.

## Protocol

`/api/uploads/options` checks write permission. All mutation routes require a signed-in session, the exact website Origin and the session CSRF token. The server chooses every repository path; browser requests cannot supply arbitrary Git operations or switch the upload's target repository.

1. The browser reads slices of **3 MiB**, computing SHA-256 for each slice. `/start` validates name, size, dimensions and checksums and records a repository-bound manifest in the shared session. At most four unfinished manifests are retained per session. Manifests expire after two hours or at session expiry, whichever comes first.
2. Each `/chunks/:index` request sends raw bytes. The server verifies expected size/checksum, creates a Git blob in the selected repository, and stores only its SHA in Redis. `/preview` similarly saves an optional JPEG. Received parts are idempotent.
3. `/finish` checks permission again, takes a versioned lease, reads and verifies received parts, and calculates the original file's SHA-256. Originals up to **25 MiB** use a normal Git blob. Larger originals stream to a GitHub release asset with an explicit Content-Length; the server verifies `state`, size and the upstream digest when present before creating a `.ptr` file. Releases use `media-YEAR`, rolling over to `media-YEAR-web-N` near 900 assets.
4. A single Git commit adds the original or pointer, preview, metadata shard and merged manifest. It uses the latest base tree and a **non-forced** ref update. Ref conflicts re-read and merge metadata before retrying; unrelated files and concurrent commits are preserved. A saved metadata entry recovers a lost completion response without adding a duplicate.
5. `/cancel` invalidates the manifest. Session version checks reject stale work after cancel, logout or repository switching. A GitHub commit already submitted before cancellation may still complete; the UI explains this and refreshes the library.

The canonical path is `gitgallery/library/YYYY/MM/DD/HHMMSS_WxH_ID.ext`; large originals append `.ptr`. `ID` is a deterministic identity derived from the ordered chunk hashes, size and extension. The **true original SHA-256** is separately stored in metadata and release pointers. Sixteen `gitgallery/meta/shards/web-HEX.json` buckets prevent creating one metadata request per uploaded file. Existing manifest entries and shard entries are merged, not replaced. Metadata includes the original filename for browser display/downloads.

Chunk blobs are unreferenced staging objects: they are not listed as photos and are not added to the branch. GitHub controls their eventual garbage collection; the app cannot promise immediate storage reclamation after cancellation. A release uploaded before an interrupted commit can also remain unreferenced until retry. No extra object-storage service or client-visible GitHub token is required.

## Hosting and limits

✅ Vercel documents a **4.5 MB function request/response body limit**. Each upload request stays below it. Finishing runs with a 270-second deadline and the function's configured maximum is 300 seconds, supported by Hobby with Fluid compute. A very slow large-video finalization can still time out; received parts remain retryable. [Vercel function limits](https://vercel.com/docs/functions/limitations).

✅ GitHub accepts base64 Git blobs, binary release-asset uploads and non-forced ref updates. Failed release uploads can leave a `starter` asset; only the current deterministic upload's incomplete starter is removed on retry. [Create a blob](https://docs.github.com/en/rest/git/blobs#create-a-blob), [upload a release asset](https://docs.github.com/en/rest/releases/assets#upload-a-release-asset), [update a reference](https://docs.github.com/en/rest/git/refs#update-a-reference).

The 25 MiB tier threshold and 500 MiB web cap are application limits, not claimed GitHub service limits. The viewer still limits buffered originals to 80 MiB and offers Open on GitHub above that size. Uploading a larger original does not imply that the browser can play or buffer it. Uploads require Contents write permission and an initialized, writable branch. Protected branches may reject direct uploads. Rate limits and permission failures are shown in the queue with next steps.

## Verification

Local tests exercise the actual HTTP/session/Vercel-adapter path with a stateful synthetic GitHub API. They cover 5 MiB multi-request originals, previews, metadata, deduplication across sessions, missing/corrupt chunks, CSRF, view-only access, repository switching, cancellation, logout during finalization, concurrent commits, lost completion responses, incomplete release retry, merged shards and a streamed **500 MiB** original with a matching checksum. No production account credentials are inspected.

Browser tests exercise the picker, gallery drag/drop, album membership, refresh/reload, exact original downloads, duplicate selection, retry, stop/resume, unsupported files, view-only guidance, responsive light/dark dialogs and a >25 MiB video playing after reload. These use real media bytes and synthetic GitHub responses. The production build, 12 library tests, 49 server tests and 26 browser tests pass; captures are inspected. Live hosting verification is recorded in [WEB-DEPLOYMENT.md](WEB-DEPLOYMENT.md).

⚠️ Real GitHub upload/download verification with a consented throwaway private library remains. The available CLI account is the work account, so it is not used to create test repositories for this personal project. The user's screenshots confirm real sign-in and an empty library; synthetic tests do not establish private upstream throughput or quotas.
