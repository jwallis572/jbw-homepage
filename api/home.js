// Vercel serverless function: GET /api/home -> { links: [...], settings: {...} | null }
// Everything the homepage reads, fetched server-side so the page never talks to Supabase itself
// (some networks, such as hospital Wi-Fi, block supabase.co but allow vercel.app).
// Uses the publishable key: the same read-only access the page used to have, and no secret.
import { sendJson, sendError, requireMethod, HttpError } from './_lib/http.js';
import { createReadStore } from './_lib/db.js';

const SUPABASE_URL = 'https://rrjnvgufodklgkrnhzwu.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_kjdshNTIpb9NQ89rjjx1_w_IUSf_a-n';

export function createHomeHandler({ store }) {
  return async function handler(req, res) {
    try {
      requireMethod(req, 'GET');
      let links, settings;
      try {
        [links, settings] = await Promise.all([store.listLinks(), store.getSettings()]);
      } catch {
        console.error('home: supabase read failed');
        throw new HttpError(502, 'upstream', 'Could not load links. Try again shortly.');
      }
      sendJson(res, 200, { links, settings });
    } catch (err) {
      sendError(res, err);
    }
  };
}

export default function handler(req, res) {
  const store = createReadStore({ url: process.env.SUPABASE_URL || SUPABASE_URL, key: PUBLISHABLE_KEY });
  return createHomeHandler({ store })(req, res);
}
