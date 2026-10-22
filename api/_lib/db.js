// Server-side Supabase access with the secret key (bypasses RLS). Never import this from a page.
// Talks to PostgREST with fetch so the functions need no runtime dependencies.
//
// The store interface used by api/auth.js (tests swap in an in-memory version):
//   getAuthState()                    -> auth_state row
//   updateAuthState(patch, {ifUpdatedAt}) -> updated row, or null if ifUpdatedAt no longer matches
//   insertResetToken({token_hash, expires_at})
//   findResetToken(token_hash)        -> row | null
//   useResetToken(id, usedAt)         -> true if this call marked it used (single use)

export function createSupabaseStore({ url, secretKey, fetch = globalThis.fetch }) {
  if (!url || !secretKey) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
  const base = `${url.replace(/\/$/, '')}/rest/v1`;

  async function rest(path, { method = 'GET', body, prefer } = {}) {
    const res = await fetch(`${base}/${path}`, {
      method,
      headers: {
        apikey: secretKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(prefer && { Prefer: prefer }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    // Status only: response bodies can echo row data, which must not end up in logs.
    if (!res.ok) throw new Error(`supabase ${method} ${path.split('?')[0]} failed: ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

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
  };
}
