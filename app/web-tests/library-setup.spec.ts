import { test, expect, type Page } from '@playwright/test';

async function signIn(page: Page, token: string) {
  await page.goto('/');
  await page.getByText('Advanced sign-in', { exact: true }).click();
  await page.getByRole('button', { name: 'Use a personal access token' }).click();
  await page.getByLabel('Personal access token', { exact: true }).fill(token);
  await page.getByRole('button', { name: 'Sign in with token' }).click();
}

for (const kind of ['new', 'existing', 'single']) {
  test(`${kind} account automatically opens its library without choosing a repository`, async ({ page, context }, testInfo) => {
    const suffix = `${kind}${Date.now()}`;
    const expected = kind === 'single' ? 'memories' : 'gitgallery-photos';
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let setups = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/library/setup') setups++; });
    await page.setViewportSize({ width: kind === 'new' ? 390 : 1440, height: kind === 'new' ? 844 : 1000 });
    await signIn(page, `test_${kind}_${suffix}`);
    await expect(page.getByRole('heading', { name: 'Your library is ready for photos' })).toBeVisible();
    await expect(page.locator('.photo-card')).toHaveCount(0);
    await expect(page.locator('.demo-banner')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Choose your photo repository' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(kind === 'new' ? 390 : 1440);
    await page.screenshot({ path: testInfo.outputPath(`automatic-${kind}.png`), fullPage: true });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your library is ready for photos' })).toBeVisible();
    expect(setups).toBe(1);
    const session = await (await context.request.get('/api/session')).json();
    expect(session.selectedRepo).toEqual({ owner: `fixture-${suffix}`, name: expected, branch: 'trunk' });
    expect(errors).toEqual([]);
    if (kind === 'new') {
      // A fresh browser session discovers the repository created by the first sign-in.
      await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await page.getByRole('navigation').getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await signIn(page, `test_new_${suffix}`);
      await expect(page.getByRole('heading', { name: 'Your library is ready for photos' })).toBeVisible();
    }
  });
}

test('setup failures explain access and offer retry and manual selection on phones', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, `test_denied_denied${Date.now()}`);
  await expect(page.getByRole('alert')).toContainText('Sign out and sign in with GitHub');
  await expect(page.getByText('No repositories available', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('automatic-setup-error-phone.png'), fullPage: true });
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Sign out and sign in with GitHub');
  await page.getByRole('button', { name: 'Choose a repository manually' }).click();
  await expect(page.getByRole('heading', { name: 'Choose your photo repository' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('a failed manual listing shows a retry instead of an empty account', async ({ page }) => {
  await signIn(page, 'test_token_for_browser_fixtures_123456789');
  await page.getByRole('button', { name: /tester\/photos/ }).click();
  await expect(page.locator('.photo-card')).toHaveCount(2);
  let fail = true;
  await page.route('**/api/repositories?*', async route => {
    if (fail) await route.fulfill({ status: 503, json: { error: 'GitHub is temporarily unavailable.' } });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Switch repository', exact: true }).first().click();
  await expect(page.getByRole('alert')).toContainText('GitHub is temporarily unavailable.');
  await expect(page.getByRole('heading', { name: 'No repositories available' })).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'Retry loading repositories' }).click();
  await expect(page.getByRole('button', { name: /tester\/photos/ })).toBeVisible();
});
