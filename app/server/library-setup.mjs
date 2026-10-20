const DEFAULT_REPOSITORY = 'gitgallery-photos';
const repoPart = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export class LibrarySetupError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function selectedRepository(info) {
  const parts = typeof info.full_name === 'string' ? info.full_name.split('/') : [];
  if (parts.length !== 2 || !parts.every(part => repoPart.test(part)) || typeof info.default_branch !== 'string' || !info.default_branch) {
    throw new LibrarySetupError(502, 'GitHub returned an invalid repository. Please try again.');
  }
  return { owner: parts[0], name: parts[1], branch: info.default_branch };
}

export function repositorySummary(info) {
  selectedRepository(info);
  return { id: info.id, fullName: info.full_name, description: info.description ?? null,
    private: !!info.private, branch: info.default_branch, writable: !!info.permissions?.push };
}

async function checked(response) {
  if (response.ok) return response;
  throw new LibrarySetupError(response.status, response.status === 401 ? 'Your GitHub session has expired. Sign in again.'
    : response.status === 403 || response.status === 429
      ? 'GitHub could not give us access to your libraries. Try again later, or sign out and sign in with GitHub, allowing repository access.'
      : 'We could not finish checking your existing libraries. Try again before creating a new one.');
}

/** Prefer the mobile default; otherwise discover custom libraries before creating anything. */
export async function prepareLibrary({ login, request, beforeCreate }) {
  if (!repoPart.test(login)) throw new LibrarySetupError(502, 'GitHub returned an invalid account.');
  const defaultPath = `/repos/${encodeURIComponent(login)}/${DEFAULT_REPOSITORY}`;
  const existing = await request(defaultPath);
  if (existing.ok) return { repository: await existing.json(), created: false };
  if (existing.status !== 404) await checked(existing);

  // OAuth responses describe the granted scopes; fine-grained tokens may omit this header.
  const assertScopes = response => {
    const scopes = response.headers.get('x-oauth-scopes');
    if (scopes !== null && !scopes.split(',').map(scope => scope.trim()).includes('repo')) {
      throw new LibrarySetupError(403, 'GitGallery needs access to private repositories. Sign out, choose Continue with GitHub, and allow repository access.');
    }
  };
  assertScopes(existing);
  const libraries = new Map();
  for (let page = 1; page <= 10; page++) {
    const response = await checked(await request(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`));
    assertScopes(response);
    const repositories = await response.json();
    if (!Array.isArray(repositories)) throw new LibrarySetupError(502, 'GitHub returned an invalid repository list. Please try again.');
    // Keep concurrency modest; do not scan a photo tree or download any media.
    for (let offset = 0; offset < repositories.length; offset += 6) {
      await Promise.all(repositories.slice(offset, offset + 6).map(async info => {
        const repo = selectedRepository(info);
        if (info.description === 'Private repo for GitGallery') { libraries.set(info.full_name, info); return; }
        const directory = await request(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/gitgallery?ref=${encodeURIComponent(repo.branch)}`);
        if (directory.status === 404) return;
        await checked(directory);
        const entries = await directory.json();
        if (Array.isArray(entries) && entries.some(entry => entry.type === 'dir' && ['library', 'images', 'meta'].includes(entry.name))) {
          libraries.set(info.full_name, info);
        } else if (Array.isArray(entries) && entries.length >= 1000) {
          throw new LibrarySetupError(409, 'This repository needs to be opened manually. Choose your existing library below.');
        }
      }));
    }
    if (!(response.headers.get('link') ?? '').includes('rel="next"')) break;
    if (page === 10) throw new LibrarySetupError(409, 'There are too many repositories to check automatically. Choose your existing library below.');
  }
  if (libraries.size === 1) return { repository: libraries.values().next().value, created: false };
  if (libraries.size > 1) return { choices: [...libraries.values()].map(repositorySummary) };

  // Recheck the session immediately before a write; the account may have signed out during discovery.
  await beforeCreate();
  const created = await request('/user/repos', { name: DEFAULT_REPOSITORY, description: 'Private repo for GitGallery', private: true, auto_init: true });
  if (created.status === 422) {
    // Another tab/device may have created the same name. Never make a numbered duplicate.
    const raced = await request(defaultPath);
    if (raced.ok) return { repository: await raced.json(), created: false };
    if (raced.status !== 404) await checked(raced);
    throw new LibrarySetupError(409, 'GitHub could not create or open gitgallery-photos. It may already exist without access. Sign in with GitHub again, or choose an existing library.');
  }
  if (created.status === 403) {
    throw new LibrarySetupError(403, 'GitHub did not allow a private library to be created. Sign out and sign in with GitHub, allowing repository access, or choose an existing library.');
  }
  await checked(created);
  const info = await created.json();
  if (info.private !== true || info.full_name?.toLowerCase() !== `${login}/${DEFAULT_REPOSITORY}`.toLowerCase()) {
    throw new LibrarySetupError(502, 'GitHub returned an unexpected library. Please choose your repository below.');
  }
  return { repository: info, created: true };
}
