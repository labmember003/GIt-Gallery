// Run against the demo website: WEB_CAPTURE_URL=http://127.0.0.1:8082 npm run screenshots:web
// Uses a fresh browser context; never touches a signed-in browser profile.
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(app, '../screenshots/web');
const previews = resolve(app, '../screenshots/previews/web');
const originals = resolve(tmpdir(), 'gitgallery-web-captures');
await Promise.all([output, previews, originals].map((path) => mkdir(path, { recursive: true })));
const browser = await chromium.launch();
const captures = [];
const base = process.env.WEB_CAPTURE_URL ?? 'http://127.0.0.1:8082/?demo=1';
const sha = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');

async function ready(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => {
    const visible = (element) => { const rect = element.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth; };
    return Array.from(document.querySelectorAll('.asset-image')).filter(visible).every((slot) => {
      const image = slot.querySelector('img'); return image && image.complete && image.naturalWidth > 0;
    }) && Array.from(document.querySelectorAll('.viewer-media img')).every((image) => image.complete && image.naturalWidth > 0);
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function shot(page, name, title, mobile = false) {
  await page.mouse.move(0, 0);
  await ready(page);
  const original = resolve(originals, `${name}.png`);
  const full = resolve(output, `${name}.webp`);
  const preview = resolve(previews, `${name}.webp`);
  await page.screenshot({ path: original, animations: 'disabled', caret: 'hide' });
  execFileSync('cwebp', ['-quiet', '-q', '90', '-m', '6', original, '-o', full]);
  execFileSync('cwebp', ['-quiet', '-q', '86', '-m', '6', '-resize', mobile ? '430' : '800', '0', original, '-o', preview]);
  const viewport = page.viewportSize();
  captures.push({ file: `${name}.webp`, title, viewport, deviceScaleFactor: mobile ? 2 : 1,
    width: viewport.width * (mobile ? 2 : 1), height: viewport.height * (mobile ? 2 : 1),
    original: { file: `${name}.png`, bytes: (await stat(original)).size, sha256: await sha(original) },
    bytes: (await stat(full)).size, sha256: await sha(full),
    preview: { file: `../previews/web/${name}.webp`, bytes: (await stat(preview)).size, sha256: await sha(preview) } });
  console.log(`Captured ${name}`);
}
async function theme(page, desired) {
  const toggle = page.getByRole('button', { name: `Switch to ${desired} theme` });
  if (await toggle.count()) await toggle.click();
}
async function nav(page, name) {
  await page.getByRole('navigation').getByRole('button', { name: new RegExp(name) }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
}
async function photo(page, name) {
  await page.getByRole('button', { name: `Open ${name}`, exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('dialog').getByRole('img').waitFor();
}

try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1040 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(base);
  await page.getByRole('button', { name: 'Open Riviera', exact: true }).waitFor();
  await shot(page, '01-gallery-light', 'Gallery — light');
  await theme(page, 'dark');
  await shot(page, '02-gallery-dark', 'Gallery — dark');
  await nav(page, 'Albums'); await theme(page, 'light');
  await shot(page, '03-albums-light', 'Albums — light');
  await theme(page, 'dark'); await shot(page, '04-albums-dark', 'Albums — dark');
  await nav(page, 'Favourites'); await theme(page, 'light');
  await shot(page, '05-favourites-light', 'Favourites — light');
  await theme(page, 'dark'); await shot(page, '06-favourites-dark', 'Favourites — dark');
  await nav(page, 'Photos'); await photo(page, 'Riviera');
  await shot(page, '07-riviera-viewer', 'Riviera photo viewer'); await page.keyboard.press('Escape');
  await photo(page, 'Santorini'); await shot(page, '08-santorini-viewer', 'Santorini photo viewer'); await page.keyboard.press('Escape');
  await photo(page, 'Alpine summit'); await shot(page, '09-alpine-viewer', 'Alpine photo viewer'); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Videos', exact: true }).click();
  await page.getByRole('button', { name: 'Open Ocean drift', exact: true }).click();
  await page.locator('video').evaluate((video) => new Promise((resolve, reject) => {
    video.muted = true;
    const seek = () => { video.pause(); video.currentTime = 5; };
    video.addEventListener('seeked', resolve, { once: true }); video.addEventListener('error', reject, { once: true });
    if (video.readyState >= 1) seek(); else video.addEventListener('loadedmetadata', seek, { once: true });
  }));
  await shot(page, '10-ocean-video-player', 'Ocean video playback'); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'All media', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0)); await theme(page, 'light');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  for (const name of ['Riviera', 'Santorini', 'Ocean', 'Tropical beach', 'Island cove', 'Mediterranean']) await page.getByRole('checkbox', { name: `Select ${name}`, exact: true }).check();
  await shot(page, '11-multi-select-light', 'Multi-selection — light');
  await theme(page, 'dark'); await shot(page, '12-multi-select-dark', 'Multi-selection — dark');
  await page.getByRole('region', { name: 'Selected photos' }).getByRole('button', { name: 'Add to album' }).click();
  await shot(page, '13-add-to-album', 'Add to album'); await page.keyboard.press('Escape');
  await nav(page, 'Albums'); await theme(page, 'light');
  await page.getByRole('button', { name: 'Open album Coastal escapes', exact: true }).click();
  await shot(page, '14-coastal-album-light', 'Coastal album — light');
  await nav(page, 'Albums'); await theme(page, 'dark');
  await page.getByRole('button', { name: 'Open album Into the mountains', exact: true }).click();
  await shot(page, '15-mountain-album-dark', 'Mountain album — dark');
  await nav(page, 'Albums'); await page.getByRole('button', { name: 'Open album City after dark', exact: true }).click();
  await shot(page, '16-city-album-dark', 'City album — dark');
  await nav(page, 'Settings'); await theme(page, 'light');
  await shot(page, '17-settings-light', 'Settings — light');
  await theme(page, 'dark'); await shot(page, '18-settings-dark', 'Settings — dark');

  const mobile = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const phone = await mobile.newPage(); await phone.goto(base);
  await phone.getByRole('button', { name: 'Open Riviera', exact: true }).waitFor();
  await shot(phone, '19-mobile-gallery-light', 'Mobile gallery — light', true);
  await theme(phone, 'dark'); await shot(phone, '20-mobile-gallery-dark', 'Mobile gallery — dark', true);
  await phone.getByRole('button', { name: 'Open navigation' }).click(); await nav(phone, 'Albums');
  await shot(phone, '21-mobile-albums', 'Mobile albums', true);
  await phone.getByRole('button', { name: 'Open navigation' }).click(); await nav(phone, 'Photos');
  await photo(phone, 'Riviera'); await shot(phone, '22-mobile-viewer', 'Mobile photo viewer', true); await phone.keyboard.press('Escape');
  await phone.getByRole('button', { name: 'Open navigation' }).click(); await shot(phone, '23-mobile-navigation', 'Mobile navigation', true);
  await nav(page, 'Photos'); await page.getByRole('button', { name: 'Videos', exact: true }).click();
  await shot(page, '24-videos-grid-dark', 'Video library — dark');
  await writeFile(resolve(output, 'capture-manifest.json'), JSON.stringify({ capturedAt: new Date().toISOString(),
    platform: 'web', browser: `Chromium ${browser.version()}`, demo: true,
    description: 'Direct browser viewport captures of the running demo; no frames, overlays, or compositing.', captures }, null, 2) + '\n');
  console.log(JSON.stringify({ captures: captures.length, originalMiB: captures.reduce((sum, item) => sum + item.original.bytes, 0) / 1048576,
    fullAndPreviewMiB: captures.reduce((sum, item) => sum + item.bytes + item.preview.bytes, 0) / 1048576, originals }));
} finally { await browser.close(); }
