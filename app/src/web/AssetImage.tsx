import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import type { MediaSource, WebAsset } from './types';

export function AssetImage({ asset, source }: { asset: WebAsset; source: MediaSource }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: '350px' });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let current = true;
    setUrl(null); setError('');
    source.load(asset, true).then((value) => { if (current) setUrl(value); })
      .catch((reason: Error) => { if (current) setError(reason.message); });
    return () => { current = false; };
  }, [asset, source, visible]);
  return <div ref={ref} className={`asset-image ${!url && !error ? 'image-loading' : ''}`}>
    {url && !error ? <img src={url} alt="" decoding="async" onError={() => setError('This format cannot be previewed by your browser.')} />
      : error ? <span className="image-fallback" title={error}><Icon name={asset.kind === 'video' ? 'video' : 'photos'} size={30} /><span>Preview unavailable</span></span> : null}
  </div>;
}
