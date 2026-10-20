import React, { useEffect, useRef, useState } from 'react';
import { GitHubSource } from './github';
import { Icon } from './Icon';
import { Modal } from './Modal';
import type { Library } from './types';

export function ConnectDialog({ onClose, onConnected }: {
  onClose(): void; onConnected(library: Library, source: GitHubSource): void;
}) {
  const [repository, setRepository] = useState('');
  const [branch, setBranch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<GitHubSource | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current?.dispose(); }; }, []);
  async function connect(event: React.FormEvent) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      const source = new GitHubSource(repository, '', branch);
      pending.current = source;
      const library = await source.connect();
      if (!mounted.current) { source.dispose(); return; }
      pending.current = null;
      onConnected(library, source);
    } catch (reason) {
      pending.current?.dispose(); pending.current = null;
      if (mounted.current) { setError(reason instanceof Error ? reason.message : 'Connection failed. Try again.'); setBusy(false); }
    }
  }
  return <Modal title="Open a public repository" onClose={onClose}>
    <p className="muted">Enter a public repository containing a GitGallery backup. Private repositories require signing in first.</p>
    <form onSubmit={connect} className="form-stack">
      <label>Repository<input autoFocus required placeholder="your-name/memories" value={repository} onChange={(event) => setRepository(event.target.value)} spellCheck={false} autoCapitalize="none" disabled={busy} /></label>
      <label>Branch <span className="optional">optional</span><input placeholder="Default branch" value={branch} onChange={(event) => setBranch(event.target.value)} spellCheck={false} disabled={busy} /></label>
      <div className="privacy-note"><Icon name="shield" /><span>This connection only reads public files. No credentials are needed.</span></div>
      {error && <p className="error-box" role="alert">{error}</p>}
      <button className="button primary full-width" disabled={busy} type="submit">{busy ? <><span className="spinner" /> Reading repository…</> : <><Icon name="github" /> Open library</>}</button>
    </form>
  </Modal>;
}
