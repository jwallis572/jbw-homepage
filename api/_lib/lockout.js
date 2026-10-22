// Attempt counting, lockout and hard lock (plan §4.3). Pure functions over the auth_state row;
// callers persist the returned patch through whatever store they were given.
//
// Why a hard lock: a 4-digit PIN has 10,000 combinations. If every lockout auto-expired, a stranger
// could try 5 PINs every 15 minutes (~480/day). The hard lock caps them at 10 guesses total before
// the emailed reset link is required.

export const MAX_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
export const RESET_EMAIL_INTERVAL_MS = 10 * 60 * 1000;

const ms = v => (v ? Date.parse(v) : NaN);
const iso = t => new Date(t).toISOString();

export function lockStatus(state, now) {
  if (state.hard_locked) return { locked: true, hard: true };
  const until = ms(state.locked_until);
  if (until > now) return { locked: true, hard: false, until, minutesLeft: Math.ceil((until - now) / 60000) };
  return { locked: false, hard: false };
}

export const attemptsLeft = state => Math.max(0, MAX_ATTEMPTS - (state.failed_attempts || 0));

/** A wrong PIN. Returns the patch to persist and whether this attempt triggered a lockout. */
export function registerFailure(state, now) {
  const failed = (state.failed_attempts || 0) + 1;
  if (failed < MAX_ATTEMPTS) {
    return { patch: { failed_attempts: failed, updated_at: iso(now) }, lockedOut: false, attemptsLeft: MAX_ATTEMPTS - failed };
  }
  const lockouts = (state.lockouts_since_success || 0) + 1;
  const hard = lockouts >= 2;
  const patch = {
    failed_attempts: 0,
    lockouts_since_success: lockouts,
    updated_at: iso(now),
    ...(hard ? { hard_locked: true } : { locked_until: iso(now + LOCKOUT_MS) }),
  };
  return { patch, lockedOut: true, hard, attemptsLeft: 0 };
}

/** A correct PIN clears the counters. */
export const registerSuccess = now => ({
  failed_attempts: 0, lockouts_since_success: 0, locked_until: null, updated_at: iso(now),
});

/** Everything a successful PIN reset clears, plus the epoch bump that kills old sessions. */
export const clearAfterReset = (state, now) => ({
  failed_attempts: 0, lockouts_since_success: 0, locked_until: null, hard_locked: false,
  session_epoch: (state.session_epoch || 1) + 1, updated_at: iso(now),
});

/**
 * May `request-reset` send another email right now?
 * - At most one email per 10 minutes (the lockout email counts).
 * - During a timed lockout, at most one email for that lockout: the one sent when it started.
 * - A hard lock never expires, so a fresh link stays available every 10 minutes; otherwise a
 *   missed or expired email would lock Jordan out for good.
 */
export function canSendResetEmail(state, now) {
  const last = ms(state.last_reset_email_at);
  if (last > now - RESET_EMAIL_INTERVAL_MS) return false;
  const lock = lockStatus(state, now);
  if (lock.locked && !lock.hard && last >= lock.until - LOCKOUT_MS) return false;
  return true;
}
