import { test, expect } from '@playwright/test';
import { stubNetwork, waitForLinks } from './helpers.js';

const box = async loc => {
  const b = await loc.boundingBox();
  if (!b) throw new Error('element not visible');
  return b;
};

test.describe('desktop 1440px', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('admin card sits under Personal; forecast top-right with radar below it', async ({ page }) => {
    await stubNetwork(page);
    await page.goto('/');
    await waitForLinks(page);
    await expect(page.locator('#admin-slot .card')).toHaveCSS('opacity', '1');
    await expect(page.locator('#radar-card')).toHaveCSS('opacity', '1');

    const personal = await box(page.locator('#cards-grid .card[data-tile-id="personal"]'));
    const row1Bottom = Math.max(...await page.locator('#cards-grid > .card').evaluateAll(
      cards => cards.map(c => c.getBoundingClientRect().bottom)));
    const admin = await box(page.locator('#admin-slot .card'));
    const forecast = await box(page.locator('#weather-card'));
    const radar = await box(page.locator('#radar-card'));

    expect(Math.abs(admin.x - personal.x)).toBeLessThanOrEqual(2);
    expect(admin.y).toBeGreaterThan(row1Bottom);
    expect(forecast.x).toBeGreaterThanOrEqual(admin.x + admin.width);
    expect(radar.y).toBeGreaterThanOrEqual(forecast.y + forecast.height);
    expect(Math.abs(radar.x - forecast.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(radar.width - forecast.width)).toBeLessThanOrEqual(2);
    // Admin spans both rows of the right column
    expect(admin.y + admin.height).toBeGreaterThanOrEqual(radar.y + radar.height - 2);
  });

  test('radar iframe is ~420px tall', async ({ page }) => {
    await stubNetwork(page);
    await page.goto('/');
    const h = (await box(page.locator('#radar-iframe'))).height;
    expect(h).toBeGreaterThanOrEqual(400);
    expect(h).toBeLessThanOrEqual(440);
  });
});

test.describe('mobile 390px', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('stacks Admin → Forecast → Radar', async ({ page }) => {
    await stubNetwork(page);
    await page.goto('/');
    await waitForLinks(page);
    const admin = await box(page.locator('#admin-slot .card'));
    const forecast = await box(page.locator('#weather-card'));
    const radar = await box(page.locator('#radar-card'));
    expect(forecast.y).toBeGreaterThanOrEqual(admin.y + admin.height);
    expect(radar.y).toBeGreaterThanOrEqual(forecast.y + forecast.height);
  });

  test('no horizontal scroll', async ({ page }) => {
    await stubNetwork(page);
    await page.goto('/');
    await waitForLinks(page);
    await page.locator('.forecast-day').first().waitFor();
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});
