/**
 * leave.routes.js — Leave records CRUD.
 *
 * GET    /api/leave-records       — list all
 * POST   /api/leave-records       — add single record (safe, no bulk wipe)
 * DELETE /api/leave-records/:id   — remove single record
 *
 * CONCURRENCY FIX vs old PUT /api/leave-records:
 *   The old bulk PUT did DELETE WHERE id NOT IN (...) which silently wiped
 *   leave records added by other concurrent users. That endpoint is removed.
 *   All mutations now go through single-record POST / DELETE endpoints.
 */

import { Router } from 'express';
import pool from '../config/db.js';

export const leaveRouter = Router();

// ── GET — list all leave records ──────────────────────────────────────────
leaveRouter.get('/', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, user_name, user_role, leave_date, leave_type, reason, status
       FROM leave_records ORDER BY leave_date DESC`
    );
    res.json(rows.map(r => ({
      id:        r.id,
      owner:     r.user_name,
      userRole:  r.user_role,
      date:      r.leave_date
                   ? (r.leave_date instanceof Date
                       ? `${r.leave_date.getFullYear()}-${String(r.leave_date.getMonth()+1).padStart(2,'0')}-${String(r.leave_date.getDate()).padStart(2,'0')}`
                       : String(r.leave_date).slice(0, 10))
                   : '',
      type:      r.leave_type,
      note:      r.reason,
      status:    r.status,
    })));
  } catch (e) {
    console.error('GET /api/leave-records error:', e.message);
    res.status(500).json({ error: 'Failed to load leave records' });
  }
});

// ── PUT — bulk upsert (from sync bridge / localStorage flush) ───────────────
// Accepts [{id, owner/userName, date/leaveDate, type/leaveType, note/reason}]
// SAFE: upsert-only, never deletes. Concurrent users' records are preserved.
leaveRouter.put('/', async (req, res) => {
  const records = req.body;
  if (!Array.isArray(records)) return res.status(400).json({ error: 'Expected array' });
  if (records.length === 0)
    return res.json({ ok: true, count: 0, message: 'No leave records provided, nothing changed.' });

  let saved = 0;
  try {
    for (const r of records) {
      const id        = r.id || ('lv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
      const userName  = r.owner    || r.userName  || r.user_name  || '';
      const leaveDate = r.date     || r.leaveDate || r.leave_date || '';
      const leaveType = r.type     || r.leaveType || r.leave_type || 'full';
      const reason    = r.note     || r.reason    || '';
      const userRole  = r.userRole || r.user_role || '';
      if (!leaveDate) continue;
      await pool.query(
        `INSERT INTO leave_records (id, user_name, user_role, leave_date, leave_type, reason, status)
         VALUES (?, ?, ?, ?, ?, ?, 'approved')
         ON DUPLICATE KEY UPDATE
           user_name=VALUES(user_name), user_role=VALUES(user_role),
           leave_date=VALUES(leave_date), leave_type=VALUES(leave_type),
           reason=VALUES(reason)`,
        [id, userName, userRole, leaveDate, leaveType, reason]
      );
      saved++;
    }
    console.log(`PUT /api/leave-records: upserted ${saved} records`);
    res.json({ ok: true, count: saved, message: `${saved} leave record(s) saved successfully` });
  } catch (e) {
    console.error('PUT /api/leave-records error:', e.message);
    res.status(500).json({ error: 'Failed to save leave records' });
  }
});

// ── POST — add single leave record ────────────────────────────────────────
leaveRouter.post('/', async (req, res) => {
  const r = req.body || {};
  const id        = r.id || ('lv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
  const userName  = r.owner || r.userName  || r.user_name  || '';
  const leaveDate = r.date  || r.leaveDate || r.leave_date || '';
  const leaveType = r.type  || r.leaveType || r.leave_type || 'full';
  const reason    = r.note  || r.reason    || '';
  const userRole  = r.userRole || r.user_role || '';

  if (!leaveDate)
    return res.status(400).json({ error: 'date is required' });

  try {
    await pool.query(
      `INSERT INTO leave_records (id, user_name, user_role, leave_date, leave_type, reason, status)
       VALUES (?, ?, ?, ?, ?, ?, 'approved')
       ON DUPLICATE KEY UPDATE
         user_name  = VALUES(user_name),  user_role  = VALUES(user_role),
         leave_date = VALUES(leave_date), leave_type = VALUES(leave_type),
         reason     = VALUES(reason)`,
      [id, userName, userRole, leaveDate, leaveType, reason]
    );
    res.status(201).json({ ok: true, id, message: 'Leave record saved successfully' });
  } catch (e) {
    console.error('POST /api/leave-records error:', e.message);
    res.status(500).json({ error: 'Failed to save leave record' });
  }
});

// ── DELETE — remove single leave record ───────────────────────────────────
leaveRouter.delete('/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: 'id is required' });

  try {
    const [result] = await pool.query('DELETE FROM leave_records WHERE id = ?', [id]);
    if (result.affectedRows === 0)
      return res.status(404).json({ error: `Record "${id}" not found` });

    res.json({ ok: true, message: `Leave record deleted successfully` });
  } catch (e) {
    console.error('DELETE /api/leave-records/:id error:', e.message);
    res.status(500).json({ error: 'Failed to delete leave record' });
  }
});
