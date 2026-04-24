/**
 * saveTask.js — Atomic task + child-table upsert helper.
 *
 * Used by tasks.routes.js. Extracted from server.js so it can be
 * imported by any route file without circular deps.
 *
 * Rules:
 *   • Always runs inside a caller-supplied transaction connection.
 *   • task_time_events  → DELETE + re-INSERT within the transaction (safe).
 *   • task_qc_reviews   → INSERT ... ON DUPLICATE KEY UPDATE (upsert by review_id).
 *   • task_rework_entries → INSERT ... ON DUPLICATE KEY UPDATE (upsert by rework_id).
 */

import { normalizeTaskDates } from './dateNormalize.js';
import { taskToColumns } from './taskMapping.js';

export async function saveTaskToDb(conn, task) {
  normalizeTaskDates(task);
  const { cols, vals } = taskToColumns(task);
  const placeholders = cols.map(() => '?').join(',');
  const updates = cols
    .filter(c => c !== 'id')
    .map(c => `${c} = VALUES(${c})`)
    .join(', ');

  await conn.query(
    `INSERT INTO tasks (${cols.join(',')}) VALUES (${placeholders})
     ON DUPLICATE KEY UPDATE ${updates}`,
    vals
  );

  // ── task_time_events (append-only semantics) ───────────────────────────────
  // DELETE + re-INSERT inside a transaction is safe here: the lock held by
  // BEGIN TRANSACTION prevents another session from seeing the gap.
  if (Array.isArray(task.timeEvents)) {
    await conn.query('DELETE FROM task_time_events WHERE task_id = ?', [task.id]);
    for (const ev of task.timeEvents) {
      await conn.query(
        `INSERT INTO task_time_events
           (task_id, event_type, timestamp, department, owner)
         VALUES (?,?,?,?,?)`,
        [task.id, ev.type || '', ev.timestamp || '', ev.department || '', ev.owner || '']
      );
    }
  }

  // ── task_qc_reviews (upsert by review_id) ─────────────────────────────────
  if (Array.isArray(task.qcReviews)) {
    for (const qc of task.qcReviews) {
      await conn.query(
        `INSERT INTO task_qc_reviews
           (task_id, review_id, submitted_by, submitted_by_dept, submitted_at,
            assigned_to, est_hours, note, outcome, completed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           submitted_by       = VALUES(submitted_by),
           submitted_by_dept  = VALUES(submitted_by_dept),
           submitted_at       = VALUES(submitted_at),
           assigned_to        = VALUES(assigned_to),
           est_hours          = VALUES(est_hours),
           note               = VALUES(note),
           outcome            = VALUES(outcome),
           completed_at       = VALUES(completed_at)`,
        [
          task.id, qc.id || '', qc.submittedBy || '', qc.submittedByDept || '',
          qc.submittedAt || '', qc.assignedTo || '', qc.estHours || 0,
          qc.note || '', qc.outcome || '', qc.completedAt || '',
        ]
      );
    }
    // Prune deleted reviews
    if (task.qcReviews.length > 0) {
      const ids = task.qcReviews.map(q => q.id).filter(Boolean);
      if (ids.length > 0) {
        const ph = ids.map(() => '?').join(',');
        await conn.query(
          `DELETE FROM task_qc_reviews WHERE task_id = ? AND review_id NOT IN (${ph})`,
          [task.id, ...ids]
        );
      }
    } else {
      await conn.query('DELETE FROM task_qc_reviews WHERE task_id = ?', [task.id]);
    }
  }

  // ── task_rework_entries (upsert by rework_id) ─────────────────────────────
  if (Array.isArray(task.reworkEntries)) {
    for (const rw of task.reworkEntries) {
      await conn.query(
        `INSERT INTO task_rework_entries
           (task_id, rework_id, date, est_hours, assigned_dept, assigned_owner,
            within_estimate, hours_already_spent, start_timestamp, end_timestamp, duration_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           date                 = VALUES(date),
           est_hours            = VALUES(est_hours),
           assigned_dept        = VALUES(assigned_dept),
           assigned_owner       = VALUES(assigned_owner),
           within_estimate      = VALUES(within_estimate),
           hours_already_spent  = VALUES(hours_already_spent),
           start_timestamp      = VALUES(start_timestamp),
           end_timestamp        = VALUES(end_timestamp),
           duration_ms          = VALUES(duration_ms)`,
        [
          task.id, rw.id || '', rw.date || '', rw.estHours || 0,
          rw.assignedDept || '', rw.assignedOwner || '', rw.withinEstimate ? 1 : 0,
          rw.hoursAlreadySpent || 0, rw.startTimestamp || '',
          rw.endTimestamp || '', rw.durationMs || 0,
        ]
      );
    }
    // Prune deleted entries
    if (task.reworkEntries.length > 0) {
      const ids = task.reworkEntries.map(r => r.id).filter(Boolean);
      if (ids.length > 0) {
        const ph = ids.map(() => '?').join(',');
        await conn.query(
          `DELETE FROM task_rework_entries WHERE task_id = ? AND rework_id NOT IN (${ph})`,
          [task.id, ...ids]
        );
      }
    } else {
      await conn.query('DELETE FROM task_rework_entries WHERE task_id = ?', [task.id]);
    }
  }
}
