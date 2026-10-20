import React, { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { sessionRequest, SessionError, type WebSession, type Repository } from './session';

type SetupResult = { status: 'ready'; session: WebSession; created: boolean }
  | { status: 'choose'; repositories: Repository[] }
  | { status: 'pending'; retryAfter: number };

export function LibrarySetup({ session, onSession, onManual, onSignOut, onExpired }: {
  session: WebSession; onSession(value: WebSession): void; onManual(): void; onSignOut(): void; onExpired(): void;
}) {
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState('');
  const [choices, setChoices] = useState<Repository[]>([]);
  const [choosing, setChoosing] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setError(''); setChoices([]);
    async function prepare() {
      try {
        const result = await sessionRequest<SetupResult>('/library/setup', { csrf: session.csrf, body: {}, signal: controller.signal });
        if (controller.signal.aborted) return;
        if (result.status === 'ready') onSession(result.session);
        else if (result.status === 'choose') setChoices(result.repositories);
        else timer = setTimeout(() => { void prepare(); }, Math.max(1, result.retryAfter) * 1000);
      } catch (reason) {
        if (controller.signal.aborted) return;
        if (reason instanceof SessionError && reason.status === 401) onExpired();
        else setError(reason instanceof Error ? reason.message : 'We could not get your library ready. Please try again.');
      }
    }
    void prepare();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [session.user?.id, session.csrf, retry]);

  async function choose(repo: Repository) {
    if (choosing) return;
    setChoosing(repo.fullName); setError('');
    try { onSession(await sessionRequest<WebSession>('/repository', { csrf: session.csrf, body: { repository: repo.fullName, branch: repo.branch } })); }
    catch (reason) { if (reason instanceof SessionError && reason.status === 401) onExpired(); else setError(reason instanceof Error ? reason.message : 'Could not open this library.'); }
    finally { setChoosing(''); }
  }

  return <div className="auth-layout">
    <header className="auth-header"><span className="auth-brand"><span className="brand-mark"><Icon name="photos" size={25} /></span>GitGallery</span><div className="account-actions"><span>@{session.user!.login}</span><button className="button secondary" onClick={onSignOut}>Sign out</button></div></header>
    <main className="repository-layout library-setup">
      <span className="eyebrow">YOUR MEMORIES, TOGETHER</span>
      <h1>{choices.length ? 'Choose your photo repository' : error ? 'Let’s get your library connected' : 'Getting your library ready'}</h1>
      {choices.length ? <p>There’s more than one GitGallery library on your account. Which one would you like to open?</p>
        : !error && <><p>We’ll open your existing GitGallery library, or create a private home for your photos if this is your first time.</p><p className="repository-progress" role="status"><span className="spinner" />Checking your GitHub libraries…</p></>}
      {error && <><div className="error-box" role="alert">{error}</div><button className="button primary" onClick={() => setRetry(value => value + 1)} disabled={!!choosing}>Try again</button></>}
      {!!choices.length && <div className="repository-list">{choices.map(repo => <button className="repository-option" key={repo.fullName} disabled={!!choosing} onClick={() => { void choose(repo); }}><span className="repository-option-icon"><Icon name="photos" size={23} /></span><span className="repository-option-copy"><strong>{repo.fullName}<span className="pill">{repo.private ? 'Private' : 'Public'}</span></strong><small>{repo.description || 'Your GitGallery backup'}</small></span>{choosing === repo.fullName ? <span className="spinner" /> : <Icon name="arrow" size={18} />}</button>)}</div>}
      {(!!error || !!choices.length) && <button className="text-button back-link" onClick={onManual} disabled={!!choosing}>Choose a repository manually</button>}
    </main>
  </div>;
}
