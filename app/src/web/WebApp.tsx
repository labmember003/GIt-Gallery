import React, { useEffect, useMemo, useRef, useState } from 'react';
import { buildTimelineSections, formatDayLabel, formatDuration, formatMonthLabel } from '../components/timeline/grouping';
import { AssetImage } from './AssetImage';
import { GitHubSource } from './github';
import { Icon, type IconName } from './Icon';
import { assetMatches, formatBytes } from './library';
import { Modal } from './Modal';
import { loadCollection, persistCollection } from './storage';
import type { Collection, Library, MediaSource, WebAsset } from './types';
import { Viewer } from './Viewer';
import './styles.css';

type Page = 'photos' | 'favorites' | 'albums' | 'settings';
type Theme = 'light' | 'dark';
const pages: Array<{ id: Page; label: string; icon: IconName }> = [
  { id: 'photos', label: 'Photos', icon: 'photos' },
  { id: 'favorites', label: 'Favourites', icon: 'heart' },
  { id: 'albums', label: 'Albums', icon: 'albums' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

function readRoute(): { page: Page; album: string | null } {
  if (typeof location === 'undefined') return { page: 'photos', album: null };
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  try {
    return { page: pages.some((page) => page.id === parts[0]) ? parts[0] as Page : 'photos',
      album: parts[0] === 'albums' && parts[1] ? decodeURIComponent(parts[1]) : null };
  } catch { return { page: 'photos', album: null }; }
}

function initialTheme(): Theme {
  try { return localStorage.getItem('gitgallery.web.theme') === 'dark' ? 'dark' : 'light'; }
  catch { return 'light'; }
}

function PhotoCard({ asset, source, favorite, selected, selecting, onOpen, onSelect, onFavorite }: {
  asset: WebAsset; source: MediaSource; favorite: boolean; selected: boolean; selecting: boolean;
  onOpen(): void; onSelect(): void; onFavorite(): void;
}) {
  return <article className={`photo-card${selected ? ' selected' : ''}${selecting ? ' selecting' : ''}`}>
    <button className="photo-open" onClick={selecting ? onSelect : onOpen} aria-label={`${selecting ? 'Select' : 'Open'} ${asset.title}`}>
      <AssetImage asset={asset} source={source} />
      <span className="photo-caption">{asset.title}</span>
      {asset.kind === 'video' && <span className="video-badge"><Icon name="play" size={12} filled />{asset.duration ? formatDuration(asset.duration) : 'Video'}</span>}
    </button>
    <label className="photo-select" title={`Select ${asset.title}`}><input type="checkbox" checked={selected} onChange={onSelect} aria-label={`Select ${asset.title}`} /><span><Icon name="check" size={14} /></span></label>
    <button className={`photo-favorite${favorite ? ' active' : ''}`} aria-label={`${favorite ? 'Unfavourite' : 'Favourite'} ${asset.title}`} aria-pressed={favorite} onClick={onFavorite}><Icon name="heart" size={17} filled={favorite} /></button>
  </article>;
}

export default function WebApp({ initialLibrary, initialSource, account, onChooseRepository, onSignOut, overlay }: {
  initialLibrary: Library; initialSource: MediaSource; account?: string;
  onChooseRepository(): void; onSignOut(): void; overlay?: React.ReactNode;
}) {
  const initial = readRoute();
  const [page, setPage] = useState<Page>(initial.page);
  const [activeAlbum, setActiveAlbum] = useState<string | null>(initial.album);
  const [library, setLibrary] = useState<Library>(initialLibrary);
  const [source] = useState<MediaSource>(initialSource);
  const sourceRef = useRef(source);
  const [collection, setCollection] = useState<Collection>(() => loadCollection(initialLibrary.id, initialLibrary.initialCollection));
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | 'photo' | 'video'>('all');
  const [order, setOrder] = useState<'newest' | 'oldest'>('newest');
  const [compact, setCompact] = useState(false);
  const [limit, setLimit] = useState(120);
  const [selected, setSelected] = useState(new Set<string>());
  const [selecting, setSelecting] = useState(false);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [albumTargets, setAlbumTargets] = useState<string[] | null>(null);
  const [albumName, setAlbumName] = useState('');
  const [albumError, setAlbumError] = useState('');
  const [deleteAlbum, setDeleteAlbum] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [storageWarning, setStorageWarning] = useState(false);
  const [demoNotice, setDemoNotice] = useState(true);
  const search = useRef<HTMLInputElement>(null);

  const assetIds = useMemo(() => new Set(library.assets.map((asset) => asset.id)), [library]);
  const favorites = useMemo(() => new Set(collection.favorites.filter((id) => assetIds.has(id))), [collection.favorites, assetIds]);
  const album = collection.albums.find((item) => item.id === activeAlbum);
  const albumIds = useMemo(() => new Set(album?.assetIds ?? []), [album]);
  const currentTitle = activeAlbum ? album?.name ?? 'Album not found' : pages.find((item) => item.id === page)!.label;
  const isTimeline = page === 'photos' || page === 'favorites' || !!activeAlbum;
  const filtered = useMemo(() => library.assets.filter((asset) => (page !== 'favorites' || favorites.has(asset.id))
    && (!activeAlbum || albumIds.has(asset.id)) && (kind === 'all' || asset.kind === kind) && assetMatches(asset, query))
    .sort((a, b) => {
      if (!a.createdAt) return b.createdAt ? 1 : 0;
      if (!b.createdAt) return -1;
      return order === 'newest' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt;
    }), [library, page, favorites, activeAlbum, albumIds, kind, query, order]);
  const sections = useMemo(() => {
    const groups = buildTimelineSections(filtered.slice(0, limit), 1);
    if (order === 'oldest') {
      const dated = groups.filter((group) => group.date).reverse().map((group) => ({ ...group, data: [...group.data].reverse() }));
      return [...dated, ...groups.filter((group) => !group.date)];
    }
    return groups;
  }, [filtered, limit, order]);
  const viewerIndex = filtered.findIndex((asset) => asset.id === viewerId);
  const viewerAsset = filtered[viewerIndex];
  const photoCount = library.assets.filter((asset) => asset.kind === 'photo').length;
  const totalBytes = library.assets.reduce((sum, asset) => sum + asset.size, 0);

  useEffect(() => {
    const change = () => { const route = readRoute(); setPage(route.page); setActiveAlbum(route.album); setSidebarOpen(false); };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => {
    document.title = `${currentTitle} · GitGallery`;
    document.documentElement.style.colorScheme = theme;
    try { localStorage.setItem('gitgallery.web.theme', theme); } catch { /* Theme still works for the session. */ }
  }, [currentTitle, theme]);
  useEffect(() => { setLimit(120); setSelected(new Set()); setSelecting(false); setViewerId(null); }, [page, activeAlbum, query, kind, order, library.id]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 4000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSidebarOpen(false);
      if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName) && !document.querySelector('dialog[open]')) {
        event.preventDefault(); search.current?.focus();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  function navigate(next: Page, id?: string) {
    location.hash = `/${next}${id ? `/${encodeURIComponent(id)}` : ''}`;
    setPage(next); setActiveAlbum(id ?? null); setSidebarOpen(false); setQuery(''); setKind('all');
  }
  function updateCollection(value: Collection) {
    setCollection(value);
    setStorageWarning(!persistCollection(library.id, value));
  }
  function favorite(id: string) {
    const next = new Set(collection.favorites);
    if (next.has(id)) next.delete(id); else next.add(id);
    updateCollection({ ...collection, favorites: [...next] });
  }
  function select(id: string) {
    setSelecting(true);
    setSelected((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  function clearSelection() { setSelected(new Set()); setSelecting(false); }
  async function refresh() {
    const current = sourceRef.current;
    if (!(current instanceof GitHubSource)) return;
    setRefreshing(true); setError('');
    try {
      const next = await current.connect();
      if (sourceRef.current === current) { setLibrary(next); setNotice('Library refreshed'); }
    } catch (reason) { if (sourceRef.current === current) setError(reason instanceof Error ? reason.message : 'Could not refresh the library.'); }
    finally { if (sourceRef.current === current) setRefreshing(false); }
  }
  function openAlbumDialog(ids: string[]) { setAlbumTargets(ids); setAlbumName(''); setAlbumError(''); setViewerId(null); }
  function createAlbum(event: React.FormEvent) {
    event.preventDefault();
    const name = albumName.trim();
    if (!name) { setAlbumError('Give your album a name.'); return; }
    if (collection.albums.some((item) => item.name.toLowerCase() === name.toLowerCase())) { setAlbumError('An album with that name already exists.'); return; }
    const next = { id: crypto.randomUUID(), name, assetIds: albumTargets ?? [] };
    updateCollection({ ...collection, albums: [...collection.albums, next] });
    setAlbumTargets(null); clearSelection(); setNotice(`Created “${name}”`);
    if (!albumTargets?.length) navigate('albums');
  }
  function addToAlbum(id: string) {
    updateCollection({ ...collection, albums: collection.albums.map((item) => item.id === id ? { ...item, assetIds: [...new Set([...item.assetIds, ...(albumTargets ?? [])])] } : item) });
    setNotice(`Added to “${collection.albums.find((item) => item.id === id)?.name}”`); setAlbumTargets(null); clearSelection();
  }

  return <div className={`gg-app${sidebarOpen ? ' sidebar-open' : ''}`} data-theme={theme}>
    <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to gallery</a>
    {sidebarOpen && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
    <aside className="sidebar" aria-label="Main navigation">
      <button className="brand" onClick={() => navigate('photos')} aria-label="GitGallery home"><span className="brand-mark"><Icon name="photos" size={25} /></span><span>GitGallery<span className="brand-caption">YOUR MEMORIES. YOUR REPO.</span></span></button>
      <div className="sidebar-section-label">LIBRARY</div>
      <nav className="navigation">{pages.map((item) => <button key={item.id} onClick={() => navigate(item.id)} className={`nav-item${page === item.id && !activeAlbum ? ' current' : ''}`} aria-current={page === item.id && !activeAlbum ? 'page' : undefined}><Icon name={item.icon} /><span>{item.label}</span>{item.id !== 'settings' && <span className="nav-count">{item.id === 'photos' ? library.assets.length : item.id === 'favorites' ? favorites.size : collection.albums.length}</span>}</button>)}</nav>
      <div className="sidebar-section-label album-label"><span>YOUR ALBUMS</span><button className="icon-button" aria-label="Create an album" onClick={() => openAlbumDialog([])}><Icon name="plus" size={17} /></button></div>
      <div className="sidebar-albums">{collection.albums.slice(0, 7).map((item, index) => <button key={item.id} onClick={() => navigate('albums', item.id)} className={`album-nav${activeAlbum === item.id ? ' current' : ''}`}><span className={`album-dot dot-${index % 4}`} /><span>{item.name}</span></button>)}{!collection.albums.length && <p className="muted small">A place for your favourite stories.</p>}</div>
      <div className="sidebar-bottom"><div className="repository-card"><div className="repository-card-top"><span className="repo-symbol"><Icon name={library.source === 'demo' ? 'photos' : 'github'} /></span><span><strong>{library.source === 'demo' ? 'Demo library' : account ? `Signed in as ${account}` : 'Public repository'}</strong><small>{library.source === 'demo' ? 'You’re in the demo library' : library.name}</small></span></div><p>{library.source === 'demo' ? 'Your own photos are one connection away.' : `${library.assets.length} items · ${formatBytes(totalBytes)}`}</p><button className="button secondary full-width" onClick={onChooseRepository}>{library.source === 'demo' ? 'Sign in to GitHub' : 'Switch repository'}<Icon name="arrow" size={15} /></button></div><span className="sidebar-version"><span className="status-dot" /> GitGallery for web <span>Library</span></span></div>
    </aside>

    <div className="workspace">
      <header className="topbar"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button><div className="breadcrumb"><span>Library</span><Icon name="arrow" size={13} /><strong>{activeAlbum ? 'Albums' : currentTitle}</strong></div><div className="topbar-actions"><span className="private-label"><Icon name="shield" size={15} /> {library.source === 'demo' ? 'Demo library' : account ? `@${account}` : 'Public library'}</span><button className="icon-button" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}><Icon name={theme === 'light' ? 'moon' : 'sun'} /></button><button className="button primary connect-top" onClick={onChooseRepository}><Icon name="github" size={17} />{library.source === 'demo' ? 'Sign in to GitHub' : 'Switch repository'}</button></div></header>
      <main id="main-content" tabIndex={-1}>
        <div className="page-heading"><div>{activeAlbum && <button className="text-button back-link" onClick={() => navigate('albums')}>← All albums</button>}<div className="title-line"><h1>{currentTitle}</h1><span className="count-label">{isTimeline ? filtered.length : page === 'albums' ? collection.albums.length : ''}</span></div><p>{page === 'settings' ? 'A gallery that feels like yours.' : activeAlbum ? 'A collection of moments worth keeping together.' : page === 'albums' ? 'Every collection tells a story.' : page === 'favorites' ? 'The moments you keep coming back to.' : 'Little moments. Big adventures. All together.'}</p></div><div className="heading-actions">{page === 'albums' && !activeAlbum ? <button className="button primary" onClick={() => openAlbumDialog([])}><Icon name="plus" size={18} />New album</button> : isTimeline ? <><button className={`button secondary${selecting ? ' selected-button' : ''}`} onClick={() => selecting ? clearSelection() : setSelecting(true)}><Icon name="check" size={16} />{selecting ? 'Cancel selection' : 'Select'}</button>{library.source === 'github' && <button className="icon-button" aria-label="Refresh library" onClick={refresh} disabled={refreshing}><Icon name="refresh" /></button>}</> : null}</div></div>

        {library.source === 'demo' && demoNotice && page === 'photos' && !activeAlbum && <div className="demo-banner"><span className="demo-banner-icon"><Icon name="photos" size={21} /></span><p><strong>A little inspiration for your library.</strong> These are sample photos. Connect your repository whenever you’re ready.</p><button className="text-button" onClick={onChooseRepository}>Make it yours <Icon name="arrow" size={14} /></button><button className="icon-button" aria-label="Hide demo notice" onClick={() => setDemoNotice(false)}><Icon name="close" size={16} /></button></div>}
        {storageWarning && <div className="warning-box" role="alert">Browser storage is unavailable. Your favourites and albums will last until this tab closes.</div>}
        {error && <div className="error-box" role="alert">{error}<button className="text-button" onClick={() => setError('')}>Dismiss</button></div>}
        {library.warnings.map((warning) => <div key={warning} className="warning-box" role="status">{warning}</div>)}

        {isTimeline && <>
          <div className="gallery-toolbar"><div className="search-box"><Icon name="search" size={18} /><input ref={search} value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search photos" placeholder="Search names or dates…" /><kbd>/</kbd></div><div className="filter-group" aria-label="Media type">{(['all', 'photo', 'video'] as const).map((value) => <button key={value} className={kind === value ? 'active' : ''} onClick={() => setKind(value)} aria-pressed={kind === value}>{value === 'all' ? 'All media' : value === 'photo' ? 'Photos' : 'Videos'}</button>)}</div><div className="display-options"><select aria-label="Sort photos" value={order} onChange={(event) => setOrder(event.target.value as 'newest' | 'oldest')}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select><button className={`icon-button${compact ? ' selected-button' : ''}`} aria-label="Compact grid" aria-pressed={compact} onClick={() => setCompact(!compact)}><Icon name="grid" size={18} /></button></div></div>
          {refreshing && <div className="refresh-status" role="status"><span className="spinner" />Refreshing your library…</div>}
          <div className={`timeline${compact ? ' compact' : ''}`}>
            {sections.map((section, index) => {
              const previous = sections[index - 1]?.date;
              const newMonth = section.date && (!previous || previous.getMonth() !== section.date.getMonth() || previous.getFullYear() !== section.date.getFullYear());
              return <section className="day-section" key={section.key} aria-label={section.date ? formatDayLabel(section.date) : 'Unknown date'}>{newMonth && <div className="month-heading"><h2>{formatMonthLabel(section.date!)}</h2><span>{section.date!.getFullYear()}</span><div /></div>}<div className="day-heading"><h3>{section.date ? formatDayLabel(section.date) : 'Unknown date'}</h3><span>{section.count} {section.count === 1 ? 'item' : 'items'}</span></div><div className="photo-grid">{section.data.flat().map((asset) => <PhotoCard key={asset.id} asset={asset} source={source} favorite={favorites.has(asset.id)} selected={selected.has(asset.id)} selecting={selecting} onOpen={() => setViewerId(asset.id)} onSelect={() => select(asset.id)} onFavorite={() => favorite(asset.id)} />)}</div></section>;
            })}
          </div>
          {!filtered.length && <div className="empty-state"><span className="empty-icon"><Icon name={page === 'favorites' ? 'heart' : 'photos'} size={36} /></span><h2>{query || kind !== 'all' ? 'No matching moments' : activeAlbum ? 'A new story starts here' : page === 'favorites' ? 'Keep your favourites close' : 'Your library is ready for photos'}</h2><p>{query || kind !== 'all' ? 'Try a different name or date, or clear your filters.' : activeAlbum ? 'Select photos in your library and add them to this album.' : page === 'favorites' ? 'Tap the heart on a photo to find it here.' : 'Back up photos with the GitGallery mobile app, then refresh this repository.'}</p><button className="button secondary" onClick={() => { if (query || kind !== 'all') { setQuery(''); setKind('all'); } else if (library.source === 'github' && !library.assets.length) void refresh(); else navigate('photos'); }}>{query || kind !== 'all' ? 'Clear filters' : library.source === 'github' && !library.assets.length ? 'Refresh library' : 'Browse photos'}</button></div>}
          {filtered.length > limit && <div className="load-more"><button className="button secondary" onClick={() => setLimit(limit + 120)}>Load more photos</button><span>Showing {Math.min(limit, filtered.length)} of {filtered.length}</span></div>}
          {!!filtered.length && <div className="gallery-footer"><span className="status-dot" />{library.source === 'demo' ? 'A world of memories, waiting for yours.' : `${library.name} · ${library.repo?.branch}`}</div>}
        </>}

        {page === 'albums' && !activeAlbum && <><p className="collection-note"><Icon name="info" size={15} />Albums are saved in this browser for this library.</p><div className="album-grid">{collection.albums.map((item) => {
          const members = library.assets.filter((asset) => item.assetIds.includes(asset.id));
          return <article key={item.id} className="album-card"><button className="album-open" onClick={() => navigate('albums', item.id)} aria-label={`Open album ${item.name}`}><div className={`album-collage${members.length ? '' : ' blank'}`}>{members.slice(0, 4).map((asset) => <AssetImage key={asset.id} asset={asset} source={source} />)}{!members.length && <Icon name="albums" size={38} />}</div><h2>{item.name}</h2><p>{members.length} {members.length === 1 ? 'item' : 'items'}</p></button><button className="icon-button album-delete" aria-label={`Delete album ${item.name}`} onClick={() => setDeleteAlbum(item.id)}><Icon name="trash" size={17} /></button></article>;
        })}<button className="new-album-card" onClick={() => openAlbumDialog([])}><span><Icon name="plus" size={28} /></span><strong>Create an album</strong><small>Give your next story a home</small></button></div></>}

        {page === 'settings' && !activeAlbum && <div className="settings-grid"><section className="settings-card"><div className="settings-title"><span className="setting-symbol"><Icon name="github" /></span><div><h2>Your repository</h2><p>Photo storage, on your terms.</p></div></div><dl><div><dt>Library</dt><dd>{library.name}</dd></div>{library.repo && <div><dt>Branch</dt><dd>{library.repo.branch}</dd></div>}<div><dt>Media</dt><dd>{photoCount} photos · {library.assets.length - photoCount} videos</dd></div><div><dt>Library size</dt><dd>{formatBytes(totalBytes)}</dd></div><div><dt>Connection</dt><dd><span className="pill">{library.source === 'demo' ? 'Demo' : 'Read only'}</span></dd></div></dl><div className="settings-buttons"><button className="button primary" onClick={onChooseRepository}>{library.source === 'demo' ? 'Sign in to GitHub' : 'Switch repository'}</button><button className="button secondary" onClick={onSignOut}><Icon name="logout" size={16} />{account ? 'Sign out' : library.source === 'demo' ? 'Exit demo' : 'Disconnect'}</button></div></section><section className="settings-card"><div className="settings-title"><span className="setting-symbol"><Icon name="sun" /></span><div><h2>Make it feel like you</h2><p>Choose a little light, or a little dark.</p></div></div><div className="theme-choices">{(['light', 'dark'] as const).map((value) => <button key={value} className={`theme-choice ${value}${theme === value ? ' chosen' : ''}`} onClick={() => setTheme(value)} aria-pressed={theme === value}><span className="theme-miniature"><span /><span /><span /></span><span><Icon name={value === 'light' ? 'sun' : 'moon'} size={17} />{value === 'light' ? 'Light' : 'Dark'}{theme === value && <Icon name="check" size={16} />}</span></button>)}</div></section><section className="settings-card"><div className="settings-title"><span className="setting-symbol"><Icon name="shield" /></span><div><h2>Private by design</h2><p>You stay in control.</p></div></div><p className="settings-copy">Your GitHub credentials stay on the server. Your session lasts up to eight hours and survives page reloads. Sign out to end it on this browser. Favourites and albums are saved locally for each library and do not sync with your mobile app.</p><button className="text-button danger-text" onClick={() => setResetOpen(true)}>Reset favourites and albums</button></section><section className="settings-card"><div className="settings-title"><span className="setting-symbol"><Icon name="photos" /></span><div><h2>GitGallery for web</h2><p>Your memories. Your repository.</p></div></div><p className="settings-copy">Browse your backed-up photos, play videos, download originals, and organise your favourites. Use the mobile app to upload and back up new photos to this repository.</p>{library.source === 'demo' && <a className="text-button" href="./demo/sources.json" target="_blank" rel="noreferrer">Demo photo and video credits<Icon name="external" size={14} /></a>}</section></div>}
      </main>
    </div>

    {selecting && selected.size > 0 && <div className="selection-bar" role="region" aria-label="Selected photos"><strong>{selected.size} selected</strong><button onClick={() => { updateCollection({ ...collection, favorites: [...new Set([...collection.favorites, ...selected])] }); setNotice('Added to favourites'); clearSelection(); }}><Icon name="heart" size={18} /><span>Favourite</span></button><button onClick={() => openAlbumDialog([...selected])}><Icon name="albums" size={18} /><span>Add to album</span></button><button aria-label="Clear selection" onClick={clearSelection}><Icon name="close" size={18} /></button></div>}
    {notice && <div className="toast" role="status"><Icon name="check" size={16} />{notice}</div>}
    {viewerAsset && <Viewer asset={viewerAsset} source={source} favorite={favorites.has(viewerAsset.id)} position={viewerIndex} total={filtered.length} onPrevious={() => setViewerId(filtered[viewerIndex - 1]?.id ?? viewerId)} onNext={() => setViewerId(filtered[viewerIndex + 1]?.id ?? viewerId)} onClose={() => setViewerId(null)} onFavorite={() => favorite(viewerAsset.id)} onAlbum={() => openAlbumDialog([viewerAsset.id])} />}
    {albumTargets !== null && <Modal title={albumTargets.length ? 'Add to album' : 'Create an album'} onClose={() => setAlbumTargets(null)}><p className="muted">{albumTargets.length ? `${albumTargets.length} selected ${albumTargets.length === 1 ? 'moment' : 'moments'}. Choose a collection or start a new one.` : 'Bring a few favourite moments together. Albums are saved in this browser.'}</p>{albumTargets.length > 0 && <div className="album-picker">{collection.albums.map((item) => <button key={item.id} onClick={() => addToAlbum(item.id)}><Icon name="albums" /><span>{item.name}</span><Icon name="plus" size={16} /></button>)}</div>}<form className="form-stack" onSubmit={createAlbum}><label>Album name<input value={albumName} onChange={(event) => { setAlbumName(event.target.value); setAlbumError(''); }} maxLength={80} placeholder="Summer by the sea" required /></label>{albumError && <p className="error-box" role="alert">{albumError}</p>}<button className="button primary" type="submit"><Icon name="plus" size={17} />{albumTargets.length ? 'Create and add' : 'Create album'}</button></form></Modal>}
    {deleteAlbum && <Modal title="Delete album?" onClose={() => setDeleteAlbum(null)}><p>Remove “{collection.albums.find((item) => item.id === deleteAlbum)?.name}” from this browser? Your photos will stay in the library.</p><div className="modal-actions"><button className="button secondary" onClick={() => setDeleteAlbum(null)}>Cancel</button><button className="button danger" onClick={() => { updateCollection({ ...collection, albums: collection.albums.filter((item) => item.id !== deleteAlbum) }); setDeleteAlbum(null); setNotice('Album deleted'); }}>Delete album</button></div></Modal>}
    {resetOpen && <Modal title="Reset this browser’s collections?" onClose={() => setResetOpen(false)}><p>This resets favourites and albums for the current library in this browser. Photos in your repository stay untouched.</p><div className="modal-actions"><button className="button secondary" onClick={() => setResetOpen(false)}>Cancel</button><button className="button danger" onClick={() => { updateCollection(library.initialCollection); setResetOpen(false); setNotice('Collections reset'); }}>Reset collections</button></div></Modal>}
    {overlay}
  </div>;
}
