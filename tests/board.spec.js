import { test, expect } from '@playwright/test';
import { FIXED_NOW } from './helpers.js';
import { openUnlocked, sampleData } from './dashboard-fakes.js';

// Board view on projects.html (plan §9 Phase 5: kanban with drag between statuses), driven against
// the real api/projects.js on an in-memory store.
test.beforeEach(async ({ page }) => { await page.clock.install({ time: FIXED_NOW }); });

const RESEARCH = ['Idea', 'IRB', 'Data Collection', 'Analysis', 'Writing', 'Submitted', 'Accepted', 'Presented', 'Published'];
const lane = (page, name) => page.locator(`.lane[data-lane="${name}"]`);
const col = (page, laneName, status) => lane(page, laneName).locator(`.col[data-status="${status}"]`);
const card = (page, id) => page.locator(`.bcard[data-project-id="${id}"]`);

async function openBoard(page, opts) {
  const env = await openUnlocked(page, opts);
  await page.locator('#tab-board').click();
  await expect(page.locator('#board-card')).toBeVisible();
  return env;
}

test('the Board tab shows one row per category in use, with that pipeline as columns', async ({ page }) => {
  await openBoard(page);
  await expect(page.locator('#tab-board')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#timeline-row')).toBeHidden();
  await expect(page.locator('#list-card')).toBeHidden();
  await expect(page.locator('.lane')).toHaveCount(1); // only Research has live projects
  await expect(lane(page, 'Research').locator('.col-head span:first-child')).toHaveText(RESEARCH);
  await expect(col(page, 'Research', 'Analysis').locator('.bcard')).toHaveText([/ECMO cannulation outcomes/]);
  await expect(col(page, 'Research', 'Writing').locator('.bcard')).toHaveText([/Case report/]);
  await expect(col(page, 'Research', 'Idea').locator('.bcard')).toHaveText([/Review article/]);
  await expect(col(page, 'Research', 'Writing').locator('.col-head span').last()).toHaveText('1');
});

test('cards show next action and the badges that matter', async ({ page }) => {
  await openBoard(page);
  await expect(card(page, 'p-case')).toContainText('Get consent form signed');
  await expect(card(page, 'p-case').locator('.badge.red')).toHaveText('1 overdue');
  await expect(card(page, 'p-case')).toContainText('Next Nov 3');
  await expect(card(page, 'p-ecmo')).toContainText('Waiting: Statistician');
  await expect(card(page, 'p-review').locator('.badge.amber')).toHaveText('Stale');
  await card(page, 'p-case').locator('.bcard-title').click();
  await expect(page.locator('#drawer-title')).toHaveText('Case report');
});

test('dragging a card to another column saves the new status and keeps every other field', async ({ page }) => {
  const { store, log } = await openBoard(page);
  // Scroll the row so both columns are in view, as you would by hand, then drag.
  await lane(page, 'Research').locator('.lane-cols').evaluate(el => {
    el.scrollLeft = el.querySelector('.col[data-status="Writing"]').offsetLeft - el.offsetLeft - 8;
  });
  await card(page, 'p-case').dragTo(col(page, 'Research', 'Submitted'));
  await expect(col(page, 'Research', 'Submitted').locator('.bcard')).toHaveText([/Case report/]);
  await expect(col(page, 'Research', 'Writing').locator('.bcard')).toHaveCount(0);
  await expect(page.locator('#toast')).toHaveText('Moved to Submitted');
  const saved = store.tables.projects.find(p => p.id === 'p-case');
  const before = sampleData().projects.find(p => p.id === 'p-case');
  expect(saved.status).toBe('Submitted');
  for (const k of ['title', 'category_id', 'role', 'start_date', 'end_date', 'next_action', 'links', 'archived']) expect(saved[k]).toEqual(before[k]);
  expect(log.filter(c => c.body.action === 'project.save')).toHaveLength(1);
});

test('the arrow buttons move one status at a time and keep focus on the card', async ({ page }) => {
  const { store } = await openBoard(page);
  const back = card(page, 'p-review').getByRole('button', { name: /is at the first status/ });
  await expect(back).toBeDisabled();
  await card(page, 'p-review').getByRole('button', { name: 'Move Review article forward to IRB' }).click();
  await expect(col(page, 'Research', 'IRB').locator('.bcard')).toHaveText([/Review article/]);
  await expect(card(page, 'p-review').getByRole('button', { name: 'Move Review article forward to Data Collection' })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); // to the back arrow
  await page.keyboard.press('Enter');
  await expect(col(page, 'Research', 'Idea').locator('.bcard')).toHaveText([/Review article/]);
  expect(store.tables.projects.find(p => p.id === 'p-review').status).toBe('Idea');
});

test("a card can't be dropped into another category's row", async ({ page }) => {
  const data = sampleData();
  data.projects.push({ ...data.projects[1], id: 'p-move', category_id: 'cat-personal', title: 'Move apartments', status: 'Active', updated_at: '2026-10-18T12:00:00Z' });
  const { store, log } = await openBoard(page, { data });
  await expect(lane(page, 'Personal').locator('.col-head span:first-child')).toHaveText(['Not started', 'Active', 'Done']);
  await lane(page, 'Research').locator('.lane-cols').evaluate(el => {
    el.scrollLeft = el.querySelector('.col[data-status="Writing"]').offsetLeft - el.offsetLeft - 8;
  });
  await page.evaluate(() => { window.__dragged = false; document.addEventListener('dragstart', () => { window.__dragged = true; }); });
  await card(page, 'p-case').dragTo(col(page, 'Personal', 'Done'));
  expect(await page.evaluate(() => window.__dragged)).toBe(true); // the drag really happened
  await expect(col(page, 'Research', 'Writing').locator('.bcard')).toHaveText([/Case report/]);
  expect(store.tables.projects.find(p => p.id === 'p-case')).toMatchObject({ category_id: 'cat-research', status: 'Writing' });
  expect(log.filter(c => c.body.action === 'project.save')).toHaveLength(0);
});

test('a failed save puts the card back and says why', async ({ page }) => {
  const { store } = await openBoard(page);
  await page.route('**/api/projects', route => (route.request().postDataJSON()?.action === 'project.save'
    ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid', message: 'Title is required.' }) })
    : route.fallback()));
  await card(page, 'p-ecmo').getByRole('button', { name: 'Move ECMO cannulation outcomes forward to Writing' }).click();
  await expect(page.locator('#toast')).toHaveText('Title is required.');
  await expect(col(page, 'Research', 'Analysis').locator('.bcard')).toHaveText([/ECMO cannulation outcomes/]);
  expect(store.tables.projects.find(p => p.id === 'p-ecmo').status).toBe('Analysis');
});

test('the category filter shows that row, and "none" categories are a plain list', async ({ page }) => {
  const data = sampleData();
  data.categories.push({ id: 'cat-life', name: 'Life events', color: '#f472b6', pipeline: 'none', statuses: [], sort_order: 5, built_in: false, created_at: '2026-09-01T00:00:00Z' });
  data.projects.push({ ...data.projects[2], id: 'p-life', category_id: 'cat-life', title: 'Move to new city', status: null });
  await openBoard(page, { data });
  await expect(lane(page, 'Life events').locator('.col-head span:first-child')).toHaveText(['No statuses']);
  await expect(card(page, 'p-life')).not.toHaveAttribute('draggable', 'true');
  await expect(card(page, 'p-life').locator('.bcard-move')).toHaveCount(0);

  await page.locator('#cat-filter').selectOption({ label: 'QI' });
  await expect(page.locator('.lane')).toHaveCount(1);
  await expect(lane(page, 'QI').locator('.col')).toHaveCount(9);
  await expect(lane(page, 'QI').locator('.bcard')).toHaveCount(0);
});

test('archived projects join the board when shown, and Lock clears it', async ({ page }) => {
  await openBoard(page);
  await page.locator('#more-btn').click();
  await page.locator('#menu-archived').click();
  await expect(col(page, 'Personal', 'Done').locator('.bcard')).toHaveText([/Old archived thing/]);
  await expect(card(page, 'p-old').locator('.badge', { hasText: 'Archived' })).toBeVisible();
  await page.locator('#lock-btn').click();
  await expect(page.locator('#board .bcard')).toHaveCount(0);
});

test('at phone width the rows scroll inside the card, not the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openBoard(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const scrolls = await lane(page, 'Research').locator('.lane-cols').evaluate(el => el.scrollWidth > el.clientWidth);
  expect(scrolls).toBe(true);
});
