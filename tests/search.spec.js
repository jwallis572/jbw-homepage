import { test, expect } from '@playwright/test';
import { stubNetwork, captureWindowOpen, opened } from './helpers.js';

const SUGGESTIONS = {
  card: ['cardiac tamponade', 'cardiology', 'cardioversion energy'],
  obrien: ["o'brien <b>bold</b> test"],
};

test.beforeEach(async ({ page }) => {
  await captureWindowOpen(page);
  await stubNetwork(page, { suggest: q => ({ items: SUGGESTIONS[q] || [] }) });
  await page.goto('/');
});

const search = page => page.locator('#search');
const items = page => page.locator('#suggestions .suggestion-item');

test.describe('suggestions', () => {
  test('dropdown shows items, bolding the completion, plus a hint row', async ({ page }) => {
    await search(page).fill('card');
    await expect(items(page)).toHaveText(SUGGESTIONS.card);
    await expect(items(page).first().locator('.sg-typed')).toHaveText('card');
    await expect(items(page).first().locator('.sg-rest')).toHaveText('iac tamponade');
    expect(await items(page).first().locator('.sg-rest').evaluate(e => getComputedStyle(e).fontWeight)).toBe('600');
    await expect(page.locator('#suggestions .suggestion-hint')).toHaveText('Search Google ↵');
  });

  test('arrow keys move the highlight and Enter opens it', async ({ page }) => {
    await search(page).fill('card');
    await expect(items(page)).toHaveCount(3);
    await search(page).press('ArrowDown');
    await expect(items(page).nth(0)).toHaveClass(/active/);
    await search(page).press('ArrowDown');
    await expect(items(page).nth(1)).toHaveClass(/active/);
    await expect(items(page).nth(0)).not.toHaveClass(/active/);
    await search(page).press('ArrowUp');
    await expect(items(page).nth(0)).toHaveClass(/active/);
    await search(page).press('ArrowDown');
    await expect(items(page).nth(1)).toHaveClass(/active/);
    await search(page).press('Enter');
    expect(await opened(page)).toEqual([expect.objectContaining({
      url: 'https://www.google.com/search?q=cardiology', target: '_blank' })]);
    await expect(page.locator('#suggestions')).toBeHidden();
  });

  test('Escape closes the dropdown', async ({ page }) => {
    await search(page).fill('card');
    await expect(page.locator('#suggestions')).toBeVisible();
    await search(page).press('Escape');
    await expect(page.locator('#suggestions')).toBeHidden();
  });

  test('clicking a suggestion searches it', async ({ page }) => {
    await search(page).fill('card');
    await items(page).nth(2).click();
    expect((await opened(page))[0].url).toBe('https://www.google.com/search?q=cardioversion%20energy');
  });

  test('apostrophes and markup render as literal text', async ({ page }) => {
    await search(page).fill('obrien');
    await expect(items(page)).toHaveText(["o'brien <b>bold</b> test"]);
    await expect(page.locator('#suggestions b')).toHaveCount(0);
    await items(page).first().click();
    expect((await opened(page))[0].url).toBe(
      'https://www.google.com/search?q=' + encodeURIComponent("o'brien <b>bold</b> test"));
  });

  test('stale responses never overwrite newer ones', async ({ page }) => {
    await page.unroute('**/api/suggest?**');
    await page.route('**/api/suggest?**', async route => {
      const q = new URL(route.request().url()).searchParams.get('q');
      if (q === 'car') await new Promise(r => setTimeout(r, 800));
      await route.fulfill({ contentType: 'application/json',
        body: JSON.stringify(q === 'car' ? ['car STALE'] : ['card fresh']) }).catch(() => {});
    });
    const firstReq = page.waitForRequest(r => r.url().endsWith('q=car'));
    await search(page).fill('car');
    await firstReq;
    await search(page).fill('card');
    await expect(items(page)).toHaveText(['card fresh']);
    await page.waitForTimeout(1000);
    await expect(items(page)).toHaveText(['card fresh']);
  });
});

test.describe('search', () => {
  test('Enter with plain text opens a Google search', async ({ page }) => {
    await search(page).fill('sepsis bundle');
    await search(page).press('Enter');
    expect(await opened(page)).toEqual([expect.objectContaining({
      url: 'https://www.google.com/search?q=sepsis%20bundle', target: '_blank' })]);
  });

  test('Enter with a domain goes straight there', async ({ page }) => {
    await search(page).fill('openevidence.com');
    await search(page).press('Enter');
    expect((await opened(page))[0].url).toBe('https://openevidence.com');
  });

  test('"/" focuses the search input', async ({ page }) => {
    await page.locator('footer').click();
    await expect(search(page)).not.toBeFocused();
    await page.keyboard.press('/');
    await expect(search(page)).toBeFocused();
    await expect(search(page)).toHaveValue('');
  });

  test('"/" types normally while already in an input', async ({ page }) => {
    await search(page).fill('a');
    await search(page).press('/');
    await expect(search(page)).toHaveValue('a/');
  });
});
