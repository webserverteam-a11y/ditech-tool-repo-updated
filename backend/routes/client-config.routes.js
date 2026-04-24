/**
 * client-config.routes.js — Per-client monthly configuration.
 *
 * GET /api/client-config   — full config object
 * PUT /api/client-config   — upsert (never wipes existing rows)
 */

import { Router } from 'express';
import pool from '../config/db.js';

export const clientConfigRouter = Router();

clientConfigRouter.get('/', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT client, month, budget_hrs, strategy_url, report_url, notes FROM client_config ORDER BY client, month'
    );
    const config = {};
    for (const r of rows) {
      if (!config[r.client]) config[r.client] = { months: {} };
      config[r.client].months[r.month] = {
        budgetHrs:   Number(r.budget_hrs) || 0,
        strategyUrl: r.strategy_url || '',
        reportUrl:   r.report_url || '',
      };
      if (r.notes) config[r.client].notes = r.notes;
    }
    res.json(config);
  } catch (e) {
    console.error('GET /api/client-config error:', e.message);
    res.status(500).json({ error: 'Failed to load client config' });
  }
});

clientConfigRouter.put('/', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object')
    return res.status(400).json({ error: 'Expected object' });
  if (Object.keys(body).length === 0)
    return res.json({ ok: true, message: 'No client config provided, nothing changed.' });

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    for (const [client, data] of Object.entries(body)) {
      const months = data.months || {};
      for (const [month, cfg] of Object.entries(months)) {
        await conn.query(
          `INSERT INTO client_config (client, month, budget_hrs, strategy_url, report_url, notes)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             budget_hrs   = VALUES(budget_hrs),
             strategy_url = IF(VALUES(strategy_url) = '', strategy_url, VALUES(strategy_url)),
             report_url   = IF(VALUES(report_url)   = '', report_url,   VALUES(report_url)),
             notes        = VALUES(notes)`,
          [client, month, cfg.budgetHrs || 0, cfg.strategyUrl || '', cfg.reportUrl || '', data.notes || '']
        );
      }
    }

    await conn.commit();
    res.json({ ok: true, message: 'Client config saved successfully' });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('PUT /api/client-config error:', e.message);
    res.status(500).json({ error: 'Failed to save client config' });
  } finally {
    if (conn) conn.release();
  }
});
