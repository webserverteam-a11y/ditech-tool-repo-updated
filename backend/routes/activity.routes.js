/**
 * activity.routes.js — Read the server-side activity log; restore deleted tasks.
 *
 * GET  /api/activity                      — search the log
 *        ?task=   task id or (part of) a title
 *        ?user=   user name (partial)
 *        ?action= action (partial), e.g. task_update, timer_end, task_delete
 *        ?tab=    exact tab id — everything one browser tab did
 *        ?hours=  look-back window (default 24)
 *        ?limit=  max rows (default 300, max 2000)
 *        ?beforeId= paging: only rows older than this id
 * GET  /api/activity/deleted              — archived deleted tasks (?q= title/id)
 * GET  /api/activity/deleted/:id          — one archive incl. full snapshot
 * POST /api/activity/deleted/:id/restore  — put a deleted task back
 *
 * See backend/services/activityLog.service.js for what is recorded.
 */

import { Router } from 'express';
import pool from '../config/db.js';
import { TASK_COLS } from '../utils/taskMapping.js';
import { recordActivity } from '../services/activityLog.service.js';

export const activityRouter = Router();

function parseJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

// ── GET /api/activity ─────────────────────────────────────────────────────
activityRouter.get('/', async (req, res) => {
  const hours = Math.min(Number(req.query.hours) || 24, 24 * 90);
  const limit = Math.min(Number(req.query.limit) || 300, 2000);
  const where = ['a.created_at >= NOW() - INTERVAL ? HOUR'];
  const params = [hours];

  if (req.query.task) {
    const t = String(req.query.task);
    // id match, current title match, or title recorded in details (deleted tasks)
    where.push('(a.task_id = ? OR t.title LIKE ? OR a.details LIKE ?)');
    params.push(t, `%${t}%`, `%${t}%`);
  }
  if (req.query.user)     { where.push('a.user_name LIKE ?'); params.push(`%${req.query.user}%`); }
  if (req.query.action)   { where.push('a.action LIKE ?');    params.push(`%${req.query.action}%`); }
  if (req.query.tab)      { where.push('a.tab_id = ?');       params.push(String(req.query.tab)); }
  if (req.query.beforeId) { where.push('a.id < ?');           params.push(Number(req.query.beforeId)); }

  try {
    const [rows] = await pool.query(
      `SELECT a.*, t.title AS task_title
         FROM activity_log a
         LEFT JOIN tasks t ON t.id = a.task_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.id DESC
        LIMIT ?`,
      [...params, limit]
    );
    res.json(rows.map(r => ({
      id: r.id, at: r.created_at, method: r.method, path: r.path,
      status: r.status, durationMs: r.duration_ms,
      user: r.user_name, tabId: r.tab_id, appLoadedAt: r.app_loaded_at,
      appBundle: r.app_bundle, ip: r.ip, userAgent: r.user_agent,
      action: r.action, taskId: r.task_id, taskTitle: r.task_title || '',
      changes: parseJson(r.changes), details: parseJson(r.details),
    })));
  } catch (e) {
    console.error('GET /api/activity error:', e.message);
    res.status(500).json({ error: 'Failed to load activity log' });
  }
});

// ── GET /api/activity/deleted ─────────────────────────────────────────────
activityRouter.get('/deleted', async (req, res) => {
  const q = req.query.q ? String(req.query.q) : '';
  try {
    const [rows] = await pool.query(
      `SELECT id, task_id, title, client, deleted_at, deleted_by, tab_id, ip, restored_at
         FROM deleted_tasks
        ${q ? 'WHERE task_id = ? OR title LIKE ?' : ''}
        ORDER BY id DESC LIMIT 500`,
      q ? [q, `%${q}%`] : []
    );
    res.json(rows.map(r => ({
      id: r.id, taskId: r.task_id, title: r.title, client: r.client,
      deletedAt: r.deleted_at, deletedBy: r.deleted_by, tabId: r.tab_id,
      ip: r.ip, restoredAt: r.restored_at,
    })));
  } catch (e) {
    console.error('GET /api/activity/deleted error:', e.message);
    res.status(500).json({ error: 'Failed to load deleted tasks' });
  }
});

// ── GET /api/activity/deleted/:id ─────────────────────────────────────────
activityRouter.get('/deleted/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM deleted_tasks WHERE id = ? LIMIT 1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Archive not found' });
    const r = rows[0];
    res.json({
      id: r.id, taskId: r.task_id, title: r.title, deletedAt: r.deleted_at,
      deletedBy: r.deleted_by, restoredAt: r.restored_at, snapshot: parseJson(r.snapshot),
    });
  } catch (e) {
    console.error('GET /api/activity/deleted/:id error:', e.message);
    res.status(500).json({ error: 'Failed to load archive' });
  }
});

// Child-table columns restored from a snapshot (fixed list, never from input).
const CHILD_COLS = {
  task_time_events:    ['event_type', 'timestamp', 'department', 'owner'],
  task_qc_reviews:     ['review_id', 'submitted_by', 'submitted_by_dept', 'submitted_at',
                        'assigned_to', 'est_hours', 'note', 'outcome', 'completed_at'],
  task_rework_entries: ['rework_id', 'date', 'est_hours', 'assigned_dept', 'assigned_owner',
                        'within_estimate', 'hours_already_spent', 'start_timestamp',
                        'end_timestamp', 'duration_ms'],
};

async function insertChildren(conn, table, taskId, rows) {
  const cols = CHILD_COLS[table];
  for (const r of rows || []) {
    await conn.query(
      `INSERT IGNORE INTO ${table} (task_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`,
      [taskId, ...cols.map(c => r[c] ?? null)]
    );
  }
}

// ── POST /api/activity/deleted/:id/restore ────────────────────────────────
// Re-creates the task exactly as archived (row + timer events + QC + rework).
// Refuses if a task with that id exists again, so it can never overwrite.
activityRouter.post('/deleted/:id/restore', async (req, res) => {
  let conn;
  try {
    const [rows] = await pool.query('SELECT * FROM deleted_tasks WHERE id = ? LIMIT 1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Archive not found' });
    const archive = rows[0];
    const snap = parseJson(archive.snapshot);
    if (!snap || !snap.task) return res.status(500).json({ error: 'Archive snapshot is unreadable' });

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [exists] = await conn.query('SELECT id FROM tasks WHERE id = ? LIMIT 1 FOR UPDATE', [archive.task_id]);
    if (exists.length) {
      await conn.rollback();
      return res.status(409).json({ error: `Task "${archive.task_id}" already exists — not restored` });
    }

    await conn.query(
      `INSERT INTO tasks (${TASK_COLS.join(', ')}) VALUES (${TASK_COLS.map(() => '?').join(', ')})`,
      TASK_COLS.map(c => snap.task[c] ?? null)
    );
    await insertChildren(conn, 'task_time_events',    archive.task_id, snap.timeEvents);
    await insertChildren(conn, 'task_qc_reviews',     archive.task_id, snap.qcReviews);
    await insertChildren(conn, 'task_rework_entries', archive.task_id, snap.reworkEntries);
    await conn.query('UPDATE deleted_tasks SET restored_at = NOW() WHERE id = ?', [archive.id]);
    await conn.commit();

    recordActivity(res, {
      action: 'task_restore', taskId: archive.task_id,
      details: { title: archive.title, archiveId: archive.id, deletedBy: archive.deleted_by },
    });
    res.json({ ok: true, taskId: archive.task_id, message: `Task "${archive.title}" restored` });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('POST /api/activity/deleted/:id/restore error:', e.message);
    res.status(500).json({ error: 'Failed to restore task' });
  } finally {
    if (conn) conn.release();
  }
});
