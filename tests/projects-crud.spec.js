import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { FIXED_NOW } from './helpers.js';
import { openUnlocked } from './dashboard-fakes.js';

// Editing in projects.html against the real api/projects.js logic (in-memory store), plan §6.1, §8.
test.beforeEach(async ({ page }) => { await page.clock.install({ time: FIXED_NOW }); });

const drawer = page => page.locator('#drawer');
const rowFor = (page, title) => page.locator('#project-rows tr', { hasText: title });

test('create a project, then add, complete and delete milestones', async ({ page }) => {
  const { store } = await openUnlocked(page);
  await page.locator('#new-project').click();
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page)).toContainText('Save the project first');
  await drawer(page).locator('input[name="title"]').fill('Sepsis QI');
  await drawer(page).locator('select[name="category_id"]').selectOption({ label: 'QI' });
  await expect(drawer(page).locator('select[name="status"] option')).toHaveCount(9);
  await drawer(page).locator('select[name="status"]').selectOption('IRB');
  await drawer(page).locator('input[name="start_date"]').fill('2026-10-01');
  await drawer(page).locator('input[name="end_date"]').fill('2027-05-31');
  await drawer(page).locator('input[name="next_action"]').fill('Finish IRB section 4');
  await page.locator('#save-project').click();

  await expect(rowFor(page, 'Sepsis QI')).toContainText('IRB');
  await expect(rowFor(page, 'Sepsis QI')).toContainText('Finish IRB section 4');
  await expect(page.locator('#drawer-title')).toHaveText('Sepsis QI');
  const created = store.tables.projects.find(p => p.title === 'Sepsis QI');
  expect(created).toMatchObject({ category_id: 'cat-qi', status: 'IRB', start_date: '2026-10-01', end_date: '2027-05-31' });
  await expect(page.locator(`.tl-project[data-project-id="${created.id}"] .tl-bar`)).toBeVisible();

  // Milestones
  await page.locator('#ms-new-name').fill('IRB submission');
  await page.locator('#ms-new-date').fill('2026-11-10');
  await page.locator('#ms-add').click();
  await expect(page.locator('#milestones .ms-row')).toHaveCount(2); // the milestone + the add row
  await expect(page.locator(`.tl-project[data-project-id="${created.id}"] .tl-ms-upcoming`)).toHaveCount(1);
  expect(store.tables.milestones.find(m => m.name === 'IRB submission')).toMatchObject({ project_id: created.id, due_date: '2026-11-10', done: false });

  await page.locator('#milestones input[type="checkbox"]').first().check();
  await expect(page.locator(`.tl-project[data-project-id="${created.id}"] .tl-ms-done`)).toHaveCount(1);
  expect(store.tables.milestones.find(m => m.name === 'IRB submission')).toMatchObject({ done: true, done_at: '2026-10-19' });

  await page.getByRole('button', { name: 'Delete milestone IRB submission' }).click();
  await expect(page.locator('#milestones .ms-row')).toHaveCount(1);
  expect(store.tables.milestones.some(m => m.name === 'IRB submission')).toBe(false);
});

test('edit, archive, restore and delete a project', async ({ page }) => {
  const { store } = await openUnlocked(page);
  await rowFor(page, 'Case report').click();
  await drawer(page).locator('input[name="next_action"]').fill('Send draft to PI');
  await page.locator('#save-project').click();
  await expect(rowFor(page, 'Case report')).toContainText('Send draft to PI');
  expect(store.tables.projects.find(p => p.id === 'p-case').next_action).toBe('Send draft to PI');

  await page.locator('#archive-btn').click();
  await expect(page.locator('#archive-btn')).toHaveText('Unarchive');
  await page.keyboard.press('Escape');
  await expect(rowFor(page, 'Case report')).toHaveCount(0);
  expect(store.tables.projects.find(p => p.id === 'p-case').archived).toBe(true);

  await page.locator('#more-btn').click();
  await page.locator('#menu-archived').click();
  await expect(rowFor(page, 'Case report')).toContainText('Archived');
  await rowFor(page, 'Case report').click();
  await page.locator('#archive-btn').click();
  await expect(page.locator('#archive-btn')).toHaveText('Archive');

  await page.locator('#delete-btn').click();
  await expect(page.locator('#modal')).toContainText('Delete “Case report”');
  await page.keyboard.press('Escape'); // Escape cancels
  expect(store.tables.projects.some(p => p.id === 'p-case')).toBe(true);
  await page.locator('#delete-btn').click();
  await page.locator('#confirm-yes').click();
  await expect(rowFor(page, 'Case report')).toHaveCount(0);
  expect(store.tables.projects.some(p => p.id === 'p-case')).toBe(false);
  expect(store.tables.milestones.some(m => m.project_id === 'p-case')).toBe(false);
});

test('a custom category with its own statuses drives the status dropdown', async ({ page }) => {
  const { store } = await openUnlocked(page);
  await page.locator('#more-btn').click();
  await page.locator('#menu-categories').click();
  await page.locator('#cat-name').fill('Grants');
  await page.locator('#cat-pipeline').selectOption('custom');
  await page.locator('#cat-statuses').fill('Drafting\nSubmitted\nFunded');
  await page.locator('#cat-save').click();
  await expect(page.locator('#modal [data-category="Grants"]')).toContainText('Custom statuses · 0 projects');
  expect(store.tables.categories.find(c => c.name === 'Grants')).toMatchObject({ pipeline: 'custom', statuses: ['Drafting', 'Submitted', 'Funded'] });

  // Duplicate names are refused with a readable message.
  await page.locator('#cat-name').fill('Grants');
  await page.locator('#cat-save').click();
  await expect(page.locator('#toast')).toHaveText('A category with that name already exists.');
  await page.keyboard.press('Escape');

  await page.locator('#new-project').click();
  await drawer(page).locator('input[name="title"]').fill('K award');
  await drawer(page).locator('select[name="category_id"]').selectOption({ label: 'Grants' });
  await expect(drawer(page).locator('select[name="status"] option')).toHaveText(['Drafting', 'Submitted', 'Funded']);
  await drawer(page).locator('select[name="status"]').selectOption('Submitted');
  await page.locator('#save-project').click();
  await expect(rowFor(page, 'K award')).toContainText('Submitted');

  // A category in use can't be deleted.
  await page.keyboard.press('Escape');
  await page.locator('#more-btn').click();
  await page.locator('#menu-categories').click();
  await expect(page.locator('#modal [data-category="Grants"] button', { hasText: 'Delete' })).toBeDisabled();
});

test('the "none" pipeline hides status, and an empty category can be deleted', async ({ page }) => {
  const { store } = await openUnlocked(page);
  await page.locator('#more-btn').click();
  await page.locator('#menu-categories').click();
  await page.locator('#cat-name').fill('Life events');
  await page.locator('#cat-pipeline').selectOption('none');
  await expect(page.locator('#cat-statuses')).toBeHidden();
  await page.locator('#cat-save').click();
  await page.keyboard.press('Escape');

  await page.locator('#new-project').click();
  await drawer(page).locator('input[name="title"]').fill('Move to new city');
  await drawer(page).locator('select[name="category_id"]').selectOption({ label: 'Life events' });
  await expect(drawer(page).locator('select[name="status"]')).toBeHidden();
  await drawer(page).locator('input[name="start_date"]').fill('2027-06-01');
  await drawer(page).locator('input[name="end_date"]').fill('2027-07-01');
  await page.locator('#save-project').click();
  await expect(rowFor(page, 'Move to new city')).toContainText('—');
  expect(store.tables.projects.find(p => p.title === 'Move to new city').status).toBeNull();

  // Delete the project, then the now-empty category.
  await page.locator('#delete-btn').click();
  await page.locator('#confirm-yes').click();
  await page.locator('#more-btn').click();
  await page.locator('#menu-categories').click();
  await page.locator('#modal [data-category="Life events"] button', { hasText: 'Delete' }).click();
  await page.locator('#confirm-yes').click();
  await expect(page.locator('#modal [data-category="Life events"]')).toHaveCount(0);
  expect(store.tables.categories.some(c => c.name === 'Life events')).toBe(false);
});

test('closing a window while its save is still in flight keeps it closed', async ({ page }) => {
  const { store } = await openUnlocked(page);
  // Slow every dashboard write down so Escape lands before the response.
  await page.route('**/api/projects', async route => {
    if (route.request().postDataJSON()?.action !== 'load') await new Promise(r => setTimeout(r, 600));
    await route.fallback();
  });
  for (const [menu, fill, save, saved] of [
    ['#menu-categories', () => page.locator('#cat-name').fill('Slow save'), '#cat-save',
      () => store.tables.categories.some(c => c.name === 'Slow save')],
    ['#menu-deadlines', async () => { await page.locator('#dl-name').fill('Slow deadline'); await page.locator('#dl-date').fill('2026-12-01'); }, '#dl-save',
      () => store.tables.deadlines.some(d => d.name === 'Slow deadline')],
  ]) {
    await page.locator('#more-btn').click();
    await page.locator(menu).click();
    await fill();
    await page.locator(save).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal')).toBeHidden();
    await expect.poll(saved).toBe(true);
    await page.waitForTimeout(100); // let the page handle the response
    await expect(page.locator('#modal')).toBeHidden();
    await expect(page.locator('#scrim')).toBeHidden();
  }
  await page.locator('#new-project').click(); // not blocked by a leftover backdrop
  await expect(page.locator('#drawer')).toBeVisible();
});

test('a conference deadline appears on the timeline; hidden ones do not', async ({ page }) => {
  const { store } = await openUnlocked(page);
  await expect(page.locator('#timeline .tl-label-conference')).toHaveText(['CHEST abstract']); // Sep 2026 – May 2027 window
  await page.locator('#more-btn').click();
  await page.locator('#menu-deadlines').click();
  await page.locator('#dl-name').fill('SCCM abstract');
  await page.locator('#dl-date').fill('2027-01-20');
  await page.locator('#dl-kind').selectOption('conference');
  await page.locator('#dl-save').click();
  await expect(page.locator('#modal [data-deadline="SCCM abstract"]')).toContainText('Conference deadline · On timeline');
  await page.keyboard.press('Escape');

  await expect(page.locator('#timeline .tl-label-conference')).toHaveText(['SCCM abstract', 'CHEST abstract']);
  await expect(page.locator('#timeline .tl-project').first().locator('.tl-mark-conference')).toHaveCount(2);
  expect(store.tables.deadlines.find(d => d.name === 'SCCM abstract')).toMatchObject({ kind: 'conference', show_on_timeline: true, date: '2027-01-20' });
  await expect(page.locator('#timeline')).not.toContainText('Hidden reminder');
  await expect(page.locator('#next-list')).toContainText('Hidden reminder'); // still listed as due soon
});

test('export downloads every table as JSON', async ({ page }) => {
  await openUnlocked(page);
  await page.locator('#more-btn').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#menu-export').click()]);
  expect(download.suggestedFilename()).toBe('projects-export-2026-10-19.json');
  const data = JSON.parse(readFileSync(await download.path(), 'utf8'));
  expect(Object.keys(data).sort()).toEqual(['categories', 'deadlines', 'exported_at', 'milestones', 'project_notes', 'projects', 'timeline_prefs']);
  expect(data.projects).toHaveLength(4); // archived included
  expect(data.milestones).toHaveLength(4);
  expect(JSON.stringify(data)).not.toContain('pin_hash');
});

test('links must be https, and typed text is never treated as HTML', async ({ page }) => {
  const { store } = await openUnlocked(page);
  await page.locator('#new-project').click();
  await drawer(page).locator('input[name="title"]').fill('<img src=x onerror="window.__pwned=1">');
  await page.getByRole('button', { name: '+ Add link' }).click();
  await drawer(page).getByLabel('Link label').fill('Drive');
  await drawer(page).getByLabel('Link URL').fill('javascript:alert(1)');
  await page.locator('#save-project').click();
  await expect(page.locator('#toast')).toHaveText('Link URLs must start with https://');
  expect(store.tables.projects.some(p => p.title.startsWith('<img'))).toBe(false);

  await drawer(page).getByLabel('Link URL').fill('https://drive.google.com/folder');
  await page.locator('#save-project').click();
  await expect(rowFor(page, '<img src=x')).toBeVisible();
  await expect(rowFor(page, '<img src=x').locator('a')).toHaveAttribute('href', 'https://drive.google.com/folder');
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  await expect(page.locator('#project-rows img')).toHaveCount(0);
});
