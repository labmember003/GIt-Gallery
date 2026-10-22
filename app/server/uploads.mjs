import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

// Each browser request stays below Vercel's 4.5 MB body limit. Only blob IDs,
// never file bytes, are retained in the shared session store.
export const CHUNK_SIZE = 3 * 1024 * 1024;
export const MAX_FILE_SIZE = 500 * 1024 * 1024;
const GIT_LIMIT = 25 * 1024 * 1024;
const PREVIEW_LIMIT = 512 * 1024;
const AGE = 2 * 60 * 60 * 1000;
const EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'avif', 'mp4', 'mov', 'm4v', 'webm'];
const MANIFEST = 'gitgallery/meta/manifest.json';
const hash = value => createHash('sha256').update(value).digest('hex');
const sameRepo = (a, b) => a && b && a.owner === b.owner && a.name === b.name && a.branch === b.branch;
export class UploadError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new UploadError(status, message); };
const sha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

async function binary(request, limit) {
  if (request.headers['content-type'] !== 'application/octet-stream') fail(415, 'Use a binary upload request.');
  if (Number(request.headers['content-length']) > limit) fail(413, 'This upload part is too large.');
  const parts = []; let length = 0;
  for await (const part of request) {
    length += part.length;
    if (length > limit) fail(413, 'This upload part is too large.');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

function metadata(input, now) {
  const extension = typeof input.name === 'string' ? input.name.split('.').pop().toLowerCase() : '';
  if (!input.name || input.name.length > 255 || /[\x00-\x1f]/.test(input.name) || !EXTENSIONS.includes(extension)) fail(400, 'Choose a supported photo or video file.');
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > MAX_FILE_SIZE) fail(413, 'Choose a file between 1 byte and 500 MB.');
  if (!Array.isArray(input.hashes) || input.hashes.length !== Math.ceil(input.size / CHUNK_SIZE)
    || input.hashes.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) fail(400, 'The file checksum is incomplete. Choose the file again.');
  const date = Number.isFinite(input.createdAt) && input.createdAt >= 0 && input.createdAt < now + 86_400_000 ? Math.floor(input.createdAt) : now;
  const dimension = value => Number.isSafeInteger(value) && value > 0 && value <= 100_000 ? value : 0;
  const fingerprint = hash(JSON.stringify([input.size, extension, input.hashes]));
  const [day, time] = new Date(date).toISOString().split('T');
  const path = `gitgallery/library/${day.replaceAll('-', '/')}/${time.slice(0, 8).replaceAll(':', '')}_${dimension(input.width)}x${dimension(input.height)}_${fingerprint}.${extension}`;
  return { name: input.name.split(/[\\/]/).pop(), size: input.size, hashes: input.hashes, createdAt: date,
    width: dimension(input.width), height: dimension(input.height), fingerprint, path,
    bucket: `web-${fingerprint[0]}`, shard: `gitgallery/meta/shards/web-${fingerprint[0]}.json` };
}

/** A narrow write API: clients supply file bytes, never repository paths or Git operations. */
export function createUploadHandler({ fetcher, now, save, active, body }) {
  return async function upload(request, url, session) {
    if (url.search) fail(400, 'Unsupported upload query.');
    if (!session.repo) fail(400, 'Open your library before uploading.');
    const repo = { ...session.repo };
    const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
    const signal = AbortSignal.timeout(270_000);
    const api = async (path, method = 'GET', data, { missing = false, raw = false, conflict = false } = {}) => {
      const response = await fetcher(`https://api.github.com${base}${path}`, {
        method, redirect: 'error', signal,
        headers: { Authorization: `Bearer ${session.token}`, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'User-Agent': 'GitGallery-Web', 'X-GitHub-Api-Version': '2022-11-28', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      if (missing && response.status === 404) return null;
      if (conflict && [409, 422].includes(response.status)) return null;
      if (!response.ok) {
        if (response.status === 401) fail(401, 'Your GitHub session expired. Sign in again, then choose your files to resume.');
        if (response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0') fail(429, 'GitHub’s request limit was reached. Wait a few minutes, then retry the upload.');
        if (response.status === 403) fail(403, 'GitHub did not allow this upload. You need write access to this repository. If access changed, sign out and sign in again.');
        if (response.status === 404) fail(404, 'This library or branch is no longer available. Check your repository access.');
        fail(502, 'GitHub could not save this file. Retry the upload in a moment.');
      }
      return response.status === 204 ? {} : raw ? Buffer.from(await response.arrayBuffer()) : response.json();
    };
    const writable = async () => {
      const info = await api('');
      return info.permissions?.push === true && !info.archived && !info.disabled;
    };
    const requireWrite = async () => { if (!await writable()) fail(403, 'You have view-only access to this repository. Switch to a library you own, or ask its owner for write access.'); };
    const blob = async bytes => {
      await active(session);
      const result = await api('/git/blobs', 'POST', { content: bytes.toString('base64'), encoding: 'base64' });
      if (!sha(result.sha)) fail(502, 'GitHub did not confirm the uploaded file. Retry the upload.');
      return result.sha;
    };
    const readJSON = async (path, ref) => {
      const result = await api(`/contents/${path}?ref=${encodeURIComponent(ref)}`, 'GET', undefined, { missing: true });
      if (!result) return null;
      if (result.encoding !== 'base64' || typeof result.content !== 'string') fail(409, 'The library metadata could not be read safely. Refresh your library and try again.');
      try { return JSON.parse(Buffer.from(result.content, 'base64').toString()); }
      catch { fail(409, 'The library metadata is damaged. Uploads are paused to protect your existing library.'); }
    };
    const head = async () => {
      const ref = await api(`/git/ref/heads/${encodeURIComponent(repo.branch)}`);
      if (!sha(ref.object?.sha)) fail(409, 'Initialize this repository with a README on GitHub before uploading.');
      return ref.object.sha;
    };
    const existing = async (item, ref) => {
      const doc = await readJSON(item.shard, ref);
      const entry = doc?.entries?.[`web:${item.fingerprint}`];
      if (!entry || entry.fileSize !== item.size || typeof entry.repoPath !== 'string'
        || !entry.repoPath.startsWith('gitgallery/library/') || !/^[a-f0-9]{64}$/.test(entry.contentHash ?? '')) return null;
      const file = await api(`/contents/${entry.repoPath}?ref=${encodeURIComponent(ref)}`, 'GET', undefined, { missing: true });
      return file ? { id: entry.repoPath.replace(/\.ptr$/, ''), repoPath: entry.repoPath, name: item.name, reused: true } : null;
    };
    const visible = item => ({ id: item.id, received: item.parts.map((part, index) => part ? index : null).filter(index => index !== null), result: item.result ?? null });

    if (url.pathname === '/api/uploads/options' && request.method === 'GET') {
      return { chunkSize: CHUNK_SIZE, maxFileSize: MAX_FILE_SIZE, extensions: EXTENSIONS, writable: await writable() };
    }
    if (request.method !== 'POST') fail(405, 'Method not allowed.');
    if (url.pathname === '/api/uploads/start') {
      const meta = metadata(await body(request), now());
      await requireWrite();
      session.uploads = (session.uploads ?? []).filter(item => item.expires > now());
      const previous = session.uploads.find(item => sameRepo(item.repo, repo) && item.fingerprint === meta.fingerprint);
      if (previous) return { ...visible(previous), result: previous.result ? { ...previous.result, reused: true } : null };
      const result = await existing(meta, await head());
      if (result) return { id: null, received: [], result };
      if (session.uploads.filter(item => !item.result).length >= 4) fail(409, 'Finish or stop your other uploads first, then retry.');
      session.uploads = session.uploads.filter(item => !item.result).concat(session.uploads.filter(item => item.result).slice(-12));
      const item = { ...meta, id: randomUUID(), repo, parts: meta.hashes.map(() => null), expires: Math.min(session.expires, now() + AGE) };
      session.uploads.push(item);
      await save(session);
      return visible(item);
    }
    const match = url.pathname.match(/^\/api\/uploads\/([a-f0-9-]{36})\/(chunks\/\d+|preview|finish|cancel)$/);
    if (!match) fail(404, 'Upload action not found.');
    const item = session.uploads?.find(upload => upload.id === match[1]);
    if (!item || item.expires <= now()) fail(410, 'This upload expired. Choose the same file again to restart it.');
    if (!sameRepo(item.repo, repo)) fail(409, 'Your library changed. Switch back to the original library to finish this upload.');
    const action = match[2];
    if (action === 'cancel') {
      session.uploads = session.uploads.filter(upload => upload !== item);
      await save(session);
      return { stopped: true };
    }
    if (item.result) return { result: item.result };
    if (item.busyUntil > now()) fail(409, 'This file is still being saved. Wait a moment, then retry.');
    if (action.startsWith('chunks/')) {
      const index = Number(action.slice(7));
      if (!Number.isSafeInteger(index) || index < 0 || index >= item.parts.length) fail(400, 'Invalid upload part.');
      const bytes = await binary(request, CHUNK_SIZE);
      const expected = Math.min(CHUNK_SIZE, item.size - index * CHUNK_SIZE);
      if (bytes.length !== expected || hash(bytes) !== item.hashes[index]) fail(400, 'This upload part did not match your file. Retry the upload.');
      if (!item.parts[index]) { item.parts[index] = await blob(bytes); await save(session); }
      return { received: index };
    }
    if (action === 'preview') {
      const bytes = await binary(request, PREVIEW_LIMIT);
      if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) fail(400, 'Invalid photo preview.');
      item.preview = await blob(bytes); await save(session);
      return { ready: true };
    }
    if (item.parts.some(part => !part)) fail(409, 'Some file parts are missing. Retry the upload to send them.');
    await requireWrite();
    item.busyUntil = now() + 285_000;
    await save(session);
    try {
      let current = await head();
      const already = await existing(item, current);
      if (already) { item.result = already; delete item.busyUntil; await save(session); return { result: already }; }
      const digest = createHash('sha256');
      async function* bytes() {
        for (let index = 0; index < item.parts.length; index++) {
          signal.throwIfAborted();
          await active(session);
          const part = await api(`/git/blobs/${item.parts[index]}`, 'GET', undefined, { raw: true });
          if (part.length !== Math.min(CHUNK_SIZE, item.size - index * CHUNK_SIZE) || hash(part) !== item.hashes[index]) fail(502, 'A saved file part could not be verified. Retry the upload.');
          digest.update(part); yield part;
        }
      }
      let originalSHA; let contentHash; let pointer;
      if (item.size <= GIT_LIMIT) {
        const parts = []; for await (const part of bytes()) parts.push(part);
        contentHash = digest.digest('hex');
        originalSHA = parts.length === 1 ? item.parts[0] : await blob(Buffer.concat(parts));
      } else {
        // Match mobile's release-asset + .ptr format. Stream bounded chunks;
        // even a 500 MB video does not have to fit in server or browser memory.
        let release; let asset; let tag;
        const name = `${item.fingerprint}.${item.path.split('.').pop()}`;
        for (let index = 0; index < 100; index++) {
          tag = `media-${new Date(item.createdAt).getUTCFullYear()}${index ? `-web-${index}` : ''}`;
          release = await api(`/releases/tags/${tag}`, 'GET', undefined, { missing: true });
          if (!release) {
            await active(session);
            release = await api('/releases', 'POST', { tag_name: tag, target_commitish: repo.branch,
              name: `GitGallery media ${tag.slice(6)}`, body: 'Original photos and videos stored by GitGallery.', draft: false, prerelease: false }, { conflict: true });
            if (!release) release = await api(`/releases/tags/${tag}`);
          }
          if (!Number.isSafeInteger(release.id)) fail(502, 'GitHub did not confirm the media release. Retry the upload.');
          let count = 0;
          for (let page = 1; page <= 10; page++) {
            const list = await api(`/releases/${release.id}/assets?per_page=100&page=${page}`);
            if (!Array.isArray(list)) fail(502, 'GitHub could not list the uploaded videos. Retry the upload.');
            count += list.length; asset = list.find(value => value.name === name) ?? asset;
            if (asset || list.length < 100) break;
          }
          if (asset || count < 900) break;
          release = null;
        }
        if (!release) fail(409, 'This library has reached its media-release capacity. Choose another repository.');
        if (asset && (asset.state !== 'uploaded' || asset.size !== item.size)) {
          // Only remove our deterministic, incomplete staging asset, never a
          // completed original or an asset belonging to a different upload.
          if (asset.state !== 'starter') fail(409, 'GitHub has an incomplete copy of this file. Try again later.');
          await active(session);
          await api(`/releases/assets/${asset.id}`, 'DELETE');
          asset = null;
        }
        if (!asset) {
          await active(session);
          const response = await fetcher(`https://uploads.github.com${base}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
            method: 'POST', redirect: 'error', signal, duplex: 'half',
            headers: { Authorization: `Bearer ${session.token}`, Accept: 'application/vnd.github+json',
              'User-Agent': 'GitGallery-Web', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/octet-stream', 'Content-Length': String(item.size) },
            body: Readable.from(bytes()),
          });
          if (!response.ok) fail(response.status === 401 ? 401 : 502, 'GitHub could not finish saving this video. Retry the upload; your received file parts are kept.');
          asset = await response.json();
        } else {
          // Recompute the true original checksum when recovering a completed
          // asset after a timeout; the multipart identity is not a file hash.
          for await (const _part of bytes()) { /* verified by the iterator */ }
        }
        contentHash = digest.digest('hex');
        if (asset.state !== 'uploaded' || asset.size !== item.size || !Number.isSafeInteger(asset.id)
          || (asset.digest && asset.digest !== `sha256:${contentHash}`)) fail(502, 'GitHub did not confirm the complete video. Retry the upload.');
        pointer = { tier: 2, release: tag, assetId: asset.id, name: asset.name, size: item.size, contentHash,
          ...(item.preview ? { preview: `${item.path}.preview.jpg` } : {}) };
        originalSHA = await blob(Buffer.from(JSON.stringify(pointer)));
      }
      const repoPath = item.path + (pointer ? '.ptr' : '');
      const entry = { fingerprint: `web:${item.fingerprint}`, repoPath, createdAt: item.createdAt,
        fileSize: item.size, contentHash, uploadedAt: now(), updatedAt: now(), originalFilename: item.name,
        ...(item.preview ? { previewRepoPath: `${item.path}.preview.jpg` } : {}) };
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) current = await head();
        const recovered = attempt ? await existing(item, current) : null;
        if (recovered) { item.result = recovered; break; }
        const commit = await api(`/git/commits/${current}`);
        const manifest = await readJSON(MANIFEST, current) ?? { version: 1, shards: {} };
        if (manifest.version !== 1 || !manifest.shards || typeof manifest.shards !== 'object' || Array.isArray(manifest.shards)) fail(409, 'This library’s metadata format is not supported for uploads. Your existing files are safe.');
        const shard = await readJSON(item.shard, current) ?? { version: 1, bucket: item.bucket, entries: {} };
        if (shard.version !== 1 || !shard.entries || typeof shard.entries !== 'object' || Array.isArray(shard.entries)) fail(409, 'This library’s photo metadata could not be updated safely. Refresh and try again.');
        shard.entries[entry.fingerprint] = entry; shard.generatedAt = now();
        const shardSHA = await blob(Buffer.from(JSON.stringify(shard)));
        manifest.updatedAt = now();
        manifest.shards[item.bucket] = { path: item.shard, count: Object.keys(shard.entries).length, updatedAt: now() };
        const manifestSHA = await blob(Buffer.from(JSON.stringify(manifest)));
        const treeEntries = [[repoPath, originalSHA], [item.shard, shardSHA], [MANIFEST, manifestSHA]];
        if (item.preview) treeEntries.push([`${item.path}.preview.jpg`, item.preview]);
        await active(session);
        const tree = await api('/git/trees', 'POST', { base_tree: commit.tree.sha, tree: treeEntries.map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha })) });
        const next = await api('/git/commits', 'POST', { message: `Add photo or video with GitGallery`, tree: tree.sha, parents: [current] });
        await active(session);
        const moved = await api(`/git/refs/heads/${encodeURIComponent(repo.branch)}`, 'PATCH', { sha: next.sha, force: false }, { conflict: true });
        if (moved) { item.result = { id: item.path, repoPath, name: item.name, reused: false }; break; }
      }
      if (!item.result) fail(409, 'GitHub could not update this branch. It may be protected or changing elsewhere. Retry once; if it continues, choose a writable library branch or ask the repository owner to allow uploads.');
      delete item.busyUntil;
      await save(session);
      return { result: item.result };
    } catch (error) {
      delete item.busyUntil;
      await save(session).catch(() => {}); // Never resurrect a signed-out/cancelled session.
      throw error;
    }
  };
}
