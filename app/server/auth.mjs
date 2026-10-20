import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { signInMethod } from './config.mjs';
import { createSessionStore, SessionConflict, StoreUnavailable } from './session-store.mjs';

const SESSION_AGE = 8 * 60 * 60 * 1000;
const COOKIE = 'gg_session';
const random = () => randomBytes(32).toString('base64url');
const equal = (left, right) => typeof left === 'string' && typeof right === 'string'
  && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const repoPart = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(value));
}
async function body(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Use a JSON request.');
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw new HttpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString());
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  }
  catch { throw new HttpError(400, 'Invalid request.'); }
}
function userInfo(user) {
  if (!Number.isSafeInteger(user.id) || typeof user.login !== 'string') throw new HttpError(502, 'GitHub returned an invalid account.');
  return { id: user.id, login: user.login, name: typeof user.name === 'string' ? user.name : user.login };
}

/** Same-origin session gateway. No token or client secret is returned to the browser. */
export function createAuthHandler(config, { fetcher = (...args) => fetch(...args), now = Date.now, store } = {}) {
  const sessions = store ?? createSessionStore(config, { now });
  const secure = () => new URL(config.origin).protocol === 'https:';
  function cookie(response, id, age) {
    response.setHeader('Set-Cookie', `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(age / 1000)}${secure() ? '; Secure' : ''}`);
  }
  async function find(request) {
    const id = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    return typeof id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(id) ? sessions.get(id) : null;
  }
  async function save(session) {
    const expected = session.version;
    session.version++;
    if (!await sessions.save(session, expected)) { session.version = expected; throw new SessionConflict(); }
  }
  async function active(session) {
    const current = await sessions.get(session.id);
    if (!current || current.version !== session.version) throw new SessionConflict();
  }
  async function create(response, previous, values = {}) {
    const age = values.user ? Math.min(SESSION_AGE, values.tokenAge ?? SESSION_AGE) : 30 * 60 * 1000;
    const session = { id: random(), version: 0, csrf: random(), expires: now() + age, ...values };
    if (!await sessions.rotate(previous, session)) throw new SessionConflict();
    cookie(response, session.id, age); return session;
  }
  function visible(session) {
    return { user: session.user ?? null, csrf: session.csrf, selectedRepo: session.repo ?? null,
      expiresAt: session.expires, oauthAvailable: !!signInMethod(config), signInMethod: signInMethod(config),
      tokenSignInAvailable: config.allowTokenSignIn === true };
  }
  async function limit(request) {
    // Vercel overwrites this header. Other hosts must not trust client-supplied forwarded headers.
    const ip = config.vercel ? request.headers['x-vercel-forwarded-for'] : request.socket?.remoteAddress;
    if (await sessions.increment(`sign-in:${ip ?? 'unknown'}`, 60_000) > 20) throw new HttpError(429, 'Too many sign-in attempts. Wait a minute and try again.');
  }
  async function github(path, token, accept = 'application/vnd.github+json', signal) {
    const response = await fetcher(`https://api.github.com${path}`, { method: 'GET', redirect: 'manual',
      signal: signal ?? AbortSignal.timeout(30_000), headers: { Accept: accept, Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'GitGallery-Web' } });
    return response;
  }
  async function check(response) {
    if (response.ok) return response;
    const status = response.status;
    throw new HttpError(status, status === 401 ? 'Your GitHub session has expired. Sign in again.'
      : status === 404 ? 'Repository or branch not found. Check your access to this repository.'
      : status === 403 || status === 429 ? 'GitHub denied this request. Check repository permissions or try again after the rate limit resets.'
      : 'GitHub could not complete the request. Please try again.');
  }
  async function account(token) { return userInfo(await (await check(await github('/user', token))).json()); }
  function signedIn(session) { if (!session?.user || !session.token) throw new HttpError(401, 'Sign in to continue.'); }
  async function oauthRequest(path, values) {
    return fetcher(`https://github.com/login/${path}`, { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(values).toString() });
  }
  function deviceDetails(pending) {
    return { method: 'device', attemptId: pending.id, userCode: pending.userCode,
      verificationUri: 'https://github.com/login/device', expiresAt: pending.expires,
      interval: Math.max(1, Math.ceil((pending.nextPollAt - now()) / 1000)) };
  }
  function waiting(response, pending) {
    json(response, 200, { status: 'pending', retryAfter: Math.max(1, Math.ceil((pending.nextPollAt - now()) / 1000)) });
  }

  return async function handle(request, response) {
    const url = new URL(request.url, config.origin);
    if (!url.pathname.startsWith('/api/')) return false;
    let session;
    try {
      if (request.headers.host !== new URL(config.origin).host) throw new HttpError(403, 'Open the configured website address.');
      if (request.headers['sec-fetch-site'] === 'cross-site' && url.pathname !== '/api/auth/callback') throw new HttpError(403, 'Cross-site requests are not allowed.');
      if (!['GET', 'POST'].includes(request.method)) throw new HttpError(405, 'Method not allowed.');
      session = await find(request);
      if (request.method === 'POST') {
        if (request.headers.origin !== config.origin || !session || !equal(request.headers['x-gitgallery-csrf'], session.csrf)) throw new HttpError(403, 'Your session changed. Reload the page and try again.');
      }
      if (url.pathname === '/api/session' && request.method === 'GET') {
        session ??= await create(response);
        json(response, 200, visible(session)); return true;
      }
      if (url.pathname === '/api/auth/start' && request.method === 'POST') {
        await limit(request);
        const method = signInMethod(config);
        if (!method) throw new HttpError(503, 'This website has not connected to GitHub yet. Open the setup instructions on the sign-in page, or contact the person who shared this website.');
        if (method === 'device') {
          if (session.pending?.kind === 'device' && session.pending.expires > now()) {
            json(response, 200, deviceDetails(session.pending)); return true;
          }
          if (session.startingUntil > now()) throw new HttpError(409, 'Sign-in is already starting. Please wait a moment.');
          session.startingUntil = now() + 35_000;
          await save(session);
          try {
            const upstream = await oauthRequest('device/code', { client_id: config.clientId, scope: 'repo' });
            const data = await upstream.json();
            if (data.error === 'device_flow_disabled') throw new HttpError(503, 'GitHub approval codes are not enabled for this website. The website owner needs to enable Device Flow in its GitHub app settings.');
            if (!upstream.ok || data.error) throw new HttpError(502, 'GitHub could not create a sign-in code. Try again in a moment.');
            if (typeof data.device_code !== 'string' || !data.device_code || data.device_code.length > 1024
              || typeof data.user_code !== 'string' || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(data.user_code)
              || data.verification_uri !== 'https://github.com/login/device'
              || !Number.isFinite(data.expires_in) || data.expires_in <= 0
              || (data.interval !== undefined && (!Number.isFinite(data.interval) || data.interval < 1 || data.interval > 900))) {
              throw new HttpError(502, 'GitHub returned an invalid sign-in code. Please try again.');
            }
            const interval = Math.ceil(data.interval ?? 5) * 1000;
            session.pending = { kind: 'device', id: random(), deviceCode: data.device_code, userCode: data.user_code,
              expires: now() + Math.min(data.expires_in, 900) * 1000, interval, nextPollAt: now() + interval, pollingUntil: 0 };
            delete session.startingUntil;
            await save(session);
            json(response, 200, deviceDetails(session.pending)); return true;
          } catch (error) {
            delete session.startingUntil;
            await save(session).catch(conflict => { if (!(conflict instanceof SessionConflict)) throw conflict; });
            throw error;
          }
        }
        const state = random(); const verifier = random();
        session.pending = { kind: 'redirect', state, verifier, expires: now() + 10 * 60 * 1000 };
        await save(session);
        const target = new URL('https://github.com/login/oauth/authorize');
        target.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: `${config.origin}/api/auth/callback`,
          scope: 'repo', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
        json(response, 200, { method: 'redirect', url: target.href }); return true;
      }
      if (url.pathname === '/api/auth/device/cancel' && request.method === 'POST') {
        const data = await body(request);
        if (session.pending?.kind === 'device' && equal(session.pending.id, data.attemptId)) { delete session.pending; await save(session); }
        json(response, 200, { cancelled: true }); return true;
      }
      if (url.pathname === '/api/auth/device/poll' && request.method === 'POST') {
        const data = await body(request);
        const pending = session.pending;
        if (pending?.kind !== 'device' || !equal(pending.id, data.attemptId)) throw new HttpError(409, 'This sign-in attempt has ended. Start again to get a new code.');
        if (pending.expires <= now()) { delete session.pending; await save(session); throw new HttpError(410, 'Your code has expired. Start again to get a new code.'); }
        if (pending.pollingUntil > now() || pending.nextPollAt > now()) { waiting(response, pending); return true; }
        pending.pollingUntil = now() + 65_000; pending.nextPollAt = now() + pending.interval;
        await save(session);
        const finishWaiting = async () => { pending.pollingUntil = 0; await save(session); waiting(response, pending); };
        try {
          const upstream = await oauthRequest('oauth/access_token', { client_id: config.clientId,
            device_code: pending.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
          const result = await upstream.json();
          await active(session);
          pending.nextPollAt = now() + pending.interval;
          if (result.error === 'slow_down' || upstream.status === 429) {
            pending.interval = Math.max(pending.interval + 5000, Number.isFinite(result.interval) ? result.interval * 1000 : 0);
            pending.nextPollAt = now() + pending.interval;
            await finishWaiting(); return true;
          }
          if (result.error === 'authorization_pending') { await finishWaiting(); return true; }
          if (result.error === 'access_denied') { delete session.pending; await save(session); throw new HttpError(403, 'You cancelled access on GitHub. Start again when you are ready.'); }
          if (['expired_token', 'token_expired', 'incorrect_device_code'].includes(result.error)) {
            delete session.pending; await save(session); throw new HttpError(410, 'Your code has expired or is no longer valid. Start again to get a new code.');
          }
          if (!upstream.ok || typeof result.access_token !== 'string' || !result.access_token) throw new HttpError(502, 'Could not check your GitHub approval. Check your connection and try again.');
          const user = await account(result.access_token);
          session = await create(response, session, { user, token: result.access_token,
            tokenAge: Number.isFinite(result.expires_in) && result.expires_in > 0 ? result.expires_in * 1000 : SESSION_AGE });
          json(response, 200, { status: 'authenticated', session: visible(session) }); return true;
        } catch (error) {
          pending.pollingUntil = 0;
          if (session.pending === pending) await save(session).catch(conflict => { if (!(conflict instanceof SessionConflict)) throw conflict; });
          throw error;
        }
      }
      if (url.pathname === '/api/auth/callback' && request.method === 'GET') {
        const pending = session?.pending;
        const code = url.searchParams.get('code');
        if (pending?.kind !== 'redirect' || pending.expires <= now() || !equal(pending.state, url.searchParams.get('state'))) throw new HttpError(400, 'Sign-in expired or could not be verified. Please start again.');
        delete session.pending;
        await save(session);
        if (url.searchParams.has('error')) throw new HttpError(400, 'GitHub sign-in was cancelled. You can try again.');
        if (!code || code.length > 512) throw new HttpError(400, 'GitHub did not return a valid sign-in code.');
        const exchanged = await fetcher('https://github.com/login/oauth/access_token', { method: 'POST', redirect: 'error',
          signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code,
            redirect_uri: `${config.origin}/api/auth/callback`, code_verifier: pending.verifier }).toString() });
        if (!exchanged.ok) throw new HttpError(502, 'GitHub sign-in is temporarily unavailable. Try again.');
        const data = await exchanged.json();
        if (typeof data.access_token !== 'string' || !data.access_token) throw new HttpError(401, 'GitHub could not complete sign-in. Please start again.');
        const user = await account(data.access_token);
        await create(response, session, { user, token: data.access_token, tokenAge: Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in * 1000 : SESSION_AGE });
        response.writeHead(303, { Location: `${config.origin}/`, 'Cache-Control': 'no-store' }); response.end(); return true;
      }
      if (url.pathname === '/api/auth/token' && request.method === 'POST') {
        if (!config.allowTokenSignIn) throw new HttpError(404, 'This sign-in method is unavailable. Continue with GitHub instead.');
        await limit(request);
        const data = await body(request);
        if (typeof data.token !== 'string' || !/^[A-Za-z0-9_]{20,255}$/.test(data.token.trim())) throw new HttpError(400, 'Enter a valid GitHub personal access token.');
        const token = data.token.trim(); const user = await account(token);
        session = await create(response, session, { user, token });
        json(response, 200, visible(session)); return true;
      }
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        // Logout invalidates the latest snapshot even if another tab just updated the repository.
        const current = await find(request);
        session = await create(response, current);
        json(response, 200, visible(session)); return true;
      }
      signedIn(session);
      if (url.pathname === '/api/repositories' && request.method === 'GET') {
        const page = Number(url.searchParams.get('page') ?? 1);
        if (!Number.isSafeInteger(page) || page < 1 || page > 100) throw new HttpError(400, 'Invalid repository page.');
        const upstream = await check(await github(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`, session.token));
        const repos = await upstream.json();
        json(response, 200, { repositories: repos.map((repo) => ({ id: repo.id, fullName: repo.full_name,
          description: repo.description, private: repo.private, branch: repo.default_branch, writable: !!repo.permissions?.push })),
          hasMore: (upstream.headers.get('link') ?? '').includes('rel="next"') }); return true;
      }
      if (url.pathname === '/api/repository' && request.method === 'POST') {
        const data = await body(request);
        const parts = typeof data.repository === 'string' ? data.repository.split('/') : [];
        if (parts.length !== 2 || !parts.every((part) => repoPart.test(part))) throw new HttpError(400, 'Enter a repository as owner/name.');
        if (data.branch !== undefined && (typeof data.branch !== 'string' || data.branch.length > 255 || /[\x00-\x1f]/.test(data.branch))) throw new HttpError(400, 'Invalid branch.');
        const info = await (await check(await github(`/repos/${parts.map(encodeURIComponent).join('/')}`, session.token))).json();
        const [owner, name] = info.full_name.split('/');
        const branch = data.branch?.trim() || info.default_branch;
        if (!owner || !name || !branch) throw new HttpError(502, 'GitHub returned an invalid repository.');
        session.repo = { owner, name, branch };
        await save(session);
        json(response, 200, visible(session)); return true;
      }
      if (url.pathname.startsWith('/api/github/') && request.method === 'GET') {
        const path = url.pathname.slice('/api/github'.length);
        const repo = session.repo;
        if (!repo) throw new HttpError(400, 'Choose a repository first.');
        const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
        const suffix = path.startsWith(base) ? path.slice(base.length) : null;
        if (path !== '/user' && (suffix === null || !/^(|\/git\/(trees|blobs)\/[A-Za-z0-9%_.-]+|\/releases\/assets\/\d+)$/.test(suffix))) throw new HttpError(403, 'This resource is outside the selected library.');
        if (suffix?.startsWith('/git/')) {
          const identifier = decodeURIComponent(suffix.split('/').pop());
          if (identifier.split('/').some((part) => !part || part === '.' || part === '..') || /[\\?#\x00-\x20]/.test(identifier)) throw new HttpError(403, 'Invalid library resource.');
          if (suffix.startsWith('/git/blobs/') && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(identifier)) throw new HttpError(400, 'Invalid blob identifier.');
        }
        if (url.search && url.search !== '?recursive=1') throw new HttpError(400, 'Unsupported library query.');
        const accept = request.headers.accept;
        if (!['application/vnd.github+json', 'application/vnd.github.raw+json', 'application/octet-stream'].includes(accept)) throw new HttpError(400, 'Unsupported media request.');
        const controller = new AbortController();
        const aborted = () => { if (!response.writableFinished) controller.abort(); };
        response.on('close', aborted);
        const timer = setTimeout(() => controller.abort(), 120_000); timer.unref();
        try {
          let upstream = await github(`${path}${url.search}`, session.token, accept, controller.signal);
          if ([301, 302, 303, 307, 308].includes(upstream.status)) {
            if (!suffix?.startsWith('/releases/assets/')) throw new HttpError(502, 'This repository moved. Select it again.');
            const target = new URL(upstream.headers.get('location') ?? '');
            if (target.protocol !== 'https:' || target.username || target.password || !target.hostname.endsWith('.githubusercontent.com')) throw new HttpError(502, 'GitHub returned an unsupported download location.');
            // Never forward Authorization to the signed download host.
            upstream = await fetcher(target.href, { redirect: 'error', signal: controller.signal });
          }
          if (upstream.status === 401) { await sessions.delete(session.id); cookie(response, '', 0); }
          const headers = { 'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
          const remaining = upstream.headers.get('x-ratelimit-remaining');
          if (remaining) headers['X-RateLimit-Remaining'] = remaining;
          response.writeHead(upstream.status, headers);
          if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response);
          else response.end();
        } finally { clearTimeout(timer); response.off('close', aborted); }
        return true;
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      if (response.headersSent || response.destroyed) { response.destroy(); return true; }
      if (url.pathname === '/api/auth/callback') {
        const reason = error instanceof HttpError ? error.message : 'GitHub sign-in could not finish. Please try again.';
        response.writeHead(303, { Location: `${config.origin}/?auth_error=${encodeURIComponent(reason)}`, 'Cache-Control': 'no-store' }); response.end();
      } else {
        if (error.status === 401 && session?.user) { await sessions.delete(session.id); cookie(response, '', 0); }
        const known = error instanceof HttpError || error instanceof SessionConflict || error instanceof StoreUnavailable;
        json(response, known ? error.status : 502, { error: known ? error.message : 'The connection to GitHub failed. Please try again.' });
      }
      return true;
    }
  };
}
