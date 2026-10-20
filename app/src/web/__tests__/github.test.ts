import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubSource } from '../github';
import type { TreeEntry } from '../types';

const path = 'gitgallery/library/2026/06/01/123456_1200x800_abcd.jpg';
const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
function fixture(entries: TreeEntry[], overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = String(input); calls.push({ url, options });
    const route = url.replace('https://api.github.com', '');
    if (overrides[route]) return overrides[route]();
    if (route === '/user') return json({ login: 'tester' });
    if (route === '/repos/owner/repo') return json({ full_name: 'owner/repo', default_branch: 'main' });
    if (route === '/repos/owner/repo/git/trees/main?recursive=1') return json({ sha: 'root', tree: entries });
    if (route.includes('/git/blobs/')) return new Response('image bytes');
    return json({}, 404);
  };
  return { fetcher, calls };
}

test('private media uses GETs to the fixed API origin, coalesces loads and clears on disposal', async () => {
  const { fetcher, calls } = fixture([{ path, sha: 'photo', type: 'blob', size: 11 }]);
  const source = new GitHubSource('owner/repo', 'fake-test-token', '', fetcher);
  const library = await source.connect();
  assert.equal(library.id, 'tester:owner/repo@main');
  const [first, second] = await Promise.all([source.load(library.assets[0], false), source.load(library.assets[0], false)]);
  assert.equal(first, second);
  assert.match(first, /^blob:/);
  assert.equal(calls.filter(({ url }) => url.includes('/git/blobs/')).length, 1);
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, 'https://api.github.com');
    assert.equal(call.options?.method, 'GET');
    assert.equal(new Headers(call.options?.headers).get('Authorization'), 'Bearer fake-test-token');
    assert.equal(call.url.includes('fake-test-token'), false);
  }
  source.dispose();
  await assert.rejects(() => fetch(first));
  await assert.rejects(() => source.connect());
});

test('public repositories need no token; repositories without commits have an empty library', async () => {
  const { fetcher, calls } = fixture([], { '/repos/owner/repo/git/trees/main?recursive=1': () => json({}, 409) });
  const source = new GitHubSource('owner/repo', '', '', fetcher);
  assert.equal((await source.connect()).assets.length, 0);
  assert.ok(calls.every(({ options }) => !new Headers(options?.headers).has('Authorization')));
  source.dispose();
});

test('token, access and rate-limit failures are actionable', async () => {
  for (const [status, pattern] of [[401, /verify that token/], [403, /denied access/], [404, /not found/], [429, /request limit/]] as const) {
    const source = new GitHubSource('owner/repo', '', '', async () => json({}, status));
    await assert.rejects(() => source.connect(), pattern);
    source.dispose();
  }
});

test('truncated recursive trees are traversed without silently omitting library files', async () => {
  const { fetcher } = fixture([], {
    '/repos/owner/repo/git/trees/main?recursive=1': () => json({ sha: 'root', truncated: true, tree: [] }),
    '/repos/owner/repo/git/trees/root': () => json({ tree: [{ path: 'gitgallery', type: 'tree', sha: 'gallery' }] }),
    '/repos/owner/repo/git/trees/gallery': () => json({ tree: [{ path: 'images', type: 'tree', sha: 'images' }, { path: 'ignored', type: 'tree', sha: 'ignored' }] }),
    '/repos/owner/repo/git/trees/images': () => json({ tree: [{ path: 'old.jpg', type: 'blob', sha: 'photo' }] }),
  });
  const source = new GitHubSource('owner/repo', '', '', fetcher);
  assert.equal((await source.connect()).assets[0].repoPath, 'gitgallery/images/old.jpg');
  source.dispose();
});

test('failed metadata does not hide photos', async () => {
  const { fetcher } = fixture([
    { path, sha: 'photo', type: 'blob' },
    { path: 'gitgallery/meta/2026/06/01/meta_dict.json', sha: 'meta', type: 'blob' },
  ], { '/repos/owner/repo/git/blobs/meta': () => json({}, 403) });
  const source = new GitHubSource('owner/repo', '', '', fetcher);
  const library = await source.connect();
  assert.equal(library.assets.length, 1);
  assert.equal(library.warnings.length, 1);
  assert.ok(library.assets[0].createdAt);
  source.dispose();
});

test('release pointers enforce the browser limit and never follow arbitrary URLs', async () => {
  const { fetcher, calls } = fixture([{ path: `${path}.ptr`, sha: 'pointer', type: 'blob' }], {
    '/repos/owner/repo/git/blobs/pointer': () => json({ tier: 2, assetId: 123, size: 500 * 1024 * 1024, url: 'https://evil.example/file' }),
  });
  const source = new GitHubSource('owner/repo', 'test-token', '', fetcher);
  const library = await source.connect();
  await assert.rejects(() => source.load(library.assets[0], false), /80 MB/);
  assert.ok(calls.every(({ url }) => new URL(url).origin === 'https://api.github.com'));
  assert.equal(source.originalLink(library.assets[0]), 'https://github.com/owner/repo/releases');
  source.dispose();
});

test('untrusted response length cannot bypass preview bounds', async () => {
  const { fetcher } = fixture([{ path, sha: 'photo', type: 'blob' }], {
    '/repos/owner/repo/git/blobs/photo': () => new Response('bytes', { headers: { 'content-length': String(500 * 1024 * 1024) } }),
  });
  const source = new GitHubSource('owner/repo', '', '', fetcher);
  const library = await source.connect();
  await assert.rejects(() => source.load(library.assets[0], true), /too large/);
  source.dispose();
});

test('thumbnail requests have bounded concurrency even when queued', async () => {
  let active = 0; let maximum = 0;
  const entries = Array.from({ length: 12 }, (_, index) => ({ path: `gitgallery/images/${index}.jpg`, type: 'blob', sha: String(index) }));
  const overrides = Object.fromEntries(entries.map((entry) => [`/repos/owner/repo/git/blobs/${entry.sha}`, async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--; return new Response('bytes');
  }]));
  const { fetcher } = fixture(entries, overrides);
  const source = new GitHubSource('owner/repo', '', '', fetcher);
  const library = await source.connect();
  await Promise.all(library.assets.map((asset) => source.load(asset, true)));
  assert.equal(maximum, 4);
  source.dispose();
});
