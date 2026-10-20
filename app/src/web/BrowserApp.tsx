import React, { useCallback, useEffect, useRef, useState } from 'react';
import Gallery from './WebApp';
import { GitHubSource } from './github';
import { Icon } from './Icon';
import { ConnectDialog } from './ConnectDialog';
import { RepositoryPicker } from './RepositoryPicker';
import { LibrarySetup } from './LibrarySetup';
import { SignIn } from './SignIn';
import { sessionFetch, sessionRequest, type WebSession } from './session';
import type { Library, MediaSource } from './types';
import './styles.css';
import './auth.css';

type OpenLibrary = { library: Library; source: MediaSource; key: string };
const currentDemo = () => new URLSearchParams(location.search).get('demo') === '1';
function setDemoUrl(value: boolean) {
  const url = new URL(location.href); if (value) url.searchParams.set('demo', '1'); else url.searchParams.delete('demo');
  url.searchParams.delete('auth_error'); url.hash = '/photos'; history.replaceState(null, '', url);
}
function savedTheme() { try { return localStorage.getItem('gitgallery.web.theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; } }
function Loading({ label }: { label: string }) { return <div className="auth-loading"><span className="brand-mark"><Icon name="photos" size={28} /></span><h1>GitGallery</h1><p role="status"><span className="spinner" />{label}</p></div>; }

export default function BrowserApp() {
  const [session, setSession] = useState<WebSession | null>(null);
  const [demo, setDemo] = useState(currentDemo);
  const [opened, setOpened] = useState<OpenLibrary | null>(null);
  const [guest, setGuest] = useState<OpenLibrary | null>(null);
  const [picker, setPicker] = useState(false);
  const [publicDialog, setPublicDialog] = useState(false);
  const [error, setError] = useState(() => new URLSearchParams(location.search).get('auth_error') ?? '');
  const [loadError, setLoadError] = useState('');
  const [retry, setRetry] = useState(0);
  const [bootError, setBootError] = useState('');
  const generation = useRef(0);
  const guestRef = useRef<OpenLibrary | null>(null);
  const mounted = useRef(true);
  const sessionRevision = useRef(0);
  const reloadSession = useCallback(async () => {
    const version = ++sessionRevision.current;
    try {
      const next = await sessionRequest<WebSession>('/session');
      if (mounted.current && version === sessionRevision.current) { setSession(next); setBootError(''); }
    } catch (reason) { if (mounted.current && version === sessionRevision.current) setBootError(reason instanceof Error ? reason.message : 'Could not reach the sign-in service.'); }
  }, []);
  useEffect(() => { mounted.current = true; void reloadSession(); return () => { mounted.current = false; guestRef.current?.source.dispose(); }; }, [reloadSession]);
  useEffect(() => {
    const url = new URL(location.href); if (url.searchParams.has('auth_error')) { url.searchParams.delete('auth_error'); history.replaceState(null, '', url); }
  }, []);
  const expired = useCallback(() => { setSession(null); setOpened(null); setGuest(null); setError('Your session ended. Sign in again to reopen your library.'); void reloadSession(); }, [reloadSession]);
  useEffect(() => {
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('gitgallery-session');
    const changed = () => { void reloadSession(); };
    if (channel) channel.onmessage = changed;
    window.addEventListener('gitgallery:session-expired', expired);
    window.addEventListener('focus', changed);
    const timer = setInterval(changed, 60_000);
    return () => { channel?.close(); window.removeEventListener('gitgallery:session-expired', expired); window.removeEventListener('focus', changed); clearInterval(timer); };
  }, [expired, reloadSession]);
  const repo = session?.selectedRepo;
  const key = demo ? 'demo' : session?.user && repo ? `${session.user.id}:${repo.owner}/${repo.name}@${repo.branch}` : '';
  useEffect(() => {
    const version = ++generation.current;
    setOpened(null); setLoadError('');
    let source: MediaSource | null = null;
    if (!key) return;
    (async () => {
      try {
        let library: Library;
        if (demo) {
          const { demoLibrary, demoSource } = await import('./demo'); source = demoSource; library = demoLibrary;
        } else {
          const connected = new GitHubSource(`${repo!.owner}/${repo!.name}`, '', repo!.branch, sessionFetch, session!.user!.login);
          source = connected; library = await connected.connect();
        }
        if (generation.current === version) setOpened({ library, source, key }); else source?.dispose();
      } catch (reason) { if (generation.current === version) setLoadError(reason instanceof Error ? reason.message : 'Could not load your library.'); }
    })();
    return () => { generation.current++; source?.dispose(); };
  }, [key, retry]);
  function accept(next: WebSession) {
    sessionRevision.current++;
    setSession(next); setPicker(false); setDemo(false); setDemoUrl(false); setGuest(null); guestRef.current?.source.dispose(); guestRef.current = null; setError('');
    if (typeof BroadcastChannel !== 'undefined') { const channel = new BroadcastChannel('gitgallery-session'); channel.postMessage('changed'); channel.close(); }
  }
  async function signOut() {
    if (demo || guest) { setDemo(false); setDemoUrl(false); setGuest(null); guestRef.current?.source.dispose(); guestRef.current = null; return; }
    if (!session) return;
    try { accept(await sessionRequest<WebSession>('/auth/logout', { csrf: session.csrf, body: {} })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not sign out. Please try again.'); }
  }
  function chooseRepository() {
    if (demo) { setDemo(false); setDemoUrl(false); if (session?.user) setPicker(true); }
    else if (guest) setPublicDialog(true);
    else setPicker(true);
  }
  const active = guest ?? (opened?.key === key ? opened : null);
  if (active && !picker) return <Gallery key={active.key} initialLibrary={active.library} initialSource={active.source} account={guest || demo ? undefined : session?.user?.login} onChooseRepository={chooseRepository} onSignOut={signOut} overlay={<>{error && <div className="global-session-error" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}{publicDialog && <ConnectDialog onClose={() => setPublicDialog(false)} onConnected={(library, source) => { guestRef.current?.source.dispose(); const next = { library, source, key: library.id }; guestRef.current = next; setGuest(next); setPublicDialog(false); }} />}</>} />;
  return <div className="gg-app" data-theme={savedTheme()}>
    {demo ? loadError ? <div className="auth-loading"><p role="alert">{loadError}</p><button className="button secondary" onClick={() => setRetry(retry + 1)}>Try again</button></div> : <Loading label="Opening the demo…" />
      : !session ? bootError ? <div className="auth-loading"><Icon name="cloud" size={35} /><h1>Unable to connect</h1><p role="alert">{bootError}</p><button className="button primary" onClick={reloadSession}>Try again</button><button className="text-button" onClick={() => { setDemo(true); setDemoUrl(true); }}>Try the demo</button></div> : <Loading label="Checking your session…" />
      : !session.user ? <SignIn session={session} initialError={error} onSession={accept} onDemo={() => { setDemo(true); setDemoUrl(true); setError(''); }} onPublic={() => setPublicDialog(true)} />
      : picker ? <RepositoryPicker session={session} onSession={accept} onSignOut={signOut} onExpired={expired} onCancel={() => setPicker(false)} />
      : !repo ? <LibrarySetup session={session} onSession={accept} onManual={() => setPicker(true)} onSignOut={signOut} onExpired={expired} />
      : loadError ? <div className="auth-loading"><Icon name="cloud" size={35} /><h1>Could not open your library</h1><p role="alert">{loadError}</p><button className="button primary" onClick={() => setRetry(retry + 1)}>Try again</button><button className="button secondary" onClick={() => setPicker(true)}>Choose another repository</button><button className="text-button" onClick={signOut}>Sign out</button></div>
      : <Loading label="Opening your photo library…" />}
    {publicDialog && <ConnectDialog onClose={() => setPublicDialog(false)} onConnected={(library, source) => { guestRef.current?.source.dispose(); const next = { library, source, key: library.id }; guestRef.current = next; setGuest(next); setPublicDialog(false); }} />}
  </div>;
}
