/**
 * unified-timesheet.routes.js — Unified Timesheet panel endpoint.
 *
 * A brand-new, standalone read-only report. Does not modify the existing
 * (bundle-only) Timesheet tab or any of its data — it only reads the
 * existing `tasks` and `task_time_events` tables.
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
  pairEvents,
  sumOverlapMs,
  primaryDept,
  estMsForDept,
  productiveMs,
  overrunMs,
  rangeBounds,
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

    const nowMs = Date.now();
    const todayStr = new Date(nowMs).toISOString().slice(0, 10);
    const { matrixStart, matrixEnd, days: matrixDays } = matrixDaysForRange(date, range, customFrom, customTo);
    const { from: rangeFrom, to: rangeTo } = rangeBounds(date, range, customFrom, customTo);

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

    const taskIds = taskRows.map(r => r.id);
    const [eventRows] = await pool.query(
      `SELECT task_id, event_type, timestamp FROM task_time_events
       WHERE task_id IN (${taskIds.map(() => '?').join(',')}) AND owner = ?
       ORDER BY task_id, timestamp`,
      [...taskIds, stakeholder]
    );

    const eventsByTask = {};
    for (const row of eventRows) {
      (eventsByTask[row.task_id] = eventsByTask[row.task_id] || []).push(row);
    }

    // ── Per-task computation ──
    const computed = taskRows.map(row => {
      const task = rowToTask(row);
      const dept = primaryDept(task, stakeholder);
      const estMs = estMsForDept(task, dept);
      const { sessions, netIntervals } = pairEvents(eventsByTask[task.id] || []);

      const actualRangeMs = sumOverlapMs(sessions, rangeFrom, rangeTo);
      const loggedRangeMs = sumOverlapMs(netIntervals, rangeFrom, rangeTo);
      const reworkRangeMs = sumOverlapMs(netIntervals, rangeFrom, rangeTo, 'rework');

      const perDay = {};
      let totalMatrixLoggedMs = 0;
      for (const d of matrixDays) {
        const [y, m, dd] = d.split('-').map(Number);
        const dayFrom = Date.UTC(y, m - 1, dd);
        const dayTo = dayFrom + 86400000;
        const dayLoggedMs = sumOverlapMs(netIntervals, dayFrom, dayTo);
        const cumulativeToDateMs = sumOverlapMs(netIntervals, null, dayTo);
        perDay[d] = {
          loggedMs: dayLoggedMs,
          state: dayLoggedMs === 0 ? 'empty' : (estMs <= 0 || cumulativeToDateMs <= estMs ? 'within' : 'overrun'),
        };
        totalMatrixLoggedMs += dayLoggedMs;
      }

      return {
        task,
        dept,
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
