import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RefreshRejectedError, refreshGrant, pollForToken, type GitHubGrant } from '../auth';
import { createRenewer, RENEW_MARGIN_MS, type RenewalStore } from '../authRenewal';

process.env.EXPO_PUBLIC_GITHUB_CLIENT_ID = 'test-client';

const HOUR = 3_600_000;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function grant(n: number, at: number): GitHubGrant {
  return { accessToken: `ghu_${n}`, refreshToken: `ghr_${n}`, expiresAt: at + 8 * HOUR, refreshExpiresAt: at + 4380 * HOUR };
}

/** The app's store, in memory; `saved` is what reached "disk". */
function memoryStore(initial: GitHubGrant | null) {
  const state = {
    token: initial?.accessToken ?? null,
    refresh: initial?.refreshToken ? { refreshToken: initial.refreshToken, expiresAt: initial.expiresAt } : null,
    saved: [] as GitHubGrant[],
    refused: [] as string[],
    ended: [] as string[],
  };
  const store: RenewalStore = {
    token: () => state.token,
    refresh: () => state.refresh,
    save: async (g) => {
      await new Promise((r) => setTimeout(r, 5));
      state.token = g.accessToken;
      state.refresh = g.refreshToken ? { refreshToken: g.refreshToken, expiresAt: g.expiresAt } : null;
      state.saved.push(g);
    },
    refused: (t) => { state.refresh = null; state.refused.push(t); },
    ended: (t) => { state.ended.push(t); },
  };
  return { state, store };
}

test('sign-in keeps the refresh token and both expiry times GitHub sends', async () => {
  const at = 1_000_000;
  const result = await pollForToken('dev', {
    intervalSec: 5, now: () => at, sleep: async () => {},
    fetchImpl: async () => json({ access_token: 'ghu_a', refresh_token: 'ghr_a', expires_in: 28800, refresh_token_expires_in: 15897600, token_type: 'bearer', scope: 'repo' }),
  });
  assert.deepEqual(result, { accessToken: 'ghu_a', refreshToken: 'ghr_a', expiresAt: at + 28_800_000, refreshExpiresAt: at + 15_897_600_000 });
});

test('a token that never expires has no refresh token', async () => {
  const result = await pollForToken('dev', { intervalSec: 5, sleep: async () => {}, fetchImpl: async () => json({ access_token: 'gho_old', scope: 'repo' }) });
  assert.deepEqual(result, { accessToken: 'gho_old', refreshToken: null, expiresAt: null, refreshExpiresAt: null });
});

test('refreshGrant sends the refresh grant with no client secret', async () => {
  let sent = '';
  const result = await refreshGrant('ghr_a', {
    now: () => 0,
    fetchImpl: async (url, init) => { assert.equal(url, 'https://github.com/login/oauth/access_token'); sent = init.body; return json({ access_token: 'ghu_b', refresh_token: 'ghr_b', expires_in: 28800 }); },
  });
  const body = new URLSearchParams(sent);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'ghr_a');
  assert.equal(body.get('client_id'), 'test-client');
  assert.equal(body.has('client_secret'), false);
  assert.equal(result.accessToken, 'ghu_b');
  assert.equal(result.refreshToken, 'ghr_b');
});

test('refreshGrant: GitHub saying no is final, an unreachable GitHub is not', async () => {
  await assert.rejects(refreshGrant('ghr_dead', { fetchImpl: async () => json({ error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' }) }), RefreshRejectedError);
  const offline = await refreshGrant('ghr_a', { fetchImpl: async () => { throw new TypeError('Network request failed'); } }).catch((e) => e);
  assert.ok(offline instanceof Error && !(offline instanceof RefreshRejectedError));
  const portal = await refreshGrant('ghr_a', { fetchImpl: async () => new Response('<html>Wi-Fi login</html>') }).catch((e) => e);
  assert.ok(portal instanceof Error && !(portal instanceof RefreshRejectedError));
});

test('a token with time left is used as is; one about to expire is renewed first', async () => {
  let now = 0;
  const { state, store } = memoryStore(grant(1, 0));
  let renewals = 0;
  const { freshToken } = createRenewer(store, { now: () => now, renew: async () => grant(2 + renewals++, now) });
  assert.equal(await freshToken(), 'ghu_1');
  now = 8 * HOUR - RENEW_MARGIN_MS - 1;
  assert.equal(await freshToken(), 'ghu_1');
  now = 8 * HOUR - RENEW_MARGIN_MS + 1;
  assert.equal(await freshToken(), 'ghu_2');
  assert.equal(state.saved.length, 1, 'the new pair is saved before it is used');
  assert.equal(state.refresh?.refreshToken, 'ghr_2');
  // Days later, long after the access token ran out: the refresh token still works.
  now += 72 * HOUR;
  assert.equal(await freshToken(), 'ghu_3');
});

test('calls that all find the token expired share one renewal', async () => {
  const { store } = memoryStore(grant(1, 0));
  let renewals = 0;
  const { freshToken } = createRenewer(store, {
    now: () => 9 * HOUR,
    renew: async (refreshToken) => {
      renewals++;
      assert.equal(refreshToken, 'ghr_1', 'a used refresh token is never sent again');
      await new Promise((r) => setTimeout(r, 20));
      return grant(2, 9 * HOUR);
    },
  });
  const tokens = await Promise.all(Array.from({ length: 6 }, () => freshToken()));
  assert.deepEqual(tokens, Array(6).fill('ghu_2'));
  assert.equal(renewals, 1);
});

test('a 401 renews once and retries; a 401 for an already replaced token just uses the new one', async () => {
  const { state, store } = memoryStore(grant(1, 0));
  let renewals = 0;
  const { withFreshToken, freshToken } = createRenewer(store, { now: () => HOUR, renew: async () => grant(2 + renewals++, HOUR) });
  const seen: string[] = [];
  const result = await withFreshToken(async (token) => { seen.push(token); return { status: token === 'ghu_1' ? 401 : 200 }; });
  assert.equal(result.status, 200);
  assert.deepEqual(seen, ['ghu_1', 'ghu_2']);
  assert.equal(renewals, 1);
  assert.equal(await freshToken({ rejected: 'ghu_1' }), 'ghu_2');
  assert.equal(renewals, 1, 'an old 401 does not renew again');
  assert.deepEqual(state.ended, []);
});

test('GitHub refusing the refresh token ends the sign-in once, without retrying it on every call', async () => {
  const { state, store } = memoryStore(grant(1, 0));
  let renewals = 0;
  const { withFreshToken, freshToken } = createRenewer(store, {
    now: () => 9 * HOUR,
    renew: async () => { renewals++; throw new RefreshRejectedError('bad_refresh_token'); },
  });
  const result = await withFreshToken(async () => ({ status: 401 }));
  assert.equal(result.status, 401);
  assert.deepEqual(state.refused, ['ghu_1']);
  assert.deepEqual(state.ended, ['ghu_1']);
  assert.equal(await freshToken(), 'ghu_1');
  assert.equal(renewals, 1);
});

test('offline: the renewal fails quietly and the next call tries again', async () => {
  const { state, store } = memoryStore(grant(1, 0));
  let online = false;
  const { freshToken } = createRenewer(store, {
    now: () => 9 * HOUR,
    renew: async () => { if (!online) throw new Error('Could not reach GitHub'); return grant(2, 9 * HOUR); },
  });
  assert.equal(await freshToken(), 'ghu_1');
  assert.deepEqual(state.refused, []);
  online = true;
  assert.equal(await freshToken(), 'ghu_2');
});

test('signing out while GitHub is answering does not bring the old sign-in back', async () => {
  const { state, store } = memoryStore(grant(1, 0));
  const { freshToken } = createRenewer(store, {
    now: () => 9 * HOUR,
    renew: async () => { state.token = null; state.refresh = null; return grant(2, 9 * HOUR); },
  });
  assert.equal(await freshToken(), null);
  assert.deepEqual(state.saved, []);
});

test('a token without a refresh token (older sign-ins) is never renewed; a 401 ends it', async () => {
  const { state, store } = memoryStore({ accessToken: 'gho_old', refreshToken: null, expiresAt: null, refreshExpiresAt: null });
  const { withFreshToken } = createRenewer(store, { now: () => 0, renew: async () => assert.fail('nothing to renew with') });
  const result = await withFreshToken(async () => ({ status: 401 }));
  assert.equal(result.status, 401);
  assert.deepEqual(state.ended, ['gho_old']);
});
