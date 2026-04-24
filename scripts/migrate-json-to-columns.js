/**
 * PRODUCTION MIGRATION SCRIPT
 * ────────────────────────────
 * Migrates the `tasks` table from a single JSON `data` column
 * to proper individual columns, and extracts nested arrays
 * (timeEvents, qcReviews, reworkEntries) into child tables.
 *
 * SAFE TO RUN MULTIPLE TIMES (idempotent).
 * Run this BEFORE deploying the updated server.js.
 *
 * Usage:
 *   node scripts/migrate-json-to-columns.js
 */
import 'dotenv/config';
import pool from '../config/db.js';

async function migrate() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  TASK MIGRATION: JSON blob → proper columns');
  console.log('═══════════════════════════════════════════════════\n');

  let conn;
  try {
    conn = await pool.getConnection();

    // ── Step 1: Check if migration is needed ────────────
    const [cols] = await conn.query(`SHOW COLUMNS FROM tasks`);
    const colNames = cols.map(c => c.Field);
    const hasDataCol = colNames.includes('data');
    const hasTitleCol = colNames.includes('title');

    if (!hasDataCol && hasTitleCol) {
      console.log('✓ Migration already completed (no `data` column, `title` column exists).');
      console.log('  Nothing to do.\n');
      return;
    }

    if (!hasDataCol && !hasTitleCol) {
      console.error('✗ Unexpected schema: no `data` and no `title` column. Aborting.');
      process.exit(1);
    }

    // ── Step 2: Read all existing JSON data ─────────────
    console.log('Step 1/6: Reading existing task data...');
    const [taskRows] = await conn.query('SELECT id, data FROM tasks');
    console.log(`  Found ${taskRows.length} tasks to migrate.\n`);

    const tasks = taskRows.map(r => {
      const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      d.id = r.id; // ensure id is set
      return d;
    });

    // ── Step 3: Add new columns to tasks table ──────────
    console.log('Step 2/6: Adding columns to tasks table...');
    const newColumns = [
      ['title', 'VARCHAR(500) DEFAULT \'\''],
      ['client', 'VARCHAR(255) DEFAULT \'\''],
      ['intake_date', 'DATE NULL'],
      ['seo_owner', 'VARCHAR(255) DEFAULT \'\''],
      ['seo_stage', 'VARCHAR(100) DEFAULT \'\''],
      ['seo_qc_status', 'VARCHAR(100) DEFAULT \'\''],
      ['focused_kw', 'VARCHAR(500) DEFAULT \'\''],
      ['volume', 'INT DEFAULT 0'],
      ['mar_rank', 'INT DEFAULT 0'],
      ['current_rank', 'INT DEFAULT 0'],
      ['est_hours', 'DECIMAL(10,2) DEFAULT 0'],
      ['est_hours_seo', 'DECIMAL(10,2) DEFAULT 0'],
      ['est_hours_content', 'DECIMAL(10,2) DEFAULT 0'],
      ['est_hours_web', 'DECIMAL(10,2) DEFAULT 0'],
      ['actual_hours', 'DECIMAL(10,2) DEFAULT 0'],
      ['content_assigned_date', 'DATE NULL'],
      ['content_owner', 'VARCHAR(255) DEFAULT \'\''],
      ['content_status', 'VARCHAR(100) DEFAULT \'\''],
      ['web_assigned_date', 'DATE NULL'],
      ['web_owner', 'VARCHAR(255) DEFAULT \'\''],
      ['target_url', 'TEXT'],
      ['web_status', 'VARCHAR(100) DEFAULT \'\''],
      ['current_owner', 'VARCHAR(255) DEFAULT \'\''],
      ['days_in_stage', 'INT DEFAULT 0'],
      ['remarks', 'TEXT'],
      ['is_completed', 'TINYINT(1) DEFAULT 0'],
      ['execution_state', 'VARCHAR(100) DEFAULT \'\''],
      ['doc_url', 'TEXT'],
      ['dept_type', 'VARCHAR(100) DEFAULT \'\''],
      ['task_type', 'VARCHAR(100) DEFAULT \'\''],
      ['platform', 'VARCHAR(100) DEFAULT \'\''],
      ['deliverable_url', 'TEXT'],
      ['due_date', 'DATE NULL'],
      ['assigned_to', 'VARCHAR(255) DEFAULT \'\''],
      ['ad_budget', 'DECIMAL(10,2) DEFAULT 0'],
      ['est_hours_seo_review', 'DECIMAL(10,2) DEFAULT 0'],
      ['qc_submitted_at', 'VARCHAR(50) DEFAULT \'\''],
      ['est_hours_content_rework', 'DECIMAL(10,2) DEFAULT 0'],
    ];
    let added = 0;
    for (const [name, def] of newColumns) {
      if (!colNames.includes(name)) {
        await conn.query(`ALTER TABLE tasks ADD COLUMN \`${name}\` ${def}`);
        added++;
      }
    }
    console.log(`  Added ${added} new columns.\n`);

    // ── Step 4: Create child tables ─────────────────────
    console.log('Step 3/6: Creating child tables...');

    await conn.query(`CREATE TABLE IF NOT EXISTS task_time_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      task_id VARCHAR(255) NOT NULL,
      event_type VARCHAR(50) NOT NULL DEFAULT '',
      \`timestamp\` VARCHAR(50) DEFAULT '',
      department VARCHAR(100) DEFAULT '',
      owner VARCHAR(255) DEFAULT '',
      INDEX idx_tte_task (task_id),
      CONSTRAINT fk_tte_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log('  ✓ task_time_events');

    await conn.query(`CREATE TABLE IF NOT EXISTS task_qc_reviews (
      id VARCHAR(255) PRIMARY KEY,
      task_id VARCHAR(255) NOT NULL,
      submitted_by VARCHAR(255) DEFAULT '',
      submitted_by_dept VARCHAR(100) DEFAULT '',
      submitted_at VARCHAR(50) DEFAULT '',
      assigned_to VARCHAR(255) DEFAULT '',
      est_hours DECIMAL(10,2) DEFAULT 0,
      note TEXT,
      outcome VARCHAR(100) DEFAULT '',
      completed_at VARCHAR(50) DEFAULT '',
      INDEX idx_tqc_task (task_id),
      CONSTRAINT fk_tqc_task FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log('  ✓ task_qc_reviews');

    await conn.query(`CREATE TABLE IF NOT EXISTS task_rework_entries (
      id VARCHAR(255) PRIMARY KEY,
      task_id VARCHAR(255) NOT NULL,
      rework_date DATE NULL,
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
    console.log('  ✓ task_rework_entries\n');

    // ── Step 5: Add indexes to tasks ────────────────────
    console.log('Step 4/6: Adding indexes...');
    const indexes = [
      ['idx_tasks_client', 'client'],
      ['idx_tasks_seo_owner', 'seo_owner'],
      ['idx_tasks_intake_date', 'intake_date'],
      ['idx_tasks_is_completed', 'is_completed'],
    ];
    for (const [idxName, colName] of indexes) {
      try {
        await conn.query(`CREATE INDEX \`${idxName}\` ON tasks (\`${colName}\`)`);
        console.log(`  ✓ ${idxName}`);
      } catch (e) {
        if (e.code === 'ER_DUP_KEYNAME') console.log(`  ○ ${idxName} (already exists)`);
        else throw e;
      }
    }
    console.log('');

    // ── Step 6: Populate columns from JSON data ─────────
    console.log('Step 5/6: Migrating data from JSON to columns...');

    await conn.beginTransaction();
    try {
      const dateFields = new Set(['intakeDate', 'contentAssignedDate', 'webAssignedDate', 'dueDate']);
      const colMap = {
        title: 'title', client: 'client', intakeDate: 'intake_date',
        seoOwner: 'seo_owner', seoStage: 'seo_stage', seoQcStatus: 'seo_qc_status',
        focusedKw: 'focused_kw', volume: 'volume', marRank: 'mar_rank',
        currentRank: 'current_rank', estHours: 'est_hours', estHoursSEO: 'est_hours_seo',
        estHoursContent: 'est_hours_content', estHoursWeb: 'est_hours_web',
        actualHours: 'actual_hours', contentAssignedDate: 'content_assigned_date',
        contentOwner: 'content_owner', contentStatus: 'content_status',
        webAssignedDate: 'web_assigned_date', webOwner: 'web_owner',
        targetUrl: 'target_url', webStatus: 'web_status', currentOwner: 'current_owner',
        daysInStage: 'days_in_stage', remarks: 'remarks', isCompleted: 'is_completed',
        executionState: 'execution_state', docUrl: 'doc_url', deptType: 'dept_type',
        taskType: 'task_type', platform: 'platform', deliverableUrl: 'deliverable_url',
        dueDate: 'due_date', assignedTo: 'assigned_to', adBudget: 'ad_budget',
        estHoursSEOReview: 'est_hours_seo_review', qcSubmittedAt: 'qc_submitted_at',
        estHoursContentRework: 'est_hours_content_rework',
      };

      let migrated = 0;
      for (const task of tasks) {
        // Build SET clause for column updates
        const sets = [];
        const vals = [];

        for (const [jsonKey, dbCol] of Object.entries(colMap)) {
          let val = task[jsonKey];
          if (val === undefined) val = null;

          // Date columns: empty string → NULL
          if (dateFields.has(jsonKey)) {
            val = (val && String(val).trim()) ? String(val).trim() : null;
          }
          // Boolean
          if (jsonKey === 'isCompleted') {
            val = val ? 1 : 0;
          }

          sets.push(`\`${dbCol}\` = ?`);
          vals.push(val);
        }

        vals.push(task.id);
        await conn.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, vals);

        // Insert time events
        if (task.timeEvents && task.timeEvents.length > 0) {
          for (const te of task.timeEvents) {
            await conn.query(
              'INSERT INTO task_time_events (task_id, event_type, `timestamp`, department, owner) VALUES (?, ?, ?, ?, ?)',
              [task.id, te.type || '', te.timestamp || '', te.department || '', te.owner || '']
            );
          }
        }

        // Insert QC reviews
        if (task.qcReviews && task.qcReviews.length > 0) {
          for (const qc of task.qcReviews) {
            await conn.query(
              'INSERT INTO task_qc_reviews (id, task_id, submitted_by, submitted_by_dept, submitted_at, assigned_to, est_hours, note, outcome, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [qc.id, task.id, qc.submittedBy || '', qc.submittedByDept || '', qc.submittedAt || '', qc.assignedTo || '', qc.estHours || 0, qc.note || null, qc.outcome || '', qc.completedAt || '']
            );
          }
        }

        // Insert rework entries
        if (task.reworkEntries && task.reworkEntries.length > 0) {
          for (const rw of task.reworkEntries) {
            await conn.query(
              'INSERT INTO task_rework_entries (id, task_id, rework_date, est_hours, assigned_dept, assigned_owner, within_estimate, hours_already_spent, start_timestamp, end_timestamp, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [rw.id, task.id, rw.date || null, rw.estHours || 0, rw.assignedDept || '', rw.assignedOwner || '', rw.withinEstimate ? 1 : 0, rw.hoursAlreadySpent || 0, rw.startTimestamp || '', rw.endTimestamp || '', rw.durationMs || 0]
            );
          }
        }

        migrated++;
        if (migrated % 10 === 0) process.stdout.write(`  ${migrated}/${tasks.length} tasks...\r`);
      }

      await conn.commit();
      console.log(`  ✓ Migrated ${migrated}/${tasks.length} tasks successfully.\n`);
    } catch (migErr) {
      await conn.rollback().catch(() => {});
      throw migErr;
    }

    // ── Step 7: Drop the old data column ────────────────
    console.log('Step 6/6: Dropping old `data` JSON column...');
    await conn.query('ALTER TABLE tasks DROP COLUMN `data`');
    console.log('  ✓ `data` column removed.\n');

    // ── Verification ────────────────────────────────────
    console.log('Verifying migration...');
    const [verifyTasks] = await conn.query('SELECT COUNT(*) as cnt FROM tasks');
    const [verifyTE] = await conn.query('SELECT COUNT(*) as cnt FROM task_time_events');
    const [verifyQC] = await conn.query('SELECT COUNT(*) as cnt FROM task_qc_reviews');
    const [verifyRW] = await conn.query('SELECT COUNT(*) as cnt FROM task_rework_entries');
    const [verifyCols] = await conn.query('SHOW COLUMNS FROM tasks');

    console.log(`  Tasks:          ${verifyTasks[0].cnt} rows`);
    console.log(`  Time Events:    ${verifyTE[0].cnt} rows`);
    console.log(`  QC Reviews:     ${verifyQC[0].cnt} rows`);
    console.log(`  Rework Entries: ${verifyRW[0].cnt} rows`);
    console.log(`  Task Columns:   ${verifyCols.length}`);
    console.log(`  Has 'data' col: ${verifyCols.some(c => c.Field === 'data')}`);

    console.log('\n═══════════════════════════════════════════════════');
    console.log('  ✓ MIGRATION COMPLETED SUCCESSFULLY');
    console.log('═══════════════════════════════════════════════════');
    console.log('\nYou can now deploy the updated server.js.\n');

  } catch (e) {
    console.error('\n✗ MIGRATION FAILED:', e.message);
    console.error(e);
    process.exit(1);
  } finally {
    if (conn) conn.release();
    await pool.end();
  }
}

migrate();
