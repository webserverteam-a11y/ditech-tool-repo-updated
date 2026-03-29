import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import pool from './config/db.js';
import dbMiddleware from './db-middleware.js';
import { encrypt, decrypt, isEncrypted } from './config/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 10000;
const HOST = process.env.HOST || '0.0.0.0';

// ── DB init ───────────────────────────────────────────
async function initDb() {
  const ddl = [
    ['tasks', `CREATE TABLE IF NOT EXISTS tasks (
      id VARCHAR(255) PRIMARY KEY, data JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`],
    ['app_config', `CREATE TABLE IF NOT EXISTS app_config (
      \`key\` VARCHAR(255) PRIMARY KEY, value JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`],
    ['users', `CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(255) PRIMARY KEY, name VARCHAR(255) NOT NULL,
      password VARCHAR(255) NOT NULL, role VARCHAR(50) NOT NULL DEFAULT 'seo',
      ownerName VARCHAR(255) DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`],
    ['audit_logs', `CREATE TABLE IF NOT EXISTS audit_logs (
      id VARCHAR(100) PRIMARY KEY, month VARCHAR(7) NOT NULL,
      timestamp VARCHAR(50), user_name VARCHAR(255), user_role VARCHAR(100),
      action VARCHAR(255), task_id VARCHAR(255), task_title VARCHAR(500),
      client VARCHAR(255), source VARCHAR(255), field VARCHAR(255),
      old_value TEXT, new_value TEXT, note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_month (month), INDEX idx_task_id (task_id))`],
    ['sessions', `CREATE TABLE IF NOT EXISTS sessions (
      token VARCHAR(64) PRIMARY KEY, expires_at BIGINT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`],
    ['client_config', `CREATE TABLE IF NOT EXISTS client_config (
      client VARCHAR(255) NOT NULL, month VARCHAR(7) NOT NULL,
      budget_hrs DECIMAL(10,2) DEFAULT 0, strategy_url TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (client, month))`],
    ['historical_keywords', `CREATE TABLE IF NOT EXISTS historical_keywords (
      id INT AUTO_INCREMENT PRIMARY KEY, task_id VARCHAR(255),
      keyword VARCHAR(500), month VARCHAR(7), rank_value INT DEFAULT 0,
      volume INT DEFAULT 0, client VARCHAR(255),
      recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_kw_month (month), INDEX idx_kw_task (task_id))`],
    ['leave_records', `CREATE TABLE IF NOT EXISTS leave_records (
      id VARCHAR(255) PRIMARY KEY, user_name VARCHAR(255) NOT NULL,
      user_role VARCHAR(100), leave_date DATE NOT NULL,
      leave_type VARCHAR(100) DEFAULT 'full', reason TEXT DEFAULT '',
      status VARCHAR(50) DEFAULT 'approved',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_leave_user (user_name), INDEX idx_leave_date (leave_date))`],
    ['workhub_remarks', `CREATE TABLE IF NOT EXISTS workhub_remarks (
      id VARCHAR(255) PRIMARY KEY, task_id VARCHAR(255),
      user_name VARCHAR(255), user_role VARCHAR(100), remark TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_remark_task (task_id), INDEX idx_remark_user (user_name))`],
  ];
  let ok = 0, fail = 0;
  for (const [name, sql] of ddl) {
    try {
      await pool.query(sql);
      ok++;
    } catch (e) {
      fail++;
      console.error(`  CREATE ${name} FAILED:`, e.code, e.message);
    }
  }
  console.log(`initDb: ${ok} tables OK, ${fail} failed`);
  if (fail > 0) throw new Error(`${fail} tables failed to create`);
}

// ── Middleware ─────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});

// DB admin panel at /db-access
app.use(dbMiddleware);

// ── Health check ──────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  const result = {
    server: true, db: false, tables: {}, error: null,
    env: {
      DB_HOST: process.env.DB_HOST ? '***set***' : 'MISSING',
      DB_USER: process.env.DB_USER ? '***set***' : 'MISSING',
      DB_PASS: process.env.DB_PASS ? '***set***' : 'MISSING',
      DB_NAME: process.env.DB_NAME || 'MISSING',
      DB_PORT: process.env.DB_PORT || '3306 (default)',
    },
    pool: { total: 0, free: 0, queued: 0 },
  };
  try {
    const p = pool.pool;
    result.pool.total = p._allConnections?.length ?? -1;
    result.pool.free = p._freeConnections?.length ?? -1;
    result.pool.queued = p._connectionQueue?.length ?? -1;
  } catch (_) {}
  try {
    const [testRows] = await pool.query('SELECT 1 as ok');
    result.db = testRows && testRows[0] && testRows[0].ok === 1;
    const [tables] = await pool.query('SHOW TABLES');
    const tableNames = tables.map(t => Object.values(t)[0]);
    const expected = ['tasks','app_config','users','audit_logs','sessions','client_config','historical_keywords','leave_records','workhub_remarks'];
    for (const name of expected) {
      result.tables[name] = tableNames.includes(name);
    }
  } catch (e) {
    result.error = `${e.code || 'UNKNOWN'}: ${e.message}`;
  }
  res.json(result);
});

// ── Force DB init (creates missing tables) ────────────
app.get('/api/db-init', async (_req, res) => {
  const results = {};
  const tableSQL = [
    ['tasks', `CREATE TABLE IF NOT EXISTS tasks (
      id VARCHAR(255) PRIMARY KEY, data JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`],
    ['app_config', `CREATE TABLE IF NOT EXISTS app_config (
      \`key\` VARCHAR(255) PRIMARY KEY, value JSON NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`],
    ['users', `CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(255) PRIMARY KEY, name VARCHAR(255) NOT NULL,
      password VARCHAR(255) NOT NULL, role VARCHAR(50) NOT NULL DEFAULT 'seo',
      ownerName VARCHAR(255) DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`],
    ['audit_logs', `CREATE TABLE IF NOT EXISTS audit_logs (
      id VARCHAR(100) PRIMARY KEY, month VARCHAR(7) NOT NULL,
      timestamp VARCHAR(50), user_name VARCHAR(255), user_role VARCHAR(100),
      action VARCHAR(255), task_id VARCHAR(255), task_title VARCHAR(500),
      client VARCHAR(255), source VARCHAR(255), field VARCHAR(255),
      old_value TEXT, new_value TEXT, note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_month (month), INDEX idx_task_id (task_id))`],
    ['sessions', `CREATE TABLE IF NOT EXISTS sessions (
      token VARCHAR(64) PRIMARY KEY, expires_at BIGINT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`],
    ['client_config', `CREATE TABLE IF NOT EXISTS client_config (
      client VARCHAR(255) NOT NULL, month VARCHAR(7) NOT NULL,
      budget_hrs DECIMAL(10,2) DEFAULT 0, strategy_url TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (client, month))`],
    ['historical_keywords', `CREATE TABLE IF NOT EXISTS historical_keywords (
      id INT AUTO_INCREMENT PRIMARY KEY, task_id VARCHAR(255),
      keyword VARCHAR(500), month VARCHAR(7), rank_value INT DEFAULT 0,
      volume INT DEFAULT 0, client VARCHAR(255),
      recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_kw_month (month), INDEX idx_kw_task (task_id))`],
    ['leave_records', `CREATE TABLE IF NOT EXISTS leave_records (
      id VARCHAR(255) PRIMARY KEY, user_name VARCHAR(255) NOT NULL,
      user_role VARCHAR(100), leave_date DATE NOT NULL,
      leave_type VARCHAR(100) DEFAULT 'full', reason TEXT DEFAULT '',
      status VARCHAR(50) DEFAULT 'approved',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_leave_user (user_name), INDEX idx_leave_date (leave_date))`],
    ['workhub_remarks', `CREATE TABLE IF NOT EXISTS workhub_remarks (
      id VARCHAR(255) PRIMARY KEY, task_id VARCHAR(255),
      user_name VARCHAR(255), user_role VARCHAR(100), remark TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_remark_task (task_id), INDEX idx_remark_user (user_name))`],
  ];
  for (const [name, sql] of tableSQL) {
    try {
      await pool.query(sql);
      results[name] = 'OK';
    } catch (e) {
      results[name] = `FAILED: ${e.code || ''} ${e.message}`;
    }
  }
  res.json({ ok: true, tables: results });
});

// ── API: Tasks ────────────────────────────────────────
app.get('/api/tasks', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT data FROM tasks ORDER BY id');
    res.json(rows.map(r => typeof r.data === 'string' ? JSON.parse(r.data) : r.data));
  } catch (e) {
    console.error('GET /api/tasks error:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load tasks' });
  }
});

app.put('/api/tasks', async (req, res) => {
  const tasks = req.body;
  if (!Array.isArray(tasks)) return res.status(400).json({ error: 'Expected array' });
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.query('DELETE FROM tasks');
    for (const t of tasks) {
      await conn.query('INSERT INTO tasks (id, data) VALUES (?, ?)', [t.id, JSON.stringify(t)]);
    }
    await conn.commit();
    res.json({ ok: true, count: tasks.length, message: `${tasks.length} task(s) saved successfully` });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('PUT /api/tasks error:', e.message);
    res.status(500).json({ error: 'Failed to save tasks' });
  } finally {
    if (conn) conn.release();
  }
});

// ── API: Config (admin_options, nav_access from app_config; users from users table) ────
app.get('/api/config/:key', async (req, res) => {
  try {
    const key = req.params.key;

    // Users are stored in the dedicated users table
    if (key === 'users') {
      const [rows] = await pool.query('SELECT id, name, password, role, ownerName FROM users ORDER BY created_at');
      // Decrypt passwords before sending to frontend
      const decryptedRows = rows.map(u => ({ ...u, password: decrypt(u.password) }));
      console.log(`GET /api/config/users: ${decryptedRows.length} users from users table`);
      return res.json(decryptedRows);
    }

    // admin_options: owner lists are derived live from the users table
    if (key === 'admin_options') {
      const [cfgRows] = await pool.query('SELECT value FROM app_config WHERE `key` = ?', ['admin_options']);
      let config = {};
      if (cfgRows.length > 0) {
        const val = cfgRows[0].value;
        config = typeof val === 'string' ? JSON.parse(val) : val;
      }
      // Query users table grouped by role — excludes admin accounts
      const [userRows] = await pool.query(
        'SELECT name, role FROM users WHERE role NOT IN (?, ?) ORDER BY name',
        ['admin', '']
      );
      const ROLE_TO_OWNER_KEY = {
        seo: 'seoOwners',
        content: 'contentOwners',
        web: 'webOwners',
        ads: 'adsOwners',
        design: 'designOwners',
        social: 'socialOwners',
        webdev: 'webdevOwners',
      };
      // Reset all dynamic owner arrays to empty, then populate from DB
      Object.values(ROLE_TO_OWNER_KEY).forEach(k => { config[k] = []; });
      userRows.forEach(u => {
        const ownerKey = ROLE_TO_OWNER_KEY[u.role];
        if (ownerKey) config[ownerKey].push(u.name);
      });
      console.log(`GET /api/config/admin_options: owner lists injected from users table (${userRows.length} users)`);
      return res.json(config);
    }

    // All other config keys use app_config
    const [rows] = await pool.query('SELECT value FROM app_config WHERE `key` = ?', [key]);
    if (rows.length === 0) {
      console.log(`GET /api/config/${key}: no row found`);
      return res.json(null);
    }
    const val = rows[0].value;
    const parsed = typeof val === 'string' ? JSON.parse(val) : val;
    res.json(parsed);
  } catch (e) {
    console.error('GET /api/config error:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load config' });
  }
});

app.put('/api/config/:key', async (req, res) => {
  try {
    const key = req.params.key;
    let body = req.body;

    // Users are stored in the dedicated users table
    if (key === 'users' && Array.isArray(body)) {
      console.log(`PUT /api/config/users: ${body.length} users, names: [${body.map(u => u.name).join(', ')}]`);

      let conn;
      try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        // Collect incoming IDs to remove deleted users
        const incomingIds = body.map(u => u.id);
        if (incomingIds.length > 0) {
          // Delete users not in the incoming list
          const placeholders = incomingIds.map(() => '?').join(',');
          await conn.query(`DELETE FROM users WHERE id NOT IN (${placeholders})`, incomingIds);
        } else {
          await conn.query('DELETE FROM users');
        }
        // Upsert each user — encrypt passwords before storing
        for (const u of body) {
          const encryptedPassword = encrypt(u.password || '');
          await conn.query(
            `INSERT INTO users (id, name, password, role, ownerName) VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name), password = VALUES(password), role = VALUES(role), ownerName = VALUES(ownerName)`,
            [u.id, u.name || '', encryptedPassword, u.role || 'seo', u.ownerName || '']
          );
        }
        await conn.commit();
      } catch (err) {
        if (conn) await conn.rollback().catch(() => {});
        throw err;
      } finally {
        if (conn) conn.release();
      }
      return res.json({ ok: true, message: `${body.length} user(s) saved successfully` });
    }

    // admin_options: strip dynamic owner arrays before saving — they are always
    // derived from the users table on GET, so storing them would cause stale data.
    if (key === 'admin_options' && body && typeof body === 'object' && !Array.isArray(body)) {
      const dynamicOwnerKeys = ['seoOwners', 'contentOwners', 'webOwners', 'adsOwners', 'designOwners', 'socialOwners', 'webdevOwners'];
      body = Object.assign({}, body);
      dynamicOwnerKeys.forEach(k => delete body[k]);
      console.log(`PUT /api/config/admin_options: stripped dynamic owner arrays, saving ${Object.keys(body).length} static keys`);
    }

    // Merge nav_access — preserve permission keys from DB that aren't in incoming data
    if (key === 'nav_access' && body && typeof body === 'object' && !Array.isArray(body)) {
      const [existing] = await pool.query('SELECT value FROM app_config WHERE `key` = ?', ['nav_access']);
      if (existing.length > 0) {
        let dbNav = existing[0].value;
        if (typeof dbNav === 'string') dbNav = JSON.parse(dbNav);
        if (dbNav && typeof dbNav === 'object') {
          let merged = false;
          for (const k of Object.keys(dbNav)) {
            if (!(k in body)) {
              body[k] = dbNav[k];
              merged = true;
            }
          }
          if (merged) console.log(`PUT /api/config/nav_access: merged missing keys from DB`);
        }
      }
      console.log(`PUT /api/config/nav_access: ${Object.keys(body).length} keys`);
    } else {
      console.log(`PUT /api/config/${key}: ${JSON.stringify(body).length} bytes`);
    }

    const value = JSON.stringify(body);
    await pool.query(
      'INSERT INTO app_config (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = ?',
      [key, value, value]
    );
    res.json({ ok: true, message: `Config '${key}' saved successfully` });
  } catch (e) {
    console.error('PUT /api/config error:', e.message);
    res.status(500).json({ error: 'Failed to save config' });
  }
});

// ── API: Login ────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { name, password } = req.body;
  try {
    const [rows] = await pool.query(
      'SELECT id, name, password, role, ownerName FROM users WHERE LOWER(name) = LOWER(?) LIMIT 1',
      [name]
    );
    if (rows.length > 0) {
      const storedPassword = decrypt(rows[0].password);
      if (storedPassword === password) {
        const { password: _, ...safe } = rows[0];
        res.json({ ok: true, message: `Welcome back, ${safe.name}!`, user: safe });
      } else {
        res.status(401).json({ error: 'Invalid credentials' });
      }
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (e) {
    console.error('POST /api/login error:', e.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── API: Client Config (budget/strategy per client per month) ──
app.get('/api/client-config', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT client, month, budget_hrs, strategy_url, notes FROM client_config ORDER BY client, month');
    // Convert rows into the nested object format the frontend expects:
    // { "ClientName": { months: { "2026-03": { budgetHrs: 10, strategyUrl: "..." } } } }
    const config = {};
    for (const r of rows) {
      if (!config[r.client]) config[r.client] = { months: {} };
      config[r.client].months[r.month] = {
        budgetHrs: Number(r.budget_hrs) || 0,
        strategyUrl: r.strategy_url || ''
      };
      if (r.notes) config[r.client].notes = r.notes;
    }
    res.json(config);
  } catch (e) {
    console.error('GET /api/client-config error:', e.message);
    res.status(500).json({ error: 'Failed to load client config' });
  }
});

app.put('/api/client-config', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'Expected object' });
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.query('DELETE FROM client_config');
    for (const [client, data] of Object.entries(body)) {
      const months = data.months || {};
      for (const [month, cfg] of Object.entries(months)) {
        await conn.query(
          'INSERT INTO client_config (client, month, budget_hrs, strategy_url, notes) VALUES (?, ?, ?, ?, ?)',
          [client, month, cfg.budgetHrs || 0, cfg.strategyUrl || '', data.notes || '']
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

// ── API: Historical Keywords ──────────────────────────
app.get('/api/historical-keywords', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, task_id, keyword, month, rank_value, volume, client, recorded_at FROM historical_keywords ORDER BY recorded_at DESC');
    res.json(rows.map(r => ({
      id: r.id, taskId: r.task_id, keyword: r.keyword,
      month: r.month, rank: r.rank_value, volume: r.volume,
      client: r.client, recordedAt: r.recorded_at
    })));
  } catch (e) {
    console.error('GET /api/historical-keywords error:', e.message);
    res.status(500).json({ error: 'Failed to load keywords' });
  }
});

app.put('/api/historical-keywords', async (req, res) => {
  const data = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: 'Expected array' });
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.query('DELETE FROM historical_keywords');
    for (const kw of data) {
      await conn.query(
        'INSERT INTO historical_keywords (task_id, keyword, month, rank_value, volume, client) VALUES (?, ?, ?, ?, ?, ?)',
        [kw.taskId || kw.task_id || null, kw.keyword || '', kw.month || '', kw.rank || kw.rank_value || 0, kw.volume || 0, kw.client || '']
      );
    }
    await conn.commit();
    res.json({ ok: true, count: data.length, message: `${data.length} keyword(s) saved successfully` });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('PUT /api/historical-keywords error:', e.message);
    res.status(500).json({ error: 'Failed to save keywords' });
  } finally {
    if (conn) conn.release();
  }
});

// ── API: Leave Records ────────────────────────────────
app.get('/api/leave-records', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, user_name, user_role, leave_date, leave_type, reason, status FROM leave_records ORDER BY leave_date DESC');
    res.json(rows.map(r => ({
      id: r.id, userName: r.user_name, userRole: r.user_role,
      leaveDate: r.leave_date, leaveType: r.leave_type,
      reason: r.reason, status: r.status
    })));
  } catch (e) {
    console.error('GET /api/leave-records error:', e.message);
    res.status(500).json({ error: 'Failed to load leave records' });
  }
});

app.put('/api/leave-records', async (req, res) => {
  const data = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: 'Expected array' });
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.query('DELETE FROM leave_records');
    for (const r of data) {
      const id = r.id || ('lv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
      await conn.query(
        'INSERT INTO leave_records (id, user_name, user_role, leave_date, leave_type, reason, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, r.userName || r.user_name || '', r.userRole || r.user_role || '', r.leaveDate || r.leave_date || new Date().toISOString().slice(0, 10), r.leaveType || r.leave_type || 'full', r.reason || '', r.status || 'approved']
      );
    }
    await conn.commit();
    res.json({ ok: true, count: data.length, message: `${data.length} leave record(s) saved successfully` });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('PUT /api/leave-records error:', e.message);
    res.status(500).json({ error: 'Failed to save leave records' });
  } finally {
    if (conn) conn.release();
  }
});

// ── API: WorkHub Remarks ──────────────────────────────
app.get('/api/workhub-remarks', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, task_id, user_name, user_role, remark, created_at FROM workhub_remarks ORDER BY created_at DESC');
    res.json(rows.map(r => ({
      id: r.id, taskId: r.task_id, userName: r.user_name,
      userRole: r.user_role, remark: r.remark, createdAt: r.created_at
    })));
  } catch (e) {
    console.error('GET /api/workhub-remarks error:', e.message);
    res.status(500).json({ error: 'Failed to load remarks' });
  }
});

app.put('/api/workhub-remarks', async (req, res) => {
  const data = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: 'Expected array' });
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.query('DELETE FROM workhub_remarks');
    for (const r of data) {
      const id = r.id || ('rm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
      await conn.query(
        'INSERT INTO workhub_remarks (id, task_id, user_name, user_role, remark) VALUES (?, ?, ?, ?, ?)',
        [id, r.taskId || r.task_id || '', r.userName || r.user_name || '', r.userRole || r.user_role || '', r.remark || '']
      );
    }
    await conn.commit();
    res.json({ ok: true, count: data.length, message: `${data.length} remark(s) saved successfully` });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('PUT /api/workhub-remarks error:', e.message);
    res.status(500).json({ error: 'Failed to save remarks' });
  } finally {
    if (conn) conn.release();
  }
});

// ── Audit Log (MySQL) ─────────────────────────────────

app.post('/api/audit', async (req, res) => {
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    const month = new Date().toISOString().slice(0, 7);
    for (const e of events) {
      const id = e.id || ('evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
      await pool.query(
        `INSERT INTO audit_logs (id, month, timestamp, user_name, user_role, action, task_id, task_title, client, source, field, old_value, new_value, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, month, e.timestamp || null, e.userName || null, e.userRole || null, e.action || null,
         e.taskId || null, e.taskTitle || null, e.client || null, e.source || null,
         e.field || null, e.oldValue || null, e.newValue || null, e.note || null]
      );
    }
    res.json({ ok: true, count: events.length, message: `${events.length} audit event(s) logged` });
  } catch (e) {
    console.error('POST /api/audit error:', e.message);
    res.status(500).json({ error: 'Failed to save audit log' });
  }
});

app.get('/api/audit', async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const [rows] = await pool.query('SELECT * FROM audit_logs WHERE month = ? ORDER BY created_at', [month]);
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

app.get('/api/audit/months', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT DISTINCT month FROM audit_logs ORDER BY month DESC');
    res.json(rows.map(r => r.month));
  } catch (e) {
    console.error('GET /api/audit/months error:', e.message);
    res.status(500).json({ error: 'Failed to load audit months' });
  }
});

app.delete('/api/audit/:id', async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const [rows] = await pool.query('SELECT * FROM audit_logs WHERE id = ? AND month = ?', [req.params.id, month]);
    if (rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    const evt = rows[0];
    await pool.query('DELETE FROM audit_logs WHERE id = ?', [req.params.id]);
    res.json({
      ok: true, event: {
        id: evt.id, month: evt.month, timestamp: evt.timestamp,
        userName: evt.user_name, userRole: evt.user_role, action: evt.action,
        taskId: evt.task_id, taskTitle: evt.task_title, client: evt.client,
        source: evt.source, field: evt.field, oldValue: evt.old_value,
        newValue: evt.new_value, note: evt.note,
      }
    });
  } catch (e) {
    console.error('DELETE /api/audit error:', e.message);
    res.status(500).json({ error: 'Failed to delete audit event' });
  }
});

app.get('/api/audit/download', async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const [rows] = await pool.query('SELECT * FROM audit_logs WHERE month = ? ORDER BY created_at', [month]);
    const headers = ['Timestamp', 'User', 'Role', 'Action', 'Task ID', 'Task Title', 'Client', 'Source', 'Field', 'Old Value', 'New Value', 'Note'];
    const csvRows = rows.map(e => [
      e.timestamp, e.user_name, e.user_role, e.action,
      e.task_id || '', e.task_title || '', e.client || '',
      e.source || '', e.field || '', e.old_value || '', e.new_value || '', e.note || ''
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const csv = [headers.join(','), ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${month}.csv"`);
    res.send(csv);
  } catch (e) {
    console.error('GET /api/audit/download error:', e.message);
    res.status(500).json({ error: 'Failed to generate CSV' });
  }
});

// ── Static + SPA fallback ─────────────────────────────
app.use(express.static(path.join(__dirname, 'dist')));

app.get('*', (_req, res) => {
  const indexPath = path.join(__dirname, 'dist', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).json({ status: 'API server running', db_admin: '/db-access' });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Server running on ${HOST}:${PORT}`);
  console.log(`Database admin: http://localhost:${PORT}/db-access`);
  // Init DB tables AFTER server is listening — retry up to 3 times
  (async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // Use pool.query (not pool.execute) for DDL — more compatible
        const tables = [
          'tasks', 'app_config', 'users', 'audit_logs', 'sessions',
          'client_config', 'historical_keywords', 'leave_records', 'workhub_remarks'
        ];
        await initDb();
        // Verify
        const [rows] = await pool.query('SHOW TABLES');
        const existing = rows.map(r => Object.values(r)[0]);
        const missing = tables.filter(t => !existing.includes(t));
        if (missing.length > 0) {
          console.error(`DB init: missing tables after attempt ${attempt}: ${missing.join(', ')}`);
          if (attempt < 3) { await new Promise(r => setTimeout(r, 5000)); continue; }
        }
        console.log(`DB init succeeded on attempt ${attempt} — ${existing.length} tables`);
        return;
      } catch (e) {
        console.error(`DB init attempt ${attempt}/3 failed:`, e.code, e.message);
        if (attempt < 3) await new Promise(r => setTimeout(r, 5000));
      }
    }
    console.error('All DB init attempts failed — visit /api/db-init to force-create tables');
  })();
});
