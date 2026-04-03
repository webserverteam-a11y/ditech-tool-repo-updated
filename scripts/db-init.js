import pool from '../config/db.js';

async function initDatabase() {
  console.log('Initializing database tables...\n');

  const tables = [
    {
      name: 'tasks',
      sql: `CREATE TABLE IF NOT EXISTS tasks (
        id VARCHAR(255) PRIMARY KEY,
        title VARCHAR(500) DEFAULT '',
        client VARCHAR(255) DEFAULT '',
        seo_owner VARCHAR(255) DEFAULT '',
        seo_stage VARCHAR(255) DEFAULT '',
        seo_qc_status VARCHAR(100) DEFAULT '',
        focused_kw VARCHAR(500) DEFAULT '',
        volume INT DEFAULT 0,
        mar_rank INT DEFAULT 0,
        current_rank INT DEFAULT 0,
        est_hours DECIMAL(10,2) DEFAULT 0,
        est_hours_seo DECIMAL(10,2) DEFAULT 0,
        est_hours_content DECIMAL(10,2) DEFAULT 0,
        est_hours_web DECIMAL(10,2) DEFAULT 0,
        est_hours_content_rework DECIMAL(10,2) DEFAULT 0,
        est_hours_seo_review DECIMAL(10,2) DEFAULT 0,
        actual_hours DECIMAL(10,2) DEFAULT 0,
        content_assigned_date VARCHAR(50) DEFAULT '',
        content_owner VARCHAR(255) DEFAULT '',
        content_status VARCHAR(100) DEFAULT '',
        web_assigned_date VARCHAR(50) DEFAULT '',
        web_owner VARCHAR(255) DEFAULT '',
        target_url TEXT,
        web_status VARCHAR(100) DEFAULT '',
        current_owner VARCHAR(255) DEFAULT '',
        days_in_stage INT DEFAULT 0,
        remarks TEXT,
        is_completed TINYINT(1) DEFAULT 0,
        execution_state VARCHAR(100) DEFAULT 'Not Started',
        doc_url TEXT,
        intake_date VARCHAR(50) DEFAULT '',
        dept_type VARCHAR(100) DEFAULT '',
        task_type VARCHAR(100) DEFAULT '',
        platform VARCHAR(100) DEFAULT '',
        deliverable_url TEXT,
        due_date VARCHAR(50) DEFAULT '',
        assigned_to VARCHAR(255) DEFAULT '',
        ad_budget DECIMAL(10,2) DEFAULT 0,
        qc_submitted_at VARCHAR(50) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_tasks_client (client),
        INDEX idx_tasks_seo_owner (seo_owner),
        INDEX idx_tasks_intake_date (intake_date),
        INDEX idx_tasks_is_completed (is_completed)
      )`
    },
    {
      name: 'task_time_events',
      sql: `CREATE TABLE IF NOT EXISTS task_time_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        task_id VARCHAR(255) NOT NULL,
        event_type VARCHAR(50) NOT NULL DEFAULT '',
        timestamp VARCHAR(50) DEFAULT '',
        department VARCHAR(100) DEFAULT '',
        owner VARCHAR(255) DEFAULT '',
        INDEX idx_tte_task (task_id),
        CONSTRAINT fk_tte_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )`
    },
    {
      name: 'task_qc_reviews',
      sql: `CREATE TABLE IF NOT EXISTS task_qc_reviews (
        id INT AUTO_INCREMENT PRIMARY KEY,
        task_id VARCHAR(255) NOT NULL,
        review_id VARCHAR(255) NOT NULL DEFAULT '',
        submitted_by VARCHAR(255) DEFAULT '',
        submitted_by_dept VARCHAR(100) DEFAULT '',
        submitted_at VARCHAR(50) DEFAULT '',
        assigned_to VARCHAR(255) DEFAULT '',
        est_hours DECIMAL(10,2) DEFAULT 0,
        note TEXT,
        outcome VARCHAR(100) DEFAULT '',
        completed_at VARCHAR(50) DEFAULT '',
        INDEX idx_tqr_task (task_id),
        CONSTRAINT fk_tqr_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )`
    },
    {
      name: 'task_rework_entries',
      sql: `CREATE TABLE IF NOT EXISTS task_rework_entries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        task_id VARCHAR(255) NOT NULL,
        rework_id VARCHAR(255) NOT NULL DEFAULT '',
        date VARCHAR(50) DEFAULT '',
        est_hours DECIMAL(10,2) DEFAULT 0,
        assigned_dept VARCHAR(100) DEFAULT '',
        assigned_owner VARCHAR(255) DEFAULT '',
        within_estimate TINYINT(1) DEFAULT 0,
        hours_already_spent DECIMAL(10,2) DEFAULT 0,
        start_timestamp VARCHAR(50) DEFAULT '',
        end_timestamp VARCHAR(50) DEFAULT '',
        duration_ms BIGINT DEFAULT 0,
        INDEX idx_tre_task (task_id),
        CONSTRAINT fk_tre_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      )`
    },
    {
      name: 'app_config',
      sql: `CREATE TABLE IF NOT EXISTS app_config (
        \`key\` VARCHAR(255) PRIMARY KEY,
        value JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`
    },
    {
      name: 'users',
      sql: `CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'seo',
        ownerName VARCHAR(255) DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`
    },
    {
      name: 'audit_logs',
      sql: `CREATE TABLE IF NOT EXISTS audit_logs (
        id VARCHAR(100) PRIMARY KEY,
        month VARCHAR(7) NOT NULL,
        timestamp VARCHAR(50),
        user_name VARCHAR(255),
        user_role VARCHAR(100),
        action VARCHAR(255),
        task_id VARCHAR(255),
        task_title VARCHAR(500),
        client VARCHAR(255),
        source VARCHAR(255),
        field VARCHAR(255),
        old_value TEXT,
        new_value TEXT,
        note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_month (month),
        INDEX idx_task_id (task_id)
      )`
    },
    {
      name: 'sessions',
      sql: `CREATE TABLE IF NOT EXISTS sessions (
        token VARCHAR(64) PRIMARY KEY,
        expires_at BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`
    },
    {
      name: 'client_config',
      sql: `CREATE TABLE IF NOT EXISTS client_config (
        client VARCHAR(255) NOT NULL,
        month VARCHAR(7) NOT NULL,
        budget_hrs DECIMAL(10,2) DEFAULT 0,
        strategy_url TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (client, month)
      )`
    },
    {
      name: 'historical_keywords',
      sql: `CREATE TABLE IF NOT EXISTS historical_keywords (
        id INT AUTO_INCREMENT PRIMARY KEY,
        task_id VARCHAR(255),
        keyword VARCHAR(500),
        month VARCHAR(7),
        rank_value INT DEFAULT 0,
        volume INT DEFAULT 0,
        client VARCHAR(255),
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_kw_month (month),
        INDEX idx_kw_task (task_id)
      )`
    },
    {
      name: 'leave_records',
      sql: `CREATE TABLE IF NOT EXISTS leave_records (
        id VARCHAR(255) PRIMARY KEY,
        user_name VARCHAR(255) NOT NULL,
        user_role VARCHAR(100),
        leave_date DATE NOT NULL,
        leave_type VARCHAR(100) DEFAULT 'full',
        reason TEXT DEFAULT '',
        status VARCHAR(50) DEFAULT 'approved',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_leave_user (user_name),
        INDEX idx_leave_date (leave_date)
      )`
    },
    {
      name: 'workhub_remarks',
      sql: `CREATE TABLE IF NOT EXISTS workhub_remarks (
        id VARCHAR(255) PRIMARY KEY,
        task_id VARCHAR(255),
        user_name VARCHAR(255),
        user_role VARCHAR(100),
        remark TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_remark_task (task_id),
        INDEX idx_remark_user (user_name)
      )`
    }
  ];

  for (const table of tables) {
    try {
      await pool.query(table.sql);
      console.log(`  ✓ Table "${table.name}" — ready`);
    } catch (e) {
      console.error(`  ✗ Table "${table.name}" — FAILED: ${e.message}`);
    }
  }

  // Verify tables exist
  console.log('\nVerifying tables...');
  const [rows] = await pool.query('SHOW TABLES');
  const tableNames = rows.map(r => Object.values(r)[0]);
  console.log('  Tables in database:', tableNames.join(', '));

  console.log('\nDatabase initialization complete.');
  process.exit(0);
}

initDatabase().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
