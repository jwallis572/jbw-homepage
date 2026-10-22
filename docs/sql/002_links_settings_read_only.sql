-- Projects dashboard, Phase 2 step 2: make links and settings read-only for the public key.
-- Source: docs/projects-dashboard-plan.md §4.5, §9.
--
-- RUN ONLY AFTER the Phase 2 PR (edit mode through /api/links and /api/settings) is live on
-- production and edit mode has been confirmed working there. Running it earlier breaks editing.
--
-- Policies found on 2026-10-22 (PR #3 comment): "public select|insert|update|delete" for anon on
-- both tables. This keeps "public select" and drops the three write policies on each table.
-- The server's secret key bypasses RLS, so /api/links and /api/settings keep working.

begin;

drop policy if exists "public insert" on public.links;
drop policy if exists "public update" on public.links;
drop policy if exists "public delete" on public.links;

drop policy if exists "public insert" on public.settings;
drop policy if exists "public update" on public.settings;
drop policy if exists "public delete" on public.settings;

commit;

-- Check: only "public select" should remain on each table.
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public' and tablename in ('links', 'settings')
order by tablename, policyname;
