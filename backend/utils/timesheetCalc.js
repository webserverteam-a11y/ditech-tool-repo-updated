/**
 * timesheetCalc.js — Pure time-math helpers for the Unified Timesheet panel.
 *
 * Originally a FAITHFUL PORT of the original (bundle-only) Timesheet tab's
 * calculation functions, extracted verbatim from dist/assets/index-xUiSJVv5.js:
 *
 *   $n (byte ~289084) → loggedMsFromEvents()
 *   kr (byte ~289305) → filterEventsForOwner() + loggedMsFromEvents()
 *   Cr (byte ~289705) → productiveMs()
 *   ca (byte ~289809) → overrunMs()
 *   W0 (byte ~289991) → reworkMsFromEvents()
 *   Pn (byte ~288775) → estHoursForOwner()
 *
 * The two load-bearing semantics that MUST match the original exactly
 * (getting either wrong produced wildly inflated numbers):
 *
 * 1. Events are filtered to the date window FIRST (by the calendar-date part
 *    of the ISO timestamp, string-compared inclusively), and only then
 *    paired. A work interval that starts one day and closes days later
 *    contributes ZERO to every day in between — on any given day, either the
 *    opening or the closing event is missing from the window, so there is
 *    nothing to pair. Intervals are never split/prorated across days.
 *
 * 2. Pairing walks events in order keeping a single pending-open timestamp:
 *    an opening event (start/resume/rework_start) OVERWRITES the pending
 *    open; a closing event (pause/end) adds (t - pending) and clears it.
 *    A dangling open (no close in window) contributes zero.
 *
 * DELIBERATE DIVERGENCE from the original bundle's kr(), 2026-08-17: the
 * owner-matching step used to fall back to crediting a blank-owner event to
 * whoever currently holds the task's department-owner field (see the old
 * DEPT_OWNER_FIELD branch, kept below for reference but no longer used for
 * matching). That fallback silently attributed OTHER people's timer actions
 * to the current task owner. The most common source: every "admin"-role
 * account has ownerName forced to "" by the Add-User form
 * (`K.role==="admin"?"":...` in the bundle) and by the built-in admin seed
 * user — so any start/pause/end an admin performs on a task (closing it out,
 * bulk-ending overdue items, etc.) is recorded with owner:"" and, under the
 * old logic, got fully credited as the task's web/content/SEO owner's own
 * logged time. That's how a task with ~48m of real work (confirmed against
 * the Action Board's own "Active Time", which matches strictly on
 * owner===currentUser with no department fallback) could show 3h42m in the
 * Unified Timesheet. Since blank owner means "we don't know who did this",
 * filterEventsForOwner now excludes those events from any individual's
 * personal timesheet rather than guessing — see below.
 *
 * This means the Unified Timesheet panel can now show LOWER numbers than
 * the original (bundle-only) Timesheet tab for the same task/day whenever
 * blank-owner events are involved — that's the fix, not a new bug: the
 * original tab still has the over-attribution behaviour described above
 * (unchanged, out of scope here — see backend/routes/unified-timesheet.routes.js
 * header for why this file never touches the bundle or other routes).
 *
 * Only consumed by backend/routes/unified-timesheet.routes.js — does not
 * touch any existing route or table.
 */

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

/**
 * Event department → task owner-field. No longer used to match ownership
 * (see divergence note above) — kept only as documentation of the mapping
 * blank-owner events used to be (mis)attributed through.
 */
const DEPT_OWNER_FIELD = {
  SEO: 'seoOwner',
  Content: 'contentOwner',
  Web: 'webOwner',
  Ads: 'adsOwner',
  Design: 'designOwner',
  Social: 'socialOwner',
  Webdev: 'webdevOwner',
};

/** Calendar-date part of an ISO timestamp, as the bundle does: split('T')[0]. */
function eventDay(timestamp) {
  return String(timestamp || '').split('T')[0];
}

/**
 * Keep events whose calendar date falls inside [fromStr, toStr] (inclusive,
 * string compare; either bound may be null for unbounded) AND whose `owner`
 * exactly matches this stakeholder. Events with no `owner` recorded are
 * excluded — we can't reliably tell who performed them (most commonly an
 * admin-role action; see the divergence note in this file's header), so
 * they're left out of everyone's personal timesheet rather than being
 * guessed onto the task's current department owner.
 */
function filterEventsForOwner(task, events, stakeholder, fromStr, toStr) {
  return (events || []).filter(e => {
    const day = eventDay(e.timestamp);
    if (!day) return false;
    if (fromStr && day < fromStr) return false;
    if (toStr && day > toStr) return false;
    return !!e.owner && e.owner === stakeholder;
  });
}

/** Date-window-only filter (no owner check) — W0 filters rework events this way. */
function filterEventsInWindow(events, fromStr, toStr) {
  return (events || []).filter(e => {
    const day = eventDay(e.timestamp);
    if (!day) return false;
    if (fromStr && day < fromStr) return false;
    if (toStr && day > toStr) return false;
    return true;
  });
}

/**
 * Port of $n(): net logged ms from an (already filtered) event list.
 * Opening events overwrite the pending start; pause/end closes it.
 *
 * Optional `nowMs`: if the list ends with a dangling open (task is still
 * running — no pause/end for it yet), credit (nowMs - open) as logged too.
 * Without this, a freshly-started task reports 0ms until its first pause,
 * which was hiding still-running tasks from the panel entirely (they'd only
 * appear after being paused/resumed once, which finally produces a closed
 * pair). Callers only pass `nowMs` for windows that include the current
 * moment (e.g. today's cell) — never for past/closed windows, so stale
 * orphaned opens from earlier days aren't misread as still accruing time.
 */
function loggedMsFromEvents(events, nowMs) {
  let total = 0;
  let open = null;
  for (const e of events || []) {
    const t = Date.parse(e.timestamp);
    if (Number.isNaN(t)) continue;
    if (e.type === 'start' || e.type === 'resume' || e.type === 'rework_start') {
      open = t;
    } else if ((e.type === 'pause' || e.type === 'end') && open) {
      total += t - open;
      open = null;
    }
  }
  if (open !== null && nowMs) total += Math.max(0, nowMs - open);
  return total;
}

/**
 * Port of W0()'s inner loop: rework ms from an (already window-filtered)
 * event list — pairs rework_start → next pause/end. Returns 0 if the window
 * contains no rework_start at all (W0's early exit).
 *
 * Optional `nowMs`: same live-open credit as loggedMsFromEvents(), for the
 * same reason — a task freshly moved into rework shouldn't read as 0 rework
 * time (and vanish from the Rework stat) just because it hasn't been
 * paused/ended yet.
 */
function reworkMsFromEvents(events, nowMs) {
  const list = events || [];
  if (!list.some(e => e.type === 'rework_start')) return 0;
  let total = 0;
  let inRework = false;
  let open = null;
  for (const e of list) {
    const t = Date.parse(e.timestamp);
    if (Number.isNaN(t)) continue;
    if (e.type === 'rework_start') {
      inRework = true;
      open = t;
    } else if (inRework && (e.type === 'pause' || e.type === 'end') && open) {
      total += t - open;
      inRework = false;
      open = null;
    }
  }
  if (inRework && open !== null && nowMs) total += Math.max(0, nowMs - open);
  return total;
}

/**
 * Gross session ms ("Actual time taken") from an (already filtered) event
 * list: first opening event → matching `end`, pauses do not close a session.
 * No bundle equivalent (the original panel has no such column); dangling
 * sessions contribute zero, consistent with the logged-time rules above,
 * unless `nowMs` is supplied (see loggedMsFromEvents) for a still-running
 * session in the current window.
 */
function grossMsFromEvents(events, nowMs) {
  let total = 0;
  let open = null;
  for (const e of events || []) {
    const t = Date.parse(e.timestamp);
    if (Number.isNaN(t)) continue;
    if (e.type === 'start' || e.type === 'resume' || e.type === 'rework_start') {
      if (open === null) open = t;
    } else if (e.type === 'end' && open !== null) {
      total += t - open;
      open = null;
    }
  }
  if (open !== null && nowMs) total += Math.max(0, nowMs - open);
  return total;
}

/**
 * Port of Pn(): estimate HOURS for this stakeholder on this task.
 * Note the SEO branch's `|| estHours` fallback — verbatim from the bundle.
 */
function estHoursForOwner(task, stakeholder) {
  return task.seoOwner === stakeholder ? (task.estHoursSEO || task.estHours || 0)
    : task.contentOwner === stakeholder ? (task.estHoursContent || 0)
    : task.webOwner === stakeholder ? (task.estHoursWeb || 0)
    : (task.assignedTo === stakeholder && task.estHours) || 0;
}

/** Port of Cr()'s cap rule: no estimate (<=0) means all logged time is productive. */
function productiveMs(loggedMs, estMs) {
  if (estMs <= 0) return loggedMs;
  return Math.min(loggedMs, estMs);
}

/** Port of ca()'s rule: no estimate (<=0) means nothing can overrun. */
function overrunMs(loggedMs, estMs) {
  if (estMs <= 0) return 0;
  return Math.max(0, loggedMs - estMs);
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

/**
 * Stat-card aggregation window as inclusive 'YYYY-MM-DD' date strings,
 * matching the original panel's date-string windows. 'yesterday' equals
 * 'today' here because the page already anchors `date` to the previous day
 * before calling the API.
 */
function rangeWindow(dateStr, range, customFrom, customTo) {
  switch (range) {
    case 'week': {
      const { weekStart, weekEnd } = weekBounds(dateStr);
      return { fromStr: weekStart, toStr: weekEnd };
    }
    case 'month': {
      const { monthStart, monthEnd } = monthDays(dateStr);
      return { fromStr: monthStart, toStr: monthEnd };
    }
    case 'custom': {
      const { rangeStart, rangeEnd } = customDays(customFrom, customTo);
      return { fromStr: rangeStart, toStr: rangeEnd };
    }
    case 'today':
    case 'yesterday':
    default:
      return { fromStr: dateStr, toStr: dateStr };
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

/**
 * Team roles for the Team Timesheet view — copied verbatim from the
 * bundle's own role-label array (byte ~461980 in
 * dist/assets/index-xUiSJVv5.js) so labels match the rest of the app.
 * `admin` is intentionally excluded — admins aren't a "team" to report on.
 */
const TEAM_ROLES = [
  { value: 'seo', label: 'SEO' },
  { value: 'content', label: 'Content' },
  { value: 'web', label: 'Web' },
  { value: 'social', label: 'Social Media' },
  { value: 'design', label: 'Design' },
  { value: 'ads', label: 'Ads' },
  { value: 'webdev', label: 'Web Dev' },
];

/** Sentinel `team` value meaning "every non-admin user, across all roles combined". */
const ALL_TEAMS_VALUE = 'all';
const ALL_TEAMS_LABEL = 'All Teams';

/**
 * Port of the bundle's daily target-hours rule (byte ~617314: `po=8`, then
 * `leaveType==='full'||'holiday' ? 0 : leaveType==='half' ? po/2 : po`).
 * `leaveType` is undefined/null when there's no leave record for that day.
 * Does not account for weekends — callers combine this with `isWeekend()`.
 */
function dailyTargetMs(leaveType) {
  if (leaveType === 'full' || leaveType === 'holiday') return 0;
  if (leaveType === 'half') return 4 * HOUR_MS;
  return 8 * HOUR_MS;
}

/** True for Saturday/Sunday — used to exclude weekends from work-day targets. */
function isWeekend(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

// Team Timesheet day-cell color rule: flat logged-hours cutoffs, not a
// percentage of the (leave-adjusted) daily target.
const TEAM_RED_MAX_MS = 6.5 * HOUR_MS;    // < 6.5h logged → red
const TEAM_GREEN_MIN_MS = 7 * HOUR_MS;    // >= 7h logged → green; between the two → yellow

/**
 * Utilization bucket for one person-day, matching the Team Timesheet
 * legend: below 6.5h logged is red ('overrun' — reusing the existing red
 * day-cell/legend styling), 6.5h-7h is yellow ('underutilized'), 7h or more
 * is green ('within'). `targetMs<=0` means either a full-day leave/holiday
 * or a weekend (callers zero the target for both) — 'leave'/'weekend' if
 * nothing was logged (the expected case, `isWorkday=false` selects
 * 'weekend' over the 'leave' default), otherwise it still counts as red
 * (any logged time against a zero budget). A workday with nothing logged
 * at all stays 'empty' (neutral, not red) — only days with SOME logged
 * time under 6.5h are colored red.
 */
function classifyUtilization(actualMs, targetMs, isWorkday) {
  if (targetMs <= 0) {
    if (actualMs > 0) return 'overrun';
    return isWorkday === false ? 'weekend' : 'leave';
  }
  if (actualMs === 0) return 'empty';
  if (actualMs < TEAM_RED_MAX_MS) return 'overrun';
  if (actualMs < TEAM_GREEN_MIN_MS) return 'underutilized';
  return 'within';
}

export {
  HOUR_MS,
  DAY_MS,
  MAX_CUSTOM_RANGE_DAYS,
  DEPT_OWNER_FIELD,
  TEAM_ROLES,
  ALL_TEAMS_VALUE,
  ALL_TEAMS_LABEL,
  filterEventsForOwner,
  filterEventsInWindow,
  loggedMsFromEvents,
  reworkMsFromEvents,
  grossMsFromEvents,
  estHoursForOwner,
  productiveMs,
  overrunMs,
  dailyTargetMs,
  isWeekend,
  classifyUtilization,
  weekBounds,
  monthDays,
  customDays,
  rangeWindow,
  matrixDaysForRange,
};

/**
 * The one task a person is genuinely still working on, if any.
 *
 * WHY THIS EXISTS
 * ───────────────
 * loggedMsFromEvents(events, nowMs) credits (nowMs - open) for a segment that
 * has no close yet. That is correct for the task someone is actually working
 * on right now — but it is applied per task, independently, so N unclosed
 * segments each credit the full elapsed time and today's total grows at N
 * minutes per minute.
 *
 * Before the timer fixes (backend/utils/timerGuard.js), unclosed segments
 * accumulated in bulk: a duplicated `start` silently orphaned the segment
 * before it, leaving it open forever. One user ended up with ~19 such
 * orphans and a today total climbing ~19x real time.
 *
 * timerGuard.js now prevents new orphans, but it cannot retroactively close
 * the ones already in the database — so reporting has to be robust to them
 * on its own. This applies the same invariant the guard enforces on writes:
 * a person is working on at most ONE task at a time. Their most recently
 * opened unclosed segment is the live one; every older unclosed segment is
 * an abandoned orphan and is credited zero live time.
 *
 * Past days are unaffected — they never receive nowMs at all, so a dangling
 * open in a closed window already contributes nothing.
 *
 * @param {Object<string, Array>} eventsByTask  taskId -> event list
 * @param {string} stakeholder                  exact owner name to match
 * @returns {string|null} task id holding the live segment, or null
 */
export function liveOpenTaskForOwner(eventsByTask, stakeholder) {
  if (!stakeholder) return null;

  let liveTaskId = null;
  let liveOpenedAt = -Infinity;

  for (const taskId of Object.keys(eventsByTask || {})) {
    let open = null;
    for (const e of eventsByTask[taskId] || []) {
      if (!e.owner || e.owner !== stakeholder) continue;
      const t = Date.parse(e.timestamp);
      if (Number.isNaN(t)) continue;
      if (e.type === 'start' || e.type === 'resume' || e.type === 'rework_start') open = t;
      else if (e.type === 'pause' || e.type === 'end') open = null;
    }
    if (open !== null && open > liveOpenedAt) {
      liveOpenedAt = open;
      liveTaskId = taskId;
    }
  }

  return liveTaskId;
}
