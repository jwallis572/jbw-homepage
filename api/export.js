// Vercel serverless function: POST /api/export  (Authorization: Bearer <session token>)
// -> { export: { exported_at, categories, projects, milestones, deadlines, project_notes, timeline_prefs } }
// The dashboard saves `export` as a JSON file: a full backup of the tracker (plan §1, "Backup").
import { authedHandler, fromEnv } from './_lib/authed.js';
import { loadAll } from './projects.js';

export function createExportHandler(deps) {
  const now = deps.now || Date.now;
  return authedHandler('export', async (_, { store }) => ({
    export: { exported_at: new Date(now()).toISOString(), ...(await loadAll(store)) },
  }), deps);
}

export default fromEnv('export', createExportHandler);
