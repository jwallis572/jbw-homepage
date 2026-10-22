// Test harness for the Projects dashboard: the page's /api calls are answered by the REAL handlers
// (api/auth.js, api/projects.js, api/export.js) running in the test process on an in-memory store,
// so UI tests exercise the same validation the server does. No network, no secrets.
import { createAuthHandler } from '../api/auth.js';
import { createProjectsHandler } from '../api/projects.js';
import { createExportHandler } from '../api/export.js';
import { hashPin } from '../api/_lib/pin.js';
import { TEST_PEPPER, TEST_SECRET, createFakeMailer, createMemoryStore, fakeRes } from './auth-fakes.js';

export const PIN = '4821';
let pinHash;

export const BUILT_INS = [
  { id: 'cat-research', name: 'Research', color: '#60a5fa', pipeline: 'research', statuses: [], sort_order: 1, built_in: true },
  { id: 'cat-qi', name: 'QI', color: '#fbbf24', pipeline: 'research', statuses: [], sort_order: 2, built_in: true },
  { id: 'cat-admin', name: 'Fellowship/Admin', color: '#a78bfa', pipeline: 'simple', statuses: [], sort_order: 3, built_in: true },
  { id: 'cat-personal', name: 'Personal', color: '#2dd4bf', pipeline: 'simple', statuses: [], sort_order: 4, built_in: true },
];

const base = { role: null, mentor: null, collaborators: null, venue: null, next_action: null, waiting_on: null, waiting_since: null, links: [], notes: null, archived: false };

/** Sample data around FIXED_NOW (Mon 19 Oct 2026). */
export function sampleData() {
  return {
    categories: BUILT_INS.map(c => ({ ...c, created_at: '2026-09-01T00:00:00Z' })),
    projects: [
      { ...base, id: 'p-ecmo', category_id: 'cat-research', title: 'ECMO cannulation outcomes', status: 'Analysis', role: '1st author',
        start_date: '2026-07-01', end_date: '2027-03-31', next_action: 'Follow up with statistician',
        waiting_on: 'Statistician', waiting_since: '2026-10-01', venue: 'CHEST 2027',
        links: [{ label: 'Drive', url: 'https://drive.google.com/x' }], created_at: '2026-07-01T00:00:00Z', updated_at: '2026-10-17T12:00:00Z' },
      { ...base, id: 'p-case', category_id: 'cat-research', title: 'Case report', status: 'Writing', role: '1st author',
        start_date: '2026-09-01', end_date: '2026-12-15', next_action: 'Get consent form signed',
        created_at: '2026-09-01T00:00:00Z', updated_at: '2026-10-14T12:00:00Z' },
      { ...base, id: 'p-review', category_id: 'cat-research', title: 'Review article', status: 'Idea',
        start_date: '2026-12-01', end_date: null, next_action: 'Email mentor with topics',
        created_at: '2026-09-15T00:00:00Z', updated_at: '2026-09-28T12:00:00Z' },
      { ...base, id: 'p-old', category_id: 'cat-personal', title: 'Old archived thing', status: 'Done', archived: true,
        start_date: '2026-01-01', end_date: '2026-03-01', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-03-01T12:00:00Z' },
    ],
    milestones: [
      { id: 'm-consent', project_id: 'p-case', name: 'Consent form signed', due_date: '2026-10-15', done: false, done_at: null, created_at: '2026-09-01T00:00:00Z' },
      { id: 'm-draft', project_id: 'p-case', name: 'Draft to PI', due_date: '2026-11-03', done: false, done_at: null, created_at: '2026-09-01T00:00:00Z' },
      { id: 'm-irb', project_id: 'p-ecmo', name: 'IRB approved', due_date: '2026-08-01', done: true, done_at: '2026-08-01', created_at: '2026-07-01T00:00:00Z' },
      { id: 'm-lock', project_id: 'p-ecmo', name: 'Data lock', due_date: '2026-11-15', done: false, done_at: null, created_at: '2026-07-01T00:00:00Z' },
    ],
    deadlines: [
      { id: 'd-chest', category_id: 'cat-research', name: 'CHEST abstract', date: '2027-03-15', kind: 'conference', show_on_timeline: true, notes: null, created_at: '2026-09-01T00:00:00Z' },
      { id: 'd-hidden', category_id: null, name: 'Hidden reminder', date: '2026-10-30', kind: 'deadline', show_on_timeline: false, notes: null, created_at: '2026-09-01T00:00:00Z' },
    ],
  };
}

function toHandler(handler) {
  return async route => {
    const req = route.request();
    const res = fakeRes();
    await handler({ method: req.method(), headers: req.headers(), body: req.postDataJSON() || {} }, res);
    await route.fulfill({ status: res.statusCode, headers: { 'content-type': 'application/json', 'cache-control': res.headers['cache-control'] || 'no-store' }, body: res.body });
  };
}

/**
 * Wire a page to an in-memory backend. Returns { store, mailer, log } where log records every
 * /api request (name, body, authorization) for assertions.
 */
export async function setupDashboard(page, { data = sampleData(), pinSet = true, auth = {} } = {}) {
  pinHash ||= await hashPin(PIN, TEST_PEPPER);
  const store = createMemoryStore({ ...(pinSet && { pin_hash: pinHash }), ...auth });
  for (const [table, rows] of Object.entries(data)) store.tables[table] = structuredClone(rows);
  const mailer = createFakeMailer();
  const deps = { store, sessionSecret: TEST_SECRET };
  const handlers = {
    auth: createAuthHandler({ ...deps, mailer, pinPepper: TEST_PEPPER, alertEmail: 'alerts@example.test', appUrl: 'https://example.test' }),
    projects: createProjectsHandler(deps),
    export: createExportHandler(deps),
  };
  const log = [];
  await page.route('**/api/*', async route => {
    const req = route.request();
    const name = new URL(req.url()).pathname.split('/').pop();
    log.push({ name, body: req.postDataJSON() || {}, auth: req.headers().authorization || null });
    if (!handlers[name]) return route.fulfill({ status: 404, body: '{}' });
    return toHandler(handlers[name])(route);
  });
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  return { store, mailer, log };
}

export async function enterPin(page, pin = PIN) {
  await page.locator('#pin-boxes .pin-box').first().focus();
  await page.keyboard.type(pin);
}

export async function openUnlocked(page, opts) {
  const env = await setupDashboard(page, opts);
  await page.goto('/projects');
  await enterPin(page);
  await page.locator('#kpis .kpi').first().waitFor();
  return env;
}
