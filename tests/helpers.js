import { readFileSync } from 'node:fs';

export const WEATHER_FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/weather.json', import.meta.url), 'utf8'));

// Monday 19 Oct 2026, 10:00 in Houston: the first day of the weather fixture.
export const FIXED_NOW = new Date('2026-10-19T10:00:00-05:00');

export const ADMIN_LINKS = [
  'Residency Tracking', 'New Innovations', 'ECMO Shift Sign-Up',
  'Residency Conference Tracker', 'Residency Program Dashboard',
  'Shift Admin Scheduling', 'UTH VPN', 'Residency Guide 26-27',
];
export const WORK_LINKS = [
  'MHH EPIC', 'LBJ EPIC', 'OpenEvidence', 'MD Calc', 'EM Houston',
  'LBJ Guidelines', 'ECMO Drive', 'FOAM Cortex',
];

/**
 * Stub the network the page talks to so tests are deterministic. The page reads links and cloud
 * settings from /api/home (our server reads Supabase), so the real links still come through and the
 * link tests check the real data; cloud settings are blanked so they can't change layout or theme.
 * The page must never contact Supabase itself, so any such request is aborted.
 */
export async function stubNetwork(page, { weather = WEATHER_FIXTURE, weatherStatus = 200, suggest, windy = false } = {}) {
  await page.route('**/*.supabase.co/**', route => route.abort());
  await page.route('**/api/home', async route => {
    const res = await route.fetch();
    if (!res.ok()) return route.fulfill({ response: res });
    await route.fulfill({ response: res, json: { ...(await res.json()), settings: null } });
  });

  await page.route('https://api.open-meteo.com/**', route =>
    weatherStatus === 200
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(weather) })
      : route.fulfill({ status: weatherStatus, contentType: 'application/json', body: '{"error":true}' }));

  if (suggest) {
    await page.route('**/api/suggest?**', async route => {
      const q = new URL(route.request().url()).searchParams.get('q');
      const { items = [], delay = 0 } = (await suggest(q)) || {};
      if (delay) await new Promise(r => setTimeout(r, delay));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items) }).catch(() => {});
    });
  }

  if (!windy) {
    await page.route('https://embed.windy.com/**', route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>radar</title>' }));
  }
}

/** Record window.open calls instead of opening real tabs. */
export async function captureWindowOpen(page) {
  await page.addInitScript(() => {
    window.__opened = [];
    window.open = (url, target, features) => { window.__opened.push({ url, target, features }); return null; };
  });
}

export const opened = page => page.evaluate(() => window.__opened);

export async function waitForLinks(page) {
  await page.locator('#admin-slot .card').waitFor();
  await page.locator('#cards-grid .card').first().waitFor();
}
