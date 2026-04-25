/**
 * init.js — Creates all required tables and runs idempotent migrations.
 *
 * Extracted verbatim from server.js. Schema and migration list are unchanged.
 *
 * initDb(pool) returns { ok, fail } so callers can log the outcome. Throws
 * only when at least one CREATE TABLE failed, preserving the previous
 * behavior where initDb at boot-time would abort on schema failure.
 *
 * ensureTables(pool) is the lighter-weight variant exposed to /api/db-init,
 * which only returns a per-table status map without throwing.
 */

const TABLE_DDL = [
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

const MIGRATIONS = [
  // Allow ON DUPLICATE KEY UPDATE on qcReviews by (task_id, review_id)
  ['qc_reviews_unique', `ALTER TABLE task_qc_reviews ADD UNIQUE KEY uq_tqr_task_review (task_id, review_id)`],
  // Allow ON DUPLICATE KEY UPDATE on reworkEntries by (task_id, rework_id)
  ['rework_entries_unique', `ALTER TABLE task_rework_entries ADD UNIQUE KEY uq_tre_task_rework (task_id, rework_id)`],
  // Add new columns to historical_keywords for full keyword data
  ['hk_add_seo_owner', `ALTER TABLE historical_keywords ADD COLUMN seo_owner VARCHAR(255) DEFAULT ''`],
  ['hk_add_intake_date', `ALTER TABLE historical_keywords ADD COLUMN intake_date VARCHAR(50) DEFAULT ''`],
  ['hk_add_current_rank', `ALTER TABLE historical_keywords ADD COLUMN current_rank INT DEFAULT 0`],
  ['hk_add_target_url', `ALTER TABLE historical_keywords ADD COLUMN target_url TEXT`],
  ['hk_add_task_title', `ALTER TABLE historical_keywords ADD COLUMN task_title VARCHAR(500) DEFAULT ''`],
  ['hk_add_source', `ALTER TABLE historical_keywords ADD COLUMN source VARCHAR(50) DEFAULT 'upload'`],
];

export const EXPECTED_TABLES = TABLE_DDL.map(([name]) => name);

/**
 * Full init: create tables + run idempotent migrations.
 * Throws if any CREATE TABLE failed (preserves old behavior).
 */
export async function initDb(pool) {
  let ok = 0;
  let fail = 0;
  for (const [name, sql] of TABLE_DDL) {
    try {
      await pool.query(sql);
      ok++;
    } catch (e) {
      fail++;
      console.error(`  CREATE ${name} FAILED:`, e.code, e.message);
    }
  }
  console.log(`initDb: ${ok} tables OK, ${fail} failed`);

  // Idempotent schema migrations — safe to run on every startup.
  // Existing-constraint / existing-column errors are expected and ignored.
  for (const [name, sql] of MIGRATIONS) {
    try {
      await pool.query(sql);
      console.log(`  migration [${name}]: applied`);
    } catch (e) {
      // 1061 = Duplicate key name (constraint already exists)
      // 1060 = Duplicate column name
      if (
        e.errno === 1061 ||
        e.errno === 1060 ||
        (e.message &&
          (e.message.includes('Duplicate key name') ||
            e.message.includes('Duplicate column name')))
      ) {
        console.log(`  migration [${name}]: already applied (skipped)`);
      } else {
        console.error(`  migration [${name}] FAILED:`, e.code, e.message);
      }
    }
  }

  if (fail > 0) throw new Error(`${fail} tables failed to create`);
  return { ok, fail };
}

/**
 * Lightweight variant for /api/db-init — per-table status map, never throws.
 */
export async function ensureTables(pool) {
  const results = {};
  for (const [name, sql] of TABLE_DDL) {
    try {
      await pool.query(sql);
      results[name] = 'OK';
    } catch (e) {
      results[name] = `FAILED: ${e.code || ''} ${e.message}`;
    }
  }
  return results;
}
