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
  return {
    auth, tokens,
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
