import { test, expect } from '@playwright/test';
import { FIXED_NOW } from './helpers.js';
import { openUnlocked } from './dashboard-fakes.js';

// Editing a category's board columns from the board (rename, add, remove, reorder), against the
// real api/projects.js on an in-memory store.
test.beforeEach(async ({ page }) => { await page.clock.install({ time: FIXED_NOW }); });

const lane = (page, name) => page.locator(`.lane[data-lane="${name}"]`);
const headers = (page, name) => lane(page, name).locator('.col-head span:first-child');
const editor = page => page.locator('#modal');
const nameInput = (page, n) => editor(page).locator('#columns-list input[type="text"]').nth(n);

async function openEditor(page, laneName = 'Research') {
  const env = await openUnlocked(page);
  await page.locator('#tab-board').click();
  await lane(page, laneName).locator('[data-edit-columns]').click();
  await expect(editor(page)).toContainText(`Edit columns: ${laneName}`);
  return env;
}

test('rename a column, add one and reorder: the board and its cards follow', async ({ page }) => {
  const { store } = await openEditor(page);
  await expect(editor(page).locator('#columns-list input[type="text"]')).toHaveCount(9);
  await expect(editor(page).locator('[data-column="Writing"]')).toContainText('1 project');

  await nameInput(page, 4).fill('Drafting');
  await page.locator('#column-add').click();
  await expect(nameInput(page, 9)).toBeFocused();
  await page.keyboard.type('Revisions');
  for (let i = 0; i < 4; i++) await editor(page).getByRole('button', { name: 'Move Revisions up' }).click();
  await expect(editor(page).getByRole('button', { name: 'Move Revisions up' })).toBeFocused();
  await page.locator('#columns-save').click();

  await expect(editor(page)).toBeHidden();
  await expect(page.locator('#toast')).toHaveText('Columns saved · 1 project moved');
  await expect(headers(page, 'Research')).toHaveText(['Idea', 'IRB', 'Data Collection', 'Analysis', 'Drafting', 'Revisions', 'Submitted', 'Accepted', 'Presented', 'Published']);
  await expect(lane(page, 'Research').locator('.col[data-status="Drafting"] .bcard')).toHaveText([/Case report/]);
  expect(store.tables.categories.find(c => c.id === 'cat-research')).toMatchObject({ pipeline: 'custom' });
  expect(store.tables.projects.find(p => p.id === 'p-case').status).toBe('Drafting');

  // The drawer's status dropdown uses the new columns too.
  await lane(page, 'Research').locator('.bcard[data-project-id="p-case"] .bcard-title').click();
  await expect(page.locator('#drawer select[name="status"] option')).toHaveCount(10);
  await expect(page.locator('#drawer select[name="status"]')).toHaveValue('Drafting');
});

test('removing a column with projects asks where they go', async ({ page }) => {
  const { store } = await openEditor(page);
  await editor(page).getByRole('button', { name: 'Remove Writing' }).click();
  const pick = editor(page).locator('select[data-move-from="Writing"]');
  await expect(editor(page).locator('[data-column="Writing"]')).toContainText('Move its 1 project to');
  await expect(pick.locator('option:checked')).toHaveText('Analysis'); // nearest column before it
  await pick.selectOption({ label: 'Submitted' });
  await editor(page).getByRole('button', { name: 'Remove Accepted' }).click(); // empty: no question
  await expect(editor(page).locator('select[data-move-from="Accepted"]')).toHaveCount(0);
  await page.locator('#columns-save').click();

  await expect(headers(page, 'Research')).toHaveText(['Idea', 'IRB', 'Data Collection', 'Analysis', 'Submitted', 'Presented', 'Published']);
  await expect(lane(page, 'Research').locator('.col[data-status="Submitted"] .bcard')).toHaveText([/Case report/]);
  expect(store.tables.projects.find(p => p.id === 'p-case').status).toBe('Submitted');
});

test('Undo brings a removed column back, and Cancel changes nothing', async ({ page }) => {
  const { log } = await openEditor(page);
  await editor(page).getByRole('button', { name: 'Remove Writing' }).click();
  await editor(page).locator('[data-column="Writing"]').getByRole('button', { name: 'Undo' }).click();
  await expect(nameInput(page, 4)).toHaveValue('Writing');
  await nameInput(page, 0).fill('Something else');
  await editor(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(headers(page, 'Research').first()).toHaveText('Idea');
  expect(log.filter(c => c.body.action === 'category.statuses')).toHaveLength(0);
});

test('blank or repeated names are caught before saving', async ({ page }) => {
  const { log } = await openEditor(page);
  await nameInput(page, 1).fill('');
  await page.locator('#columns-save').click();
  await expect(page.locator('#toast')).toHaveText('Every column needs a name.');
  await nameInput(page, 1).fill('idea');
  await page.locator('#columns-save').click();
  await expect(page.locator('#toast')).toHaveText('Column names must be different.');
  expect(log.filter(c => c.body.action === 'category.statuses')).toHaveLength(0);
  await expect(editor(page)).toBeVisible();
});

test('editing Research leaves QI with the standard steps', async ({ page }) => {
  await openEditor(page);
  await nameInput(page, 0).fill('Brainstorm');
  await page.locator('#columns-save').click();
  await expect(editor(page)).toBeHidden();
  await page.locator('#cat-filter').selectOption({ label: 'QI' });
  await expect(headers(page, 'QI').first()).toHaveText('Idea');
  await page.locator('#cat-filter').selectOption({ label: 'Research' });
  await expect(headers(page, 'Research').first()).toHaveText('Brainstorm');
});

test('a "none" category can be given columns from the board', async ({ page }) => {
  const env = await openUnlocked(page);
  const { store } = env;
  store.tables.categories.push({ id: 'cat-life', name: 'Life events', color: '#f472b6', pipeline: 'none', statuses: [], sort_order: 5, built_in: false, created_at: '2026-09-01T00:00:00Z' });
  await page.locator('#lock-btn').click(); // reload data with the new category
  await page.locator('#pin-boxes .pin-box').first().focus();
  await page.keyboard.type('4821');
  await page.locator('#tab-board').click();
  await page.locator('#cat-filter').selectOption({ label: 'Life events' });
  await expect(lane(page, 'Life events').locator('[data-edit-columns]')).toHaveText('Add columns');
  await lane(page, 'Life events').locator('[data-edit-columns]').click();
  await expect(editor(page).locator('#columns-list input[type="text"]')).toHaveCount(0);
  for (const n of ['Planning', 'Doing', 'Done']) {
    await page.locator('#column-add').click();
    await page.keyboard.type(n);
  }
  await page.locator('#columns-save').click();
  await expect(headers(page, 'Life events')).toHaveText(['Planning', 'Doing', 'Done']);
  expect(store.tables.categories.find(c => c.id === 'cat-life')).toMatchObject({ pipeline: 'custom', statuses: ['Planning', 'Doing', 'Done'] });
});
