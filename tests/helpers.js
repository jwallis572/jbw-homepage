import { readFileSync } from 'node:fs';

export const WEATHER_FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/weather.json', import.meta.url), 'utf8'));

// Monday 19 Oct 2026, 10:00 in Houston: the first day of the weather fixture.
export const FIXED_NOW = new Date('2026-10-19T10:00:00-05:00');

// The live order in Supabase (Jordan reorders these in edit mode; update this when that happens).
export const ADMIN_LINKS = [
  'Residency Guide 26-27', 'Residency Program Dashboard', 'New Innovations',
  'Residency Tracking', 'Residency Conference Tracker', 'ECMO Shift Sign-Up',
  'Shift Admin Scheduling', 'UTH VPN',
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
export const EMPTY_TIMELINE = {
  window: { mode: 'rolling', months_back: 1, months_ahead: 8, fixed_start: null, fixed_end: null },
  today: '2026-10-19', counts: { active: 0, overdue: 0 }, projects: [], deadlines: [],
};

/**
 * timeline: the /api/timeline body for the homepage strip (that endpoint needs the secret key,
 * which CI doesn't have). Pass { status } to simulate a failure.
 */
export async function stubNetwork(page, { weather = WEATHER_FIXTURE, weatherStatus = 200, suggest, windy = false, timeline = EMPTY_TIMELINE } = {}) {
  await page.route('**/*.supabase.co/**', route => route.abort());
  await page.route('**/api/timeline', route => (timeline.status
    ? route.fulfill({ status: timeline.status, contentType: 'application/json', body: '{"error":"upstream"}' })
    : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(timeline) })));
  await page.route('**/api/home', async route => {
    // A test can finish while this is still in flight; the closed page then rejects. Ignore that.
    try {
      const res = await route.fetch();
      if (!res.ok()) return await route.fulfill({ response: res });
      await route.fulfill({ response: res, json: { ...(await res.json()), settings: null } });
    } catch (err) {
      if (!/closed/i.test(String(err))) throw err;
    }
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
