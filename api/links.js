// Vercel serverless function: POST /api/links  (Authorization: Bearer <session token>)
//   { action: 'insert',  link: { section, label, url, icon, sort_order } }  -> { link }
//   { action: 'update',  id, link: { label, url, icon } }                   -> { link }
//   { action: 'delete',  id }                                               -> { ok }
//   { action: 'reorder', section, ids: [...] }                              -> { ok }
// Replaces the browser's direct writes to the links table (plan §6.4).
import { HttpError } from './_lib/http.js';
import { authedHandler, bad, fromEnv } from './_lib/authed.js';

export const SECTIONS = ['personal', 'finance', 'work', 'study', 'admin'];
const DEFAULT_ICON = 'fa-solid fa-link';

const isId = v => typeof v === 'string' && /^[\w-]{1,64}$/.test(v);

export function isHttpsUrl(v) {
  if (typeof v !== 'string' || v.length > 2000) return false;
  try { return new URL(v).protocol === 'https:'; } catch { return false; }
}

function cleanLink(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object') throw bad('Missing link.');
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  const url = typeof input.url === 'string' ? input.url.trim() : '';
  const icon = typeof input.icon === 'string' && input.icon.trim() ? input.icon.trim() : DEFAULT_ICON;
  if (!label || label.length > 100) throw bad('Label is required (100 characters max).');
  if (!isHttpsUrl(url)) throw bad('URL must start with https://');
  if (!/^[a-z0-9 -]{1,80}$/i.test(icon)) throw bad('Icon must be Font Awesome class names.');
  const link = { label, url, icon };
  if (partial) return link;
  if (!SECTIONS.includes(input.section)) throw bad('Unknown section.');
  const sort_order = Number.isInteger(input.sort_order) && input.sort_order >= 0 && input.sort_order <= 10000
    ? input.sort_order : 0;
  return { ...link, section: input.section, sort_order };
}

const notFound = () => new HttpError(404, 'not_found', 'That link no longer exists.');

const actions = {
  async insert({ link }, { store }) {
    return { link: await store.insertLink(cleanLink(link)) };
  },
  async update({ id, link }, { store }) {
    if (!isId(id)) throw bad('Missing link id.');
    const row = await store.updateLink(id, cleanLink(link, { partial: true }));
    if (!row) throw notFound();
    return { link: row };
  },
  async delete({ id }, { store }) {
    if (!isId(id)) throw bad('Missing link id.');
    if (!(await store.deleteLink(id))) throw notFound();
    return { ok: true };
  },
  async reorder({ section, ids }, { store }) {
    if (!SECTIONS.includes(section)) throw bad('Unknown section.');
    if (!Array.isArray(ids) || ids.length > 200 || !ids.every(isId) || new Set(ids).size !== ids.length) {
      throw bad('ids must be a list of link ids.');
    }
    const updated = await store.setLinkOrder(section, ids);
    if (updated !== ids.length) throw new HttpError(409, 'stale', 'Some links changed. Reload and try again.');
    return { ok: true };
  },
};

export function createLinksHandler(deps) {
  return authedHandler('links', (body, d) => {
    const action = actions[body.action];
    if (!action) throw new HttpError(400, 'bad_action', 'Unknown action.');
    return action(body, d);
  }, deps);
}

export default fromEnv('links', createLinksHandler);
