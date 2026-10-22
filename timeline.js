// Shared timeline renderer for projects.html (and the homepage strip, plan §6.2–6.3).
// Plain script, no dependencies: exposes window.JBWTimeline. Everything that decides *where*
// things go is a pure function of (data, window, today) so it can be tested without a browser.
(function (root) {
  'use strict';

  // Keep in step with PIPELINES in api/projects.js (a test checks they match).
  const PIPELINES = {
    research: ['Idea', 'IRB', 'Data Collection', 'Analysis', 'Writing', 'Submitted', 'Accepted', 'Presented', 'Published'],
    simple: ['Not started', 'Active', 'Done'],
  };
  const DEFAULT_PREFS = { mode: 'rolling', months_back: 1, months_ahead: 8, fixed_start: null, fixed_end: null };
  const PRESETS = [3, 6, 9, 12, 18, 24];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ── Dates: 'YYYY-MM-DD' strings in, local-midnight Dates inside (no UTC day shifts) ──
  function parseDay(s) {
    if (!s) return null;
    const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
  const monthStart = d => new Date(d.getFullYear(), d.getMonth(), 1);
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const monthsBetween = (a, b) => (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());

  /**
   * The visible window: { start, end, months } with start = the 1st of a month and end exclusive.
   * Rolling: months_back before the current month, months_ahead counting the current month,
   * so the default 1/8 shows 9 months. Fixed: fixed_start's month through fixed_end's month.
   */
  function computeWindow(prefs, today) {
    const p = { ...DEFAULT_PREFS, ...(prefs || {}) };
    let start, end;
    if (p.mode === 'fixed' && p.fixed_start && p.fixed_end) {
      start = monthStart(parseDay(p.fixed_start));
      end = addMonths(monthStart(parseDay(p.fixed_end)), 1);
    } else {
      const cur = monthStart(today);
      start = addMonths(cur, -p.months_back);
      end = addMonths(cur, p.months_ahead);
    }
    if (end <= start) end = addMonths(start, 1);
    return { start, end, months: monthsBetween(start, end) };
  }

  /** Prefs for a preset length, keeping how far back the window starts. */
  function presetPrefs(prefs, months) {
    const back = Math.min((prefs && prefs.mode === 'rolling' ? prefs.months_back : 1) ?? 1, months - 1);
    return { ...DEFAULT_PREFS, months_back: back, months_ahead: months - back };
  }

  /** Zoom (+1 = more months) or pan (+1 = later) a window, returning new fixed prefs. */
  function zoomPrefs(win, deltaMonths) {
    const months = Math.max(1, Math.min(36, win.months + deltaMonths));
    const center = addMonths(win.start, Math.floor(win.months / 2));
    const start = addMonths(center, -Math.floor(months / 2));
    return { ...DEFAULT_PREFS, mode: 'fixed', fixed_start: ymd(start), fixed_end: ymd(addMonths(start, months - 1)) };
  }
  function panPrefs(win, deltaMonths) {
    const start = addMonths(win.start, deltaMonths);
    return { ...DEFAULT_PREFS, mode: 'fixed', fixed_start: ymd(start), fixed_end: ymd(addMonths(start, win.months - 1)) };
  }

  /** Position of a date across the window, 0–100 (unclamped). */
  function pct(win, d) {
    return ((d - win.start) / (win.end - win.start)) * 100;
  }

  /**
   * Column ticks. Weekly under 4 months, monthly for 4–18, quarterly above 18.
   * Each: { pos, label, major } where major ticks start a month (or a quarter).
   */
  function ticks(win) {
    const out = [];
    const monthLabel = (d, i) => (d.getMonth() === 0 || i === 0 ? `${MONTHS[d.getMonth()]} '${String(d.getFullYear()).slice(2)}` : MONTHS[d.getMonth()]);
    if (win.months < 4) {
      for (let i = 0; i < win.months; i++) {
        const m = addMonths(win.start, i);
        out.push({ pos: pct(win, m), label: monthLabel(m, i), major: true });
        for (let d = new Date(m); d < addMonths(m, 1); d.setDate(d.getDate() + 1)) {
          if (d.getDay() === 1 && d.getDate() !== 1) out.push({ pos: pct(win, d), label: String(d.getDate()), major: false });
        }
      }
    } else if (win.months <= 18) {
      for (let i = 0; i < win.months; i++) {
        const m = addMonths(win.start, i);
        out.push({ pos: pct(win, m), label: monthLabel(m, i), major: true });
      }
    } else {
      for (let i = 0; i < win.months; i++) {
        const m = addMonths(win.start, i);
        if (m.getMonth() % 3 === 0 || i === 0) {
          out.push({ pos: pct(win, m), label: `Q${Math.floor(m.getMonth() / 3) + 1} '${String(m.getFullYear()).slice(2)}`, major: true });
        }
      }
    }
    return out;
  }

  /**
   * Lay out one project's bar and milestones inside the window.
   * project: { start, end, created, milestones: [{ date, done, name? }] } with 'YYYY-MM-DD' strings.
   * Returns { bar: { left, width, clipLeft, clipRight, open } | null, marks: [{ pos, state, name }] }.
   */
  function layoutProject(project, win, today) {
    const s = parseDay(project.start) || parseDay(project.created);
    const e = parseDay(project.end);
    let bar = null;
    if (s) {
      const open = !e;
      const endDay = e ? new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1) : win.end;
      const left = pct(win, s), right = pct(win, endDay);
      if (right > 0 && left < 100) {
        const l = Math.max(0, left), r = Math.min(100, right);
        bar = { left: l, width: r - l, clipLeft: left < 0, clipRight: right > 100 || (open && right >= 100), open };
      }
    }
    const t = startOfDay(today);
    const marks = (project.milestones || []).map(m => {
      const d = parseDay(m.date);
      return { pos: pct(win, d), state: m.done ? 'done' : d < t ? 'overdue' : 'upcoming', name: m.name };
    }).filter(m => m.pos >= 0 && m.pos <= 100);
    return { bar, marks };
  }

  // ── DOM ──
  function el(tag, cls, attrs) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') n.textContent = v;
      else if (k === 'style') Object.assign(n.style, v);
      else n.setAttribute(k, v);
    }
    return n;
  }

  /**
   * Render into `container` (replacing its contents).
   * data: { projects: [{ id, title, subtitle?, color, status?, start, end, created, milestones, stale? }],
   *         deadlines: [{ name, date, kind }] }
   * opts: { compact, onProjectClick(id), nameWidth }
   */
  // Styles travel with the component so both pages render it the same way.
  const CSS = `
.tl{--tl-line:#27272a;--tl-grid:#222226;--tl-muted:#a1a1aa;--tl-today:#60a5fa;--tl-conf:#a78bfa;--tl-red:#f87171;--tl-ms:#f0f0f0;--tl-row:#1f1f23;
  font-size:14px;min-width:640px;user-select:none}
.tl-row{display:flex;align-items:stretch}
.tl-name{width:var(--tl-name);flex-shrink:0;padding:12px 12px 12px 0;box-sizing:border-box;min-width:0}
.tl-title{font-weight:500;color:inherit;display:flex;align-items:center;gap:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl-sub{font-size:12px;color:var(--tl-muted);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tl-badge{font-size:11px;font-weight:600;color:#0a0a0a;background:#fcd34d;border-radius:6px;padding:2px 6px}
.tl-head .tl-name{padding:0}
.tl-scale{flex:1;position:relative;height:28px;border-bottom:1px solid var(--tl-line)}
.tl-tick{position:absolute;top:4px;font-size:12px;color:var(--tl-muted);white-space:nowrap;padding-left:4px}
.tl-tick:not(.major){font-size:10px;opacity:.75}
.tl-project{border-bottom:1px solid var(--tl-row)}
.tl-project.clickable{cursor:pointer}
.tl-project.clickable:hover .tl-title,.tl-project.clickable:focus-visible .tl-title{color:#93c5fd}
.tl-project:focus-visible{outline:2px solid var(--tl-today);outline-offset:-2px;border-radius:6px}
.tl-track{flex:1;position:relative;min-height:64px}
.tl-compact .tl-track{min-height:44px}
.tl-compact .tl-name{padding:8px 12px 8px 0;font-size:14px;display:flex;align-items:center}
.tl-grid{position:absolute;top:0;bottom:0;width:1px;background:var(--tl-grid)}
.tl-today{position:absolute;top:0;bottom:0;width:2px;margin-left:-1px;background:var(--tl-today);z-index:2}
.tl-mark{position:absolute;top:0;bottom:0;width:0;border-left:2px dotted #71717a;z-index:1}
.tl-mark-conference{border-left:2px dashed var(--tl-conf)}
.tl-mark-event{border-left-color:#2dd4bf}
.tl-bar{position:absolute;top:50%;transform:translateY(-50%);height:28px;border-radius:8px;box-sizing:border-box;
  background:color-mix(in srgb,var(--c) 18%,transparent);border:1px solid var(--c);display:flex;align-items:center;
  padding:0 10px;gap:6px;font-size:12px;color:color-mix(in srgb,var(--c) 45%,#fff);overflow:hidden;white-space:nowrap}
.tl-compact .tl-bar{height:20px;border-radius:6px;padding:0 6px}
.tl-bar.open{border-style:dashed}
.tl-bar.clip-left{border-top-left-radius:0;border-bottom-left-radius:0;border-left-width:0}
.tl-bar.clip-right{border-top-right-radius:0;border-bottom-right-radius:0;border-right-width:0}
.tl-bar-label{overflow:hidden;text-overflow:ellipsis}
.tl-arrow{font-size:16px;line-height:1;opacity:.85}
.tl-arrow-right{margin-left:auto}
.tl-ms{position:absolute;top:50%;width:12px;height:12px;transform:translate(-50%,-50%) rotate(45deg);z-index:3;box-sizing:border-box;background:var(--tl-ms)}
.tl-compact .tl-ms{width:10px;height:10px}
.tl-ms-overdue{background:var(--tl-red)}
.tl-ms-done{background:transparent;border:2px solid var(--tl-ms)}
.tl-labels{flex:1;position:relative;height:28px;font-size:12px}
.tl-label{position:absolute;top:8px;transform:translateX(-50%);white-space:nowrap;color:var(--tl-muted)}
.tl-label-today{color:#93c5fd}
.tl-label-conference{color:#c4b5fd}
.tl-empty-row .tl-name{color:var(--tl-muted)}
`;
  function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById('jbw-tl-css')) return;
    const s = document.createElement('style');
    s.id = 'jbw-tl-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function render(container, data, win, today, opts = {}) {
    ensureStyles();
    container.textContent = '';
    const tl = el('div', 'tl' + (opts.compact ? ' tl-compact' : ''));
    tl.style.setProperty('--tl-name', `${opts.nameWidth || (opts.compact ? 220 : 230)}px`);
    tl.dataset.start = ymd(win.start);
    tl.dataset.end = ymd(win.end);
    tl.dataset.months = String(win.months);

    const todayPos = pct(win, startOfDay(today));
    const showToday = todayPos >= 0 && todayPos <= 100;
    const marks = (data.deadlines || []).map(d => ({ ...d, pos: pct(win, parseDay(d.date)) }))
      .filter(d => d.pos >= 0 && d.pos <= 100);

    const tickList = ticks(win);
    const head = el('div', 'tl-row tl-head');
    head.appendChild(el('div', 'tl-name'));
    const scale = el('div', 'tl-scale');
    for (const t of tickList) {
      scale.appendChild(el('div', 'tl-tick' + (t.major ? ' major' : ''), { text: t.label, style: { left: `${t.pos}%` } }));
    }
    head.appendChild(scale);
    tl.appendChild(head);

    const gridLines = track => {
      for (const t of tickList) if (t.major) track.appendChild(el('div', 'tl-grid', { style: { left: `${t.pos}%` } }));
      if (showToday) track.appendChild(el('div', 'tl-today', { style: { left: `${todayPos}%` } }));
      for (const d of marks) track.appendChild(el('div', `tl-mark tl-mark-${d.kind}`, { style: { left: `${d.pos}%` } }));
    };

    const projects = data.projects || [];
    if (!projects.length) {
      const row = el('div', 'tl-row tl-empty-row');
      row.appendChild(el('div', 'tl-name', { text: opts.emptyText || 'No projects yet' }));
      const track = el('div', 'tl-track');
      gridLines(track);
      row.appendChild(track);
      tl.appendChild(row);
    }

    for (const p of projects) {
      const row = el('div', 'tl-row tl-project');
      row.dataset.projectId = p.id;
      const name = el('div', 'tl-name');
      const title = el('div', 'tl-title', { text: p.title });
      if (p.stale) title.appendChild(el('span', 'tl-badge', { text: 'STALE' }));
      name.appendChild(title);
      if (p.subtitle && !opts.compact) name.appendChild(el('div', 'tl-sub', { text: p.subtitle }));
      if (opts.onProjectClick) {
        row.classList.add('clickable');
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', `Open ${p.title}`);
        row.addEventListener('click', () => opts.onProjectClick(p.id));
        row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onProjectClick(p.id); } });
      }
      row.appendChild(name);

      const track = el('div', 'tl-track');
      gridLines(track);
      const lay = layoutProject(p, win, today);
      if (lay.bar) {
        const b = lay.bar;
        const bar = el('div', 'tl-bar' + (b.clipLeft ? ' clip-left' : '') + (b.clipRight ? ' clip-right' : '') + (b.open ? ' open' : ''), {
          style: { left: `${b.left}%`, width: `${b.width}%` },
        });
        bar.style.setProperty('--c', p.color || '#60a5fa');
        if (b.clipLeft) bar.appendChild(el('span', 'tl-arrow tl-arrow-left', { text: '‹', 'aria-label': 'continues earlier' }));
        if (p.status && !opts.compact) bar.appendChild(el('span', 'tl-bar-label', { text: p.status }));
        if (b.clipRight) bar.appendChild(el('span', 'tl-arrow tl-arrow-right', { text: '›', 'aria-label': 'continues later' }));
        track.appendChild(bar);
      }
      for (const m of lay.marks) {
        const dot = el('div', `tl-ms tl-ms-${m.state}`, { style: { left: `${m.pos}%` } });
        if (m.name) dot.title = m.name;
        track.appendChild(dot);
      }
      row.appendChild(track);
      tl.appendChild(row);
    }

    // Labels for today and the dated markers, under the rows.
    const foot = el('div', 'tl-row tl-foot');
    foot.appendChild(el('div', 'tl-name'));
    const labels = el('div', 'tl-labels');
    if (showToday) labels.appendChild(el('span', 'tl-label tl-label-today', { text: 'Today', style: { left: `${todayPos}%` } }));
    for (const d of marks) labels.appendChild(el('span', `tl-label tl-label-${d.kind}`, { text: d.name, style: { left: `${d.pos}%` } }));
    foot.appendChild(labels);
    tl.appendChild(foot);

    container.appendChild(tl);
    return tl;
  }

  root.JBWTimeline = {
    PIPELINES, DEFAULT_PREFS, PRESETS,
    parseDay, ymd, addMonths, monthStart,
    computeWindow, presetPrefs, zoomPrefs, panPrefs, pct, ticks, layoutProject, render,
  };
})(typeof window !== 'undefined' ? window : globalThis);
