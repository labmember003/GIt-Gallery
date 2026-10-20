import { test, expect, type Page } from '@playwright/test';
const TOKEN = 'test_token_for_browser_fixtures_123456789';
async function signIn(page: Page) {
  await page.goto('/');
  await page.getByText('Advanced sign-in', { exact: true }).click();
  await page.getByRole('button', { name: 'Use a personal access token' }).click();
  await page.getByLabel('Personal access token', { exact: true }).fill(TOKEN);
  await page.getByRole('button', { name: 'Sign in with token' }).click();
  await expect(page.getByRole('heading', { name: 'Choose your photo repository' })).toBeVisible();
}

test('signed-out visitors see sign-in without demo media; demo is an explicit choice', async ({ page }, testInfo) => {
  const media: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/demo/')) media.push(request.url()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to GitGallery' })).toBeVisible();
  await expect(page.locator('.photo-card')).toHaveCount(0);
  expect(media).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('welcome-desktop.png') });
  await page.getByRole('button', { name: 'Try the demo', exact: true }).click();
  await expect(page.locator('.photo-card')).toHaveCount(39);
  await page.getByRole('navigation').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Exit demo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to GitGallery' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome to GitGallery' })).toBeVisible();
});

test('real server session opens only selected media, survives reload, and signs out', async ({ page, context }, testInfo) => {
  const browserAuthHeaders: string[] = [];
  const errors: string[] = [];
  page.on('request', request => { if (request.headers().authorization) browserAuthHeaders.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await signIn(page);
  await expect(page.getByRole('button', { name: /tester\/photos/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('repository-picker.png') });
  await page.getByRole('button', { name: /tester\/photos/ }).click();
  await expect(page.locator('.photo-card')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Open real memory', exact: true })).toBeVisible();
  await expect.poll(() => page.locator('.photo-card img').first().evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator('.demo-banner')).toHaveCount(0);
  await page.getByRole('button', { name: 'Favourite real memory', exact: true }).click();
  await page.reload();
  await expect(page.locator('.photo-card')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Unfavourite real memory', exact: true })).toBeVisible();
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookies: document.cookie }));
  expect(storage).not.toContain(TOKEN);
  expect(storage).not.toContain('gg_session');
  expect(storage).toContain('tester:tester/photos@main');
  expect((await context.cookies()).find(cookie => cookie.name === 'gg_session')?.httpOnly).toBe(true);
  expect(browserAuthHeaders).toEqual([]);
  await page.getByRole('navigation').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to GitGallery' })).toBeVisible();
  await expect(page.locator('.photo-card')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Welcome to GitGallery' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('OAuth redirects through GitHub and returns to repository selection', async ({ page }) => {
  await page.route('**/api/session', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), tokenSignInAvailable: false } });
  });
  await page.route('https://github.com/login/oauth/authorize**', async route => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', url.searchParams.get('state')!);
    callback.searchParams.set('code', 'fixture-code');
    await route.fulfill({ status: 302, headers: { Location: callback.href } });
  });
  await page.goto('/');
  await expect(page.getByText('Advanced sign-in', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Personal access token', { exact: true })).toHaveCount(0);
  await page.getByText('How sign-in works', { exact: true }).click();
  await expect(page.getByText('Sign in to your GitHub account.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Continue with GitHub', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Choose your photo repository' })).toBeVisible();
  await expect(page.getByText('@tester', { exact: true })).toBeVisible();
});

test('unconfigured copies explain the required setup and retry recovers', async ({ page }, testInfo) => {
  let available = false;
  let sessionRequests = 0;
  let authRequests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/auth/start') authRequests++; });
  await page.route('**/api/session', async route => {
    sessionRequests++;
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), oauthAvailable: available, tokenSignInAvailable: false } });
  });
  await page.route('https://github.com/login/oauth/authorize**', async route => {
    const url = new URL(route.request().url());
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', url.searchParams.get('state')!);
    callback.searchParams.set('code', 'fixture-code');
    await route.fulfill({ status: 302, headers: { Location: callback.href } });
  });
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText('This website needs to connect to GitHub');
  await page.getByText('Setup steps if you run this website', { exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Device Flow');
  await expect(page.getByRole('status')).toContainText('GITHUB_CLIENT_ID');
  const retry = page.getByRole('button', { name: 'Retry GitHub sign-in', exact: true });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect.poll(() => sessionRequests).toBeGreaterThan(1);
  await expect(retry).toBeEnabled();
  expect(authRequests).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('signin-unavailable.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('signin-unavailable-phone.png'), fullPage: true });
  available = true;
  await retry.click();
  await expect(page.getByRole('heading', { name: 'Choose your photo repository' })).toBeVisible();
  expect(authRequests).toBe(1);
});

test('invalid credentials can be corrected; empty repositories contain no sample photos or albums', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Advanced sign-in', { exact: true }).click();
  await page.getByRole('button', { name: 'Use a personal access token' }).click();
  await page.getByLabel('Personal access token', { exact: true }).fill('invalid_token_for_fixture_only_123');
  await page.getByRole('button', { name: 'Sign in with token' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Personal access token', { exact: true }).fill(TOKEN);
  await page.getByRole('button', { name: 'Sign in with token' }).click();
  await page.getByRole('button', { name: /tester\/empty/ }).click();
  await expect(page.getByRole('heading', { name: 'Your library is ready for photos' })).toBeVisible();
  await expect(page.locator('.photo-card')).toHaveCount(0);
  await page.getByRole('navigation').getByRole('button', { name: /Albums/ }).click();
  await expect(page.locator('.album-card')).toHaveCount(0);
});

test('switching repositories replaces media; cancelling the picker keeps the current library usable', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: /tester\/photos/ }).click();
  await expect(page.locator('.photo-card')).toHaveCount(2);
  await page.getByRole('button', { name: 'Switch repository', exact: true }).first().click();
  await page.getByRole('button', { name: 'Back to your library' }).click();
  await page.getByRole('button', { name: 'Open real memory', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('img')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Switch repository', exact: true }).first().click();
  await page.getByRole('button', { name: /tester\/empty/ }).click();
  await expect(page.locator('.photo-card')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your library is ready for photos' })).toBeVisible();
});

test('another tab signing out clears the displayed private library', async ({ page, context }) => {
  await signIn(page); await page.getByRole('button', { name: /tester\/photos/ }).click();
  await expect(page.locator('.photo-card')).toHaveCount(2);
  const second = await context.newPage(); await second.goto('/');
  await expect(second.locator('.photo-card')).toHaveCount(2);
  await second.getByRole('navigation').getByRole('button', { name: 'Settings', exact: true }).click();
  await second.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to GitGallery' })).toBeVisible();
  await expect(page.locator('.photo-card')).toHaveCount(0);
});

test('phone sign-in and repository picker fit the screen', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to GitGallery' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('welcome-phone.png'), fullPage: true });
  await signIn(page);
  await expect(page.getByRole('button', { name: /tester\/photos/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('repositories-phone.png'), fullPage: true });
});
