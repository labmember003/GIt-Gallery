import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, assertAuthReady, missingOAuthSettings, signInMethod } from './config.mjs';

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gitgallery-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('local preview has no token login by default and never adopts native credentials', t => {
  const dir = directory(t);
  writeFileSync(join(dir, '.env'), 'EXPO_PUBLIC_GITHUB_TOKEN=native_fixture_token\nEXPO_PUBLIC_GITHUB_CLIENT_ID=native-client\n');
  const config = loadConfig(dir, {});
  assert.equal(config.allowTokenSignIn, false);
  assert.deepEqual(missingOAuthSettings(config), ['GITHUB_CLIENT_ID']);
  assert.doesNotThrow(() => assertAuthReady(config));
});

test('production accepts code sign-in with a client ID and requires a secret only for redirect mode', t => {
  const dir = directory(t);
  for (const settings of [{ WEB_ORIGIN: 'https://photos.example.com' }, { NODE_ENV: 'production' }]) {
    const config = loadConfig(dir, { ...settings });
    assert.throws(() => assertAuthReady(config), /GITHUB_CLIENT_ID/);
    config.clientId = 'app-client';
    assert.equal(signInMethod(config), 'device');
    assert.doesNotThrow(() => assertAuthReady(config));
    config.authMode = 'redirect';
    assert.throws(() => assertAuthReady(config), /GITHUB_CLIENT_SECRET.*website operator/);
    config.clientSecret = 'server-secret';
    assert.equal(signInMethod(config), 'redirect');
    assert.doesNotThrow(() => assertAuthReady(config));
    config.authMode = 'device';
    assert.equal(signInMethod(config), 'device');
  }
});

test('host settings override the local file and advanced token login requires explicit opt-in', t => {
  const dir = directory(t);
  writeFileSync(join(dir, '.env.web'), 'GITHUB_CLIENT_ID=local-client\nGITHUB_CLIENT_SECRET="local-secret"\nWEB_ALLOW_TOKEN_SIGN_IN=true\n');
  const config = loadConfig(dir, { GITHUB_CLIENT_SECRET: 'host-secret', WEB_ALLOW_TOKEN_SIGN_IN: 'false' });
  assert.equal(config.clientId, 'local-client');
  assert.equal(config.clientSecret, 'host-secret');
  assert.equal(config.allowTokenSignIn, false);
  assert.deepEqual(missingOAuthSettings(config), []);
  assert.equal(loadConfig(dir, {}).allowTokenSignIn, true);
});

test('Vercel requires shared sessions and never loads local development settings', t => {
  const dir = directory(t);
  writeFileSync(join(dir, '.env.web'), 'GITHUB_CLIENT_ID=local-client\nGITHUB_CLIENT_SECRET=local-secret\n');
  const config = loadConfig(dir, { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'gallery.example.com', VERCEL_URL: 'preview.example.com' });
  assert.equal(config.origin, 'https://gallery.example.com');
  assert.equal(config.clientId, '');
  config.clientId = 'host-client';
  assert.throws(() => assertAuthReady(config), /connect Upstash Redis/);
  config.redisUrl = 'https://redis.example.com'; config.redisToken = 'server-only-fixture';
  assert.doesNotThrow(() => assertAuthReady(config));
  const preview = loadConfig(dir, { VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: 'preview.example.com', KV_REST_API_URL: config.redisUrl, KV_REST_API_TOKEN: config.redisToken });
  assert.equal(preview.origin, 'https://preview.example.com');
  assert.equal(preview.redisToken, config.redisToken);
});
