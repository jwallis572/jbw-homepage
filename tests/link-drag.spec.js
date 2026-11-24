import { test, expect } from '@playwright/test';
import { stubNetwork } from './helpers.js';

// Dragging links within and between sections in edit mode, and dragging tiles (the ⠿ handle).
// /api/* is stubbed, so these never touch the real backend; the request log checks what was sent.
const LINKS = [
  { id: 'l-admin', section: 'admin', label: 'UTH VPN', url: 'https://vpn.uth.edu', icon: 'fa-solid fa-shield-halved', sort_order: 0 },
  { id: 'l-work-1', section: 'work', label: 'MD Calc', url: 'https://www.mdcalc.com', icon: 'fa-solid fa-calculator', sort_order: 0 },
  { id: 'l-work-2', section: 'work', label: 'OpenEvidence', url: 'https://www.openevidence.com', icon: 'fa-solid fa-book', sort_order: 1 },
  { id: 'l-study-1', section: 'study', label: 'Rosh Review', url: 'https://www.roshreview.com', icon: 'fa-solid fa-link', sort_order: 0 },
];
const PIN = '4821';
const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function setup(page, { linksStatus = 200 } = {}) {
  await stubNetwork(page);
  const log = { links: [], homeLoads: 0 };
  await page.route('**/api/home', route => { log.homeLoads++; return json(route, 200, { links: LINKS, settings: null }); });

  let n = 1;
  const nextToken = () => ({ token: `tok-${++n}`, exp: Date.now() + 30 * 60 * 1000 });
  await page.route('**/api/*', async route => {
    const req = route.request();
    const name = new URL(req.url()).pathname.split('/').pop();
    if (name === 'home') return route.fallback();
    const body = req.postDataJSON() || {};
    if (name === 'auth') {
      if (body.action === 'status') return json(route, 200, { configured: true, locked: false, hard: false, attemptsLeft: 5, authenticated: false });
      if (body.action === 'unlock' && body.pin === PIN) return json(route, 200, { token: 'tok-1', exp: Date.now() + 30 * 60 * 1000 });
    }
    if (name === 'links') {
      log.links.push(body);
      if (linksStatus !== 200) return json(route, linksStatus, { error: 'stale', message: 'Some links changed. Reload and try again.' });
      return json(route, 200, { ok: true, ...nextToken() });
    }
    if (name === 'settings') return json(route, 200, { ok: true, ...nextToken() });
    return route.fallback();
  });
  return log;
}

const card = (page, id) => page.locator(`.card[data-tile-id="${id}"]`);
const labels = (page, id) => card(page, id).locator('.link-item a').allTextContents();
const tileOrder = page => page.locator('#cards-grid > .card').evaluateAll(cs => cs.map(c => c.dataset.tileId));

async function open(page) {
  await page.goto('/');
  await card(page, 'work').locator('.link-item').first().waitFor();
}

async function unlock(page) {
  await page.locator('#settings-btn').click();
  await page.locator('#edit-mode-btn').click();
  await page.locator('#pin-modal .pin-box').first().focus();
  await page.keyboard.type(PIN);
  await expect(page.locator('body')).toHaveClass(/edit-mode/);
  await page.locator('#settings-close').click();
}

// Drop onto the top edge of a row (= before it) or the bottom edge (= after it).
const TOP = { x: 20, y: 2 };

test.describe('desktop', () => {
  test('a link dragged onto another section moves there and is saved with one move request', async ({ page }) => {
    const log = await setup(page);
    await open(page);
    await unlock(page);

    await card(page, 'work').locator('.link-item', { hasText: 'MD Calc' })
      .dragTo(card(page, 'study').locator('.link-item', { hasText: 'Rosh Review' }), { targetPosition: TOP });

    expect(await labels(page, 'study')).toEqual(['MD Calc', 'Rosh Review']);
    expect(await labels(page, 'work')).toEqual(['OpenEvidence']);
    await expect.poll(() => log.links.length).toBe(1);
    expect(log.links[0]).toEqual({
      action: 'move', id: 'l-work-1', from: 'work', to: 'study',
      ids: ['l-work-1', 'l-study-1'], from_ids: ['l-work-2'],
    });
  });

  test('a link can be dropped into an empty section and into the pinned Residency Admin card', async ({ page }) => {
    const log = await setup(page);
    await open(page);
    await unlock(page);
    expect(await labels(page, 'personal')).toEqual([]);

    await card(page, 'work').locator('.link-item', { hasText: 'OpenEvidence' }).dragTo(card(page, 'personal'));
    expect(await labels(page, 'personal')).toEqual(['OpenEvidence']);

    // Dropped on the header (above every row) = top of that section.
    await card(page, 'study').locator('.link-item', { hasText: 'Rosh Review' }).dragTo(card(page, 'admin').locator('.card-header'));
    expect(await labels(page, 'admin')).toEqual(['Rosh Review', 'UTH VPN']);
    expect(await labels(page, 'study')).toEqual([]);

    await expect.poll(() => log.links.length).toBe(2);
    expect(log.links[0]).toMatchObject({ action: 'move', from: 'work', to: 'personal', ids: ['l-work-2'], from_ids: ['l-work-1'] });
    expect(log.links[1]).toMatchObject({ action: 'move', from: 'study', to: 'admin', ids: ['l-study-1', 'l-admin'], from_ids: [] });
  });

  test('reordering within a section still sends a reorder, not a move', async ({ page }) => {
    const log = await setup(page);
    await open(page);
    await unlock(page);
    await card(page, 'work').locator('.link-item', { hasText: 'OpenEvidence' })
      .dragTo(card(page, 'work').locator('.link-item', { hasText: 'MD Calc' }), { targetPosition: TOP });
    expect(await labels(page, 'work')).toEqual(['OpenEvidence', 'MD Calc']);
    await expect.poll(() => log.links.length).toBe(1);
    expect(log.links[0]).toEqual({ action: 'reorder', section: 'work', ids: ['l-work-2', 'l-work-1'] });
  });

  test('if the server refuses a move, the page reloads the links instead of keeping an unsaved order', async ({ page }) => {
    const log = await setup(page, { linksStatus: 409 });
    await open(page);
    await unlock(page);
    const loadsBefore = log.homeLoads;
    await card(page, 'work').locator('.link-item', { hasText: 'MD Calc' }).dragTo(card(page, 'study'));
    await expect(page.locator('#toast')).toContainText('Some links changed');
    await expect.poll(() => log.homeLoads).toBeGreaterThan(loadsBefore);
    await expect.poll(() => labels(page, 'work')).toEqual(['MD Calc', 'OpenEvidence']);
    expect(await labels(page, 'study')).toEqual(['Rosh Review']);
  });

  test('outside edit mode, links cannot be dragged', async ({ page }) => {
    const log = await setup(page);
    await open(page);
    await card(page, 'work').locator('.link-item', { hasText: 'MD Calc' }).dragTo(card(page, 'study'));
    expect(await labels(page, 'work')).toEqual(['MD Calc', 'OpenEvidence']);
    expect(log.links).toEqual([]);
  });

  for (const editing of [false, true]) {
    test(`tile reordering with the ⠿ handle still works${editing ? ' in edit mode' : ''}`, async ({ page }) => {
      const log = await setup(page);
      await open(page);
      if (editing) await unlock(page);
      const before = await tileOrder(page);
      expect(before.indexOf('work')).toBeLessThan(before.indexOf('study'));

      await card(page, 'study').locator('.card-drag-handle').dragTo(card(page, 'work').locator('.card-header'));

      const after = await tileOrder(page);
      expect(after.indexOf('study')).toBeLessThan(after.indexOf('work'));
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('jordan_start_card_order')))).toEqual(after);
      // A tile drag is not a link move: every link stays where it was.
      expect(await labels(page, 'work')).toEqual(['MD Calc', 'OpenEvidence']);
      expect(log.links).toEqual([]);
    });
  }
});

test.describe('touch (phone)', () => {
  test.use({ hasTouch: true });

  // Real browsers send every event of a touch to the element it started on.
  async function touch(page, type, x, y) {
    return page.evaluate(({ type, x, y }) => {
      if (type === 'touchstart') window.__touchTarget = document.elementFromPoint(x, y);
      const target = window.__touchTarget;
      const t = new Touch({ identifier: 1, target, clientX: x, clientY: y });
      const ev = new TouchEvent(type, {
        bubbles: true, cancelable: true,
        touches: type === 'touchend' ? [] : [t], targetTouches: type === 'touchend' ? [] : [t], changedTouches: [t],
      });
      target.dispatchEvent(ev);
      return ev.defaultPrevented;
    }, { type, x, y });
  }
  const centre = async loc => { await loc.scrollIntoViewIfNeeded(); const b = await loc.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };

  test('dragging a link by its handle onto another section moves it', async ({ page }) => {
    const log = await setup(page);
    await open(page);
    await unlock(page);

    const from = await centre(card(page, 'work').locator('.link-item', { hasText: 'MD Calc' }).locator('.link-row-drag'));
    const rosh = await card(page, 'study').locator('.link-item', { hasText: 'Rosh Review' }).boundingBox();
    const to = { x: rosh.x + 20, y: rosh.y + rosh.height - 2 }; // lower half: after Rosh Review

    expect(await touch(page, 'touchstart', from.x, from.y)).toBe(true);
    expect(await touch(page, 'touchmove', to.x, to.y)).toBe(true);
    await touch(page, 'touchend', to.x, to.y);

    expect(await labels(page, 'study')).toEqual(['Rosh Review', 'MD Calc']);
    expect(await labels(page, 'work')).toEqual(['OpenEvidence']);
    await expect.poll(() => log.links.length).toBe(1);
    expect(log.links[0]).toMatchObject({ action: 'move', id: 'l-work-1', from: 'work', to: 'study', ids: ['l-study-1', 'l-work-1'] });
  });

  test('a touch anywhere else is left alone, so the page still scrolls', async ({ page }) => {
    const log = await setup(page);
    await open(page);
    await unlock(page);
    // On a link's text (not its handle), and on a card body: the browser keeps its default (scroll).
    for (const loc of [card(page, 'work').locator('.link-item a').first(), card(page, 'study').locator('.card-header')]) {
      const p = await centre(loc);
      expect(await touch(page, 'touchstart', p.x, p.y)).toBe(false);
      expect(await touch(page, 'touchmove', p.x, p.y + 80)).toBe(false);
      await touch(page, 'touchend', p.x, p.y + 80);
    }
    expect(await labels(page, 'work')).toEqual(['MD Calc', 'OpenEvidence']);
    expect(log.links).toEqual([]);
  });
});
