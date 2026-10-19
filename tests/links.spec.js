import { test, expect } from '@playwright/test';
import { stubNetwork, waitForLinks, ADMIN_LINKS, WORK_LINKS } from './helpers.js';

// These read the real links table in Supabase, so they check what's actually deployed.
const labels = loc => loc.locator('.link-item a').allTextContents();

test.beforeEach(async ({ page }) => {
  await stubNetwork(page);
  await page.goto('/');
  await waitForLinks(page);
});

test('Residency Admin card has its 7 links', async ({ page }) => {
  const card = page.locator('#admin-slot .card');
  await expect(card.locator('.card-title')).toHaveText('📋 Residency Admin');
  const got = await labels(card);
  expect(got).toHaveLength(ADMIN_LINKS.length);
  ADMIN_LINKS.forEach((name, i) => expect(got[i]).toContain(name));
});

test('Work card has the remaining links', async ({ page }) => {
  const got = await labels(page.locator('.card[data-tile-id="work"]'));
  expect(got).toEqual(WORK_LINKS);
});

test('every link is https and opens in a new tab', async ({ page }) => {
  const links = await page.locator('.card .link-item a').evaluateAll(as =>
    as.map(a => ({ text: a.textContent, href: a.getAttribute('href'), target: a.target, rel: a.rel })));
  expect(links.length).toBeGreaterThan(20);
  for (const l of links) {
    expect(l.href, l.text).toMatch(/^https:\/\//);
    expect(l.target, l.text).toBe('_blank');
    expect(l.rel, l.text).toContain('noopener');
  }
});

test('admin links use Font Awesome icons', async ({ page }) => {
  const icons = await page.locator('#admin-slot .link-icon').evaluateAll(is => is.map(i => i.className));
  expect(icons).toHaveLength(7);
  for (const c of icons) expect(c).toMatch(/\bfa-(solid|regular|brands)\b.*\bfa-[a-z-]+/);
});
