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
    const expected = ['tasks','task_time_events','task_qc_reviews','task_rework_entries','app_config','users','audit_logs','sessions','client_config','historical_keywords','leave_records','workhub_remarks'];
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
  // child tables — delete + re-insert
  await conn.query('DELETE FROM task_time_events WHERE task_id = ?', [task.id]);
  await conn.query('DELETE FROM task_qc_reviews WHERE task_id = ?', [task.id]);
  await conn.query('DELETE FROM task_rework_entries WHERE task_id = ?', [task.id]);

  if (Array.isArray(task.timeEvents)) {
    for (const ev of task.timeEvents) {
      await conn.query(
        'INSERT INTO task_time_events (task_id, event_type, timestamp, department, owner) VALUES (?,?,?,?,?)',
        [task.id, ev.type || '', ev.timestamp || '', ev.department || '', ev.owner || '']
      );
    }
  }
  if (Array.isArray(task.qcReviews)) {
    for (const qc of task.qcReviews) {
      await conn.query(
        'INSERT INTO task_qc_reviews (task_id, review_id, submitted_by, submitted_by_dept, submitted_at, assigned_to, est_hours, note, outcome, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [task.id, qc.id || '', qc.submittedBy || '', qc.submittedByDept || '', qc.submittedAt || '', qc.assignedTo || '', qc.estHours || 0, qc.note || '', qc.outcome || '', qc.completedAt || '']
      );
    }
  }
  if (Array.isArray(task.reworkEntries)) {
    for (const rw of task.reworkEntries) {
      await conn.query(
        'INSERT INTO task_rework_entries (task_id, rework_id, date, est_hours, assigned_dept, assigned_owner, within_estimate, hours_already_spent, start_timestamp, end_timestamp, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [task.id, rw.id || '', rw.date || '', rw.estHours || 0, rw.assignedDept || '', rw.assignedOwner || '', rw.withinEstimate ? 1 : 0, rw.hoursAlreadySpent || 0, rw.startTimestamp || '', rw.endTimestamp || '', rw.durationMs || 0]
      );
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
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    // Collect incoming IDs -> delete tasks NOT in the incoming set
    const ids = tasks.map(t => t.id).filter(Boolean);
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(',');
      await conn.query(`DELETE FROM tasks WHERE id NOT IN (${ph})`, ids);
    } else {
      // All tasks have null/empty IDs — refuse to wipe
      await conn.rollback();
      return res.status(400).json({ error: 'No valid task IDs in payload, aborting to prevent data loss.' });
    }
    for (const t of tasks) {
      await saveTaskToDb(conn, t);
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
    res.json({ ok: true });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('PUT /api/tasks/:id error:', e.message);
    res.status(500).json({ error: 'Failed to save task' });
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
          `INSERT INTO client_config (client, month, budget_hrs, strategy_url, notes) VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE budget_hrs = VALUES(budget_hrs), strategy_url = VALUES(strategy_url), notes = VALUES(notes)`,
          [client, month, cfg.budgetHrs || 0, cfg.strategyUrl || '', data.notes || '']
        );
      }
    }
    // Remove entries no longer in the payload (scoped delete)
    if (incomingKeys.length > 0) {
      const pairs = [];
      for (let i = 0; i < incomingKeys.length; i += 2) pairs.push('(?, ?)');
      await conn.query(`DELETE FROM client_config WHERE (client, month) NOT IN (${pairs.join(',')})`, incomingKeys);
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
          'tasks', 'task_time_events', 'task_qc_reviews', 'task_rework_entries',
          'app_config', 'users', 'audit_logs', 'sessions',
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
