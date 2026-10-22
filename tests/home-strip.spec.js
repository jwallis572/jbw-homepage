import { test, expect } from '@playwright/test';
import { stubNetwork, FIXED_NOW, EMPTY_TIMELINE } from './helpers.js';

// The Projects timeline strip on the homepage (plan §6.2, §8). /api/home and /api/timeline are
// stubbed so this runs the same on any network.
const LINKS = [
  { id: 'a1', section: 'admin', label: 'UTH VPN', url: 'https://vpn.uth.edu', icon: 'fa-solid fa-shield-halved', sort_order: 0 },
  { id: 'w1', section: 'work', label: 'MD Calc', url: 'https://www.mdcalc.com', icon: 'fa-solid fa-calculator', sort_order: 0 },
];
const TIMELINE = {
  ...EMPTY_TIMELINE,
  counts: { active: 3, overdue: 1 },
  projects: [
    { id: 'p1', title: 'ECMO cannulation outcomes', color: '#60a5fa', status: 'Analysis', start: '2026-07-01', end: '2027-03-31', created: '2026-07-01', milestones: [{ date: '2026-11-15', done: false }] },
    { id: 'p2', title: 'Case report', color: '#2dd4bf', status: 'Writing', start: '2026-09-01', end: '2026-12-15', created: '2026-09-01', milestones: [{ date: '2026-10-15', done: false }, { date: '2026-10-01', done: true }] },
    { id: 'p3', title: 'Review article', color: '#a1a1aa', status: 'Idea', start: '2026-12-01', end: null, created: '2026-09-15', milestones: [] },
  ],
  deadlines: [{ name: 'CHEST abstract', date: '2027-03-15', kind: 'conference' }],
};

async function open(page, timeline = TIMELINE) {
  await page.clock.install({ time: FIXED_NOW });
  await stubNetwork(page, { timeline });
  await page.route('**/api/home', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ links: LINKS, settings: null }) }));
  await page.goto('/');
  await page.locator('#admin-slot .card').waitFor();
}

const strip = page => page.locator('#projects-strip');

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('sits below every card, full width, and is one link to /projects in a new tab', async ({ page }) => {
    await open(page);
    await expect(strip(page)).toHaveCSS('opacity', '1');
    const s = await strip(page).boundingBox();
    const bottoms = await page.locator('#admin-slot .card, #weather-card, #radar-card, #cards-grid > .card').evaluateAll(
      els => els.map(e => e.getBoundingClientRect().bottom + window.scrollY));
    expect(s.y + (await page.evaluate(() => window.scrollY))).toBeGreaterThan(Math.max(...bottoms));
    const grid = await page.locator('#cards-grid').boundingBox();
    expect(Math.abs(s.width - grid.width)).toBeLessThanOrEqual(2);

    expect(await strip(page).evaluate(el => el.tagName)).toBe('A');
    await expect(strip(page)).toHaveAttribute('href', '/projects');
    await expect(strip(page)).toHaveAttribute('target', '_blank');
    await expect(strip(page)).toHaveAttribute('rel', /noopener/);
    // Nothing clickable nested inside the link.
    await expect(strip(page).locator('a, button, input, [tabindex], [role="button"]')).toHaveCount(0);
  });

  test('shows the count chips and a compact timeline with no private details', async ({ page }) => {
    await open(page);
    await expect(page.locator('#strip-active')).toHaveText('3 active');
    await expect(page.locator('#strip-overdue')).toHaveText('1 overdue');
    await expect(strip(page)).toContainText('Open dashboard →');
    await expect(strip(page).locator('.tl.tl-compact')).toBeVisible();
    await expect(strip(page).locator('.tl-project')).toHaveCount(3);
    await expect(strip(page).locator('.tl-tick.major')).toHaveText(["Sep '26", 'Oct', 'Nov', 'Dec', "Jan '27", 'Feb', 'Mar', 'Apr', 'May']);
    await expect(strip(page).locator('.tl-today')).toHaveCount(3);
    await expect(strip(page).locator('.tl-label-conference')).toHaveText('CHEST abstract');
    await expect(strip(page).locator('.tl-ms-overdue')).toHaveCount(1);
    await expect(strip(page).locator('.tl-ms-done')).toHaveCount(1);
    await expect(strip(page).locator('.tl-bar-label')).toHaveCount(0); // statuses stay off the compact strip
    await expect(strip(page).locator('[title]')).toHaveCount(0);       // milestones carry no names
  });

  test('uses the window saved on the dashboard', async ({ page }) => {
    await open(page, { ...TIMELINE, window: { mode: 'fixed', months_back: 1, months_ahead: 8, fixed_start: '2027-01-01', fixed_end: '2027-03-01' } });
    await expect(strip(page).locator('.tl-tick.major')).toHaveText(["Jan '27", 'Feb', 'Mar']);
    await expect(strip(page).locator('.tl-today')).toHaveCount(0);
  });

  test('no projects shows the empty state; zero overdue hides that chip', async ({ page }) => {
    await open(page, EMPTY_TIMELINE);
    await expect(strip(page)).toContainText('No projects yet. Open dashboard to add one.');
    await expect(page.locator('#strip-active')).toHaveText('0 active');
    await expect(page.locator('#strip-overdue')).toBeHidden();
  });

  test('an API failure shows one quiet line and the rest of the page still works', async ({ page }) => {
    await open(page, { status: 502 });
    await expect(strip(page).locator('.strip-msg')).toHaveText('Projects timeline unavailable right now.');
    await expect(page.locator('#admin-slot .link-item')).toHaveCount(1);
    await expect(page.locator('.forecast-day').first()).toBeVisible();
    await expect(page.locator('#strip-active')).toBeHidden();
  });

  test('follows the tile font-size setting', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('jbw-tile-font-size', '18'));
    await open(page);
    await expect(strip(page).locator('.tl-name').nth(1)).toHaveCSS('font-size', '18px');
  });
});

test.describe('mobile 390px', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the strip scrolls inside its card without widening the page', async ({ page }) => {
    await open(page);
    await strip(page).locator('.tl').waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
