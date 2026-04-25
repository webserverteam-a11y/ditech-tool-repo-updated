/**
 * workhub.routes.js — WorkHub remarks CRUD.
 *
 * GET    /api/workhub-remarks       — list all
 * POST   /api/workhub-remarks       — add single remark (safe, no bulk wipe)
 * DELETE /api/workhub-remarks/:id   — remove single remark
 *
 * CONCURRENCY FIX vs old PUT /api/workhub-remarks:
 *   The old bulk PUT did DELETE WHERE id NOT IN (...) which silently wiped
 *   remarks added by other concurrent users. That endpoint is removed.
 *   All mutations now go through single-record POST / DELETE endpoints.
 */

import { Router } from 'express';
import pool from '../config/db.js';

export const workhubRouter = Router();

// ── GET — list all remarks ─────────────────────────────────────────────────
workhubRouter.get('/', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, task_id, user_name, user_role, remark, created_at
       FROM workhub_remarks ORDER BY created_at DESC`
    );
    res.json(rows.map(r => ({
      id:        r.id,
      taskId:    r.task_id,
      userName:  r.user_name,
      userRole:  r.user_role,
      remark:    r.remark,
      createdAt: r.created_at,
    })));
  } catch (e) {
    console.error('GET /api/workhub-remarks error:', e.message);
    res.status(500).json({ error: 'Failed to load remarks' });
  }
});

// ── POST — add single remark ───────────────────────────────────────────────
workhubRouter.post('/', async (req, res) => {
  const r = req.body || {};
  const id       = r.id || ('rm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
  const taskId   = r.taskId   || r.task_id   || '';
  const userName = r.userName || r.user_name || '';
  const userRole = r.userRole || r.user_role || '';
  const remark   = r.remark   || '';

  if (!remark.trim())
    return res.status(400).json({ error: 'remark text is required' });

  try {
    await pool.query(
      `INSERT INTO workhub_remarks (id, task_id, user_name, user_role, remark)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         task_id   = VALUES(task_id),
         user_name = VALUES(user_name),
         user_role = VALUES(user_role),
         remark    = VALUES(remark)`,
      [id, taskId, userName, userRole, remark]
    );
    res.status(201).json({ ok: true, id, message: 'Remark saved successfully' });
  } catch (e) {
    console.error('POST /api/workhub-remarks error:', e.message);
    res.status(500).json({ error: 'Failed to save remark' });
  }
});

// ── DELETE — remove single remark ─────────────────────────────────────────
workhubRouter.delete('/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'id is required' });

  try {
    const [result] = await pool.query('DELETE FROM workhub_remarks WHERE id = ?', [id]);
    if (result.affectedRows === 0)
      return res.status(404).json({ error: `Remark "${id}" not found` });

    res.json({ ok: true, message: 'Remark deleted successfully' });
  } catch (e) {
    console.error('DELETE /api/workhub-remarks/:id error:', e.message);
    res.status(500).json({ error: 'Failed to delete remark' });
  }
});
