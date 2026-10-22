// Vercel serverless function: POST /api/auth  { action: 'status' | 'unlock' | 'request-reset' | 'reset', ... }
// PIN unlock, lockout and the emailed reset flow (plan §4). Everything secret comes from env vars;
// tests build the handler with createAuthHandler() and an in-memory store + fake mailer.
import { createHash, randomBytes } from 'node:crypto';
import { HttpError, bearer, readJson, requireMethod, sendError, sendJson } from './_lib/http.js';
import { hashPin, isValidPin, verifyPin } from './_lib/pin.js';
import { issueToken, refreshToken, verifyToken } from './_lib/session.js';
import {
  attemptsLeft, canSendResetEmail, clearAfterReset, lockStatus, registerFailure, registerSuccess,
} from './_lib/lockout.js';
import { createSupabaseStore } from './_lib/db.js';
import { createResendMailer, resetEmail } from './_lib/mailer.js';

export const RESET_TTL_MS = 30 * 60 * 1000;
const CLAIM_RETRIES = 5;
const GENERIC_RESET = { ok: true, message: 'If configured, an email was sent.' };

const sha256 = s => createHash('sha256').update(s).digest('hex');
const iso = t => new Date(t).toISOString();
// updated_at doubles as a row version for compare-and-set, so it must always move forward.
const nextStamp = (state, t) => iso(Math.max(t, (Date.parse(state.updated_at) || 0) + 1));

function lockedError(lock) {
  return lock.hard
    ? new HttpError(423, 'locked', 'Locked. Use the reset link sent to your email.', { hard: true })
    : new HttpError(423, 'locked', `Locked for ${lock.minutesLeft} min. Check your email for a reset link.`,
      { hard: false, minutesLeft: lock.minutesLeft });
}

/**
 * deps: { store, mailer, now: () => ms, sessionSecret, pinPepper, alertEmail, appUrl }
 * mailer / alertEmail / appUrl may be missing; reset emails are then silently skipped.
 */
export function createAuthHandler(deps) {
  const { store, mailer, now = Date.now, sessionSecret, pinPepper, alertEmail, appUrl } = deps;

  async function sendResetLink(reason) {
    if (!mailer || !alertEmail || !appUrl) return;
    const token = randomBytes(32).toString('hex');
    await store.insertResetToken({ token_hash: sha256(token), expires_at: iso(now() + RESET_TTL_MS) });
    const { subject, text } = resetEmail(reason, `${appUrl}/projects?reset=${token}`);
    try {
      await mailer.send({ to: alertEmail, subject, text });
    } catch {
      console.error('auth: reset email failed to send');
    }
  }

  async function status(req) {
    const state = await store.getAuthState();
    const t = now();
    const lock = lockStatus(state, t);
    const body = {
      configured: !!state.pin_hash,
      locked: lock.locked,
      hard: lock.hard,
      ...(lock.minutesLeft && { minutesLeft: lock.minutesLeft }),
      attemptsLeft: attemptsLeft(state),
      authenticated: false,
    };
    const opts = { secret: sessionSecret, epoch: state.session_epoch, now: t };
    const session = verifyToken(bearer(req), opts);
    if (session) Object.assign(body, { authenticated: true, ...refreshToken(session, opts) });
    return body;
  }

  async function unlock({ pin }) {
    // Count the attempt *before* checking the PIN, with a compare-and-set on updated_at, so
    // parallel requests can never evaluate more than 5 guesses per lockout window.
    let state, claim;
    for (let i = 0; ; i++) {
      state = await store.getAuthState();
      const lock = lockStatus(state, now());
      if (lock.locked) throw lockedError(lock); // PIN is not evaluated while locked
      if (!isValidPin(pin)) throw new HttpError(400, 'bad_pin', 'PIN must be 4 digits.');
      if (!state.pin_hash) throw new HttpError(409, 'not_set_up', 'No PIN yet. Use "Set up PIN".');
      claim = registerFailure(state, now());
      claim.patch.updated_at = nextStamp(state, now());
      if (await store.updateAuthState(claim.patch, { ifUpdatedAt: state.updated_at })) break;
      if (i >= CLAIM_RETRIES) throw new HttpError(429, 'busy', 'Try again.');
    }

    if (await verifyPin(pin, state.pin_hash, pinPepper)) {
      await store.updateAuthState({
        ...registerSuccess(now()),
        ...(claim.hard && { hard_locked: false }),
        updated_at: nextStamp(claim.patch, now()),
      });
      return issueToken({ secret: sessionSecret, epoch: state.session_epoch, now: now() });
    }

    if (claim.lockedOut) {
      await store.updateAuthState({ last_reset_email_at: iso(now()), updated_at: nextStamp(claim.patch, now()) });
      await sendResetLink('lockout');
      throw lockedError(lockStatus({ ...state, ...claim.patch }, now()));
    }
    throw new HttpError(401, 'incorrect', `Incorrect. ${claim.attemptsLeft} attempts left.`,
      { attemptsLeft: claim.attemptsLeft });
  }

  async function requestReset() {
    const state = await store.getAuthState();
    if (!canSendResetEmail(state, now())) return GENERIC_RESET;
    // Compare-and-set so simultaneous requests send one email, not several.
    const claimed = await store.updateAuthState(
      { last_reset_email_at: iso(now()), updated_at: nextStamp(state, now()) }, { ifUpdatedAt: state.updated_at });
    if (claimed) await sendResetLink(state.pin_hash ? 'forgot' : 'setup');
    return GENERIC_RESET;
  }

  async function reset({ token, pin }) {
    const invalid = new HttpError(400, 'invalid_link', 'This reset link is invalid or has expired.');
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw invalid;
    if (!isValidPin(pin)) throw new HttpError(400, 'bad_pin', 'PIN must be 4 digits.');
    const row = await store.findResetToken(sha256(token));
    if (!row || row.used_at || Date.parse(row.expires_at) <= now()) throw invalid;
    if (!(await store.useResetToken(row.id, iso(now())))) throw invalid;
    const pin_hash = await hashPin(pin, pinPepper);
    const state = await store.getAuthState();
    await store.updateAuthState({ pin_hash, ...clearAfterReset(state, now()), updated_at: nextStamp(state, now()) });
    return { ok: true };
  }

  const actions = { status, unlock, 'request-reset': requestReset, reset };

  return async function handler(req, res) {
    try {
      requireMethod(req, 'POST');
      const body = await readJson(req);
      const action = actions[body.action];
      if (!action) throw new HttpError(400, 'bad_action', 'Unknown action.');
      sendJson(res, 200, await action(action === status ? req : body));
    } catch (err) {
      if (!(err instanceof HttpError)) console.error('auth: request failed');
      sendError(res, err);
    }
  };
}

function depsFromEnv(env) {
  const { SESSION_SECRET, PIN_PEPPER } = env;
  if (!SESSION_SECRET || SESSION_SECRET.length < 32 || !PIN_PEPPER || PIN_PEPPER.length < 32) {
    throw new Error('SESSION_SECRET and PIN_PEPPER must be set (64 hex chars each)');
  }
  return {
    store: createSupabaseStore({ url: env.SUPABASE_URL, secretKey: env.SUPABASE_SECRET_KEY }),
    mailer: env.RESEND_API_KEY && env.RESET_FROM_EMAIL
      ? createResendMailer({ apiKey: env.RESEND_API_KEY, from: env.RESET_FROM_EMAIL })
      : null,
    sessionSecret: SESSION_SECRET,
    pinPepper: PIN_PEPPER,
    alertEmail: env.ALERT_EMAIL,
    appUrl: (env.APP_URL || (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : '')).replace(/\/$/, ''),
  };
}

export default async function handler(req, res) {
  let deps;
  try {
    deps = depsFromEnv(process.env);
  } catch (err) {
    console.error(`auth: ${err.message}`);
    return sendJson(res, 500, { error: 'not_configured', message: 'Server is not configured.' });
  }
  return createAuthHandler(deps)(req, res);
}
