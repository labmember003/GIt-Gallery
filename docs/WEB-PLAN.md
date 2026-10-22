# GitGallery web

The browser companion uses the existing Expo project and a small Node server for authentication. It opens with a welcome/sign-in screen. Demo photos are loaded only through **Try the demo**; after sign-in, GitGallery opens an existing library or creates a private one automatically. Signed-in users can upload photos and videos from the browser; Android and iOS provide automatic device backup.

## Implemented

| Capability | Behaviour |
|---|---|
| Sign-in | Guided GitHub approval codes using the existing client ID; optional browser redirects with state/PKCE when a secret is configured; advanced token login is opt-in |
| Sessions | HttpOnly, SameSite cookie; credentials held on the server; selected repository restored after reload |
| Library setup | Reuse the mobile default, discover custom libraries, or create a private initialized repository automatically |
| Repository picker | Multiple-library choice and optional switching; account repositories, loaded-list search, pagination, manual owner/name and branch entry |
| Gallery | Responsive desktop/phone layouts, date groups, search, filters, sorting, compact grid, multi-select |
| Uploads | File picker and drag/drop, progress, retry/stop, original preservation, album membership, previews and tier routing; up to 500 MiB per file |
| Viewer | Photo zoom, keyboard navigation, video playback, original downloads |
| Collections | Favourites and albums saved in this browser, separated by account/repository/branch |
| Demo | Explicit opt-in; 36 photos and 3 clips, separate from real libraries |
| Public access | Public repositories can be opened without signing in |
| Compatibility | Canonical paths, legacy paths, metadata shards, previews, and release pointers |
| Logout | Invalidates the server session; other open tabs update; no return to sample photos |

A real library starts with empty favourites/albums unless this browser already has saved collections for that account and repository. These collections do not sync with the mobile app. A public connection opened without sign-in must be reopened after a reload.

Mobile saves its chosen repository in that device's SecureStore. Web discovers the library independently after GitHub approval:

1. Open `username/gitgallery-photos` if accessible, preserving its actual default branch. This is the mobile default and takes precedence over custom libraries.
2. Otherwise page through accessible repositories and detect the mobile description `Private repo for GitGallery` or a `gitgallery/` directory containing `library`, `images` or `meta`. One match opens automatically; several matches require a choice.
3. With a complete search and no match, create `gitgallery-photos` in the signed-in user's account with `private: true` and `auto_init: true`. Reuse an existing name after a simultaneous-creation conflict; never make numbered duplicates.

Discovery uses six concurrent directory checks, at most ten repository pages and a 100-second request deadline. Failed access, missing private-repository OAuth scope, incomplete scans and creation failures stop setup and offer retry/manual selection. A failed repository listing is not displayed as an empty account. A 120-second shared-session lease prevents overlapping setup across function instances; session version checks reject stale results and check for logout before creation. Interrupted creation is recovered by looking up the same deterministic repository name on retry.

The new library starts empty. Choose **Upload** in Photos or an album, or drop files onto the gallery. Uploads appear automatically when the batch finishes. Mobile backups to the same repository also appear after refreshing. Discovery and repository selection do not change existing files. See [the upload protocol and limits](WEB-UPLOADS.md).

## Local setup

These are **website operator** instructions, completed once for all visitors. End users sign in with their own GitHub account; library setup is automatic unless several existing libraries need a choice. [Plain-language sign-in setup and explanation](WEB-AUTH-SETUP.md).

```bash
cd app
npm install
# Copy the example only if you have not configured .env.web yet:
cp .env.web.example .env.web
```

Use an OAuth App you own with **Device Flow enabled**. Set `GITHUB_CLIENT_ID` in `app/.env.web`; `WEB_AUTH_MODE=auto` uses approval codes when no client secret is present. The existing mobile registration was verified to issue a code through GitHub on 2026-10-20. Visitors get step-by-step instructions to copy the code, open GitHub, approve access and return to their automatically prepared library. Tokens and private device credentials remain on the server.

A client secret and callback are optional, for direct browser redirects. To use that flow, set `GITHUB_CLIENT_SECRET` and register `http://127.0.0.1:8082/api/auth/callback`. `WEB_AUTH_MODE=redirect` requires those settings; `WEB_AUTH_MODE=device` always uses codes. The native `.env` and development-token bypass are never loaded for web sign-in.

```bash
npm run check:web       # credential-safe readiness check
npm run web             # open http://127.0.0.1:8082
```

The Node server owns port 8082 and forwards development assets/HMR to Metro on 8083. Use **8082** for the website. `localhost:8082` redirects to the configured origin. To change ports, set both: `PORT=8084 WEB_ORIGIN=http://127.0.0.1:8084 npm run web`. Restart after configuration changes.

An unconfigured copy provides on-page setup instructions for its operator and explains the restriction to visitors. During code sign-in, the app shows expiry, cancel, retry and a new-code action. Token login is off by default, including the endpoint; `WEB_ALLOW_TOKEN_SIGN_IN=true` exposes it under Advanced sign-in.

For a production build on this machine:

```bash
npm run build:web       # exports app/dist-web
npm run preview:web     # serves frontend + /api on http://127.0.0.1:8082
```

## Hosting

The selected host is one **Vercel Hobby project** for the static frontend and Node API, with Upstash Redis for shared sessions. See the [deployment guide](WEB-DEPLOYMENT.md) for exact settings, free-plan limits and live verification status.

The Vercel deployment serves `dist-web` as static assets and `api/index.mjs` as a Node function on the same origin. Uploading `dist-web` alone does **not** provide sign-in or authenticated media access. Standalone Node hosting remains supported with `npm run preview:web` behind HTTPS.

Set `WEB_ORIGIN` to the exact public HTTPS origin, configure the client ID, and use `HOST=0.0.0.0` when required. For direct redirects, also configure the client secret and callback `<WEB_ORIGIN>/api/auth/callback`. A reverse proxy must preserve the configured Host header. The server rejects unexpected hosts and requires HTTPS for non-loopback origins; Secure cookies are enabled for HTTPS. Public origins and `NODE_ENV=production` require the settings for the chosen sign-in method at startup (client ID for codes; ID and secret for explicit redirect mode). This catches missing configuration, while a real sign-in is still required to verify the registration and secret.

Vercel sessions live in shared Redis and survive individual function restarts. Local preview defaults to an in-memory store whose sessions expire on restart. Sessions have a maximum lifetime of eight hours, shortened to the GitHub token expiry when supplied. Expiry requires signing in again; automatic refresh-token rotation is not implemented. Atomic version checks and rotation prevent stale instances or cancelled approvals from restoring an invalid session. Pending approval leases and sign-in rate counters are shared on Vercel; preview and production namespaces are isolated by origin. No service worker caches private media.

The website is deployed at [https://gitgallery-umber.vercel.app](https://gitgallery-umber.vercel.app). Public HTTP and fresh desktop/phone browser checks passed for sign-in code issuance, pending approval, cancellation, session reload, demo media and video playback, with no browser errors or failed site requests. The user has confirmed real-account sign-in and an empty library; real private upload/download verification remains; fixtures exercise completed authorization without a personal token. Vercel is connected to `labmember003/GIt-Gallery`, with production branch `main` and Root Directory `app`. Keep GitHub App access limited to that repository and verify each pushed commit's deployment status.

## Architecture and security

- `app/App.web.tsx` selects `src/web/BrowserApp.tsx`. It restores sessions, gates the gallery, and loads the demo module only when explicitly selected.
- `src/web/SignIn.tsx`, `DeviceSignIn.tsx`, `LibrarySetup.tsx` and `RepositoryPicker.tsx` handle onboarding, copy-code approval, expiry, cancellation, automatic library setup and optional selection. `WebApp.tsx` renders an actual selected library or the explicit demo.
- `src/web/session.ts` sends same-origin requests. The browser receives account information and a CSRF token, never the server’s GitHub access token or OAuth secret.
- `server/auth.mjs` requests device codes and polls with provider-enforced intervals, supports redirect code exchange with state/PKCE, validates identity with GitHub, rotates session IDs on sign-in, enforces session expiry, and implements logout. State-changing requests require both the exact Origin and session CSRF token.
- `server/library-setup.mjs` discovers existing libraries and creates only the fixed private default when no existing library is found. The CSRF-protected `/api/library/setup` route owns session leases and saves the selected repository. Repository creation is separate from the read-only media gateway.
- `server/uploads.mjs` implements selected-library writes behind Origin/CSRF checks. Browser requests use 3 MiB chunks, shared session manifests, Git blob staging and atomic non-forced commits; larger originals stream to release assets. See [WEB-UPLOADS.md](WEB-UPLOADS.md).
- `server/site.mjs` serves the frontend and API on one origin, with security headers and static-file range support. It also proxies Metro during development.
- The authenticated media gateway allows only read endpoints under the selected repository. GitHub credentials are attached on the server. Release redirects are restricted to HTTPS GitHub content hosts and receive no Authorization header.
- `src/web/github.ts` normalises the GitHub tree through the same fetch contract for public direct reads and authenticated server reads. `library.ts` interprets paths/metadata; `storage.ts` validates browser-local collections.
- The pure parser in `src/services/sync/pathMetadata.ts` and timeline grouping are shared with native. SQLite, SecureStore, filesystem, and device-photo APIs stay outside the browser graph.
- Expo builds disable dotenv loading and strip native development credentials and the web client secret from the bundler environment. The server’s `.env.web` is never part of `dist-web`.

OAuth requests GitHub’s `repo` scope to access private libraries. That scope allows private repository creation and photo/video uploads; GitHub OAuth Apps do not offer a private-repository read-only scope. Fine-grained PATs allow repository-specific Contents read/write permission for uploads; read-only connections can still browse. A GitHub App integration is a future option for narrower OAuth permissions. Signing out ends the local website session; revoke the app grant separately in GitHub settings if needed.

GitHub documents a limit of 50 code submissions per hour per app for Device Flow. Direct redirect sign-in is the deployment path for higher traffic. See the [official device-flow limits](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#rate-limits-for-the-device-flow).

## Media and scale limits

The browser limits media requests to four concurrent downloads, thumbnails to 12 MiB, metadata files to 8 MiB, and originals to 80 MiB. Completed media cache entries have a 96 MiB byte budget; in-flight requests and decoded images can temporarily exceed that. These are app safeguards, not GitHub service limits. The timeline initially renders 120 items and supports Load more; large libraries still need virtualisation and persistent indexing.

Truncated recursive trees trigger explicit subtree traversal. Incomplete subtrees or listings above the 50,000-entry guard produce an error. Failed metadata shows a warning and falls back to path metadata. First-time library creation initializes a private repository with a README. Uploads preserve unrelated files and merge metadata; a non-forced ref update protects concurrent changes.

HEIC and some MOV codecs depend on browser support; unsupported originals can still be downloaded. Signed-in release downloads go through the server to avoid browser redirect/CORS problems, but unsupported redirects, failed downloads and originals above the browser limit offer **Open on GitHub**. The server streams relay responses, but the browser still buffers permitted media into blobs. Progressive private-video streaming and transcoding are not implemented. Real private release downloads still need verification with a configured account.

## Screenshots

The original demo was preserved in [24 web screenshots](../screenshots/README.md#web), including desktop and mobile light/dark layouts. Full WebP captures plus previews occupy 3.58 MiB. They show the demo before the sign-in entry flow changed. The source PNGs remain outside the repository; checksums and dimensions are in `screenshots/web/capture-manifest.json`.

```bash
cd app
npx playwright install chromium   # once per machine
npm run screenshots:web           # requires the running website and cwebp
```

The capture script opens `/?demo=1` in a fresh browser context. It never uses a signed-in browser profile.

## Verification

```bash
cd app
npm run test:web
```

This runs TypeScript, 12 library unit tests, 49 server authentication/configuration/store/setup/upload tests, a production export, and 26 Chromium browser tests. The browser suite starts isolated Node servers on 8092 (redirect) and 8093 (approval codes) with fixture GitHub responses; it exercises the actual session cookies, CSRF, OAuth callback, repository picker, authenticated media gateway, reloads and cross-tab logout. No test writes to GitHub or uses a personal token.

Coverage includes automatic creation/reuse, custom-library discovery, multi-library choice, pagination, setup leases, logout during discovery, creation conflicts, access errors/retry, production startup readiness, optional-token enforcement, on-page setup guidance, device-code onboarding, slow-down handling, expired/denied codes and cancellation races, invalid/denied/replayed OAuth callbacks, credential isolation, wrong origins, session expiry, token errors, repository access bounds, signed-release redirects, demo opt-in, real-library empty states, desktop/phone layouts, 1,001-item pagination, 500 MiB pointer fallback, video playback/seeking, downloads, themes and collection persistence. Browser captures were inspected. Fresh Android/iOS production Hermes bundle exports passed on 2026-10-20. Source maps confirm the browser UI, web entry and web auth server are excluded. The shared parser source is identical to its original implementation, native configuration is unchanged, and existing dependency entries were not upgraded. This does not claim a new emulator/device regression pass.

## Remaining work

1. Complete real private-library upload/download verification with a throwaway repository; configure optional redirect sign-in for larger public deployments. Add Safari/Firefox and accessibility verification before public release.
2. Browser background uploads and a persistent file queue; optional photo compression. Current uploads preserve originals and require this tab to stay open. Reselecting the same files resumes received parts while the session/upload manifest remains valid.
3. Define a shared collection schema before syncing favourites/albums between mobile and web. Add virtualisation, cached indexes and incremental refresh.
4. Add refresh-token rotation and complete live private-media streaming/bandwidth checks. Vercel public deployment checks, shared Redis sessions and sign-in rate limits are implemented.

## Official references

- ✅ [Expo web workflow](https://docs.expo.dev/workflow/web/): platform-specific React DOM interfaces and export.
- ✅ [GitHub OAuth authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps): callback, client secret, state, PKCE, identity validation and token expiration.
- ✅ [GitHub private repository creation](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user): `repo` scope, `private` and `auto_init` options. [Directory reads](https://docs.github.com/en/rest/repos/contents#get-repository-content) identify GitGallery data without downloading media.
- ✅ [GitHub repository listing](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user): authenticated repository selection.
- ✅ [GitHub blob reads](https://docs.github.com/en/rest/git/blobs#get-a-blob) and [release downloads](https://docs.github.com/en/rest/releases/assets#get-a-release-asset): read permission and binary redirects. ⚠️ Live private-release compatibility awaits account verification.
- ✅ [GitHub CORS](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests): direct public reads.
