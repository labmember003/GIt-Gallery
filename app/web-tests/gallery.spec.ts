import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('demo photos, search, viewer keyboard navigation, download, and theme', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?demo=1');
  await expect(page.locator('.photo-card')).toHaveCount(39);
  await expect(page.locator('.photo-card img').first()).toBeVisible();
  await expect.poll(() => page.locator('.photo-card img').first().evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  expect((await page.locator('.gg-app').boundingBox())!.width).toBe(1440);
  await page.locator('.gallery-footer').scrollIntoViewIfNeeded();
  await expect(page.locator('.gallery-footer')).toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>('.photo-card img')).filter((image) => image.getBoundingClientRect().top < innerHeight).every((image) => image.complete && image.naturalWidth > 0));
  await page.screenshot({ path: testInfo.outputPath('desktop-light.png') });
  await page.getByRole('textbox', { name: 'Search photos' }).fill('Santorini');
  await expect(page.locator('.photo-card')).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Search photos' }).fill('no such memory');
  await expect(page.getByRole('heading', { name: 'No matching moments' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('button', { name: 'Open Riviera', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Zoom in' }).locator('img')).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download original' }).click();
  expect((await downloadPromise).suggestedFilename()).toMatch(/riviera\.webp$/);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('dialog').getByRole('heading')).not.toHaveText('Riviera');
  await expect(page.getByRole('dialog').getByRole('img')).toHaveAttribute('src', /santorini\.webp$/);
  await expect.poll(() => page.getByRole('dialog').getByRole('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('photo-viewer.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await page.reload();
  await expect(page.locator('.gg-app')).toHaveAttribute('data-theme', 'dark');
  await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>('.photo-card img')).filter((image) => image.getBoundingClientRect().top < innerHeight).every((image) => image.complete && image.naturalWidth > 0));
  await page.screenshot({ path: testInfo.outputPath('desktop-dark.png') });
  expect(errors).toEqual([]);
});

test('videos load, play, and seek', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.getByRole('button', { name: 'Videos', exact: true }).click();
  await expect(page.locator('.photo-card')).toHaveCount(3);
  await page.getByRole('button', { name: 'Open Ocean drift', exact: true }).click();
  const video = page.locator('video');
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.duration)).toBeGreaterThan(10);
  await video.evaluate(async (element: HTMLVideoElement) => { element.muted = true; await element.play(); element.currentTime = 5; });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(5);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('favourites and album membership persist; deleting albums keeps photos', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.getByRole('button', { name: 'Unfavourite Riviera', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Favourite Riviera', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('navigation').getByRole('button', { name: /Albums/ }).click();
  await page.getByRole('button', { name: 'New album', exact: true }).click();
  await page.getByRole('textbox', { name: 'Album name' }).fill('Weekend stories');
  await page.getByRole('button', { name: 'Create album', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: /Photos/ }).click();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select Riviera', exact: true }).check();
  await page.getByRole('region', { name: 'Selected photos' }).getByRole('button', { name: 'Add to album' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Weekend stories', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: /Albums/ }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Open album Weekend stories', exact: true }).click();
  await expect(page.locator('.photo-card')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Open Riviera', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'All albums' }).click();
  await page.getByRole('button', { name: 'Delete album Weekend stories' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete album', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open album Weekend stories' })).toHaveCount(0);
  await page.getByRole('navigation').getByRole('button', { name: /Photos/ }).click();
  await expect(page.locator('.photo-card')).toHaveCount(39);
});

test('phone layout, navigation and dialogs fit the viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?demo=1');
  await expect(page.getByRole('button', { name: 'Open Riviera', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>('.photo-card img')).filter((image) => image.getBoundingClientRect().top < innerHeight).every((image) => image.complete && image.naturalWidth > 0));
  await page.screenshot({ path: testInfo.outputPath('phone-gallery.png') });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('navigation').getByRole('button', { name: /Albums/ }).click();
  await expect(page.getByRole('heading', { name: 'Albums', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New album', exact: true }).click();
  const bounds = await page.getByRole('dialog').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.gg-app')).not.toHaveClass(/sidebar-open/);
});

test('large libraries render in pages; oversized release originals have a usable fallback', async ({ page }) => {
  const bytes = await readFile('public/demo/riviera.webp');
  const entries = Array.from({ length: 1000 }, (_, index) => ({
    path: `gitgallery/images/trip/photo${String(index).padStart(4, '0')}.webp`, type: 'blob', sha: `photo${index}`, size: bytes.length,
  }));
  entries.push({ path: 'gitgallery/images/trip/bigvideo.mp4.ptr', type: 'blob', sha: 'pointer', size: 100 });
  await page.route('https://api.github.com/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/git/trees/')) return route.fulfill({ json: { sha: 'root', tree: entries } });
    if (path.endsWith('/git/blobs/pointer')) return route.fulfill({ json: { tier: 2, assetId: 123, size: 500 * 1024 * 1024 } });
    if (path.includes('/git/blobs/')) return route.fulfill({ contentType: 'image/webp', body: bytes });
    return route.fulfill({ json: { full_name: 'tester/large', default_branch: 'main' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Open a public repository', exact: true }).click();
  await page.getByRole('textbox', { name: 'Repository', exact: true }).fill('tester/large');
  await page.getByRole('button', { name: 'Open library', exact: true }).click();
  await expect(page.locator('.photo-card')).toHaveCount(120);
  await page.getByRole('button', { name: 'Load more photos', exact: true }).click();
  await expect(page.locator('.photo-card')).toHaveCount(240);
  await page.getByRole('textbox', { name: 'Search photos' }).fill('photo0999');
  await expect(page.locator('.photo-card')).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Search photos' }).fill('bigvideo');
  await page.getByRole('button', { name: 'Open bigvideo', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('80 MB browser preview limit');
  await expect(page.getByRole('link', { name: 'Open on GitHub' })).toHaveAttribute('href', 'https://github.com/tester/large/releases');
});
