import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { sessionRequest, SessionError, type WebSession, type Repository } from './session';

export function RepositoryPicker({ session, onSession, onSignOut, onCancel, onExpired }: {
  session: WebSession; onSession(value: WebSession): void; onSignOut(): void; onCancel?: () => void; onExpired(): void;
}) {
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState('');
  const [repository, setRepository] = useState('');
  const [branch, setBranch] = useState('');
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [choosing, setChoosing] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setListError('');
    sessionRequest<{ repositories: Repository[]; hasMore: boolean }>(`/repositories?page=${page}`, { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) { setRepositories((previous) => page === 1 ? result.repositories : [...new Map([...previous, ...result.repositories].map((repo) => [repo.id, repo])).values()]); setHasMore(result.hasMore); } })
      .catch((reason) => { if (!controller.signal.aborted) { if (reason instanceof SessionError && reason.status === 401) onExpired(); else setListError(reason instanceof Error ? reason.message : 'Could not load your repositories.'); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [page, session.user?.id, retry]);
  const filtered = useMemo(() => repositories.filter((repo) => `${repo.fullName} ${repo.description ?? ''}`.toLowerCase().includes(query.toLowerCase())), [repositories, query]);
  async function choose(name: string, selectedBranch?: string) {
    if (choosing) return; setChoosing(name); setError('');
    try { onSession(await sessionRequest<WebSession>('/repository', { csrf: session.csrf, body: { repository: name.trim(), branch: selectedBranch?.trim() } })); }
    catch (reason) { if (reason instanceof SessionError && reason.status === 401) onExpired(); else setError(reason instanceof Error ? reason.message : 'Could not open this repository.'); }
    finally { setChoosing(''); }
  }
  return <div className="auth-layout"><header className="auth-header"><span className="auth-brand"><span className="brand-mark"><Icon name="photos" size={25} /></span>GitGallery</span><div className="account-actions"><span className="account-avatar">{session.user!.login.slice(0, 2).toUpperCase()}</span><span>@{session.user!.login}</span><button className="button secondary" onClick={onSignOut}>Sign out</button></div></header>
    <main className="repository-layout"><div className="repository-heading"><span className="eyebrow">YOUR LIBRARY STARTS HERE</span><h1>Choose your photo repository</h1><p>Open the repository you use with GitGallery on your phone. Only its backed-up photos and videos will appear.</p></div>
      {error && <div className="error-box" role="alert">{error}</div>}
      {listError && <div className="error-box" role="alert">{listError}<button className="text-button" onClick={() => setRetry(value => value + 1)}>Retry loading repositories</button></div>}
      <div className="repository-browser"><div className="repository-search search-box"><Icon name="search" size={18} /><input aria-label="Find a repository" placeholder="Find a repository…" value={query} onChange={(event) => setQuery(event.target.value)} /></div><span className="muted small">{repositories.length} repositories loaded</span></div>
      <div className="repository-list">{filtered.map((repo) => <button className="repository-option" key={repo.id} disabled={!!choosing} onClick={() => choose(repo.fullName, repo.branch)}><span className="repository-option-icon"><Icon name="github" size={23} /></span><span className="repository-option-copy"><strong>{repo.fullName}<span className="pill">{repo.private ? 'Private' : 'Public'}</span></strong><small>{repo.description || `Branch: ${repo.branch}`}</small></span>{choosing === repo.fullName ? <span className="spinner" /> : <Icon name="arrow" size={18} />}</button>)}</div>
      {loading && <p className="repository-progress" role="status"><span className="spinner" />Loading your repositories…</p>}
      {!loading && !listError && !filtered.length && <div className="repository-empty"><Icon name="albums" size={30} /><h2>{query ? 'No matching repositories' : 'No repositories available'}</h2><p>{query ? 'Try another name, load more results, or enter the repository below.' : 'No repositories were returned for this GitHub account. Check the account shown above, or open your library by name below.'}</p></div>}
      {hasMore && <button className="button secondary" disabled={loading || !!choosing} onClick={() => setPage(page + 1)}>Load more repositories</button>}
      <details className="manual-repository"><summary>Open a repository or a different branch by name</summary><form className="form-stack" onSubmit={(event) => { event.preventDefault(); void choose(repository, branch); }}><label>Repository<input required placeholder="your-name/memories" value={repository} onChange={(event) => setRepository(event.target.value)} disabled={!!choosing} /></label><label>Branch <span className="optional">optional</span><input placeholder="Default branch" value={branch} onChange={(event) => setBranch(event.target.value)} disabled={!!choosing} /></label><button className="button primary" disabled={!!choosing}>Open library</button></form></details>
      {onCancel && <button className="text-button back-link" onClick={onCancel}>← Back to your library</button>}
      <p className="repository-footnote"><Icon name="shield" size={16} />Opening a repository does not change its files.</p>
    </main></div>;
}
