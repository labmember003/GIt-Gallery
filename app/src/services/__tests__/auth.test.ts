import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pollForToken, startDeviceFlow, DeviceFlowError } from '../auth';

// Read lazily by GITHUB_CLIENT_ID(), so setting it after import is fine.
process.env.EXPO_PUBLIC_GITHUB_CLIENT_ID = 'test-client';

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** A fake clock: sleeping advances time instead of waiting. */
function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleeps,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms; },
  };
}

test('keeps polling through network failures (iOS suspends the app while GitHub is open)', async () => {
  const c = clock();
  const answers: Array<() => Response> = [
    () => json({ error: 'authorization_pending' }),
    () => { throw new TypeError('Network request failed'); },
    () => { throw new TypeError('The network connection was lost.'); },
    () => json({ access_token: 'gho_ok' }),
  ];
  const token = await pollForToken('dev', {
    intervalSec: 5, expiresInSec: 900, now: c.now, sleep: c.sleep,
    fetchImpl: async () => answers.shift()!(),
  });
  assert.equal(token, 'gho_ok');
  assert.equal(c.sleeps.length, 4);
});

test('a poll request that hangs is abandoned and retried', async () => {
  const c = clock();
  let calls = 0;
  const token = await pollForToken('dev', {
    intervalSec: 5, now: c.now, sleep: c.sleep, requestTimeoutMs: 30,
    fetchImpl: (_url, init) => {
      calls += 1;
      if (calls === 1) {
        // Never answers until aborted, like a request frozen by suspension.
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      return Promise.resolve(json({ access_token: 'after-hang' }));
    },
  });
  assert.equal(token, 'after-hang');
  assert.equal(calls, 2);
});

test('slow_down raises the interval by 5s or to the value GitHub sends', async () => {
  const c = clock();
  const answers = [json({ error: 'slow_down' }), json({ error: 'slow_down', interval: 20 }), json({ access_token: 't' })];
  await pollForToken('dev', { intervalSec: 5, now: c.now, sleep: c.sleep, fetchImpl: async () => answers.shift()! });
  assert.deepEqual(c.sleeps, [5000, 10000, 20000]);
});

test('expired, denied and disabled end the flow with a typed error', async () => {
  for (const [error, kind] of [['expired_token', 'expired'], ['access_denied', 'denied'], ['device_flow_disabled', 'disabled'], ['incorrect_device_code', 'misconfigured']] as const) {
    const c = clock();
    await assert.rejects(
      pollForToken('dev', { intervalSec: 5, now: c.now, sleep: c.sleep, fetchImpl: async () => json({ error }) }),
      (e: any) => e instanceof DeviceFlowError && e.kind === kind,
    );
  }
});

test('gives up as expired once the code lifetime passes, even if offline the whole time', async () => {
  const c = clock();
  await assert.rejects(
    pollForToken('dev', {
      intervalSec: 5, expiresInSec: 30, now: c.now, sleep: c.sleep,
      fetchImpl: async () => { throw new TypeError('Network request failed'); },
    }),
    (e: any) => e.kind === 'expired',
  );
});

test('an abort stops the loop as cancelled', async () => {
  const c = clock();
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    pollForToken('dev', { intervalSec: 5, signal: abort.signal, now: c.now, sleep: c.sleep, fetchImpl: async () => json({}) }),
    (e: any) => e.kind === 'cancelled',
  );
});

test('wake() cuts the wait short so returning to the app polls at once', async () => {
  let wakeResolve: () => void = () => {};
  let calls = 0;
  const started = Date.now();
  const promise = pollForToken('dev', {
    intervalSec: 60,
    wake: () => new Promise<void>((r) => { wakeResolve = r; }),
    fetchImpl: async () => { calls += 1; return json({ access_token: 'woken' }); },
  });
  setTimeout(() => wakeResolve(), 20);
  assert.equal(await promise, 'woken');
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 5000);
});

test('startDeviceFlow reports a network failure as start-failed and a disabled app as disabled', async () => {
  await assert.rejects(startDeviceFlow(async () => { throw new TypeError('Network request failed'); }), (e: any) => e.kind === 'start-failed');
  await assert.rejects(startDeviceFlow(async () => json({ error: 'device_flow_disabled' })), (e: any) => e.kind === 'disabled');
  const flow = await startDeviceFlow(async () => json({ device_code: 'd', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 899, interval: 5 }));
  assert.equal(flow.user_code, 'ABCD-1234');
});
