/**
 * keyword-update.routes.js — Keyword Update panel endpoints.
 *
 * GET  /api/keyword-update?client=X&from=YYYY-MM-DD&to=YYYY-MM-DD
 *   Returns lightweight task rows (id, title, owner, contentOwner,
 *   keyword, volume, was, now) for the given client + date range.
 *
 * PATCH /api/keyword-update/bulk
 *   Body: { updates: [{ id, keyword?, volume?, was?, now? }, ...] }
 *   Bulk-updates keyword/ranking fields for the supplied tasks. Each row
 *   is a sparse update — only fields present on that row are touched, so
 *   concurrent edits to other task columns are never clobbered.
 */

import { Router } from 'express';
import pool from '../config/db.js';

export const keywordUpdateRouter = Router();

const FIELD_MAP = {
  keyword: 'focused_kw',
  volume:  'volume',
  was:     'mar_rank',
  now:     'current_rank',
};

// ── GET /api/keyword-update ─────────────────────────────────────────────────
keywordUpdateRouter.get('/', async (req, res) => {
  const { client, from, to } = req.query;
  if (!client) return res.status(400).json({ error: 'client param required' });
  if (!from || !to) return res.status(400).json({ error: 'from and to params required' });

  try {
    const [rows] = await pool.query(
      `SELECT id, title, seo_owner, content_owner, focused_kw, volume, mar_rank, current_rank
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
      keyword:      r.focused_kw    || '',
      volume:       r.volume        ?? 0,
      was:          r.mar_rank      ?? 0,
      now:          r.current_rank  ?? 0,
    })));
  } catch (e) {
    console.error('GET /api/keyword-update error:', e.message);
    res.status(500).json({ error: 'Failed to load keyword update data' });
  }
});

// ── PATCH /api/keyword-update/bulk ──────────────────────────────────────────
keywordUpdateRouter.patch('/bulk', async (req, res) => {
  const { updates } = req.body;

  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: 'updates must be a non-empty array' });
  }

  let updated = 0;
  const failed = [];

  for (const row of updates) {
    const { id } = row || {};
    if (!id) {
      failed.push({ id: null, error: 'missing id' });
      continue;
    }

    const setCols = [];
    const values = [];
    for (const [key, col] of Object.entries(FIELD_MAP)) {
      if (row[key] !== undefined && row[key] !== null) {
        setCols.push(`${col} = ?`);
        values.push(row[key]);
      }
    }

    if (setCols.length === 0) {
      failed.push({ id, error: 'no valid fields provided' });
      continue;
    }

    try {
      const [result] = await pool.query(
        `UPDATE tasks SET ${setCols.join(', ')}, updated_at = NOW() WHERE id = ?`,
        [...values, id]
      );
      if (result.affectedRows === 0) {
        failed.push({ id, error: 'task not found' });
      } else {
        updated += 1;
      }
    } catch (e) {
      console.error(`PATCH /api/keyword-update/bulk error for id=${id}:`, e.message);
      failed.push({ id, error: 'update failed' });
    }
  }

  res.json({ updated, failed });
});
