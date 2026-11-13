import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOps, coverPathFor, emptyDoc, isAlbumNameTaken, normalizeAlbumPath, parseAlbumsDoc, serializeAlbumsDoc, type AlbumOp } from '../albums/model';

const P1 = 'gitgallery/library/2026/01/02/101010_4000x3000_aaaa1111.jpg';
const P2 = 'gitgallery/library/2026/03/04/090000_1920x1080_bbbb2222.mp4.ptr';
const P3 = 'gitgallery/library/2025/12/31/235959_100x100_cccc3333.jpg';

test('create, add, rename, cover, remove, delete replay in order', () => {
  const ops: AlbumOp[] = [
    { type: 'create', id: 'a1', name: '  Goa   trip ', at: 1 },
    { type: 'add', id: 'a1', paths: [P1, P2, P1], at: 2 },
    { type: 'rename', id: 'a1', name: 'Goa', at: 3 },
    { type: 'cover', id: 'a1', path: P1, at: 4 },
  ];
  const doc = applyOps(emptyDoc(), ops);
  assert.equal(doc.albums.length, 1);
  assert.equal(doc.albums[0].name, 'Goa');
  // .ptr is stripped and duplicates collapse.
  assert.deepEqual(doc.albums[0].items, [P1, P2.replace(/\.ptr$/, '')]);
  assert.equal(doc.albums[0].cover, P1);

  const removed = applyOps(doc, [{ type: 'remove', id: 'a1', paths: [P1], at: 5 }]);
  assert.deepEqual(removed.albums[0].items, [P2.replace(/\.ptr$/, '')]);
  assert.equal(removed.albums[0].cover, null, 'removing the cover photo clears the cover');

  const deleted = applyOps(removed, [{ type: 'delete', id: 'a1', at: 6 }]);
  assert.equal(deleted.albums.length, 0);
  assert.equal(doc.albums[0].items.length, 2, 'applyOps never mutates its input');
});

test('edits from two devices merge instead of overwriting', () => {
  const base = applyOps(emptyDoc(), [{ type: 'create', id: 'a1', name: 'Goa', at: 1 }, { type: 'add', id: 'a1', paths: [P1], at: 2 }]);
  // Phone B added P3 and pushed first; phone A replays its own add on top.
  const remote = applyOps(base, [{ type: 'add', id: 'a1', paths: [P3], at: 3 }]);
  const merged = applyOps(remote, [{ type: 'add', id: 'a1', paths: [P2], at: 4 }]);
  assert.deepEqual(merged.albums[0].items, [P1, P3, normalizeAlbumPath(P2)]);
});

test('adding to an album deleted elsewhere does not bring it back', () => {
  const doc = applyOps(emptyDoc(), [{ type: 'add', id: 'gone', paths: [P1], at: 1 }, { type: 'rename', id: 'gone', name: 'x', at: 2 }]);
  assert.equal(doc.albums.length, 0);
});

test('parse tolerates junk and round-trips', () => {
  assert.deepEqual(parseAlbumsDoc('not json').albums, []);
  assert.deepEqual(parseAlbumsDoc({ albums: [null, { id: 1 }, { id: 'x', name: '' }] }).albums, []);
  const doc = applyOps(emptyDoc(), [{ type: 'create', id: 'a1', name: 'Goa', at: 1 }, { type: 'add', id: 'a1', paths: [P1], at: 2 }]);
  assert.deepEqual(parseAlbumsDoc(serializeAlbumsDoc(doc)), doc);
  const dup = parseAlbumsDoc({ albums: [{ id: 'a', name: 'A', items: [P2, normalizeAlbumPath(P2)] }, { id: 'a', name: 'B' }] });
  assert.equal(dup.albums.length, 1);
  assert.deepEqual(dup.albums[0].items, [normalizeAlbumPath(P2)]);
});

test('names are unique ignoring case; cover falls back to the newest item', () => {
  const doc = applyOps(emptyDoc(), [{ type: 'create', id: 'a1', name: 'Goa', at: 1 }, { type: 'add', id: 'a1', paths: [P3, P1, P2], at: 2 }]);
  assert.equal(isAlbumNameTaken(doc.albums, 'goa'), true);
  assert.equal(isAlbumNameTaken(doc.albums, 'goa', 'a1'), false);
  assert.equal(coverPathFor(doc.albums[0]), normalizeAlbumPath(P2));
});
