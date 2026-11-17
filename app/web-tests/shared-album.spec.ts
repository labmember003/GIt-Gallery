import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  objectId, partFile, sealBytes, sealManifest, sharePath, toBase64Url, type ShareItem, type ShareManifest,
} from '../src/services/share/format';

/**
 * A shared album opened from its link. The encrypted files that the owner's
 * phone would publish to `<owner>/gitgallery-shares` are built here with the
 * real format code and served in place of raw.githubusercontent.com, so this
 * runs offline and still exercises the production page, CSP and decryption.
 */

const rnd = (n: number) => new Uint8Array(randomBytes(n));
const OWNER = 'tester';
const SHARE_ID = 'fixture0share01';

async function buildShare() {
  const key = rnd(32);
  const files = new Map<string, Uint8Array>();
  const items: ShareItem[] = [];
  const photos = ['riviera', 'santorini', 'canyon'];
  for (const [index, name] of photos.entries()) {
    const bytes = new Uint8Array(await readFile(`public/demo/${name}.webp`));
    const id = `item${index}`;
    for (const kind of ['p', 'o'] as const) {
      sealBytes(key, objectId(id, kind), bytes, rnd).forEach((part, p) => files.set(sharePath(SHARE_ID, partFile(id, kind, p)), part));
    }
    items.push({ id, src: `src${index}`, kind: 'photo', w: 1600, h: 1067, takenAt: Date.UTC(2026, 0, 26 - index, 12), ext: 'webp',
      preview: { size: bytes.length, parts: 1 }, original: { size: bytes.length, parts: 1 } });
  }
  const manifest: ShareManifest = { v: 1, title: 'Trip fixture', owner: OWNER, createdAt: 1, updatedAt: 2, cover: 'item0', items };
  files.set(sharePath(SHARE_ID, 'manifest.bin'), sealManifest(key, manifest, rnd).bytes);
  return { key: toBase64Url(key), files };
}

const COMMIT = 'c0ffee'.padEnd(40, '0');

/** `stale` serves an older commit at `HEAD`, as raw.githubusercontent.com can for a few minutes. */
async function serveShare(page: Page, files: Map<string, Uint8Array>, stale?: Map<string, Uint8Array>) {
  await page.route('https://api.github.com/**', (route) => route.fulfill({
    status: 200, body: COMMIT, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/vnd.github.sha' },
  }));
  await page.route('https://raw.githubusercontent.com/**', async (route) => {
    const url = new URL(route.request().url()).pathname;
    const atHead = url.startsWith(`/${OWNER}/gitgallery-shares/HEAD/`);
    const path = url.replace(`/${OWNER}/gitgallery-shares/${atHead ? 'HEAD' : COMMIT}/`, '');
    const body = (atHead && stale ? stale : files).get(path);
    await route.fulfill(body
      ? { status: 200, body: Buffer.from(body), headers: { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream' } }
      : { status: 404, body: '404: Not Found', headers: { 'access-control-allow-origin': '*' } });
  });
}

test('a share link opens without sign-in, decrypts in the browser, and explains a wrong key or a stopped share', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const share = await buildShare();
  await serveShare(page, share.files);

  await page.goto(`/s/${OWNER}/${SHARE_ID}#${share.key}`);
  await expect(page.getByRole('heading', { name: 'Trip fixture' })).toBeVisible();
  await expect(page.getByText(`Shared by @${OWNER}`)).toBeVisible();
  await expect(page.locator('.photo-card')).toHaveCount(3);
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll<HTMLImageElement>('.photo-card img'));
    return images.length === 3 && images.every((image) => image.complete && image.naturalWidth > 0);
  });
  await expect(page).toHaveTitle('Trip fixture · GitGallery');
  await page.screenshot({ path: testInfo.outputPath('shared-album.png') });

  await page.getByRole('button', { name: 'Open Trip fixture' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect.poll(() => page.getByRole('dialog').getByRole('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  // View only: no favourite or add-to-album actions.
  await expect(page.getByRole('button', { name: 'Add to favourites' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add to album' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.goto(`/s/${OWNER}/${SHARE_ID}#${'A'.repeat(43)}`);
  await expect(page.getByRole('heading', { name: 'Could not open this album' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);

  await page.goto(`/s/${OWNER}/stoppedshare01#${share.key}`);
  await expect(page.getByRole('heading', { name: 'Album not available' })).toBeVisible();

  await page.goto(`/s/${OWNER}/${SHARE_ID}`);
  await expect(page.getByText('This link is incomplete')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a stopped share is gone at once, even while the CDN still serves the old commit at HEAD', async ({ page }) => {
  const share = await buildShare();
  await serveShare(page, new Map(), share.files);
  await page.goto(`/s/${OWNER}/${SHARE_ID}#${share.key}`);
  await expect(page.getByRole('heading', { name: 'Album not available' })).toBeVisible();
});

test('the shared album fits a phone screen', async ({ page }) => {
  const share = await buildShare();
  await serveShare(page, share.files);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/s/${OWNER}/${SHARE_ID}#${share.key}`);
  await expect(page.locator('.photo-card')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
