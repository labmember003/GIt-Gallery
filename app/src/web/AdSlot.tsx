import React, { useEffect } from 'react';

// One small Google AdSense ad (320×100), only on the public sign-in page: never next to anyone's photos.
// Google's script is loaded here and nowhere else; BrowserApp reloads the page once someone signs in, so the script
// never runs alongside a signed-in library. Nothing shows on localhost, behind an ad blocker, or when Google has no ad.
const CLIENT = 'ca-pub-7683902216769416';
const SLOT = '8164641375';

declare global {
  interface Window { adsbygoogle?: unknown[]; gitgalleryAdsLoaded?: boolean }
}

export function adsLoaded(): boolean {
  return typeof window !== 'undefined' && window.gitgalleryAdsLoaded === true;
}

export function AdSlot() {
  const live = typeof location !== 'undefined' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  useEffect(() => {
    if (!live) return;
    if (!window.gitgalleryAdsLoaded) {
      const script = document.createElement('script');
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${CLIENT}`;
      document.head.appendChild(script);
      window.gitgalleryAdsLoaded = true;
    }
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch { /* ad blocked or already filled */ }
  }, [live]);
  if (!live) return null;
  return <aside className="ad-slot" aria-label="Advertisement">
    <span className="ad-label">Advertisement</span>
    <ins className="adsbygoogle" style={{ display: 'inline-block', width: 320, height: 100 }} data-ad-client={CLIENT} data-ad-slot={SLOT} />
  </aside>;
}
