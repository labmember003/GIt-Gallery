import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, missingOAuthSettings, signInMethod, assertAuthReady } from '../server/config.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(app);
const missing = missingOAuthSettings(config);
console.log('GitGallery website operator check — visitors never configure credentials.');
console.log(`Website: ${config.origin}`);
console.log(`Sign-in method: ${signInMethod(config) ?? 'not configured'}`);
if (signInMethod(config) === 'redirect') console.log(`GitHub callback: ${config.origin}/api/auth/callback`);
console.log(`Client ID: ${config.clientId ? 'set' : 'missing'}`);
console.log(`Client secret: ${config.clientSecret ? 'set' : config.authMode === 'redirect' ? 'missing' : 'not needed for approval codes'}`);
console.log(`Advanced token sign-in: ${config.allowTokenSignIn ? 'enabled' : 'off (normal user experience)'}`);
console.log(`Session storage: ${config.redisUrl && config.redisToken ? 'shared Redis' : config.vercel ? 'missing (required on Vercel)' : 'local memory (single-process preview)'}`);
try { assertAuthReady(config); } catch (error) { console.error(error.message); process.exitCode = 1; }
if (missing.length) {
  console.error(`Sign-in setup is incomplete. Set ${missing.join(' and ')} in app/.env.web or the host's secret settings.`);
  console.error('Follow docs/WEB-AUTH-SETUP.md. These settings are shared by the website; each visitor signs in to their own GitHub account.');
  process.exitCode = 1;
} else {
  console.log(signInMethod(config) === 'device'
    ? 'Approval-code sign-in is configured. Device Flow must be enabled on the GitHub registration. Visitors copy a code, approve on GitHub, and return to choose their library.'
    : 'Redirect sign-in is configured. Complete a real GitHub sign-in to verify the secret, callback and repository access.');
}
