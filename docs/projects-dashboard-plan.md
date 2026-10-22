# Projects Dashboard — Master Plan

_Last updated: 2026-10-22. Owner: Jordan. Built with Claude Code._

This is the build spec for adding a private **Projects dashboard** to jbw-homepage, a public
**timeline strip** on the homepage that opens it, and a **4-digit passcode** that protects both the
dashboard and the homepage's edit mode. Read the whole file before writing code; the rollout order
in §9 matters.

Design mockup (dashboard, homepage strip, signed-out strip): Claude design canvas
"Projects Dashboard Mockup". Match its dark theme, spacing and colors; the homepage's existing CSS
variables are the source of truth.

---

## 1. Confirmed decisions

| Topic | Decision |
|---|---|
| Where it lives | Same repo and Vercel project. New page `projects.html`, served at `/projects`. |
| Homepage tile | Full-width strip **below all link cards**. Shows **only the timeline**. Always visible, logged in or not. Clicking anywhere opens the dashboard **in a new tab**. |
| Dashboard access | **4-digit numeric PIN required every time the dashboard opens.** Unlock lives only in that tab's memory: refresh, new tab, or another click from the homepage asks again. |
| Inactivity | Dashboard re-locks after **30 minutes idle**. |
| Homepage edit mode | Turning on edit mode **requires the same PIN**. All link and settings writes go through the passcode-checked server. |
| Failed attempts | **5 wrong PINs → lockout + email** to Jordan's personal Gmail (address stored only in a Vercel env var) with a reset link. One email per lockout. |
| Lockout length | First lockout auto-expires after **15 minutes**. A second lockout without a successful unlock in between is a **hard lock**: only the email reset clears it. (See §4.3 for why.) |
| Reset link | Single use, expires in **30 minutes**, lets Jordan **set a new PIN**, which also clears the lock. |
| Categories | Built-in: **Research, QI, Fellowship/Admin, Personal**. Jordan can **add his own categories**, each with its own color and either the research pipeline, the simple pipeline, or a **custom list of statuses**. |
| Non-traditional items | Any project can skip status pipelines entirely and just use free-form dated milestones. Standalone dated items (conference deadlines, exams, events) live in their own list and appear on the timeline. |
| Timeline window | Default **rolling 1 month back → 8 months ahead**. A **window control** on the dashboard lets Jordan change it on the fly (presets + custom start/end + zoom). The homepage strip uses the same saved window. |
| Backup | "Export all data" button downloads a JSON file of every project, milestone, category and deadline. |
| Secrets | Every key, the PIN pepper and the alert email live in **Vercel Environment Variables**, never in code. `.env*` added to `.gitignore`. |
| Repo visibility | Stays public for now (deferred). Nothing secret may ever be committed. |
| Data rule | **No PHI** anywhere in the tracker. Names, dates, statuses and links only. |

---

## 2. Current state of the repo (what to build on)

- `index.html` (~1,840 lines): single-page homepage. Uses `@supabase/supabase-js` from jsDelivr
  with the **publishable** key (`sb_publishable_…`) against Supabase project
  `rrjnvgufodklgkrnhzwu`.
  - `links` table: read on load; **inserted, updated, reordered and deleted directly from the
    browser** in edit mode (`editMode` toggle, ~line 1673).
  - `settings` table: single row `key = 'prefs'`; `pushSettings()` **upserts from the browser**
    whenever an appearance setting changes.
  - Sections defined in `SECTIONS` (~line 788) plus pinned `ADMIN_SECTION` ("Residency Admin").
- `api/suggest.js`: existing Vercel function (search-suggest proxy). New functions follow its style.
- `scripts/serve.mjs`: local server for tests. Routes **only flat** `/api/<name>` →
  `api/<name>.js`. Keep new endpoints flat (no nested folders under `/api` for routes).
- `sw.js`: service worker caches the app shell, skips `/api/*` and other origins.
  Cache name `jordan-start-v4` → bump when shipping.
- Tests: Playwright (`tests/*.spec.js`), run on every PR by `.github/workflows/test.yml`.
  `tests/helpers.js` stubs Supabase settings writes and network. `FIXED_NOW` = 2026-10-19.
- `.vercelignore` excludes tests, scripts, playwright config, `.github`, `.claude`.

**Security gap being closed:** because edit mode writes with the public key and no sign-in, the
Supabase policies on `links` and `settings` almost certainly allow anonymous insert/update/delete.
Anyone could alter or delete homepage links. Confirm in Supabase → Authentication → Policies
before Phase 2 and record what was found in the PR.

---

## 3. Architecture

```
Browser (public)                     Vercel functions (server)            Supabase
─────────────────                    ─────────────────────────            ────────
index.html                           api/timeline.js  (public, read) ──► projects, milestones,
  • links/settings READ (anon key)                                         categories, deadlines
  • timeline strip ───────────────►  (returns tile fields only)
  • edit mode ──PIN──►               api/auth.js  (unlock, reset)    ──► auth_state, reset_tokens
                                     api/links.js (token required)   ──► links      (secret key)
                                     api/settings.js (token required)──► settings   (secret key)
projects.html                        api/projects.js (token required)──► all tracker tables
  • PIN screen ──────────────────►   api/export.js (token required)
  • dashboard (token in memory)
```

- Browser keeps using the **publishable key for reads only** of `links` and `settings`.
- Every write, and every read of private dashboard data, goes through a Vercel function that
  verifies a session token, then talks to Supabase with the **secret key** (server-only env var).
- Shared server code lives in `api/_lib/` (underscore = not deployed as a route by Vercel; also
  not routed by `serve.mjs`).

### Files to add or change

| File | Purpose |
|---|---|
| `projects.html` | Dashboard page: PIN screen, dashboard UI, editors. Self-contained like `index.html`. |
| `api/auth.js` | `POST {action:'unlock', pin}`, `POST {action:'request-reset'}`, `POST {action:'reset', token, pin}`, `POST {action:'status'}`. |
| `api/timeline.js` | `GET` public, cacheable. Tile data only (see §6.2). |
| `api/projects.js` | Token required. CRUD for projects, milestones, categories, deadlines; dashboard summary. |
| `api/links.js` | Token required. Insert/update/delete/reorder links (replaces browser writes). |
| `api/settings.js` | Token required. Upsert the `prefs` row (replaces browser writes). |
| `api/export.js` | Token required. Returns all tracker data as a JSON download. |
| `api/_lib/session.js` | Issue/verify HMAC session tokens. |
| `api/_lib/pin.js` | Hash/verify PIN (scrypt + pepper), constant-time compare. |
| `api/_lib/lockout.js` | Attempt counting, lockout, hard lock. Pure logic with an injectable store for tests. |
| `api/_lib/mailer.js` | Send lockout/reset email via Resend. Injectable for tests. |
| `api/_lib/db.js` | Supabase server client using the secret key. |
| `api/_lib/http.js` | JSON body parsing, method checks, `Cache-Control: no-store`, error shape. |
| `index.html` | Timeline strip, PIN modal for edit mode, route writes through `/api/links` and `/api/settings`. |
| `sw.js` | Bump cache version. Never cache `/api/*` (already) or `projects.html` data. |
| `vercel.json` | Clean URL for `/projects`, security headers, `X-Robots-Tag: noindex` on `/projects`. |
| `.gitignore` | Add `.env*`. |
| `.vercelignore` | Add `docs/` so this plan is not served publicly. |
| `tests/*.spec.js` | New specs listed in §8. |

---

## 4. Security design

### 4.1 PIN storage
- PIN is exactly 4 digits. Stored in `auth_state.pin_hash` as **scrypt(pin + PIN_PEPPER, salt)**.
  The pepper lives only in Vercel env vars, so a database leak alone does not reveal the PIN.
- Compare with `crypto.timingSafeEqual`.
- Never log the PIN, the hash, tokens, or the alert email.

### 4.2 Session tokens
- On correct PIN, `api/auth` returns a token: base64url(JSON `{iat, exp, sid}`) + HMAC-SHA256
  signature using `SESSION_SECRET`.
- `exp` = now + 30 min. Every authenticated API response returns a refreshed token (sliding
  window), so 30 minutes of **inactivity** locks it.
- Client stores the token **only in a JS variable**. Never localStorage, sessionStorage, or cookies.
  Closing, refreshing, or opening a new tab means re-entering the PIN.
- `auth_state.session_epoch` is embedded in tokens; a PIN reset increments it, killing all
  existing sessions.
- All authenticated endpoints: `Authorization: Bearer <token>`, `Cache-Control: no-store`.

### 4.3 Attempts, lockout and why there is a hard lock
- `auth_state` tracks `failed_attempts`, `locked_until`, `lockouts_since_success`, `hard_locked`.
- Counter is **global** (one user), not per IP.
- Wrong PIN → `failed_attempts += 1`. At 5:
  - `lockouts_since_success += 1`, `failed_attempts = 0`.
  - If `lockouts_since_success == 1`: `locked_until = now + 15 min`.
  - If `>= 2`: `hard_locked = true` (no auto-expiry).
  - Send **one** email for this lockout with a reset link (§4.4). Email also serves as an alert
    that someone was guessing.
- Correct PIN → reset `failed_attempts` and `lockouts_since_success` to 0.
- While locked, `unlock` returns `423 Locked` with a generic message and **does not check the PIN**.
- **Why:** a 4-digit PIN has only 10,000 combinations. If lockouts always auto-expired after 15
  minutes, a stranger could try 5 PINs every 15 minutes (~480/day) and would likely get in
  within a couple of weeks. The hard lock caps a stranger at **10 guesses total** (≈0.1% chance)
  before Jordan's email is required.
- Remaining attempts are shown to the user ("3 attempts left").

### 4.4 Reset flow
1. Lockout (or "Forgot PIN?" / first-time "Set up PIN") calls `request-reset`.
2. Server creates 32 random bytes, stores **SHA-256 of it** in `reset_tokens` with
   `expires_at = now + 30 min`, `used_at = null`, and emails `${APP_URL}/projects?reset=<token>`
   to `ALERT_EMAIL` only. The address is never accepted from the request.
3. `request-reset` is rate-limited: max 1 email per 10 minutes, and max 1 per lockout.
   Always returns the same generic "If configured, an email was sent" response.
4. Opening the link shows "Set a new 4-digit PIN" (enter twice). `reset` validates the token
   (exists, unexpired, unused), sets the new hash, marks the token used, clears all lockout
   fields, increments `session_epoch`.
5. **First-time setup:** if `auth_state.pin_hash` is null, the PIN screen shows "Set up PIN",
   which runs the same email flow. No initial PIN ever lives in code or env vars.

### 4.5 Supabase access after lockdown
- `links`, `settings`: RLS on. Policy: `anon` may **select** only. No insert/update/delete for
  `anon`/`authenticated`.
- `projects`, `milestones`, `categories`, `deadlines`, `timeline_prefs`, `auth_state`,
  `reset_tokens`: RLS on, **no policies** for `anon`/`authenticated`. Only the server's secret
  key (which bypasses RLS) can touch them.
- The publishable key in `index.html` therefore can read links/settings and nothing else.

### 4.6 Headers and misc
- `projects.html` and all `/api/*` except `timeline`: `Cache-Control: no-store`.
- `/projects`: `X-Robots-Tag: noindex, nofollow` + `<meta name="robots" content="noindex">`.
- Site-wide: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Frame-Options: DENY` (the Windy radar is embedded *into* the page, which is unaffected).
- All user-entered text rendered with `textContent`, never `innerHTML`, to prevent script injection.
- Links entered in projects must be `https://` URLs; reject `javascript:` etc. Same check in
  `api/links.js`.

---

## 5. Data model (Supabase SQL)

Run as a migration in the existing Supabase project. Keep the SQL in `docs/sql/` (excluded from
deploy) so it is versioned.

```sql
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
```

**Pipelines**
- `research`: Idea → IRB → Data Collection → Analysis → Writing → Submitted → Accepted →
  Presented → Published.
- `simple`: Not started → Active → Done.
- `custom`: whatever is in `categories.statuses`, in order.
- `none`: no status; the project is just a date range with milestones.

Built-in categories can be renamed/recolored but not deleted while projects use them. Custom
categories can be deleted only when empty (or after moving their projects).

The **links/settings RLS change** is a separate migration run in Phase 2 (§9), not here.

---

## 6. UI specification

### 6.1 `projects.html` (dashboard)

**PIN screen** (always first)
- Centered card, 4 large digit boxes, numeric keypad input (`inputmode="numeric"`,
  `autocomplete="one-time-code"` off; `autocomplete="off"`), auto-submit on 4th digit.
- States: idle, wrong PIN ("Incorrect. 3 attempts left"), locked ("Locked for 14 min. Check your
  email for a reset link."), hard-locked ("Locked. Use the reset link sent to your email."),
  first-time ("Set up PIN" → sends email), reset-link landing ("Set a new PIN" ×2).
- "Forgot PIN?" link → `request-reset`.

**Dashboard** (after unlock), per the mockup:
1. Top bar: page title, view tabs (**Timeline** / Board (Phase 3) / **List**), Filter, **New project**,
   **Lock** button (clears token immediately), overflow menu with **Export data** and **Manage
   categories**.
2. Counts row: Active projects, Due next 30 days, Overdue, Waiting on others, Stale (no update
   in 14+ days). Each count is clickable to filter the list.
3. Timeline card (see §6.3).
4. Sidebar: **Next 30 days** (milestones + deadlines, overdue highlighted) and **Waiting on**
   (who, project, since when; amber after 14 days).
5. All-projects table: Project, Category, Status, Next action, Role, Links, Updated. Row click →
   project drawer.

**Project drawer / editor** (side panel on desktop, full screen on phone)
- All `projects` fields. Status dropdown shows the category's pipeline (hidden for `none`).
- Milestones list: add/edit/delete, check off done.
- Links list: label + https URL.
- Delete project (confirm dialog). Archive instead of delete is the default action.

**Manage categories**
- List with name, color swatch, pipeline type, project count.
- Add/edit: name, color (preset swatches + hex), pipeline (`research`/`simple`/`custom`/`none`).
  For `custom`, an ordered editable list of status names.

**Deadlines & events**
- Add standalone dated items (name, date, kind, optional category, show on timeline).
- Conference deadlines render as dashed vertical lines across the timeline with a label.

**Responsive:** works on a phone (sidebar stacks below; timeline scrolls horizontally inside its
card; touch targets ≥ 44px).

**Auto-lock:** any API call refreshes the token. A client-side idle timer (30 min of no
input/API activity) clears the token and returns to the PIN screen; the server's `exp` enforces it
regardless.

### 6.2 Homepage timeline strip (`index.html`)
- New full-width card **after all link cards** (and after the Residency Admin card), before the
  weather row. Respects the existing tile alpha / font-size settings.
- Header: icon + "Projects", "N active" and "N overdue" chips, "Open dashboard →".
- Body: compact timeline (project name column + bars + milestone diamonds + today line +
  conference/deadline markers), same window as the dashboard.
- Entire card is one link: `<a href="/projects" target="_blank" rel="noopener">`.
- Data from `GET /api/timeline`, which returns **only**: project id, title, category color,
  status, start/end dates, milestone dates and done flags (**no milestone names**), deadlines
  marked `show_on_timeline` (name + date + kind), counts (active, overdue), and the timeline
  window. Never next actions, notes, links, people, or roles.
- `api/timeline` response: `Cache-Control: public, s-maxage=60, stale-while-revalidate=300`.
- Empty state: "No projects yet. Open dashboard to add one."
- Error state: quiet one-line message; never breaks the rest of the homepage.

### 6.3 Timeline component and window control
- One shared renderer used by both pages (inline in each file, or a shared `timeline.js` added to
  the service worker's shell list). Pure function: `(data, window, today) → DOM`.
- Default window: rolling, **1 month back → 8 months ahead**, from the first of the month.
- **Window control** on the dashboard timeline card:
  - Presets: 3 mo, 6 mo, **9 mo (default)**, 12 mo, 18 mo, 24 mo.
  - "Months back" stepper (0–24).
  - Custom fixed range: start and end month pickers.
  - Zoom: Ctrl/⌘+scroll or pinch changes months shown; drag to pan.
  - "Reset to default" button.
  - Changes apply instantly. "Save as default" writes `timeline_prefs` (also changes the
    homepage strip). Unsaved changes last only for that dashboard session.
- Month grid adapts: weekly ticks under 4 months, monthly 4–18, quarterly above 18.
- Bars clipped at window edges show a small arrow indicating they continue.
- Today line in accent blue; overdue milestones red; done milestones hollow.

### 6.4 Homepage edit mode
- Clicking the existing edit toggle opens a small PIN modal (same 4-box input, same lockout
  messages). Correct PIN → edit mode on, token held in memory.
- All link add/edit/delete/reorder calls go to `/api/links` with the token.
- Settings: appearance changes still apply instantly on this device (localStorage, as today).
  **Cloud sync of settings only happens while unlocked** (edit mode on); `pushSettings()` posts
  to `/api/settings`. When locked, changes stay local to that browser. The on-load upsert must be
  removed; on-load is read-only.
- Leaving edit mode or 30 min idle discards the token.

---

## 7. Environment variables (Vercel → Settings → Environment Variables)

| Name | Value | Scope |
|---|---|---|
| `SUPABASE_URL` | `https://rrjnvgufodklgkrnhzwu.supabase.co` | Production, Preview |
| `SUPABASE_SECRET_KEY` | Supabase → Settings → API keys → **secret** key (`sb_secret_…`) | Production, Preview |
| `SESSION_SECRET` | 64 random hex chars | Production, Preview (different values) |
| `PIN_PEPPER` | 64 random hex chars | Production, Preview (different values) |
| `RESEND_API_KEY` | Resend API key | Production, Preview |
| `ALERT_EMAIL` | Jordan's personal Gmail | Production, Preview |
| `RESET_FROM_EMAIL` | `onboarding@resend.dev` unless a domain is verified in Resend | Production, Preview |
| `APP_URL` | `https://jbw-homepage.vercel.app` (Preview: leave unset; derive from `VERCEL_URL`) | Production |

Notes
- Resend's shared `onboarding@resend.dev` sender only delivers to the email address that owns the
  Resend account. Confirm the Resend account uses the same Gmail as `ALERT_EMAIL`, or verify a
  domain.
- Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- If any secret is ever exposed, rotate it in Vercel and redeploy. Rotating `SESSION_SECRET` logs
  out every session; rotating `PIN_PEPPER` invalidates the PIN (use the reset flow).

---

## 8. Testing

Keep the current Playwright suite green. CI has **no secrets**, so:
- Server logic in `api/_lib/` takes an injectable store and mailer. Tests use an in-memory store and
  a fake mailer that records messages. Test via a tiny `node --test` suite **or** Playwright
  `request` against `serve.mjs` with `TEST_MODE=1` wiring in-memory deps (never enabled in Vercel;
  guard so `TEST_MODE` is ignored when `VERCEL` is set).
- UI tests stub `/api/*` with `page.route`, like `tests/helpers.js` does for Supabase.

New specs
- `auth.spec.js` / `lockout` unit tests:
  - Correct PIN → token; wrong PIN decrements remaining attempts.
  - 5 wrong → 423 locked, exactly one email, reset link present.
  - Locked state does not evaluate the PIN (a correct PIN while locked still returns 423).
  - Auto-expiry after 15 min (fake clock) for the first lockout.
  - Second lockout without success → hard lock, no auto-expiry.
  - Correct PIN resets counters.
  - Reset token: works once, expires after 30 min, wrong token rejected, reset increments
    `session_epoch` and old tokens fail.
  - `request-reset` rate limit and generic response.
  - Token: tampered signature rejected, expired rejected, sliding refresh works.
- `projects-page.spec.js`: PIN screen shows first; unlock renders dashboard from stubbed data;
  refresh returns to PIN screen; Lock button works; idle timeout (fake timers) re-locks; nothing
  written to localStorage/sessionStorage/cookies containing the token.
- `projects-crud.spec.js` (stubbed API): create/edit/archive project, milestones, custom category
  with custom statuses, `none` pipeline hides status, deadline appears on timeline, export
  downloads JSON.
- `timeline.spec.js`: default window is −1/+8 months from `FIXED_NOW`; presets and custom range
  change columns; bars clip at edges; today line position; "Save as default" calls API.
- `home-strip.spec.js`: strip renders below all cards from stubbed `/api/timeline`; it is an `<a>`
  to `/projects` with `target="_blank"` and `rel="noopener"`; empty and error states; counts chips.
- `edit-mode.spec.js`: toggling edit mode prompts for PIN; link writes go to `/api/links` with
  bearer token; no direct Supabase write requests from the browser (assert via request
  listener); settings sync only while unlocked.
- Update `links.spec.js` / `layout.spec.js` for the new strip and the removed on-load upsert.

Manual checks on the Vercel **preview** before merge (with preview env vars set):
real email arrives at Gmail; reset link opens and sets PIN; lockout timing; phone layout.

---

## 9. Build order (each phase = its own PR; tests green before merge)

### Phase 0 — Prep (no behavior change)
- Add `.env*` to `.gitignore`, `docs/` to `.vercelignore`, `vercel.json` with headers and
  `/projects` clean URL.
- **Jordan:** add env vars from §7 in Vercel (Production + Preview). Check Supabase policies on
  `links`/`settings` and note what's there.

### Phase 1 — Auth backend + tracker tables
- Run §5 SQL migration.
- `api/_lib/*`, `api/auth.js`, unit tests from §8.
- No UI yet. Verify on preview: first-time "set up PIN" email arrives and the PIN can be set.

### Phase 2 — Lock down homepage edits (**order matters**)
1. Ship `api/links.js`, `api/settings.js`, PIN modal for edit mode, remove browser writes and
   the on-load upsert. Merge and confirm on production that edit mode works through the API.
2. **Only after step 1 is live**, run the RLS migration making `links`/`settings` read-only for
   `anon`. (Doing this first would break edit mode.)
3. Verify: with edit mode off, a direct Supabase write using the publishable key fails.

### Phase 3 — Dashboard (core)
- `projects.html`: PIN screen, counts, timeline with window control, sidebar, project table,
  project drawer, milestones, categories manager (incl. custom statuses and `none`),
  deadlines/events, Lock button, idle auto-lock, export.
- `api/projects.js`, `api/export.js`.
- Tests from §8. Mobile pass.

### Phase 4 — Homepage strip
- `api/timeline.js`, strip in `index.html`, `sw.js` cache bump, tests.

### Phase 5 — Later (backlog, not in this build)
- Board (kanban) view with drag between statuses.
- CV export: accepted/presented/published items as formatted citations.
- Calendar feed (`.ics`) of milestones and deadlines for Google Calendar (tokenized private URL).
- Weekly Monday digest email (Vercel cron + Resend): due this week, overdue, stale, waiting on.
- Per-project activity log UI (table already exists).
- IRB approval/expiration fields and continuing-review reminders.
- Optional "short public label" per project for the homepage strip.
- Make the GitHub repo private.

---

## 10. Starter data (enter after Phase 3)
- Conference deadlines for the fellowship year (July 2027–June 2028): CHEST 2027 and SCCM 2028
  abstract deadlines. Look up and enter the official dates once announced; mark kind =
  `conference`.
- Fellowship onboarding items (licensure, credentialing, DEA, start date July 2027) under
  Fellowship/Admin.

## 11. Definition of done
- Dashboard data is unreachable without the PIN (no public endpoint returns private fields).
- Homepage links and settings cannot be changed with the publishable key.
- 5 wrong PINs lock and email; second lockout requires the email reset.
- Strip on the homepage always visible and opens `/projects` in a new tab.
- Every page works on a phone. All tests pass in CI.
