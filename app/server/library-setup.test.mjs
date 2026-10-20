import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareLibrary, selectedRepository, LibrarySetupError } from './library-setup.mjs';

const info = (name = 'gitgallery-photos', branch = 'trunk') => ({ id: 1, full_name: `tester/${name}`, default_branch: branch, private: true });
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const listing = page => `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`;

test('the mobile default opens directly and preserves its real default branch', async () => {
  const paths = [];
  const result = await prepareLibrary({ login: 'tester', request: async path => { paths.push(path); return json(info()); } });
  assert.deepEqual(paths, ['/repos/tester/gitgallery-photos']);
  assert.deepEqual(selectedRepository(result.repository), { owner: 'tester', name: 'gitgallery-photos', branch: 'trunk' });
  assert.equal(result.created, false);
});

test('custom libraries on later pages are found through canonical and legacy directories', async () => {
  const writes = [];
  const result = await prepareLibrary({ login: 'tester', request: async (path, values) => {
    if (values) writes.push(values);
    if (path === listing(1)) return json([info('code'), info('memories')], 200, { link: '<https://api.github.com/user/repos?page=2>; rel="next"' });
    if (path === listing(2)) return json([info('old-backup', 'albums/travel')]);
    if (path === '/repos/tester/memories/contents/gitgallery?ref=trunk') return json([{ name: 'library', type: 'dir' }]);
    if (path === '/repos/tester/old-backup/contents/gitgallery?ref=albums%2Ftravel') return json([{ name: 'images', type: 'dir' }]);
    return json({}, 404);
  } });
  assert.deepEqual(result.choices.map(repo => repo.fullName), ['tester/memories', 'tester/old-backup']);
  assert.deepEqual(writes, []);
});

test('a single custom mobile library is reused, including an empty one with the mobile description', async () => {
  for (const marked of [false, true]) {
    const result = await prepareLibrary({ login: 'tester', request: async (path, values) => {
      assert.equal(values, undefined);
      if (path === listing(1)) return json([{ ...info('memories'), description: marked ? 'Private repo for GitGallery' : 'Memories' }]);
      if (path.includes('/contents/gitgallery')) return json([{ name: 'meta', type: 'dir' }]);
      return json({}, 404);
    } });
    assert.equal(result.repository.full_name, 'tester/memories');
    assert.equal(result.created, false);
  }
});

test('first-time setup creates only the initialized private default, and the next session reuses it', async () => {
  let created = false; let writes = 0; let checkedSession = 0;
  const request = async (path, values) => {
    if (path === listing(1)) return json([]);
    if (path === '/user/repos' && values) {
      writes++; assert.equal(checkedSession, 1);
      assert.deepEqual(values, { name: 'gitgallery-photos', description: 'Private repo for GitGallery', private: true, auto_init: true });
      created = true; return json(info(), 201);
    }
    return created ? json(info()) : json({}, 404);
  };
  const options = { login: 'tester', request, beforeCreate: async () => { checkedSession++; } };
  assert.equal((await prepareLibrary(options)).created, true);
  assert.equal((await prepareLibrary(options)).created, false);
  assert.equal(writes, 1);
});

test('failed discovery and missing private scopes never fall through to creation', async () => {
  for (const stage of ['default', 'list', 'directory', 'scope']) {
    for (const status of [403, 429, 500]) {
      let writes = 0;
      await assert.rejects(prepareLibrary({ login: 'tester', request: async (path, values) => {
        if (values) writes++;
        if (path === '/repos/tester/gitgallery-photos') return json({}, stage === 'default' ? status : 404);
        if (stage === 'scope') return json([], 200, { 'x-oauth-scopes': 'read:user, public_repo' });
        if (path === listing(1)) return stage === 'list' ? json({}, status) : json([info('memories')]);
        return json({}, status);
      } }), LibrarySetupError);
      assert.equal(writes, 0);
    }
  }
});

test('simultaneous account setup reuses a name collision and never invents another name', async () => {
  let lookups = 0; const names = [];
  const result = await prepareLibrary({ login: 'tester', beforeCreate: async () => {}, request: async (path, values) => {
    if (values) { names.push(values.name); return json({}, 422); }
    if (path === listing(1)) return json([]);
    return ++lookups === 1 ? json({}, 404) : json(info());
  } });
  assert.equal(result.created, false); assert.deepEqual(names, ['gitgallery-photos']);
  await assert.rejects(prepareLibrary({ login: 'tester', beforeCreate: async () => {}, request: async (path, values) => {
    if (values) return json({}, 422);
    return path === listing(1) ? json([]) : json({}, 404);
  } }), error => error.status === 409 && /already exist without access/.test(error.message));
});

test('a partial large-account scan does not create a second library', async () => {
  let pages = 0;
  await assert.rejects(prepareLibrary({ login: 'tester', request: async (path, values) => {
    assert.equal(values, undefined);
    if (path.startsWith('/user/repos?')) { pages++; return json([], 200, { link: '<https://api.github.com/user/repos?page=11>; rel="next"' }); }
    return json({}, 404);
  } }), error => error.status === 409);
  assert.equal(pages, 10);
});

test('a creation permission error gives actionable sign-in steps', async () => {
  await assert.rejects(prepareLibrary({ login: 'tester', beforeCreate: async () => {}, request: async (path, values) => {
    if (values) return json({}, 403);
    return path === listing(1) ? json([]) : json({}, 404);
  } }), error => error.status === 403 && /Sign out and sign in with GitHub/.test(error.message));
});
