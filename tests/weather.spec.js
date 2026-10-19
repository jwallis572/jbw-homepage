import { test, expect } from '@playwright/test';
import { stubNetwork, FIXED_NOW } from './helpers.js';

test.use({ timezoneId: 'America/Chicago' });

test.describe('with fixture', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(FIXED_NOW);
    await stubNetwork(page);
  });

  test('requests Fahrenheit and current weather_code from Open-Meteo', async ({ page }) => {
    const req = page.waitForRequest(/api\.open-meteo\.com/);
    await page.goto('/');
    const url = new URL((await req).url());
    expect(url.searchParams.get('temperature_unit')).toBe('fahrenheit');
    expect(url.searchParams.get('current')).toContain('weather_code');
  });

  test('renders 7 tiles with correct weekday names', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.forecast-day')).toHaveCount(7);
    await expect(page.locator('.forecast-day-name'))
      .toHaveText(['Today', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  });

  test('maps WMO codes to icons', async ({ page }) => {
    await page.goto('/');
    // fixture codes: 3, 53, 81, 96, 0, 61, 45
    await expect(page.locator('.forecast-icon')).toHaveText(['☁️', '🌦️', '🌧️', '⛈️', '☀️', '🌧️', '🌫️']);
    await expect(page.locator('.forecast-icon').nth(3)).toHaveAttribute('title', 'Thunderstorm with hail');
  });

  test('shows rain chance with droplet, and a dash for null', async ({ page }) => {
    await page.goto('/');
    const rain = page.locator('.forecast-rain');
    await expect(rain.nth(0)).toHaveText('💧 40%');
    await expect(rain.nth(1)).toHaveText('💧 —');
    await expect(rain.nth(0)).toHaveAttribute('title', 'Chance of rain');
    await expect(page.locator('#weather-content')).not.toContainText('null');
  });

  test('shows current temperature and condition text', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.weather-temp')).toHaveText('78°F');
    await expect(page.locator('#weather-condition')).toHaveText('⛅ Partly cloudy');
  });
});

test('fetch failure shows "Weather unavailable" without uncaught errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await stubNetwork(page, { weatherStatus: 500 });
  await page.goto('/');
  await expect(page.locator('#weather-content')).toContainText('Weather unavailable');
  await expect(page.locator('#weather-content')).not.toContainText('--°F');
  expect(errors).toEqual([]);
});
