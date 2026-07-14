/**
 * unified-timesheet.routes.js — Unified Timesheet panel endpoint.
 *
 * A brand-new, standalone read-only report. Does not modify the existing
 * (bundle-only) Timesheet tab or any of its data — it only reads the
 * existing `tasks` and `task_time_events` tables, and its math is a
 * faithful port of the original Timesheet's calculation functions
 * (see backend/utils/timesheetCalc.js for the mapping).
 *
 * GET /api/unified-timesheet
 *   Query params:
 *     stakeholder (required) — owner name, matched against seo_owner /
 *                               content_owner / web_owner / assigned_to
 *     date        (required) — 'YYYY-MM-DD', the navigated day (anchors
 *                               today/yesterday/week/month)
 *     range       (optional, default 'today') — today|yesterday|week|month|custom
 *                               Controls the aggregation window for the 6
 *                               stat cards. It also controls how many day
 *                               columns the table shows:
 *                                 - 'month'  → every day in that calendar month
 *                                 - 'custom' → every day between customFrom/customTo
 *                                 - anything else → the Monday-Sunday week containing `date`
 *     customFrom, customTo (required when range=custom) — 'YYYY-MM-DD' each
 *     client      (optional, repeatable) — filter to specific client/project names
 *     status      (optional, repeatable) — filter to specific execution_state values
 *
 *   Response shape:
 *     {
 *       stakeholder, range, selectedDate, matrixStart, matrixEnd,
 *       matrixDays: [{date,label,isToday,isSelected}, ...],
 *       stats: { totalTasks, actualMs, loggedMs, productiveMs, overrunMs, reworkTaskCount },
 *       groups: [{ client, taskCount, rollup:{actualMs,loggedMs,perDayMs}, tasks:[...] }],
 *       grandTotal: { taskCount, actualMs, loggedMs, estMs, perDayMs }
 *     }
 *   All durations are raw milliseconds — the page formats them client-side.
 */

import { Router } from 'express';
import pool from '../config/db.js';
import { rowToTask } from '../utils/taskMapping.js';
import {
  HOUR_MS,
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
  rangeWindow,
  matrixDaysForRange,
} from '../utils/timesheetCalc.js';

export const unifiedTimesheetRouter = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_RANGES = new Set(['today', 'yesterday', 'week', 'month', 'custom']);

function toArray(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function dayLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const weekday = dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  const month = dt.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${weekday}, ${d} ${month}`;
}

unifiedTimesheetRouter.get('/', async (req, res) => {
  try {
    const stakeholder = (req.query.stakeholder || '').trim();
    const date = (req.query.date || '').trim();
    const range = (req.query.range || 'today').trim();
    const customFrom = (req.query.customFrom || '').trim();
    const customTo = (req.query.customTo || '').trim();
    const clientFilter = toArray(req.query.client).filter(Boolean);
    const statusFilter = toArray(req.query.status).filter(Boolean);

    if (!stakeholder) return res.status(400).json({ error: 'stakeholder param required' });
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date param required as YYYY-MM-DD' });
    if (!VALID_RANGES.has(range)) return res.status(400).json({ error: `range must be one of ${[...VALID_RANGES].join('|')}` });
    if (range === 'custom') {
      if (!DATE_RE.test(customFrom) || !DATE_RE.test(customTo)) {
        return res.status(400).json({ error: 'customFrom and customTo are required as YYYY-MM-DD when range=custom' });
      }
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const { matrixStart, matrixEnd, days: matrixDays } = matrixDaysForRange(date, range, customFrom, customTo);
    const { fromStr: rangeFromStr, toStr: rangeToStr } = rangeWindow(date, range, customFrom, customTo);

    // ── Fetch in-scope tasks (owner match + optional client/status filters) ──
    const whereParts = ['(seo_owner = ? OR content_owner = ? OR web_owner = ? OR assigned_to = ?)'];
    const params = [stakeholder, stakeholder, stakeholder, stakeholder];

    if (clientFilter.length > 0) {
      whereParts.push(`client IN (${clientFilter.map(() => '?').join(',')})`);
      params.push(...clientFilter);
    }
    if (statusFilter.length > 0) {
      whereParts.push(`execution_state IN (${statusFilter.map(() => '?').join(',')})`);
      params.push(...statusFilter);
    }

    const [taskRows] = await pool.query(
      `SELECT * FROM tasks WHERE ${whereParts.join(' AND ')} ORDER BY client, id`,
      params
    );

    if (taskRows.length === 0) {
      return res.json(emptyResponse(stakeholder, range, date, matrixStart, matrixEnd, matrixDays));
    }

    // All events for these tasks, in insertion order (ORDER BY id), exactly
    // like the GET /api/tasks payload the original Timesheet consumes.
    // Owner/department matching happens per-event in JS (filterEventsForOwner),
    // NOT in SQL — events recorded with an empty owner but a department must
    // still match via the task's department-owner field.
    const taskIds = taskRows.map(r => r.id);
    const [eventRows] = await pool.query(
      `SELECT task_id, event_type, timestamp, department, owner FROM task_time_events
       WHERE task_id IN (${taskIds.map(() => '?').join(',')})
       ORDER BY id`,
      taskIds
    );

    const eventsByTask = {};
    for (const row of eventRows) {
      (eventsByTask[row.task_id] = eventsByTask[row.task_id] || []).push({
        type: row.event_type,
        timestamp: row.timestamp,
        department: row.department,
        owner: row.owner,
      });
    }

    // ── Per-task computation (windows are inclusive date-strings, matching
    //    the original panel: filter events to the window first, then pair) ──
    const computed = taskRows.map(row => {
      const task = rowToTask(row);
      const estMs = (Number(estHoursForOwner(task, stakeholder)) || 0) * HOUR_MS;
      const events = eventsByTask[task.id] || [];

      const rangeEvents = filterEventsForOwner(task, events, stakeholder, rangeFromStr, rangeToStr);
      const loggedRangeMs = loggedMsFromEvents(rangeEvents);
      const actualRangeMs = grossMsFromEvents(rangeEvents);
      const reworkRangeMs = reworkMsFromEvents(filterEventsInWindow(events, rangeFromStr, rangeToStr));

      const perDay = {};
      let totalMatrixLoggedMs = 0;
      for (const d of matrixDays) {
        const dayLoggedMs = loggedMsFromEvents(filterEventsForOwner(task, events, stakeholder, d, d));
        const cumulativeToDateMs = loggedMsFromEvents(filterEventsForOwner(task, events, stakeholder, null, d));
        perDay[d] = {
          loggedMs: dayLoggedMs,
          state: dayLoggedMs === 0 ? 'empty' : (estMs <= 0 || cumulativeToDateMs <= estMs ? 'within' : 'overrun'),
        };
        totalMatrixLoggedMs += dayLoggedMs;
      }

      return {
        task,
        estMs,
        actualRangeMs,
        loggedRangeMs,
        reworkRangeMs,
        perDay,
        totalMatrixLoggedMs,
      };
    });

    // ── Stat cards (aggregated over the selected range) ──
    const inRangeTasks = computed.filter(c => c.loggedRangeMs > 0);
    const stats = {
      totalTasks: inRangeTasks.length,
      actualMs: sumField(inRangeTasks, 'actualRangeMs'),
      loggedMs: sumField(inRangeTasks, 'loggedRangeMs'),
      productiveMs: inRangeTasks.reduce((s, c) => s + productiveMs(c.loggedRangeMs, c.estMs), 0),
      overrunMs: inRangeTasks.reduce((s, c) => s + overrunMs(c.loggedRangeMs, c.estMs), 0),
      reworkTaskCount: computed.filter(c => c.reworkRangeMs > 0).length,
    };

    // ── Table: only tasks with activity somewhere in the displayed matrix ──
    const matrixTasks = computed.filter(c => c.totalMatrixLoggedMs > 0);

    const groupMap = new Map();
    for (const c of matrixTasks) {
      const clientName = c.task.client || 'Unassigned';
      if (!groupMap.has(clientName)) groupMap.set(clientName, []);
      groupMap.get(clientName).push(c);
    }

    const groups = [...groupMap.entries()]
      .sort((a, b) => (a[0] === 'Unassigned' ? 1 : b[0] === 'Unassigned' ? -1 : a[0].localeCompare(b[0])))
      .map(([clientName, members]) => {
        const perDayMs = {};
        for (const d of matrixDays) perDayMs[d] = members.reduce((s, c) => s + c.perDay[d].loggedMs, 0);

        return {
          client: clientName,
          taskCount: members.length,
          rollup: {
            actualMs: sumField(members, 'actualRangeMs'),
            loggedMs: sumField(members, 'totalMatrixLoggedMs'),
            perDayMs,
          },
          tasks: members.map(c => ({
            id: c.task.id,
            title: c.task.title,
            status: c.task.executionState,
            docUrl: c.task.docUrl || '',
            targetUrl: c.task.targetUrl || '',
            estMs: c.estMs,
            actualMs: c.actualRangeMs,
            perDay: c.perDay,
            totalLoggedMs: c.totalMatrixLoggedMs,
          })),
        };
      });

    const grandPerDayMs = {};
    for (const d of matrixDays) grandPerDayMs[d] = matrixTasks.reduce((s, c) => s + c.perDay[d].loggedMs, 0);

    const grandTotal = {
      taskCount: matrixTasks.length,
      actualMs: sumField(matrixTasks, 'actualRangeMs'),
      loggedMs: sumField(matrixTasks, 'totalMatrixLoggedMs'),
      estMs: sumField(matrixTasks, 'estMs'),
      perDayMs: grandPerDayMs,
    };

    res.json({
      stakeholder,
      range,
      selectedDate: date,
      isToday: date === todayStr,
      matrixStart,
      matrixEnd,
      matrixDays: matrixDays.map(d => ({
        date: d,
        label: dayLabel(d),
        isToday: d === todayStr,
        isSelected: d === date,
      })),
      stats,
      groups,
      grandTotal,
    });
  } catch (e) {
    console.error('GET /api/unified-timesheet error:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load unified timesheet data' });
  }
});

/**
 * GET /api/unified-timesheet/team — Team Timesheet view.
 *
 * Same panel, a different lens: instead of one stakeholder's tasks grouped
 * by client, this groups a whole role/"team" roster's worked hours (net
 * logged time — start/resume→pause/end pairing, the same figure as the
 * individual view's "Logged" column; the mock labels it "Actual") against
 * a per-person 8h/day target — halved/zeroed on approved leave — with a
 * four-way utilization classification (leave/empty/underutilized/within/
 * overrun). Entirely additive: reuses the same timesheetCalc.js helpers as
 * the handler above, but never touches it.
 *
 * Query params: team (required, one of TEAM_ROLES' values), date, range
 * (today|yesterday|week|month|custom), customFrom/customTo, client[]/status[]
 * (optional task filters, same semantics as the single-stakeholder endpoint).
 */
const VALID_TEAMS = new Set([...TEAM_ROLES.map(t => t.value), ALL_TEAMS_VALUE]);
const TEAM_LABEL = Object.assign(
  Object.fromEntries(TEAM_ROLES.map(t => [t.value, t.label])),
  { [ALL_TEAMS_VALUE]: ALL_TEAMS_LABEL }
);

unifiedTimesheetRouter.get('/team', async (req, res) => {
  try {
    const team = (req.query.team || '').trim();
    const date = (req.query.date || '').trim();
    const range = (req.query.range || 'today').trim();
    const customFrom = (req.query.customFrom || '').trim();
    const customTo = (req.query.customTo || '').trim();
    const clientFilter = toArray(req.query.client).filter(Boolean);
    const statusFilter = toArray(req.query.status).filter(Boolean);

    if (!VALID_TEAMS.has(team)) return res.status(400).json({ error: `team must be one of ${[...VALID_TEAMS].join('|')}` });
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date param required as YYYY-MM-DD' });
    if (!VALID_RANGES.has(range)) return res.status(400).json({ error: `range must be one of ${[...VALID_RANGES].join('|')}` });
    if (range === 'custom') {
      if (!DATE_RE.test(customFrom) || !DATE_RE.test(customTo)) {
        return res.status(400).json({ error: 'customFrom and customTo are required as YYYY-MM-DD when range=custom' });
      }
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const { matrixStart, matrixEnd, days: matrixDays } = matrixDaysForRange(date, range, customFrom, customTo);
    const { fromStr: rangeFromStr, toStr: rangeToStr } = rangeWindow(date, range, customFrom, customTo);
    const matrixDaysOut = matrixDays.map(d => ({ date: d, label: dayLabel(d), isToday: d === todayStr, isSelected: d === date }));

    // ── Roster: everyone with this role, or every non-admin user for "all" ──
    const [rosterRows] = team === ALL_TEAMS_VALUE
      ? await pool.query('SELECT name FROM users WHERE role <> ? ORDER BY name', ['admin'])
      : await pool.query('SELECT name FROM users WHERE role = ? ORDER BY name', [team]);
    const roster = rosterRows.map(r => r.name).filter(Boolean);

    if (roster.length === 0) {
      return res.json(emptyTeamResponse(team, range, date, matrixStart, matrixEnd, matrixDaysOut));
    }

    // ── Tasks matched to ANY roster member (same owner-field logic as the
    //    single-stakeholder handler, just IN(...) instead of = ?) ──
    const rosterPh = roster.map(() => '?').join(',');
    const whereParts = [
      `(seo_owner IN (${rosterPh}) OR content_owner IN (${rosterPh}) OR web_owner IN (${rosterPh}) OR assigned_to IN (${rosterPh}))`,
    ];
    const params = [...roster, ...roster, ...roster, ...roster];

    if (clientFilter.length > 0) {
      whereParts.push(`client IN (${clientFilter.map(() => '?').join(',')})`);
      params.push(...clientFilter);
    }
    if (statusFilter.length > 0) {
      whereParts.push(`execution_state IN (${statusFilter.map(() => '?').join(',')})`);
      params.push(...statusFilter);
    }

    const [taskRows] = await pool.query(
      `SELECT * FROM tasks WHERE ${whereParts.join(' AND ')}`,
      params
    );

    if (taskRows.length === 0) {
      return res.json(emptyTeamResponse(team, range, date, matrixStart, matrixEnd, matrixDaysOut, roster));
    }

    const taskIds = taskRows.map(r => r.id);
    const [eventRows] = await pool.query(
      `SELECT task_id, event_type, timestamp, department, owner FROM task_time_events
       WHERE task_id IN (${taskIds.map(() => '?').join(',')})
       ORDER BY id`,
      taskIds
    );
    const eventsByTask = {};
    for (const row of eventRows) {
      (eventsByTask[row.task_id] = eventsByTask[row.task_id] || []).push({
        type: row.event_type, timestamp: row.timestamp, department: row.department, owner: row.owner,
      });
    }
    const tasks = taskRows.map(rowToTask);

    // ── Leave records for the roster, bounded to the displayed matrix ──
    const [leaveRows] = await pool.query(
      `SELECT user_name, leave_date, leave_type FROM leave_records
       WHERE user_name IN (${rosterPh}) AND leave_date BETWEEN ? AND ? AND status = 'approved'`,
      [...roster, matrixStart, matrixEnd]
    );
    const leaveByUserDate = {};
    for (const row of leaveRows) {
      const dateStr = row.leave_date instanceof Date ? row.leave_date.toISOString().slice(0, 10) : String(row.leave_date).slice(0, 10);
      (leaveByUserDate[row.user_name] = leaveByUserDate[row.user_name] || {})[dateStr] = row.leave_type;
    }

    // `rangeDays` is always a subset of `matrixDays`: rangeWindow() and
    // matrixDaysForRange() build week/month/custom bounds identically for
    // those ranges, and for today/yesterday rangeWindow's single day always
    // falls inside matrixDaysForRange's week fallback. So each member's
    // per-day figures only need computing once (over matrixDays); the range
    // stat cards are derived by filtering that same per-day data down to
    // rangeDays, rather than recomputing from scratch.
    const rangeDaySet = new Set(matrixDays.filter(d => d >= rangeFromStr && d <= rangeToStr));

    // ── Per member: NET LOGGED ms per matrix day against a leave-adjusted
    //    8h/day target, computed once and reused for every rollup below.
    //    Uses loggedMsFromEvents (start/resume→pause/end pairing, breaks
    //    excluded) — the same figure the individual view's "Logged" column
    //    shows — NOT gross session time: gross both over-counted (a 9am
    //    start ended at 11pm counted 14h wall-clock including breaks) and
    //    under-counted (tasks still Paused/In-progress at day end have no
    //    `end` event, so their real worked hours contributed zero). ──
    const members = roster.map(name => {
      const memberTasks = tasks.filter(t => t.seoOwner === name || t.contentOwner === name || t.webOwner === name || t.assignedTo === name);

      const perDay = {};
      for (const d of matrixDays) {
        const actualMs = memberTasks.reduce((sum, task) => {
          const events = eventsByTask[task.id] || [];
          return sum + loggedMsFromEvents(filterEventsForOwner(task, events, name, d, d));
        }, 0);
        // Weekends are never a work-day target, regardless of leave records
        // (5-working-day week: Sat/Sun always target 0, not the usual 8h).
        const isWorkday = !isWeekend(d);
        const leaveType = (leaveByUserDate[name] || {})[d];
        const targetMs = isWorkday ? dailyTargetMs(leaveType) : 0;
        perDay[d] = { actualMs, targetMs, state: classifyUtilization(actualMs, targetMs, isWorkday) };
      }

      const rangeReworkMs = memberTasks.reduce((sum, task) => {
        const events = eventsByTask[task.id] || [];
        return sum + reworkMsFromEvents(filterEventsInWindow(events, rangeFromStr, rangeToStr));
      }, 0);

      const matrixActualMs = sumBy(matrixDays, d => perDay[d].actualMs);
      const matrixTargetMs = sumBy(matrixDays, d => perDay[d].targetMs);

      const rangeDaysForMember = matrixDays.filter(d => rangeDaySet.has(d));
      const rangeActualMs = sumBy(rangeDaysForMember, d => perDay[d].actualMs);
      const rangeTargetMs = sumBy(rangeDaysForMember, d => perDay[d].targetMs);
      const rangeProductiveMs = sumBy(rangeDaysForMember, d => productiveMs(perDay[d].actualMs, perDay[d].targetMs));
      const rangeOverrunMs = sumBy(rangeDaysForMember, d => overrunMs(perDay[d].actualMs, perDay[d].targetMs));

      return {
        name,
        perDay,
        matrixActualMs,
        matrixTargetMs,
        rangeActualMs,
        rangeTargetMs,
        rangeProductiveMs,
        rangeOverrunMs,
        rangeReworkMs,
      };
    });

    // ── Team-level stat cards, derived from the same per-member per-day data ──
    const stats = {
      totalMembers: roster.length,
      actualMs: sumField(members, 'rangeActualMs'),
      targetMs: sumField(members, 'rangeTargetMs'),
      productiveMs: sumField(members, 'rangeProductiveMs'),
      overrunMs: sumField(members, 'rangeOverrunMs'),
      reworkMs: sumField(members, 'rangeReworkMs'),
    };

    const grandPerDayMs = {};
    for (const d of matrixDays) grandPerDayMs[d] = members.reduce((s, m) => s + m.perDay[d].actualMs, 0);

    res.json({
      team,
      teamLabel: TEAM_LABEL[team],
      range,
      selectedDate: date,
      isToday: date === todayStr,
      matrixStart,
      matrixEnd,
      matrixDays: matrixDaysOut,
      stats,
      members: members.map(m => ({
        name: m.name,
        perDay: m.perDay,
        matrixActualMs: m.matrixActualMs,
        matrixTargetMs: m.matrixTargetMs,
      })),
      grandTotal: {
        memberCount: roster.length,
        actualMs: sumField(members, 'matrixActualMs'),
        targetMs: sumField(members, 'matrixTargetMs'),
        perDayMs: grandPerDayMs,
      },
    });
  } catch (e) {
    console.error('GET /api/unified-timesheet/team error:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load team timesheet data' });
  }
});

/**
 * GET /api/unified-timesheet/client-coverage — Client Coverage view.
 *
 * Monthly client × SEO-stage task-count matrix: for the given calendar month,
 * how many tasks each client has in each seo_stage. Read-only and entirely
 * additive — shares nothing with the two timesheet handlers above except the
 * pool and this router.
 *
 * Data sources (all existing tables, no schema changes):
 *   - `clients` table          → full roster, so clients with 0 tasks still get a row
 *   - `app_config` admin_options.seoStages → stage column set + order
 *   - `tasks`                  → counts grouped by client/seo_stage/seo_owner,
 *                                month-bucketed on intake_date (same
 *                                `intake_date LIKE 'YYYY-MM%'` convention as
 *                                the SEO scorecard report)
 *
 * Query params:
 *   month (required) — 'YYYY-MM'
 *   owner (optional) — filter counts to one seo_owner
 *
 * Response:
 *   {
 *     month, owner,
 *     owners: [...],                        // seo_owner values for the filter dropdown
 *     stages: [...],                        // column order: configured stages, then
 *                                           // any extra values found in data, then
 *                                           // 'Unspecified' if blank stages exist
 *     clients: [{ name, owner, counts: {stage: n}, total }],
 *     totals: { perStage: {stage: n}, grand },
 *     stats: { clientCount, totalTasks, topStage, zeroTaskClients }
 *   }
 */
const MONTH_RE = /^\d{4}-\d{2}$/;
// Mirrors the app's built-in admin_options defaults — only used when the
// admin_options row is missing or has no seoStages array.
const DEFAULT_SEO_STAGES = ['Blogs', 'Client Call', 'Development', 'On Page', 'Reports', 'Tech. SEO', 'Whatsapp Message'];
const UNSPECIFIED_STAGE = 'Unspecified';
const UNASSIGNED_CLIENT = 'Unassigned';

unifiedTimesheetRouter.get('/client-coverage', async (req, res) => {
  try {
    const month = (req.query.month || '').trim();
    const owner = (req.query.owner || '').trim();
    if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'month param required as YYYY-MM' });

    const [cfgRows] = await pool.query('SELECT value FROM app_config WHERE `key` = ?', ['admin_options']);
    let configuredStages = DEFAULT_SEO_STAGES;
    if (cfgRows.length > 0) {
      try {
        const val = cfgRows[0].value;
        const cfg = typeof val === 'string' ? JSON.parse(val) : val;
        if (Array.isArray(cfg.seoStages) && cfg.seoStages.length > 0) {
          configuredStages = cfg.seoStages.filter(Boolean);
        }
      } catch { /* unparsable config → keep defaults */ }
    }

    const [clientRows] = await pool.query('SELECT name FROM clients ORDER BY sort_order, name');
    const roster = clientRows.map(r => r.name).filter(Boolean);

    const countParams = [`${month}%`];
    let ownerClause = '';
    if (owner) { ownerClause = ' AND seo_owner = ?'; countParams.push(owner); }
    const [countRows] = await pool.query(
      `SELECT client, seo_stage, seo_owner, COUNT(*) AS cnt
       FROM tasks
       WHERE intake_date LIKE ?${ownerClause}
       GROUP BY client, seo_stage, seo_owner`,
      countParams
    );

    // Dropdown options: everyone who has ever owned a task, not just this month,
    // so switching months never silently drops the active filter's option.
    const [ownerRows] = await pool.query(
      `SELECT DISTINCT seo_owner FROM tasks WHERE seo_owner IS NOT NULL AND seo_owner <> '' ORDER BY seo_owner`
    );

    // Columns: configured order first (stable across months, even at 0 tasks),
    // then any ad-hoc stage values found in the data, 'Unspecified' last.
    const stageSet = new Set(configuredStages);
    const stages = [...configuredStages];
    let hasUnspecified = false;
    for (const row of countRows) {
      const stage = (row.seo_stage || '').trim();
      if (!stage) { hasUnspecified = true; continue; }
      if (!stageSet.has(stage)) { stageSet.add(stage); stages.push(stage); }
    }
    if (hasUnspecified) stages.push(UNSPECIFIED_STAGE);

    const byClient = new Map();
    const ensureClient = name => {
      if (!byClient.has(name)) byClient.set(name, { counts: {}, ownerCounts: {}, total: 0 });
      return byClient.get(name);
    };
    for (const row of countRows) {
      const clientName = (row.client || '').trim() || UNASSIGNED_CLIENT;
      const stage = (row.seo_stage || '').trim() || UNSPECIFIED_STAGE;
      const entry = ensureClient(clientName);
      const n = Number(row.cnt) || 0;
      entry.counts[stage] = (entry.counts[stage] || 0) + n;
      entry.total += n;
      const ownerName = (row.seo_owner || '').trim();
      if (ownerName) entry.ownerCounts[ownerName] = (entry.ownerCounts[ownerName] || 0) + n;
    }

    // Rows: roster order, then clients that only exist on tasks (e.g. renamed/
    // removed from the clients table), 'Unassigned' always last.
    const rosterSet = new Set(roster);
    const extraClients = [...byClient.keys()]
      .filter(c => !rosterSet.has(c))
      .sort((a, b) => (a === UNASSIGNED_CLIENT ? 1 : b === UNASSIGNED_CLIENT ? -1 : a.localeCompare(b)));
    const clientNames = [...roster, ...extraClients];

    const clients = clientNames.map(name => {
      const entry = byClient.get(name) || { counts: {}, ownerCounts: {}, total: 0 };
      // Sub-label: the owner who logged the most of this client's tasks this
      // month (there is no client→owner mapping in the DB to read instead).
      let topOwner = '';
      let topOwnerCnt = 0;
      for (const [o, c] of Object.entries(entry.ownerCounts)) {
        if (c > topOwnerCnt) { topOwner = o; topOwnerCnt = c; }
      }
      const counts = {};
      for (const s of stages) counts[s] = entry.counts[s] || 0;
      return { name, owner: topOwner, counts, total: entry.total };
    });

    const perStage = {};
    for (const s of stages) perStage[s] = clients.reduce((sum, c) => sum + c.counts[s], 0);
    const grand = clients.reduce((sum, c) => sum + c.total, 0);

    let topStage = '';
    let topStageCnt = 0;
    for (const s of stages) {
      if (perStage[s] > topStageCnt) { topStage = s; topStageCnt = perStage[s]; }
    }

    res.json({
      month,
      owner,
      owners: ownerRows.map(r => r.seo_owner),
      stages,
      clients,
      totals: { perStage, grand },
      stats: {
        clientCount: clients.length,
        totalTasks: grand,
        topStage,
        zeroTaskClients: clients.filter(c => c.total === 0).length,
      },
    });
  } catch (e) {
    console.error('GET /api/unified-timesheet/client-coverage error:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load client coverage data' });
  }
});

function sumBy(list, fn) {
  return list.reduce((s, item) => s + fn(item), 0);
}

function emptyTeamResponse(team, range, date, matrixStart, matrixEnd, matrixDaysOut, roster) {
  const perDayMs = {};
  for (const d of matrixDaysOut) perDayMs[d.date] = 0;
  return {
    team,
    teamLabel: TEAM_LABEL[team],
    range,
    selectedDate: date,
    isToday: date === new Date().toISOString().slice(0, 10),
    matrixStart,
    matrixEnd,
    matrixDays: matrixDaysOut,
    stats: { totalMembers: (roster || []).length, actualMs: 0, targetMs: 0, productiveMs: 0, overrunMs: 0, reworkMs: 0 },
    members: [],
    grandTotal: { memberCount: (roster || []).length, actualMs: 0, targetMs: 0, perDayMs },
  };
}

function sumField(list, field) {
  return list.reduce((s, c) => s + c[field], 0);
}

function emptyResponse(stakeholder, range, date, matrixStart, matrixEnd, matrixDays) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const perDayMs = {};
  for (const d of matrixDays) perDayMs[d] = 0;
  return {
    stakeholder,
    range,
    selectedDate: date,
    isToday: date === todayStr,
    matrixStart,
    matrixEnd,
    matrixDays: matrixDays.map(d => ({
      date: d,
      label: dayLabel(d),
      isToday: d === todayStr,
      isSelected: d === date,
    })),
    stats: { totalTasks: 0, actualMs: 0, loggedMs: 0, productiveMs: 0, overrunMs: 0, reworkTaskCount: 0 },
    groups: [],
    grandTotal: { taskCount: 0, actualMs: 0, loggedMs: 0, estMs: 0, perDayMs },
  };
}
