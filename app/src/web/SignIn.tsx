import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { DeviceSignIn } from './DeviceSignIn';
import { sessionRequest, type DeviceChallenge, type SignInStart, type WebSession } from './session';

export function SignIn({ session, initialError, onSession, onDemo, onPublic }: {
  session: WebSession; initialError: string; onSession(value: WebSession): void; onDemo(): void; onPublic(): void;
}) {
  const [tokenForm, setTokenForm] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState(initialError);
  const [working, setWorking] = useState<'github' | 'token' | null>(null);
  const [unavailable, setUnavailable] = useState(!session.oauthAvailable);
  const [device, setDevice] = useState<{ challenge: DeviceChallenge; csrf: string } | null>(null);
  const signInButton = useRef<HTMLButtonElement>(null);
  const hadDeviceDialog = useRef(false);
  const busy = working !== null;
  useEffect(() => { setUnavailable(!session.oauthAvailable); }, [session.oauthAvailable]);
  useEffect(() => {
    if (hadDeviceDialog.current && !device) signInButton.current?.focus();
    hadDeviceDialog.current = !!device;
  }, [device]);
  async function oauth() {
    setWorking('github'); setError('');
    try {
      // Refresh both readiness and CSRF so retry works after a server restart.
      const current = await sessionRequest<WebSession>('/session');
      if (current.user) { onSession(current); return; }
      setUnavailable(!current.oauthAvailable);
      if (!current.oauthAvailable) return;
      const started = await sessionRequest<SignInStart>('/auth/start', { csrf: current.csrf, body: {} });
      if (started.method === 'device') { setDevice({ challenge: started, csrf: current.csrf }); return; }
      const { url } = started;
      const target = new URL(url);
      if (target.origin !== 'https://github.com' || target.pathname !== '/login/oauth/authorize') throw new Error('Sign-in returned an invalid address.');
      location.assign(url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Sign-in could not start. Please try again.'); }
    finally { setWorking(null); }
  }
  async function signIn(event: React.FormEvent) {
    event.preventDefault(); setWorking('token'); setError('');
    try {
      const current = await sessionRequest<WebSession>('/session');
      const next = await sessionRequest<WebSession>('/auth/token', { csrf: current.csrf, body: { token } });
      setToken(''); onSession(next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Sign-in could not finish.'); }
    finally { setWorking(null); }
  }
  return <div className="auth-layout">
    <header className="auth-header"><span className="auth-brand"><span className="brand-mark"><Icon name="photos" size={25} /></span>GitGallery</span><span className="muted small">Your memories. Your repository.</span></header>
    <main className="welcome-layout">
      <section className="welcome-story"><span className="eyebrow">A HOME FOR YOUR MEMORIES</span><h1>Your photos.<br /><span>Your space.</span></h1><p>A beautiful place for the moments you keep. Upload, browse, and keep your photos in your own GitHub repository.</p><div className="welcome-art" aria-hidden="true"><div className="memory-frame frame-back"><Icon name="albums" size={58} /></div><div className="memory-frame frame-front"><Icon name="photos" size={88} /><span>Every moment, together.</span></div><span className="memory-badge"><Icon name="github" size={19} />Stored in your repository</span></div><div className="welcome-features"><span><Icon name="shield" size={18} />Your own storage</span><span><Icon name="photos" size={18} />Photos & videos</span><span><Icon name="heart" size={18} />Made for your memories</span></div></section>
      <section className="signin-card" aria-label="Sign in"><span className="signin-symbol"><Icon name="github" size={28} /></span><h2>Welcome to GitGallery</h2><p>Sign in and we’ll get your photo library ready.</p>
        {error && <div className="error-box" role="alert">{error}</div>}
        {unavailable && <div className="signin-unavailable" role="status"><strong>This website needs to connect to GitHub</strong><p>If someone shared this website with you, ask them to enable GitHub sign-in. You can still open a public photo repository below.</p><details className="signin-help"><summary>Setup steps if you run this website</summary><ol><li>Open <a href="https://github.com/settings/developers" target="_blank" rel="noreferrer">GitHub Developer settings</a> and register or select your OAuth App.</li><li>Enable <b>Device Flow</b> and copy its Client ID.</li><li>Set <code>GITHUB_CLIENT_ID</code> in <code>app/.env.web</code> on your server, then restart it.</li></ol><p>Visitors can then sign in using their own GitHub account. Approval-code sign-in needs no client secret.</p></details></div>}
        <button ref={signInButton} className="button primary full-width sign-in-primary" onClick={oauth} disabled={busy}><Icon name="github" size={19} />{working === 'github' ? 'Connecting to GitHub…' : unavailable ? 'Retry GitHub sign-in' : 'Continue with GitHub'}</button>
        {!unavailable && <><p className="signin-permissions">We’ll find your GitGallery library or create a private gitgallery-photos repository for you. GitHub asks for repository access, including write permission. Uploads save photos and videos to the library you choose.</p><details className="signin-help" open={session.signInMethod === 'device'}><summary>How sign-in works</summary><ol>{session.signInMethod === 'device' && <li>Copy the one-time code we show you.</li>}<li>Sign in to your GitHub account{session.signInMethod === 'device' ? ' and enter the code' : ''}.</li><li>Allow GitGallery to access your repositories.</li><li>Return here. We’ll open your library or create a private one automatically.</li></ol><p>New to GitHub? Create an account on GitHub first. We’ll set up your library; upload your first photos here or back them up with GitGallery on your phone.</p></details></>}
        {session.tokenSignInAvailable && <details className="signin-help advanced-signin"><summary>Advanced sign-in</summary><button className="text-button token-toggle" disabled={busy} onClick={() => { setTokenForm(!tokenForm); setError(''); }} aria-expanded={tokenForm}>Use a personal access token <Icon name="arrow" size={14} /></button>
          {tokenForm && <form className="form-stack token-form" onSubmit={signIn}><label>Personal access token<input autoFocus type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" spellCheck={false} placeholder="github_pat_…" required disabled={busy} /></label><p className="field-help">Choose a fine-grained token with <strong>Contents: read and write</strong> for your photo repository. <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Create a token</a></p><button className="button primary full-width" disabled={busy}>{working === 'token' ? 'Signing in…' : 'Sign in with token'}</button></form>}</details>}
        <div className="signin-divider"><span>Take a look around</span></div><button className="button secondary full-width" onClick={onDemo} disabled={busy}><Icon name="photos" size={18} />Try the demo</button><button className="text-button public-link" onClick={onPublic} disabled={busy}>Open a public repository <Icon name="arrow" size={14} /></button><p className="signin-note"><Icon name="shield" size={15} />Sign in securely on GitHub. Your password stays with GitHub.</p>
      </section>
    </main><footer className="auth-footer">Your photos stay in your GitHub repository.</footer>
    {device && <DeviceSignIn challenge={device.challenge} csrf={device.csrf} onSession={onSession} onClose={() => setDevice(null)} onRestart={() => { setDevice(null); void oauth(); }} />}
  </div>;
}
