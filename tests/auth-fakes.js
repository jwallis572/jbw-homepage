// In-memory stand-ins for the auth handler's dependencies (CI has no secrets or database).
import { randomUUID } from 'node:crypto';
import { createAuthHandler } from '../api/auth.js';

export const TEST_SECRET = 'test-session-secret-0123456789abcdef0123456789abcdef';
export const TEST_PEPPER = 'test-pin-pepper-0123456789abcdef0123456789abcdef0123';

const tick = () => new Promise(r => setImmediate(r)); // let concurrent requests interleave

/** Same interface as createSupabaseStore() in api/_lib/db.js. */
export function createMemoryStore(initial = {}) {
  const auth = {
    id: 1, pin_hash: null, failed_attempts: 0, locked_until: null, lockouts_since_success: 0,
    hard_locked: false, session_epoch: 1, last_reset_email_at: null,
    updated_at: '2026-10-01T00:00:00.000Z', ...initial,
  };
  const tokens = [];
  const links = [];
  const settings = { row: null };
  // Dashboard tables (docs/sql/001): generic rows with the same defaults and constraints that matter.
  const tables = {
    categories: [], projects: [], milestones: [], deadlines: [], project_notes: [],
    timeline_prefs: [{ id: 1, mode: 'rolling', months_back: 1, months_ahead: 8, fixed_start: null, fixed_end: null }],
  };
  const sortBy = (rows, order) => {
    if (!order) return rows;
    const keys = order.split(',').map(s => s.split('.'));
    return [...rows].sort((a, b) => {
      for (const [k, dir] of keys) {
        const x = a[k] ?? '', y = b[k] ?? '';
        if (x < y) return dir === 'desc' ? 1 : -1;
        if (x > y) return dir === 'desc' ? -1 : 1;
      }
      return 0;
    });
  };
  const conflict = () => Object.assign(new Error('duplicate'), { status: 409 });
  return {
    auth, tokens, links, settings, tables,
    async listRows(table, order) { await tick(); return sortBy(tables[table], order).map(r => structuredClone(r)); },
    async insertRow(table, row) {
      await tick();
      if (table === 'categories' && tables.categories.some(c => c.name === row.name)) throw conflict();
      const full = { id: randomUUID(), created_at: new Date().toISOString(), ...(table === 'categories' && { built_in: false }), ...row };
      tables[table].push(full);
      return structuredClone(full);
    },
    async updateRow(table, id, patch) {
      await tick();
      const row = tables[table].find(r => String(r.id) === String(id));
      if (!row) return null;
      if (table === 'categories' && patch.name && tables.categories.some(c => c !== row && c.name === patch.name)) throw conflict();
      Object.assign(row, patch);
      return structuredClone(row);
    },
    async deleteRow(table, id) {
      await tick();
      const i = tables[table].findIndex(r => String(r.id) === String(id));
      if (i < 0) return false;
      tables[table].splice(i, 1);
      if (table === 'projects') { // on delete cascade
        tables.milestones = tables.milestones.filter(m => m.project_id !== id);
        tables.project_notes = tables.project_notes.filter(n => n.project_id !== id);
      }
      return true;
    },
    async countWhere(table, column, value) { await tick(); return tables[table].filter(r => r[column] === value).length; },
    async clearWhere(table, column, value) { await tick(); tables[table].forEach(r => { if (r[column] === value) r[column] = null; }); },
    async insertLink(fields) {
      await tick();
      const row = { id: randomUUID(), ...fields };
      links.push(row);
      return { ...row };
    },
    async updateLink(id, fields) {
      await tick();
      const row = links.find(l => l.id === id);
      if (!row) return null;
      Object.assign(row, fields);
      return { ...row };
    },
    async deleteLink(id) {
      await tick();
      const i = links.findIndex(l => l.id === id);
      if (i < 0) return false;
      links.splice(i, 1);
      return true;
    },
    async setLinkOrder(section, ids) {
      await tick();
      let n = 0;
      ids.forEach((id, sort_order) => {
        const row = links.find(l => l.id === id && l.section === section);
        if (row) { row.sort_order = sort_order; n++; }
      });
      return n;
    },
    async upsertSettings(value, updated_at) {
      await tick();
      settings.row = { key: 'prefs', value, updated_at };
      return { ...settings.row };
    },
    async getAuthState() { await tick(); return { ...auth }; },
    async updateAuthState(patch, { ifUpdatedAt } = {}) {
      await tick();
      if (ifUpdatedAt && auth.updated_at !== ifUpdatedAt) return null;
      Object.assign(auth, patch);
      return { ...auth };
    },
    async insertResetToken({ token_hash, expires_at }) {
      await tick();
      tokens.push({ id: randomUUID(), token_hash, expires_at, used_at: null });
    },
    async findResetToken(token_hash) {
      await tick();
      const row = tokens.find(t => t.token_hash === token_hash);
      return row ? { ...row } : null;
    },
    async useResetToken(id, usedAt) {
      await tick();
      const row = tokens.find(t => t.id === id && !t.used_at);
      if (!row) return false;
      row.used_at = usedAt;
      return true;
    },
  };
}

export function createFakeMailer() {
  const sent = [];
  return { sent, async send(msg) { sent.push(msg); } };
}

export function fakeRes() {
  return {
    statusCode: 0, headers: {}, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b = '') { this.body = b; },
  };
}

/**
 * A handler wired to fakes plus a call(body, {token}) helper that returns { status, body, headers }.
 * The clock is a plain number tests move forward with `env.advance(ms)`.
 */
export function authEnv({ start = Date.parse('2026-10-19T15:00:00Z'), state, mailer = createFakeMailer(), appUrl = 'https://example.test' } = {}) {
  const store = createMemoryStore(state);
  const env = { store, mailer, t: start };
  env.now = () => env.t;
  env.advance = ms => { env.t += ms; };
  const handler = createAuthHandler({
    store, mailer, now: env.now, sessionSecret: TEST_SECRET, pinPepper: TEST_PEPPER,
    alertEmail: 'alerts@example.test', appUrl,
  });
  env.call = async (body, { token, method = 'POST' } = {}) => {
    const res = fakeRes();
    await handler({ method, body, headers: token ? { authorization: `Bearer ${token}` } : {} }, res);
    return { status: res.statusCode, body: JSON.parse(res.body), headers: res.headers };
  };
  /** Pull the reset token out of the most recent email's link. */
  env.lastResetToken = () => {
    const msg = mailer.sent.at(-1);
    return msg && /\/projects\?reset=([0-9a-f]{64})/.exec(msg.text)?.[1];
  };
  return env;
}
