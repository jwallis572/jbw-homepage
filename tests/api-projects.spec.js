import { test, expect } from '@playwright/test';
import projectsHandler, { createProjectsHandler } from '../api/projects.js';
import { createExportHandler } from '../api/export.js';
import { issueToken } from '../api/_lib/session.js';
import { TEST_SECRET, createMemoryStore, fakeRes } from './auth-fakes.js';
import { sampleData } from './dashboard-fakes.js';

// Unit tests for api/projects.js and api/export.js on an in-memory store (plan §5, §8).
const NOW = Date.parse('2026-10-19T15:00:00Z');

function env() {
  const store = createMemoryStore();
  for (const [table, rows] of Object.entries(sampleData())) store.tables[table] = structuredClone(rows);
  const deps = { store, sessionSecret: TEST_SECRET, now: () => NOW };
  const handlers = { projects: createProjectsHandler(deps), export: createExportHandler(deps) };
  const token = issueToken({ secret: TEST_SECRET, epoch: 1, now: NOW }).token;
  const call = async (body, { name = 'projects', auth = token } = {}) => {
    const res = fakeRes();
    await handlers[name]({ method: 'POST', body, headers: auth ? { authorization: `Bearer ${auth}` } : {} }, res);
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  return { store, call };
}
const P = { category_id: 'cat-research', title: 'New study', status: 'Idea' };

test('everything needs a session, including load and export', async () => {
  const { call } = env();
  expect((await call({ action: 'load' }, { auth: null })).status).toBe(401);
  expect((await call({}, { name: 'export', auth: null })).status).toBe(401);
  expect((await call({ action: 'load' }, { auth: 'nope' })).status).toBe(401);
});

test('load returns every table but the activity log; export includes it', async () => {
  const { call } = env();
  const load = await call({ action: 'load' });
  expect(Object.keys(load.body).sort()).toEqual(['categories', 'deadlines', 'exp', 'milestones', 'projects', 'timeline_prefs', 'token']);
  expect(load.body.timeline_prefs).toMatchObject({ months_back: 1, months_ahead: 8 });
  const exp = await call({}, { name: 'export' });
  expect(exp.body.export.exported_at).toBe(new Date(NOW).toISOString());
  expect(exp.body.export.project_notes).toEqual([]);
});

test('project status must belong to its category, and "none" stores no status', async () => {
  const { store, call } = env();
  expect((await call({ action: 'project.save', project: { ...P, status: 'Funded' } })).status).toBe(400);
  const defaulted = await call({ action: 'project.save', project: { ...P, status: undefined } });
  expect(defaulted.body.project.status).toBe('Idea');
  store.tables.categories.push({ id: 'cat-none', name: 'Life', color: '#ffffff', pipeline: 'none', statuses: [], sort_order: 9 });
  const none = await call({ action: 'project.save', project: { ...P, category_id: 'cat-none', status: 'Idea' } });
  expect(none.body.project.status).toBeNull();
  expect(none.body.project.updated_at).toBe(new Date(NOW).toISOString());
});

test('project fields are validated', async () => {
  const { call } = env();
  const bad = [
    { ...P, title: '  ' },
    { ...P, title: 'x'.repeat(201) },
    { ...P, category_id: 'missing' },
    { ...P, start_date: '2026-13-40' },
    { ...P, start_date: '2027-02-01', end_date: '2027-01-01' },
    { ...P, links: [{ label: 'x', url: 'http://insecure.example' }] },
    { ...P, links: [{ label: '', url: 'https://ok.example' }] },
    { ...P, notes: 'x'.repeat(5001) },
  ];
  for (const project of bad) {
    const res = await call({ action: 'project.save', project });
    expect([400, 404], JSON.stringify(project).slice(0, 60)).toContain(res.status);
  }
  const ok = await call({ action: 'project.save', project: { ...P, waiting_on: '', waiting_since: '2026-10-01' } });
  expect(ok.body.project.waiting_since).toBeNull(); // no "since" without someone to wait on
});

test('saving or deleting a milestone touches its project', async () => {
  const { store, call } = env();
  const res = await call({ action: 'milestone.save', milestone: { project_id: 'p-review', name: 'Outline', due_date: '2026-12-10' } });
  expect(res.body.milestone).toMatchObject({ project_id: 'p-review', done: false, done_at: null });
  expect(store.tables.projects.find(p => p.id === 'p-review').updated_at).toBe(new Date(NOW).toISOString());
  const done = await call({ action: 'milestone.save', id: res.body.milestone.id, milestone: { project_id: 'p-review', name: 'Outline', due_date: '2026-12-10', done: true } });
  expect(done.body.milestone.done_at).toBe('2026-10-19');
  expect((await call({ action: 'milestone.save', milestone: { project_id: 'p-review', name: 'No date' } })).status).toBe(400);
  expect((await call({ action: 'milestone.delete', id: res.body.milestone.id })).body.ok).toBe(true);
});

test('categories: custom statuses required, no pipeline change under projects, delete only when empty', async () => {
  const { store, call } = env();
  expect((await call({ action: 'category.save', category: { name: 'G', pipeline: 'custom', statuses: [] } })).status).toBe(400);
  expect((await call({ action: 'category.save', category: { name: 'G', pipeline: 'custom', statuses: ['A', 'a'] } })).status).toBe(400);
  expect((await call({ action: 'category.save', category: { name: 'G', color: 'red' } })).status).toBe(400);
  expect((await call({ action: 'category.save', category: { name: 'Research' } })).status).toBe(409);

  const change = await call({ action: 'category.save', id: 'cat-research', category: { name: 'Research', color: '#123456', pipeline: 'simple' } });
  expect(change.status).toBe(409);
  const recolor = await call({ action: 'category.save', id: 'cat-research', category: { name: 'Research', color: '#123456', pipeline: 'research' } });
  expect(recolor.body.category.color).toBe('#123456');

  expect((await call({ action: 'category.delete', id: 'cat-research' })).status).toBe(409);
  store.tables.deadlines.push({ id: 'd-qi', category_id: 'cat-qi', name: 'QI day', date: '2026-11-01', kind: 'event', show_on_timeline: true });
  expect((await call({ action: 'category.delete', id: 'cat-qi' })).body.ok).toBe(true);
  expect(store.tables.deadlines.find(d => d.id === 'd-qi').category_id).toBeNull();
});

test('deadlines and timeline prefs are validated', async () => {
  const { store, call } = env();
  expect((await call({ action: 'deadline.save', deadline: { name: 'X', date: '2027-01-01', kind: 'party' } })).status).toBe(400);
  expect((await call({ action: 'deadline.save', deadline: { name: 'X' } })).status).toBe(400);
  const ok = await call({ action: 'deadline.save', deadline: { name: 'Boards', date: '2027-01-01' } });
  expect(ok.body.deadline).toMatchObject({ kind: 'deadline', show_on_timeline: true, category_id: null });

  expect((await call({ action: 'prefs.save', prefs: { months_back: 30 } })).status).toBe(400);
  expect((await call({ action: 'prefs.save', prefs: { mode: 'fixed', fixed_start: '2027-03-01', fixed_end: '2027-01-01' } })).status).toBe(400);
  const prefs = await call({ action: 'prefs.save', prefs: { mode: 'fixed', fixed_start: '2027-01-01', fixed_end: '2027-06-01' } });
  expect(store.tables.timeline_prefs).toHaveLength(1);
  expect(prefs.body.timeline_prefs).toMatchObject({ id: 1, mode: 'fixed', fixed_start: '2027-01-01' });
});

test('unknown actions are rejected, and the deployed handler needs its secrets', async () => {
  const { call } = env();
  expect((await call({ action: 'drop.tables' })).body.error).toBe('bad_action');
  const saved = { ...process.env };
  delete process.env.SESSION_SECRET;
  try {
    const res = fakeRes();
    await projectsHandler({ method: 'POST', body: {}, headers: {} }, res);
    expect(JSON.parse(res.body).error).toBe('not_configured');
  } finally {
    Object.assign(process.env, saved);
  }
});

test.describe('category.statuses (board columns)', () => {
  const R = ['Idea', 'IRB', 'Data Collection', 'Analysis', 'Writing', 'Submitted', 'Accepted', 'Presented', 'Published'];
  const keep = names => names.map(n => ({ name: n, was: n }));

  test('rename, add and reorder: projects follow their column and only this category changes', async () => {
    const { store, call } = env();
    const columns = keep(R).map(c => (c.was === 'Writing' ? { name: 'Drafting', was: 'Writing' } : c));
    columns.splice(5, 0, { name: 'Revisions' }); // new column after Drafting
    const res = await call({ action: 'category.statuses', id: 'cat-research', columns });
    expect(res.status).toBe(200);
    expect(res.body.moved).toBe(1);
    expect(res.body.category).toMatchObject({ pipeline: 'custom', name: 'Research', color: '#60a5fa' });
    expect(res.body.category.statuses).toEqual(['Idea', 'IRB', 'Data Collection', 'Analysis', 'Drafting', 'Revisions', 'Submitted', 'Accepted', 'Presented', 'Published']);
    expect(store.tables.projects.find(p => p.id === 'p-case').status).toBe('Drafting');
    expect(store.tables.projects.find(p => p.id === 'p-ecmo').status).toBe('Analysis');
    expect(store.tables.projects.find(p => p.id === 'p-case').updated_at).toBe('2026-10-14T12:00:00Z'); // renames aren't activity
    expect(store.tables.categories.find(c => c.id === 'cat-qi').pipeline).toBe('research');
  });

  test('swapping two names in one save maps each project correctly', async () => {
    const { store, call } = env();
    const columns = keep(R).map(c => (c.was === 'Analysis' ? { name: 'Writing', was: 'Analysis' }
      : c.was === 'Writing' ? { name: 'Analysis', was: 'Writing' } : c));
    expect((await call({ action: 'category.statuses', id: 'cat-research', columns })).body.moved).toBe(2);
    expect(store.tables.projects.find(p => p.id === 'p-ecmo').status).toBe('Writing');
    expect(store.tables.projects.find(p => p.id === 'p-case').status).toBe('Analysis');
  });

  test('removing a column with projects needs a destination', async () => {
    const { store, call } = env();
    const columns = keep(R.filter(s => s !== 'Writing'));
    const refused = await call({ action: 'category.statuses', id: 'cat-research', columns });
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain('still has projects');
    expect(store.tables.categories.find(c => c.id === 'cat-research').pipeline).toBe('research'); // nothing saved

    const ok = await call({ action: 'category.statuses', id: 'cat-research', columns, reassign: { Writing: 'Submitted' } });
    expect(ok.status).toBe(200);
    expect(store.tables.projects.find(p => p.id === 'p-case').status).toBe('Submitted');
    // An empty column can go without a destination.
    const again = await call({ action: 'category.statuses', id: 'cat-research', columns: keep(ok.body.category.statuses.filter(s => s !== 'IRB')) });
    expect(again.status).toBe(200);
  });

  test('a "none" category gains columns and its projects start in the first one', async () => {
    const { store, call } = env();
    store.tables.categories.push({ id: 'cat-none', name: 'Life', color: '#ffffff', pipeline: 'none', statuses: [], sort_order: 9 });
    store.tables.projects.push({ ...store.tables.projects[0], id: 'p-life', category_id: 'cat-none', status: null });
    const res = await call({ action: 'category.statuses', id: 'cat-none', columns: [{ name: 'Planning' }, { name: 'Doing' }, { name: 'Done' }] });
    expect(res.body.category).toMatchObject({ pipeline: 'custom', statuses: ['Planning', 'Doing', 'Done'] });
    expect(store.tables.projects.find(p => p.id === 'p-life').status).toBe('Planning');
  });

  test('bad column lists are rejected', async () => {
    const { call } = env();
    const bad = [
      { columns: 'Idea' },
      { columns: [] },
      { columns: [{ name: '' }] },
      { columns: [{ name: 'A' }, { name: 'a' }] },
      { columns: [{ name: 'x'.repeat(41) }] },
      { columns: Array.from({ length: 21 }, (_, i) => ({ name: `C${i}` })) },
      { columns: [{ name: 'A', was: 'Nope' }] },
      { columns: [{ name: 'A', was: 'Idea' }, { name: 'B', was: 'Idea' }] },
      { columns: keep(R), reassign: { Idea: 'IRB' } }, // only removed columns can be reassigned
      { columns: keep(R.filter(s => s !== 'Writing')), reassign: { Writing: 'Nowhere' } },
    ];
    for (const b of bad) {
      const res = await call({ action: 'category.statuses', id: 'cat-research', ...b });
      expect(res.status, JSON.stringify(b).slice(0, 80)).toBe(400);
    }
    expect((await call({ action: 'category.statuses', id: 'missing', columns: [{ name: 'A' }] })).status).toBe(404);
  });
});
