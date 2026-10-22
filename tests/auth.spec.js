import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import authHandler from '../api/auth.js';
import { hashPin, verifyPin } from '../api/_lib/pin.js';
import { issueToken, refreshToken, requireSession, verifyToken, SESSION_TTL_MS } from '../api/_lib/session.js';
import { readJson } from '../api/_lib/http.js';
import { TEST_PEPPER, TEST_SECRET, authEnv, createFakeMailer, createMemoryStore, fakeRes } from './auth-fakes.js';

// Unit tests for the PIN auth backend (plan §4, §8): in-memory store, fake mailer, fake clock.
const MIN = 60 * 1000;
const PIN = '4821';
let PIN_HASH;
test.beforeAll(async () => { PIN_HASH = await hashPin(PIN, TEST_PEPPER); });

const withPin = (opts = {}) => authEnv({ ...opts, state: { pin_hash: PIN_HASH, ...opts.state } });
const unlock = (env, pin) => env.call({ action: 'unlock', pin });
async function failTimes(env, n) {
  let last;
  for (let i = 0; i < n; i++) last = await unlock(env, '0000');
  return last;
}

test.describe('unlock', () => {
  test('correct PIN returns a session token', async () => {
    const env = withPin();
    const res = await unlock(env, PIN);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.exp).toBe(env.t + SESSION_TTL_MS);
    expect(verifyToken(res.body.token, { secret: TEST_SECRET, epoch: 1, now: env.t })).toBeTruthy();
    const status = await env.call({ action: 'status' }, { token: res.body.token });
    expect(status.body).toMatchObject({ configured: true, authenticated: true, locked: false });
  });

  test('wrong PIN counts down the remaining attempts', async () => {
    const env = withPin();
    for (const left of [4, 3, 2, 1]) {
      const res = await unlock(env, '0000');
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: 'incorrect', attemptsLeft: left });
      expect(res.body.message).toBe(`Incorrect. ${left} attempts left.`);
    }
    expect(env.mailer.sent).toHaveLength(0);
  });

  test('5 wrong PINs lock with 423 and send exactly one email with a reset link', async () => {
    const env = withPin();
    const fifth = await failTimes(env, 5);
    expect(fifth.status).toBe(423);
    expect(fifth.body).toMatchObject({ error: 'locked', hard: false, minutesLeft: 15 });
    await failTimes(env, 3); // more guesses while locked: still one email
    expect(env.mailer.sent).toHaveLength(1);
    expect(env.mailer.sent[0].to).toBe('alerts@example.test');
    expect(env.lastResetToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(env.mailer.sent[0].text).toContain('https://example.test/projects?reset=');
  });

  test('while locked the PIN is not evaluated: the correct PIN still gets 423', async () => {
    const env = withPin();
    await failTimes(env, 5);
    const res = await unlock(env, PIN);
    expect(res.status).toBe(423);
    expect(res.body.token).toBeUndefined();
  });

  test('the first lockout expires on its own after 15 minutes', async () => {
    const env = withPin();
    await failTimes(env, 5);
    env.advance(15 * MIN - 1000);
    expect((await unlock(env, PIN)).status).toBe(423);
    env.advance(1000);
    expect((await unlock(env, PIN)).status).toBe(200);
  });

  test('a second lockout without a success in between is a hard lock with no expiry', async () => {
    const env = withPin();
    await failTimes(env, 5);
    env.advance(15 * MIN);
    for (const left of [4, 3, 2, 1]) expect((await unlock(env, '0000')).body.attemptsLeft).toBe(left);
    const tenth = await unlock(env, '0000');
    expect(tenth.status).toBe(423);
    expect(tenth.body).toMatchObject({ error: 'locked', hard: true });
    expect(env.mailer.sent).toHaveLength(2);
    env.advance(30 * 24 * 60 * MIN);
    const later = await unlock(env, PIN);
    expect(later.status).toBe(423);
    expect(later.body.hard).toBe(true);
  });

  test('a correct PIN resets the attempt and lockout counters', async () => {
    const env = withPin();
    await failTimes(env, 3);
    expect((await unlock(env, PIN)).status).toBe(200);
    expect((await unlock(env, '0000')).body.attemptsLeft).toBe(4);

    // After a lockout + success, the next lockout is a timed one again, not a hard lock.
    await failTimes(env, 4);
    env.advance(15 * MIN);
    expect((await unlock(env, PIN)).status).toBe(200);
    expect(env.store.auth.lockouts_since_success).toBe(0);
    const res = await failTimes(env, 5);
    expect(res.body.hard).toBe(false);
  });

  test('parallel guesses cannot evaluate more than 5 PINs', async () => {
    const env = withPin();
    const results = await Promise.all(Array.from({ length: 25 }, () => unlock(env, '0000')));
    const statuses = results.map(r => r.status);
    expect(statuses.filter(s => s === 401)).toHaveLength(4);
    expect(statuses.every(s => [401, 423, 429].includes(s))).toBe(true);
    expect(env.mailer.sent).toHaveLength(1);
    expect((await unlock(env, PIN)).status).toBe(423);
  });

  test('malformed PINs are rejected without using an attempt', async () => {
    const env = withPin();
    for (const pin of ['123', '12345', 'abcd', 1234, undefined]) {
      expect((await unlock(env, pin)).status).toBe(400);
    }
    expect((await unlock(env, '0000')).body.attemptsLeft).toBe(4);
  });

  test('unlock before a PIN is set up says so', async () => {
    const env = authEnv();
    const res = await unlock(env, '1234');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_set_up');
    const status = await env.call({ action: 'status' });
    expect(status.body).toMatchObject({ configured: false, locked: false, authenticated: false });
  });
});

test.describe('reset link', () => {
  async function lockedWithLink() {
    const env = withPin();
    await failTimes(env, 5);
    return { env, token: env.lastResetToken() };
  }

  test('sets a new PIN, clears the lock, and works only once', async () => {
    const { env, token } = await lockedWithLink();
    expect((await env.call({ action: 'reset', token, pin: '7777' })).body).toEqual({ ok: true });
    expect(env.store.auth).toMatchObject({ failed_attempts: 0, locked_until: null, lockouts_since_success: 0, hard_locked: false });
    expect((await unlock(env, '7777')).status).toBe(200);
    expect((await unlock(env, PIN)).status).toBe(401);
    const again = await env.call({ action: 'reset', token, pin: '1111' });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_link');
    expect((await unlock(env, '7777')).status).toBe(200);
  });

  test('clears a hard lock', async () => {
    const env = withPin();
    await failTimes(env, 5);
    env.advance(15 * MIN);
    await failTimes(env, 5);
    expect(env.store.auth.hard_locked).toBe(true);
    await env.call({ action: 'reset', token: env.lastResetToken(), pin: '2468' });
    expect((await unlock(env, '2468')).status).toBe(200);
  });

  test('expires after 30 minutes', async () => {
    const { env, token } = await lockedWithLink();
    env.advance(30 * MIN);
    const res = await env.call({ action: 'reset', token, pin: '7777' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_link');
  });

  test('wrong or malformed tokens are rejected', async () => {
    const { env } = await lockedWithLink();
    for (const token of [randomBytes(32).toString('hex'), 'abc', '', null, 'Z'.repeat(64)]) {
      const res = await env.call({ action: 'reset', token, pin: '7777' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_link');
    }
    expect(env.store.auth.pin_hash).toBe(PIN_HASH);
  });

  test('rejects a new PIN that is not 4 digits and leaves the link usable', async () => {
    const { env, token } = await lockedWithLink();
    expect((await env.call({ action: 'reset', token, pin: '12' })).body.error).toBe('bad_pin');
    expect((await env.call({ action: 'reset', token, pin: '1212' })).status).toBe(200);
  });

  test('increments session_epoch so existing sessions stop working', async () => {
    const env = withPin();
    const { token: session } = (await unlock(env, PIN)).body;
    await env.call({ action: 'request-reset' });
    await env.call({ action: 'reset', token: env.lastResetToken(), pin: '9999' });
    expect(env.store.auth.session_epoch).toBe(2);
    const status = await env.call({ action: 'status' }, { token: session });
    expect(status.body.authenticated).toBe(false);
    await expect(requireSession({ headers: { authorization: `Bearer ${session}` } },
      { store: env.store, secret: TEST_SECRET, now: env.t })).rejects.toMatchObject({ status: 401 });
  });
});

test.describe('request-reset', () => {
  const GENERIC = { ok: true, message: 'If configured, an email was sent.' };

  test('first-time setup emails a link that sets the PIN', async () => {
    const env = authEnv();
    const res = await env.call({ action: 'request-reset' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(GENERIC);
    expect(env.mailer.sent).toHaveLength(1);
    expect(env.mailer.sent[0].subject).toMatch(/set up/i);
    await env.call({ action: 'reset', token: env.lastResetToken(), pin: '5150' });
    expect((await unlock(env, '5150')).status).toBe(200);
  });

  test('is limited to one email per 10 minutes and always answers the same way', async () => {
    const env = withPin();
    expect((await env.call({ action: 'request-reset' })).body).toEqual(GENERIC);
    env.advance(9 * MIN);
    expect((await env.call({ action: 'request-reset' })).body).toEqual(GENERIC);
    expect(env.mailer.sent).toHaveLength(1);
    env.advance(MIN);
    await env.call({ action: 'request-reset' });
    expect(env.mailer.sent).toHaveLength(2);
  });

  test('simultaneous requests send one email', async () => {
    const env = withPin();
    await Promise.all(Array.from({ length: 10 }, () => env.call({ action: 'request-reset' })));
    expect(env.mailer.sent).toHaveLength(1);
  });

  test('sends nothing more during a timed lockout, which already emailed', async () => {
    const env = withPin();
    await failTimes(env, 5);
    env.advance(11 * MIN);
    expect((await env.call({ action: 'request-reset' })).body).toEqual(GENERIC);
    expect(env.mailer.sent).toHaveLength(1);
  });

  test('during a hard lock a fresh link is available every 10 minutes', async () => {
    const env = withPin();
    await failTimes(env, 5);
    env.advance(15 * MIN);
    await failTimes(env, 5);
    expect(env.mailer.sent).toHaveLength(2);
    await env.call({ action: 'request-reset' });
    expect(env.mailer.sent).toHaveLength(2);
    env.advance(10 * MIN);
    await env.call({ action: 'request-reset' });
    expect(env.mailer.sent).toHaveLength(3);
  });

  test('ignores any address in the request and gives the same answer when email is not configured', async () => {
    const env = withPin();
    await env.call({ action: 'request-reset', email: 'attacker@example.test', to: 'attacker@example.test' });
    expect(env.mailer.sent.map(m => m.to)).toEqual(['alerts@example.test']);

    const unconfigured = withPin({ appUrl: '' });
    expect((await unconfigured.call({ action: 'request-reset' })).body).toEqual(GENERIC);
    expect(unconfigured.mailer.sent).toHaveLength(0);
  });
});

test.describe('session tokens', () => {
  const opts = { secret: TEST_SECRET, epoch: 3, now: 1_000_000 };

  test('a tampered signature or payload is rejected', () => {
    const { token } = issueToken(opts);
    const [body, sig] = token.split('.');
    const flipped = sig.slice(0, -1) + (sig.at(-1) === 'A' ? 'B' : 'A');
    expect(verifyToken(`${body}.${flipped}`, opts)).toBeNull();
    const forged = Buffer.from(JSON.stringify({ iat: 0, exp: 9e15, sid: 'x', ep: 3 })).toString('base64url');
    expect(verifyToken(`${forged}.${sig}`, opts)).toBeNull();
    expect(verifyToken(token, { ...opts, secret: 'another-secret-another-secret-another' })).toBeNull();
    expect(verifyToken('garbage', opts)).toBeNull();
    expect(verifyToken(`${token}.extra`, opts)).toBeNull();
  });

  test('an expired token is rejected', () => {
    const { token } = issueToken(opts);
    expect(verifyToken(token, { ...opts, now: opts.now + SESSION_TTL_MS - 1 })).toBeTruthy();
    expect(verifyToken(token, { ...opts, now: opts.now + SESSION_TTL_MS })).toBeNull();
  });

  test('a token from an older epoch is rejected', () => {
    const { token } = issueToken(opts);
    expect(verifyToken(token, { ...opts, epoch: 4 })).toBeNull();
  });

  test('refreshing slides the 30-minute window and keeps the session id', () => {
    const { token } = issueToken(opts);
    const t20 = opts.now + 20 * MIN;
    const payload = verifyToken(token, { ...opts, now: t20 });
    const refreshed = refreshToken(payload, { ...opts, now: t20 });
    expect(refreshed.exp).toBe(t20 + SESSION_TTL_MS);
    const t40 = opts.now + 40 * MIN;
    expect(verifyToken(token, { ...opts, now: t40 })).toBeNull();
    expect(verifyToken(refreshed.token, { ...opts, now: t40 }).sid).toBe(payload.sid);
  });

  test('requireSession returns a refreshed token and rejects a missing one', async () => {
    const store = createMemoryStore({ session_epoch: 3 });
    const { token } = issueToken(opts);
    const t = opts.now + 10 * MIN;
    const out = await requireSession({ headers: { authorization: `Bearer ${token}` } }, { store, secret: TEST_SECRET, now: t });
    expect(out.exp).toBe(t + SESSION_TTL_MS);
    expect(out.token).not.toBe(token);
    await expect(requireSession({ headers: {} }, { store, secret: TEST_SECRET, now: t })).rejects.toMatchObject({ status: 401 });
  });
});

test.describe('PIN hashing and HTTP plumbing', () => {
  test('PIN hashes are salted scrypt and need the pepper', async () => {
    const a = await hashPin('1234', TEST_PEPPER);
    const b = await hashPin('1234', TEST_PEPPER);
    expect(a).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(await verifyPin('1234', a, TEST_PEPPER)).toBe(true);
    expect(await verifyPin('1235', a, TEST_PEPPER)).toBe(false);
    expect(await verifyPin('1234', a, 'some-other-pepper')).toBe(false);
    expect(await verifyPin('1234', 'not-a-hash', TEST_PEPPER)).toBe(false);
  });

  test('only POST is allowed and unknown actions are rejected', async () => {
    const env = withPin();
    expect((await env.call({ action: 'status' }, { method: 'GET' })).status).toBe(405);
    const bad = await env.call({ action: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('bad_action');
  });

  test('responses never include the PIN hash', async () => {
    const env = withPin();
    const bodies = [
      await env.call({ action: 'status' }), await unlock(env, PIN), await unlock(env, '0000'),
    ].map(r => JSON.stringify(r.body));
    for (const b of bodies) expect(b).not.toContain(PIN_HASH.split('$')[2]);
  });

  test('readJson parses string bodies and streamed bodies', async () => {
    expect(await readJson({ body: '{"a":1}' })).toEqual({ a: 1 });
    async function* stream() { yield Buffer.from('{"action":'); yield Buffer.from('"status"}'); }
    expect(await readJson(Object.assign(stream(), { body: undefined }))).toEqual({ action: 'status' });
    await expect(readJson({ body: '[1]' })).rejects.toMatchObject({ status: 400 });
  });

  test('the deployed handler refuses to run without its secrets', async () => {
    const saved = { ...process.env };
    delete process.env.SESSION_SECRET;
    delete process.env.PIN_PEPPER;
    try {
      const res = fakeRes();
      await authHandler({ method: 'POST', body: { action: 'status' }, headers: {} }, res);
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).error).toBe('not_configured');
    } finally {
      Object.assign(process.env, saved);
    }
  });

  test('a failing mailer does not break the lockout response', async () => {
    const mailer = createFakeMailer();
    mailer.send = async () => { throw new Error('down'); };
    const env = withPin({ mailer });
    const res = await failTimes(env, 5);
    expect(res.status).toBe(423);
  });
});
