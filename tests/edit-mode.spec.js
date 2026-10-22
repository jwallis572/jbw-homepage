import { test, expect } from '@playwright/test';
import { stubNetwork, FIXED_NOW } from './helpers.js';

// Edit mode behind the PIN (plan §6.4, §8). /api/* and the links table are stubbed, so these never
// touch the real backend. The request log checks that the browser itself never writes to Supabase.
const LINKS = [
  { id: 'l-admin', section: 'admin', label: 'UTH VPN', url: 'https://vpn.uth.edu', icon: 'fa-solid fa-shield-halved', sort_order: 0 },
  { id: 'l-work-1', section: 'work', label: 'MD Calc', url: 'https://www.mdcalc.com', icon: 'fa-solid fa-calculator', sort_order: 0 },
  { id: 'l-work-2', section: 'work', label: 'OpenEvidence', url: 'https://www.openevidence.com', icon: 'fa-solid fa-book', sort_order: 1 },
];
const PIN = '4821';
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function setup(page, { status = {}, cloudSettings = null } = {}) {
  await stubNetwork(page);
  await page.route('**/rest/v1/links**', route => route.request().method() === 'GET'
    ? json(route, 200, LINKS) : json(route, 403, { message: 'browser writes are not allowed' }));
  if (cloudSettings) {
    await page.route('**/rest/v1/settings**', route => route.request().method() === 'GET'
      ? json(route, 200, { value: cloudSettings }) : json(route, 403, {}));
  }

  const log = { api: [], supabaseWrites: [] };
  page.on('request', r => {
    if (r.url().includes('/rest/v1/') && r.method() !== 'GET' && r.method() !== 'HEAD') log.supabaseWrites.push(`${r.method()} ${r.url()}`);
  });

  let n = 1;
  const nextToken = () => ({ token: `tok-${++n}`, exp: Date.now() + 30 * 60 * 1000 });
  await page.route('**/api/*', async route => {
    const req = route.request();
    const name = new URL(req.url()).pathname.split('/').pop();
    const body = req.postDataJSON() || {};
    log.api.push({ name, body, auth: req.headers().authorization || null });
    if (name === 'auth') {
      if (body.action === 'status') return json(route, 200, { configured: true, locked: false, hard: false, attemptsLeft: 5, authenticated: false, ...status });
      if (body.action === 'unlock') return body.pin === PIN
        ? json(route, 200, { token: 'tok-1', exp: Date.now() + 30 * 60 * 1000 })
        : json(route, 401, { error: 'incorrect', message: 'Incorrect. 4 attempts left.', attemptsLeft: 4 });
      if (body.action === 'request-reset') return json(route, 200, { ok: true, message: 'If configured, an email was sent.' });
    }
    if (!/^Bearer tok-\d+$/.test(req.headers().authorization || '')) return json(route, 401, { error: 'unauthorized', message: 'Session expired.' });
    if (name === 'links') {
      if (body.action === 'insert') return json(route, 200, { link: { id: `new-${n}`, ...body.link }, ...nextToken() });
      if (body.action === 'update') return json(route, 200, { link: { id: body.id, ...body.link }, ...nextToken() });
      return json(route, 200, { ok: true, ...nextToken() });
    }
    if (name === 'settings') return json(route, 200, { ok: true, ...nextToken() });
    return route.fallback();
  });
  return log;
}

async function open(page) {
  await page.goto('/');
  await page.locator('#cards-grid .card[data-tile-id="work"] .link-item').first().waitFor();
}

async function clickEdit(page) {
  if (!(await page.locator('#settings-panel.open').count())) await page.locator('#settings-btn').click();
  await page.locator('#edit-mode-btn').click();
}

async function enterPin(page, pin) {
  await page.locator('#pin-modal .pin-box').first().focus();
  await page.keyboard.type(pin);
}

async function unlock(page) {
  await clickEdit(page);
  await enterPin(page, PIN);
  await expect(page.locator('body')).toHaveClass(/edit-mode/);
  await page.locator('#settings-close').click();
}

test('Edit Links asks for the PIN first and shows wrong-PIN feedback', async ({ page }) => {
  await setup(page);
  await open(page);
  await clickEdit(page);
  await expect(page.locator('#pin-modal')).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/edit-mode/);

  await enterPin(page, '0000');
  await expect(page.locator('#pin-msg')).toHaveText('Incorrect. 4 attempts left.');
  await expect(page.locator('#pin-modal .pin-box').first()).toHaveValue('');
  await expect(page.locator('body')).not.toHaveClass(/edit-mode/);

  await enterPin(page, PIN);
  await expect(page.locator('#pin-modal')).toBeHidden();
  await expect(page.locator('body')).toHaveClass(/edit-mode/);
  await expect(page.locator('#edit-mode-btn')).toHaveText('✅ Done Editing');
});

test('link writes go to /api/links with the current bearer token, never straight to Supabase', async ({ page }) => {
  const log = await setup(page);
  await open(page);
  await unlock(page);

  const work = page.locator('#cards-grid .card[data-tile-id="work"]');
  await work.locator('.add-link-btn').click();
  await work.locator('.af-label').fill('EM Houston');
  await work.locator('.af-url').fill('https://emhouston.org');
  await work.locator('.add-link-form .btn-save').click();
  await expect(work.locator('.link-item a', { hasText: 'EM Houston' })).toHaveAttribute('href', 'https://emhouston.org');

  await work.locator('.link-item', { hasText: 'MD Calc' }).locator('.link-edit-btn').click();
  await work.locator('.ef-label').fill('MDCalc');
  await work.locator('.link-edit-inline .btn-save').click();
  await expect(work.locator('.link-item a', { hasText: 'MDCalc' })).toBeVisible();

  await work.locator('.link-item', { hasText: 'OpenEvidence' }).locator('.link-delete-btn').click();
  await expect(work.locator('.link-item', { hasText: 'OpenEvidence' })).toHaveCount(0);

  const writes = log.api.filter(c => c.name === 'links');
  expect(writes.map(c => c.body.action)).toEqual(['insert', 'update', 'delete']);
  expect(writes[0].body.link).toMatchObject({ section: 'work', label: 'EM Houston', url: 'https://emhouston.org' });
  // Each response's refreshed token is the one the next request sends.
  expect(writes.map(c => c.auth)).toEqual(['Bearer tok-1', 'Bearer tok-2', 'Bearer tok-3']);
  expect(log.supabaseWrites).toEqual([]);
});

test('the token is never stored, and Done Editing or a reload locks edit mode again', async ({ page }) => {
  await setup(page);
  await open(page);
  await unlock(page);

  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
  expect(stored).not.toContain('tok-');
  expect((await page.context().cookies()).map(c => c.value).join()).not.toContain('tok-');

  await page.locator('#settings-btn').click();
  await page.locator('#edit-mode-btn').click();
  await expect(page.locator('body')).not.toHaveClass(/edit-mode/);
  await page.locator('#edit-mode-btn').click();
  await expect(page.locator('#pin-modal')).toBeVisible();
  await page.locator('#pin-cancel').click();

  await unlock(page);
  await page.reload();
  await page.locator('#cards-grid .card').first().waitFor();
  await expect(page.locator('body')).not.toHaveClass(/edit-mode/);
});

test('a 401 from the server ends the edit session', async ({ page }) => {
  const log = await setup(page);
  await open(page);
  await unlock(page);
  await page.unroute('**/api/*');
  await page.route('**/api/*', route => json(route, 401, { error: 'unauthorized', message: 'Session expired.' }));
  const work = page.locator('#cards-grid .card[data-tile-id="work"]');
  await work.locator('.link-item', { hasText: 'OpenEvidence' }).locator('.link-delete-btn').click();
  await expect(page.locator('body')).not.toHaveClass(/edit-mode/);
  await expect(page.locator('#toast')).toContainText('Enter your PIN again');
  await expect(work.locator('.link-item', { hasText: 'OpenEvidence' })).toHaveCount(1);
  expect(log.supabaseWrites).toEqual([]);
});

test('30 idle minutes lock edit mode', async ({ page }) => {
  await page.clock.install({ time: FIXED_NOW });
  await setup(page);
  await open(page);
  await unlock(page);
  await page.clock.fastForward('29:00');
  await expect(page.locator('body')).toHaveClass(/edit-mode/);
  await page.clock.fastForward('01:05');
  await expect(page.locator('body')).not.toHaveClass(/edit-mode/);
  await expect(page.locator('#toast')).toContainText('30 minutes idle');
});

test.describe('settings sync', () => {
  test('nothing is written on load', async ({ page }) => {
    const log = await setup(page);
    await open(page);
    await page.waitForTimeout(1200); // longer than the 800ms sync debounce
    expect(log.api.filter(c => c.name === 'settings')).toEqual([]);
    expect(log.supabaseWrites).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('jordan_start_settings_pending'))).toBeNull();
  });

  test('changes while locked stay local and pending; unlocking pushes them', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('jordan_start_theme', 'dark'));
    const log = await setup(page);
    await open(page);
    await page.locator('#settings-btn').click();
    await page.locator('label:has(#dark-mode-toggle) .toggle-slider').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.waitForTimeout(1200);
    expect(log.api.filter(c => c.name === 'settings')).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('jordan_start_settings_pending'))).toBe('1');

    await page.locator('#edit-mode-btn').click();
    await enterPin(page, PIN);
    await expect.poll(() => log.api.filter(c => c.name === 'settings').length).toBe(1);
    const push = log.api.find(c => c.name === 'settings');
    expect(push.auth).toBe('Bearer tok-1');
    expect(push.body.value.theme).toBe('light');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('jordan_start_settings_pending'))).toBeNull();

    // While unlocked, a change syncs after the debounce.
    await page.locator('label:has(#dark-mode-toggle) .toggle-slider').click();
    await expect.poll(() => log.api.filter(c => c.name === 'settings').length).toBe(2);
    expect(log.api.filter(c => c.name === 'settings')[1].body.value.theme).toBe('dark');
    expect(log.supabaseWrites).toEqual([]);
  });

  test('pending local settings are not overwritten by the cloud copy on load', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('jordan_start_theme', 'light');
      localStorage.setItem('jordan_start_settings_pending', '1');
    });
    await setup(page, { cloudSettings: { theme: 'dark' } });
    await open(page);
    await page.waitForTimeout(500);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('without pending changes the cloud copy still applies on load', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('jordan_start_theme', 'light'));
    await setup(page, { cloudSettings: { theme: 'dark' } });
    await open(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test.describe('PIN modal states', () => {
  test('a locked account shows the lock message and disables the boxes', async ({ page }) => {
    await setup(page, { status: { locked: true, minutesLeft: 12 } });
    await open(page);
    await clickEdit(page);
    await expect(page.locator('#pin-msg')).toHaveText('Locked for 12 min. Check your email for a reset link.');
    await expect(page.locator('#pin-modal .pin-box').first()).toBeDisabled();
  });

  test('a hard lock says to use the emailed link', async ({ page }) => {
    await setup(page, { status: { locked: true, hard: true } });
    await open(page);
    await clickEdit(page);
    await expect(page.locator('#pin-msg')).toHaveText('Locked. Use the reset link sent to your email.');
  });

  test('no PIN yet offers Set up PIN, and Forgot PIN? requests a reset email', async ({ page }) => {
    const log = await setup(page, { status: { configured: false } });
    await open(page);
    await clickEdit(page);
    await expect(page.locator('#pin-forgot')).toHaveText('Set up PIN');
    await page.locator('#pin-forgot').click();
    await expect(page.locator('#pin-msg')).toContainText('link is on its way');
    expect(log.api.some(c => c.name === 'auth' && c.body.action === 'request-reset')).toBe(true);
  });

  test('pasting 4 digits submits, and Escape closes', async ({ page }) => {
    await setup(page);
    await open(page);
    await clickEdit(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#pin-modal')).toBeHidden();
    await page.locator('#edit-mode-btn').click();
    await page.locator('#pin-modal .pin-box').first().evaluate((el, pin) => {
      const dt = new DataTransfer();
      dt.setData('text', pin);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, PIN);
    await expect(page.locator('body')).toHaveClass(/edit-mode/);
  });
});
