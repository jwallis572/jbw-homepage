// Vercel serverless function: GET /api/timeline  (public, cached briefly at the edge)
// What the homepage strip draws, and nothing more (plan §6.2):
//   { window, today, counts: { active, overdue },
//     projects: [{ id, title, color, status, start, end, created, milestones: [{ date, done }] }],
//     deadlines: [{ name, date, kind }] }
// Never next actions, notes, links, people, roles or milestone names. Archived projects are left out.
// The tracker tables have no public policies, so this reads with the secret key server-side.
import { HttpError, requireMethod, sendError, sendJson } from './_lib/http.js';
import { createSupabaseStore } from './_lib/db.js';
import { statusesFor } from './projects.js';

const CACHE = 'public, s-maxage=60, stale-while-revalidate=300';

/** 'YYYY-MM-DD' for now in Houston, the homepage's time zone. */
export function houstonDay(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

export function buildTimeline({ categories, projects, milestones, deadlines, prefs }, today) {
  const cats = new Map(categories.map(c => [c.id, c]));
  const live = projects.filter(p => !p.archived);
  const liveIds = new Set(live.map(p => p.id));
  const isActive = p => {
    const cat = cats.get(p.category_id);
    if (!cat || cat.pipeline === 'none') return !p.end_date || p.end_date >= today;
    const s = statusesFor(cat);
    return p.status !== s[s.length - 1];
  };
  const overdue = milestones.filter(m => !m.done && liveIds.has(m.project_id) && m.due_date < today).length;
  const { mode, months_back, months_ahead, fixed_start, fixed_end } = prefs || {};
  return {
    window: prefs ? { mode, months_back, months_ahead, fixed_start, fixed_end } : null,
    today,
    counts: { active: live.filter(isActive).length, overdue },
    projects: live.map(p => ({
      id: p.id,
      title: p.title,
      color: cats.get(p.category_id)?.color || '#a1a1aa',
      status: p.status,
      start: p.start_date,
      end: p.end_date,
      created: (p.created_at || '').slice(0, 10),
      milestones: milestones.filter(m => m.project_id === p.id).map(m => ({ date: m.due_date, done: !!m.done })),
    })),
    deadlines: deadlines.filter(d => d.show_on_timeline).map(d => ({ name: d.name, date: d.date, kind: d.kind })),
  };
}

export function createTimelineHandler({ store, now = Date.now }) {
  return async function handler(req, res) {
    try {
      requireMethod(req, 'GET');
      let rows;
      try {
        const [categories, projects, milestones, deadlines, prefs] = await Promise.all([
          store.listRows('categories'),
          store.listRows('projects', 'created_at.asc'),
          store.listRows('milestones', 'due_date.asc'),
          store.listRows('deadlines', 'date.asc'),
          store.listRows('timeline_prefs'),
        ]);
        rows = { categories, projects, milestones, deadlines, prefs: prefs[0] };
      } catch {
        console.error('timeline: supabase read failed');
        throw new HttpError(502, 'upstream', 'Timeline unavailable.');
      }
      sendJson(res, 200, buildTimeline(rows, houstonDay(now())), { cache: CACHE });
    } catch (err) {
      sendError(res, err);
    }
  };
}

export default async function handler(req, res) {
  let store;
  try {
    store = createSupabaseStore({ url: process.env.SUPABASE_URL, secretKey: process.env.SUPABASE_SECRET_KEY });
  } catch (err) {
    console.error(`timeline: ${err.message}`);
    return sendJson(res, 500, { error: 'not_configured', message: 'Server is not configured.' });
  }
  return createTimelineHandler({ store })(req, res);
}
