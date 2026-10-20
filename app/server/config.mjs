import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadConfig(app, env = process.env) {
  const vercel = env.VERCEL === '1';
  const local = {};
  const file = resolve(app, '.env.web');
  if (!vercel && existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match) local[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  const value = (key, fallback = '') => env[key] ?? local[key] ?? fallback;
  const port = Number(value('PORT', '8082'));
  const deploymentHost = env.VERCEL_ENV === 'production' ? env.VERCEL_PROJECT_PRODUCTION_URL ?? env.VERCEL_URL : env.VERCEL_URL;
  const origin = new URL(value('WEB_ORIGIN', vercel && deploymentHost ? `https://${deploymentHost}` : `http://127.0.0.1:${port}`));
  const authMode = value('WEB_AUTH_MODE', 'auto');
  if (!['auto', 'device', 'redirect'].includes(authMode)) throw new Error('WEB_AUTH_MODE must be auto, device, or redirect.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('WEB_ORIGIN must be an origin without a path or credentials.');
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) throw new Error('Public web hosting requires an HTTPS WEB_ORIGIN.');
  if (vercel && origin.protocol !== 'https:') throw new Error('Set an HTTPS WEB_ORIGIN or enable Vercel system environment variables for the deployment domain.');
  return { port, host: value('HOST', '127.0.0.1'), origin: origin.origin,
    clientId: value('GITHUB_CLIENT_ID'), clientSecret: value('GITHUB_CLIENT_SECRET'),
    authMode, vercel,
    redisUrl: value('UPSTASH_REDIS_REST_URL') || value('KV_REST_API_URL'),
    redisToken: value('UPSTASH_REDIS_REST_TOKEN') || value('KV_REST_API_TOKEN'),
    allowTokenSignIn: value('WEB_ALLOW_TOKEN_SIGN_IN', 'false') === 'true',
    requireOAuth: vercel || env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) };
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
  if ((config.redisUrl && !config.redisToken) || (!config.redisUrl && config.redisToken) || (config.vercel && (!config.redisUrl || !config.redisToken))) {
    throw new Error('Shared sessions are not ready: connect Upstash Redis and set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (KV_REST_API_URL and KV_REST_API_TOKEN are also supported). See docs/WEB-DEPLOYMENT.md.');
  }
}
