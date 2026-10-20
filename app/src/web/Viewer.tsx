import React, { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { formatBytes } from './library';
import type { MediaSource, WebAsset } from './types';

export function Viewer({ asset, source, favorite, position, total, onPrevious, onNext, onClose, onFavorite, onAlbum }: {
  asset: WebAsset; source: MediaSource; favorite: boolean; position: number; total: number;
  onPrevious(): void; onNext(): void; onClose(): void; onFavorite(): void; onAlbum(): void;
}) {
  const [loaded, setLoaded] = useState<{ id: string; url: string } | null>(null);
  const url = loaded?.id === asset.id ? loaded.url : null;
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(false);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => {
    let active = true; setLoaded(null); setError(''); setZoom(false);
    source.load(asset, false).then((value) => { if (active) setLoaded({ id: asset.id, url: value }); })
      .catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [asset, source]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' && position > 0) { event.preventDefault(); onPrevious(); }
      if (event.key === 'ArrowRight' && position < total - 1) { event.preventDefault(); onNext(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onPrevious, onNext, position, total]);

  async function download() {
    if (!url) return;
    setDownloading(true);
    try {
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = asset.filename;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
    } finally { setDownloading(false); }
  }
  const external = source.originalLink(asset);
  return <Modal title={asset.title} onClose={onClose} wide>
    <div className="viewer-meta"><span>{asset.createdAt ? new Date(asset.createdAt).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' }) : 'Capture date unavailable'}</span><span>{position + 1} / {total}</span></div>
    <div className={`viewer-media${zoom ? ' zoomed' : ''}`}>
      {url && !error ? asset.kind === 'video' ? <video key={asset.id} src={url} controls autoPlay playsInline onError={() => setError('This video format is not supported by your browser. Download it or open it on GitHub.')} />
        : <button className="zoom-image" aria-label={zoom ? 'Zoom out' : 'Zoom in'} onClick={() => setZoom(!zoom)}><img key={asset.id} src={url} alt={asset.title} onError={() => setError('This image format is not supported by your browser. Download the original to view it.')} /></button>
        : <div className="viewer-placeholder">{error ? <><Icon name="info" size={30} /><p role="alert">{error}</p></> : <><span className="spinner" /><p>Opening original…</p></>}</div>}
    </div>
    <div className="viewer-toolbar">
      <div className="viewer-navigation"><button className="icon-button" aria-label="Previous photo" disabled={position === 0} onClick={onPrevious}><span className="rotate"><Icon name="arrow" /></span></button><button className="icon-button" aria-label="Next photo" disabled={position === total - 1} onClick={onNext}><Icon name="arrow" /></button><span className="muted small">{asset.width && asset.height ? `${asset.width} × ${asset.height} · ` : ''}{formatBytes(asset.size)}</span></div>
      <div className="viewer-actions"><button className={`icon-button${favorite ? ' is-favorite' : ''}`} aria-label={favorite ? 'Remove from favourites' : 'Add to favourites'} aria-pressed={favorite} onClick={onFavorite}><Icon name="heart" filled={favorite} /></button><button className="icon-button" aria-label="Add to album" onClick={onAlbum}><Icon name="albums" /></button><button className="icon-button" aria-label="Download original" disabled={!url || downloading} onClick={download}><Icon name="download" /></button>{external && <a className="icon-button" href={external} target="_blank" rel="noreferrer" aria-label="Open on GitHub"><Icon name="external" /></a>}</div>
    </div>
  </Modal>;
}
