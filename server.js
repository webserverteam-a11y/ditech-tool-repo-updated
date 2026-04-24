import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import pool from './config/db.js';
import dbMiddleware from './db-middleware.js';
import { encrypt, decrypt, isEncrypted } from './config/crypto.js';

// ── New modular backend (Step 1 scaffolding) ──────────
// These wire in the standard response helpers and error handler. They do
// NOT change any existing endpoint behavior — old routes still use res.json
// directly. New routes (added in later migration steps) will use res.ok /
// res.fail from attachResponders, and unhandled errors will be caught by
// globalErrorHandler.
import { validateEnv } from './backend/config/env.js';
import { attachResponders } from './backend/middleware/response.js';
import { noCache } from './backend/middleware/noCache.js';
import { apiNotFound, globalErrorHandler } from './backend/middleware/errorHandler.js';
import { buildApiRouter } from './backend/routes/index.js';

validateEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 10000;
const HOST = process.env.HOST || '0.0.0.0';

// ── DB init ───────────────────────────────────────────
async function initDb() {
  const ddl = [
    ['tasks', `CREATE TABLE IF NOT EXISTS tasks (
      id VARCHAR(255) PRIMARY KEY,
      title VARCHAR(500) DEFAULT '', client VARCHAR(255) DEFAULT '',
      seo_owner VARCHAR(255) DEFAULT '', seo_stage VARCHAR(255) DEFAULT '',
      seo_qc_status VARCHAR(100) DEFAULT '', focused_kw VARCHAR(500) DEFAULT '',
      volume INT DEFAULT 0, mar_rank INT DEFAULT 0, current_rank INT DEFAULT 0,
      est_hours DECIMAL(10,2) DEFAULT 0, est_hours_seo DECIMAL(10,2) DEFAULT 0,
      est_hours_content DECIMAL(10,2) DEFAULT 0, est_hours_web DECIMAL(10,2) DEFAULT 0,
      est_hours_content_rework DECIMAL(10,2) DEFAULT 0, est_hours_seo_review DECIMAL(10,2) DEFAULT 0,
      actual_hours DECIMAL(10,2) DEFAULT 0,
      content_assigned_date VARCHAR(50) DEFAULT '', content_owner VARCHAR(255) DEFAULT '',
      content_status VARCHAR(100) DEFAULT '',
      web_assigned_date VARCHAR(50) DEFAULT '', web_owner VARCHAR(255) DEFAULT '',
      target_url TEXT, web_status VARCHAR(100) DEFAULT '',
      current_owner VARCHAR(255) DEFAULT '', days_in_stage INT DEFAULT 0,
      remarks TEXT, is_completed TINYINT(1) DEFAULT 0,
      execution_state VARCHAR(100) DEFAULT 'Not Started', doc_url TEXT,
      intake_date VARCHAR(50) DEFAULT '',
      dept_type VARCHAR(100) DEFAULT '', task_type VARCHAR(100) DEFAULT '',
      platform VARCHAR(100) DEFAULT '', deliverable_url TEXT,
      due_date VARCHAR(50) DEFAULT '', assigned_to VARCHAR(255) DEFAULT '',
      ad_budget DECIMAL(10,2) DEFAULT 0, qc_submitted_at VARCHAR(50) DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tasks_client (client), INDEX idx_tasks_seo_owner (seo_owner),
      INDEX idx_tasks_intake_date (intake_date), INDEX idx_tasks_is_completed (is_completed))`],
    ['task_time_events', `CREATE TABLE IF NOT EXISTS task_time_events (
      id INT AUTO_INCREMENT PRIMARY KEY, task_id VARCHAR(255) NOT NULL,
      event_type VARCHAR(50) NOT NULL DEFAULT '', timestamp VARCHAR(50) DEFAULT '',
      department VARCHAR(100) DEFAULT '', owner VARCHAR(255) DEFAULT '',
      INDEX idx_tte_task (task_id),
      CONSTRAINT fk_tte_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE)`],
    ['task_qc_reviews', `CREATE TABLE IF NOT EXISTS task_qc_reviews (
      id INT AUTO_INCREMENT PRIMARY KEY, task_id VARCHAR(255) NOT NULL,
      review_id VARCHAR(255) NOT NULL DEFAULT '',
      submitted_by VARCHAR(255) DEFAULT '', submitted_by_dept VARCHAR(100) DEFAULT '',
      submitted_at VARCHAR(50) DEFAULT '', assigned_to VARCHAR(255) DEFAULT '',
      est_hours DECIMAL(10,2) DEFAULT 0, note TEXT,
      outcome VARCHAR(100) DEFAULT '', completed_at VARCHAR(50) DEFAULT '',
      INDEX idx_tqr_task (task_id),
      CONSTRAINT fk_tqr_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE)`],
    ['task_rework_entries', `CREATE TABLE IF NOT EXISTS task_rework_entries (
      id INT AUTO_INCREMENT PRIMARY KEY, task_id VARCHAR(255) NOT NULL,
      rework_id VARCHAR(255) NOT NULL DEFAULT '', date VARCHAR(50) DEFAULT '',
      est_hours DECIMAL(10,2) DEFAULT 0,
      assigned_dept VARCHAR(100) DEFAULT '', assigned_owner VARCHAR(255) DEFAULT '',
      within_estimate TINYINT(1) DEFAULT 0, hours_already_spent DECIMAL(10,2) DEFAULT 0,
      start_timestamp VARCHAR(50) DEFAULT '', end_timestamp VARCHAR(50) DEFAULT '',
      duration_ms BIGINT DEFAULT 0,
      INDEX idx_tre_task (task_id),
      CONSTRAINT fk_tre_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE)`],
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
      report_url TEXT DEFAULT '',
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
    ['clients', `CREATE TABLE IF NOT EXISTS clients (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`],
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

  // ── Schema migrations (safe to run on every startup) ─────────────────────
  // These add UNIQUE constraints needed for upsert-safe child table saves.
  // IF the constraint already exists, MariaDB/MySQL throws a duplicate key error
  // which we silently ignore (idempotent).
  const migrations = [
    // Allow ON DUPLICATE KEY UPDATE on qcReviews by (task_id, review_id)
    ['qc_reviews_unique', `ALTER TABLE task_qc_reviews ADD UNIQUE KEY uq_tqr_task_review (task_id, review_id)`],
    // Allow ON DUPLICATE KEY UPDATE on reworkEntries by (task_id, rework_id)
    ['rework_entries_unique', `ALTER TABLE task_rework_entries ADD UNIQUE KEY uq_tre_task_rework (task_id, rework_id)`],
    // Remove duplicate task_time_events rows before adding unique index.
    // Keeps the row with the lowest id for each (task_id, event_type, timestamp) triple.
    ['dedup_time_events', `DELETE t1 FROM task_time_events t1 INNER JOIN task_time_events t2 ON t1.task_id = t2.task_id AND t1.event_type = t2.event_type AND t1.timestamp = t2.timestamp AND t1.id > t2.id`],
    // Add unique index so INSERT IGNORE in saveTask.js correctly deduplicates events.
    ['tte_unique', `ALTER TABLE task_time_events ADD UNIQUE KEY idx_tte_unique (task_id, event_type, \`timestamp\`)`],
    // Add new columns to historical_keywords for full keyword data
    ['hk_add_seo_owner', `ALTER TABLE historical_keywords ADD COLUMN seo_owner VARCHAR(255) DEFAULT ''`],
    ['hk_add_intake_date', `ALTER TABLE historical_keywords ADD COLUMN intake_date VARCHAR(50) DEFAULT ''`],
    ['hk_add_current_rank', `ALTER TABLE historical_keywords ADD COLUMN current_rank INT DEFAULT 0`],
    ['hk_add_target_url', `ALTER TABLE historical_keywords ADD COLUMN target_url TEXT`],
    ['hk_add_task_title', `ALTER TABLE historical_keywords ADD COLUMN task_title VARCHAR(500) DEFAULT ''`],
    ['hk_add_source', `ALTER TABLE historical_keywords ADD COLUMN source VARCHAR(50) DEFAULT 'upload'`],
  ];
  for (const [name, sql] of migrations) {
    try {
      await pool.query(sql);
      console.log(`  migration [${name}]: applied`);
    } catch (e) {
      // 1061 = Duplicate key name (constraint already exists) — safe to ignore
      // 1060 = Duplicate column name — safe to ignore for ADD COLUMN migrations
      if (e.errno === 1061 || e.errno === 1060 || (e.message && (e.message.includes('Duplicate key name') || e.message.includes('Duplicate column name')))) {
        console.log(`  migration [${name}]: already applied (skipped)`);
      } else {
        console.error(`  migration [${name}] FAILED:`, e.code, e.message);
      }
    }
  }
  if (fail > 0) throw new Error(`${fail} tables failed to create`);
}

// ── Middleware ─────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));

// No-cache headers on every /api response
app.use('/api', noCache);

// Attach res.ok / res.fail helpers (harmless to existing routes — they just
// don't call them. New routes will).
app.use('/api', attachResponders);

// New modular API router (empty in Step 1 — resources are added one at a time
// in later migration steps). Mounted BEFORE the inline routes below so that a
// migrated route takes precedence if ever both existed at the same path.
app.use('/api', buildApiRouter());

// DB admin panel at /db-access
app.use(dbMiddleware);


// ── Date normalization helper ─────────────────────────
// Converts various date formats to YYYY-MM-DD.
// Handles: DD-MM-YYYY, DD/MM/YYYY, MM-DD-YYYY, MM/DD/YYYY, YYYY/MM/DD, YYYY-MM-DD
// Returns the original string unchanged if it cannot be parsed.
function normalizeDate(val) {
  if (!val || typeof val !== 'string') return val;
  const s = val.trim();
  if (!s) return s;

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // YYYY/MM/DD
  let m = s.match(/^(\d{4})[\/](\d{1,2})[\/](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;

  // DD-MM-YYYY or DD/MM/YYYY  (day > 12 disambiguates from MM-DD-YYYY)
  // MM-DD-YYYY or MM/DD/YYYY  (month > 12 is impossible, so first > 12 means day)
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const year = m[3];
    if (a > 12) {
      // a must be day → DD-MM-YYYY
      return `${year}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
    }
    if (b > 12) {
      // b must be day → MM-DD-YYYY
      return `${year}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`;
    }
    // Ambiguous (both ≤ 12): assume DD-MM-YYYY (common in Indian locale)
    return `${year}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
  }

  return s;
}

// Normalize all date fields on a task object and ensure intakeDate is never blank
const TASK_DATE_FIELDS = ['intakeDate', 'contentAssignedDate', 'webAssignedDate'];
function normalizeTaskDates(task) {
  const today = new Date().toISOString().split('T')[0];
  for (const field of TASK_DATE_FIELDS) {
    if (task[field]) {
      task[field] = normalizeDate(task[field]);
    }
  }
  // If intakeDate is missing or blank, default to today so the task is never
  // silently hidden by the Action Board's date filter.
  if (!task.intakeDate || !task.intakeDate.trim()) {
    task.intakeDate = today;
  }
  return task;
}

// ── Task column mapping (snake_case DB → camelCase JSON) ──
const TASK_COLUMN_MAP = {
  id: 'id', title: 'title', client: 'client', intake_date: 'intakeDate',
  seo_owner: 'seoOwner', seo_stage: 'seoStage', seo_qc_status: 'seoQcStatus',
  focused_kw: 'focusedKw', volume: 'volume', mar_rank: 'marRank',
  current_rank: 'currentRank', est_hours: 'estHours', est_hours_seo: 'estHoursSEO',
  est_hours_content: 'estHoursContent', est_hours_web: 'estHoursWeb',
  actual_hours: 'actualHours', content_assigned_date: 'contentAssignedDate',
  content_owner: 'contentOwner', content_status: 'contentStatus',
  web_assigned_date: 'webAssignedDate', web_owner: 'webOwner',
  target_url: 'targetUrl', web_status: 'webStatus', current_owner: 'currentOwner',
  days_in_stage: 'daysInStage', remarks: 'remarks', is_completed: 'isCompleted',
  execution_state: 'executionState', doc_url: 'docUrl', dept_type: 'deptType',
  task_type: 'taskType', platform: 'platform', deliverable_url: 'deliverableUrl',
  due_date: 'dueDate', assigned_to: 'assignedTo', ad_budget: 'adBudget',
  est_hours_seo_review: 'estHoursSEOReview', qc_submitted_at: 'qcSubmittedAt',
  est_hours_content_rework: 'estHoursContentRework',
};
const INT_COLS = new Set(['volume', 'mar_rank', 'current_rank', 'days_in_stage']);
const DEC_COLS = new Set(['est_hours', 'est_hours_seo', 'est_hours_content', 'est_hours_web',
  'actual_hours', 'ad_budget', 'est_hours_seo_review', 'est_hours_content_rework']);
const DATE_COLS = new Set(['intake_date', 'content_assigned_date', 'web_assigned_date', 'due_date']);
const TASK_COLS = Object.keys(TASK_COLUMN_MAP);

function groupBy(arr, key) {
  const m = {};
  for (const item of arr) { const k = item[key]; if (!m[k]) m[k] = []; m[k].push(item); }
  return m;
}

// DB row → camelCase task object (without child arrays)
function rowToTask(row) {
  const task = {};
  for (const col of TASK_COLS) {
    const key = TASK_COLUMN_MAP[col];
    let val = row[col];
    if (val === null || val === undefined) {
      if (INT_COLS.has(col) || DEC_COLS.has(col)) val = 0;
      else if (col === 'is_completed') val = false;
      else val = '';
    }
    if (col === 'is_completed') val = !!val;
    if (INT_COLS.has(col)) val = Number(val) || 0;
    if (DEC_COLS.has(col)) val = Number(val) || 0;
    task[key] = val;
  }
  task.timeEvents = [];
  task.qcReviews = [];
  task.reworkEntries = [];
  return task;
}

// camelCase task object → { cols, vals } for INSERT/UPDATE
function taskToColumns(task) {
  const cols = []; const vals = [];
  for (const col of TASK_COLS) {
    const key = TASK_COLUMN_MAP[col];
    let val = task[key];
    if (val === undefined) val = null;
    if (col === 'is_completed') val = val ? 1 : 0;
    if ((INT_COLS.has(col) || DEC_COLS.has(col)) && (val === '' || val === null)) val = 0;
    cols.push(col);
    vals.push(val);
  }
  return { cols, vals };
}

// Save one task + child rows inside an existing transaction connection
async function saveTaskToDb(conn, task) {
  normalizeTaskDates(task);
  const { cols, vals } = taskToColumns(task);
  const placeholders = cols.map(() => '?').join(',');
  const updates = cols.filter(c => c !== 'id').map(c => `${c} = VALUES(${c})`).join(', ');
  await conn.query(
    `INSERT INTO tasks (${cols.join(',')}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`,
    vals
  );
  // child tables — upsert by their natural unique key (task_id + event identity)
  // CONCURRENCY FIX: Previously used DELETE-then-INSERT which caused a race:
  // if two users saved the same task simultaneously, one save's DELETE would
  // wipe the other save's just-written child rows. Now we use INSERT ... ON
  // DUPLICATE KEY UPDATE so concurrent saves merge safely.
  //
  // task_time_events has no natural unique key (events are append-only), so
  // we still delete+reinsert them — but only within a transaction, so it's safe
  // for single-task saves. For bulk saves, the fetch-fresh-then-merge in the
  // frontend (patch-timer-fix) ensures timeEvents are always current before save.
  if (Array.isArray(task.timeEvents)) {
    await conn.query('DELETE FROM task_time_events WHERE task_id = ?', [task.id]);
    for (const ev of task.timeEvents) {
      await conn.query(
        'INSERT INTO task_time_events (task_id, event_type, timestamp, department, owner) VALUES (?,?,?,?,?)',
        [task.id, ev.type || '', ev.timestamp || '', ev.department || '', ev.owner || '']
      );
    }
  }
  // qcReviews: upsert by review_id (unique per task)
  if (Array.isArray(task.qcReviews)) {
    for (const qc of task.qcReviews) {
      await conn.query(
        `INSERT INTO task_qc_reviews (task_id, review_id, submitted_by, submitted_by_dept, submitted_at, assigned_to, est_hours, note, outcome, completed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE submitted_by=VALUES(submitted_by), submitted_by_dept=VALUES(submitted_by_dept),
           submitted_at=VALUES(submitted_at), assigned_to=VALUES(assigned_to), est_hours=VALUES(est_hours),
           note=VALUES(note), outcome=VALUES(outcome), completed_at=VALUES(completed_at)`,
        [task.id, qc.id || '', qc.submittedBy || '', qc.submittedByDept || '', qc.submittedAt || '', qc.assignedTo || '', qc.estHours || 0, qc.note || '', qc.outcome || '', qc.completedAt || '']
      );
    }
    // Remove qcReviews that are no longer in the task (user explicitly deleted them)
    if (task.qcReviews.length > 0) {
      const qcIds = task.qcReviews.map(qc => qc.id).filter(Boolean);
      if (qcIds.length > 0) {
        const ph = qcIds.map(() => '?').join(',');
        await conn.query(`DELETE FROM task_qc_reviews WHERE task_id = ? AND review_id NOT IN (${ph})`, [task.id, ...qcIds]);
      }
    } else {
      await conn.query('DELETE FROM task_qc_reviews WHERE task_id = ?', [task.id]);
    }
  }
  // reworkEntries: upsert by rework_id (unique per task)
  if (Array.isArray(task.reworkEntries)) {
    for (const rw of task.reworkEntries) {
      await conn.query(
        `INSERT INTO task_rework_entries (task_id, rework_id, date, est_hours, assigned_dept, assigned_owner, within_estimate, hours_already_spent, start_timestamp, end_timestamp, duration_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE date=VALUES(date), est_hours=VALUES(est_hours), assigned_dept=VALUES(assigned_dept),
           assigned_owner=VALUES(assigned_owner), within_estimate=VALUES(within_estimate),
           hours_already_spent=VALUES(hours_already_spent), start_timestamp=VALUES(start_timestamp),
           end_timestamp=VALUES(end_timestamp), duration_ms=VALUES(duration_ms)`,
        [task.id, rw.id || '', rw.date || '', rw.estHours || 0, rw.assignedDept || '', rw.assignedOwner || '', rw.withinEstimate ? 1 : 0, rw.hoursAlreadySpent || 0, rw.startTimestamp || '', rw.endTimestamp || '', rw.durationMs || 0]
      );
    }
    // Remove reworkEntries no longer in the task
    if (task.reworkEntries.length > 0) {
      const rwIds = task.reworkEntries.map(rw => rw.id).filter(Boolean);
      if (rwIds.length > 0) {
        const ph = rwIds.map(() => '?').join(',');
        await conn.query(`DELETE FROM task_rework_entries WHERE task_id = ? AND rework_id NOT IN (${ph})`, [task.id, ...rwIds]);
      }
    } else {
      await conn.query('DELETE FROM task_rework_entries WHERE task_id = ?', [task.id]);
    }
  }
}

// ── API: Tasks ────────────────────────────────────────
app.get('/api/tasks', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tasks ORDER BY id');
    const [teRows] = await pool.query('SELECT * FROM task_time_events ORDER BY id');
    const [qcRows] = await pool.query('SELECT * FROM task_qc_reviews ORDER BY id');
    const [rwRows] = await pool.query('SELECT * FROM task_rework_entries ORDER BY id');
    const teMap = groupBy(teRows, 'task_id');
    const qcMap = groupBy(qcRows, 'task_id');
    const rwMap = groupBy(rwRows, 'task_id');
    const tasks = rows.map(r => {
      const t = rowToTask(r);
      normalizeTaskDates(t);
      t.timeEvents = (teMap[t.id] || []).map(e => ({ type: e.event_type, timestamp: e.timestamp, department: e.department, owner: e.owner }));
      t.qcReviews = (qcMap[t.id] || []).map(e => {
        const obj = { id: e.review_id, submittedBy: e.submitted_by, submittedByDept: e.submitted_by_dept, submittedAt: e.submitted_at, assignedTo: e.assigned_to, estHours: Number(e.est_hours) || 0 };
        if (e.note) obj.note = e.note;
        if (e.outcome) obj.outcome = e.outcome;
        if (e.completed_at) obj.completedAt = e.completed_at;
        return obj;
      });
      t.reworkEntries = (rwMap[t.id] || []).map(e => ({
        id: e.rework_id, date: e.date, estHours: Number(e.est_hours) || 0,
        assignedDept: e.assigned_dept, assignedOwner: e.assigned_owner,
        withinEstimate: !!e.within_estimate, hoursAlreadySpent: Number(e.hours_already_spent) || 0,
        startTimestamp: e.start_timestamp, endTimestamp: e.end_timestamp,
        durationMs: Number(e.duration_ms) || 0,
      }));
      return t;
    });
    res.json(tasks);
  } catch (e) {
    console.error('GET /api/tasks error:', e.code, e.message);
    res.status(500).json({ error: 'Failed to load tasks' });
  }
});

app.put('/api/tasks', async (req, res) => {
  const tasks = req.body;
  if (!Array.isArray(tasks)) return res.status(400).json({ error: 'Expected array' });
  // Safety guard — never allow a bulk wipe via empty payload
  if (tasks.length === 0) {
    return res.json({ ok: true, count: 0, message: 'No tasks provided, nothing changed.' });
  }
  // SAFETY: Validate all tasks have IDs before touching the DB
  const ids = tasks.map(t => t.id).filter(Boolean);
  if (ids.length === 0) {
    return res.status(400).json({ error: 'No valid task IDs in payload, aborting to prevent data loss.' });
  }
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    // ── CONCURRENCY FIX ──────────────────────────────────────────────────────
    // Previously this route did: DELETE FROM tasks WHERE id NOT IN (incoming IDs)
    // That caused tasks added by OTHER users (not yet in the current user's local
    // state) to be silently deleted when any user triggered a bulk save.
    // Scenario: User A adds Task-X, User B (whose state loaded before Task-X
    // was created) saves their own task list — Task-X gets wiped.
    //
    // Fix: NEVER delete tasks in bulk. Only upsert (insert or update).
    // To delete a task, use DELETE /api/tasks/:id explicitly.
    // ─────────────────────────────────────────────────────────────────────────
    for (const t of tasks) {
      await saveTaskToDb(conn, t);
    }
    await conn.commit();

    // ── DB verification: count saved rows to confirm all tasks persisted ──
    const ph = ids.map(() => '?').join(',');
    const [verifyRows] = await pool.query(
      `SELECT COUNT(*) AS count FROM tasks WHERE id IN (${ph})`, ids
    );
    const verifiedCount = Number(verifyRows[0].count) || 0;
    const dbVerified = verifiedCount === ids.length;

    res.json({
      ok: true,
      count: tasks.length,
      dbVerified,
      verifiedCount,
      message: dbVerified
        ? `${tasks.length} task(s) saved and verified in DB`
        : `${tasks.length} task(s) saved — DB verified ${verifiedCount} of ${ids.length}`,
    });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('PUT /api/tasks error:', e.message);
    res.status(500).json({ error: 'Failed to save tasks' });
  } finally {
    if (conn) conn.release();
  }
});

// ── API: Single-task atomic upsert (timer-safe) ──────
app.put('/api/tasks/:id', async (req, res) => {
  const task = req.body;
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    return res.status(400).json({ error: 'Expected task object' });
  }
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    task.id = req.params.id;
    await saveTaskToDb(conn, task);
    await conn.commit();

    // ── DB verification: read back the saved row to confirm persistence ──
    const [verifyRows] = await pool.query(
      'SELECT id, title, client, execution_state, updated_at FROM tasks WHERE id = ? LIMIT 1',
      [task.id]
    );
    const dbVerified = verifyRows.length > 0;
    const dbRecord = dbVerified ? {
      id: verifyRows[0].id,
      title: verifyRows[0].title,
      client: verifyRows[0].client,
      executionState: verifyRows[0].execution_state,
      updatedAt: verifyRows[0].updated_at,
    } : null;

    res.json({
      ok: true,
      dbVerified,
      dbRecord,
      message: dbVerified
        ? `Entry verified in DB — task "${task.id}" saved successfully`
        : `Task "${task.id}" saved but DB verification returned no row`,
    });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('PUT /api/tasks/:id error:', e.message);
    res.status(500).json({ error: 'Failed to save task' });
  } finally {
    if (conn) conn.release();
  }
});

// ── API: Delete a single task (explicit, safe) ───────────────────────────────
// Use this whenever a user intentionally deletes a task from the UI.
// Never use bulk DELETE — it risks wiping tasks added by concurrent users.
app.delete('/api/tasks/:id', async (req, res) => {
  const taskId = req.params.id;
  if (!taskId) return res.status(400).json({ error: 'Task ID required' });
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    // Delete child rows first (FK-safe order)
    await conn.query('DELETE FROM task_time_events WHERE task_id = ?', [taskId]);
    await conn.query('DELETE FROM task_qc_reviews WHERE task_id = ?', [taskId]);
    await conn.query('DELETE FROM task_rework_entries WHERE task_id = ?', [taskId]);
    const [result] = await conn.query('DELETE FROM tasks WHERE id = ?', [taskId]);
    await conn.commit();
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: `Task "${taskId}" not found` });
    }
    console.log(`DELETE /api/tasks/${taskId}: task and child rows removed`);
    res.json({ ok: true, message: `Task "${taskId}" deleted` });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('DELETE /api/tasks/:id error:', e.message);
    res.status(500).json({ error: 'Failed to delete task' });
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

    // admin_options: owner lists from users table, clients from clients table
    if (key === 'admin_options') {
      const [cfgRows] = await pool.query('SELECT value FROM app_config WHERE `key` = ?', ['admin_options']);
      let config = {};
      if (cfgRows.length > 0) {
        const val = cfgRows[0].value;
        config = typeof val === 'string' ? JSON.parse(val) : val;
      }

      // Clients: always read from dedicated clients table (not from JSON blob)
      const [clientRows] = await pool.query('SELECT name FROM clients ORDER BY sort_order, name');
      config.clients = clientRows.map(r => r.name);

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
      console.log(`GET /api/config/admin_options: ${config.clients.length} clients from clients table, ${userRows.length} users`);
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

      // Safety guard — never allow a bulk wipe via empty payload
      if (body.length === 0) {
        return res.json({ ok: true, message: 'No users provided, nothing changed.' });
      }

      let conn;
      try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        // Collect incoming IDs to remove deleted users
        const incomingIds = body.map(u => u.id).filter(Boolean);
        if (incomingIds.length > 0) {
          // Delete users not in the incoming list
          const placeholders = incomingIds.map(() => '?').join(',');
          await conn.query(`DELETE FROM users WHERE id NOT IN (${placeholders})`, incomingIds);
        } else {
          // All users have null/empty IDs — refuse to wipe
          await conn.rollback();
          return res.status(400).json({ error: 'No valid user IDs in payload, aborting to prevent data loss.' });
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

    // admin_options: strip dynamic owner arrays and save clients to dedicated table
    if (key === 'admin_options' && body && typeof body === 'object' && !Array.isArray(body)) {
      const dynamicOwnerKeys = ['seoOwners', 'contentOwners', 'webOwners', 'adsOwners', 'designOwners', 'socialOwners', 'webdevOwners'];
      body = Object.assign({}, body);
      dynamicOwnerKeys.forEach(k => delete body[k]);

      // Save clients to dedicated clients table (prevents data loss from JSON overwrite)
      // IMPORTANT: Only touch the clients table when the 'clients' key was explicitly included
      // in the payload. If it's absent (e.g. frontend sent a partial save), we leave the DB
      // untouched to prevent silent data loss when switching locations/devices.
      const clientsKeyPresent = 'clients' in body;
      const incomingClients = Array.isArray(body.clients) ? body.clients.filter(c => c && typeof c === 'string') : [];
      delete body.clients; // remove from JSON blob — clients now live in their own table

      if (clientsKeyPresent) {
        // Guard: if the key was sent but the array is empty, refuse to wipe all clients.
        // This protects against race conditions where the frontend saves before data has loaded.
        if (incomingClients.length === 0) {
          console.warn('PUT /api/config/admin_options: WARNING — clients key was sent but array is empty. Skipping clients table update to prevent data loss. This may indicate a frontend race condition or save triggered before client list loaded.');
        } else {
          let conn;
          try {
            conn = await pool.getConnection();
            await conn.beginTransaction();

            // Get existing clients from DB
            const [existingRows] = await conn.query('SELECT name FROM clients');
            const existingSet = new Set(existingRows.map(r => r.name));
            const incomingSet = new Set(incomingClients);

            // Delete removed clients (only ones explicitly removed by admin)
            const toDelete = [...existingSet].filter(c => !incomingSet.has(c));
            if (toDelete.length > 0) {
              const placeholders = toDelete.map(() => '?').join(',');
              await conn.query(`DELETE FROM clients WHERE name IN (${placeholders})`, toDelete);
            }

            // Insert new clients with sort_order preserving the incoming order
            // Uses ON DUPLICATE KEY UPDATE to avoid recreating rows (keeps original IDs stable)
            for (let i = 0; i < incomingClients.length; i++) {
              await conn.query(
                `INSERT INTO clients (name, sort_order) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order)`,
                [incomingClients[i], i]
              );
            }

            await conn.commit();
            console.log(`PUT /api/config/admin_options: saved ${incomingClients.length} clients to clients table (added ${incomingClients.length - existingSet.size + toDelete.length}, removed ${toDelete.length})`);
          } catch (err) {
            if (conn) await conn.rollback().catch(() => {});
            throw err;
          } finally {
            if (conn) conn.release();
          }
        }
      } else {
        // 'clients' key was not in the payload at all — leave clients table completely untouched
        console.log('PUT /api/config/admin_options: clients key not present in payload, clients table unchanged (safe partial save)');
      }

      console.log(`PUT /api/config/admin_options: saving ${Object.keys(body).length} static keys to app_config`);
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

// ── API: Clients CRUD (standalone, location-safe) ──────────────────────────────
// GET /api/clients — always returns the authoritative list from the clients table.
// Use this on page load instead of reading clients out of admin_options,
// to avoid race conditions when switching locations / devices.
app.get('/api/clients', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT name FROM clients ORDER BY sort_order, name');
    res.json(rows.map(r => r.name));
  } catch (e) {
    console.error('GET /api/clients error:', e.message);
    res.status(500).json({ error: 'Failed to load clients' });
  }
});

// POST /api/clients — add a single new client safely (never risks wiping others)
app.post('/api/clients', async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Client name is required' });
    }
    const clientName = name.trim();
    const [maxRow] = await pool.query('SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM clients');
    const nextOrder = (maxRow[0].maxOrder ?? -1) + 1;
    await pool.query(
      'INSERT INTO clients (name, sort_order) VALUES (?, ?) ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order)',
      [clientName, nextOrder]
    );
    console.log(`POST /api/clients: added "${clientName}" at sort_order ${nextOrder}`);
    res.json({ ok: true, message: `Client "${clientName}" added successfully` });
  } catch (e) {
    console.error('POST /api/clients error:', e.message);
    res.status(500).json({ error: 'Failed to add client' });
  }
});

// DELETE /api/clients/:name — remove a single client by name (URL-encoded)
app.delete('/api/clients/:name', async (req, res) => {
  try {
    const clientName = decodeURIComponent(req.params.name);
    if (!clientName) return res.status(400).json({ error: 'Client name is required' });
    const [result] = await pool.query('DELETE FROM clients WHERE name = ?', [clientName]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: `Client "${clientName}" not found` });
    }
    console.log(`DELETE /api/clients: removed "${clientName}"`);
    res.json({ ok: true, message: `Client "${clientName}" removed` });
  } catch (e) {
    console.error('DELETE /api/clients error:', e.message);
    res.status(500).json({ error: 'Failed to delete client' });
  }
});

// PUT /api/clients/reorder — update sort order only, never deletes
app.put('/api/clients/reorder', async (req, res) => {
  try {
    const { clients } = req.body || {};
    if (!Array.isArray(clients) || clients.length === 0) {
      return res.status(400).json({ error: 'Expected non-empty clients array' });
    }
    const names = clients.filter(c => c && typeof c === 'string');
    if (names.length === 0) return res.status(400).json({ error: 'No valid client names' });
    let conn;
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();
      for (let i = 0; i < names.length; i++) {
        await conn.query('UPDATE clients SET sort_order = ? WHERE name = ?', [i, names[i]]);
      }
      await conn.commit();
      console.log(`PUT /api/clients/reorder: reordered ${names.length} clients`);
      res.json({ ok: true, message: `${names.length} clients reordered` });
    } catch (err) {
      if (conn) await conn.rollback().catch(() => {});
      throw err;
    } finally {
      if (conn) conn.release();
    }
  } catch (e) {
    console.error('PUT /api/clients/reorder error:', e.message);
    res.status(500).json({ error: 'Failed to reorder clients' });
  }
});

// ── API: Client Config (budget/strategy per client per month) ──
app.get('/api/client-config', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT client, month, budget_hrs, strategy_url, report_url, notes FROM client_config ORDER BY client, month');
    // Convert rows into the nested object format the frontend expects:
    // { "ClientName": { months: { "2026-03": { budgetHrs: 10, strategyUrl: "...", reportUrl: "..." } } } }
    const config = {};
    for (const r of rows) {
      if (!config[r.client]) config[r.client] = { months: {} };
      config[r.client].months[r.month] = {
        budgetHrs: Number(r.budget_hrs) || 0,
        strategyUrl: r.strategy_url || '',
        reportUrl: r.report_url || ''
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
  // Safety guard — never wipe on empty payload
  if (Object.keys(body).length === 0) {
    return res.json({ ok: true, message: 'No client config provided, nothing changed.' });
  }
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    // Upsert per row — never wipe first
    const incomingKeys = [];
    for (const [client, data] of Object.entries(body)) {
      const months = data.months || {};
      for (const [month, cfg] of Object.entries(months)) {
        incomingKeys.push(client, month);
        await conn.query(
          `INSERT INTO client_config (client, month, budget_hrs, strategy_url, report_url, notes) VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE budget_hrs = VALUES(budget_hrs),
             strategy_url = IF(VALUES(strategy_url) = '', strategy_url, VALUES(strategy_url)),
             report_url = IF(VALUES(report_url) = '', report_url, VALUES(report_url)),
             notes = VALUES(notes)`,
          [client, month, cfg.budgetHrs || 0, cfg.strategyUrl || '', cfg.reportUrl || '', data.notes || '']
        );
      }
    }
    // NOTE: Global DELETE removed — it wiped rows when localStorage had
    // an incomplete snapshot. Upsert-only is safe; old months are harmless.
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
    const [rows] = await pool.query('SELECT id, task_id, keyword, month, rank_value, volume, client, seo_owner, intake_date, current_rank, target_url, task_title, source, recorded_at FROM historical_keywords ORDER BY recorded_at DESC');
    res.json(rows.map(r => ({
      id: r.id, taskId: r.task_id, keyword: r.keyword,
      month: r.month, rank: r.rank_value, volume: r.volume,
      client: r.client, seoOwner: r.seo_owner || '', date: r.intake_date || '',
      currentRank: r.current_rank || 0, targetUrl: r.target_url || '',
      taskTitle: r.task_title || '', source: r.source || 'historical',
      recordedAt: r.recorded_at
    })));
  } catch (e) {
    console.error('GET /api/historical-keywords error:', e.message);
    res.status(500).json({ error: 'Failed to load keywords' });
  }
});

app.put('/api/historical-keywords', async (req, res) => {
  const data = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: 'Expected array' });
  // Safety guard — never wipe on empty payload
  if (data.length === 0) {
    return res.json({ ok: true, count: 0, message: 'No keywords provided, nothing changed.' });
  }
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    // Collect incoming IDs for scoped delete (remove rows not in payload)
    const kwIds = data.map(kw => kw.id).filter(Boolean);
    if (kwIds.length > 0) {
      const kwPh = kwIds.map(() => '?').join(',');
      await conn.query(`DELETE FROM historical_keywords WHERE id NOT IN (${kwPh})`, kwIds);
    }
    // Upsert existing rows, insert new rows
    for (const kw of data) {
      if (kw.id) {
        await conn.query(
          `INSERT INTO historical_keywords (id, task_id, keyword, month, rank_value, volume, client) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE task_id = VALUES(task_id), keyword = VALUES(keyword), month = VALUES(month), rank_value = VALUES(rank_value), volume = VALUES(volume), client = VALUES(client)`,
          [kw.id, kw.taskId || kw.task_id || null, kw.keyword || '', kw.month || '', kw.rank || kw.rank_value || 0, kw.volume || 0, kw.client || '']
        );
      } else {
        await conn.query(
          'INSERT INTO historical_keywords (task_id, keyword, month, rank_value, volume, client) VALUES (?, ?, ?, ?, ?, ?)',
          [kw.taskId || kw.task_id || null, kw.keyword || '', kw.month || '', kw.rank || kw.rank_value || 0, kw.volume || 0, kw.client || '']
        );
      }
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

// ── API: Add single historical keyword ─────
app.post('/api/historical-keywords/add', async (req, res) => {
  const kw = req.body;
  if (!kw || !kw.focusedKw) return res.status(400).json({ error: 'Missing keyword data' });
  try {
    const [result] = await pool.query(
      `INSERT INTO historical_keywords (keyword, volume, rank_value, client, seo_owner, intake_date, current_rank, target_url, task_title, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [kw.focusedKw || '', kw.volume || 0, kw.marRank || 0, kw.client || '', kw.seoOwner || '', kw.date || '', kw.currentRank || 0, kw.targetUrl || '', kw.taskTitle || '', kw.source || 'historical']
    );
    res.json({ ok: true, id: result.insertId });
  } catch (e) {
    console.error('POST /api/historical-keywords/add error:', e.message);
    res.status(500).json({ error: 'Failed to add keyword' });
  }
});

// ── API: Update single historical keyword ─────
app.patch('/api/historical-keywords/:id', async (req, res) => {
  const { id } = req.params;
  const kw = req.body;
  if (!kw) return res.status(400).json({ error: 'Missing keyword data' });
  try {
    await pool.query(
      `UPDATE historical_keywords SET keyword=?, volume=?, rank_value=?, client=?, seo_owner=?, intake_date=?, current_rank=?, target_url=?, task_title=? WHERE id=?`,
      [kw.focusedKw || '', kw.volume || 0, kw.marRank || 0, kw.client || '', kw.seoOwner || '', kw.date || '', kw.currentRank || 0, kw.targetUrl || '', kw.taskTitle || '', id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('PATCH /api/historical-keywords error:', e.message);
    res.status(500).json({ error: 'Failed to update keyword' });
  }
});

// ── API: Delete single historical keyword ─────
app.delete('/api/historical-keywords/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM historical_keywords WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/historical-keywords error:', e.message);
    res.status(500).json({ error: 'Failed to delete keyword' });
  }
});

// ── API: Keyword CSV Upload (bulk insert into DB) ─────
app.post('/api/keywords/upload-csv', express.text({ type: 'text/csv', limit: '5mb' }), async (req, res) => {
  try {
    const raw = typeof req.body === 'string' ? req.body : '';
    if (!raw.trim()) return res.status(400).json({ error: 'Empty CSV body' });

    // Parse CSV rows — handle quoted fields
    const lines = raw.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return res.status(400).json({ error: 'CSV must have a header row and at least one data row' });

    // Parse a single CSV line respecting quotes
    function parseCsvLine(line) {
      const cols = [];
      let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { inQ = !inQ; continue; }
        if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; continue; }
        cur += ch;
      }
      cols.push(cur.trim());
      return cols;
    }

    const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9 _]/g, '').trim());

    // Flexible column detection
    const find = (...candidates) => {
      for (const c of candidates) {
        const idx = headers.findIndex(h => h.includes(c));
        if (idx >= 0) return idx;
      }
      return -1;
    };

    const ci = {
      date:       find('date', 'intake'),
      client:     find('client'),
      seoOwner:   find('seo owner', 'owner'),
      task:       find('task', 'title'),
      keyword:    find('keyword', 'kw', 'focused'),
      volume:     find('volume', 'vol'),
      monthlyRank:find('monthly rank', 'monthly', 'mar_rank', 'marrank'),
      curRank:    find('cur rank', 'current rank', 'cur_rank', 'currank'),
      targetUrl:  find('target url', 'url', 'target'),
      source:     find('source'),
    };

    if (ci.keyword < 0) return res.status(400).json({ error: 'CSV must have a "Keyword" column' });

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      const kw = ci.keyword >= 0 ? cols[ci.keyword] : '';
      if (!kw) continue; // skip empty keyword rows

      rows.push({
        intake_date:  ci.date >= 0 ? cols[ci.date] || '' : '',
        client:       ci.client >= 0 ? cols[ci.client] || '' : '',
        seo_owner:    ci.seoOwner >= 0 ? cols[ci.seoOwner] || '' : '',
        task_title:   ci.task >= 0 ? cols[ci.task] || '' : '',
        keyword:      kw,
        volume:       ci.volume >= 0 ? parseInt(String(cols[ci.volume]).replace(/[^0-9]/g, ''), 10) || 0 : 0,
        rank_value:   ci.monthlyRank >= 0 ? parseInt(cols[ci.monthlyRank], 10) || 0 : 0,
        current_rank: ci.curRank >= 0 ? parseInt(cols[ci.curRank], 10) || 0 : 0,
        target_url:   ci.targetUrl >= 0 ? cols[ci.targetUrl] || '' : '',
        source:       ci.source >= 0 ? cols[ci.source] || 'upload' : 'upload',
      });
    }

    if (rows.length === 0) return res.status(400).json({ error: 'No valid keyword rows found in CSV' });

    let conn;
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();

      const sql = `INSERT INTO historical_keywords
        (keyword, client, seo_owner, intake_date, task_title, volume, rank_value, current_rank, target_url, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

      for (const r of rows) {
        await conn.query(sql, [
          r.keyword, r.client, r.seo_owner, r.intake_date,
          r.task_title, r.volume, r.rank_value, r.current_rank,
          r.target_url, r.source
        ]);
      }

      await conn.commit();
      res.json({ ok: true, count: rows.length, message: `${rows.length} keyword(s) uploaded successfully` });
    } catch (dbErr) {
      if (conn) await conn.rollback().catch(() => {});
      throw dbErr;
    } finally {
      if (conn) conn.release();
    }
  } catch (e) {
    console.error('POST /api/keywords/upload-csv error:', e.message);
    res.status(500).json({ error: 'Failed to upload keywords' });
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
  // Safety guard — never wipe on empty payload
  if (data.length === 0) {
    return res.json({ ok: true, count: 0, message: 'No leave records provided, nothing changed.' });
  }
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    // Assign IDs to new records, collect all IDs for scoped delete
    const leaveRows = data.map(r => ({ ...r, _id: r.id || ('lv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)) }));
    const leaveIds = leaveRows.map(r => r._id);
    const lvPh = leaveIds.map(() => '?').join(',');
    await conn.query(`DELETE FROM leave_records WHERE id NOT IN (${lvPh})`, leaveIds);
    // Upsert per row — never wipe first
    for (const r of leaveRows) {
      await conn.query(
        `INSERT INTO leave_records (id, user_name, user_role, leave_date, leave_type, reason, status) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE user_name = VALUES(user_name), user_role = VALUES(user_role), leave_date = VALUES(leave_date), leave_type = VALUES(leave_type), reason = VALUES(reason), status = VALUES(status)`,
        [r._id, r.userName || r.user_name || '', r.userRole || r.user_role || '', r.leaveDate || r.leave_date || new Date().toISOString().slice(0, 10), r.leaveType || r.leave_type || 'full', r.reason || '', r.status || 'approved']
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

// ── API: Leave Records — individual add/delete (DB-safe) ─────────────────────
// POST /api/leave-records — add a single record safely
app.post('/api/leave-records', async (req, res) => {
  try {
    const r = req.body || {};
    const id = r.id || ('lv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
    const userName = r.owner || r.userName || r.user_name || '';
    const leaveDate = r.date || r.leaveDate || r.leave_date || '';
    const leaveType = r.type || r.leaveType || r.leave_type || 'full';
    const reason = r.note || r.reason || '';
    const userRole = r.userRole || r.user_role || '';
    if (!leaveDate) return res.status(400).json({ error: 'date is required' });
    await pool.query(
      `INSERT INTO leave_records (id, user_name, user_role, leave_date, leave_type, reason, status)
       VALUES (?, ?, ?, ?, ?, ?, 'approved')
       ON DUPLICATE KEY UPDATE user_name=VALUES(user_name), user_role=VALUES(user_role),
         leave_date=VALUES(leave_date), leave_type=VALUES(leave_type), reason=VALUES(reason)`,
      [id, userName, userRole, leaveDate, leaveType, reason]
    );
    console.log(`POST /api/leave-records: added ${id} (${userName} / ${leaveDate})`);
    res.json({ ok: true, id, message: 'Leave record saved' });
  } catch (e) {
    console.error('POST /api/leave-records error:', e.message);
    res.status(500).json({ error: 'Failed to save leave record' });
  }
});

// DELETE /api/leave-records/:id — remove a single record safely
app.delete('/api/leave-records/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const [result] = await pool.query('DELETE FROM leave_records WHERE id = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: `Record "${id}" not found` });
    console.log(`DELETE /api/leave-records/${id}: removed`);
    res.json({ ok: true, message: `Leave record "${id}" deleted` });
  } catch (e) {
    console.error('DELETE /api/leave-records/:id error:', e.message);
    res.status(500).json({ error: 'Failed to delete leave record' });
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
  // Safety guard — never wipe on empty payload
  if (data.length === 0) {
    return res.json({ ok: true, count: 0, message: 'No remarks provided, nothing changed.' });
  }
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    // Assign IDs to new records, collect all IDs for scoped delete
    const remarkRows = data.map(r => ({ ...r, _id: r.id || ('rm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)) }));
    const remarkIds = remarkRows.map(r => r._id);
    const rmPh = remarkIds.map(() => '?').join(',');
    await conn.query(`DELETE FROM workhub_remarks WHERE id NOT IN (${rmPh})`, remarkIds);
    // Upsert per row — never wipe first
    for (const r of remarkRows) {
      await conn.query(
        `INSERT INTO workhub_remarks (id, task_id, user_name, user_role, remark) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE task_id = VALUES(task_id), user_name = VALUES(user_name), user_role = VALUES(user_role), remark = VALUES(remark)`,
        [r._id, r.taskId || r.task_id || '', r.userName || r.user_name || '', r.userRole || r.user_role || '', r.remark || '']
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
    const savedIds = [];
    for (const e of events) {
      const id = e.id || ('evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
      await pool.query(
        `INSERT INTO audit_logs (id, month, timestamp, user_name, user_role, action, task_id, task_title, client, source, field, old_value, new_value, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, month, e.timestamp || null, e.userName || null, e.userRole || null, e.action || null,
         e.taskId || null, e.taskTitle || null, e.client || null, e.source || null,
         e.field || null, e.oldValue || null, e.newValue || null, e.note || null]
      );
      savedIds.push(id);
    }

    // ── DB verification: confirm all audit events are persisted ──
    const ph = savedIds.map(() => '?').join(',');
    const [verifyRows] = await pool.query(
      `SELECT COUNT(*) AS count FROM audit_logs WHERE id IN (${ph})`, savedIds
    );
    const verifiedCount = Number(verifyRows[0].count) || 0;
    const dbVerified = verifiedCount === savedIds.length;

    res.json({
      ok: true,
      count: events.length,
      dbVerified,
      verifiedCount,
      message: dbVerified
        ? `${events.length} audit event(s) logged and verified in DB`
        : `${events.length} event(s) logged — DB verified ${verifiedCount} of ${savedIds.length}`,
    });
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

// ── API 404 + global error handler ────────────────────
// apiNotFound catches requests to unknown /api/* routes before the SPA
// fallback swallows them. globalErrorHandler catches anything thrown from
// a new-style controller. Legacy inline routes still handle their own
// errors with their own try/catch blocks, so adding these is non-breaking.
app.use(apiNotFound);
app.use(globalErrorHandler);

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
  if (process.env.SKIP_DB_INIT === '1') {
    console.log('DB init skipped (SKIP_DB_INIT=1)');
    return;
  }
  (async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // Use pool.query (not pool.execute) for DDL — more compatible
        const tables = [
          'tasks', 'task_time_events', 'task_qc_reviews', 'task_rework_entries',
          'app_config', 'users', 'audit_logs', 'sessions',
          'client_config', 'historical_keywords', 'leave_records', 'workhub_remarks', 'clients'
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
