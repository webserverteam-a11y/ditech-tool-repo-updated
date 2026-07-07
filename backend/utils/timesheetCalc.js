/**
 * timesheetCalc.js — Pure time-math helpers for the Unified Timesheet panel.
 *
 * Reimplements (server-side, from scratch) the same event-pairing semantics
 * the existing (bundle-only) Timesheet tab uses, so Logged/Productive/Overrun
 * figures stay consistent with it. Only consumed by
 * backend/routes/unified-timesheet.routes.js — does not touch any existing
 * route or table.
 *
 * Two related-but-different durations are computed per task:
 *   - "gross" (session) time — wall-clock elapsed from a `start` event to its
 *     matching `end` event, including any `pause` gaps in between. Shown as
 *     "Actual time taken".
 *   - "net" (active) time — sum of `start|resume|rework_start` → next
 *     `pause|end` sub-intervals, i.e. time actually worked. Shown as
 *     "Logged", and used for Productive/Overrun/Rework math, matching the
 *     existing Timesheet's definitions.
 */

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

function parseTs(ts) {
  const n = Date.parse(ts);
  return Number.isNaN(n) ? null : n;
}

/**
 * Pairs a task's time events (already filtered to one owner, any order) into
 * gross sessions and net active intervals.
 *
 * @param {{event_type:string, timestamp:string}[]} events
 * @returns {{ sessions: {startMs:number, endMs:number|null}[],
 *             netIntervals: {startMs:number, endMs:number|null, kind:'work'|'rework'}[] }}
 */
function pairEvents(events) {
  const sorted = events
    .map(e => ({ type: e.event_type, ts: parseTs(e.timestamp) }))
    .filter(e => e.ts !== null)
    .sort((a, b) => a.ts - b.ts);

  const sessions = [];
  const netIntervals = [];
  let sessionStart = null;
  let netStart = null;
  let netKind = null;

  for (const ev of sorted) {
    const t = ev.ts;
    if (ev.type === 'start' || ev.type === 'resume' || ev.type === 'rework_start') {
      if (sessionStart === null) sessionStart = t;
      if (netStart === null) {
        netStart = t;
        netKind = ev.type === 'rework_start' ? 'rework' : 'work';
      }
    } else if (ev.type === 'pause') {
      if (netStart !== null) {
        netIntervals.push({ startMs: netStart, endMs: t, kind: netKind });
        netStart = null;
        netKind = null;
      }
      // Gross session stays open across a pause — it only ends on `end`.
    } else if (ev.type === 'end') {
      if (netStart !== null) {
        netIntervals.push({ startMs: netStart, endMs: t, kind: netKind });
        netStart = null;
        netKind = null;
      }
      if (sessionStart !== null) {
        sessions.push({ startMs: sessionStart, endMs: t });
        sessionStart = null;
      }
    }
  }

  // Trailing open state — task/session still running. Leave endMs null;
  // callers clip this to "now" (or the query window) when summing.
  if (netStart !== null) netIntervals.push({ startMs: netStart, endMs: null, kind: netKind });
  if (sessionStart !== null) sessions.push({ startMs: sessionStart, endMs: null });

  return { sessions, netIntervals };
}

/**
 * Sums the overlap of a set of {startMs, endMs|null} intervals with a
 * [fromMs, toMs] window. `fromMs`/`toMs` may each be null for "unbounded".
 * An open-ended interval (endMs === null) is clipped to `nowMs`.
 */
function sumOverlapMs(intervals, fromMs, toMs, nowMs, kindFilter) {
  let total = 0;
  for (const iv of intervals) {
    if (kindFilter && iv.kind !== kindFilter) continue;
    const end = iv.endMs === null ? nowMs : iv.endMs;
    const effFrom = fromMs === null || fromMs === undefined ? iv.startMs : Math.max(iv.startMs, fromMs);
    const effTo = toMs === null || toMs === undefined ? end : Math.min(end, toMs);
    if (effTo > effFrom) total += effTo - effFrom;
  }
  return total;
}

/** Resolves which department's estimate applies to this owner on this task. */
function primaryDept(task, stakeholder) {
  if (task.seoOwner === stakeholder) return 'seo';
  if (task.contentOwner === stakeholder) return 'content';
  if (task.webOwner === stakeholder) return 'web';
  return 'generic';
}

function estMsForDept(task, dept) {
  const hours =
    dept === 'seo' ? task.estHoursSEO :
    dept === 'content' ? task.estHoursContent :
    dept === 'web' ? task.estHoursWeb :
    task.estHours;
  return (Number(hours) || 0) * HOUR_MS;
}

function productiveMs(loggedMs, estMs) {
  return Math.min(loggedMs, estMs);
}

function overrunMs(loggedMs, estMs) {
  return Math.max(0, loggedMs - estMs);
}

/** UTC calendar-day bounds in ms for a 'YYYY-MM-DD' string. */
function dayBoundsMs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const from = Date.UTC(y, m - 1, d);
  return { from, to: from + DAY_MS };
}

/** Monday–Sunday week (as 7 'YYYY-MM-DD' strings) containing dateStr. */
function weekBounds(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0=Sun..6=Sat
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(Date.UTC(y, m - 1, d + mondayOffset));

  const days = [];
  for (let i = 0; i < 7; i++) {
    const dd = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + i));
    days.push(dd.toISOString().slice(0, 10));
  }
  return { weekStart: days[0], weekEnd: days[6], days };
}

/** All days (as 'YYYY-MM-DD' strings) in the calendar month containing dateStr. */
function monthDays(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days = [];
  for (let day = 1; day <= daysInMonth; day++) {
    days.push(new Date(Date.UTC(y, m - 1, day)).toISOString().slice(0, 10));
  }
  return { monthStart: days[0], monthEnd: days[days.length - 1], days };
}

const MAX_CUSTOM_RANGE_DAYS = 186; // ~6 months, keeps the table from growing unbounded

/** Inclusive list of 'YYYY-MM-DD' strings between fromStr and toStr (capped). */
function customDays(fromStr, toStr) {
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  const [ty, tm, td] = toStr.split('-').map(Number);
  let fromMs = Date.UTC(fy, fm - 1, fd);
  let toMs = Date.UTC(ty, tm - 1, td);
  if (fromMs > toMs) [fromMs, toMs] = [toMs, fromMs];

  const maxToMs = fromMs + (MAX_CUSTOM_RANGE_DAYS - 1) * DAY_MS;
  if (toMs > maxToMs) toMs = maxToMs;

  const days = [];
  for (let t = fromMs; t <= toMs; t += DAY_MS) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return { rangeStart: days[0], rangeEnd: days[days.length - 1], days };
}

/** Aggregation window (ms) for a range pill, anchored at dateStr. */
function rangeBounds(dateStr, range, customFrom, customTo) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dayFrom = Date.UTC(y, m - 1, d);

  switch (range) {
    case 'today':
      return { from: dayFrom, to: dayFrom + DAY_MS };
    case 'yesterday':
      return { from: dayFrom - DAY_MS, to: dayFrom };
    case 'week': {
      const { weekStart } = weekBounds(dateStr);
      const [wy, wm, wd] = weekStart.split('-').map(Number);
      const from = Date.UTC(wy, wm - 1, wd);
      return { from, to: from + 7 * DAY_MS };
    }
    case 'month': {
      const from = Date.UTC(y, m - 1, 1);
      const to = Date.UTC(y, m, 1);
      return { from, to };
    }
    case 'custom': {
      const { rangeStart, rangeEnd } = customDays(customFrom, customTo);
      const [sy, sm, sd] = rangeStart.split('-').map(Number);
      const [ey, em, ed] = rangeEnd.split('-').map(Number);
      return { from: Date.UTC(sy, sm - 1, sd), to: Date.UTC(ey, em - 1, ed) + DAY_MS };
    }
    default:
      return { from: dayFrom, to: dayFrom + DAY_MS };
  }
}

/**
 * Which days the table's day-by-day matrix should show, per range:
 *  - 'month'  → every day in that calendar month (scrollable)
 *  - 'custom' → every day in the user-picked from/to range (scrollable, capped)
 *  - anything else (today/yesterday/week) → the Monday-Sunday week containing dateStr
 */
function matrixDaysForRange(dateStr, range, customFrom, customTo) {
  if (range === 'month') {
    const { monthStart, monthEnd, days } = monthDays(dateStr);
    return { matrixStart: monthStart, matrixEnd: monthEnd, days };
  }
  if (range === 'custom' && customFrom && customTo) {
    const { rangeStart, rangeEnd, days } = customDays(customFrom, customTo);
    return { matrixStart: rangeStart, matrixEnd: rangeEnd, days };
  }
  const { weekStart, weekEnd, days } = weekBounds(dateStr);
  return { matrixStart: weekStart, matrixEnd: weekEnd, days };
}

export {
  HOUR_MS,
  DAY_MS,
  MAX_CUSTOM_RANGE_DAYS,
  parseTs,
  pairEvents,
  sumOverlapMs,
  primaryDept,
  estMsForDept,
  productiveMs,
  overrunMs,
  dayBoundsMs,
  weekBounds,
  monthDays,
  customDays,
  rangeBounds,
  matrixDaysForRange,
};
