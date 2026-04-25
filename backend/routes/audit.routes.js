/**
 * audit.routes.js — Audit log endpoints.
 *
 * POST   /api/audit            — log one or more events
 * GET    /api/audit            — list events for a month (?month=YYYY-MM)
 * GET    /api/audit/months     — list distinct months that have events
 * DELETE /api/audit/:id        — delete a single audit event
 * GET    /api/audit/download   — download as CSV (?month=YYYY-MM)
 */

import { Router } from 'express';
import pool from '../config/db.js';

export const auditRouter = Router();

// ── POST — log events ─────────────────────────────────────────────────────
auditRouter.post('/', async (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];
  const month  = new Date().toISOString().slice(0, 7);
  const savedIds = [];

  try {
    for (const e of events) {
      const id = e.id || ('evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
      await pool.query(
        `INSERT INTO audit_logs
           (id, month, timestamp, user_name, user_role, action,
            task_id, task_title, client, source, field, old_value, new_value, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, month, e.timestamp || null, e.userName || null, e.userRole || null,
          e.action || null, e.taskId || null, e.taskTitle || null, e.client || null,
          e.source || null, e.field || null, e.oldValue || null, e.newValue || null,
          e.note || null,
        ]
      );
      savedIds.push(id);
    }

    const ph = savedIds.map(() => '?').join(',');
    const [vRows] = await pool.query(
      `SELECT COUNT(*) AS c FROM audit_logs WHERE id IN (${ph})`, savedIds
    );
    const verified = Number(vRows[0].c) === savedIds.length;

    res.json({
      ok: true, count: events.length,
      dbVerified: verified,
      message: verified
        ? `${events.length} audit event(s) logged and verified`
        : `${events.length} event(s) logged — DB verified ${vRows[0].c} of ${savedIds.length}`,
    });
  } catch (e) {
    console.error('POST /api/audit error:', e.message);
    res.status(500).json({ error: 'Failed to save audit log' });
  }
});

// ── GET /api/audit/months — must come before /:id ─────────────────────────
auditRouter.get('/months', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT DISTINCT month FROM audit_logs ORDER BY month DESC'
    );
    res.json(rows.map(r => r.month));
  } catch (e) {
    console.error('GET /api/audit/months error:', e.message);
    res.status(500).json({ error: 'Failed to load audit months' });
  }
});

// ── GET /api/audit/download — CSV export ──────────────────────────────────
auditRouter.get('/download', async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  try {
    const [rows] = await pool.query(
      'SELECT * FROM audit_logs WHERE month = ? ORDER BY created_at', [month]
    );
    const headers = [
      'Timestamp','User','Role','Action','Task ID','Task Title',
      'Client','Source','Field','Old Value','New Value','Note',
    ];
    const csvRows = rows.map(e =>
      [
        e.timestamp, e.user_name, e.user_role, e.action,
        e.task_id || '', e.task_title || '', e.client || '',
        e.source || '', e.field || '', e.old_value || '',
        e.new_value || '', e.note || '',
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
    );
    const csv = [headers.join(','), ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${month}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('GET /api/audit/download error:', e.message);
    res.status(500).json({ error: 'Failed to generate CSV' });
  }
});

// ── GET /api/audit — list events ──────────────────────────────────────────
auditRouter.get('/', async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  try {
    const [rows] = await pool.query(
      'SELECT * FROM audit_logs WHERE month = ? ORDER BY created_at', [month]
    );
    res.json(rows.map(r => ({
      id: r.id, month: r.month, timestamp: r.timestamp,
      userName: r.user_name, userRole: r.user_role, action: r.action,
      taskId: r.task_id, taskTitle: r.task_title, client: r.client,
      source: r.source, field: r.field, oldValue: r.old_value,
      newValue: r.new_value, note: r.note,
    })));
  } catch (e) {
    console.error('GET /api/audit error:', e.message);
    res.status(500).json({ error: 'Failed to load audit logs' });
  }
});

// ── DELETE /api/audit/:id ─────────────────────────────────────────────────
auditRouter.delete('/:id', async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  try {
    const [rows] = await pool.query(
      'SELECT * FROM audit_logs WHERE id = ? AND month = ?',
      [req.params.id, month]
    );
    if (rows.length === 0)
      return res.status(404).json({ error: 'Event not found' });

    await pool.query('DELETE FROM audit_logs WHERE id = ?', [req.params.id]);
    const evt = rows[0];
    res.json({
      ok: true,
      event: {
        id: evt.id, month: evt.month, timestamp: evt.timestamp,
        userName: evt.user_name, userRole: evt.user_role, action: evt.action,
        taskId: evt.task_id, taskTitle: evt.task_title, client: evt.client,
        source: evt.source, field: evt.field, oldValue: evt.old_value,
        newValue: evt.new_value, note: evt.note,
      },
    });
  } catch (e) {
    console.error('DELETE /api/audit/:id error:', e.message);
    res.status(500).json({ error: 'Failed to delete audit event' });
  }
});
