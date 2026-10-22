// Server-side Supabase access with the secret key (bypasses RLS). Never import this from a page.
// Talks to PostgREST with fetch so the functions need no runtime dependencies.
//
// The store interface used by api/auth.js (tests swap in an in-memory version):
//   getAuthState()                    -> auth_state row
//   updateAuthState(patch, {ifUpdatedAt}) -> updated row, or null if ifUpdatedAt no longer matches
//   insertResetToken({token_hash, expires_at})
//   findResetToken(token_hash)        -> row | null
//   useResetToken(id, usedAt)         -> true if this call marked it used (single use)
//
// Homepage writes (api/links.js, api/settings.js):
//   insertLink(fields)                -> inserted row
//   updateLink(id, fields)            -> updated row | null if no such link
//   deleteLink(id)                    -> true if a row was deleted
//   setLinkOrder(section, ids)        -> number of links in that section that were updated
//   upsertSettings(value, updatedAt)  -> the 'prefs' row
//
// Projects dashboard tables (api/projects.js, api/export.js), generic by table name:
//   listRows(table, order)            -> all rows, optionally ordered ("col.asc,col2.desc")
//   insertRow(table, row)             -> inserted row
//   updateRow(table, id, patch)       -> updated row | null if no such id
//   deleteRow(table, id)              -> true if a row was deleted
//   countWhere(table, column, value)  -> number of rows where column = value
//   clearWhere(table, column, value)  -> sets column to null where column = value
// A unique or foreign-key violation surfaces as an Error with status 409.

function restClient(url, key, fetch) {
  const base = `${url.replace(/\/$/, '')}/rest/v1`;
  return async function rest(path, { method = 'GET', body, prefer } = {}) {
    const res = await fetch(`${base}/${path}`, {
      method,
      headers: {
        apikey: key,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(prefer && { Prefer: prefer }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    // Status only: response bodies can echo row data, which must not end up in logs.
    if (!res.ok) {
      throw Object.assign(new Error(`supabase ${method} ${path.split('?')[0]} failed: ${res.status}`), { status: res.status });
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
}

/**
 * Public reads for the homepage (api/home.js) with the publishable key, so the server has exactly
 * the read-only access the browser used to have and needs no secret.
 *   listLinks()    -> links rows ordered by section, sort_order
 *   getSettings()  -> the 'prefs' value | null
 */
export function createReadStore({ url, key, fetch = globalThis.fetch }) {
  const rest = restClient(url, key, fetch);
  return {
    listLinks: () => rest('links?select=*&order=section.asc,sort_order.asc'),
    async getSettings() {
      const rows = await rest('settings?key=eq.prefs&select=value');
      return rows?.[0]?.value ?? null;
    },
  };
}

export function createSupabaseStore({ url, secretKey, fetch = globalThis.fetch }) {
  if (!url || !secretKey) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
  const rest = restClient(url, secretKey, fetch);

  return {
    async getAuthState() {
      const rows = await rest('auth_state?id=eq.1&select=*');
      if (!rows?.length) throw new Error('auth_state row missing: run docs/sql/001_projects_tracker_and_auth.sql');
      return rows[0];
    },
    async updateAuthState(patch, { ifUpdatedAt } = {}) {
      const guard = ifUpdatedAt ? `&updated_at=eq.${encodeURIComponent(ifUpdatedAt)}` : '';
      const rows = await rest(`auth_state?id=eq.1${guard}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
      return rows[0] || null;
    },
    async insertResetToken({ token_hash, expires_at }) {
      await rest('reset_tokens', { method: 'POST', body: { token_hash, expires_at }, prefer: 'return=minimal' });
    },
    async findResetToken(token_hash) {
      const rows = await rest(`reset_tokens?token_hash=eq.${encodeURIComponent(token_hash)}&select=*`);
      return rows[0] || null;
    },
    async useResetToken(id, usedAt) {
      const rows = await rest(`reset_tokens?id=eq.${encodeURIComponent(id)}&used_at=is.null`, {
        method: 'PATCH', body: { used_at: usedAt }, prefer: 'return=representation',
      });
      return rows.length === 1;
    },
    async insertLink(fields) {
      const rows = await rest('links', { method: 'POST', body: fields, prefer: 'return=representation' });
      return rows[0];
    },
    async updateLink(id, fields) {
      const rows = await rest(`links?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH', body: fields, prefer: 'return=representation',
      });
      return rows[0] || null;
    },
    async deleteLink(id) {
      const rows = await rest(`links?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=representation' });
      return rows.length > 0;
    },
    async setLinkOrder(section, ids) {
      const results = await Promise.all(ids.map((id, sort_order) =>
        rest(`links?id=eq.${encodeURIComponent(id)}&section=eq.${encodeURIComponent(section)}`, {
          method: 'PATCH', body: { sort_order }, prefer: 'return=representation',
        })));
      return results.filter(rows => rows.length > 0).length;
    },
    async upsertSettings(value, updatedAt) {
      // Same upsert the browser used to do: conflict on the primary key (key = 'prefs').
      const rows = await rest('settings', {
        method: 'POST', body: { key: 'prefs', value, updated_at: updatedAt },
        prefer: 'resolution=merge-duplicates,return=representation',
      });
      return rows[0];
    },
    listRows: (table, order) => rest(`${table}?select=*${order ? `&order=${order}` : ''}`),
    async insertRow(table, row) {
      return (await rest(table, { method: 'POST', body: row, prefer: 'return=representation' }))[0];
    },
    async updateRow(table, id, patch) {
      const rows = await rest(`${table}?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: patch, prefer: 'return=representation' });
      return rows[0] || null;
    },
    async deleteRow(table, id) {
      const rows = await rest(`${table}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=representation' });
      return rows.length > 0;
    },
    async countWhere(table, column, value) {
      return (await rest(`${table}?select=id&${column}=eq.${encodeURIComponent(value)}`)).length;
    },
    async clearWhere(table, column, value) {
      await rest(`${table}?${column}=eq.${encodeURIComponent(value)}`, { method: 'PATCH', body: { [column]: null }, prefer: 'return=minimal' });
    },
  };
}
