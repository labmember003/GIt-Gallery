import React, { useEffect, useMemo, useState } from 'react';
import { buildTimelineSections, formatDayLabel, formatMonthLabel } from '../components/timeline/grouping';
import type { ShareManifest, ShareRef } from '../services/share/format';
import { AssetImage } from './AssetImage';
import { Icon } from './Icon';
import { ShareGoneError, ShareNetworkError, SharedSource, loadSharedManifest, sharedAssets } from './shared';
import type { WebAsset } from './types';
import { Viewer } from './Viewer';
import './styles.css';
import './auth.css';

const isPhone = typeof navigator !== 'undefined' && /iPhone|iPad|Android/i.test(navigator.userAgent);

function theme(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem('gitgallery.web.theme');
    if (saved === 'dark' || saved === 'light') return saved;
  } catch {}
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function SharedAlbum({ shareRef }: { shareRef: ShareRef | null }) {
  const [manifest, setManifest] = useState<ShareManifest | null>(null);
  const [source, setSource] = useState<SharedSource | null>(null);
  const [error, setError] = useState<{ message: string; gone: boolean; retry: boolean } | null>(shareRef ? null : { message: 'This link is incomplete. Ask for the link again and copy all of it.', gone: false, retry: false });
  const [viewer, setViewer] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!shareRef) return;
    let live = true;
    let opened: SharedSource | null = null;
    setError(null);
    loadSharedManifest(shareRef)
      .then(({ manifest: m, commit }) => {
        if (!live) return;
        opened = new SharedSource(shareRef, m, commit);
        setManifest(m);
        setSource(opened);
        document.title = `${m.title} · GitGallery`;
      })
      .catch((e) => live && setError({ message: e instanceof Error ? e.message : 'This link could not be opened.', gone: e instanceof ShareGoneError, retry: e instanceof ShareNetworkError }));
    return () => {
      live = false;
      opened?.dispose();
    };
  }, [shareRef, attempt]);

  const assets = useMemo(() => (manifest ? sharedAssets(manifest) : []), [manifest]);
  const sections = useMemo(() => buildTimelineSections(assets, 4), [assets]);
  const flat = useMemo(() => sections.flatMap((s) => s.data.flat()) as WebAsset[], [sections]);
  const appLink = shareRef ? `gitgallery://share/${shareRef.owner}/${shareRef.id}#${shareRef.key}` : null;

  return <div className="gg-app shared-page" data-theme={theme()}>
    <header className="shared-top">
      <a className="brand shared-brand" href="/"><span className="brand-mark"><Icon name="photos" size={22} /></span>GitGallery</a>
      {isPhone && appLink && <a className="button primary" href={appLink}>Open in the app</a>}
    </header>
    <main className="shared-main">
      {error ? <div className="auth-loading"><Icon name={error.gone ? 'albums' : 'info'} size={35} /><h1>{error.gone ? 'Album not available' : 'Could not open this album'}</h1><p role="alert">{error.message}</p>{error.retry && <button className="button primary" onClick={() => setAttempt(attempt + 1)}>Try again</button>}</div>
        : !manifest || !source ? <div className="auth-loading"><p role="status"><span className="spinner" />Opening shared album…</p></div>
        : <>
          <div className="page-heading"><div><div className="title-line"><h1>{manifest.title}</h1><span className="count-label">{assets.length}</span></div><p>Shared by @{manifest.owner}</p><p className="shared-note"><Icon name="shield" size={14} />View only · end-to-end encrypted</p></div></div>
          {!assets.length && <div className="empty-state"><span className="empty-icon"><Icon name="albums" size={36} /></span><h2>This album is empty</h2><p>Photos the owner adds will show up here.</p></div>}
          <div className="timeline">
            {sections.map((section, index) => {
              const previous = sections[index - 1]?.date;
              const newMonth = section.date && (!previous || previous.getMonth() !== section.date.getMonth() || previous.getFullYear() !== section.date.getFullYear());
              return <section className="day-section" key={section.key} aria-label={section.date ? formatDayLabel(section.date) : 'Unknown date'}>
                {newMonth && <div className="month-heading"><h2>{formatMonthLabel(section.date!)}</h2>{!formatMonthLabel(section.date!).includes(String(section.date!.getFullYear())) && <span>{section.date!.getFullYear()}</span>}<div /></div>}
                <div className="day-heading"><h3>{section.date ? formatDayLabel(section.date) : 'Unknown date'}</h3><span>{section.count} {section.count === 1 ? 'item' : 'items'}</span></div>
                <div className="photo-grid">{section.data.flat().map((asset) => <article key={asset.id} className="photo-card">
                  <button className="photo-open" onClick={() => setViewer(flat.findIndex((a) => a.id === asset.id))} aria-label={`Open ${asset.title}`}>
                    <AssetImage asset={asset} source={source} />
                    {asset.kind === 'video' && <span className="video-badge"><Icon name="play" size={12} filled />Video</span>}
                  </button>
                </article>)}</div>
              </section>;
            })}
          </div>
          <p className="shared-footnote"><Icon name="shield" size={15} />Decrypted in this browser with the key in the link. GitHub only stores encrypted copies.</p>
        </>}
    </main>
    {viewer != null && source && flat[viewer] && <Viewer asset={flat[viewer]} source={source} position={viewer} total={flat.length}
      onPrevious={() => setViewer(Math.max(0, viewer - 1))} onNext={() => setViewer(Math.min(flat.length - 1, viewer + 1))} onClose={() => setViewer(null)} />}
  </div>;
}
