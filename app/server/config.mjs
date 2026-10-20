import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadConfig(app, env = process.env) {
  const local = {};
  const file = resolve(app, '.env.web');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match) local[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  const value = (key, fallback = '') => env[key] ?? local[key] ?? fallback;
  const port = Number(value('PORT', '8082'));
  const origin = new URL(value('WEB_ORIGIN', `http://127.0.0.1:${port}`));
  const authMode = value('WEB_AUTH_MODE', 'auto');
  if (!['auto', 'device', 'redirect'].includes(authMode)) throw new Error('WEB_AUTH_MODE must be auto, device, or redirect.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('WEB_ORIGIN must be an origin without a path or credentials.');
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) throw new Error('Public web hosting requires an HTTPS WEB_ORIGIN.');
  return { port, host: value('HOST', '127.0.0.1'), origin: origin.origin,
    clientId: value('GITHUB_CLIENT_ID'), clientSecret: value('GITHUB_CLIENT_SECRET'),
    authMode,
    allowTokenSignIn: value('WEB_ALLOW_TOKEN_SIGN_IN', 'false') === 'true',
    requireOAuth: env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) };
}

export function missingOAuthSettings(config) {
  return [!config.clientId && 'GITHUB_CLIENT_ID', config.authMode === 'redirect' && !config.clientSecret && 'GITHUB_CLIENT_SECRET'].filter(Boolean);
}

export function signInMethod(config) {
  if (missingOAuthSettings(config).length) return null;
  return config.authMode === 'device' || !config.clientSecret ? 'device' : 'redirect';
}

export function assertAuthReady(config) {
  const missing = missingOAuthSettings(config);
  if (config.requireOAuth && missing.length) {
    throw new Error(`GitHub sign-in is not ready: set ${missing.join(' and ')} in the server environment. This is a one-time task for the website operator, not each user. See docs/WEB-AUTH-SETUP.md. Callback: ${config.origin}/api/auth/callback`);
  }
}
