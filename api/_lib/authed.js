// Shared plumbing for PIN-protected write endpoints (api/links.js, api/settings.js):
// POST only, valid session token required, refreshed token returned with every success.
import { HttpError, readJson, requireMethod, sendError, sendJson } from './http.js';
import { requireSession } from './session.js';
import { createSupabaseStore } from './db.js';

/** deps: { store, sessionSecret, now }. run(body, deps) returns the response body. */
export function authedHandler(name, run, deps) {
  const { store, sessionSecret, now = Date.now } = deps;
  return async function handler(req, res) {
    try {
      requireMethod(req, 'POST');
      const { token, exp } = await requireSession(req, { store, secret: sessionSecret, now: now() });
      const body = await readJson(req);
      sendJson(res, 200, { ...(await run(body, deps)), token, exp });
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(`${name}: request failed`);
      sendError(res, err);
    }
  };
}

/** The deployed handler: builds deps from env vars on each request. */
export function fromEnv(name, create) {
  return async function handler(req, res) {
    const { SESSION_SECRET, SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
    let inner;
    try {
      if (!SESSION_SECRET || SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be set');
      inner = create({
        store: createSupabaseStore({ url: SUPABASE_URL, secretKey: SUPABASE_SECRET_KEY }),
        sessionSecret: SESSION_SECRET,
      });
    } catch (err) {
      console.error(`${name}: ${err.message}`);
      return sendJson(res, 500, { error: 'not_configured', message: 'Server is not configured.' });
    }
    return inner(req, res);
  };
}

export const bad = message => new HttpError(400, 'invalid', message);
