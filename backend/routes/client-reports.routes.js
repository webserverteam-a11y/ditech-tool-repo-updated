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
 * PUT  /api/client-reports/profiles/:client       — merge-update one profile
 *        (also registers the client in the shared `clients` table if new)
 * GET  /api/client-reports/metrics?client=X       — metrics rows (optional filter)
 * PUT  /api/client-reports/metrics                — bulk merge-update (batch save)
 * PUT  /api/client-reports/metrics/:client/:month — single month merge-update
 * POST /api/client-reports/import                 — parse + merge CSV text
 *
 * Multi-user safety (data-loss fix):
 *   - Every write is a field-level MERGE, never a whole-row replace. Only the
 *     fields the caller actually sends are written; everything else keeps
 *     whatever is in the DB (so two people editing different fields of the
 *     same client/month no longer wipe each other's work).
 *   - Callers may send `base` = the values they were looking at when they
 *     started editing. If the DB value has since been changed by someone
 *     else (DB != base and DB != new value), that field is NOT written and is
 *     reported back in `conflicts`, so the browser can keep the user's edit
 *     and ask them to review instead of silently overwriting.
 *   - CSV import treats blank cells as "leave unchanged" instead of writing 0.
 */

import { Router } from 'express';
import pool from '../config/db.js';

export const clientReportsRouter = Router();

const TIERS = ['Enterprise', 'Growth', 'Starter'];

const METRIC_COLS = {
  organicTraffic: 'organic_traffic',
  organicClicks: 'organic_clicks',
  impressions: 'impressions',
  leads: 'leads',
  notes: 'notes',
};
const PROFILE_COLS = {
  domain: 'domain',
  industry: 'industry',
  tier: 'tier',
  accountManager: 'account_manager',
  targetTraffic: 'target_traffic',
  targetLeads: 'target_leads',
  startDate: 'start_date',
};
const NUMERIC_FIELDS = new Set(['organicTraffic', 'organicClicks', 'impressions', 'leads', 'targetTraffic', 'targetLeads']);

// Quote-aware CSV parser — handles fields like "17,885" (a thousands-separator
// comma inside quotes) that a naive line.split(',') would incorrectly break
// into extra columns and misalign every field after it.
// Rows pasted straight from Excel / Google Sheets arrive tab-separated, so
// the delimiter is sniffed from the header line.
function parseCsvRows(text) {
  const firstLine = text.split('\n', 1)[0];
  const delim = firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field); field = '';
    } else if (c === '\r') {
      // skip
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

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

const EMPTY_PROFILE = { domain: '', industry: '', tier: 'Growth', accountManager: '', targetTraffic: 0, targetLeads: 0, startDate: '' };
const EMPTY_METRIC = { organicTraffic: 0, organicClicks: 0, impressions: 0, leads: 0, notes: '' };

// Accepts numbers or numeric strings that may contain thousands-separator
// commas (e.g. from pasted CSV text) — parseInt alone stops at the first
// comma and silently truncates values like "17,885" down to 17.
function toInt(val) {
  if (typeof val === 'number') return Math.max(0, Math.round(val) || 0);
  const cleaned = String(val ?? '').replace(/[,\s]/g, '').trim();
  return Math.max(0, parseInt(cleaned, 10) || 0);
}

function normalizeField(field, val) {
  if (NUMERIC_FIELDS.has(field)) return toInt(val);
  if (field === 'tier') return TIERS.includes(val) ? val : 'Growth';
  return String(val ?? '');
}

function sameValue(field, a, b) {
  return normalizeField(field, a) === normalizeField(field, b);
}

const MONTH_LOOKUP = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// Normalises the many shapes a month takes after a round trip through Excel /
// Google Sheets ("2026-10", "2026-10-01", "Oct-26", "October 2026",
// "10/1/2026", "1/10/2026", "10/2026") into YYYY-MM. Returns '' if unusable.
function normalizeMonth(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const fmt = (y, m) => {
    y = Number(y); m = Number(m);
    if (y < 100) y += 2000;
    if (!(m >= 1 && m <= 12) || !(y >= 2000 && y <= 2100)) return '';
    return y + '-' + (m < 10 ? '0' + m : '' + m);
  };
  let r;
  if ((r = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?(?:[ T].*)?$/))) return fmt(r[1], r[2]);
  if ((r = s.match(/^(\d{1,2})[-/.](\d{4})$/))) return fmt(r[2], r[1]);
  if ((r = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T].*)?$/))) {
    const a = Number(r[1]), b = Number(r[2]);
    // Excel turns "2026-10" into the 1st of that month, so whichever part
    // isn't 1 is the month. Otherwise fall back to US (M/D/Y) unless the
    // first part can't be a month.
    let m;
    if (a === 1 && b !== 1) m = b;
    else if (b === 1 && a !== 1) m = a;
    else if (a > 12) m = b;
    else m = a;
    return fmt(r[3], m);
  }
  if ((r = s.match(/^([A-Za-z]{3,9})[\s\-'’,.]*(\d{2}|\d{4})$/))) {
    const m = MONTH_LOOKUP[r[1].toLowerCase()];
    return m ? fmt(r[2], m) : '';
  }
  if ((r = s.match(/^(\d{2}|\d{4})[\s\-'’,.]*([A-Za-z]{3,9})$/))) {
    const m = MONTH_LOOKUP[r[2].toLowerCase()];
    return m ? fmt(r[1], m) : '';
  }
  return '';
}

// Runs fn(conn) inside a transaction, retrying on deadlocks (two users
// saving the same client/month at the same instant).
async function withTransaction(fn, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    let conn;
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (e) {
      if (conn) await conn.rollback().catch(() => {});
      if (attempt < retries && (e.code === 'ER_LOCK_DEADLOCK' || e.code === 'ER_LOCK_WAIT_TIMEOUT')) continue;
      throw e;
    } finally {
      if (conn) conn.release();
    }
  }
}

// Additive-only registration in the shared `clients` roster — same upsert
// clients.routes.js POST / and PUT /profiles/:client already use. Never
// deletes or modifies an existing row, just no-ops via ON DUPLICATE KEY
// UPDATE name = name when the client is already registered.
async function registerClient(conn, name) {
  const [existing] = await conn.query('SELECT 1 FROM clients WHERE name = ? LIMIT 1', [name]);
  if (existing.length) return;
  const [maxRow] = await conn.query('SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM clients');
  const nextOrder = (maxRow[0].maxOrder ?? -1) + 1;
  await conn.query(
    'INSERT INTO clients (name, sort_order) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = name',
    [name, nextOrder]
  );
}

// Collects the fields the caller actually wants to change.
//   blankIsNoChange=true (CSV import): empty cells are skipped.
//   blankIsNoChange=false (UI): a field present in the payload is written,
//   even if it is an empty string (e.g. clearing notes on purpose).
function pickChanges(input, cols, blankIsNoChange) {
  const changes = {};
  for (const field of Object.keys(cols)) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    const v = input[field];
    if (v === undefined || v === null) continue;
    if (blankIsNoChange && String(v).trim() === '') continue;
    changes[field] = v;
  }
  return changes;
}

// Applies `changes` on top of `current`, skipping any field someone else
// changed since the caller's `base` snapshot. Returns { merged, applied, conflicts }.
function mergeFields(current, changes, base) {
  const merged = { ...current };
  const applied = [];
  const conflicts = [];
  for (const [field, raw] of Object.entries(changes)) {
    const next = normalizeField(field, raw);
    if (base && Object.prototype.hasOwnProperty.call(base, field) &&
        !sameValue(field, current[field], base[field]) &&
        !sameValue(field, current[field], next)) {
      conflicts.push({ field, yours: next, theirs: current[field], base: normalizeField(field, base[field]) });
      continue;
    }
    if (!sameValue(field, current[field], next)) applied.push(field);
    merged[field] = next;
  }
  return { merged, applied, conflicts };
}

async function mergeMetric(conn, m, { blankIsNoChange = false } = {}) {
  const client = String(m.client || '').trim();
  const month = normalizeMonth(m.month);
  if (!client || !month) return { status: 'invalid', client, month, applied: [], conflicts: [] };

  const changes = pickChanges(m, METRIC_COLS, blankIsNoChange);
  if (Object.keys(changes).length === 0) return { status: 'unchanged', client, month, applied: [], conflicts: [] };

  const [rows] = await conn.query(
    'SELECT * FROM client_reports_metrics WHERE client = ? AND month = ? FOR UPDATE', [client, month]
  );
  const exists = rows.length > 0;
  const current = exists ? mapMetricRow(rows[0]) : { ...EMPTY_METRIC };
  const { merged, applied, conflicts } = mergeFields(current, changes, m.base || null);

  if (applied.length === 0 && exists) {
    return { status: conflicts.length ? 'conflict' : 'unchanged', client, month, applied, conflicts };
  }
  if (applied.length === 0 && !exists && conflicts.length) {
    return { status: 'conflict', client, month, applied, conflicts };
  }

  const ctr = merged.impressions > 0 ? Math.round((merged.organicClicks / merged.impressions) * 10000) / 100 : 0;
  await conn.query(
    `INSERT INTO client_reports_metrics
       (client, month, organic_traffic, organic_clicks, impressions, ctr, leads, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       organic_traffic = VALUES(organic_traffic),
       organic_clicks  = VALUES(organic_clicks),
       impressions     = VALUES(impressions),
       ctr             = VALUES(ctr),
       leads           = VALUES(leads),
       notes           = VALUES(notes)`,
    [client, month, merged.organicTraffic, merged.organicClicks, merged.impressions, ctr, merged.leads, merged.notes]
  );
  return { status: 'saved', client, month, applied, conflicts };
}

async function mergeProfile(conn, client, input, { blankIsNoChange = false } = {}) {
  const changes = pickChanges(input, PROFILE_COLS, blankIsNoChange);
  if (changes.tier !== undefined && !TIERS.includes(changes.tier)) {
    if (blankIsNoChange) delete changes.tier; else changes.tier = 'Growth';
  }

  await registerClient(conn, client);

  const [rows] = await conn.query(
    'SELECT * FROM client_reports_profiles WHERE client = ? FOR UPDATE', [client]
  );
  const exists = rows.length > 0;
  const current = exists ? mapProfileRow(rows[0]) : { ...EMPTY_PROFILE };
  const { merged, applied, conflicts } = mergeFields(current, changes, input.base || null);
  if (!exists && !merged.startDate) merged.startDate = new Date().toISOString().split('T')[0];

  if (exists && applied.length === 0) return { status: conflicts.length ? 'conflict' : 'unchanged', applied, conflicts };

  await conn.query(
    `INSERT INTO client_reports_profiles
       (client, domain, industry, tier, account_manager, target_traffic, target_leads, start_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       domain = VALUES(domain), industry = VALUES(industry), tier = VALUES(tier),
       account_manager = VALUES(account_manager),
       target_traffic = VALUES(target_traffic), target_leads = VALUES(target_leads),
       start_date = VALUES(start_date)`,
    [client, merged.domain, merged.industry, merged.tier, merged.accountManager,
      merged.targetTraffic, merged.targetLeads, merged.startDate]
  );
  return { status: 'saved', applied, conflicts };
}

function conflictMessage(conflicts) {
  return conflicts.length
    ? ` ${conflicts.length} field(s) were changed by someone else since you loaded them and were NOT overwritten — review and save again.`
    : '';
}

// ── GET /profiles — shared client roster + this panel's extra fields ───────
clientReportsRouter.get('/profiles', async (_req, res) => {
  try {
    const [clientRows] = await pool.query('SELECT name FROM clients ORDER BY sort_order, name');
    const [profileRows] = await pool.query('SELECT * FROM client_reports_profiles');
    const profileMap = {};
    profileRows.forEach(r => { profileMap[r.client] = mapProfileRow(r); });

    const merged = clientRows.map(c => profileMap[c.name] || { client: c.name, ...EMPTY_PROFILE });

    // Include profiles for clients that somehow have a profile but were
    // removed from the shared roster (keeps their historical data visible).
    const knownNames = new Set(clientRows.map(c => c.name));
    profileRows.forEach(r => {
      if (!knownNames.has(r.client)) { merged.push(mapProfileRow(r)); knownNames.add(r.client); }
    });

    // Same for clients that only have metrics rows (e.g. removed from the
    // shared roster by another panel) — their data must not become invisible.
    const [metricClients] = await pool.query('SELECT DISTINCT client FROM client_reports_metrics');
    metricClients.forEach(r => {
      if (!knownNames.has(r.client)) { merged.push({ client: r.client, ...EMPTY_PROFILE }); knownNames.add(r.client); }
    });

    res.json(merged);
  } catch (e) {
    console.error('GET /api/client-reports/profiles error:', e.message);
    res.status(500).json({ error: 'Failed to load client profiles' });
  }
});

// ── PUT /profiles/:client — merge-update one profile ────────────────────────
// Body: any subset of profile fields, plus optional `base` (values the user
// saw when they opened the form) for conflict detection.
clientReportsRouter.put('/profiles/:client', async (req, res) => {
  const client = decodeURIComponent(req.params.client || '').trim();
  if (!client) return res.status(400).json({ error: 'Client name is required' });

  try {
    const result = await withTransaction(conn => mergeProfile(conn, client, req.body || {}));
    const msg = result.status === 'unchanged' && !result.conflicts.length
      ? `No changes to save for "${client}"`
      : `Client "${client}" profile saved` + conflictMessage(result.conflicts);
    res.json({ ok: true, message: msg, applied: result.applied, conflicts: result.conflicts });
  } catch (e) {
    console.error('PUT /api/client-reports/profiles/:client error:', e.message);
    res.status(500).json({ error: 'Failed to save client profile' });
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

// ── PUT /metrics — bulk merge-update (batch save from the entry grid) ──────
// Body: [{ client, month, <only the changed fields>, base: {<field>: <value the user saw>} }]
clientReportsRouter.put('/metrics', async (req, res) => {
  const rows = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.json({ ok: true, count: 0, conflicts: [], message: 'No metric rows provided, nothing changed.' });
  }

  try {
    const results = await withTransaction(async conn => {
      const out = [];
      for (const m of rows) out.push(await mergeMetric(conn, m));
      return out;
    });
    const saved = results.filter(r => r.status === 'saved').length;
    const conflicts = [];
    results.forEach(r => r.conflicts.forEach(c => conflicts.push({ client: r.client, month: r.month, ...c })));
    res.json({
      ok: true,
      count: saved,
      conflicts,
      message: `${saved} client metric row(s) saved.` + conflictMessage(conflicts),
    });
  } catch (e) {
    console.error('PUT /api/client-reports/metrics error:', e.message);
    res.status(500).json({ error: 'Failed to save metrics' });
  }
});

// ── PUT /metrics/:client/:month — single month merge-update ────────────────
clientReportsRouter.put('/metrics/:client/:month', async (req, res) => {
  const client = decodeURIComponent(req.params.client || '').trim();
  const month = req.params.month;
  const body = req.body || {};

  try {
    const result = await withTransaction(conn => mergeMetric(conn, { ...body, client, month }));
    if (result.status === 'invalid') return res.status(400).json({ error: 'client and a valid YYYY-MM month are required' });
    const conflicts = result.conflicts.map(c => ({ client, month: result.month, ...c }));
    const msg = result.status === 'unchanged'
      ? `No changes to save for ${month}`
      : `Saved ${month} metrics for "${client}".` + conflictMessage(conflicts);
    res.json({ ok: true, message: msg, applied: result.applied, conflicts });
  } catch (e) {
    console.error('PUT /api/client-reports/metrics/:client/:month error:', e.message);
    res.status(500).json({ error: 'Failed to save metric' });
  }
});

// ── POST /import — parse pasted CSV text, merge into DB ─────────────────────
// Header row required. Recognised columns (case-insensitive, any order):
//   Client*, Month, Organic Traffic, Organic Clicks, Impressions,
//   Leads Received, Notes, Domain, Industry, Tier, Account Manager,
//   Target Traffic, Target Leads
// Blank cells leave the existing DB value untouched. Columns the panel's
// own export adds (MoM %, CTR) are ignored — CTR is always recomputed.
// Body: { csv, defaultMonth? } — defaultMonth is used for rows with no Month.
const HEADER_ALIASES = {
  client: ['client', 'client name', 'name'],
  month: ['month', 'reporting month', 'period'],
  organicTraffic: ['organic traffic', 'traffic', 'sessions', 'organic sessions'],
  organicClicks: ['organic clicks', 'clicks'],
  impressions: ['impressions'],
  leads: ['leads received', 'leads'],
  notes: ['notes', 'note', 'work done'],
  domain: ['domain', 'website'],
  industry: ['industry'],
  tier: ['tier', 'client tier'],
  accountManager: ['account manager', 'manager', 'mgr'],
  targetTraffic: ['target traffic', 'monthly traffic target', 'traffic target'],
  targetLeads: ['target leads', 'monthly lead goal', 'lead target', 'leads target'],
};

function normHeader(h) {
  return String(h || '').replace(/^﻿/, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

clientReportsRouter.post('/import', async (req, res) => {
  const { csv, defaultMonth } = req.body || {};
  if (!csv || typeof csv !== 'string' || !csv.trim()) {
    return res.status(400).json({ error: 'csv text is required' });
  }

  const rows = parseCsvRows(csv.replace(/^﻿/, ''));
  if (rows.length < 2) return res.status(400).json({ error: 'CSV must include a header row plus at least one data row' });

  const header = rows[0].map(normHeader);
  const col = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    col[field] = header.findIndex(h => aliases.includes(h));
  }

  const fallbackMonth = normalizeMonth(defaultMonth);
  if (col.client === -1) {
    return res.status(400).json({ error: 'CSV header must include a Client column' });
  }
  if (col.month === -1 && !fallbackMonth) {
    return res.status(400).json({ error: 'CSV header must include a Month column (or pick a reporting month)' });
  }

  const cell = (parts, field) => (col[field] === -1 ? undefined : (parts[col[field]] ?? '').trim());
  const metricFields = Object.keys(METRIC_COLS);
  const profileFields = Object.keys(PROFILE_COLS).filter(f => f !== 'startDate');

  try {
    const summary = await withTransaction(async conn => {
      let metricsSaved = 0, profilesSaved = 0, unchanged = 0;
      const skipped = [];

      for (let i = 1; i < rows.length; i++) {
        const parts = rows[i];
        const line = i + 1;
        const client = cell(parts, 'client');
        if (!client) { skipped.push({ line, reason: 'missing client name' }); continue; }

        const profileInput = {};
        profileFields.forEach(f => { const v = cell(parts, f); if (v !== undefined) profileInput[f] = v; });
        const metricInput = { client };
        metricFields.forEach(f => { const v = cell(parts, f); if (v !== undefined) metricInput[f] = v; });

        const hasMetricData = metricFields.some(f => metricInput[f] !== undefined && metricInput[f] !== '');
        const hasProfileData = profileFields.some(f => profileInput[f] !== undefined && profileInput[f] !== '');

        let rowMonth = '';
        if (hasMetricData) {
          const rawMonth = cell(parts, 'month');
          rowMonth = rawMonth ? normalizeMonth(rawMonth) : fallbackMonth;
          if (!rowMonth) { skipped.push({ line, client, reason: `unrecognised month "${rawMonth}"` }); continue; }
        }

        // Always make sure the client exists in the roster + has a profile row.
        const p = await mergeProfile(conn, client, profileInput, { blankIsNoChange: true });
        if (hasProfileData && p.status === 'saved') profilesSaved++;

        if (hasMetricData) {
          const r = await mergeMetric(conn, { ...metricInput, month: rowMonth }, { blankIsNoChange: true });
          if (r.status === 'saved') metricsSaved++;
          else unchanged++;
        } else if (!hasProfileData) {
          skipped.push({ line, client, reason: 'no values to import (all cells blank)' });
        }
      }
      return { metricsSaved, profilesSaved, unchanged, skipped };
    });

    let message = `${summary.metricsSaved} metric row(s) and ${summary.profilesSaved} profile(s) updated`;
    if (summary.unchanged) message += `, ${summary.unchanged} row(s) already up to date`;
    if (summary.skipped.length) message += `, ${summary.skipped.length} row(s) skipped`;
    res.json({ ok: true, count: summary.metricsSaved, ...summary, message });
  } catch (e) {
    console.error('POST /api/client-reports/import error:', e.message);
    res.status(500).json({ error: 'Failed to import CSV' });
  }
});
