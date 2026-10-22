// Stateful GitHub protocol fixture. Never imported by production code.
import { createHash } from 'node:crypto';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const oid = bytes => createHash('sha1').update(bytes).digest('hex');
export function uploadGitHub({ owner = 'uploader', name = 'gitgallery-photos', writable = true } = {}) {
  const blobs = new Map(); const trees = new Map(); const commits = new Map(); const releases = new Map(); const assets = new Map();
  const requests = []; let counter = 1;
  const state = { writable, failChunk: false, conflict: false, incompleteAsset: false, beforeRef: null, beforeBlob: null, beforeRelease: null, loseResponse: false };
  const putBlob = bytes => { const id = oid(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])); blobs.set(id, bytes); return id; };
  let tree = { 'README.md': putBlob(Buffer.from('Fixture library')) };
  const putTree = value => { const id = oid(JSON.stringify(value)); trees.set(id, structuredClone(value)); return id; };
  const putCommit = (tree, parents = []) => { const id = oid(JSON.stringify([tree, parents, counter++])); commits.set(id, { sha: id, tree: { sha: tree }, parents }); return id; };
  let head = putCommit(putTree(tree));
  const info = { id: 77, full_name: `${owner}/${name}`, private: true, default_branch: 'main', description: 'Private repo for GitGallery', permissions: { push: writable } };
  const fetcher = async (input, options = {}) => {
    const url = new URL(String(input)); const method = options.method ?? 'GET';
    requests.push({ path: url.pathname, method, body: typeof options.body === 'string' && options.body.length < 65536 ? JSON.parse(options.body) : undefined });
    if (url.pathname === '/user') return json({ id: 77, login: owner, name: 'Test Photographer' });
    if (url.pathname === '/user/repos') return json([{ ...info, permissions: { push: state.writable } }]);
    const base = `/repos/${owner}/${name}`;
    if (url.pathname === base) return json({ ...info, permissions: { push: state.writable } });
    if (!url.pathname.startsWith(`${base}/`)) return json({}, 404);
    const path = decodeURIComponent(url.pathname.slice(base.length));
    const data = typeof options.body === 'string' ? JSON.parse(options.body) : undefined;
    if (path === '/git/ref/heads/main') return json({ object: { sha: head } });
    if (path === '/git/refs/heads/main' && method === 'PATCH') {
      if (state.beforeRef) await state.beforeRef();
      if (state.conflict) {
        state.conflict = false;
        const extra = { ...trees.get(commits.get(head).tree.sha), 'other-device.txt': putBlob(Buffer.from('Concurrent change')) };
        head = putCommit(putTree(extra), [head]);
        return json({}, 422);
      }
      const commit = commits.get(data.sha);
      if (data.force !== false || commit?.parents[0] !== head) return json({}, 422);
      head = data.sha;
      if (state.loseResponse) { state.loseResponse = false; throw new Error('Connection lost after accepted commit'); }
      return json({ object: { sha: head } });
    }
    if (path === '/git/blobs' && method === 'POST') {
      if (state.beforeBlob) await state.beforeBlob();
      if (state.failChunk) { state.failChunk = false; return json({}, 502); }
      return json({ sha: putBlob(Buffer.from(data.content, 'base64')) }, 201);
    }
    if (path.startsWith('/git/blobs/')) {
      const bytes = blobs.get(path.split('/').pop());
      if (!bytes) return json({}, 404);
      return options.headers.Accept === 'application/vnd.github.raw+json' ? new Response(bytes) : json({ content: bytes.toString('base64'), encoding: 'base64' });
    }
    if (path === '/git/trees' && method === 'POST') {
      const next = { ...trees.get(data.base_tree) };
      for (const entry of data.tree) next[entry.path] = entry.sha;
      return json({ sha: putTree(next) }, 201);
    }
    if (path.startsWith('/git/trees/')) {
      const id = path.split('/').pop();
      const selected = id === 'main' ? commits.get(head).tree.sha : id;
      return json({ sha: selected, tree: Object.entries(trees.get(selected) ?? {}).map(([path, sha]) => ({ path, sha, type: 'blob', size: blobs.get(sha)?.length })) });
    }
    if (path === '/git/commits' && method === 'POST') return json({ sha: putCommit(data.tree, data.parents) }, 201);
    if (path.startsWith('/git/commits/')) return json(commits.get(path.split('/').pop()));
    if (path.startsWith('/contents/')) {
      const ref = url.searchParams.get('ref');
      const selected = ref && commits.has(ref) ? ref : head;
      const entries = trees.get(commits.get(selected).tree.sha);
      const id = entries[path.slice('/contents/'.length)];
      if (!id) return json({}, 404);
      return json({ sha: id, encoding: 'base64', content: blobs.get(id).toString('base64') });
    }
    if (path.startsWith('/releases/tags/')) return releases.has(path.slice(15)) ? json(releases.get(path.slice(15))) : json({}, 404);
    if (path === '/releases' && method === 'POST') {
      const release = { id: counter++, tag_name: data.tag_name }; releases.set(data.tag_name, release); return json(release, 201);
    }
    const listing = path.match(/^\/releases\/(\d+)\/assets$/);
    if (listing && url.hostname === 'uploads.github.com') {
      if (state.beforeRelease) await state.beforeRelease();
      const hash = createHash('sha256'); let size = 0; const parts = [];
      for await (const bytes of options.body) { hash.update(bytes); size += bytes.length; if (size <= 30 * 1024 * 1024) parts.push(bytes); else parts.length = 0; }
      if (size !== Number(options.headers['Content-Length'])) return json({}, 400);
      const asset = { id: counter++, release: Number(listing[1]), size, name: url.searchParams.get('name'), state: state.incompleteAsset ? 'starter' : 'uploaded', digest: `sha256:${hash.digest('hex')}` };
      // Keep test downloads for browser videos; the 500 MB test checks size/hash
      // without retaining a second full original in memory.
      if (size <= 30 * 1024 * 1024) asset.bytes = Buffer.concat(parts);
      assets.set(asset.id, asset); const { bytes: _bytes, ...safe } = asset; return json(safe, 201);
    }
    if (listing) {
      const page = Number(url.searchParams.get('page') ?? 1);
      return json([...assets.values()].filter(asset => asset.release === Number(listing[1])).slice((page - 1) * 100, page * 100).map(({ bytes, ...safe }) => safe));
    }
    const assetId = path.match(/^\/releases\/assets\/(\d+)$/);
    if (assetId) {
      const asset = assets.get(Number(assetId[1]));
      if (method === 'DELETE') { assets.delete(Number(assetId[1])); return new Response(null, { status: 204 }); }
      return asset?.bytes ? new Response(asset.bytes) : json({}, 404);
    }
    return json({}, 404);
  };
  return { fetcher, state, blobs, assets, requests,
    files: () => new Map(Object.entries(trees.get(commits.get(head).tree.sha)).map(([path, sha]) => [path, blobs.get(sha)])),
    commitCount: () => commits.size,
  };
}
