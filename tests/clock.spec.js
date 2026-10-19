import { test, expect } from '@playwright/test';
import { stubNetwork } from './helpers.js';

test('clock and date render real text', async ({ page }) => {
  await stubNetwork(page);
  await page.goto('/');
  await expect(page.locator('#clock')).not.toHaveText('--:--');
  await expect(page.locator('#clock')).toHaveText(/^\d{1,2}:\d{2}(:\d{2})?\s?[AP]M$/);
  await expect(page.locator('#date')).not.toHaveText('Loading...');
  await expect(page.locator('#date')).toHaveText(/^\w+day, \w+ \d{1,2}, \d{4}$/);
});
