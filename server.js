import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import dbMiddleware from './db-middleware.js';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 10000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const HOST = process.env.HOST || '0.0.0.0';

// ── DB helpers ────────────────────────────────────────
function getDb() {
  return new Database(DB_PATH);
}

function initDb() {
  const db = getDb();
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.close();
}

initDb();

// ── Middleware ─────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

// Prevent browser caching of API responses
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
});

// DB admin panel at /db-access
app.use(dbMiddleware);

// ── API: Tasks ────────────────────────────────────────
app.get('/api/tasks', (_req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare('SELECT data FROM tasks ORDER BY id').all();
    res.json(rows.map(r => JSON.parse(r.data)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    db.close();
  }
});

app.put('/api/tasks', (req, res) => {
  const tasks = req.body;
  if (!Array.isArray(tasks)) return res.status(400).json({ error: 'Expected array' });
  const db = getDb();
  try {
    db.transaction(() => {
      db.prepare('DELETE FROM tasks').run();
      const ins = db.prepare('INSERT INTO tasks (id, data) VALUES (?, ?)');
      for (const t of tasks) ins.run(t.id, JSON.stringify(t));
    })();
    res.json({ ok: true, count: tasks.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    db.close();
  }
});

// ── API: Config (admin_options, users, nav_access) ────
app.get('/api/config/:key', (req, res) => {
  const db = getDb();
  try {
    const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(req.params.key);
    res.json(row ? JSON.parse(row.value) : null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    db.close();
  }
});

app.put('/api/config/:key', (req, res) => {
  const db = getDb();
  try {
    db.prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)').run(
      req.params.key, JSON.stringify(req.body)
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    db.close();
  }
});

// ── API: Login ────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { name, password } = req.body;
  const db = getDb();
  try {
    const row = db.prepare("SELECT value FROM app_config WHERE key = 'users'").get();
    const users = row ? JSON.parse(row.value) : [];
    const user = users.find(u => u.name.toLowerCase() === name.toLowerCase() && u.password === password);
    if (user) {
      const { password: _, ...safe } = user;
      res.json({ ok: true, user: safe });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    db.close();
  }
});


// ── Audit Log (JSON file per month) ───────────────────

const AUDIT_DIR = process.env.AUDIT_DIR || path.join(__dirname, 'audit-logs');
if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });

function auditFile(month) {
  return path.join(AUDIT_DIR, `audit-${month}.json`);
}

function readAudit(month) {
  const f = auditFile(month);
  if (!fs.existsSync(f)) return [];
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}

function writeAudit(month, events) {
  fs.writeFileSync(auditFile(month), JSON.stringify(events, null, 2), 'utf8');
}

// POST /api/audit — append event(s)
app.post('/api/audit', (req, res) => {
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    const month = new Date().toISOString().slice(0, 7); // YYYY-MM
    const existing = readAudit(month);
    const updated = [...existing, ...events.map(e => ({
      ...e,
      id: e.id || ('evt_' + Date.now() + '_' + Math.random().toString(36).slice(2,7)),
      month,
    }))];
    writeAudit(month, updated);
    res.json({ ok: true, count: events.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/audit?month=2026-03 — read events
app.get('/api/audit', (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const events = readAudit(month);
    res.json(events);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/audit/months — list available months
app.get('/api/audit/months', (_req, res) => {
  try {
    const files = fs.existsSync(AUDIT_DIR) ? fs.readdirSync(AUDIT_DIR) : [];
    const months = files
      .filter(f => f.startsWith('audit-') && f.endsWith('.json'))
      .map(f => f.replace('audit-', '').replace('.json', ''))
      .sort().reverse();
    res.json(months);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/audit/:id — undo a single event (remove from file + reverse on task)
app.delete('/api/audit/:id', (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const events = readAudit(month);
    const evt = events.find(e => e.id === req.params.id);
    if (!evt) return res.status(404).json({ error: 'Event not found' });
    const updated = events.filter(e => e.id !== req.params.id);
    writeAudit(month, updated);
    res.json({ ok: true, event: evt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/audit/download?month=2026-03 — CSV download
app.get('/api/audit/download', (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const events = readAudit(month);
    const headers = ['Timestamp','User','Role','Action','Task ID','Task Title','Client','Source','Field','Old Value','New Value','Note'];
    const rows = events.map(e => [
      e.timestamp, e.userName, e.userRole, e.action,
      e.taskId||'', e.taskTitle||'', e.client||'',
      e.source||'', e.field||'', e.oldValue||'', e.newValue||'', e.note||''
    ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${month}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ── Audit Log (JSON file per month) ───────────────────

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
});
