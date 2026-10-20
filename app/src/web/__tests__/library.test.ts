import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetsFromTree, isLibraryPath, parseRepository } from '../library';
import { parseCollection, collectionKey } from '../storage';
import { parseCanonicalPath } from '../../services/sync/pathMetadata';
import type { MetaEntry } from '../../services/sync/types';

test('canonical and legacy files are listed once; previews and unrelated paths are excluded', () => {
  const path = 'gitgallery/library/2026/06/01/123456_1200x800_abcd.mp4';
  const assets = assetsFromTree([
    { path: `${path}.ptr`, sha: 'pointer', type: 'blob', size: 100 },
    { path, sha: 'duplicate', type: 'blob', size: 200 },
    { path: `${path}.preview.jpg`, sha: 'preview', type: 'blob' },
    { path: 'gitgallery/images/travel/old.jpg', sha: 'legacy', type: 'blob', size: 150 },
    { path: 'screenshots/android/example.png', sha: 'screenshot', type: 'blob' },
    { path: 'gitgallery/library/../secret.png', sha: 'invalid', type: 'blob' },
  ], [{ repoPath: path, createdAt: 1000, fileSize: 900 } as MetaEntry]);
  assert.equal(assets.length, 2);
  assert.equal(assets[0].kind, 'video');
  assert.equal(assets[0].createdAt, 1000);
  assert.equal(assets[0].size, 900);
  assert.equal(assets[0].width, 1200);
  assert.equal(assets[0].previewPath, `${path}.preview.jpg`);
  assert.equal(assets[1].createdAt, null);
  assert.equal(isLibraryPath('gitgallery/meta/example.jpg'), false);
});

test('path parser preserves native date, dimensions, and pointer identity', () => {
  const parsed = parseCanonicalPath('gitgallery/library/2026/06/01/123456_1200x800_abcd.jpg.ptr');
  assert.equal(parsed.captureDate?.getFullYear(), 2026);
  assert.equal(parsed.captureDate?.getMonth(), 5);
  assert.equal(parsed.captureDate?.getHours(), 12);
  assert.equal(parsed.identity, 'abcd');
  assert.equal(parsed.height, 800);
  assert.equal(parseCanonicalPath('gitgallery/images/album/old.jpg').identity, null);
});

test('repository input accepts GitHub repositories and rejects arbitrary origins and paths', () => {
  assert.deepEqual(parseRepository(' https://github.com/alex/memories.git/ '), { owner: 'alex', name: 'memories' });
  assert.deepEqual(parseRepository('alex/memories'), { owner: 'alex', name: 'memories' });
  for (const value of ['https://example.com/alex/memories', '../secret', 'alex/repo/tree/main', 'alex/repo?token=x', 'https://github.com@evil.com/a/b']) {
    assert.throws(() => parseRepository(value));
  }
});

test('collections recover from corrupt storage and validate stored objects', () => {
  const fallback = { favorites: [], albums: [] };
  assert.deepEqual(parseCollection('{broken', fallback), fallback);
  assert.deepEqual(parseCollection('null', fallback), fallback);
  assert.deepEqual(parseCollection(JSON.stringify({ favorites: ['a', 'a', 1], albums: [null, { id: '1', name: 'Trips', assetIds: ['a', 'a', null] }] }), fallback), {
    favorites: ['a'], albums: [{ id: '1', name: 'Trips', assetIds: ['a'] }],
  });
  assert.notEqual(collectionKey('alice:owner/repo@main'), collectionKey('bob:owner/repo@main'));
});
