/**
 * activityLog.service.js — Server-side activity log.
 *
 * WHY
 * ───
 * audit_logs is written by the browser, so when a stale tab or old bundle
 * silently overwrites tasks, nothing is logged — exactly when it matters.
 * This log is written by the server for every mutating API request, whatever
 * browser, machine or bundle version sent it.
 *
 * Each row records: when, who (X-User header), which tab (X-Tab-Id), how old
 * that tab's code is (X-App-Loaded / X-App-Bundle), IP, user agent, the
 * endpoint and HTTP status, and — for task writes — the exact field changes
 * (from → to). Headers are attached by scripts/patch-activity-headers.js.
 *
 * NOTE: there is no server-side auth yet, so X-User is self-reported by the
 * browser. Good enough for debugging; not proof of identity.
 *
 * Exports:
 *   activityLogger           — Express middleware, mount on /api
 *   recordActivity(res, e)   — route handlers add task-level entries
 *   clientMeta(req)          — who/tab/ip of a request
 *   archiveDeletedTask(...)  — full copy of a task before it is deleted
 *   logSystemActivity(...)   — rows for server-initiated actions
 *   pruneActivity(pool)      — retention cleanup
 *
 * Retention (env):
 *   ACTIVITY_LOG_RETENTION_HOURS   default 168 (7 days)
 *   DELETED_TASK_RETENTION_DAYS    default 30
 */

import pool from '../config/db.js';

const RETENTION_HOURS = Number(process.env.ACTIVITY_LOG_RETENTION_HOURS) || 168;
const DELETED_RETENTION_DAYS = Number(process.env.DELETED_TASK_RETENTION_DAYS) || 30;

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_DETAILS_CHARS = 4000;

function cut(v, n) {
  const s = v === null || v === undefined ? '' : String(v);
  return s.length > n ? s.slice(0, n) : s;
}

function decodeHeader(v) {
  if (!v) return '';
  try { return decodeURIComponent(String(v)); } catch { return String(v); }
}

/** Who / where a request came from. */
export function clientMeta(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return {
    user:      cut(decodeHeader(req.headers['x-user']), 255),
    tabId:     cut(req.headers['x-tab-id'], 64),
    appLoaded: cut(req.headers['x-app-loaded'], 50),
    appBundle: cut(req.headers['x-app-bundle'], 255),
    ip:        cut(fwd || req.socket?.remoteAddress || '', 64),
    userAgent: cut(req.headers['user-agent'], 500),
  };
}

/** Deep copy with anything password-like masked. */
function redact(v, depth = 0) {
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 50).map(x => redact(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = /pass|secret|token/i.test(k) ? '[redacted]' : redact(val, depth + 1);
  }
  return out;
}

function jsonOrEmpty(v) {
  if (v === undefined || v === null) return null;
  try { return cut(JSON.stringify(v), MAX_DETAILS_CHARS); } catch { return null; }
}

/**
 * Add a task-level entry to this request's log. Call from route handlers.
 * entry: { action, taskId, changes: [{field, from, to}], details: {...} }
 */
export function recordActivity(res, entry) {
  if (!res.locals.activity) res.locals.activity = [];
  res.locals.activity.push(entry);
}

async function insertRows(rows) {
  if (!rows.length) return;
  const cols = ['method', 'path', 'status', 'duration_ms', 'user_name', 'tab_id',
    'app_loaded_at', 'app_bundle', 'ip', 'user_agent', 'action', 'task_id',
    'changes', 'details'];
  const ph = rows.map(() => `(${cols.map(() => '?').join(',')})`).join(',');
  await pool.query(
    `INSERT INTO activity_log (${cols.join(',')}) VALUES ${ph}`,
    rows.flatMap(r => cols.map(c => r[c] ?? ''))
  );
}

/**
 * Express middleware: one log row per task-level entry recorded by the route,
 * or one generic row for any other write. Written after the response is sent,
 * so it never slows a request down; a logging failure is only printed.
 */
export function activityLogger(req, res, next) {
  if (!WRITE_METHODS.has(req.method)) return next();
  const started = Date.now();

  res.on('finish', () => {
    const meta = clientMeta(req);
    const path = cut(req.originalUrl, 500);
    const base = {
      method: req.method, path, status: res.statusCode,
      duration_ms: Date.now() - started,
      user_name: meta.user, tab_id: meta.tabId,
      app_loaded_at: meta.appLoaded, app_bundle: meta.appBundle,
      ip: meta.ip, user_agent: meta.userAgent,
    };

    const entries = res.locals.activity || [];
    let rows;
    if (entries.length) {
      rows = entries.map(e => ({
        ...base,
        action:  cut(e.action, 100),
        task_id: cut(e.taskId, 255),
        changes: e.changes && e.changes.length ? jsonOrEmpty(e.changes) : null,
        details: jsonOrEmpty(e.details),
      }));
    } else {
      // Generic write. Task routes record their own entries (with diffs), so
      // their raw bodies — often huge timeEvents arrays — are not stored.
      const isTask = req.originalUrl.startsWith('/api/tasks');
      rows = [{
        ...base,
        action: `${req.method} ${req.baseUrl || ''}`.trim(),
        task_id: '',
        changes: null,
        details: isTask ? null : jsonOrEmpty(redact(req.body)),
      }];
    }

    insertRows(rows).catch(err =>
      console.error('[activityLog] insert failed:', err.message)
    );
  });

  next();
}

/** Rows for things the server does on its own (startup, cleanup, timers). */
export async function logSystemActivity(action, details) {
  try {
    await insertRows([{
      method: 'SYSTEM', path: '', status: 0, duration_ms: 0,
      user_name: 'system', action: cut(action, 100), task_id: '',
      changes: null, details: jsonOrEmpty(details),
    }]);
  } catch (err) {
    console.error('[activityLog] system log failed:', err.message);
  }
}

/**
 * Save a full copy of a task (row + child tables) before it is deleted.
 * Runs on the caller's connection so it is part of the delete transaction:
 * if the archive fails, the delete is rolled back.
 * @returns {Promise<object|null>} the archived task row, or null if absent
 */
export async function archiveDeletedTask(conn, taskId, meta) {
  const [rows] = await conn.query('SELECT * FROM tasks WHERE id = ? LIMIT 1', [taskId]);
  if (!rows.length) return null;
  const [timeEvents]    = await conn.query('SELECT * FROM task_time_events WHERE task_id = ?', [taskId]);
  const [qcReviews]     = await conn.query('SELECT * FROM task_qc_reviews WHERE task_id = ?', [taskId]);
  const [reworkEntries] = await conn.query('SELECT * FROM task_rework_entries WHERE task_id = ?', [taskId]);

  const task = rows[0];
  await conn.query(
    `INSERT INTO deleted_tasks (task_id, title, client, deleted_by, tab_id, ip, snapshot)
     VALUES (?,?,?,?,?,?,?)`,
    [taskId, cut(task.title, 500), cut(task.client, 255), meta.user, meta.tabId, meta.ip,
     JSON.stringify({ task, timeEvents, qcReviews, reworkEntries })]
  );
  return task;
}

/** Delete log rows / archived tasks past their retention. */
export async function pruneActivity(dbPool = pool) {
  try {
    const [a] = await dbPool.query(
      'DELETE FROM activity_log WHERE created_at < NOW() - INTERVAL ? HOUR',
      [RETENTION_HOURS]
    );
    const [d] = await dbPool.query(
      'DELETE FROM deleted_tasks WHERE deleted_at < NOW() - INTERVAL ? DAY',
      [DELETED_RETENTION_DAYS]
    );
    if (a.affectedRows || d.affectedRows) {
      await logSystemActivity('system_prune', {
        activityRowsDeleted: a.affectedRows, deletedTasksPurged: d.affectedRows,
        retentionHours: RETENTION_HOURS, deletedRetentionDays: DELETED_RETENTION_DAYS,
      });
    }
  } catch (err) {
    console.error('[activityLog] prune failed:', err.message);
  }
}
