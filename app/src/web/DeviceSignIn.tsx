import React, { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { sessionRequest, SessionError, type DeviceChallenge, type WebSession } from './session';

export function DeviceSignIn({ challenge, csrf, onSession, onClose, onRestart }: {
  challenge: DeviceChallenge; csrf: string; onSession(value: WebSession): void; onClose(): void; onRestart(): void;
}) {
  const [clock, setClock] = useState(Date.now);
  const [error, setError] = useState('');
  const [terminal, setTerminal] = useState(false);
  const [retry, setRetry] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyHint, setCopyHint] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const code = useRef<HTMLInputElement>(null);
  const callbacks = useRef({ onSession, onClose, onRestart });
  callbacks.current = { onSession, onClose, onRestart };
  const remaining = Math.max(0, Math.ceil((challenge.expiresAt - clock) / 1000));

  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (cancelling) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    setError(''); setTerminal(false);
    const schedule = (seconds: number) => {
      timer = setTimeout(poll, Math.min(Math.max(1, seconds) * 1000, Math.max(0, challenge.expiresAt - Date.now())));
    };
    async function poll() {
      if (!active) return;
      if (Date.now() >= challenge.expiresAt) { setTerminal(true); setError('Your code has expired. Get a new code to continue.'); return; }
      try {
        const result = await sessionRequest<{ status: 'pending'; retryAfter: number } | { status: 'authenticated'; session: WebSession }>('/auth/device/poll', {
          csrf, body: { attemptId: challenge.attemptId }, signal: controller.signal,
        });
        if (!active) return;
        if (result.status === 'authenticated') callbacks.current.onSession(result.session);
        else schedule(result.retryAfter);
      } catch (reason) {
        if (!active) return;
        setTerminal(reason instanceof SessionError && [400, 401, 403, 409, 410].includes(reason.status));
        setError(reason instanceof Error ? reason.message : 'Could not check your approval. Please try again.');
      }
    }
    schedule(challenge.interval);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [challenge.attemptId, challenge.expiresAt, challenge.interval, csrf, retry, cancelling]);

  async function copyCode() {
    try { await navigator.clipboard.writeText(challenge.userCode); setCopied(true); setCopyHint(''); }
    catch { code.current?.select(); setCopyHint('The code is selected. Copy it, then paste it on GitHub.'); }
  }
  async function cancel(restart = false) {
    if (cancelling) return;
    setCancelling(true);
    try {
      await sessionRequest('/auth/device/cancel', { csrf, body: { attemptId: challenge.attemptId } });
    } catch (reason) {
      // A session can end or complete in another tab while the dialog is open.
      if (reason instanceof SessionError && [401, 403, 409].includes(reason.status)) {
        try {
          const current = await sessionRequest<WebSession>('/session');
          if (current.user) { callbacks.current.onSession(current); return; }
        } catch { setError('Could not stop sign-in. Check your connection and try again.'); setCancelling(false); return; }
      } else { setError('Could not stop sign-in. Check your connection and try again.'); setCancelling(false); return; }
    }
    if (restart) callbacks.current.onRestart(); else callbacks.current.onClose();
  }
  return <Modal title="Connect your GitHub account" onClose={() => { void cancel(); }}>
    <div className="device-signin">
      <p className="device-intro">Approve GitGallery on GitHub using this one-time code. Your password stays on GitHub.</p>
      <ol className="device-steps">
        <li><strong>Copy your sign-in code</strong><div className="device-code-row"><input ref={code} aria-label="GitHub sign-in code" readOnly value={challenge.userCode} onFocus={event => event.target.select()} /><button className="button secondary" onClick={copyCode} disabled={remaining === 0}>{copied ? 'Copied' : 'Copy code'}</button></div>{copyHint && <p role="status">{copyHint}</p>}<small>Only enter this code for the sign-in you started here.</small></li>
        <li><strong>Enter it on GitHub and approve access</strong><p>Sign in to your GitHub account, paste the code, then choose <b>Authorize</b>. If you need an account, create one on GitHub first.</p><a className="button primary" href="https://github.com/login/device" target="_blank" rel="noopener noreferrer"><Icon name="github" size={18} />Open GitHub to approve <Icon name="external" size={15} /></a><small>Opens github.com in a new tab.</small></li>
        <li><strong>Return here to open your photo library</strong><p>This page continues automatically after approval. We’ll find your existing library or create a private one for you.</p></li>
      </ol>
      {error ? <div className="error-box" role="alert">{error}</div> : remaining === 0 ? <div className="error-box" role="alert">Your code has expired. Get a new code to continue.</div> : <p className="device-waiting" role="status"><span className="spinner" />Waiting for your approval… <span>Code expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</span></p>}
      <div className="device-actions">{(terminal || remaining === 0) ? <button className="button primary" disabled={cancelling} onClick={() => { void cancel(true); }}>Get a new code</button> : error && <button className="button primary" disabled={cancelling} onClick={() => setRetry(retry + 1)}>Check again</button>}<button className="button secondary" disabled={cancelling} onClick={() => { void cancel(); }}>{cancelling ? 'Cancelling…' : 'Cancel sign-in'}</button></div>
    </div>
  </Modal>;
}
