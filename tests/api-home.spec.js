import { test, expect } from '@playwright/test';
import { createHomeHandler } from '../api/home.js';
import { createReadStore } from '../api/_lib/db.js';
import { fakeRes } from './auth-fakes.js';

// Unit tests for GET /api/home and its read store, with Supabase's REST API faked (no network).
const LINKS = [{ id: 'a', section: 'admin', label: 'UTH VPN', url: 'https://vpn.uth.edu', icon: 'fa-solid fa-shield-halved', sort_order: 0 }];
const PREFS = { theme: 'dark', card_order: ['work', 'study'] };

function fakeSupabase({ status = 200, settingsRows = [{ value: PREFS }] } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (status !== 200) return new Response('{"message":"nope"}', { status });
    const body = url.includes('/links?') ? LINKS : settingsRows;
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { calls, store: createReadStore({ url: 'https://example.supabase.co/', key: 'sb_publishable_test', fetch }) };
}

async function get(store, method = 'GET') {
  const res = fakeRes();
  await createHomeHandler({ store })({ method, url: '/api/home', headers: {} }, res);
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body) };
}

test('returns links and cloud settings in one response, never cached', async () => {
  const { store, calls } = fakeSupabase();
  const res = await get(store);
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body).toEqual({ links: LINKS, settings: PREFS });

  // Reads only, with the publishable key, ordered the way the page expects.
  expect(calls.map(c => c.init.method)).toEqual(['GET', 'GET']);
  expect(calls.every(c => c.init.headers.apikey === 'sb_publishable_test')).toBe(true);
  expect(calls.map(c => c.url)).toEqual([
    'https://example.supabase.co/rest/v1/links?select=*&order=section.asc,sort_order.asc',
    'https://example.supabase.co/rest/v1/settings?key=eq.prefs&select=value',
  ]);
});

test('settings are null when there is no prefs row', async () => {
  const { store } = fakeSupabase({ settingsRows: [] });
  expect((await get(store)).body.settings).toBeNull();
});

test('a Supabase failure is a 502 with no upstream details', async () => {
  const { store } = fakeSupabase({ status: 500 });
  const res = await get(store);
  expect(res.status).toBe(502);
  expect(res.body).toEqual({ error: 'upstream', message: 'Could not load links. Try again shortly.' });
});

test('only GET is allowed', async () => {
  const { store, calls } = fakeSupabase();
  expect((await get(store, 'POST')).status).toBe(405);
  expect(calls).toHaveLength(0);
});
