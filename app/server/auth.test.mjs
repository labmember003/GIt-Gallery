import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createAuthHandler } from './auth.mjs';
import { createMemorySessionStore, createRedisSessionStore, StoreUnavailable } from './session-store.mjs';
import { createVercelHandler } from './vercel.mjs';

const TOKEN = 'test_token_for_fixture_only_1234567890';
const SECRET = 'fixture_client_secret_only';
const SHA = 'a'.repeat(40);
const DEVICE = { device_code: 'server_only_device_code_fixture', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 };
const REPOSITORY_LIST = 'https://api.github.com/user/repos?per_page=100&page=1&sort=updated&affiliation=owner,collaborator,organization_member';
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
async function setup(t, overrides = {}, options = {}) {
  let time = Date.now();
  const config = { origin: '', clientId: 'test-client-id', clientSecret: SECRET, allowTokenSignIn: true };
  const requests = [];
  const fetcher = async (input, options = {}) => {
    const url = String(input); requests.push({ url, options });
    if (overrides[url]) return overrides[url](options);
    if (url === 'https://github.com/login/oauth/access_token') return json({ access_token: TOKEN, expires_in: 3600 });
    if (url === 'https://api.github.com/user') return json({ id: 7, login: 'tester', name: 'Test User' });
    if (url.startsWith('https://api.github.com/user/repos?')) return json([{ id: 3, full_name: 'tester/photos', default_branch: 'main', private: true, permissions: { push: false } }], 200, { link: '<https://api.github.com/user/repos?page=2>; rel="next"' });
    if (url === 'https://api.github.com/repos/tester/photos') return json({ full_name: 'tester/photos', default_branch: 'main' });
    if (url.includes('/git/trees/')) return json({ sha: 'root', tree: [] });
    if (url.endsWith(`/git/blobs/${SHA}`)) return new Response('image bytes', { headers: { 'content-type': 'image/webp' } });
    return json({}, 404);
  };
  const redis = process.env.GITGALLERY_TEST_REDIS_URL && process.env.GITGALLERY_TEST_REDIS_TOKEN;
  const store = options.store ?? (redis ? createRedisSessionStore({ origin: `https://fixture-${randomUUID()}.example`,
    redisUrl: process.env.GITGALLERY_TEST_REDIS_URL, redisToken: process.env.GITGALLERY_TEST_REDIS_TOKEN }, { now: () => time }) : createMemorySessionStore({ now: () => time }));
  const makeHandler = () => (options.freshInstance ? createVercelHandler : createAuthHandler)(config, { fetcher, now: () => time, store });
  const handler = makeHandler();
  const server = createServer(async (req, res) => { if (!await (options.freshInstance ? makeHandler() : handler)(req, res) && !res.writableEnded) res.writeHead(404).end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  let cookie = ''; let csrf = '';
  async function call(path, data, headers = {}) {
    const response = await fetch(`${config.origin}${path}`, { redirect: 'manual', method: data === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, ...(data === undefined ? {} : { Origin: config.origin, 'Content-Type': 'application/json', 'X-GitGallery-CSRF': csrf }), ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  }
  async function session() { const response = await call('/api/session'); const result = await response.json(); csrf = result.csrf; return result; }
  async function login() { await session(); const response = await call('/api/auth/token', { token: TOKEN }); const result = await response.json(); assert.equal(response.status, 200); csrf = result.csrf; return result; }
  return { call, session, login, requests, config, advance(ms) { time += ms; }, getCookie: () => cookie, getCsrf: () => csrf };
}

test('automatic setup is authenticated, CSRF protected, and restores an existing library across Vercel instances', async t => {
  const app = await setup(t, {
    'https://api.github.com/repos/tester/gitgallery-photos': () => json({ full_name: 'tester/gitgallery-photos', default_branch: 'trunk', private: true }),
  }, { freshInstance: true });
  await app.session();
  assert.equal((await app.call('/api/library/setup', {})).status, 401);
  await app.login();
  assert.equal((await app.call('/api/library/setup', {}, { 'X-GitGallery-CSRF': 'wrong' })).status, 403);
  const prepared = await app.call('/api/index?__gg_path=library%2Fsetup', {});
  assert.equal(prepared.status, 200);
  const result = await prepared.json();
  assert.equal(result.status, 'ready'); assert.equal(result.created, false);
  assert.deepEqual(result.session.selectedRepo, { owner: 'tester', name: 'gitgallery-photos', branch: 'trunk' });
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.deepEqual((await app.session()).selectedRepo, result.session.selectedRepo);
  const calls = app.requests.length;
  assert.equal((await (await app.call('/api/library/setup', {})).json()).status, 'ready');
  assert.equal(app.requests.length, calls);
  const query = await app.call('/api/index?__gg_path=repositories&page=2');
  assert.equal(query.status, 200);
  assert.match(app.requests.at(-1).url, /page=2&/);
});

test('first-time automatic setup creates a private initialized repository with only server-held credentials', async t => {
  let writes = 0;
  const app = await setup(t, {
    [REPOSITORY_LIST]: () => json([]),
    'https://api.github.com/user/repos': options => {
      writes++; assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(JSON.parse(options.body), { name: 'gitgallery-photos', description: 'Private repo for GitGallery', private: true, auto_init: true });
      return json({ full_name: 'tester/gitgallery-photos', default_branch: 'main', private: true }, 201);
    },
  });
  await app.login();
  const response = await app.call('/api/library/setup', {});
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.created, true); assert.equal(result.session.selectedRepo.name, 'gitgallery-photos');
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal((await app.call('/api/library/setup', {})).status, 200); assert.equal(writes, 1);
});

test('another cold handler waits for active setup and logout prevents a late creation', async t => {
  let entered; let release;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let writes = 0;
  const app = await setup(t, {
    'https://api.github.com/repos/tester/gitgallery-photos': async () => { entered(); await gate; return json({}, 404); },
    [REPOSITORY_LIST]: () => json([]),
    'https://api.github.com/user/repos': () => { writes++; return json({}, 201); },
  }, { freshInstance: true });
  await app.login();
  const pending = app.call('/api/library/setup', {});
  await reached;
  const concurrent = await app.call('/api/library/setup', {});
  assert.equal(concurrent.status, 202); assert.equal((await concurrent.json()).status, 'pending');
  await app.call('/api/auth/logout', {});
  release();
  assert.equal((await pending).status, 409); assert.equal(writes, 0);
  assert.equal((await app.session()).user, null);
});

test('a failed setup releases its lease so retry can discover an existing library', async t => {
  let failed = true;
  const app = await setup(t, {
    'https://api.github.com/repos/tester/gitgallery-photos': () => failed ? json({}, 403) : json({ full_name: 'tester/gitgallery-photos', default_branch: 'main', private: true }),
  });
  await app.login();
  const denied = await app.call('/api/library/setup', {});
  assert.equal(denied.status, 403); assert.match((await denied.json()).error, /sign out and sign in/);
  failed = false;
  assert.equal((await (await app.call('/api/library/setup', {})).json()).status, 'ready');
});

test('OAuth uses state and PKCE, rotates the cookie, and exposes no credentials', async t => {
  const app = await setup(t); const initial = await app.session(); const old = app.getCookie();
  assert.equal(initial.user, null); assert.equal(initial.oauthAvailable, true);
  const started = await app.call('/api/auth/start', {}); const target = new URL((await started.json()).url);
  assert.equal(target.origin, 'https://github.com'); assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(target.searchParams.get('redirect_uri'), `${app.config.origin}/api/auth/callback`);
  const state = target.searchParams.get('state');
  const callback = await app.call(`/api/auth/callback?code=test-code&state=${state}`);
  assert.equal(callback.status, 303); assert.equal(callback.headers.get('location'), `${app.config.origin}/`);
  assert.notEqual(app.getCookie(), old); assert.match(callback.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const exchanged = app.requests.find(request => request.url === 'https://github.com/login/oauth/access_token');
  const form = new URLSearchParams(exchanged.options.body);
  assert.equal(form.get('client_secret'), SECRET);
  assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), target.searchParams.get('code_challenge'));
  const current = await app.session(); assert.equal(current.user.login, 'tester');
  assert.ok(!JSON.stringify(current).includes(TOKEN)); assert.ok(!JSON.stringify(current).includes(SECRET));
  const replay = await app.call(`/api/auth/callback?code=test-code&state=${state}`);
  assert.match(replay.headers.get('location'), /auth_error=/);
  assert.equal(app.requests.filter(request => request.url === 'https://github.com/login/oauth/access_token').length, 1);
});

test('invalid state and denied consent never exchange an authorization code', async t => {
  const app = await setup(t); await app.session();
  const target = new URL((await (await app.call('/api/auth/start', {})).json()).url);
  const wrong = await app.call('/api/auth/callback?code=bad&state=wrong');
  assert.match(wrong.headers.get('location'), /auth_error=/);
  const denied = await app.call(`/api/auth/callback?error=access_denied&state=${target.searchParams.get('state')}`);
  assert.match(decodeURIComponent(denied.headers.get('location')), /cancelled/);
  assert.equal(app.requests.length, 0);
});

test('approval codes sign in without a secret, keep device credentials on the server and rotate sessions', async t => {
  let approved = false;
  const app = await setup(t, {
    'https://github.com/login/device/code': () => json(DEVICE),
    'https://github.com/login/oauth/access_token': options => {
      const params = new URLSearchParams(options.body);
      assert.equal(params.get('device_code'), DEVICE.device_code);
      assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
      assert.equal(params.has('client_secret'), false);
      return json(approved ? { access_token: TOKEN } : { error: 'authorization_pending' });
    },
  });
  app.config.clientSecret = '';
  assert.equal((await app.session()).signInMethod, 'device');
  const old = app.getCookie();
  const started = await (await app.call('/api/auth/start', {})).json();
  assert.equal(started.method, 'device'); assert.equal(started.userCode, DEVICE.user_code);
  assert.ok(!JSON.stringify(started).includes(DEVICE.device_code));
  assert.equal((await (await app.call('/api/auth/start', {})).json()).attemptId, started.attemptId);
  assert.equal(app.requests.filter(item => item.url.endsWith('/device/code')).length, 1);
  app.advance(5000);
  assert.equal((await (await app.call('/api/auth/device/poll', { attemptId: started.attemptId })).json()).status, 'pending');
  approved = true; app.advance(5000);
  const result = await (await app.call('/api/auth/device/poll', { attemptId: started.attemptId })).json();
  assert.equal(result.status, 'authenticated'); assert.equal(result.session.user.login, 'tester');
  assert.notEqual(app.getCookie(), old);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.ok(!JSON.stringify(result).includes(DEVICE.device_code));
});

test('device polling enforces the provider interval and adds five seconds on slow_down', async t => {
  const app = await setup(t, {
    'https://github.com/login/device/code': () => json(DEVICE),
    'https://github.com/login/oauth/access_token': () => json({ error: 'slow_down', interval: 10 }),
  });
  app.config.clientSecret = ''; await app.session();
  const { attemptId } = await (await app.call('/api/auth/start', {})).json();
  const polls = () => app.requests.filter(item => item.url.endsWith('/access_token')).length;
  assert.equal((await (await app.call('/api/auth/device/poll', { attemptId })).json()).retryAfter, 5);
  assert.equal(polls(), 0);
  app.advance(5000);
  assert.equal((await (await app.call('/api/auth/device/poll', { attemptId })).json()).retryAfter, 10);
  app.advance(9000); await app.call('/api/auth/device/poll', { attemptId }); assert.equal(polls(), 1);
  app.advance(1000);
  assert.equal((await (await app.call('/api/auth/device/poll', { attemptId })).json()).retryAfter, 15);
  assert.equal(polls(), 2);
});

test('device denial, expiry, wrong attempts and CSRF cannot authenticate a visitor', async t => {
  for (const [error, expected] of [['access_denied', 403], ['expired_token', 410]]) {
    const app = await setup(t, {
      'https://github.com/login/device/code': () => json(DEVICE),
      'https://github.com/login/oauth/access_token': () => json({ error }),
    });
    app.config.clientSecret = ''; await app.session();
    const { attemptId } = await (await app.call('/api/auth/start', {})).json();
    app.advance(5000);
    assert.equal((await app.call('/api/auth/device/poll', { attemptId: 'someone-elses-attempt' })).status, 409);
    assert.equal((await app.call('/api/auth/device/poll', { attemptId }, { 'X-GitGallery-CSRF': 'wrong' })).status, 403);
    assert.equal((await app.call('/api/auth/device/poll', { attemptId })).status, expected);
    assert.equal((await app.session()).user, null);
    assert.equal((await app.call('/api/auth/device/poll', { attemptId })).status, 409);
  }
  const expired = await setup(t, { 'https://github.com/login/device/code': () => json(DEVICE) });
  expired.config.clientSecret = ''; await expired.session();
  const { attemptId } = await (await expired.call('/api/auth/start', {})).json();
  expired.advance(900001);
  assert.equal((await expired.call('/api/auth/device/poll', { attemptId })).status, 410);
  assert.equal(expired.requests.filter(item => item.url.endsWith('/access_token')).length, 0);
});

test('cancelling during a device poll prevents a late approval from creating a session', async t => {
  let release; let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const app = await setup(t, {
    'https://github.com/login/device/code': () => json(DEVICE),
    'https://github.com/login/oauth/access_token': () => { entered(); return new Promise(resolve => { release = () => resolve(json({ access_token: TOKEN })); }); },
  });
  app.config.clientSecret = ''; await app.session();
  const { attemptId } = await (await app.call('/api/auth/start', {})).json();
  app.advance(5000);
  const polling = app.call('/api/auth/device/poll', { attemptId });
  await waiting;
  // A second browser poll must not make another upstream token request.
  assert.equal((await (await app.call('/api/auth/device/poll', { attemptId })).json()).status, 'pending');
  assert.equal((await app.call('/api/auth/device/cancel', { attemptId })).status, 200);
  release();
  assert.equal((await polling).status, 409);
  assert.equal((await app.session()).user, null);
  assert.equal(app.requests.filter(item => item.url.endsWith('/access_token')).length, 1);
  assert.equal(app.requests.filter(item => item.url.endsWith('/user')).length, 0);
});

test('device setup rejects untrusted verification links and explains disabled registrations', async t => {
  const untrusted = await setup(t, { 'https://github.com/login/device/code': () => json({ ...DEVICE, verification_uri: 'https://evil.example/verify' }) });
  untrusted.config.clientSecret = ''; await untrusted.session();
  assert.equal((await untrusted.call('/api/auth/start', {})).status, 502);
  const disabled = await setup(t, { 'https://github.com/login/device/code': () => json({ error: 'device_flow_disabled' }, 400) });
  disabled.config.clientSecret = ''; await disabled.session();
  const response = await disabled.call('/api/auth/start', {});
  assert.equal(response.status, 503); assert.match(await response.text(), /enable Device Flow/);
});

test('unconfigured sign-in gives visitors a plain message and token login is operator-controlled', async t => {
  const app = await setup(t);
  app.config.clientId = '';
  app.config.clientSecret = '';
  app.config.allowTokenSignIn = false;
  const session = await app.session();
  assert.equal(session.oauthAvailable, false);
  assert.equal(session.tokenSignInAvailable, false);
  const start = await app.call('/api/auth/start', {});
  assert.equal(start.status, 503);
  const message = await start.text();
  assert.match(message, /setup instructions/i);
  assert.doesNotMatch(message, /client.secret|\.env|personal access token|configuration/i);
  assert.equal((await app.call('/api/auth/token', { token: TOKEN })).status, 404);
  assert.equal(app.requests.length, 0);
});

test('mutation requests require both same origin and session CSRF token', async t => {
  const app = await setup(t); await app.session();
  assert.equal((await app.call('/api/auth/token', { token: TOKEN }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.call('/api/auth/token', { token: TOKEN }, { 'X-GitGallery-CSRF': 'wrong' })).status, 403);
  assert.equal((await app.call('/api/session', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(app.requests.length, 0);
});

test('selected library survives reload; logout invalidates old sessions', async t => {
  const app = await setup(t); await app.login();
  const repos = await (await app.call('/api/repositories')).json();
  assert.equal(repos.repositories[0].fullName, 'tester/photos'); assert.equal(repos.hasMore, true);
  const selected = await (await app.call('/api/repository', { repository: 'tester/photos' })).json();
  assert.deepEqual(selected.selectedRepo, { owner: 'tester', name: 'photos', branch: 'main' });
  assert.deepEqual((await app.session()).selectedRepo, selected.selectedRepo);
  const old = app.getCookie();
  const logout = await (await app.call('/api/auth/logout', {})).json(); assert.equal(logout.user, null); assert.equal(logout.selectedRepo, null);
  assert.equal((await app.call('/api/repositories', undefined, { Cookie: old })).status, 401);
});

test('two visitors have independent identities, repositories and logout sessions', async t => {
  const otherToken = 'other_visitor_fixture_token_123456789';
  const app = await setup(t, {
    'https://api.github.com/user': options => options.headers.Authorization === `Bearer ${otherToken}`
      ? json({ id: 8, login: 'other', name: 'Other Visitor' })
      : json({ id: 7, login: 'tester', name: 'Test Visitor' }),
    'https://api.github.com/repos/other/photos': () => json({ full_name: 'other/photos', default_branch: 'main' }),
  });
  await app.login();
  await app.call('/api/repository', { repository: 'tester/photos' });
  const firstCookie = app.getCookie();
  const firstCsrf = app.getCsrf();
  const anonymous = await (await app.call('/api/session', undefined, { Cookie: '' })).json();
  const second = await (await app.call('/api/auth/token', { token: otherToken }, { 'X-GitGallery-CSRF': anonymous.csrf })).json();
  const secondCookie = app.getCookie();
  await app.call('/api/repository', { repository: 'other/photos' }, { 'X-GitGallery-CSRF': second.csrf });
  assert.notEqual(firstCookie, secondCookie);
  assert.equal(second.user.login, 'other');
  const first = await (await app.call('/api/session', undefined, { Cookie: firstCookie })).json();
  assert.equal(first.user.login, 'tester');
  assert.equal(first.selectedRepo.owner, 'tester');
  const forbidden = await app.call(`/api/github/repos/tester/photos/git/blobs/${SHA}`, undefined, { Cookie: secondCookie, Accept: 'application/vnd.github.raw+json' });
  assert.equal(forbidden.status, 403);
  await app.call('/api/auth/logout', {}, { Cookie: firstCookie, 'X-GitGallery-CSRF': firstCsrf });
  const stillSignedIn = await (await app.call('/api/session', undefined, { Cookie: secondCookie })).json();
  assert.equal(stillSignedIn.user.login, 'other');
  assert.equal(stillSignedIn.selectedRepo.owner, 'other');
});

test('API gateway only reads the selected repository and uses the server token', async t => {
  const app = await setup(t); await app.login(); await app.call('/api/repository', { repository: 'tester/photos' });
  const media = await app.call(`/api/github/repos/tester/photos/git/blobs/${SHA}`, undefined, { Accept: 'application/vnd.github.raw+json', Authorization: 'Bearer attacker-value' });
  assert.equal(await media.text(), 'image bytes'); assert.equal(media.headers.get('cache-control'), 'no-store');
  const upstream = app.requests.at(-1); assert.equal(upstream.options.headers.Authorization, `Bearer ${TOKEN}`); assert.equal(upstream.options.method, 'GET');
  const count = app.requests.length;
  assert.equal((await app.call(`/api/github/repos/other/private/git/blobs/${SHA}`, undefined, { Accept: 'application/vnd.github.raw+json' })).status, 403);
  assert.equal((await app.call('/api/github/repos/tester/photos/git/trees/main', { delete: true })).status, 404);
  assert.equal((await app.call('/api/github/repos/tester/photos/git/trees/%2F..%2F..%2Fsecret', undefined, { Accept: 'application/vnd.github+json' })).status, 403);
  assert.equal(app.requests.length, count);
});

test('release redirect never receives the token and arbitrary destinations are rejected', async t => {
  const asset = 'https://api.github.com/repos/tester/photos/releases/assets/123';
  const signed = 'https://release-assets.githubusercontent.com/file?signature=test';
  const app = await setup(t, { [asset]: () => new Response(null, { status: 302, headers: { location: signed } }), [signed]: options => { assert.equal(options.headers, undefined); return new Response('video bytes'); } });
  await app.login(); await app.call('/api/repository', { repository: 'tester/photos' });
  const response = await app.call('/api/github/repos/tester/photos/releases/assets/123', undefined, { Accept: 'application/octet-stream' });
  assert.equal(await response.text(), 'video bytes');
  const other = await setup(t, { [asset]: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/file' } }) });
  await other.login(); await other.call('/api/repository', { repository: 'tester/photos' });
  assert.equal((await other.call('/api/github/repos/tester/photos/releases/assets/123', undefined, { Accept: 'application/octet-stream' })).status, 502);
  assert.ok(other.requests.every(request => !request.url.includes('evil.example')));
});

test('expired sessions, invalid tokens, and malformed input fail without leaking secrets', async t => {
  const app = await setup(t); await app.login(); app.advance(8 * 60 * 60 * 1000 + 1);
  assert.equal((await app.call('/api/repositories')).status, 401); assert.equal((await app.session()).user, null);
  assert.equal((await app.call('/api/auth/token', null)).status, 400);
  const invalid = await setup(t, { 'https://api.github.com/user': () => json({ message: TOKEN }, 401) });
  await invalid.session(); const response = await invalid.call('/api/auth/token', { token: TOKEN });
  assert.equal(response.status, 401); assert.ok(!(await response.text()).includes(TOKEN));
});

test('sign-in cannot finish after the originating session has logged out', async t => {
  let release;
  const app = await setup(t, { 'https://github.com/login/oauth/access_token': async () => { await new Promise(resolve => { release = resolve; }); return json({ access_token: TOKEN }); } });
  await app.session(); const target = new URL((await (await app.call('/api/auth/start', {})).json()).url);
  const callback = app.call(`/api/auth/callback?code=test&state=${target.searchParams.get('state')}`);
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  await app.call('/api/auth/logout', {}); release();
  assert.match((await callback).headers.get('location'), /auth_error=/);
  assert.equal((await app.session()).user, null);
});

test('fresh Vercel handlers share sign-in, repository selection, sessions and logout', async t => {
  const app = await setup(t, {}, { freshInstance: true });
  await app.login();
  await app.call('/api/repository', { repository: 'tester/photos' });
  const authenticated = app.getCookie();
  assert.equal((await app.session()).selectedRepo.name, 'photos');
  assert.equal((await app.session()).user.login, 'tester');
  const media = await app.call(`/api/github/repos/tester/photos/git/blobs/${SHA}`, undefined, { Accept: 'application/vnd.github.raw+json' });
  assert.equal(await media.text(), 'image bytes');
  await app.call('/api/auth/logout', {});
  assert.equal((await app.call('/api/repositories', undefined, { Cookie: authenticated })).status, 401);
});

test('device cancellation on another Vercel instance wins over an in-flight approval', async t => {
  let release; let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const app = await setup(t, {
    'https://github.com/login/device/code': () => json(DEVICE),
    'https://github.com/login/oauth/access_token': () => { entered(); return new Promise(resolve => { release = () => resolve(json({ access_token: TOKEN })); }); },
  }, { freshInstance: true });
  app.config.clientSecret = ''; await app.session();
  const { attemptId } = await (await app.call('/api/auth/start', {})).json();
  app.advance(5000);
  const poll = app.call('/api/auth/device/poll', { attemptId });
  await waiting;
  assert.equal((await (await app.call('/api/auth/device/poll', { attemptId })).json()).status, 'pending');
  assert.equal((await app.call('/api/auth/device/cancel', { attemptId })).status, 200);
  release();
  assert.equal((await poll).status, 409);
  assert.equal((await app.session()).user, null);
  assert.equal(app.requests.filter(item => item.url.endsWith('/access_token')).length, 1);
});

test('redirect state is single-use and rate limits are shared across fresh Vercel handlers', async t => {
  const app = await setup(t, {}, { freshInstance: true });
  await app.session();
  const target = new URL((await (await app.call('/api/auth/start', {})).json()).url);
  assert.equal((await app.call(`/api/auth/callback?code=test&state=${target.searchParams.get('state')}`)).status, 303);
  assert.equal((await app.session()).user.login, 'tester');
  assert.match((await app.call(`/api/auth/callback?code=test&state=${target.searchParams.get('state')}`)).headers.get('location'), /auth_error=/);
  for (let i = 0; i < 19; i++) assert.equal((await app.call('/api/auth/start', {})).status, 200);
  assert.equal((await app.call('/api/auth/start', {})).status, 429);
});

test('a shared-store outage returns a safe retryable error without creating a session', async t => {
  const store = { async rotate() { throw new StoreUnavailable(); } };
  const app = await setup(t, {}, { store, freshInstance: true });
  const response = await app.call('/api/session');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match((await response.json()).error, /temporarily unavailable/);
});

test('Vercel API handler streams private media larger than buffered function responses', async t => {
  const chunk = new Uint8Array(1024 * 1024).fill(42);
  const app = await setup(t, {
    [`https://api.github.com/repos/tester/photos/git/blobs/${SHA}`]: () => new Response(new ReadableStream({
      start(controller) { for (let i = 0; i < 6; i++) controller.enqueue(chunk); controller.close(); },
    }), { headers: { 'content-type': 'video/mp4' } }),
  }, { freshInstance: true });
  await app.login(); await app.call('/api/repository', { repository: 'tester/photos' });
  const response = await app.call(`/api/github/repos/tester/photos/git/blobs/${SHA}`, undefined, { Accept: 'application/vnd.github.raw+json' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  let bytes = 0;
  for await (const part of response.body) bytes += part.byteLength;
  assert.equal(bytes, 6 * 1024 * 1024);
});
