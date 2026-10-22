import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByText('Advanced sign-in', { exact: true }).click();
  await page.getByRole('button', { name: 'Use a personal access token' }).click();
  await page.getByLabel('Personal access token', { exact: true }).fill(`test_upload_${randomUUID().replaceAll('-', '')}`);
  await page.getByRole('button', { name: 'Sign in with token' }).click();
  await expect(page.getByRole('heading', { name: 'Your library is ready for photos' })).toBeVisible();
}

test('empty library uploads real image bytes, shows originals and survives reload without duplicates', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await signIn(page);
  await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('upload-empty-library.png') });
  await page.getByRole('button', { name: 'Upload photos and videos', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Choose files', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('upload-picker-light.png') });
  const bytes = await readFile('public/demo/riviera.webp');
  const image = { name: 'My summer.webp', mimeType: 'image/webp', buffer: bytes };
  await dialog.getByLabel('Choose photos and videos').setInputFiles(image);
  await expect(dialog.getByText('1 of 1 saved', { exact: true })).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: testInfo.outputPath('upload-complete.png') });
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open My summer', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('.photo-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Open My summer', exact: true }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download original' }).click();
  const download = await downloaded; expect(download.suggestedFilename()).toBe(image.name);
  const stream = await download.createReadStream(); const chunks: Buffer[] = []; for await (const part of stream!) chunks.push(Buffer.from(part));
  expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await dialog.getByLabel('Choose photos and videos').setInputFiles(image);
  await expect(dialog.getByText('Already in your library', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.photo-card')).toHaveCount(1); expect(errors).toEqual([]);
});

test('album uploads chunk a file over Vercel limit, retry failures, reject unsupported files and retain membership', async ({ page }, testInfo) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Create an album', exact: true }).click();
  await page.getByRole('textbox', { name: 'Album name' }).fill('Summer stories');
  await page.getByRole('button', { name: 'Create album', exact: true }).click();
  await page.getByRole('button', { name: 'Open album Summer stories', exact: true }).click();
  await page.getByRole('button', { name: 'Upload photos and videos', exact: true }).click();
  let failed = false; const chunkSizes: number[] = [];
  await page.route('**/api/uploads/*/chunks/*', async route => {
    chunkSizes.push(route.request().postDataBuffer()!.length);
    if (!failed) { failed = true; return route.fulfill({ status: 502, json: { error: 'Connection interrupted. Retry to continue.' } }); }
    return route.continue();
  });
  const original = await readFile('public/demo/riviera.webp');
  const bytes = Buffer.concat([original, Buffer.alloc(5 * 1024 * 1024)]);
  await page.getByLabel('Choose photos and videos').setInputFiles({ name: 'Large photo.webp', mimeType: 'image/webp', buffer: bytes });
  await expect(page.getByRole('button', { name: 'Retry remaining' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('upload-retry.png') });
  await page.getByRole('button', { name: 'Retry remaining' }).click();
  await expect(page.getByText('1 of 1 saved', { exact: true })).toBeVisible();
  expect(chunkSizes.length).toBeGreaterThan(2); expect(Math.max(...chunkSizes)).toBeLessThan(4.5 * 1024 * 1024);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.photo-card')).toHaveCount(1);
  await page.reload(); await expect(page.getByRole('heading', { name: 'Summer stories', exact: true })).toBeVisible();
  await expect(page.locator('.photo-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await page.getByLabel('Choose photos and videos').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not media') });
  await expect(page.getByText(/This file type is not supported/)).toBeVisible();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.photo-card')).toHaveCount(1);
});

test('video upload uses a release pointer, plays after refresh, and phone upload dialog fits', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  await signIn(page); await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose files' })).toBeEnabled();
  const dialog = page.getByRole('dialog'); const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('upload-phone-dark.png') });
  const original = await readFile('public/demo/ocean-drift.mp4');
  await page.getByLabel('Choose photos and videos').setInputFiles({ name: 'Ocean day.mp4', mimeType: 'video/mp4', buffer: Buffer.concat([original, Buffer.alloc(26 * 1024 * 1024)]) });
  await expect(page.getByText('1 of 1 saved', { exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Open Ocean day', exact: true }).click();
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.duration)).toBeGreaterThan(10);
  await page.locator('video').evaluate(async (video: HTMLVideoElement) => { video.muted = true; await video.play(); video.currentTime = 5; });
  await expect.poll(() => page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(5);
});

test('demo uploads guide visitors to sign-in, and view-only libraries explain how to get write access', async ({ page }) => {
  await page.goto('/?demo=1'); await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to GitGallery' })).toBeVisible();
  await page.getByText('Advanced sign-in', { exact: true }).click();
  await page.getByRole('button', { name: 'Use a personal access token' }).click();
  await page.getByLabel('Personal access token', { exact: true }).fill('test_token_for_browser_fixtures_123456789');
  await page.getByRole('button', { name: 'Sign in with token' }).click();
  await page.getByRole('button', { name: /tester\/empty/ }).click();
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('ask its owner for write access');
  await expect(page.getByLabel('Choose photos and videos')).toHaveCount(0);
});

test('dropping files opens upload; stopping and retrying keeps the queue usable', async ({ page }, testInfo) => {
  await signIn(page);
  let release: () => void = () => {}; let arrived: () => void = () => {};
  const reached = new Promise<void>(resolve => { arrived = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let delayed = false;
  await page.route('**/api/uploads/*/chunks/*', async route => {
    if (!delayed) { delayed = true; arrived(); await gate; }
    await route.continue().catch(() => {});
  });
  const bytes = Array.from(await readFile('public/demo/riviera.webp'));
  await page.locator('main').evaluate((main, bytes) => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], 'Dropped photo.webp', { type: 'image/webp' }));
    main.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, bytes);
  await reached;
  await expect(page.getByRole('progressbar')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('upload-progress.png') });
  await page.getByRole('button', { name: 'Stop uploads…', exact: true }).click();
  await expect(page.getByText(/Files already saved will stay/)).toBeVisible();
  await page.getByRole('button', { name: 'Stop uploads', exact: true }).click();
  release();
  await expect(page.getByRole('button', { name: 'Retry remaining' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry remaining' }).click();
  await expect(page.getByText('1 of 1 saved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Dropped photo', exact: true })).toBeVisible();
});
