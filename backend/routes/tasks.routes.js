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
    const setClauses = updates.map(([col]) => `${col} = ?`).join(', ');
    const values     = [...updates.map(([, v]) => v), taskId];

    const [result] = await pool.query(
      `UPDATE tasks SET ${setClauses}, updated_at = NOW() WHERE id = ?`,
      values
    );

    if (result.affectedRows === 0)
      return res.status(404).json({ error: `Task "${taskId}" not found` });

    res.json({
      ok: true,
      taskId,
      updated: Object.fromEntries(updates),
      message: `Task "${taskId}" updated successfully`,
    });
  } catch (e) {
    console.error('PATCH /api/tasks/:id/fields error:', e.message);
    res.status(500).json({ error: 'Failed to update task fields' });
  }
});
