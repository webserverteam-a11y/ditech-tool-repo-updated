/**
 * keywords.routes.js — Historical keywords CRUD + CSV upload.
 *
 * GET    /api/historical-keywords        — list all (includes updatedAt)
 * POST   /api/historical-keywords        — add single keyword
 * PATCH  /api/historical-keywords/:id    — sparse update (only fields sent)
 * DELETE /api/historical-keywords/:id    — delete single keyword
 * POST   /api/keywords/upload-csv        — bulk import from CSV
 *
 * Multi-user concurrency design:
 *
 *   PATCH /:id — SPARSE update (safe for multi-user):
 *     Only updates the fields explicitly present in the request body.
 *     Omitting a field leaves its DB value completely untouched.
 *     Two users editing different fields on the same keyword simultaneously
 *     will NOT overwrite each other's work.
 *
 *   PUT / — Bulk sync from localStorage (metadata-only for existing rows):
 *     ranking fields (volume, rank_value, current_rank) are intentionally
 *     NOT in the ON DUPLICATE KEY UPDATE clause. This prevents a stale
 *     browser snapshot from silently overwriting ranking values that were
 *     set by another user or by a direct DB edit.
 *     New records (first-time INSERT) still get their ranking fields set.
 *     Use PATCH /:id to explicitly update rankings on an existing keyword.
 *
 *   historical_keywords.updated_at — auto-managed by MySQL ON UPDATE CURRENT_TIMESTAMP.
 *     Exposed as `updatedAt` in the GET response so clients can detect staleness.
 */

import { Router } from 'express';
import express from 'express';
import pool from '../config/db.js';
import { parseCsvLine as parseCsv } from '../utils/csvParser.js';

export const keywordsRouter = Router();

// ── GET — list all keywords ────────────────────────────────────────────────
keywordsRouter.get('/', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, task_id, keyword, month, rank_value, volume, client,
              seo_owner, intake_date, current_rank, target_url, task_title,
              source, recorded_at, updated_at
       FROM historical_keywords ORDER BY recorded_at DESC`
    );
    res.json(rows.map(r => ({
      id:          r.id,
      taskId:      r.task_id,
      keyword:     r.keyword,
      month:       r.month,
      rank:        r.rank_value,
      volume:      r.volume,
      client:      r.client,
      seoOwner:    r.seo_owner    || '',
      date:        r.intake_date  || '',
      currentRank: r.current_rank || 0,
      targetUrl:   r.target_url   || '',
      taskTitle:   r.task_title   || '',
      source:      r.source       || 'historical',
      recordedAt:  r.recorded_at,
      updatedAt:   r.updated_at   || r.recorded_at,
    })));
  } catch (e) {
    console.error('GET /api/historical-keywords error:', e.message);
    res.status(500).json({ error: 'Failed to load keywords' });
  }
});

// ── PUT — bulk upsert (from sync bridge / localStorage flush) ─────────────
// Accepts array in React-internal format: [{id?, keyword, volume, rank, client, ...}]
//
// CONCURRENCY FIX — ranking fields protected on existing rows:
//   The old ON DUPLICATE KEY UPDATE included `volume=VALUES(volume)`,
//   `rank_value=VALUES(rank_value)`, and `current_rank=VALUES(current_rank)`.
//   That meant when any user's stale browser state flushed (e.g. User B who
//   hadn't seen User A's direct DB edit), the bulk sync would silently overwrite
//   volume/rank values that User A or an admin had just set.
//
//   Fix: for existing rows (ON DUPLICATE KEY UPDATE), ranking fields are kept at
//   their current DB value — they are intentionally NOT in the UPDATE clause.
//   Only NEW records (INSERT path) get their ranking fields set from the payload.
//
//   To change rankings on an existing keyword, use PATCH /:id (single-record,
//   sparse update) which only touches the fields you explicitly provide.
keywordsRouter.put('/', async (req, res) => {
  const data = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: 'Expected array' });
  if (data.length === 0)
    return res.json({ ok: true, count: 0, message: 'No keywords provided, nothing changed.' });

  let saved = 0;
  try {
    for (const kw of data) {
      const keyword    = kw.keyword    || kw.focusedKw  || '';
      const volume     = Number(kw.volume)    || 0;
      const rankValue  = Number(kw.rank)      || Number(kw.rank_value) || Number(kw.marRank) || 0;
      const client     = kw.client     || '';
      const seoOwner   = kw.seoOwner   || kw.seo_owner  || '';
      const intakeDate = kw.date       || kw.intakeDate  || kw.intake_date || '';
      const curRank    = Number(kw.currentRank) || Number(kw.current_rank) || 0;
      const targetUrl  = kw.targetUrl  || kw.target_url || '';
      const taskTitle  = kw.taskTitle  || kw.task_title  || '';
      const source     = kw.source     || 'historical';
      if (!keyword) continue;

      if (kw.id) {
        await pool.query(
          `INSERT INTO historical_keywords
             (id, keyword, volume, rank_value, client, seo_owner, intake_date,
              current_rank, target_url, task_title, source)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE
             keyword=VALUES(keyword),
             -- volume, rank_value, current_rank intentionally NOT updated here:
             -- bulk sync must never overwrite rankings set by another user or a
             -- direct DB edit. Use PATCH /:id to update rankings explicitly.
             client=VALUES(client),
             seo_owner=VALUES(seo_owner),
             intake_date=VALUES(intake_date),
             target_url=VALUES(target_url),
             task_title=VALUES(task_title)`,
          [kw.id, keyword, volume, rankValue, client, seoOwner, intakeDate,
           curRank, targetUrl, taskTitle, source]
        );
      } else {
        await pool.query(
          `INSERT INTO historical_keywords
             (keyword, volume, rank_value, client, seo_owner, intake_date,
              current_rank, target_url, task_title, source)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [keyword, volume, rankValue, client, seoOwner, intakeDate,
           curRank, targetUrl, taskTitle, source]
        );
      }
      saved++;
    }
    console.log(`PUT /api/historical-keywords: upserted ${saved} keywords`);
    res.json({ ok: true, count: saved, message: `${saved} keyword(s) saved successfully` });
  } catch (e) {
    console.error('PUT /api/historical-keywords error:', e.message);
    res.status(500).json({ error: 'Failed to save keywords' });
  }
});

// ── POST — add single keyword ──────────────────────────────────────────────
keywordsRouter.post('/', async (req, res) => {
  const kw = req.body;
  if (!kw || !kw.focusedKw)
    return res.status(400).json({ error: 'Missing keyword data (focusedKw required)' });

  try {
    const [result] = await pool.query(
      `INSERT INTO historical_keywords
         (keyword, volume, rank_value, client, seo_owner, intake_date,
          current_rank, target_url, task_title, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        kw.focusedKw || '', kw.volume || 0, kw.marRank || 0,
        kw.client || '', kw.seoOwner || '', kw.date || '',
        kw.currentRank || 0, kw.targetUrl || '', kw.taskTitle || '',
        kw.source || 'historical',
      ]
    );
    res.status(201).json({ ok: true, id: result.insertId, message: 'Keyword added successfully' });
  } catch (e) {
    console.error('POST /api/historical-keywords error:', e.message);
    res.status(500).json({ error: 'Failed to add keyword' });
  }
});

// Keep the /add alias for backward-compat with the patched bundle
keywordsRouter.post('/add', async (req, res) => {
  const kw = req.body;
  if (!kw || !kw.focusedKw)
    return res.status(400).json({ error: 'Missing keyword data' });

  try {
    const [result] = await pool.query(
      `INSERT INTO historical_keywords
         (keyword, volume, rank_value, client, seo_owner, intake_date,
          current_rank, target_url, task_title, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        kw.focusedKw || '', kw.volume || 0, kw.marRank || 0,
        kw.client || '', kw.seoOwner || '', kw.date || '',
        kw.currentRank || 0, kw.targetUrl || '', kw.taskTitle || '',
        kw.source || 'historical',
      ]
    );
    res.json({ ok: true, id: result.insertId, message: 'Keyword added successfully' });
  } catch (e) {
    console.error('POST /api/historical-keywords/add error:', e.message);
    res.status(500).json({ error: 'Failed to add keyword' });
  }
});

// ── PATCH — update single keyword (SPARSE — only fields present in body) ──
//
// CONCURRENCY FIX: The old handler used `kw.volume || 0` fallbacks, meaning a
// PATCH with only { currentRank: 5 } would zero out volume, keyword, etc.
// This wiped data set by concurrent users or direct DB edits.
//
// New approach: build the SET clause dynamically from whatever keys are in the
// request body. Omitting a field leaves its DB value completely untouched.
// Two users can PATCH different fields on the same row simultaneously without
// either one overwriting the other's work.
keywordsRouter.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const kw = req.body;
  if (!kw || typeof kw !== 'object' || Array.isArray(kw))
    return res.status(400).json({ error: 'Missing or invalid keyword data' });

  // camelCase / alias → snake_case DB column
  // Map deduplication: first matching alias wins (e.g. both "focusedKw" and
  // "keyword" map to the same DB column; only the first one seen is used).
  const FIELD_MAP = [
    ['keyword',      'keyword'],
    ['focusedKw',    'keyword'],
    ['volume',       'volume'],
    ['marRank',      'rank_value'],
    ['rank',         'rank_value'],
    ['rank_value',   'rank_value'],
    ['currentRank',  'current_rank'],
    ['current_rank', 'current_rank'],
    ['client',       'client'],
    ['seoOwner',     'seo_owner'],
    ['seo_owner',    'seo_owner'],
    ['date',         'intake_date'],
    ['intakeDate',   'intake_date'],
    ['intake_date',  'intake_date'],
    ['targetUrl',    'target_url'],
    ['target_url',   'target_url'],
    ['taskTitle',    'task_title'],
    ['task_title',   'task_title'],
  ];

  const updates = new Map(); // col → value  (Map deduplicates same DB col from aliases)
  for (const [bodyKey, col] of FIELD_MAP) {
    if (kw[bodyKey] !== undefined && !updates.has(col)) {
      updates.set(col, kw[bodyKey]);
    }
  }

  if (updates.size === 0)
    return res.status(400).json({ error: 'No valid keyword fields in request body' });

  try {
    const setClauses = [...updates.keys()].map(col => `${col} = ?`).join(', ');
    const vals       = [...updates.values(), id];

    const [result] = await pool.query(
      `UPDATE historical_keywords SET ${setClauses}, updated_at = NOW() WHERE id = ?`,
      vals
    );
    if (result.affectedRows === 0)
      return res.status(404).json({ error: `Keyword ${id} not found` });

    res.json({ ok: true, message: 'Keyword updated successfully' });
  } catch (e) {
    console.error('PATCH /api/historical-keywords/:id error:', e.message);
    res.status(500).json({ error: 'Failed to update keyword' });
  }
});

// ── DELETE — remove single keyword ────────────────────────────────────────
keywordsRouter.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await pool.query('DELETE FROM historical_keywords WHERE id = ?', [id]);
    if (result.affectedRows === 0)
      return res.status(404).json({ error: `Keyword ${id} not found` });

    res.json({ ok: true, message: 'Keyword deleted successfully' });
  } catch (e) {
    console.error('DELETE /api/historical-keywords/:id error:', e.message);
    res.status(500).json({ error: 'Failed to delete keyword' });
  }
});

// ── POST /api/keywords/upload-csv — bulk insert from CSV ──────────────────
// Registered here as /upload-csv; mounted at /api/keywords in index.js
keywordsRouter.post(
  '/upload-csv',
  express.text({ type: 'text/csv', limit: '5mb' }),
  async (req, res) => {
    try {
      const raw = typeof req.body === 'string' ? req.body : '';
      if (!raw.trim()) return res.status(400).json({ error: 'Empty CSV body' });

      const lines = raw.split(/\r?\n/).filter(l => l.trim());
      if (lines.length < 2) return res.status(400).json({ error: 'CSV must have header + data rows' });

      const header = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z_]/g, '_'));
      const col = (name) => header.indexOf(name);

      const rows = [];
      for (let i = 1; i < lines.length; i++) {
        const cells = parseCsv(lines[i]);
        if (cells.length < 2) continue;
        const get = (name) => (cells[col(name)] || '').trim();
        const kw = get('focused_kw') || get('keyword') || get('focusedkw');
        if (!kw) continue;
        rows.push({
          keyword:     kw,
          volume:      parseInt(get('volume'), 10) || 0,
          rank_value:  parseInt(get('mar_rank') || get('marrank') || get('rank'), 10) || 0,
          client:      get('client'),
          seo_owner:   get('seo_owner') || get('seoowner'),
          intake_date: get('intake_date') || get('intakedate'),
          current_rank: parseInt(get('current_rank') || get('currentrank'), 10) || 0,
          target_url:  get('target_url') || get('targeturl'),
          task_title:  get('title') || get('task_title') || get('tasktitle'),
          source:      'upload',
        });
      }

      if (rows.length === 0)
        return res.status(400).json({ error: 'No valid keyword rows found in CSV' });

      let conn;
      try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        for (const r of rows) {
          await conn.query(
            `INSERT INTO historical_keywords
               (keyword, volume, rank_value, client, seo_owner, intake_date,
                current_rank, target_url, task_title, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              r.keyword, r.volume, r.rank_value, r.client, r.seo_owner,
              r.intake_date, r.current_rank, r.target_url, r.task_title, r.source,
            ]
          );
        }
        await conn.commit();
        res.json({ ok: true, count: rows.length, message: `${rows.length} keyword(s) imported from CSV` });
      } catch (e) {
        if (conn) await conn.rollback().catch(() => {});
        throw e;
      } finally {
        if (conn) conn.release();
      }
    } catch (e) {
      console.error('POST /api/keywords/upload-csv error:', e.message);
      res.status(500).json({ error: 'Failed to import CSV' });
    }
  }
);
