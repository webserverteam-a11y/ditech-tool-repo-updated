/**
 * indexing.routes.js — Indexing Status panel endpoints.
 *
 * GET  /api/indexing?client=X&from=YYYY-MM-DD&to=YYYY-MM-DD
 *   Returns lightweight task rows (id, title, owner, content_owner,
 *   target_url, index_status) for the given client + date range.
 *
 * PATCH /api/indexing/bulk
 *   Body: { ids: string[], status: 'Indexed' | 'Non-Indexed' | 'Not Checked' | 'In Progress' }
 *   Bulk-updates index_status for the supplied task IDs.
 */

import { Router } from 'express';
import pool from '../config/db.js';

export const indexingRouter = Router();

const ALLOWED_STATUSES = ['Indexed', 'Non-Indexed', 'Not Checked', 'In Progress'];

// ── GET /api/indexing ──────────────────────────────────────────────────────
indexingRouter.get('/', async (req, res) => {
  const { client, from, to } = req.query;
  if (!client) return res.status(400).json({ error: 'client param required' });
  if (!from || !to) return res.status(400).json({ error: 'from and to params required' });

  try {
    const [rows] = await pool.query(
      `SELECT id, title, seo_owner, content_owner, target_url, index_status
       FROM tasks
       WHERE client = ?
         AND intake_date >= ?
         AND intake_date <= ?
       ORDER BY intake_date DESC, id`,
      [client, from, to]
    );

    res.json(rows.map(r => ({
      id:           r.id,
      title:        r.title         || '',
      owner:        r.seo_owner     || '',
      contentOwner: r.content_owner || '',
      targetUrl:    r.target_url    || '',
      indexStatus:  r.index_status  || '',
    })));
  } catch (e) {
    console.error('GET /api/indexing error:', e.message);
    res.status(500).json({ error: 'Failed to load indexing data' });
  }
});

// ── PATCH /api/indexing/bulk ───────────────────────────────────────────────
indexingRouter.patch('/bulk', async (req, res) => {
  const { ids, status } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  if (!ALLOWED_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` });
  }

  try {
    const placeholders = ids.map(() => '?').join(', ');
    const [result] = await pool.query(
      `UPDATE tasks SET index_status = ?, updated_at = NOW() WHERE id IN (${placeholders})`,
      [status, ...ids]
    );

    res.json({ updated: result.affectedRows });
  } catch (e) {
    console.error('PATCH /api/indexing/bulk error:', e.message);
    res.status(500).json({ error: 'Failed to update indexing status' });
  }
});
