/**
 * timerCheck.service.js — Timer overrun detection and notification.
 *
 * computeElapsedHours(events) — pure function, works from raw DB rows.
 * runOverrunCheck(pool, taskId?) — queries DB and sends overrun emails.
 *   If taskId is provided, checks only that one task (used by event POST).
 *   If omitted, scans all In Progress tasks (used by 15-min interval).
 */

import pool from '../config/db.js';
import { sendOverrunEmail } from './email.service.js';

const THRESHOLD_HOURS = Number(process.env.OVERRUN_THRESHOLD_HOURS) || 5;

/**
 * Compute cumulative active time in hours from an array of event rows.
 * Events must be sorted ascending by timestamp.
 *
 * Algorithm:
 *   - 'start' or 'resume' opens a segment
 *   - 'pause' or 'end' closes the open segment and adds its duration
 *   - If a segment is still open at call time, adds (now - segmentStart)
 */
export function computeElapsedHours(events) {
  let totalMs    = 0;
  let segStart   = null;

  for (const evt of events) {
    const type = (evt.event_type || '').toLowerCase();
    const ts   = new Date(evt.timestamp);
    if (isNaN(ts.getTime())) continue;

    if (type === 'start' || type === 'resume') {
      segStart = ts;
    } else if ((type === 'pause' || type === 'end') && segStart) {
      const delta = ts - segStart;
      if (delta > 0) totalMs += delta;
      segStart = null;
    }
  }

  // Timer still running — add time up to now
  if (segStart) {
    const delta = Date.now() - segStart;
    if (delta > 0) totalMs += delta;
  }

  return totalMs / 3_600_000; // ms → hours
}

/**
 * Run the overrun check.
 * @param {object} dbPool    - mysql2 pool (passed in to avoid circular imports)
 * @param {string} [taskId]  - optional: check only this task
 */
export async function runOverrunCheck(dbPool, taskId) {
  try {
    // Build query: In Progress tasks without a notification yet,
    // joined to users to get the owner's email.
    let taskQuery = `
      SELECT t.id, t.title, t.client, t.seo_owner,
             u.ownerName, u.email AS ownerEmail
      FROM tasks t
      LEFT JOIN users u ON u.ownerName = t.seo_owner
      WHERE t.execution_state = 'In Progress'
        AND t.overrun_notified_at IS NULL
    `;
    const taskParams = [];

    if (taskId) {
      taskQuery += ' AND t.id = ?';
      taskParams.push(taskId);
    }

    const [tasks] = await dbPool.query(taskQuery, taskParams);
    if (!tasks.length) return;

    for (const task of tasks) {
      // Skip if owner has no email configured
      if (!task.ownerEmail) continue;

      // Fetch time events for this task, sorted oldest first
      const [events] = await dbPool.query(
        `SELECT event_type, timestamp
         FROM task_time_events
         WHERE task_id = ?
         ORDER BY timestamp ASC`,
        [task.id]
      );

      if (!events.length) continue;

      const elapsed = computeElapsedHours(events);
      if (elapsed < THRESHOLD_HOURS) continue;

      // Send alert
      await sendOverrunEmail(
        {
          id:         task.id,
          title:      task.title,
          client:     task.client,
          ownerName:  task.ownerName || task.seo_owner,
          ownerEmail: task.ownerEmail,
        },
        elapsed
      );

      // Mark task so we don't email again
      await dbPool.query(
        `UPDATE tasks SET overrun_notified_at = NOW() WHERE id = ?`,
        [task.id]
      );
    }
  } catch (err) {
    console.error('[timerCheck] runOverrunCheck error:', err.message);
  }
}
