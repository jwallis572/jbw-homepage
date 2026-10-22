// Shared HTTP helpers for the Vercel functions. Files under api/_lib are not routes.

const MAX_BODY = 16 * 1024;

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** Send a JSON response. Private by default: everything except the public timeline is no-store. */
export function sendJson(res, status, body, { cache = 'no-store' } = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.end(JSON.stringify(body));
}

/** Error shape for every endpoint: { error: <code>, message, ...extra }. */
export function sendError(res, err) {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: err.code, message: err.message, ...err.extra });
  } else {
    sendJson(res, 500, { error: 'server_error', message: 'Something went wrong.' });
  }
}

export function requireMethod(req, ...methods) {
  if (!methods.includes(req.method)) {
    throw new HttpError(405, 'method_not_allowed', `Use ${methods.join(' or ')}.`);
  }
}

/** Parse a JSON object body. Vercel pre-parses req.body; the local test server does not. */
export async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    return parse(String(req.body));
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'too_large', 'Request body too large.');
    chunks.push(chunk);
  }
  return parse(Buffer.concat(chunks).toString('utf8'));
}

function parse(text) {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* fall through */ }
  throw new HttpError(400, 'bad_json', 'Body must be a JSON object.');
}

/** Bearer token from the Authorization header, or null. */
export function bearer(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}
