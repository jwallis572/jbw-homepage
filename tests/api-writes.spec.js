import { test, expect } from '@playwright/test';
import linksHandler, { createLinksHandler, isHttpsUrl } from '../api/links.js';
import settingsHandler, { createSettingsHandler } from '../api/settings.js';
import { issueToken, verifyToken, SESSION_TTL_MS } from '../api/_lib/session.js';
import { TEST_SECRET, createMemoryStore, fakeRes } from './auth-fakes.js';

// Unit tests for the PIN-protected write endpoints (plan §6.4): in-memory store, no network.
const NOW = Date.parse('2026-10-19T15:00:00Z');

function writeEnv({ epoch = 1 } = {}) {
  const store = createMemoryStore({ session_epoch: epoch });
  const env = { store, t: NOW };
  const deps = { store, sessionSecret: TEST_SECRET, now: () => env.t };
  const handlers = { links: createLinksHandler(deps), settings: createSettingsHandler(deps) };
  env.token = issueToken({ secret: TEST_SECRET, epoch, now: NOW }).token;
  env.call = async (name, body, { token = env.token, method = 'POST' } = {}) => {
    const res = fakeRes();
    await handlers[name]({ method, body, headers: token ? { authorization: `Bearer ${token}` } : {} }, res);
    return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers };
  };
  return env;
}

const LINK = { section: 'work', label: 'MD Calc', url: 'https://www.mdcalc.com', icon: 'fa-solid fa-calculator', sort_order: 3 };

test.describe('session required', () => {
  for (const name of ['links', 'settings']) {
    test(`${name}: no token, a bad token or an expired token gets 401`, async () => {
      const env = writeEnv();
      const body = name === 'links' ? { action: 'insert', link: LINK } : { value: { theme: 'dark' } };
      expect((await env.call(name, body, { token: null })).status).toBe(401);
      expect((await env.call(name, body, { token: `${env.token}x` })).status).toBe(401);
      env.t = NOW + SESSION_TTL_MS;
      const expired = await env.call(name, body);
      expect(expired.status).toBe(401);
      expect(expired.body.error).toBe('unauthorized');
      expect(env.store.links).toHaveLength(0);
      expect(env.store.settings.row).toBeNull();
    });

    test(`${name}: a token from before a PIN reset gets 401`, async () => {
      const env = writeEnv();
      env.store.auth.session_epoch = 2;
      const body = name === 'links' ? { action: 'insert', link: LINK } : { value: { theme: 'dark' } };
      expect((await env.call(name, body)).status).toBe(401);
    });

    test(`${name}: only POST is allowed`, async () => {
      const env = writeEnv();
      expect((await env.call(name, {}, { method: 'GET' })).status).toBe(405);
    });

    test(`${name}: the deployed handler refuses to run without its secrets`, async () => {
      const saved = { ...process.env };
      delete process.env.SESSION_SECRET;
      try {
        const res = fakeRes();
        await (name === 'links' ? linksHandler : settingsHandler)({ method: 'POST', body: {}, headers: {} }, res);
        expect(res.statusCode).toBe(500);
        expect(JSON.parse(res.body).error).toBe('not_configured');
      } finally {
        Object.assign(process.env, saved);
      }
    });
  }

  test('every success returns a refreshed token with a new 30-minute window', async () => {
    const env = writeEnv();
    env.t = NOW + 20 * 60 * 1000;
    const res = await env.call('links', { action: 'insert', link: LINK });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.exp).toBe(env.t + SESSION_TTL_MS);
    expect(verifyToken(res.body.token, { secret: TEST_SECRET, epoch: 1, now: NOW + 40 * 60 * 1000 })).toBeTruthy();
  });
});

test.describe('links', () => {
  test('insert, update, reorder and delete', async () => {
    const env = writeEnv();
    const a = (await env.call('links', { action: 'insert', link: LINK })).body.link;
    const b = (await env.call('links', { action: 'insert', link: { ...LINK, label: 'EM Houston', url: 'https://emhouston.org' } })).body.link;
    expect(a).toMatchObject({ section: 'work', label: 'MD Calc', url: 'https://www.mdcalc.com', sort_order: 3 });

    const upd = await env.call('links', { action: 'update', id: a.id, link: { label: ' MDCalc ', url: 'https://mdcalc.com', icon: '' } });
    expect(upd.body.link).toMatchObject({ label: 'MDCalc', url: 'https://mdcalc.com', icon: 'fa-solid fa-link', section: 'work' });

    expect((await env.call('links', { action: 'reorder', section: 'work', ids: [b.id, a.id] })).body.ok).toBe(true);
    expect(env.store.links.find(l => l.id === b.id).sort_order).toBe(0);
    expect(env.store.links.find(l => l.id === a.id).sort_order).toBe(1);

    expect((await env.call('links', { action: 'delete', id: a.id })).body.ok).toBe(true);
    expect(env.store.links.map(l => l.id)).toEqual([b.id]);
  });

  test('only https:// URLs are accepted', async () => {
    const env = writeEnv();
    for (const url of ['javascript:alert(1)', 'http://example.com', 'data:text/html,hi', 'ftp://x.org', '', 'not a url', `https://x.org/${'a'.repeat(2000)}`]) {
      const res = await env.call('links', { action: 'insert', link: { ...LINK, url } });
      expect(res.status, url.slice(0, 30)).toBe(400);
      expect(res.body.message).toMatch(/https/);
    }
    expect(isHttpsUrl('https://openevidence.com/path?q=1')).toBe(true);
    const a = (await env.call('links', { action: 'insert', link: LINK })).body.link;
    expect((await env.call('links', { action: 'update', id: a.id, link: { label: 'x', url: 'javascript:void(0)' } })).status).toBe(400);
    expect(env.store.links[0].url).toBe('https://www.mdcalc.com');
  });

  test('rejects unknown sections, empty or long labels and odd icon classes', async () => {
    const env = writeEnv();
    const bad = [
      { ...LINK, section: 'secret' },
      { ...LINK, label: '   ' },
      { ...LINK, label: 'x'.repeat(101) },
      { ...LINK, icon: 'fa-solid" onmouseover="alert(1)' },
    ];
    for (const link of bad) expect((await env.call('links', { action: 'insert', link })).status).toBe(400);
    expect((await env.call('links', { action: 'insert' })).status).toBe(400);
    expect((await env.call('links', { action: 'nope' })).body.error).toBe('bad_action');
    expect(env.store.links).toHaveLength(0);
  });

  test('missing links are 404 and a stale reorder is 409', async () => {
    const env = writeEnv();
    const a = (await env.call('links', { action: 'insert', link: LINK })).body.link;
    const other = (await env.call('links', { action: 'insert', link: { ...LINK, section: 'study' } })).body.link;
    expect((await env.call('links', { action: 'update', id: 'gone', link: LINK })).status).toBe(404);
    expect((await env.call('links', { action: 'delete', id: 'gone' })).status).toBe(404);
    expect((await env.call('links', { action: 'reorder', section: 'work', ids: [a.id, other.id] })).status).toBe(409);
    for (const ids of ['x', [a.id, a.id], [1, 2], ['bad id!']]) {
      expect((await env.call('links', { action: 'reorder', section: 'work', ids })).status).toBe(400);
    }
  });
});

test.describe('links: move between sections', () => {
  // work: [a, b], study: [c]. Moving a into study at the top gives study [a, c] and work [b].
  async function moveEnv() {
    const env = writeEnv();
    const add = async (section, label, url, sort_order) =>
      (await env.call('links', { action: 'insert', link: { ...LINK, section, label, url, sort_order } })).body.link;
    env.a = await add('work', 'A', 'https://a.example', 0);
    env.b = await add('work', 'B', 'https://b.example', 1);
    env.c = await add('study', 'C', 'https://c.example', 0);
    env.move = (extra = {}) => env.call('links', {
      action: 'move', id: env.a.id, from: 'work', to: 'study',
      ids: [env.a.id, env.c.id], from_ids: [env.b.id], ...extra,
    });
    return env;
  }
  const byId = (env, id) => env.store.links.find(l => l.id === id);

  // The guarantee: whatever happens, every link is still there exactly once.
  function expectNoLinkLostOrDuplicated(env) {
    const ids = env.store.links.map(l => l.id).sort();
    expect(ids).toEqual([env.a.id, env.b.id, env.c.id].sort());
  }

  test('moves a link and renumbers both sections', async () => {
    const env = await moveEnv();
    const res = await env.move();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(byId(env, env.a.id)).toMatchObject({ section: 'study', sort_order: 0 });
    expect(byId(env, env.c.id)).toMatchObject({ section: 'study', sort_order: 1 });
    expect(byId(env, env.b.id)).toMatchObject({ section: 'work', sort_order: 0 });
    expectNoLinkLostOrDuplicated(env);
  });

  test('moving the last link out leaves an empty section, and an empty section can receive one', async () => {
    const env = await moveEnv();
    const res = await env.call('links', {
      action: 'move', id: env.c.id, from: 'study', to: 'admin', ids: [env.c.id], from_ids: [],
    });
    expect(res.status).toBe(200);
    expect(byId(env, env.c.id)).toMatchObject({ section: 'admin', sort_order: 0 });
    expect(env.store.links.filter(l => l.section === 'study')).toHaveLength(0);
  });

  test('writes in order: moved link, then destination, then source', async () => {
    const env = await moveEnv();
    const calls = [];
    const { moveLink, setLinkOrder } = env.store;
    env.store.moveLink = (...args) => { calls.push(`moveLink ${args[0] === env.a.id ? 'a' : '?'} ${args[1]}->${args[2].section}`); return moveLink(...args); };
    env.store.setLinkOrder = (section, ids) => { calls.push(`setLinkOrder ${section}`); return setLinkOrder(section, ids); };
    expect((await env.move()).status).toBe(200);
    expect(calls).toEqual(['moveLink a work->study', 'setLinkOrder study', 'setLinkOrder work']);
  });

  test('rejects bad input without writing anything', async () => {
    const env = await moveEnv();
    const before = JSON.stringify(env.store.links);
    const cases = [
      { to: 'work' },                                  // same section: that's a reorder
      { to: 'secret' },
      { from: 'nowhere' },
      { id: 'bad id!' },
      { ids: [env.c.id] },                             // destination order is missing the moved link
      { from_ids: [env.b.id, env.a.id] },              // source order still contains it
      { ids: [] },
      { ids: [env.a.id, env.a.id] },
      { from_ids: 'x' },
    ];
    for (const extra of cases) {
      expect((await env.move(extra)).status, JSON.stringify(extra)).toBe(400);
    }
    expect(JSON.stringify(env.store.links)).toBe(before);
  });

  test('a link that is gone or already moved is a 409 and changes nothing', async () => {
    const env = await moveEnv();
    expect((await env.move({ from: 'finance' })).status).toBe(409); // a isn't in finance
    expect(byId(env, env.a.id)).toMatchObject({ section: 'work', sort_order: 0 });
    await env.call('links', { action: 'delete', id: env.a.id });
    expect((await env.move()).status).toBe(409);
    expect(env.store.links.map(l => l.id).sort()).toEqual([env.b.id, env.c.id].sort());
  });

  // A write that fails partway: the first row of a section's renumbering succeeds, then the store
  // throws (like a dropped connection). No step may lose or duplicate a link.
  for (const failAt of ['moveLink', 'setLinkOrder destination', 'setLinkOrder source']) {
    test(`a failure during ${failAt} never loses or duplicates a link`, async () => {
      const env = await moveEnv();
      const { moveLink, setLinkOrder } = env.store;
      env.store.moveLink = async (...args) => {
        if (failAt === 'moveLink') throw new Error('connection reset');
        return moveLink(...args);
      };
      env.store.setLinkOrder = async (section, ids) => {
        const target = failAt === 'setLinkOrder destination' ? 'study' : failAt === 'setLinkOrder source' ? 'work' : null;
        if (section === target) {
          await setLinkOrder(section, ids.slice(0, 1)); // first row written...
          throw new Error('connection reset');           // ...then the rest fail
        }
        return setLinkOrder(section, ids);
      };

      const res = await env.move();
      expect(res.status).toBe(500);
      expectNoLinkLostOrDuplicated(env);
      // Each link sits in exactly one section; the moved one is wherever step 1 left it.
      expect(byId(env, env.a.id).section).toBe(failAt === 'moveLink' ? 'work' : 'study');
      expect(byId(env, env.b.id).section).toBe('work');
      expect(byId(env, env.c.id).section).toBe('study');
      for (const l of env.store.links) expect(Number.isInteger(l.sort_order)).toBe(true);
    });
  }
});

test.describe('settings', () => {
  const VALUE = {
    theme: 'dark', accent: '#3b82f6', engine: 'perplexity', show_seconds: 'true', show_weather: 'false',
    show_radar: null, card_order: ['work', 'study', 'personal', 'finance'], tile_alpha: 0.18, tile_font: 14,
  };

  test('upserts the prefs row', async () => {
    const env = writeEnv();
    const res = await env.call('settings', { value: VALUE });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(env.store.settings.row).toEqual({ key: 'prefs', value: VALUE, updated_at: new Date(NOW).toISOString() });
  });

  test('rejects unknown keys and invalid values', async () => {
    const env = writeEnv();
    const bad = [
      { ...VALUE, admin: true },
      { ...VALUE, theme: 'neon' },
      { ...VALUE, accent: 'red; background:url(x)' },
      { ...VALUE, tile_alpha: 7 },
      { ...VALUE, tile_font: '14' },
      { ...VALUE, card_order: ['<script>'] },
      { ...VALUE, show_seconds: true },
    ];
    for (const value of bad) expect((await env.call('settings', { value })).status).toBe(400);
    for (const value of [null, 'x', [1]]) expect((await env.call('settings', { value })).status).toBe(400);
    expect(env.store.settings.row).toBeNull();
  });
});
