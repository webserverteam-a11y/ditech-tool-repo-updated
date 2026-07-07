/**
 * timesheetCalc.js — Pure time-math helpers for the Unified Timesheet panel.
 *
 * FAITHFUL PORT of the original (bundle-only) Timesheet tab's calculation
 * functions, extracted verbatim from dist/assets/index-xUiSJVv5.js:
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
 * Only consumed by backend/routes/unified-timesheet.routes.js — does not
 * touch any existing route or table.
 */

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

/** Event department → task owner-field, mirroring kr()'s DEPT_OWNER map. */
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
 * Port of kr()'s filter step: keep events whose calendar date falls inside
 * [fromStr, toStr] (inclusive, string compare; either bound may be null for
 * unbounded) AND that belong to this stakeholder — matched by the event's
 * own `owner`, or, when owner is empty, by mapping the event's `department`
 * to the task's corresponding owner field.
 */
function filterEventsForOwner(task, events, stakeholder, fromStr, toStr) {
  return (events || []).filter(e => {
    const day = eventDay(e.timestamp);
    if (!day) return false;
    if (fromStr && day < fromStr) return false;
    if (toStr && day > toStr) return false;
    if (e.owner) return e.owner === stakeholder;
    if (e.department) {
      const field = DEPT_OWNER_FIELD[e.department];
      return field ? task[field] === stakeholder : false;
    }
    return false;
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
 */
function loggedMsFromEvents(events) {
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
  return total;
}

/**
 * Port of W0()'s inner loop: rework ms from an (already window-filtered)
 * event list — pairs rework_start → next pause/end. Returns 0 if the window
 * contains no rework_start at all (W0's early exit).
 */
function reworkMsFromEvents(events) {
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
  return total;
}

/**
 * Gross session ms ("Actual time taken") from an (already filtered) event
 * list: first opening event → matching `end`, pauses do not close a session.
 * No bundle equivalent (the original panel has no such column); dangling
 * sessions contribute zero, consistent with the logged-time rules above.
 */
function grossMsFromEvents(events) {
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

/**
 * Port of the bundle's daily target-hours rule (byte ~617314: `po=8`, then
 * `leaveType==='full'||'holiday' ? 0 : leaveType==='half' ? po/2 : po`).
 * `leaveType` is undefined/null when there's no leave record for that day.
 */
function dailyTargetMs(leaveType) {
  if (leaveType === 'full' || leaveType === 'holiday') return 0;
  if (leaveType === 'half') return 4 * HOUR_MS;
  return 8 * HOUR_MS;
}

/**
 * Utilization bucket for one person-day, matching the Team Timesheet
 * legend: Underutilized <80%, Within Estimate 80-100%, Overrun >100%.
 * `targetMs<=0` means a full-day leave/holiday — 'leave' if nothing was
 * logged (the expected case), otherwise it still counts as overrun (any
 * logged time against a zero budget).
 */
function classifyUtilization(actualMs, targetMs) {
  if (targetMs <= 0) return actualMs > 0 ? 'overrun' : 'leave';
  if (actualMs === 0) return 'empty';
  const pct = actualMs / targetMs;
  if (pct < 0.8) return 'underutilized';
  if (pct <= 1.0) return 'within';
  return 'overrun';
}

export {
  HOUR_MS,
  DAY_MS,
  MAX_CUSTOM_RANGE_DAYS,
  DEPT_OWNER_FIELD,
  TEAM_ROLES,
  filterEventsForOwner,
  filterEventsInWindow,
  loggedMsFromEvents,
  reworkMsFromEvents,
  grossMsFromEvents,
  estHoursForOwner,
  productiveMs,
  overrunMs,
  dailyTargetMs,
  classifyUtilization,
  weekBounds,
  monthDays,
  customDays,
  rangeWindow,
  matrixDaysForRange,
};
