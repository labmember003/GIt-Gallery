import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createVercelHandler } from './vercel.mjs';
import { createMemorySessionStore } from './session-store.mjs';
import { CHUNK_SIZE, MAX_FILE_SIZE } from './uploads.mjs';
import { uploadGitHub } from '../web-tests/fixtures/upload-github.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function setup(t) {
  const github = uploadGitHub(); const store = createMemorySessionStore();
  const id = randomBytes(32).toString('base64url'); const csrf = randomBytes(32).toString('hex');
  const session = { id, version: 0, csrf, expires: Date.now() + 3600000, user: { id: 77, login: 'uploader' }, token: 'upload_test_only', repo: { owner: 'uploader', name: 'gitgallery-photos', branch: 'main' } };
  await store.rotate(null, session);
  const config = { origin: '', clientId: 'fixture', clientSecret: '' };
  // A fresh handler for every request proves that no file state depends on a
  // warm Vercel function. Exercise the actual wildcard rewrite as well.
  const server = createServer((req, res) => { void createVercelHandler(config, { store, fetcher: github.fetcher })(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const call = async (path, data, headers = {}) => {
    const binary = Buffer.isBuffer(data);
    const target = `/api/index?__gg_path=${encodeURIComponent(path)}&path=${encodeURIComponent(path)}`;
    const response = await fetch(config.origin + target, { method: data === undefined ? 'GET' : 'POST',
      headers: { Cookie: `gg_session=${id}`, Origin: config.origin, 'X-GitGallery-CSRF': csrf,
        ...(data === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }), ...headers },
      ...(data === undefined ? {} : { body: binary ? data : JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  };
  const start = async (bytes, extra = {}) => {
    const hashes = [];
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) hashes.push(digest(bytes.subarray(i, i + CHUNK_SIZE)));
    const meta = { name: 'Summer.webp', size: bytes.length, createdAt: Date.UTC(2025, 5, 12, 9, 30), width: 320, height: 200, hashes, ...extra };
    const result = await call('uploads/start', meta); assert.equal(result.status, 200, JSON.stringify(result));
    return { ...result.data, meta };
  };
  const chunks = async (id, bytes) => {
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const result = await call(`uploads/${id}/chunks/${i / CHUNK_SIZE}`, bytes.subarray(i, i + CHUNK_SIZE));
      assert.equal(result.status, 200, JSON.stringify(result));
    }
  };
  return { call, start, chunks, github, store, id };
}

test('multi-request upload preserves original bytes, mobile paths, previews, metadata and existing files', async t => {
  const app = await setup(t); const bytes = randomBytes(5 * 1024 * 1024);
  const upload = await app.start(bytes);
  assert.equal((await app.call(`uploads/${upload.id}/finish`, {})).status, 409);
  await app.chunks(upload.id, bytes);
  assert.equal((await app.call(`uploads/${upload.id}/preview`, Buffer.from([255, 216, 12, 255, 217]))).status, 200);
  const saved = await app.call(`uploads/${upload.id}/finish`, {}); assert.equal(saved.status, 200, JSON.stringify(saved));
  const files = app.github.files(); const result = saved.data.result;
  assert.match(result.id, /^gitgallery\/library\/2025\/06\/12\/093000_320x200_[a-f0-9]{64}\.webp$/);
  assert.deepEqual(files.get(result.repoPath), bytes);
  assert.equal(files.get('README.md').toString(), 'Fixture library');
  assert.ok(files.has(`${result.id}.preview.jpg`));
  const manifest = JSON.parse(files.get('gitgallery/meta/manifest.json'));
  const shard = JSON.parse(files.get(Object.values(manifest.shards)[0].path));
  const meta = Object.values(shard.entries)[0];
  assert.equal(meta.contentHash, digest(bytes)); assert.equal(meta.originalFilename, 'Summer.webp');
  assert.equal(meta.fileSize, bytes.length); assert.equal(meta.createdAt, upload.meta.createdAt);
  assert.equal((await app.call(`uploads/${upload.id}/finish`, {})).data.result.id, result.id);
  // A new session (no in-memory queue) still recognises a saved file.
  const session = await app.store.get(app.id); session.uploads = []; await app.store.save({ ...session, version: session.version + 1 }, session.version);
  const again = await app.start(bytes); assert.equal(again.result.id, result.id); assert.equal(again.result.reused, true);
  assert.equal(app.github.commitCount(), 2);
});

test('corrupt chunks, missing permissions, CSRF, unrelated sessions and oversize files cannot write', async t => {
  const app = await setup(t); const bytes = Buffer.from('photo fixture');
  const upload = await app.start(bytes);
  assert.equal((await app.call(`uploads/${upload.id}/chunks/0`, Buffer.alloc(bytes.length))).status, 400);
  assert.equal((await app.call(`uploads/${upload.id}/chunks/9`, bytes)).status, 400);
  assert.equal((await app.call(`uploads/${upload.id}/chunks/0`, bytes, { 'X-GitGallery-CSRF': 'wrong' })).status, 403);
  assert.equal((await app.call(`uploads/${upload.id}/chunks/0`, bytes, { Cookie: '' })).status, 403);
  assert.equal((await app.call('uploads/start', { ...upload.meta, size: MAX_FILE_SIZE + 1 })).status, 413);
  assert.equal((await app.call('uploads/start', { ...upload.meta, name: 'script.html' })).status, 400);
  app.github.state.writable = false;
  assert.equal((await app.call('uploads/options')).data.writable, false);
  assert.equal((await app.call('uploads/start', upload.meta)).status, 403);
  assert.equal(app.github.commitCount(), 1);
});

test('interrupted chunks resume, cancellation invalidates an upload and a changed repository cannot receive it', async t => {
  const app = await setup(t); const bytes = randomBytes(CHUNK_SIZE + 5); const upload = await app.start(bytes);
  await app.call(`uploads/${upload.id}/chunks/0`, bytes.subarray(0, CHUNK_SIZE));
  app.github.state.failChunk = true;
  assert.equal((await app.call(`uploads/${upload.id}/chunks/1`, bytes.subarray(CHUNK_SIZE))).status, 502);
  const resume = await app.start(bytes); assert.equal(resume.id, upload.id); assert.deepEqual(resume.received, [0]);
  let session = await app.store.get(app.id);
  await app.store.save({ ...session, repo: { ...session.repo, name: 'different' }, version: session.version + 1 }, session.version);
  assert.equal((await app.call(`uploads/${upload.id}/finish`, {})).status, 409);
  session = await app.store.get(app.id);
  await app.store.save({ ...session, repo: { ...session.repo, name: 'gitgallery-photos' }, version: session.version + 1 }, session.version);
  assert.equal((await app.call(`uploads/${upload.id}/cancel`, {})).status, 200);
  assert.equal((await app.call(`uploads/${upload.id}/finish`, {})).status, 410);
  assert.equal(app.github.commitCount(), 1);
});

test('a concurrent mobile commit is preserved and a lost completion response is recovered without duplicates', async t => {
  const app = await setup(t); const bytes = Buffer.from('photo'); const upload = await app.start(bytes);
  await app.chunks(upload.id, bytes); app.github.state.conflict = true; app.github.state.loseResponse = true;
  assert.equal((await app.call(`uploads/${upload.id}/finish`, {})).status, 502);
  const retry = await app.call(`uploads/${upload.id}/finish`, {}); assert.equal(retry.status, 200, JSON.stringify(retry));
  assert.equal(retry.data.result.reused, true);
  const files = app.github.files(); assert.equal(files.get('other-device.txt').toString(), 'Concurrent change');
  assert.equal([...files.keys()].filter(path => path.startsWith('gitgallery/library/')).length, 1);
});

test('logout during final assembly prevents publishing a library commit', async t => {
  const app = await setup(t); const bytes = Buffer.from('photo'); const upload = await app.start(bytes); await app.chunks(upload.id, bytes);
  let entered; let release; const reached = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  app.github.state.beforeBlob = async () => { entered(); await gate; };
  const finish = app.call(`uploads/${upload.id}/finish`, {}); await reached;
  await app.store.delete(app.id); release();
  assert.equal((await finish).status, 409); assert.equal(app.github.commitCount(), 1);
});

test('large originals use verified release pointers and retry an incomplete release asset', async t => {
  const app = await setup(t); const bytes = Buffer.alloc(26 * 1024 * 1024, 7); const upload = await app.start(bytes, { name: 'Ocean.mp4' });
  await app.chunks(upload.id, bytes); app.github.state.incompleteAsset = true;
  assert.equal((await app.call(`uploads/${upload.id}/finish`, {})).status, 502);
  assert.equal(app.github.commitCount(), 1);
  app.github.state.incompleteAsset = false;
  const result = await app.call(`uploads/${upload.id}/finish`, {}); assert.equal(result.status, 200, JSON.stringify(result));
  const pointer = JSON.parse(app.github.files().get(result.data.result.repoPath));
  assert.equal(pointer.tier, 2); assert.equal(pointer.release, 'media-2025'); assert.equal(pointer.size, bytes.length);
  assert.equal(pointer.contentHash, digest(bytes)); assert.equal(app.github.assets.get(pointer.assetId).state, 'uploaded');
  assert.deepEqual(app.github.assets.get(pointer.assetId).bytes, bytes);
});

test('the 500 MB boundary streams to a release with a matching original checksum', async t => {
  const app = await setup(t); const chunk = Buffer.alloc(CHUNK_SIZE, 19);
  const tail = chunk.subarray(0, MAX_FILE_SIZE % CHUNK_SIZE);
  const count = Math.ceil(MAX_FILE_SIZE / CHUNK_SIZE);
  const hashes = Array.from({ length: count }, (_, i) => digest(i === count - 1 ? tail : chunk));
  const begun = await app.call('uploads/start', { name: 'Large video.mp4', size: MAX_FILE_SIZE, hashes, createdAt: Date.UTC(2025, 1, 1) });
  assert.equal(begun.status, 200, JSON.stringify(begun));
  const digestAll = createHash('sha256');
  for (let i = 0; i < count; i++) {
    const bytes = i === count - 1 ? tail : chunk; digestAll.update(bytes);
    const received = await app.call(`uploads/${begun.data.id}/chunks/${i}`, bytes);
    assert.equal(received.status, 200, JSON.stringify(received));
  }
  const finished = await app.call(`uploads/${begun.data.id}/finish`, {});
  assert.equal(finished.status, 200, JSON.stringify(finished));
  const pointer = JSON.parse(app.github.files().get(finished.data.result.repoPath));
  assert.equal(pointer.size, MAX_FILE_SIZE); assert.equal(pointer.contentHash, digestAll.digest('hex'));
});

test('web metadata shards merge entries instead of replacing earlier uploads', async t => {
  const app = await setup(t);
  // Seventeen uploads necessarily share at least one of the sixteen buckets.
  for (let i = 0; i < 17; i++) {
    const bytes = Buffer.from(`photo ${i}`); const upload = await app.start(bytes);
    await app.chunks(upload.id, bytes);
    const result = await app.call(`uploads/${upload.id}/finish`, {}); assert.equal(result.status, 200, JSON.stringify(result));
  }
  const files = app.github.files(); const manifest = JSON.parse(files.get('gitgallery/meta/manifest.json'));
  assert.equal(Object.values(manifest.shards).reduce((sum, shard) => sum + shard.count, 0), 17);
  assert.equal(Object.values(manifest.shards).flatMap(shard => Object.values(JSON.parse(files.get(shard.path)).entries)).length, 17);
});
