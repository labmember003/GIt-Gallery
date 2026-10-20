# Vercel deployment

**Live website: [GitGallery Web](https://gitgallery-umber.vercel.app)** · [Try the demo](https://gitgallery-umber.vercel.app/?demo=1)

The frontend and backend run in one Vercel Hobby project, `applicationsplit-1607s-projects/gitgallery`, with a free Upstash Redis resource for shared sessions. Production deployment and public desktop/phone browser checks passed on 2026-10-20.

The account-owner marketplace acceptance is complete. The permanent `gitgallery-sessions` resource is available, reports the Free plan, and is connected only to this project for production and preview. Its creation explicitly disabled automatic paid upgrades and the paid production pack. Functions and Redis use Mumbai (`bom1`); builds run on Vercel’s build infrastructure. Node 22 and approval-code sign-in are configured. The Vercel project has no GitHub App repository connection; deployment used the local folder.

## What runs where

| Part | Location |
| --- | --- |
| Exported React frontend and demo assets | Vercel static hosting/CDN |
| GitHub sign-in and private-media API | Node.js Vercel Function, `app/api/index.mjs` |
| Sessions, pending GitHub approvals and sign-in rate counters | Upstash Redis over HTTPS |
| Original photos/videos and metadata | Each visitor's GitHub repository/release assets |
| Web favourites and albums | This browser's local storage |

Frontend and API share one origin, so existing HttpOnly, Secure, SameSite cookies and CSRF checks remain in place. Android and iOS continue to connect directly to GitHub.

## Free-plan expectations

Vercel Hobby is intended for personal, non-commercial projects. It avoids Render Free's fixed 15-minute idle-sleep behaviour, but functions can still cold-start and there is no promise of uninterrupted free hosting. Vercel documents monthly included limits such as 100 GB Fast Data Transfer, 10 GB Fast Origin Transfer, one million function invocations, four active CPU hours and 360 GB-hours of provisioned memory. Exhausting a free allowance can pause the affected feature until its reset. Authenticated media is relayed through the function, so photos and videos consume hosting bandwidth even though GitHub stores them.

Upstash advertises a free Redis tier with 500,000 commands/month and roughly 250 MB of storage. Keep automatic paid upgrades **disabled**, and leave the paid production pack off. Redis holds short-lived session information, not the photo library. Its quota is separate from Vercel's.

✅ Official sources checked on 2026-10-20: [Vercel Hobby limits and personal-use scope](https://vercel.com/docs/plans/hobby), [Vercel compute lifecycle](https://vercel.com/docs/fundamentals/what-is-compute), [Upstash pricing](https://upstash.com/pricing/redis), and [Render Free idle sleep](https://render.com/docs/free).

## Project settings

Use the `app` folder as the project root when importing the GitHub repository in the dashboard. The current CLI link was created from inside `app/`, where the linked root is `.`.

| Setting | Value |
| --- | --- |
| Framework preset | Other |
| Node.js | 22.x |
| Install command | `npm ci --include=dev` |
| Build command | `npm run build:web` |
| Output directory | `dist-web` |
| API | `api/index.mjs` |

`app/vercel.json` declares the build, Mumbai function region, function duration, API rewrite and response headers. Every `/api/:path*` request is sent to `api/index.mjs`; the handler restores the public route and removes internal routing metadata. The explicit rewrite supports nested sign-in and repository/media routes. The function explicitly enables response streaming. The native project directories, local environment files and test output are excluded by `.vercelignore`. Expo builds disable dotenv loading and remove server secrets from the bundler's environment.

## GitHub permissions

Deploying the local folder with the Vercel CLI does not require granting the Vercel GitHub App repository access. No GitHub integration is needed for that deployment method.

If automatic GitHub deployments are enabled later, select **Only select repositories** when configuring the GitHub App, and select only **labmember003/GIt-Gallery**. Do not select all repositories. Connect the project with repository root `app`. Deployment authorization does not authorize committing or pushing source changes; those remain the user's call.

## Configure sign-in and shared sessions

1. Sign in with `vercel login`, then link the existing project from `app/` using `vercel link --project gitgallery --scope applicationsplit-1607s-projects`.
2. Connect **Upstash for Redis**, selecting its free plan, automatic upgrades off and the paid production pack off. Vercel requires the account owner to accept the provider's marketplace terms on first use. Connect the resource to this project for production and preview.
3. Set `GITHUB_CLIENT_ID` to the existing GitGallery registration's client ID and set `WEB_AUTH_MODE=device`. Device Flow must be enabled on that registration. Keep `WEB_ALLOW_TOKEN_SIGN_IN=false`.
4. The Redis integration must provide `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, or the supported `KV_REST_API_URL` and `KV_REST_API_TOKEN` aliases. Store these in Vercel's server environment, never a public Expo variable or a tracked file.
5. Keep Vercel's system environment variables enabled. The server uses the production project domain in production and the deployment domain in preview. An explicit `WEB_ORIGIN` can override this; scope it carefully so previews do not accidentally use the production origin.
6. Run `vercel deploy --prod` from `app/`. A custom domain is optional.

For direct redirect sign-in instead of approval codes, add a server-only `GITHUB_CLIENT_SECRET`, set `WEB_AUTH_MODE=redirect`, and register the exact public callback `<WEB_ORIGIN>/api/auth/callback`. See [the sign-in guide](WEB-AUTH-SETUP.md). Visitors never configure OAuth credentials. GitHub's documented Device Flow verification-code submission limit makes redirect sign-in preferable for a larger audience.

✅ References: [Vercel Node functions](https://vercel.com/docs/functions/runtimes/node-js), [system environment variables](https://vercel.com/docs/environment-variables/system-environment-variables), [response-streaming configuration](https://vercel.com/docs/build-output-api/primitives), [Upstash integration](https://upstash.com/docs/redis/howto/vercelintegration), and [GitHub authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

## Session behaviour

On Vercel, missing Redis configuration fails closed rather than silently using process memory. Redis stores the signed-in account, private GitHub token, selected repository, CSRF value, pending authorization and provider polling interval. Keys expire with their session; signed-in sessions last at most eight hours. Session IDs rotate on sign-in and logout. Atomic compare-and-swap transitions prevent a cancelled attempt or a stale function instance from recreating a signed-out session. Polling leases expire if a function is interrupted. Sign-in rate counters are shared across instances and use Vercel's platform-supplied client IP header. Redis namespaces are isolated by the configured website origin.

Local preview still works without Redis using a single-process memory store, with the same snapshot/concurrency semantics. Those local sessions expire on restart. Configuring Redis also works with the existing standalone Node server.

## Verification and live status

Production deployment `dpl_GS93SQLgeB8nTzXfqypm2W6ELaTX` is READY and aliased to the live URL above. Unauthenticated HTTPS requests to the page, session API, demo image and credits JSON all returned HTTP 200. Session cookies include HttpOnly, Secure and SameSite=Lax; the API uses no-store.

Fresh Chromium contexts at 1440×1000 and 390×844 verified welcome/sign-in, real GitHub code issuance, authorization-pending polling, cancellation, session persistence across reload, 39 demo media cards, video playback/seeking and no horizontal overflow. The GitHub approval link opened github.com. Both runs reported zero browser errors and zero failed site requests; desktop and phone captures were inspected. No personal token or approval bypass was used.

A completed real-account sign-in and private-release download still require human consent. Those remain unverified on the live host; the fixture suite covers completed authorization and private-media access. Production private-media size/streaming limits are not claimed from static demo playback.

Local verification covers TypeScript, 12 library tests, 27 server/configuration/store tests and 16 Chromium browser tests. All 20 authentication tests also passed against a real temporary Upstash database using fixture GitHub responses only. A production Vercel Node builder check produced a Node 22 function with response streaming and the five expected API/server modules; environment files were absent. Desktop and phone onboarding captures were inspected. The separate live checks above verify public routing and onboarding; private-media platform limits still require a consented library test.

The temporary test database expires after 72 hours and must not be used as the production session store. The deployed app uses the permanent, account-owned `gitgallery-sessions` resource instead.

Automatic library setup is deployed in production (`dpl_EEz1GC2oAnQH9SLasYfABAqNMc4g`). Fresh desktop and phone browser sessions verified the new setup explanation, protected nested `/api/library/setup` route (401 while signed out), real sign-in code issuance/cancellation, and all 39 demo items, with zero browser errors or horizontal overflow. Local checks passed TypeScript, 12 library tests, 39 server tests and 21 browser tests. Four setup integration tests additionally passed against real temporary Redis with simulated GitHub responses. Actual GitHub repository creation/reuse through a visitor-approved account remains to be confirmed; no production user token was inspected.

The website and demo links are near the top of `README.md`. Documentation/source changes remain local until the user commits and pushes them; publishing the Vercel website does not publish those Git changes.
