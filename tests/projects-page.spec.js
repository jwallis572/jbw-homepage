import { test, expect } from '@playwright/test';
import { FIXED_NOW } from './helpers.js';
import { PIN, enterPin, openUnlocked, setupDashboard } from './dashboard-fakes.js';

// projects.html: PIN gate, session handling and the dashboard's summary (plan §6.1, §8).
test.beforeEach(async ({ page }) => { await page.clock.install({ time: FIXED_NOW }); });

test('the PIN screen shows first and nothing private loads before unlock', async ({ page }) => {
  const { log } = await setupDashboard(page);
  await page.goto('/projects');
  await expect(page.locator('#pin-screen')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();
  await expect(page.locator('#pin-title')).toHaveText('Projects');
  expect(log.filter(c => c.name === 'projects')).toEqual([]);
  expect(await page.locator('meta[name="robots"]').getAttribute('content')).toContain('noindex');
});

test('a wrong PIN shows attempts left; the right one renders the dashboard', async ({ page }) => {
  const { log } = await setupDashboard(page);
  await page.goto('/projects');
  await enterPin(page, '0000');
  await expect(page.locator('#pin-msg')).toHaveText('Incorrect. 4 attempts left.');
  await enterPin(page, PIN);
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#pin-screen')).toBeHidden();

  // Counts from the sample data (today = 19 Oct 2026).
  const kpi = key => page.locator(`.kpi[data-kpi="${key}"] .kpi-value`);
  await expect(kpi('active')).toHaveText('3');
  await expect(kpi('due')).toHaveText('3'); // Draft to PI (Nov 3), Data lock (Nov 15) and the Oct 30 reminder
  await expect(kpi('overdue')).toHaveText('1');
  await expect(kpi('waiting')).toHaveText('1');
  await expect(kpi('stale')).toHaveText('1');

  await expect(page.locator('#project-rows tr')).toHaveCount(3); // archived hidden
  await expect(page.locator('#next-list .side-item.overdue')).toContainText('Consent form signed');
  await expect(page.locator('#next-list .side-item.overdue')).toContainText('Overdue 4 days');
  await expect(page.locator('#wait-list')).toContainText('Statistician');
  await expect(page.locator('#wait-list .side-sub')).toHaveClass(/warn/); // 18 days

  const load = log.find(c => c.name === 'projects');
  expect(load.body.action).toBe('load');
  expect(load.auth).toMatch(/^Bearer /);
});

test('counts are clickable filters', async ({ page }) => {
  await openUnlocked(page);
  await page.locator('.kpi[data-kpi="overdue"]').click();
  await expect(page.locator('#project-rows tr')).toHaveCount(1);
  await expect(page.locator('#project-rows')).toContainText('Case report');
  await expect(page.locator('#chip-row')).toContainText('Overdue');
  await page.locator('#chip-row .chip').first().click();
  await expect(page.locator('#project-rows tr')).toHaveCount(3);
});

test('refreshing returns to the PIN screen', async ({ page }) => {
  await openUnlocked(page);
  await page.reload();
  await expect(page.locator('#pin-screen')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();
});

test('the Lock button clears the session immediately', async ({ page }) => {
  const { log } = await openUnlocked(page);
  await page.locator('#lock-btn').click();
  await expect(page.locator('#pin-screen')).toBeVisible();
  await expect(page.locator('#project-rows tr')).toHaveCount(0);
  await expect(page.locator('#pin-msg')).toHaveText('Locked.');
  const before = log.length;
  await page.locator('#app').evaluate(el => { el.hidden = false; });
  expect(log.length).toBe(before);
});

test('30 idle minutes lock the dashboard', async ({ page }) => {
  await openUnlocked(page);
  await page.clock.fastForward('29:00');
  await expect(page.locator('#app')).toBeVisible();
  await page.clock.fastForward('01:05');
  await expect(page.locator('#pin-screen')).toBeVisible();
  await expect(page.locator('#pin-msg')).toHaveText('Locked after 30 minutes idle.');
});

test('the token is never written to localStorage, sessionStorage or cookies', async ({ page }) => {
  const { log } = await openUnlocked(page);
  const token = log.find(c => c.name === 'projects').auth.replace('Bearer ', '');
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
  expect(stored).not.toContain(token.split('.')[0]);
  expect((await page.context().cookies()).length).toBe(0);
});

test('a server 401 locks the page', async ({ page }) => {
  const { store } = await openUnlocked(page);
  store.auth.session_epoch = 99; // as if the PIN had been reset elsewhere
  await page.locator('#new-project').click();
  await page.locator('#drawer input[name="title"]').fill('Anything');
  await page.locator('#save-project').click();
  await expect(page.locator('#pin-screen')).toBeVisible();
  await expect(page.locator('#pin-msg')).toHaveText('Session expired. Enter your PIN again.');
});

test('lockout states show on the PIN screen', async ({ page }) => {
  await setupDashboard(page, { auth: { hard_locked: true } });
  await page.goto('/projects');
  await expect(page.locator('#pin-msg')).toHaveText('Locked. Use the reset link sent to your email.');
  await expect(page.locator('#pin-boxes .pin-box').first()).toBeDisabled();
});

test('first-time setup emails a link, and the link lets you set the PIN twice', async ({ page }) => {
  const { mailer } = await setupDashboard(page, { pinSet: false });
  await page.goto('/projects');
  await expect(page.locator('#pin-title')).toHaveText('Set up PIN');
  await page.locator('#pin-forgot').click();
  await expect(page.locator('#pin-msg')).toContainText('link is on its way');
  expect(mailer.sent).toHaveLength(1);
  const link = /https:\/\/example\.test(\/projects\?reset=[0-9a-f]{64})/.exec(mailer.sent[0].text)[1];

  await page.goto(link);
  await expect(page.locator('#pin-title')).toHaveText('Set a new PIN');
  await enterPin(page, '1357');
  await expect(page.locator('#pin-sub')).toHaveText('Enter the same PIN again.');
  await enterPin(page, '1350');
  await expect(page.locator('#pin-msg')).toHaveText("Those PINs didn't match. Try again.");
  await enterPin(page, '1357');
  await expect(page.locator('#pin-sub')).toHaveText('Enter the same PIN again.');
  await enterPin(page, '1357');
  await expect(page.locator('#pin-msg')).toHaveText('PIN saved. Enter it to unlock.');
  expect(new URL(page.url()).search).toBe('');
  await enterPin(page, '1357');
  await expect(page.locator('#app')).toBeVisible();
});

test('no console errors while unlocking and opening every panel', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await openUnlocked(page);
  await page.locator('#project-rows tr').first().click();
  await page.keyboard.press('Escape');
  for (const item of ['#menu-categories', '#menu-deadlines']) {
    await page.locator('#more-btn').click();
    await page.locator(item).click();
    await page.keyboard.press('Escape');
  }
  await page.locator('#tab-list').click();
  await expect(page.locator('#timeline-row')).toBeHidden();
  await page.locator('#tab-timeline').click();
  expect(errors).toEqual([]);
});

test('works at phone width without horizontal page scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openUnlocked(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.locator('#project-rows tr').first().click();
  const drawer = await page.locator('#drawer').boundingBox();
  expect(drawer.width).toBeGreaterThanOrEqual(388);
});
