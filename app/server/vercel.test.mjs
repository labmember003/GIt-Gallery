import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createVercelHandler } from './vercel.mjs';

test('Vercel rewrites preserve nested authentication routes, queries and CSRF checks', async t => {
  const config = { origin: '', clientId: 'fixture-client' };
  const handler = createVercelHandler(config, { fetcher: async () => new Response(JSON.stringify({
    device_code: 'private-device-fixture', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5,
  })) });
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const opened = await fetch(`${config.origin}/api/index?__gg_path=session`);
  assert.equal(opened.status, 200);
  const { csrf } = await opened.json();
  const cookie = opened.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, Origin: config.origin, 'X-GitGallery-CSRF': csrf, 'Content-Type': 'application/json' };
  for (const path of ['/api/index?__gg_path=auth%2Fstart', '/api/auth/start?__gg_path=auth%2Fstart']) {
    const response = await fetch(`${config.origin}${path}`, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 200);
    const challenge = await response.json();
    assert.equal(challenge.method, 'device');
    assert.ok(!JSON.stringify(challenge).includes('private-device-fixture'));
  }
  const denied = await fetch(`${config.origin}/api/index?__gg_path=auth%2Fstart`, { method: 'POST', headers: { ...headers, Origin: 'https://other.example' }, body: '{}' });
  assert.equal(denied.status, 403);
  const duplicate = await fetch(`${config.origin}/api/index?__gg_path=session&__gg_path=auth%2Fstart`);
  assert.equal(duplicate.status, 400);
});
