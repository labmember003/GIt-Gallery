import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { formatBytes } from './library';
import { sessionRequest } from './session';
import { ACCEPT_MEDIA, uploadFile, type UploadFile, type UploadOptions } from './uploads';

type Queued = UploadFile & { key: string; status: 'queued' | 'uploading' | 'saved' | 'failed' | 'stopped'; percent: number; label: string };

export function UploadDialog({ csrf, repository, album, initialFiles = [], onSaved, onClose }: {
  csrf: string; repository: string; album?: string; initialFiles?: File[];
  onSaved(ids: string[]): Promise<void>; onClose(): void;
}) {
  const [options, setOptions] = useState<UploadOptions | null>(null);
  const [error, setError] = useState('');
  const [items, setItems] = useState<Queued[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [dragging, setDragging] = useState(false);
  const queue = useRef<Queued[]>([]);
  const running = useRef(false);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const stopping = useRef<Promise<void> | null>(null);
  const active = useRef<Queued | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const initial = useRef(initialFiles);
  const render = () => { if (mounted.current) setItems([...queue.current]); };

  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    void sessionRequest<UploadOptions>('/uploads/options', { signal: abort.signal }).then(setOptions).catch(reason => {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not check upload access.');
    });
    return () => { mounted.current = false; abort.abort(); controller.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!options?.writable || !initial.current.length) return;
    const files = initial.current; initial.current = []; add(files);
  }, [options]);
  useEffect(() => {
    if (!busy) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [busy]);

  async function run() {
    if (running.current || !options?.writable) return;
    running.current = true; setBusy(true); setConfirmStop(false);
    const abort = new AbortController(); controller.current = abort;
    const saved: string[] = [];
    try {
      for (const item of queue.current) {
        if (abort.signal.aborted) break;
        if (item.status !== 'queued') continue;
        active.current = item; item.status = 'uploading'; render();
        try {
          const result = await uploadFile(item, options, csrf, abort.signal, progress => { Object.assign(item, progress); render(); });
          item.status = 'saved'; item.percent = 100; item.label = result.reused ? 'Already in your library' : 'Saved to your library'; saved.push(result.id);
        } catch (reason) {
          item.status = abort.signal.aborted ? 'stopped' : 'failed';
          item.label = abort.signal.aborted ? 'Stopped — retry to continue' : reason instanceof Error ? reason.message : 'Upload interrupted. Retry to continue.';
        }
        render();
      }
    } finally {
      await stopping.current;
      stopping.current = null;
      if (abort.signal.aborted) queue.current.filter(item => item.status === 'queued').forEach(item => { item.status = 'stopped'; item.label = 'Not uploaded'; });
      active.current = null;
      // Also refresh after stopping: a commit already accepted by GitHub can
      // finish even if its browser connection was closed.
      try { if (mounted.current) await onSaved(saved); }
      catch { if (mounted.current) setError('Your files were saved, but the library could not refresh. Close this window and refresh the library.'); }
      running.current = false;
      if (mounted.current) {
        setBusy(false); setConfirmStop(false); render();
        if (queue.current.some(item => item.status === 'queued')) void run();
      }
    }
  }
  function add(files: File[]) {
    if (!options?.writable) return;
    if (queue.current.length + files.length > 200) { setError('Choose up to 200 files at a time. Finish this batch before adding more.'); return; }
    queue.current.push(...files.map(file => ({ file, key: crypto.randomUUID(), status: 'queued' as const, percent: 0, label: 'Waiting to upload' })));
    setError(''); render(); void run();
  }
  function stop() {
    if (stopping.current) return;
    const id = active.current?.uploadId;
    controller.current?.abort();
    stopping.current = (async () => {
      if (id) {
        try { await sessionRequest(`/uploads/${id}/cancel`, { csrf, body: {} }); }
        catch { if (mounted.current) setError('The connection closed. A file already being saved may still finish; refresh your library before retrying.'); }
      }
    })();
  }
  const completed = items.filter(item => item.status === 'saved').length;
  const retryable = items.some(item => item.status === 'failed' || item.status === 'stopped');

  return <Modal title={album ? `Upload to ${album}` : 'Upload photos and videos'} className="modal-upload" onClose={() => busy ? setConfirmStop(true) : onClose()}>
    <p className="muted upload-destination">Originals are saved to <strong>{repository}</strong>.{album && <> They’ll also appear in “{album}” in this browser.</>}</p>
    {error && <p className="error-box" role="alert">{error}{!options && <button className="text-button" onClick={() => { setError(''); void sessionRequest<UploadOptions>('/uploads/options').then(setOptions).catch(reason => setError(reason.message)); }}>Try again</button>}</p>}
    {!options && !error && <p role="status"><span className="spinner" />Checking upload access…</p>}
    {options && !options.writable && <div className="warning-box" role="alert">You have view-only access to this repository. Switch to a library you own, or ask its owner for write access. If your permissions just changed, sign out and sign in again.</div>}
    {options?.writable && <>
      <input ref={input} className="upload-input" type="file" multiple accept={ACCEPT_MEDIA} aria-label="Choose photos and videos" onChange={event => { add(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
      <div className={`upload-dropzone${dragging ? ' dragging' : ''}`} onDragOver={event => { event.preventDefault(); event.stopPropagation(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); event.stopPropagation(); setDragging(false); add(Array.from(event.dataTransfer.files)); }}>
        <span className="upload-symbol"><Icon name="upload" size={28} /></span>
        <strong>Drop your photos and videos here</strong><span className="muted">or choose them from your device</span>
        <button className="button primary" onClick={() => input.current?.click()}><Icon name="plus" size={17} />{items.length ? 'Add more files' : 'Choose files'}</button>
        <small>JPG, PNG, WebP, GIF, HEIC, HEIF, AVIF · MP4, MOV, M4V, WebM<br />Up to {formatBytes(options.maxFileSize)} per file. Keep this tab open while uploading.</small>
      </div>
      {!!items.length && <div className="upload-queue" aria-label="Upload queue"><div className="upload-summary" role="status"><strong>{busy ? 'Uploading your memories' : completed === items.length ? 'Your memories are saved' : 'Some files need attention'}</strong><span>{completed} of {items.length} saved</span></div>
        <ul>{items.map(item => <li key={item.key} className={`upload-item ${item.status}`}><span className="upload-file-icon"><Icon name={item.status === 'saved' ? 'check' : /\.(mp4|mov|m4v|webm)$/i.test(item.file.name) ? 'video' : 'photos'} /></span><div className="upload-file-copy"><strong title={item.file.name}>{item.file.name}</strong><span>{formatBytes(item.file.size)} · {item.label}</span>{item.status === 'uploading' && <progress aria-label={`Upload progress for ${item.file.name}`} value={item.percent} max={100} />}</div></li>)}</ul>
      </div>}
      {confirmStop && <div className="warning-box upload-stop" role="alert"><p>Stop the remaining uploads? Files already saved will stay in your library. A file currently being saved may still finish.</p><button className="button secondary" onClick={() => setConfirmStop(false)}>Keep uploading</button><button className="button danger" onClick={() => void stop()}>Stop uploads</button></div>}
    </>}
    <div className="modal-actions">{busy ? <button className="button secondary" onClick={() => setConfirmStop(true)}>Stop uploads…</button> : <>{retryable && options?.writable && <button className="button secondary" onClick={() => { queue.current.filter(item => item.status === 'failed' || item.status === 'stopped').forEach(item => { item.status = 'queued'; item.label = 'Waiting to retry'; }); render(); void run(); }}><Icon name="refresh" size={16} />Retry remaining</button>}<button className="button primary" onClick={onClose}>{completed ? 'Done' : 'Close'}</button></>}</div>
  </Modal>;
}
