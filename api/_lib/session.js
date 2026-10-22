// Session tokens: base64url(JSON {iat, exp, sid, ep}) + '.' + base64url(HMAC-SHA256(SESSION_SECRET)).
// `ep` is auth_state.session_epoch at issue time; a PIN reset bumps the epoch and kills old tokens.
// Clients keep the token in memory only; every authenticated response returns a refreshed one,
// so the 30-minute expiry is an inactivity timeout.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, bearer } from './http.js';

export const SESSION_TTL_MS = 30 * 60 * 1000;

const sign = (body, secret) => createHmac('sha256', secret).update(body).digest('base64url');

export function issueToken({ secret, epoch, now = Date.now(), sid = randomBytes(12).toString('base64url') }) {
  const payload = { iat: now, exp: now + SESSION_TTL_MS, sid, ep: epoch };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${body}.${sign(body, secret)}`, exp: payload.exp };
}

/** Returns the payload if the signature, expiry and epoch all check out, else null. */
export function verifyToken(token, { secret, epoch, now = Date.now() }) {
  if (typeof token !== 'string') return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload.exp !== 'number' || payload.exp <= now) return null;
  if (payload.ep !== epoch) return null;
  return payload;
}

/** Same session id, fresh 30-minute window. */
export const refreshToken = (payload, { secret, epoch, now = Date.now() }) =>
  issueToken({ secret, epoch, now, sid: payload.sid });

/**
 * For authenticated endpoints: verify the bearer token against the current epoch and return
 * { session, token, exp } where token is the refreshed one to send back. Throws 401 otherwise.
 */
export async function requireSession(req, { store, secret, now = Date.now() }) {
  const state = await store.getAuthState();
  const opts = { secret, epoch: state.session_epoch, now };
  const session = verifyToken(bearer(req), opts);
  if (!session) throw new HttpError(401, 'unauthorized', 'Session expired. Enter your PIN again.');
  return { session, ...refreshToken(session, opts) };
}
