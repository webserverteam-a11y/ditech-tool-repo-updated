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
import { saveTaskToDb } from '../utils/saveTask.js';
import { rowToTask } from '../utils/taskMapping.js';
import { normalizeTaskDates } from '../utils/dateNormalize.js';
import { groupBy } from '../utils/taskMapping.js';

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

// Helper: save one task in its own transaction, with up to `retries` retries
// on deadlock (ER_LOCK_DEADLOCK) or lock-wait timeout (ER_LOCK_WAIT_TIMEOUT).
async function saveOneTask(task, retries = 3) {
  let conn;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();
      await saveTaskToDb(conn, task);
      await conn.commit();
      conn.release();
      return;
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
    for (const t of tasks) await saveOneTask(t);

    const ph = ids.map(() => '?').join(',');
    const [vRows] = await pool.query(`SELECT COUNT(*) AS c FROM tasks WHERE id IN (${ph})`, ids);
    const verified = Number(vRows[0].c) === ids.length;

    res.json({
      ok: true, count: tasks.length,
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
    await saveTaskToDb(conn, task);
    await conn.commit();

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
    await conn.query('DELETE FROM task_time_events   WHERE task_id = ?', [taskId]);
    await conn.query('DELETE FROM task_qc_reviews    WHERE task_id = ?', [taskId]);
    await conn.query('DELETE FROM task_rework_entries WHERE task_id = ?', [taskId]);
    const [result] = await conn.query('DELETE FROM tasks WHERE id = ?', [taskId]);
    await conn.commit();

    if (result.affectedRows === 0)
      return res.status(404).json({ error: `Task "${taskId}" not found` });

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
//         seoStage, executionState, seoQcStatus, contentStatus, webStatus }
// Any field omitted from the body is left unchanged in the DB.
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
    const setClauses = ASSIGNABLE.map(([col]) => `${col} = ?`).join(', ');
    const values     = ASSIGNABLE.map(([, v]) => v);
    values.push(taskId);

    const [result] = await pool.query(
      `UPDATE tasks SET ${setClauses}, updated_at = NOW() WHERE id = ?`,
      values
    );

    if (result.affectedRows === 0)
      return res.status(404).json({ error: `Task "${taskId}" not found` });

    const updated = Object.fromEntries(ASSIGNABLE);
    res.json({
      ok: true,
      taskId,
      updated,
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

    await pool.query(
      `INSERT INTO task_time_events (task_id, event_type, timestamp, department, owner)
       VALUES (?, ?, ?, ?, ?)`,
      [taskId, ev.type, ev.timestamp || new Date().toISOString(), ev.department || '', ev.owner || '']
    );

    res.status(201).json({
      ok: true,
      taskId,
      event: { type: ev.type, timestamp: ev.timestamp, department: ev.department, owner: ev.owner },
      message: `Event "${ev.type}" recorded for task "${taskId}"`,
    });
  } catch (e) {
    console.error('POST /api/tasks/:id/events error:', e.message);
    res.status(500).json({ error: 'Failed to record event' });
  }
});
