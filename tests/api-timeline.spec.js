import { test, expect } from '@playwright/test';
import timelineHandler, { createTimelineHandler, houstonDay } from '../api/timeline.js';
import { createMemoryStore, fakeRes } from './auth-fakes.js';
import { sampleData } from './dashboard-fakes.js';

// GET /api/timeline: public, so it must return only the tile fields (plan §6.2).
const NOW = Date.parse('2026-10-19T15:00:00Z');

function storeWith(data = sampleData()) {
  const store = createMemoryStore();
  for (const [t, rows] of Object.entries(data)) store.tables[t] = structuredClone(rows);
  return store;
}
async function get(store, method = 'GET') {
  const res = fakeRes();
  await createTimelineHandler({ store, now: () => NOW })({ method, headers: {} }, res);
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body) };
}

test('returns tile fields only, briefly cacheable', async () => {
  const res = await get(storeWith());
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('public, s-maxage=60, stale-while-revalidate=300');
  expect(Object.keys(res.body).sort()).toEqual(['counts', 'deadlines', 'projects', 'today', 'window']);
  for (const p of res.body.projects) {
    expect(Object.keys(p).sort()).toEqual(['color', 'created', 'end', 'id', 'milestones', 'start', 'status', 'title']);
    for (const m of p.milestones) expect(Object.keys(m).sort()).toEqual(['date', 'done']);
  }
  for (const d of res.body.deadlines) expect(Object.keys(d).sort()).toEqual(['date', 'kind', 'name']);
  expect(res.body.window).toEqual({ mode: 'rolling', months_back: 1, months_ahead: 8, fixed_start: null, fixed_end: null });
});

test('never leaks private fields, milestone names, archived projects or hidden deadlines', async () => {
  const json = JSON.stringify((await get(storeWith())).body);
  for (const secret of ['Follow up with statistician', 'Statistician', '1st author', 'drive.google.com', 'Consent form signed',
    'Data lock', 'Old archived thing', 'Hidden reminder', 'CHEST 2027']) {
    expect(json, secret).not.toContain(secret);
  }
  expect(json).toContain('CHEST abstract'); // a deadline that is meant to be shown
});

test('counts active projects and overdue milestones like the dashboard does', async () => {
  const { body } = await get(storeWith());
  expect(body.counts).toEqual({ active: 3, overdue: 1 });
  expect(body.today).toBe('2026-10-19');
  const p = body.projects.find(x => x.id === 'p-ecmo');
  expect(p).toMatchObject({ title: 'ECMO cannulation outcomes', color: '#60a5fa', status: 'Analysis', start: '2026-07-01', end: '2027-03-31' });
  expect(p.milestones).toEqual([{ date: '2026-08-01', done: true }, { date: '2026-11-15', done: false }]);
});

test('today is the Houston date, even when UTC has already moved on', () => {
  expect(houstonDay(Date.parse('2026-10-20T03:30:00Z'))).toBe('2026-10-19'); // 10:30pm CDT
  expect(houstonDay(Date.parse('2026-10-20T06:00:00Z'))).toBe('2026-10-20');
});

test('a Supabase failure is a quiet 502 that is not cached', async () => {
  const store = storeWith();
  store.listRows = async () => { throw new Error('down'); };
  const res = await get(store);
  expect(res.status).toBe(502);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body.error).toBe('upstream');
});

test('only GET, and the deployed handler needs its secret key', async () => {
  expect((await get(storeWith(), 'POST')).status).toBe(405);
  const saved = { ...process.env };
  delete process.env.SUPABASE_SECRET_KEY;
  try {
    const res = fakeRes();
    await timelineHandler({ method: 'GET', headers: {} }, res);
    expect(JSON.parse(res.body).error).toBe('not_configured');
  } finally {
    Object.assign(process.env, saved);
  }
});
