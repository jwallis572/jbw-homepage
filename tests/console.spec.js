import { test, expect } from '@playwright/test';
import { stubNetwork, waitForLinks } from './helpers.js';

// Third-party noise we tolerate: messages caused by the real Windy radar iframe.
const IGNORED = [
  /windy\.com/i,
];

test('no console errors on page load', async ({ page }) => {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location().url}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  await stubNetwork(page, { windy: true });
  await page.goto('/');
  await waitForLinks(page);
  await page.locator('.forecast-day').first().waitFor();
  await page.waitForTimeout(1500);
  const ignored = errors.filter(e => IGNORED.some(re => re.test(e)));
  if (ignored.length) console.log('Ignored third-party console errors:\n' + ignored.join('\n'));
  expect(errors.filter(e => !ignored.includes(e))).toEqual([]);
});
