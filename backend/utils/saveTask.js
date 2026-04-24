/**
 * saveTask.js — Atomic task + child-table upsert helper.
 *
 * Used by tasks.routes.js. Extracted from server.js so it can be
 * imported by any route file without circular deps.
 *
 * Multi-user concurrency rules (100-user safe):
 *   • task_time_events  → INSERT IGNORE (append-only, never deletes existing events).
 *                         A UNIQUE INDEX on (task_id, event_type, timestamp) prevents
 *                         duplicates while ensuring concurrent saves never wipe each
 *                         other's timer events.
 *   • task_qc_reviews   → INSERT ... ON DUPLICATE KEY UPDATE (upsert by review_id).
 *                         NO prune step — deletes go through the dedicated
 *                         DELETE /api/tasks/:id/qc-reviews/:reviewId endpoint so a
 *                         concurrent full-task save can't silently remove a review
 *                         that another user just submitted.
 *   • task_rework_entries → Same upsert-only policy as qcReviews.
 *                           Deletes go through DELETE /api/tasks/:id/rework/:reworkId.
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

  // ── task_time_events — APPEND-ONLY, never delete ───────────────────────────
  // Race condition fixed: the old DELETE + re-INSERT pattern let User B's stale
  // task save wipe timer events that User A had just recorded.
  //
  // New approach: INSERT IGNORE skips rows that already exist in the DB
  // (matched by the UNIQUE INDEX idx_tte_unique on task_id+event_type+timestamp).
  // New events from the payload are added; existing events are left untouched.
  // To remove a time event, use the explicit DELETE endpoint.
  if (Array.isArray(task.timeEvents)) {
    for (const ev of task.timeEvents) {
      await conn.query(
        `INSERT IGNORE INTO task_time_events
           (task_id, event_type, timestamp, department, owner)
         VALUES (?,?,?,?,?)`,
        [task.id, ev.type || '', ev.timestamp || '', ev.department || '', ev.owner || '']
      );
    }
  }

  // ── task_qc_reviews — UPSERT-ONLY, never bulk-delete ──────────────────────
  // Race condition fixed: the old "prune" step (DELETE WHERE review_id NOT IN ...)
  // could silently delete a QC review that another user submitted after the current
  // user loaded the task. Only explicit DELETE /qc-reviews/:reviewId removes a review.
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
    // Prune step INTENTIONALLY REMOVED — see header comment above.
  }

  // ── task_rework_entries — UPSERT-ONLY, never bulk-delete ──────────────────
  // Same upsert-only policy as qcReviews — see comment above.
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
    // Prune step INTENTIONALLY REMOVED — see header comment above.
  }
}
