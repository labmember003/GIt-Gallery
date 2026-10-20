# GitHub sign-in and onboarding

The website guides each visitor through signing in to **their own GitHub account**, approving GitGallery and choosing their photo repository. Users do not create developer credentials or personal tokens.

## What a visitor does

1. Click **Continue with GitHub**.
2. When the approval-code screen appears, click **Copy code**.
3. Click **Open GitHub to approve**. On GitHub, sign in, enter the code and approve GitGallery.
4. Return to the GitGallery tab. It continues automatically to the repository picker after approval.
5. Choose the repository used by GitGallery on the phone. The website displays that backup.

The instructions, copy button, GitHub link, expiry countdown and waiting status are all in the app. An expired or denied code offers a new attempt. Cancellation stops the pending sign-in; a late response cannot authenticate a cancelled attempt. A network problem offers a check-again action.

New users need a GitHub account and a photo backup from the mobile app. The website currently reads existing backups; browser uploads are not implemented. If a shared website has no GitHub registration configured, its sign-in screen explains that the website owner must enable it and provides expandable setup steps for self-hosters, plus public-repository access.

## Why no new secret is needed here

GitHub supports an approval-code method called **Device Flow**. It uses the existing app registration's public client ID and requires the visitor to approve access on GitHub. It does not require a client secret or callback URL. The mobile app already uses it, and the existing registration was checked against GitHub's live code endpoint on 2026-10-20: code issuance succeeded with a five-second minimum polling interval.

The server keeps the private device credential and resulting GitHub token. The browser only receives the human-facing code and an attempt identifier tied to its session. Polling honours GitHub's interval and increases it on `slow_down`. Sessions still use HttpOnly cookies, CSRF checks, identity validation and session-ID rotation.

✅ [GitHub Device Flow documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) confirms these requirements. GitHub documents a limit of **50 verification-code submissions per hour per application**. For a widely used public website, configure redirect sign-in to avoid that device-flow constraint. Redirect sign-in also avoids the user's copy-code step.

## Website operator configuration

This is configured once for the website, not separately by every visitor. `app/.env.web` is gitignored and read by the Node server. Its current client ID comes from the existing mobile app registration; no native development token is reused.

```dotenv
GITHUB_CLIENT_ID=your_registered_app_id
WEB_AUTH_MODE=auto
WEB_ORIGIN=http://127.0.0.1:8082
```

With a client ID and no client secret, `auto` uses approval codes. **Enable Device Flow** in that registration's [GitHub Developer settings](https://github.com/settings/developers). The existing registration already accepted the live code request. No new registration or secret is required for this local flow.

```bash
cd app
npm run check:web
npm run build:web
npm run preview:web
```

Stop an existing preview before restarting it after configuration changes. Open `http://127.0.0.1:8082` and refresh an old tab. `check:web` reports settings and the selected flow without printing credential values. Code issuance and a pending approval can be verified without signing in; completing a real account test still requires that person to approve GitGallery on GitHub.

| `WEB_AUTH_MODE` | Behaviour |
|---|---|
| `auto` (default) | Redirect when client ID and secret are present; approval codes when only the ID is present |
| `device` | Always use approval codes; requires a client ID and Device Flow enabled on GitHub |
| `redirect` | Always use browser redirects; requires the client ID, secret and a matching GitHub callback |

## Optional direct browser redirects

For redirect sign-in, obtain the client secret for the same registration, store it as `GITHUB_CLIENT_SECRET` on the server, and register `<WEB_ORIGIN>/api/auth/callback` as GitHub's callback. For local testing that is `http://127.0.0.1:8082/api/auth/callback`. Set `WEB_AUTH_MODE=redirect` to require this method explicitly. Visitors then approve on GitHub and return automatically without copying a code.

✅ [GitHub's web authorization flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#web-application-flow) requires a client secret. This requirement applies to redirect sign-in; it does not block approval-code sign-in.

## Hosting and optional advanced access

Run the Node website behind HTTPS, set `WEB_ORIGIN` to its public origin, and set `HOST=0.0.0.0` if the host needs it. Preserve the configured Host header through the reverse proxy. Production startup validates the credentials required for the selected method. Static hosting of `dist-web` alone does not provide authentication.

Personal-token login remains disabled by default. A self-hosting operator may explicitly enable `WEB_ALLOW_TOKEN_SIGN_IN=true`; it appears under **Advanced sign-in**. Ordinary users use the guided GitHub flow.

See [WEB-PLAN.md](WEB-PLAN.md) for session limits, hosting and remaining features. Full authorization and private-release verification with a real account still require human consent; automated tests use fixture responses for that portion.
