// Vercel serverless function: POST /api/settings  (Authorization: Bearer <session token>)
//   { value: { theme, accent, engine, show_seconds, show_weather, show_radar, card_order, tile_alpha, tile_font } }
// Upserts the single 'prefs' row. Replaces the browser's direct upsert (plan §6.4).
import { authedHandler, bad, fromEnv } from './_lib/authed.js';

// Every field the homepage syncs, with what a valid value looks like. Unknown keys are rejected.
const FIELDS = {
  theme:        v => v === 'light' || v === 'dark',
  accent:       v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v),
  engine:       v => typeof v === 'string' && /^[a-z]{1,20}$/.test(v),
  show_seconds: v => v === 'true' || v === 'false',
  show_weather: v => v === 'true' || v === 'false',
  show_radar:   v => v === 'true' || v === 'false',
  card_order:   v => Array.isArray(v) && v.length <= 20 && v.every(s => typeof s === 'string' && /^[a-z]{1,20}$/.test(s)),
  tile_alpha:   v => typeof v === 'number' && v >= 0 && v <= 1,
  tile_font:    v => Number.isInteger(v) && v >= 6 && v <= 32,
};

export function cleanSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('value must be an object.');
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!FIELDS[k]) throw bad(`Unknown setting: ${String(k).slice(0, 40)}`);
    if (v === null) { out[k] = null; continue; } // the page sends null for settings never changed
    if (!FIELDS[k](v)) throw bad(`Invalid value for ${k}.`);
    out[k] = v;
  }
  return out;
}

export function createSettingsHandler(deps) {
  return authedHandler('settings', async ({ value }, { store, now = Date.now }) => {
    await store.upsertSettings(cleanSettings(value), new Date(now()).toISOString());
    return { ok: true };
  }, deps);
}

export default fromEnv('settings', createSettingsHandler);
