import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FIXED_NOW } from './helpers.js';
import { PIPELINES as SERVER_PIPELINES } from '../api/projects.js';
import { openUnlocked } from './dashboard-fakes.js';

// timeline.js (plan §6.3): window maths in Node, then the controls on projects.html.
const ctx = {};
vm.runInNewContext(readFileSync(new URL('../timeline.js', import.meta.url), 'utf8'), ctx);
const T = ctx.JBWTimeline;
const day = s => T.ymd(s);
const NOW = new Date(2026, 9, 19); // FIXED_NOW's local day: Mon 19 Oct 2026

test.describe('window maths', () => {
  test('the default window is one month back to eight ahead: Sep 2026 – May 2027', () => {
    const w = T.computeWindow(T.DEFAULT_PREFS, NOW);
    expect([day(w.start), day(w.end), w.months]).toEqual(['2026-09-01', '2027-06-01', 9]);
  });

  test('presets keep the months back and change the length', () => {
    for (const [n, end] of [[3, '2026-12-01'], [6, '2027-03-01'], [12, '2027-09-01'], [24, '2028-09-01']]) {
      const w = T.computeWindow(T.presetPrefs(T.DEFAULT_PREFS, n), NOW);
      expect([day(w.start), day(w.end), w.months]).toEqual(['2026-09-01', end, n]);
    }
  });

  test('a fixed range covers its start month through its end month', () => {
    const w = T.computeWindow({ mode: 'fixed', fixed_start: '2027-01-01', fixed_end: '2027-03-01' }, NOW);
    expect([day(w.start), day(w.end), w.months]).toEqual(['2027-01-01', '2027-04-01', 3]);
  });

  test('ticks are weekly under 4 months, monthly to 18, quarterly above', () => {
    const at = n => T.ticks(T.computeWindow(T.presetPrefs(T.DEFAULT_PREFS, n), NOW));
    const three = at(3);
    expect(three.filter(t => t.major).map(t => t.label)).toEqual(["Sep '26", 'Oct', 'Nov']);
    expect(three.filter(t => !t.major).length).toBeGreaterThanOrEqual(10);
    expect(at(9).map(t => t.label)).toEqual(["Sep '26", 'Oct', 'Nov', 'Dec', "Jan '27", 'Feb', 'Mar', 'Apr', 'May']);
    expect(at(24).map(t => t.label)).toEqual(["Q3 '26", "Q4 '26", "Q1 '27", "Q2 '27", "Q3 '27", "Q4 '27", "Q1 '28", "Q2 '28", "Q3 '28"]);
  });

  test('bars clip at the window edges and open-ended projects run off the right', () => {
    const w = T.computeWindow(T.DEFAULT_PREFS, NOW);
    const early = T.layoutProject({ start: '2026-07-01', end: '2027-03-31', milestones: [] }, w, NOW).bar;
    expect(early).toMatchObject({ left: 0, clipLeft: true, clipRight: false, open: false });
    const open = T.layoutProject({ start: '2026-12-01', end: null, milestones: [] }, w, NOW).bar;
    expect(open).toMatchObject({ clipLeft: false, clipRight: true, open: true });
    expect(open.left + open.width).toBeCloseTo(100, 5);
    const outside = T.layoutProject({ start: '2027-08-01', end: '2027-09-01', milestones: [] }, w, NOW).bar;
    expect(outside).toBeNull();
  });

  test('milestones are overdue, upcoming or done, and only those in view are drawn', () => {
    const w = T.computeWindow(T.DEFAULT_PREFS, NOW);
    const { marks } = T.layoutProject({ start: '2026-09-01', end: '2026-12-01', milestones: [
      { date: '2026-10-15', done: false }, { date: '2026-11-03', done: false }, { date: '2026-10-01', done: true }, { date: '2025-01-01', done: false },
    ] }, w, NOW);
    expect(marks.map(m => m.state)).toEqual(['overdue', 'upcoming', 'done']);
  });

  test('today sits at its share of the window', () => {
    const w = T.computeWindow(T.DEFAULT_PREFS, NOW);
    // 48 days into a 273-day window
    expect(T.pct(w, NOW)).toBeCloseTo((48 / 273) * 100, 5);
  });

  test('zoom and pan produce fixed windows', () => {
    const w = T.computeWindow(T.DEFAULT_PREFS, NOW);
    const zoomed = T.computeWindow(T.zoomPrefs(w, 3), NOW);
    expect(zoomed.months).toBe(12);
    const panned = T.computeWindow(T.panPrefs(w, 2), NOW);
    expect([day(panned.start), panned.months]).toEqual(['2026-11-01', 9]);
  });

  test('the pipelines match the server', () => {
    expect(JSON.parse(JSON.stringify(T.PIPELINES))).toEqual(SERVER_PIPELINES);
  });
});

test.describe('timeline on the dashboard', () => {
  test.beforeEach(async ({ page }) => { await page.clock.install({ time: FIXED_NOW }); });
  const labels = page => page.locator('#timeline .tl-tick.major');

  test('defaults to the saved window and draws today, bars and clipping', async ({ page }) => {
    await openUnlocked(page);
    await expect(labels(page)).toHaveText(["Sep '26", 'Oct', 'Nov', 'Dec', "Jan '27", 'Feb', 'Mar', 'Apr', 'May']);
    await expect(page.locator('#timeline .tl')).toHaveAttribute('data-start', '2026-09-01');
    const todayLeft = await page.locator('#timeline .tl-today').first().evaluate(el => parseFloat(el.style.left));
    expect(todayLeft).toBeCloseTo((48 / 273) * 100, 3);
    await expect(page.locator('.tl-project[data-project-id="p-ecmo"] .tl-bar')).toHaveClass(/clip-left/);
    await expect(page.locator('.tl-project[data-project-id="p-review"] .tl-bar')).toHaveClass(/open/);
    await expect(page.locator('.tl-project[data-project-id="p-review"] .tl-title')).toContainText('STALE');
    await expect(page.locator('.tl-project[data-project-id="p-case"] .tl-ms-overdue')).toHaveCount(1);
    await expect(page.locator('.tl-project[data-project-id="p-ecmo"] .tl-ms-done')).toHaveCount(0); // Aug 1 is before the window
    await expect(page.locator('.tl-project[data-project-id="p-old"]')).toHaveCount(0); // archived
  });

  test('presets, the months-back stepper and a custom range change the columns', async ({ page }) => {
    await openUnlocked(page);
    await page.locator('[data-preset="3"]').click();
    await expect(labels(page)).toHaveText(["Sep '26", 'Oct', 'Nov']);
    await expect(page.locator('#timeline .tl-tick:not(.major)').first()).toBeVisible();
    await page.locator('[data-preset="24"]').click();
    await expect(labels(page).first()).toHaveText("Q3 '26");

    await page.locator('[data-preset="9"]').click();
    await page.getByRole('button', { name: 'More months back' }).click();
    await expect(page.locator('#back-value')).toHaveText('2');
    await expect(labels(page).first()).toHaveText("Aug '26");

    await page.locator('#range-start').fill('2027-01');
    await page.locator('#range-end').fill('2027-06');
    await page.locator('#range-apply').click();
    await expect(labels(page)).toHaveText(["Jan '27", 'Feb', 'Mar', 'Apr', 'May', 'Jun']);
    await expect(page.locator('#timeline .tl-today')).toHaveCount(0); // today is outside
    await expect(page.locator('.tl-project[data-project-id="p-ecmo"] .tl-bar')).toHaveClass(/clip-left/);
  });

  test('Save as default calls the API, and Reset goes back to the saved window', async ({ page }) => {
    const { store, log } = await openUnlocked(page);
    await expect(page.locator('#win-save')).toBeDisabled();
    await page.locator('[data-preset="12"]').click();
    await expect(page.locator('#win-controls')).toContainText('Not saved');
    await page.locator('#win-save').click();
    await expect(page.locator('#win-save')).toBeDisabled();
    const save = log.find(c => c.body.action === 'prefs.save');
    expect(save.body.prefs).toMatchObject({ mode: 'rolling', months_back: 1, months_ahead: 11 });
    expect(store.tables.timeline_prefs[0]).toMatchObject({ mode: 'rolling', months_back: 1, months_ahead: 11 });

    await page.locator('[data-preset="3"]').click();
    await expect(labels(page)).toHaveCount(3);
    await page.locator('#win-reset').click();
    await expect(labels(page)).toHaveCount(12);
  });

  test('Ctrl+scroll zooms and dragging pans', async ({ page }) => {
    await openUnlocked(page);
    const box = page.locator('#timeline .tl-scale');
    const b = await box.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + 10);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 100);
    await page.keyboard.up('Control');
    await expect(page.locator('#timeline .tl')).toHaveAttribute('data-months', '10');

    const before = await page.locator('#timeline .tl').getAttribute('data-start');
    const s = await box.boundingBox();
    await page.mouse.move(s.x + s.width * 0.6, s.y + 10);
    await page.mouse.down();
    await page.mouse.move(s.x + s.width * 0.2, s.y + 10, { steps: 8 });
    await page.mouse.up();
    const after = await page.locator('#timeline .tl').getAttribute('data-start');
    expect(after > before).toBe(true); // dragged left = later months
  });

  test('clicking a timeline row opens that project', async ({ page }) => {
    await openUnlocked(page);
    await page.locator('.tl-project[data-project-id="p-case"] .tl-name').click();
    await expect(page.locator('#drawer-title')).toHaveText('Case report');
  });
});
