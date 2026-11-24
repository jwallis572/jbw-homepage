-- Recreate public.links and public.settings (schema, RLS and grants only; no data).
--
-- Why this exists: on 2026-11-22 a `drop table public.links; drop table public.settings;` meant for
-- a different Supabase project was run in this one, and there were no backups. This script rebuilt
-- the two tables on 2026-11-23; the rows were then re-inserted from a local, git-ignored backup.
-- Keep personal link data OUT of this file: insert rows in a separate, unsaved SQL Editor query.
--
-- Shape matches what the code expects:
--   api/_lib/db.js   reads  links?select=*&order=section.asc,sort_order.asc  and  settings?key=eq.prefs
--                    writes links (insert without id/created_at; patch by id) and upserts settings on key
--   api/links.js     sections: personal | finance | work | study | admin; default icon 'fa-solid fa-link'
--   api/settings.js  value is a JSON object of homepage prefs
-- Policies match docs/sql/002_links_settings_read_only.sql: "public select" only. Writes go through
-- /api/links and /api/settings with the secret key, which bypasses RLS.
--
-- Safe to run: the guard stops it in any other project, and plain `create table` (no IF NOT EXISTS)
-- errors out instead of touching tables that already exist. Nothing here drops, truncates or deletes.

begin;

-- Guard: stop unless this is the homepage project (rrjnvgufodklgkrnhzwu).
do $$
begin
  if to_regclass('public.auth_state') is null or to_regclass('public.projects') is null then
    raise exception 'WRONG PROJECT: public.auth_state/public.projects not found. Switch to the homepage project.';
  end if;
  if to_regclass('public.progress') is not null or to_regclass('public.approval_tokens') is not null then
    raise exception 'WRONG PROJECT: this looks like the Study Guide project.';
  end if;
end $$;

create table public.links (
  id          uuid primary key default gen_random_uuid(),
  section     text not null,
  label       text not null,
  url         text not null,
  icon        text not null default 'fa-solid fa-link',
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create table public.settings (
  key         text primary key,
  value       jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.links    enable row level security;
alter table public.settings enable row level security;

create policy "public select" on public.links    for select to anon using (true);
create policy "public select" on public.settings for select to anon using (true);

grant select on public.links, public.settings to anon, authenticated;
grant all    on public.links, public.settings to service_role;

-- Tell the REST API to pick up the new tables right away (otherwise PGRST205 for a while).
notify pgrst, 'reload schema';

commit;

-- Check: both tables exist with RLS on and only "public select" policies.
select c.relname as table_name, c.relrowsecurity as rls_on,
       (select string_agg(p.policyname || ' (' || p.cmd || ')', ', ')
          from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('links', 'settings')
order by 1;
