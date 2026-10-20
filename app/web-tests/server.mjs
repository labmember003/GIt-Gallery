// Isolated test server. No real GitHub requests or credentials are used.
import { createSiteServer } from '../server/site.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const photo = await readFile('public/demo/riviera.webp');
const sha = 'a'.repeat(40);
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const devicePolls = new Map();
const fetcher = async (input, options = {}) => {
  const url = new URL(String(input));
  if (url.href === 'https://github.com/login/device/code') {
    const deviceCode = `device_fixture_${devicePolls.size}`;
    devicePolls.set(deviceCode, 0);
    return json({ device_code: deviceCode, user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 });
  }
  if (url.href === 'https://github.com/login/oauth/access_token') {
    const form = new URLSearchParams(options.body);
    if (form.has('device_code')) {
      const code = form.get('device_code'); const polls = devicePolls.get(code);
      if (polls === undefined) return json({ error: 'incorrect_device_code' });
      devicePolls.set(code, polls + 1);
      if (polls === 0) return json({ error: 'authorization_pending' });
    }
    return json({ access_token: 'test_token_for_browser_fixtures_123456789', expires_in: 3600 });
  }
  if (url.origin !== 'https://api.github.com') throw new Error('Unexpected fixture origin');
  if (options.headers.Authorization !== 'Bearer test_token_for_browser_fixtures_123456789') return json({}, 401);
  if (url.pathname === '/user') return json({ id: 7, login: 'tester', name: 'Test Photographer' });
  if (url.pathname === '/user/repos') return json([
    { id: 1, full_name: 'tester/photos', private: true, default_branch: 'main', description: 'My photo library', permissions: { push: false } },
    { id: 2, full_name: 'tester/empty', private: true, default_branch: 'main', description: 'Empty backup', permissions: { push: false } },
  ]);
  if (/^\/repos\/tester\/(photos|empty)$/.test(url.pathname)) return json({ full_name: url.pathname.slice(7), default_branch: 'main' });
  if (url.pathname === '/repos/tester/photos/git/trees/main') return json({ sha: 'b'.repeat(40), tree: [
    { path: 'gitgallery/images/trip/real-memory.webp', sha, type: 'blob', size: photo.length },
    { path: 'gitgallery/images/trip/another-memory.webp', sha, type: 'blob', size: photo.length },
  ] });
  if (url.pathname === '/repos/tester/empty/git/trees/main') return json({ sha: 'c'.repeat(40), tree: [] });
  if (url.pathname === `/repos/tester/photos/git/blobs/${sha}`) return new Response(photo, { headers: { 'content-type': 'image/webp' } });
  return json({}, 404);
};
const server = createSiteServer({ origin: 'http://127.0.0.1:8092', clientId: 'test-client', clientSecret: 'test-secret', allowTokenSignIn: true }, { root: resolve('dist-web'), fetcher });
const deviceServer = createSiteServer({ origin: 'http://127.0.0.1:8093', clientId: 'test-client', clientSecret: '', allowTokenSignIn: false }, { root: resolve('dist-web'), fetcher });
deviceServer.listen(8093, '127.0.0.1');
server.listen(8092, '127.0.0.1', () => console.log('Fixture website ready at http://127.0.0.1:8092'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { for (const site of [server, deviceServer]) { site.closeAllConnections(); site.close(); } });
