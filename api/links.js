// Vercel serverless function: POST /api/links  (Authorization: Bearer <session token>)
//   { action: 'insert',  link: { section, label, url, icon, sort_order } }  -> { link }
//   { action: 'update',  id, link: { label, url, icon } }                   -> { link }
//   { action: 'delete',  id }                                               -> { ok }
//   { action: 'reorder', section, ids: [...] }                              -> { ok }
//   { action: 'move', id, from, to, ids: [...], from_ids: [...] }          -> { ok }
//       ids = the destination section's new order (including id); from_ids = what's left in `from`.
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
const stale = () => new HttpError(409, 'stale', 'Some links changed. Reload and try again.');

function checkIds(ids, { allowEmpty = true } = {}) {
  if (!Array.isArray(ids) || (!allowEmpty && ids.length === 0) || ids.length > 200
    || !ids.every(isId) || new Set(ids).size !== ids.length) {
    throw bad('ids must be a list of link ids.');
  }
}

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
    checkIds(ids);
    const updated = await store.setLinkOrder(section, ids);
    if (updated !== ids.length) throw stale();
    return { ok: true };
  },
  // Moves one link to another section. The three writes run one after another, and each only
  // PATCHes `section`/`sort_order` on rows that already exist (never insert or delete), so a failure
  // partway can leave gaps or ties in sort_order but can never lose or duplicate a link:
  //   1. the moved link's section and position (one row, and only if it is still in `from`)
  //   2. the destination section's order
  //   3. the source section's order
  async move({ id, from, to, ids, from_ids }, { store }) {
    if (!isId(id)) throw bad('Missing link id.');
    if (!SECTIONS.includes(from) || !SECTIONS.includes(to)) throw bad('Unknown section.');
    if (from === to) throw bad('Use reorder to move a link within a section.');
    checkIds(ids, { allowEmpty: false });
    checkIds(from_ids);
    if (!ids.includes(id) || from_ids.includes(id)) throw bad('ids must include the moved link; from_ids must not.');

    const moved = await store.moveLink(id, from, { section: to, sort_order: ids.indexOf(id) });
    if (!moved) throw stale(); // gone, or already moved somewhere else (e.g. from another tab)
    if ((await store.setLinkOrder(to, ids)) !== ids.length) throw stale();
    if ((await store.setLinkOrder(from, from_ids)) !== from_ids.length) throw stale();
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
