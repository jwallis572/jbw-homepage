// Vercel serverless function: POST /api/projects  (Authorization: Bearer <session token>)
//   { action: 'load' }                                  -> { categories, projects, milestones, deadlines, timeline_prefs }
//   { action: 'project.save',   id?, project }          -> { project }      (no id = create)
//   { action: 'project.delete', id }                    -> { ok }
//   { action: 'milestone.save', id?, milestone }        -> { milestone }
//   { action: 'milestone.delete', id }                  -> { ok }
//   { action: 'category.save',  id?, category }         -> { category }
//   { action: 'category.delete', id }                   -> { ok }       (409 while projects use it)
//   { action: 'deadline.save',  id?, deadline }         -> { deadline }
//   { action: 'deadline.delete', id }                   -> { ok }
//   { action: 'prefs.save', prefs }                     -> { timeline_prefs }
// Every input is checked here; the tables have no public policies (plan §4.5, §5).
import { HttpError } from './_lib/http.js';
import { authedHandler, bad, fromEnv } from './_lib/authed.js';
import { isHttpsUrl } from './links.js';

// Keep in step with PIPELINES in timeline.js (a test checks they match).
export const PIPELINES = {
  research: ['Idea', 'IRB', 'Data Collection', 'Analysis', 'Writing', 'Submitted', 'Accepted', 'Presented', 'Published'],
  simple: ['Not started', 'Active', 'Done'],
};

const isId = v => typeof v === 'string' && /^[\w-]{1,64}$/.test(v);
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const isHex = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

function text(input, key, { max, required = false, label = key }) {
  const v = input[key];
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
    if (required) throw bad(`${label} is required.`);
    return null;
  }
  if (typeof v !== 'string') throw bad(`${label} must be text.`);
  const t = v.trim();
  if (t.length > max) throw bad(`${label} is too long (${max} characters max).`);
  return t;
}

function date(input, key, { required = false, label = key } = {}) {
  const v = input[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${label} is required.`);
    return null;
  }
  if (!isDate(v)) throw bad(`${label} must be a date (YYYY-MM-DD).`);
  return v;
}

const bool = (input, key, fallback) => (typeof input[key] === 'boolean' ? input[key] : fallback);

function obj(v, what) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(`Missing ${what}.`);
  return v;
}

export function statusesFor(category) {
  if (category.pipeline === 'custom') return category.statuses || [];
  return PIPELINES[category.pipeline] || [];
}

function cleanCategory(input) {
  input = obj(input, 'category');
  const name = text(input, 'name', { max: 60, required: true, label: 'Name' });
  const color = input.color ?? '#60a5fa';
  if (!isHex(color)) throw bad('Color must be a hex value like #60a5fa.');
  const pipeline = input.pipeline ?? 'simple';
  if (!['research', 'simple', 'custom', 'none'].includes(pipeline)) throw bad('Unknown pipeline.');
  let statuses = [];
  if (pipeline === 'custom') {
    if (!Array.isArray(input.statuses)) throw bad('Custom categories need a list of statuses.');
    statuses = input.statuses.map(s => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
    if (!statuses.length) throw bad('Add at least one status.');
    if (statuses.length > 20 || statuses.some(s => s.length > 40)) throw bad('Up to 20 statuses, 40 characters each.');
    if (new Set(statuses.map(s => s.toLowerCase())).size !== statuses.length) throw bad('Statuses must be different.');
  }
  const sort_order = Number.isInteger(input.sort_order) && input.sort_order >= 0 && input.sort_order <= 1000 ? input.sort_order : 0;
  return { name, color, pipeline, statuses, sort_order };
}

function cleanLinks(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 20) throw bad('Links must be a list (20 max).');
  return v.map(l => {
    if (!l || typeof l !== 'object') throw bad('Each link needs a label and URL.');
    const label = typeof l.label === 'string' ? l.label.trim() : '';
    const url = typeof l.url === 'string' ? l.url.trim() : '';
    if (!label || label.length > 80) throw bad('Each link needs a label (80 characters max).');
    if (!isHttpsUrl(url)) throw bad('Link URLs must start with https://');
    return { label, url };
  });
}

function cleanProject(input, category) {
  input = obj(input, 'project');
  const statuses = statusesFor(category);
  let status = null;
  if (category.pipeline !== 'none') {
    status = input.status ?? statuses[0];
    if (!statuses.includes(status)) throw bad(`Status must be one of: ${statuses.join(', ')}.`);
  }
  const p = {
    category_id: category.id,
    title: text(input, 'title', { max: 200, required: true, label: 'Title' }),
    status,
    role: text(input, 'role', { max: 120 }),
    mentor: text(input, 'mentor', { max: 200 }),
    collaborators: text(input, 'collaborators', { max: 500 }),
    venue: text(input, 'venue', { max: 200 }),
    start_date: date(input, 'start_date', { label: 'Start date' }),
    end_date: date(input, 'end_date', { label: 'End date' }),
    next_action: text(input, 'next_action', { max: 300 }),
    waiting_on: text(input, 'waiting_on', { max: 200 }),
    waiting_since: date(input, 'waiting_since', { label: 'Waiting since' }),
    links: cleanLinks(input.links),
    notes: text(input, 'notes', { max: 5000 }),
    archived: bool(input, 'archived', false),
  };
  if (p.start_date && p.end_date && p.end_date < p.start_date) throw bad('End date is before the start date.');
  if (!p.waiting_on) p.waiting_since = null;
  return p;
}

function cleanMilestone(input, today) {
  input = obj(input, 'milestone');
  const done = bool(input, 'done', false);
  return {
    name: text(input, 'name', { max: 200, required: true, label: 'Name' }),
    due_date: date(input, 'due_date', { required: true, label: 'Due date' }),
    done,
    done_at: done ? (date(input, 'done_at', { label: 'Done date' }) || today) : null,
  };
}

function cleanDeadline(input) {
  input = obj(input, 'deadline');
  const kind = input.kind ?? 'deadline';
  if (!['deadline', 'event', 'conference'].includes(kind)) throw bad('Kind must be deadline, event or conference.');
  return {
    name: text(input, 'name', { max: 200, required: true, label: 'Name' }),
    date: date(input, 'date', { required: true, label: 'Date' }),
    kind,
    show_on_timeline: bool(input, 'show_on_timeline', true),
    notes: text(input, 'notes', { max: 2000 }),
  };
}

function cleanPrefs(input) {
  input = obj(input, 'prefs');
  const mode = input.mode ?? 'rolling';
  if (!['rolling', 'fixed'].includes(mode)) throw bad('Mode must be rolling or fixed.');
  const int = (k, lo, hi, def) => {
    const v = input[k] ?? def;
    if (!Number.isInteger(v) || v < lo || v > hi) throw bad(`${k} must be a whole number from ${lo} to ${hi}.`);
    return v;
  };
  const prefs = {
    mode,
    months_back: int('months_back', 0, 24, 1),
    months_ahead: int('months_ahead', 1, 36, 8),
    fixed_start: date(input, 'fixed_start', { label: 'Start month' }),
    fixed_end: date(input, 'fixed_end', { label: 'End month' }),
  };
  if (mode === 'fixed') {
    if (!prefs.fixed_start || !prefs.fixed_end) throw bad('A fixed range needs a start and end month.');
    if (prefs.fixed_end < prefs.fixed_start) throw bad('The end month is before the start month.');
  }
  return prefs;
}

const notFound = what => new HttpError(404, 'not_found', `That ${what} no longer exists.`);
const isoDay = t => new Date(t).toISOString().slice(0, 10);

async function findRow(store, table, id, what) {
  if (!isId(id)) throw bad(`Missing ${what} id.`);
  const row = (await store.listRows(table)).find(r => String(r.id) === id);
  if (!row) throw notFound(what);
  return row;
}

/** Insert or update, mapping unique-name clashes to a readable 409. */
async function save(store, table, id, row, what) {
  try {
    if (id === undefined || id === null) return await store.insertRow(table, row);
    if (!isId(id)) throw bad(`Missing ${what} id.`);
    const updated = await store.updateRow(table, id, row);
    if (!updated) throw notFound(what);
    return updated;
  } catch (err) {
    if (err.status === 409) throw new HttpError(409, 'conflict', `A ${what} with that name already exists.`);
    throw err;
  }
}

async function remove(store, table, id, what) {
  if (!isId(id)) throw bad(`Missing ${what} id.`);
  if (!(await store.deleteRow(table, id))) throw notFound(what);
  return { ok: true };
}

async function touchProject(store, projectId, now) {
  await store.updateRow('projects', projectId, { updated_at: new Date(now).toISOString() });
}

export async function loadAll(store) {
  const [categories, projects, milestones, deadlines, prefs, project_notes] = await Promise.all([
    store.listRows('categories', 'sort_order.asc,name.asc'),
    store.listRows('projects', 'created_at.asc'),
    store.listRows('milestones', 'due_date.asc'),
    store.listRows('deadlines', 'date.asc'),
    store.listRows('timeline_prefs'),
    store.listRows('project_notes', 'created_at.asc'),
  ]);
  return { categories, projects, milestones, deadlines, timeline_prefs: prefs[0] || null, project_notes };
}

const actions = {
  async load(_, { store }) {
    const { project_notes, ...rest } = await loadAll(store);
    return rest;
  },

  async 'project.save'({ id, project }, { store, now }) {
    const input = obj(project, 'project');
    const category = await findRow(store, 'categories', input.category_id, 'category');
    const row = { ...cleanProject(input, category), updated_at: new Date(now()).toISOString() };
    return { project: await save(store, 'projects', id, row, 'project') };
  },
  'project.delete': ({ id }, { store }) => remove(store, 'projects', id, 'project'),

  async 'milestone.save'({ id, milestone }, { store, now }) {
    const input = obj(milestone, 'milestone');
    const project = await findRow(store, 'projects', input.project_id, 'project');
    const row = { project_id: project.id, ...cleanMilestone(input, isoDay(now())) };
    const saved = await save(store, 'milestones', id, row, 'milestone');
    await touchProject(store, project.id, now());
    return { milestone: saved };
  },
  async 'milestone.delete'({ id }, { store, now }) {
    const row = await findRow(store, 'milestones', id, 'milestone');
    await remove(store, 'milestones', id, 'milestone');
    await touchProject(store, row.project_id, now());
    return { ok: true };
  },

  async 'category.save'({ id, category }, { store }) {
    const row = cleanCategory(category);
    if (id !== undefined && id !== null) {
      const existing = await findRow(store, 'categories', id, 'category');
      // A pipeline can't change under projects whose statuses would stop making sense.
      const used = await store.countWhere('projects', 'category_id', id);
      if (used && (existing.pipeline !== row.pipeline
        || (row.pipeline === 'custom' && (await store.listRows('projects')).some(p =>
          p.category_id === id && p.status && !row.statuses.includes(p.status))))) {
        throw new HttpError(409, 'in_use', 'Projects use statuses this change would remove. Move or update them first.');
      }
    }
    return { category: await save(store, 'categories', id, row, 'category') };
  },
  async 'category.delete'({ id }, { store }) {
    await findRow(store, 'categories', id, 'category');
    const used = await store.countWhere('projects', 'category_id', id);
    if (used) throw new HttpError(409, 'in_use', `${used} project${used === 1 ? ' uses' : 's use'} this category. Move ${used === 1 ? 'it' : 'them'} first.`);
    await store.clearWhere('deadlines', 'category_id', id);
    return remove(store, 'categories', id, 'category');
  },

  async 'deadline.save'({ id, deadline }, { store }) {
    const input = obj(deadline, 'deadline');
    const row = cleanDeadline(input);
    row.category_id = input.category_id ? (await findRow(store, 'categories', input.category_id, 'category')).id : null;
    return { deadline: await save(store, 'deadlines', id, row, 'deadline') };
  },
  'deadline.delete': ({ id }, { store }) => remove(store, 'deadlines', id, 'deadline'),

  async 'prefs.save'({ prefs }, { store }) {
    const row = cleanPrefs(prefs);
    const saved = (await store.updateRow('timeline_prefs', 1, row)) || (await store.insertRow('timeline_prefs', { id: 1, ...row }));
    return { timeline_prefs: saved };
  },
};

export function createProjectsHandler(deps) {
  const now = deps.now || Date.now;
  return authedHandler('projects', (body, d) => {
    const action = actions[body.action];
    if (!action) throw new HttpError(400, 'bad_action', 'Unknown action.');
    return action(body, { ...d, now });
  }, deps);
}

export default fromEnv('projects', createProjectsHandler);
