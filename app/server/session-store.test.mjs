import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemorySessionStore, createRedisSessionStore, createSessionStore, StoreUnavailable } from './session-store.mjs';

test('session snapshots cannot resurrect a logged-out session or overwrite another tab', async () => {
  let time = 1000;
  const store = createMemorySessionStore({ now: () => time });
  const session = { id: 'original', version: 0, expires: 10000 };
  assert.equal(await store.rotate(null, session), true);
  const first = await store.get(session.id); const stale = await store.get(session.id);
  first.version++; first.repo = 'one';
  assert.equal(await store.save(first, 0), true);
  stale.version++; stale.repo = 'two';
  assert.equal(await store.save(stale, 0), false);
  assert.equal((await store.get(session.id)).repo, 'one');
  const replacement = { id: 'rotated', version: 0, expires: 9000 };
  assert.equal(await store.rotate(first, replacement), true);
  assert.equal(await store.save(first, 1), false);
  assert.equal(await store.rotate(first, { ...replacement, id: 'resurrected' }), false);
  time = 10001;
  assert.equal(await store.get(replacement.id), null);
});

test('Redis REST credentials stay in headers and server errors never expose them', async () => {
  const config = { origin: 'https://gallery.example.com', redisUrl: 'https://redis.example.com', redisToken: 'private-redis-fixture' };
  const store = createRedisSessionStore(config, { fetcher: async (url, request) => {
    assert.equal(url, config.redisUrl);
    assert.equal(request.headers.Authorization, `Bearer ${config.redisToken}`);
    assert.equal(request.redirect, 'error');
    assert.ok(!request.body.includes(config.redisToken));
    return new Response(JSON.stringify({ error: config.redisToken }));
  } });
  await assert.rejects(store.get('fixture'), error => error instanceof StoreUnavailable && !error.message.includes(config.redisToken));
  assert.throws(() => createRedisSessionStore({ ...config, redisUrl: 'http://redis.example.com' }), /HTTPS/);
  assert.throws(() => createSessionStore({ vercel: true }), /requires shared sessions/);
});
