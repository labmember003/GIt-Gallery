import { test, expect } from '@playwright/test';

const website = 'http://127.0.0.1:8093';

test('guided GitHub code approval establishes a session without exposing credentials', async ({ page, context }, testInfo) => {
  const errors: string[] = [];
  const responses: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', async response => { if (response.url().includes('/api/auth/')) responses.push(await response.text()); });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: website });
  await page.goto(website);
  await expect(page.getByText('Copy the one-time code we show you.', { exact: true })).toBeVisible();
  await expect(page.getByText('Advanced sign-in', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue with GitHub', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect your GitHub account' });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel('GitHub sign-in code')).toHaveValue('ABCD-EFGH');
  await page.getByRole('button', { name: 'Copy code', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('ABCD-EFGH');
  await expect(page.getByRole('link', { name: 'Open GitHub to approve' })).toHaveAttribute('href', 'https://github.com/login/device');
  await expect(dialog).toContainText('This page continues automatically after approval.');
  await page.screenshot({ path: testInfo.outputPath('device-signin-desktop.png') });
  await expect(page.getByRole('heading', { name: 'Choose your photo repository' })).toBeVisible();
  await page.getByRole('button', { name: /tester\/photos/ }).click();
  await expect(page.locator('.photo-card')).toHaveCount(2);
  await page.reload();
  await expect(page.locator('.photo-card')).toHaveCount(2);
  expect((await context.cookies()).find(cookie => cookie.name === 'gg_session')?.httpOnly).toBe(true);
  expect(responses.join(' ')).not.toContain('device_fixture_');
  expect(responses.join(' ')).not.toContain('test_token_for_browser');
  expect(errors).toEqual([]);
});

test('phone onboarding fits and cancelling invalidates the pending sign-in', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Keep the fixture waiting for consent while layout and cancellation are exercised.
  await page.route('**/api/auth/device/poll', route => route.fulfill({ json: { status: 'pending', retryAfter: 5 } }));
  await page.goto(website);
  await page.getByRole('button', { name: 'Continue with GitHub', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('device-signin-phone.png') });
  const cancel = page.waitForResponse('**/api/auth/device/cancel');
  await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
  expect((await cancel).status()).toBe(200);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue with GitHub', exact: true })).toBeFocused();
  const session = await (await page.request.get(`${website}/api/session`)).json();
  expect(session.user).toBeNull();
});

test('expired approval code gives a clear next step and generates a fresh attempt', async ({ page }) => {
  let attempts = 0;
  page.on('request', request => { if (request.url().endsWith('/api/auth/start')) attempts++; });
  await page.route('**/api/auth/device/poll', route => route.fulfill({ status: 410, json: { error: 'Your code has expired. Start again to get a new code.' } }));
  await page.goto(website);
  await page.getByRole('button', { name: 'Continue with GitHub', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Your code has expired');
  await page.getByRole('button', { name: 'Get a new code', exact: true }).click();
  await expect.poll(() => attempts).toBe(2);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Waiting for your approval');
});
