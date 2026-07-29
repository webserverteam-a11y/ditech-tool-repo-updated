/**
 * client-reports.routes.js — Client Reports panel (SEO performance tracker).
 *
 * Reuses the shared `clients` table (id/name/sort_order) as the client-name
 * roster. Only adds the extra profile fields + monthly metrics history this
 * panel needs, in its own tables (client_reports_profiles,
 * client_reports_metrics), keyed by client name as a plain string — same
 * convention as `client_config.client` / `tasks.client` (no FK).
 *
 * GET  /api/client-reports/profiles              — all clients + profile fields
 * PUT  /api/client-reports/profiles/:client       — upsert one profile
 *        (also registers the client in the shared `clients` table if new)
 * GET  /api/client-reports/metrics?client=X       — metrics rows (optional filter)
 * PUT  /api/client-reports/metrics                — bulk upsert (batch save)
 * PUT  /api/client-reports/metrics/:client/:month — single month upsert
 * POST /api/client-reports/import                 — parse + bulk upsert CSV text
 */

import { Router } from 'express';
import pool from '../config/db.js';

export const clientReportsRouter = Router();

const TIERS = ['Enterprise', 'Growth', 'Starter'];

function mapProfileRow(r) {
  return {
    client: r.client,
    domain: r.domain || '',
    industry: r.industry || '',
    tier: r.tier || 'Growth',
    accountManager: r.account_manager || '',
    targetTraffic: Number(r.target_traffic) || 0,
    targetLeads: Number(r.target_leads) || 0,
    startDate: r.start_date || '',
  };
}

function mapMetricRow(r) {
  return {
    client: r.client,
    month: r.month,
    organicTraffic: Number(r.organic_traffic) || 0,
    organicClicks: Number(r.organic_clicks) || 0,
    impressions: Number(r.impressions) || 0,
    ctr: Number(r.ctr) || 0,
    leads: Number(r.leads) || 0,
    notes: r.notes || '',
  };
}

async function upsertMetric(conn, m) {
  const client = (m.client || '').trim();
  const month = (m.month || '').trim();
  if (!client || !/^\d{4}-\d{2}$/.test(month)) return false;

  const clicks = Math.max(0, parseInt(m.organicClicks, 10) || 0);
  const impressions = Math.max(0, parseInt(m.impressions, 10) || 0);
  const ctr = impressions > 0 ? Math.round((clicks / impressions) * 10000) / 100 : 0;

  await conn.query(
    `INSERT INTO client_reports_metrics
       (client, month, organic_traffic, organic_clicks, impressions, ctr, leads, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       organic_traffic = VALUES(organic_traffic),
       organic_clicks  = VALUES(organic_clicks),
       impressions      = VALUES(impressions),
       ctr              = VALUES(ctr),
       leads            = VALUES(leads),
       notes            = VALUES(notes)`,
    [
      client, month,
      Math.max(0, parseInt(m.organicTraffic, 10) || 0),
      clicks, impressions, ctr,
      Math.max(0, parseInt(m.leads, 10) || 0),
      m.notes || '',
    ]
  );
  return true;
}

// ── GET /profiles — shared client roster + this panel's extra fields ───────
clientReportsRouter.get('/profiles', async (_req, res) => {
  try {
    const [clientRows] = await pool.query('SELECT name FROM clients ORDER BY sort_order, name');
    const [profileRows] = await pool.query('SELECT * FROM client_reports_profiles');
    const profileMap = {};
    profileRows.forEach(r => { profileMap[r.client] = mapProfileRow(r); });

    const merged = clientRows.map(c => profileMap[c.name] || {
      client: c.name, domain: '', industry: '', tier: 'Growth',
      accountManager: '', targetTraffic: 0, targetLeads: 0, startDate: '',
    });

    // Include profiles for clients that somehow have a profile but were
    // removed from the shared roster (keeps their historical data visible).
    const knownNames = new Set(clientRows.map(c => c.name));
    profileRows.forEach(r => {
      if (!knownNames.has(r.client)) merged.push(mapProfileRow(r));
    });

    res.json(merged);
  } catch (e) {
    console.error('GET /api/client-reports/profiles error:', e.message);
    res.status(500).json({ error: 'Failed to load client profiles' });
  }
});

// ── PUT /profiles/:client — upsert one profile ──────────────────────────────
clientReportsRouter.put('/profiles/:client', async (req, res) => {
  const client = decodeURIComponent(req.params.client || '').trim();
  if (!client) return res.status(400).json({ error: 'Client name is required' });

  const body = req.body || {};
  const tier = TIERS.includes(body.tier) ? body.tier : 'Growth';

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Register in the shared roster if not already present — additive only,
    // reuses the exact upsert clients.routes.js already does for POST /api/clients.
    const [maxRow] = await conn.query('SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM clients');
    const nextOrder = (maxRow[0].maxOrder ?? -1) + 1;
    await conn.query(
      'INSERT INTO clients (name, sort_order) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = name',
      [client, nextOrder]
    );

    await conn.query(
      `INSERT INTO client_reports_profiles
         (client, domain, industry, tier, account_manager, target_traffic, target_leads, start_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         domain = VALUES(domain), industry = VALUES(industry), tier = VALUES(tier),
         account_manager = VALUES(account_manager),
         target_traffic = VALUES(target_traffic), target_leads = VALUES(target_leads),
         start_date = VALUES(start_date)`,
      [
        client, body.domain || '', body.industry || '', tier,
        body.accountManager || '',
        Math.max(0, parseInt(body.targetTraffic, 10) || 0),
        Math.max(0, parseInt(body.targetLeads, 10) || 0),
        body.startDate || '',
      ]
    );

    await conn.commit();
    res.json({ ok: true, message: `Client "${client}" profile saved successfully` });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('PUT /api/client-reports/profiles/:client error:', e.message);
    res.status(500).json({ error: 'Failed to save client profile' });
  } finally {
    if (conn) conn.release();
  }
});

// ── GET /metrics?client=X — metrics rows ────────────────────────────────────
clientReportsRouter.get('/metrics', async (req, res) => {
  const { client } = req.query;
  try {
    const [rows] = client
      ? await pool.query('SELECT * FROM client_reports_metrics WHERE client = ? ORDER BY month', [client])
      : await pool.query('SELECT * FROM client_reports_metrics ORDER BY client, month');
    res.json(rows.map(mapMetricRow));
  } catch (e) {
    console.error('GET /api/client-reports/metrics error:', e.message);
    res.status(500).json({ error: 'Failed to load metrics' });
  }
});

// ── PUT /metrics — bulk upsert (batch save from the entry grid) ────────────
clientReportsRouter.put('/metrics', async (req, res) => {
  const rows = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.json({ ok: true, count: 0, message: 'No metric rows provided, nothing changed.' });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    let saved = 0;
    for (const m of rows) {
      if (await upsertMetric(conn, m)) saved++;
    }
    await conn.commit();
    res.json({ ok: true, count: saved, message: `${saved} client metric row(s) saved` });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('PUT /api/client-reports/metrics error:', e.message);
    res.status(500).json({ error: 'Failed to save metrics' });
  } finally {
    if (conn) conn.release();
  }
});

// ── PUT /metrics/:client/:month — single month upsert ──────────────────────
clientReportsRouter.put('/metrics/:client/:month', async (req, res) => {
  const client = decodeURIComponent(req.params.client || '').trim();
  const month = req.params.month;
  const body = req.body || {};

  try {
    const ok = await upsertMetric(pool, { ...body, client, month });
    if (!ok) return res.status(400).json({ error: 'client and a valid YYYY-MM month are required' });
    res.json({ ok: true, message: `Saved ${month} metrics for "${client}"` });
  } catch (e) {
    console.error('PUT /api/client-reports/metrics/:client/:month error:', e.message);
    res.status(500).json({ error: 'Failed to save metric' });
  }
});

// ── POST /import — parse pasted CSV text, bulk upsert ───────────────────────
// Expected columns (header row required): Client, Month, Organic Traffic,
// Organic Clicks, Impressions, Leads Received[, Notes]
clientReportsRouter.post('/import', async (req, res) => {
  const { csv } = req.body || {};
  if (!csv || typeof csv !== 'string' || !csv.trim()) {
    return res.status(400).json({ error: 'csv text is required' });
  }

  const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return res.status(400).json({ error: 'CSV must include a header row plus at least one data row' });

  const parseLine = (line) => line.split(',').map(p => p.replace(/^"|"$/g, '').trim());
  const header = parseLine(lines[0]).map(h => h.toLowerCase());
  const idx = (name) => header.indexOf(name);

  const iClient = idx('client');
  const iMonth = idx('month');
  const iTraffic = idx('organic traffic');
  const iClicks = idx('organic clicks');
  const iImpressions = idx('impressions');
  const iLeads = idx('leads received');
  const iNotes = idx('notes');

  if (iClient === -1 || iMonth === -1) {
    return res.status(400).json({ error: 'CSV header must include Client and Month columns' });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    let saved = 0;
    for (let i = 1; i < lines.length; i++) {
      const parts = parseLine(lines[i]);
      const ok = await upsertMetric(conn, {
        client: parts[iClient],
        month: parts[iMonth],
        organicTraffic: iTraffic !== -1 ? parts[iTraffic] : 0,
        organicClicks: iClicks !== -1 ? parts[iClicks] : 0,
        impressions: iImpressions !== -1 ? parts[iImpressions] : 0,
        leads: iLeads !== -1 ? parts[iLeads] : 0,
        notes: iNotes !== -1 ? parts[iNotes] : '',
      });
      if (ok) saved++;
    }
    await conn.commit();
    res.json({ ok: true, count: saved, message: `${saved} row(s) imported successfully` });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('POST /api/client-reports/import error:', e.message);
    res.status(500).json({ error: 'Failed to import CSV' });
  } finally {
    if (conn) conn.release();
  }
});
