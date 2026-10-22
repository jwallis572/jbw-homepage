-- Projects dashboard, Phase 1: tracker tables + PIN auth state.
-- Source: docs/projects-dashboard-plan.md §5. Run once in the Supabase SQL editor.
-- Does NOT touch the links or settings tables (that is the Phase 2 migration).
-- Wrapped in a transaction so a failure part-way leaves nothing behind.

begin;

-- Categories: built-ins seeded, plus Jordan's own
create table categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  color       text not null default '#60a5fa',          -- hex
  pipeline    text not null default 'simple'            -- 'research' | 'simple' | 'custom' | 'none'
              check (pipeline in ('research','simple','custom','none')),
  statuses    text[] not null default '{}',             -- used when pipeline = 'custom'
  sort_order  int not null default 0,
  built_in    boolean not null default false,
  created_at  timestamptz not null default now()
);

create table projects (
  id            uuid primary key default gen_random_uuid(),
  category_id   uuid not null references categories(id),
  title         text not null,
  status        text,                                   -- null when pipeline = 'none'
  role          text,                                   -- e.g. "1st author", "Co-investigator"
  mentor        text,
  collaborators text,
  venue         text,                                   -- target journal / conference
  start_date    date,
  end_date      date,
  next_action   text,
  waiting_on    text,
  waiting_since date,
  links         jsonb not null default '[]',            -- [{label, url}]
  notes         text,
  archived      boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table milestones (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  name        text not null,
  due_date    date not null,
  done        boolean not null default false,
  done_at     date,
  created_at  timestamptz not null default now()
);

-- Standalone dated items: conference deadlines, exams, events, misc dates
create table deadlines (
  id           uuid primary key default gen_random_uuid(),
  category_id  uuid references categories(id),
  name         text not null,
  date         date not null,
  kind         text not null default 'deadline'         -- 'deadline' | 'event' | 'conference'
               check (kind in ('deadline','event','conference')),
  show_on_timeline boolean not null default true,
  notes        text,
  created_at   timestamptz not null default now()
);

-- Activity log per project (Phase 3 UI, table created now)
create table project_notes (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  body        text not null,
  created_at  timestamptz not null default now()
);

-- Timeline window preference (one row)
create table timeline_prefs (
  id            int primary key default 1 check (id = 1),
  mode          text not null default 'rolling' check (mode in ('rolling','fixed')),
  months_back   int not null default 1 check (months_back between 0 and 24),
  months_ahead  int not null default 8 check (months_ahead between 1 and 36),
  fixed_start   date,
  fixed_end     date
);
insert into timeline_prefs (id) values (1);

-- Auth state (one row)
create table auth_state (
  id                     int primary key default 1 check (id = 1),
  pin_hash               text,                          -- 'scrypt$<salt>$<hash>'
  failed_attempts        int not null default 0,
  locked_until           timestamptz,
  lockouts_since_success int not null default 0,
  hard_locked            boolean not null default false,
  session_epoch          int not null default 1,
  last_reset_email_at    timestamptz,
  updated_at             timestamptz not null default now()
);
insert into auth_state (id) values (1);

create table reset_tokens (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

-- Lock everything down: RLS on, no anon policies
alter table categories      enable row level security;
alter table projects        enable row level security;
alter table milestones      enable row level security;
alter table deadlines       enable row level security;
alter table project_notes   enable row level security;
alter table timeline_prefs  enable row level security;
alter table auth_state      enable row level security;
alter table reset_tokens    enable row level security;

-- Seed built-in categories
insert into categories (name, color, pipeline, built_in, sort_order) values
  ('Research',          '#60a5fa', 'research', true, 1),
  ('QI',                '#fbbf24', 'research', true, 2),
  ('Fellowship/Admin',  '#a78bfa', 'simple',   true, 3),
  ('Personal',          '#2dd4bf', 'simple',   true, 4);

commit;
