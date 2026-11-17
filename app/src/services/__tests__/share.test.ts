import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import {
  CHUNK_SIZE, PART_CHUNKS, concat, fromBase64Url, newShareId, objectId, openBytes, openManifest, parseShareUrl,
  partCount, sealBytes, sealManifest, shareUrl, toBase64Url, type ShareManifest,
} from '../share/format';

const rnd = (n: number) => new Uint8Array(randomBytes(n));
const key = rnd(32);

test('base64url round-trips every length', () => {
  for (let n = 0; n < 70; n++) {
    const b = rnd(n);
    assert.deepEqual(fromBase64Url(toBase64Url(b)), b);
  }
  assert.equal(toBase64Url(key).length, 43);
});

test('share links round-trip and reject anything malformed', () => {
  const ref = { owner: 'kapoorkhushi03', id: newShareId(rnd), key: toBase64Url(key) };
  const url = shareUrl(ref);
  assert.match(url, /^https:\/\/gitgallery-umber\.vercel\.app\/s\/kapoorkhushi03\/[a-z0-9]{16}#[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(parseShareUrl(url), ref);
  assert.deepEqual(parseShareUrl(`gitgallery://share/${ref.owner}/${ref.id}#${ref.key}`), ref);
  assert.equal(parseShareUrl(url.replace(/#.*/, '')), null, 'no key, no share');
  assert.equal(parseShareUrl(url.slice(0, -1)), null, 'short key');
  assert.equal(parseShareUrl(url.replace('kapoorkhushi03', '../etc')), null);
  assert.equal(parseShareUrl('https://evil.example/x'), null);
});

test('objects of every size seal and open, split into parts', () => {
  for (const size of [0, 1, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, CHUNK_SIZE * PART_CHUNKS + 5]) {
    const plain = rnd(size);
    const parts = sealBytes(key, objectId('a', 'o'), plain, rnd);
    assert.equal(parts.length, partCount(size), `parts for ${size}`);
    assert.deepEqual(openBytes(key, objectId('a', 'o'), size, parts), plain);
  }
});

test('tampering is detected: wrong key, swapped object, truncation, flipped bit', () => {
  const plain = rnd(CHUNK_SIZE * 2 + 10);
  const parts = sealBytes(key, objectId('a', 'o'), plain, rnd);
  assert.throws(() => openBytes(rnd(32), objectId('a', 'o'), plain.length, parts));
  assert.throws(() => openBytes(key, objectId('b', 'o'), plain.length, parts), 'bound to its object');
  const all = concat(parts);
  const firstRecord = CHUNK_SIZE + 40;
  assert.throws(() => openBytes(key, objectId('a', 'o'), CHUNK_SIZE, [all.subarray(0, firstRecord)]), 'cut after a full chunk');
  const flipped = all.slice();
  flipped[100] ^= 1;
  assert.throws(() => openBytes(key, objectId('a', 'o'), plain.length, [flipped]));
});

test('manifest seals with its size and opens on its own', () => {
  const manifest: ShareManifest = { v: 1, title: 'Goa', owner: 'kapoorkhushi03', createdAt: 1, updatedAt: 2, cover: null, items: [
    { id: 'x1', src: 'abcd', kind: 'photo', w: 10, h: 20, takenAt: 3, ext: 'jpg', preview: { size: 5, parts: 1 }, original: { size: 9, parts: 1 } },
  ] };
  const sealed = sealManifest(key, manifest, rnd);
  assert.deepEqual(openManifest(key, sealed.bytes), manifest);
  assert.throws(() => openManifest(rnd(32), sealed.bytes));
  assert.equal(new TextDecoder().decode(sealed.bytes).includes('Goa'), false, 'title is not readable');
});
