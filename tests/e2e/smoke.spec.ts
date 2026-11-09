import { test, expect } from '@playwright/test';

// Run against a DISPOSABLE migrated database with test-only credentials.
// No Google/model/network integration is called by these tests.
const origin = process.env.TEST_BASE_URL || 'http://127.0.0.1:3100';
const password = process.env.TEST_OWNER_PASSWORD || 'local-verification-only-password';
test('private routes reject anonymous and cross-origin requests', async ({ request }) => {
  for (const path of ['/api/dashboard', '/api/google/connect']) {
    expect((await request.get(path, { maxRedirects: 0 })).status()).toBe(401);
  }
  for (const path of ['/api/sync', '/api/chat']) {
    expect((await request.post(path, { data: {} })).status()).toBe(401);
  }
  expect((await request.get('/api/cron?task=morning')).status()).toBe(401);
  const status = await (await request.get('/api/status')).json();
  expect(status.authenticated).toBe(false);
  expect(status.accounts).toEqual([]);
  expect(status.gaps).toEqual([]);
  const cross = await request.post('/api/auth/login', { data: { password }, headers: { Origin: 'https://attacker.invalid' } });
  expect(cross.status()).toBe(403);
});

test('real login, source settings, weekly filters, mobile layout and logout', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByLabel('Owner password')).toBeVisible();
  await page.getByLabel('Owner password').fill(password);
  await page.getByRole('button', { name: 'Unlock desk' }).click();
  await expect(page.getByRole('heading', { name: 'Your agenda' })).toBeVisible();
  await expect(page.getByText('No Google accounts connected.', { exact: true })).toBeVisible();
  await page.getByLabel('Time window').selectOption('4');
  await expect(page.getByLabel('Time window')).toHaveValue('4');
  await page.getByRole('button', { name: 'Research', exact: true }).click();
  await page.screenshot({ path: info.outputPath('desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Your agenda' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connected accounts' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Connect Google account/ })).toHaveAttribute('href', '/api/google/connect');
  await page.getByRole('button', { name: 'Lock desk' }).click();
  await expect(page.getByLabel('Owner password')).toBeVisible();
  expect((await page.request.get('/api/dashboard')).status()).toBe(401);
  expect(errors).toEqual([]);
});

test('controlled continuation scenario runs sequential batches and stops when scope is caught up', async ({ page }) => {
  // UI-only provider scenario; actual owner login and server rendering, simulated sync responses.
  const starts: number[] = [];
  let processed = 0;
  const progress = () => ({accounts:[{email:'fixture@example.test',processedThreads:processed,pendingThreads:processed < 2 ? 1 : 0,failedThreads:0,hasMoreMailPages:processed < 2,mailComplete:processed >= 2,calendarsDone:1,calendarsTotal:1,calendarComplete:true}],totalProcessedThreads:processed,totalPendingThreads:processed < 2 ? 1 : 0,totalFailedThreads:0,hasMore:processed < 2,canContinue:processed < 2,madeProgress:processed > 0,scopeDays:90,blockedReasons:[]});
  await page.route('**/api/status', async route => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({response,json:data.authenticated ? {...data,progress:progress()} : data});
  });
  await page.route('**/api/sync', async route => {
    starts.push(Date.now()); processed++;
    await route.fulfill({json:{ok:true,summary:'Controlled test batch '+processed,gaps:[],progress:progress()}});
  });
  await page.goto('/');
  await page.getByLabel('Owner password').fill(password);
  await page.getByRole('button',{name:'Unlock desk'}).click();
  await page.getByRole('button',{name:'Sync sources',exact:true}).click();
  await expect.poll(() => starts.length,{timeout:12000}).toBe(2);
  expect(starts[1]-starts[0]).toBeGreaterThanOrEqual(4900);
  await expect(page.getByRole('button',{name:'Sync sources',exact:true})).toBeEnabled();
  await expect(page.getByRole('button',{name:'Pause sync'})).toHaveCount(0);
  await expect(page.getByRole('region',{name:'Source sync progress'})).toContainText('2 threads processed');
});
