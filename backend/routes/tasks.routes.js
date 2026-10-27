/**
 * tasks.routes.js — All task CRUD + atomic mutation endpoints.
 *
 * Endpoints:
 *   GET    /api/tasks                          — full list with child arrays
 *   PUT    /api/tasks                          — bulk upsert (no delete, safe for multi-user)
 *   PUT    /api/tasks/:id                      — single-task upsert
 *   DELETE /api/tasks/:id                      — explicit single-task delete
 *
 * Atomic endpoints (multi-user safe — no full-task overwrite):
 *   PATCH  /api/tasks/:id/assign               — update only assignment/status fields
 *   PATCH  /api/tasks/:id/fields               — update any subset of scalar task fields
 *   POST   /api/tasks/:id/events               — append a single time event (no overwrite)
 *   POST   /api/tasks/:id/qc-reviews           — upsert a single QC review
 *   DELETE /api/tasks/:id/qc-reviews/:reviewId — remove a single QC review
 *   POST   /api/tasks/:id/rework               — upsert a single rework entry
 *   DELETE /api/tasks/:id/rework/:reworkId     — remove a single rework entry
 */

import { Router } from 'express';
import pool from '../config/db.js';
import { saveTaskToDb, isDuplicateTimeEvent } from '../utils/saveTask.js';
import { rowToTask } from '../utils/taskMapping.js';
import { normalizeTaskDates } from '../utils/dateNormalize.js';
import { groupBy } from '../utils/taskMapping.js';
import { runOverrunCheck } from '../services/timerCheck.service.js';
import { enforceSingleActiveTimer, isOpeningEvent, resolveEventOwner } from '../utils/timerGuard.js';
import { TASK_COLUMN_MAP } from '../utils/taskMapping.js';
import { recordActivity, archiveDeletedTask, clientMeta } from '../services/activityLog.service.js';

// ── Activity-log helpers ───────────────────────────────────────────────────

const SAVE_ACTIONS = {
  create:        'task_create',
  merge:         'task_update',
  full:          'task_update_full',
  refused_stale: 'task_refused_stale',
};

/** Record one saveTaskToDb() result in this request's activity log. */
function logTaskSave(res, task, r) {
  const changed = (r.changes && r.changes.length) || r.newEvents.length || r.autoPaused.length;
  recordActivity(res, {
    action:  r.mode === 'create' || r.stale || changed ? SAVE_ACTIONS[r.mode] : 'task_save_nochange',
    taskId:  task.id,
    changes: r.changes,
    details: {
      title: task.title,
      newEvents:  r.newEvents.length ? r.newEvents : undefined,
      autoPaused: r.autoPaused.length ? r.autoPaused : undefined,
      sentBase:   !!task._base,
      clientCopyUpdatedAt: task.updatedAt || undefined,
    },
  });
}

/** Loose equality for DB vs JSON values ("1.00" == 1, 1 == true, null == ''). */
function sameValue(a, b) {
  const blankA = a === null || a === undefined || a === '';
  const blankB = b === null || b === undefined || b === '';
  if (blankA || blankB) return blankA === blankB;
  const na = Number(a), nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  return String(a) === String(b);
}

/**
 * [{field, from, to}] for the given [[column, newValue]] pairs vs the current
 * row. Column names come from the routes' own whitelists, never from input.
 */
async function diffColumns(taskId, pairs, db = pool) {
  const [rows] = await db.query(
    `SELECT ${pairs.map(([c]) => c).join(', ')} FROM tasks WHERE id = ? LIMIT 1`,
    [taskId]
  );
  if (!rows.length) return [];
  return pairs
    .filter(([c, v]) => !sameValue(rows[0][c], v))
    .map(([c, v]) => ({ field: TASK_COLUMN_MAP[c] || c, from: rows[0][c], to: v }));
}

const isoOrEmpty = d => (d ? new Date(d).toISOString() : '');

/**
 * Version check for the field-level PATCH endpoints.
 *
 * Field-level writes can not clobber unrelated fields, but they can still act
 * on a decision made from an out-of-date screen: user B closes or reassigns a
 * task that user A handed off ten seconds ago, without ever seeing A's change.
 * A client that sends `expectedUpdatedAt` (the task version it was looking at)
 * gets 409 instead if the row has changed since; it then refreshes and the
 * user decides again. Omitting it keeps the old unconditional behaviour.
 *
 * Runs `apply(conn)` in a transaction holding the row lock, so the check and
 * the write can not interleave with another writer. Retried on deadlock, as
 * in saveOneTask() — the timer guard inside `apply` may lock other task rows.
 *
 * @returns {Promise<{status: 'ok'|'conflict'|'missing', updatedAt?: string, currentUpdatedAt?: string}>}
 */
async function withVersionCheck(taskId, expectedUpdatedAt, apply, retries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await versionCheckOnce(taskId, expectedUpdatedAt, apply);
    } catch (e) {
      const retryable = e.code === 'ER_LOCK_DEADLOCK' || e.code === 'ER_LOCK_WAIT_TIMEOUT';
      if (!retryable || attempt >= retries) throw e;
      await new Promise(r => setTimeout(r, 50 * attempt));
    }
  }
}

async function versionCheckOnce(taskId, expectedUpdatedAt, apply) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      'SELECT updated_at FROM tasks WHERE id = ? LIMIT 1 FOR UPDATE', [taskId]
    );
    if (!rows.length) { await conn.rollback(); return { status: 'missing' }; }

    if (expectedUpdatedAt && rows[0].updated_at &&
        Date.parse(expectedUpdatedAt) < new Date(rows[0].updated_at).getTime()) {
      await conn.rollback();
      return { status: 'conflict', currentUpdatedAt: isoOrEmpty(rows[0].updated_at) };
    }

    await apply(conn);
    const [after] = await conn.query('SELECT updated_at FROM tasks WHERE id = ? LIMIT 1', [taskId]);
    await conn.commit();
    return { status: 'ok', updatedAt: isoOrEmpty(after[0] && after[0].updated_at) };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/** Shared 409 / activity-log handling for a refused PATCH. */
function refuseConflict(res, taskId, expectedUpdatedAt, result, attempted) {
  recordActivity(res, {
    action: 'task_conflict_refused', taskId,
    details: { expectedUpdatedAt, currentUpdatedAt: result.currentUpdatedAt, attempted },
  });
  return res.status(409).json({
    error: 'This task was changed by someone else since you loaded it — refresh and try again',
    conflict: true, taskId, currentUpdatedAt: result.currentUpdatedAt,
  });
}

export const tasksRouter = Router();

// ── GET /api/tasks ─────────────────────────────────────────────────────────
tasksRouter.get('/', async (_req, res) => {
  try {
    const [rows]   = await pool.query('SELECT * FROM tasks ORDER BY id');
    const [teRows] = await pool.query('SELECT * FROM task_time_events ORDER BY id');
    const [qcRows] = await pool.query('SELECT * FROM task_qc_reviews ORDER BY id');
    const [rwRows] = await pool.query('SELECT * FROM task_rework_entries ORDER BY id');

    const teMap = groupBy(teRows, 'task_id');
    const qcMap = groupBy(qcRows, 'task_id');
    const rwMap = groupBy(rwRows, 'task_id');

    const tasks = rows.map(r => {
      const t = rowToTask(r);
      normalizeTaskDates(t);

      t.timeEvents = (teMap[t.id] || []).map(e => ({
        type: e.event_type, timestamp: e.timestamp,
        department: e.department, owner: e.owner,
      }));

      t.qcReviews = (qcMap[t.id] || []).map(e => {
        const obj = {
          id: e.review_id, submittedBy: e.submitted_by,
          submittedByDept: e.submitted_by_dept, submittedAt: e.submitted_at,
          assignedTo: e.assigned_to, estHours: Number(e.est_hours) || 0,
        };
        if (e.note)         obj.note        = e.note;
        if (e.outcome)      obj.outcome      = e.outcome;
        if (e.completed_at) obj.completedAt  = e.completed_at;
        return obj;
      });

      t.reworkEntries = (rwMap[t.id] || []).map(e => ({
        id: e.rework_id, date: e.date,
        estHours: Number(e.est_hours) || 0,
        assignedDept: e.assigned_dept, assignedOwner: e.assigned_owner,
        withinEstimate: !!e.within_estimate,
        hoursAlreadySpent: Number(e.hours_already_spent) || 0,
        startTimestamp: e.start_timestamp, endTimestamp: e.end_timestamp,
        durationMs: Number(e.duration_ms) || 0,
      }));

      return t;
    });

    res.json(tasks);
  } catch (e) {
    console.error('GET /api/tasks error:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load tasks' });
  }
});


//Get task by id
// tasksRouter.get('/:id', async (req, res) => {
//   const taskId = req.params.id;
//   try {
//     const [rows] = await pool.query('SELECT * FROM tasks WHERE id = ? LIMIT 1', [taskId]);
//     if (rows.length === 0) {
//       return res.status(404).json({ error: 'Task not found' });
//     }
//     const task = rowToTask(rows[0]);
//     normalizeTaskDates(task);

//     const [teRows] = await pool.query('SELECT * FROM task_time_events WHERE task_id = ? ORDER BY id', [taskId]);
//     const [qcRows] = await pool.query('SELECT * FROM task_qc_reviews WHERE task_id = ? ORDER BY id', [taskId]);
//     const [rwRows] = await pool.query('SELECT * FROM task_rework_entries WHERE task_id = ? ORDER BY id', [taskId]);

//     task.timeEvents = teRows.map(e => ({
//       type: e.event_type, timestamp: e.timestamp,
//       department: e.department, owner: e.owner,
//     }));

//     task.qcReviews = qcRows.map(e => {
//       const obj = {
//         id: e.review_id, submittedBy: e.submitted_by,
//         submittedByDept: e.submitted_by_dept, submittedAt: e.submitted_at,
//         assignedTo: e.assigned_to, estHours: Number(e.est_hours) || 0,
//       };
//       if (e.note)         obj.note        = e.note;
//       if (e.outcome)      obj.outcome      = e.outcome;
//       if (e.completed_at) obj.completedAt  = e.completed_at;
//       return obj;
//     });

//     task.reworkEntries = rwRows.map(e => ({
//       id: e.rework_id, date: e.date,
//       estHours: Number(e.est_hours) || 0,
//       assignedDept: e.assigned_dept, assignedOwner: e.assigned_owner,
//       withinEstimate: !!e.within_estimate,
//       hoursAlreadySpent: Number(e.hours_already_spent) || 0,
//       startTimestamp: e.start_timestamp, endTimestamp: e.end_timestamp,
//       durationMs: Number(e.duration_ms) || 0,
//     }));

//     res.json(task);
//   } catch (e) {
//     console.error(`GET /api/tasks/${taskId} error:`, e.code, e.message);
//     res.status(500).json({ error: 'Failed to load task' });
//   }
// });



// Helper: save one task in its own transaction, with up to `retries` retries
// on deadlock (ER_LOCK_DEADLOCK) or lock-wait timeout (ER_LOCK_WAIT_TIMEOUT).
async function saveOneTask(task, retries = 3) {
  let conn;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();
      const result = await saveTaskToDb(conn, task);
      await conn.commit();
      conn.release();
      return result;
    } catch (e) {
      if (conn) { await conn.rollback().catch(() => {}); conn.release(); conn = null; }
      const retryable = e.code === 'ER_LOCK_DEADLOCK' || e.code === 'ER_LOCK_WAIT_TIMEOUT';
      if (retryable && attempt < retries) {
        // brief back-off before retry: 50ms, 150ms, …
        await new Promise(r => setTimeout(r, 50 * attempt));
        continue;
      }
      throw e;
    }
  }
}

// ── PUT /api/tasks — bulk upsert (NEVER deletes) ───────────────────────────
tasksRouter.put('/', async (req, res) => {
  const tasks = req.body;
  if (!Array.isArray(tasks)) return res.status(400).json({ error: 'Expected array' });
  if (tasks.length === 0)
    return res.json({ ok: true, count: 0, message: 'No tasks provided, nothing changed.' });

  const ids = tasks.map(t => t.id).filter(Boolean);
  if (ids.length === 0)
    return res.status(400).json({ error: 'No valid task IDs in payload, aborting to prevent data loss.' });

  try {
    // Save each task in its own short transaction (sequentially to avoid deadlocks).
    const staleIds = [];
    for (const t of tasks) {
      const r = await saveOneTask(t);
      logTaskSave(res, t, r);
      if (r.stale) staleIds.push(t.id);
    }
    recordActivity(res, {
      action: 'task_bulk_save',
      details: { count: tasks.length, refused: staleIds.length },
    });
    if (staleIds.length)
      console.warn(`PUT /api/tasks: refused ${staleIds.length} stale task overwrite(s):`, staleIds.join(', '));

    const ph = ids.map(() => '?').join(',');
    const [vRows] = await pool.query(`SELECT COUNT(*) AS c FROM tasks WHERE id IN (${ph})`, ids);
    const verified = Number(vRows[0].c) === ids.length;

    res.json({
      ok: true, count: tasks.length,
      staleIds,
      dbVerified: verified,
      message: verified
        ? `${tasks.length} task(s) saved and verified in DB`
        : `${tasks.length} task(s) saved — DB verified ${vRows[0].c} of ${ids.length}`,
    });
  } catch (e) {
    console.error('PUT /api/tasks error:', e.message);
    res.status(500).json({ error: 'Failed to save tasks' });
  }
});

// ── PUT /api/tasks/:id — single-task atomic upsert ─────────────────────────
tasksRouter.put('/:id', async (req, res) => {
  const task = req.body;
  if (!task || typeof task !== 'object' || Array.isArray(task))
    return res.status(400).json({ error: 'Expected task object' });

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    task.id = req.params.id;
    const saved = await saveTaskToDb(conn, task);
    await conn.commit();
    logTaskSave(res, task, saved);

    if (saved.stale) {
      console.warn(`PUT /api/tasks/${task.id}: refused stale overwrite (client copy ${task.updatedAt || 'unversioned'})`);
      return res.status(409).json({
        error: 'Task was changed by someone else since you loaded it — refresh and try again',
        stale: true, taskId: task.id,
      });
    }

    const [vRows] = await pool.query(
      'SELECT id, title, client, execution_state, updated_at FROM tasks WHERE id = ? LIMIT 1',
      [task.id]
    );
    const dbVerified = vRows.length > 0;
    res.json({
      ok: true, dbVerified,
      dbRecord: dbVerified ? {
        id: vRows[0].id, title: vRows[0].title, client: vRows[0].client,
        executionState: vRows[0].execution_state, updatedAt: vRows[0].updated_at,
      } : null,
      message: dbVerified
        ? `Task "${task.id}" saved successfully`
        : `Task "${task.id}" saved but DB verification returned no row`,
    });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('PUT /api/tasks/:id error:', e.message);
    res.status(500).json({ error: 'Failed to save task' });
  } finally {
    if (conn) conn.release();
  }
});

// ── DELETE /api/tasks/:id ─────────────────────────────────────────────────
tasksRouter.delete('/:id', async (req, res) => {
  const taskId = req.params.id;
  if (!taskId) return res.status(400).json({ error: 'Task ID required' });

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    // Full copy first, in the same transaction — no archive, no delete.
    const archived = await archiveDeletedTask(conn, taskId, clientMeta(req));
    await conn.query('DELETE FROM task_time_events   WHERE task_id = ?', [taskId]);
    await conn.query('DELETE FROM task_qc_reviews    WHERE task_id = ?', [taskId]);
    await conn.query('DELETE FROM task_rework_entries WHERE task_id = ?', [taskId]);
    const [result] = await conn.query('DELETE FROM tasks WHERE id = ?', [taskId]);
    await conn.commit();

    if (result.affectedRows === 0)
      return res.status(404).json({ error: `Task "${taskId}" not found` });

    recordActivity(res, {
      action: 'task_delete', taskId,
      details: archived ? {
        title: archived.title, client: archived.client,
        seoOwner: archived.seo_owner, executionState: archived.execution_state,
      } : undefined,
    });

    res.json({ ok: true, message: `Task "${taskId}" deleted successfully` });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('DELETE /api/tasks/:id error:', e.message);
    res.status(500).json({ error: 'Failed to delete task' });
  } finally {
    if (conn) conn.release();
  }
});

// ── PATCH /api/tasks/:id/assign — atomic field-level assignment update ─────
// Only touches the listed columns. Does NOT read/write timeEvents or child
// tables, so it is safe when multiple users assign simultaneously.
//
// Body: { seoOwner, contentOwner, webOwner, assignedTo, currentOwner,
//         seoStage, executionState, seoQcStatus, contentStatus, webStatus,
//         expectedUpdatedAt? }  — see withVersionCheck()
// Any field omitted from the body is left unchanged in the DB.
// Response includes the task's new `updatedAt`.
tasksRouter.patch('/:id/assign', async (req, res) => {
  const taskId = req.params.id;
  const body   = req.body || {};

  const ASSIGNABLE = [
    ['seo_owner',        body.seoOwner],
    ['content_owner',    body.contentOwner],
    ['web_owner',        body.webOwner],
    ['assigned_to',      body.assignedTo],
    ['current_owner',    body.currentOwner],
    ['seo_stage',        body.seoStage],
    ['execution_state',  body.executionState],
    ['seo_qc_status',    body.seoQcStatus],
    ['content_status',   body.contentStatus],
    ['web_status',       body.webStatus],
  ].filter(([, v]) => v !== undefined && v !== null);

  if (ASSIGNABLE.length === 0)
    return res.status(400).json({ error: 'No assignable fields provided' });

  try {
    // This endpoint can set execution_state directly, with no timer event and
    // no owner attached. The Action Board renders a RUNNING timer from
    // execution_state === 'In Progress' plus any unclosed start event on the
    // task, so flipping the state here on a task that still carries an old
    // orphaned start makes a long-dormant task appear to start on its own.
    //
    // Apply the same one-task-at-a-time rule as the events endpoint: moving a
    // task into a running state pauses whatever else that owner had running.
    let autoPaused = [];
    let changes = [];
    const result = await withVersionCheck(taskId, body.expectedUpdatedAt, async conn => {
      if (body.executionState === 'In Progress' || body.executionState === 'Rework') {
        const guardOwner = await resolveEventOwner(conn, {
          taskId,
          owner:      body.owner || body.currentUser || '',
          department: body.currentOwner,
        });
        if (guardOwner) {
          const guard = await enforceSingleActiveTimer(conn, {
            taskId,
            owner:      guardOwner,
            timestamp:  new Date().toISOString(),
            department: body.currentOwner || '',
          });
          autoPaused = guard.pausedTaskIds;
        }
      }

      changes = await diffColumns(taskId, ASSIGNABLE, conn);
      const setClauses = ASSIGNABLE.map(([col]) => `${col} = ?`).join(', ');
      await conn.query(
        `UPDATE tasks SET ${setClauses}, updated_at = NOW() WHERE id = ?`,
        [...ASSIGNABLE.map(([, v]) => v), taskId]
      );
    });

    if (result.status === 'missing')
      return res.status(404).json({ error: `Task "${taskId}" not found` });
    if (result.status === 'conflict')
      return refuseConflict(res, taskId, body.expectedUpdatedAt, result, Object.fromEntries(ASSIGNABLE));

    recordActivity(res, {
      action: 'task_assign', taskId, changes,
      details: autoPaused.length ? { autoPaused } : undefined,
    });

    const updated = Object.fromEntries(ASSIGNABLE);
    res.json({
      ok: true,
      taskId,
      updated,
      updatedAt: result.updatedAt,
      message: `Task "${taskId}" assignment updated successfully`,
    });
  } catch (e) {
    console.error('PATCH /api/tasks/:id/assign error:', e.message);
    res.status(500).json({ error: 'Failed to update assignment' });
  }
});

// ── POST /api/tasks/:id/events — append a single time event ────────────────
// Append-only: never deletes existing events. Safe for concurrent timer
// Start/Pause/End from multiple users or browser tabs.
//
// Body: { type, timestamp, department, owner }
tasksRouter.post('/:id/events', async (req, res) => {
  const taskId = req.params.id;
  const ev     = req.body || {};

  if (!ev.type)
    return res.status(400).json({ error: 'event type is required' });

  try {
    // Verify task exists
    const [tRows] = await pool.query('SELECT id FROM tasks WHERE id = ? LIMIT 1', [taskId]);
    if (tRows.length === 0)
      return res.status(404).json({ error: `Task "${taskId}" not found` });

    const timestamp = ev.timestamp || new Date().toISOString();
    const logEvent = (outcome, extra) => recordActivity(res, {
      action: `timer_${ev.type}`, taskId,
      details: { outcome, owner: ev.owner || '', department: ev.department || '', timestamp, ...extra },
    });

    // Near-duplicate guard — same rule as saveTaskToDb(). Both timer handlers
    // record each action twice with clocks ~1ms apart, and the exact-timestamp
    // UNIQUE index can not catch that. Skipping the twin here keeps this
    // endpoint consistent with the full-task save path.
    const [recent] = await pool.query(
      'SELECT event_type, timestamp, owner FROM task_time_events WHERE task_id = ?',
      [taskId]
    );
    const seen = recent
      .map(e => ({ type: e.event_type || '', t: Date.parse(e.timestamp), owner: e.owner || '' }))
      .filter(e => !Number.isNaN(e.t));

    if (isDuplicateTimeEvent(seen, { ...ev, timestamp })) {
      logEvent('ignored_duplicate');
      return res.status(200).json({
        ok: true,
        taskId,
        deduplicated: true,
        message: `Event "${ev.type}" for task "${taskId}" ignored as a duplicate of one recorded moments ago`,
      });
    }

    // Single-active-timer guard — same rule as saveTaskToDb(). Pauses whatever
    // else this person has running; drops the event outright if they already
    // have this task open, since recording it would orphan the live segment.
    let pausedTaskIds = [];
    if (isOpeningEvent(ev.type)) {
      // Admin accounts record events with owner '' — resolve those to the task's
      // department owner so bulk admin actions are guarded too, instead of
      // silently leaving every touched task running.
      const guardOwner = await resolveEventOwner(pool, {
        taskId, owner: ev.owner, department: ev.department,
      });
      const guard = await enforceSingleActiveTimer(pool, {
        taskId,
        owner:      guardOwner,
        timestamp,
        department: ev.department || '',
      });
      if (guard.redundant) {
        logEvent('ignored_already_running', guard.pausedTaskIds.length ? { autoPaused: guard.pausedTaskIds } : undefined);
        return res.status(200).json({
          ok: true,
          taskId,
          alreadyRunning: true,
          message: `Task "${taskId}" is already running for ${ev.owner}; ignored a redundant "${ev.type}"`,
        });
      }
      pausedTaskIds = guard.pausedTaskIds;
    }

    await pool.query(
      `INSERT INTO task_time_events (task_id, event_type, timestamp, department, owner)
       VALUES (?, ?, ?, ?, ?)`,
      [taskId, ev.type, timestamp, ev.department || '', ev.owner || '']
    );
    logEvent('recorded', pausedTaskIds.length ? { autoPaused: pausedTaskIds } : undefined);

    res.status(201).json({
      ok: true,
      taskId,
      event: { type: ev.type, timestamp: ev.timestamp, department: ev.department, owner: ev.owner },
      pausedTaskIds,
      message: pausedTaskIds.length
        ? `Event "${ev.type}" recorded for task "${taskId}"; auto-paused ${pausedTaskIds.length} other running task(s)`
        : `Event "${ev.type}" recorded for task "${taskId}"`,
    });

    // Fire-and-forget: check if this task has now exceeded the time threshold.
    // Runs after the response is sent so it never delays the timer action.
    runOverrunCheck(pool, taskId).catch(err =>
      console.error('[timerCheck] post-event check failed:', err.message)
    );
  } catch (e) {
    console.error('POST /api/tasks/:id/events error:', e.message);
    res.status(500).json({ error: 'Failed to record event' });
  }
});

// ── POST /api/tasks/:id/qc-reviews — upsert a single QC review ─────────────
// Atomic: only touches the one review row. Safe for concurrent QC submits —
// User B's submit will not be wiped by User A's concurrent full-task save.
//
// Body: { id, submittedBy, submittedByDept, submittedAt, assignedTo,
//         estHours, note, outcome, completedAt }
tasksRouter.post('/:id/qc-reviews', async (req, res) => {
  const taskId   = req.params.id;
  const qc       = req.body || {};
  const reviewId = qc.id || qc.reviewId || '';

  if (!reviewId)
    return res.status(400).json({ error: 'QC review id is required' });

  try {
    const [tRows] = await pool.query('SELECT id FROM tasks WHERE id = ? LIMIT 1', [taskId]);
    if (tRows.length === 0)
      return res.status(404).json({ error: `Task "${taskId}" not found` });

    await pool.query(
      `INSERT INTO task_qc_reviews
         (task_id, review_id, submitted_by, submitted_by_dept, submitted_at,
          assigned_to, est_hours, note, outcome, completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         submitted_by      = VALUES(submitted_by),
         submitted_by_dept = VALUES(submitted_by_dept),
         submitted_at      = VALUES(submitted_at),
         assigned_to       = VALUES(assigned_to),
         est_hours         = VALUES(est_hours),
         note              = VALUES(note),
         outcome           = VALUES(outcome),
         completed_at      = VALUES(completed_at)`,
      [
        taskId, reviewId, qc.submittedBy || '', qc.submittedByDept || '',
        qc.submittedAt || '', qc.assignedTo || '', qc.estHours || 0,
        qc.note || '', qc.outcome || '', qc.completedAt || '',
      ]
    );

    recordActivity(res, {
      action: 'qc_review_save', taskId,
      details: { reviewId, submittedBy: qc.submittedBy, assignedTo: qc.assignedTo, outcome: qc.outcome },
    });
    res.status(201).json({
      ok: true, taskId, reviewId,
      message: `QC review "${reviewId}" saved for task "${taskId}"`,
    });
  } catch (e) {
    console.error('POST /api/tasks/:id/qc-reviews error:', e.message);
    res.status(500).json({ error: 'Failed to save QC review' });
  }
});

// ── DELETE /api/tasks/:id/qc-reviews/:reviewId ─────────────────────────────
// Explicit single-record delete. Safe: only removes the specified review.
tasksRouter.delete('/:id/qc-reviews/:reviewId', async (req, res) => {
  const { id: taskId, reviewId } = req.params;

  try {
    const [result] = await pool.query(
      'DELETE FROM task_qc_reviews WHERE task_id = ? AND review_id = ?',
      [taskId, reviewId]
    );
    if (result.affectedRows === 0)
      return res.status(404).json({ error: `QC review "${reviewId}" not found on task "${taskId}"` });

    recordActivity(res, { action: 'qc_review_delete', taskId, details: { reviewId } });
    res.json({ ok: true, message: `QC review "${reviewId}" removed` });
  } catch (e) {
    console.error('DELETE /api/tasks/:id/qc-reviews/:reviewId error:', e.message);
    res.status(500).json({ error: 'Failed to delete QC review' });
  }
});

// ── POST /api/tasks/:id/rework — upsert a single rework entry ──────────────
// Atomic: only touches the one rework row. Safe for concurrent rework submits.
//
// Body: { id, date, estHours, assignedDept, assignedOwner, withinEstimate,
//         hoursAlreadySpent, startTimestamp, endTimestamp, durationMs }
tasksRouter.post('/:id/rework', async (req, res) => {
  const taskId   = req.params.id;
  const rw       = req.body || {};
  const reworkId = rw.id || rw.reworkId || '';

  if (!reworkId)
    return res.status(400).json({ error: 'Rework entry id is required' });

  try {
    const [tRows] = await pool.query('SELECT id FROM tasks WHERE id = ? LIMIT 1', [taskId]);
    if (tRows.length === 0)
      return res.status(404).json({ error: `Task "${taskId}" not found` });

    await pool.query(
      `INSERT INTO task_rework_entries
         (task_id, rework_id, date, est_hours, assigned_dept, assigned_owner,
          within_estimate, hours_already_spent, start_timestamp, end_timestamp, duration_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         date                = VALUES(date),
         est_hours           = VALUES(est_hours),
         assigned_dept       = VALUES(assigned_dept),
         assigned_owner      = VALUES(assigned_owner),
         within_estimate     = VALUES(within_estimate),
         hours_already_spent = VALUES(hours_already_spent),
         start_timestamp     = VALUES(start_timestamp),
         end_timestamp       = VALUES(end_timestamp),
         duration_ms         = VALUES(duration_ms)`,
      [
        taskId, reworkId, rw.date || '', rw.estHours || 0,
        rw.assignedDept || '', rw.assignedOwner || '', rw.withinEstimate ? 1 : 0,
        rw.hoursAlreadySpent || 0, rw.startTimestamp || '',
        rw.endTimestamp || '', rw.durationMs || 0,
      ]
    );

    recordActivity(res, {
      action: 'rework_save', taskId,
      details: { reworkId, assignedDept: rw.assignedDept, assignedOwner: rw.assignedOwner },
    });
    res.status(201).json({
      ok: true, taskId, reworkId,
      message: `Rework entry "${reworkId}" saved for task "${taskId}"`,
    });
  } catch (e) {
    console.error('POST /api/tasks/:id/rework error:', e.message);
    res.status(500).json({ error: 'Failed to save rework entry' });
  }
});

// ── DELETE /api/tasks/:id/rework/:reworkId ──────────────────────────────────
// Explicit single-record delete. Safe: only removes the specified entry.
tasksRouter.delete('/:id/rework/:reworkId', async (req, res) => {
  const { id: taskId, reworkId } = req.params;

  try {
    const [result] = await pool.query(
      'DELETE FROM task_rework_entries WHERE task_id = ? AND rework_id = ?',
      [taskId, reworkId]
    );
    if (result.affectedRows === 0)
      return res.status(404).json({ error: `Rework entry "${reworkId}" not found on task "${taskId}"` });

    recordActivity(res, { action: 'rework_delete', taskId, details: { reworkId } });
    res.json({ ok: true, message: `Rework entry "${reworkId}" removed` });
  } catch (e) {
    console.error('DELETE /api/tasks/:id/rework/:reworkId error:', e.message);
    res.status(500).json({ error: 'Failed to delete rework entry' });
  }
});

// ── PATCH /api/tasks/:id/fields — atomic update of any scalar task fields ───
// Updates only the fields present in the request body. Leaves all other fields
// untouched. This is the safe alternative to PUT /:id when you only need to
// change one or two fields without sending the entire task object.
//
// Body: any camelCase subset of task fields, e.g.
//   { remarks: "new note", dueDate: "2026-05-01", isCompleted: true }
// plus optional expectedUpdatedAt — see withVersionCheck(). Response includes
// the task's new `updatedAt`.
tasksRouter.patch('/:id/fields', async (req, res) => {
  const taskId = req.params.id;
  const body   = req.body || {};

  // Whitelist: camelCase input → snake_case DB column
  const FIELD_MAP = {
    title:                  'title',
    client:                 'client',
    focusedKw:              'focused_kw',
    volume:                 'volume',
    marRank:                'mar_rank',
    currentRank:            'current_rank',
    estHours:               'est_hours',
    estHoursSEO:            'est_hours_seo',
    estHoursContent:        'est_hours_content',
    estHoursWeb:            'est_hours_web',
    estHoursContentRework:  'est_hours_content_rework',
    estHoursSEOReview:      'est_hours_seo_review',
    actualHours:            'actual_hours',
    targetUrl:              'target_url',
    daysInStage:            'days_in_stage',
    remarks:                'remarks',
    isCompleted:            'is_completed',
    executionState:         'execution_state',
    docUrl:                 'doc_url',
    intakeDate:             'intake_date',
    deptType:               'dept_type',
    taskType:               'task_type',
    platform:               'platform',
    deliverableUrl:         'deliverable_url',
    dueDate:                'due_date',
    assignedTo:             'assigned_to',
    adBudget:               'ad_budget',
    qcSubmittedAt:          'qc_submitted_at',
    seoOwner:               'seo_owner',
    contentOwner:           'content_owner',
    webOwner:               'web_owner',
    currentOwner:           'current_owner',
    seoStage:               'seo_stage',
    seoQcStatus:            'seo_qc_status',
    contentStatus:          'content_status',
    webStatus:              'web_status',
    contentAssignedDate:    'content_assigned_date',
    webAssignedDate:        'web_assigned_date',
  };

  const updates = [];
  for (const [camel, col] of Object.entries(FIELD_MAP)) {
    if (body[camel] !== undefined && body[camel] !== null) {
      // Coerce isCompleted to 0/1 for MySQL TINYINT
      updates.push([col, camel === 'isCompleted' ? (body[camel] ? 1 : 0) : body[camel]]);
    }
  }

  if (updates.length === 0)
    return res.status(400).json({ error: 'No valid fields provided' });

  try {
    let changes = [];
    const result = await withVersionCheck(taskId, body.expectedUpdatedAt, async conn => {
      changes = await diffColumns(taskId, updates, conn);
      const setClauses = updates.map(([col]) => `${col} = ?`).join(', ');
      await conn.query(
        `UPDATE tasks SET ${setClauses}, updated_at = NOW() WHERE id = ?`,
        [...updates.map(([, v]) => v), taskId]
      );
    });

    if (result.status === 'missing')
      return res.status(404).json({ error: `Task "${taskId}" not found` });
    if (result.status === 'conflict')
      return refuseConflict(res, taskId, body.expectedUpdatedAt, result, Object.fromEntries(updates));

    recordActivity(res, { action: 'task_fields', taskId, changes });

    res.json({
      ok: true,
      taskId,
      updated: Object.fromEntries(updates),
      updatedAt: result.updatedAt,
      message: `Task "${taskId}" updated successfully`,
    });
  } catch (e) {
    console.error('PATCH /api/tasks/:id/fields error:', e.message);
    res.status(500).json({ error: 'Failed to update task fields' });
  }
});
