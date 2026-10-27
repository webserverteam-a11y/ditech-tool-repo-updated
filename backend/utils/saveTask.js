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
import { taskToColumns, TASK_COLUMN_MAP, INT_COLS, DEC_COLS } from './taskMapping.js';
import { enforceSingleActiveTimer, isOpeningEvent } from './timerGuard.js';

/**
 * Near-duplicate window for timer events, in milliseconds.
 *
 * Both timer handlers in the bundle record every Start/Pause/Resume/End
 * TWICE, each with its own `new Date().toISOString()` call:
 *
 *   Action Board  Te()  — `_abTs` for the immediate _saveTaskById(),
 *                         then `Ze` inside the setTasks() updater
 *   WorkHub       Xe()  — `_ts`   for the immediate _saveTaskById(),
 *                         then `Pe` inside Qe()'s setTasks() updater
 *
 * The two clocks read ~1ms apart, so the UNIQUE index on
 * (task_id, event_type, timestamp) never matches and INSERT IGNORE lets
 * both rows through. 35.7% of task_time_events rows are such twins, and
 * each phantom `start` orphans the open segment before it — the single
 * largest source of dangling timers (8,940 of 9,917 dangling opens).
 *
 * 2s is far longer than the ~1ms clock skew and far shorter than any
 * meaningful human re-click, so it drops the twin without ever dropping a
 * real event.
 */
const EVENT_DEDUP_WINDOW_MS = 2000;

/** True if `ev` repeats an event already recorded for the same task+owner. */
export function isDuplicateTimeEvent(seen, ev) {
  const t = Date.parse(ev.timestamp || '');
  if (Number.isNaN(t)) return false;
  const type  = ev.type  || '';
  const owner = ev.owner || '';
  return seen.some(s =>
    s.type === type &&
    s.owner === owner &&
    Math.abs(s.t - t) < EVENT_DEDUP_WINDOW_MS
  );
}

/** How long after creation an unversioned full-row write is still accepted. */
const NEW_TASK_GRACE_MS = 5 * 60 * 1000;

/** May a payload without `_base` overwrite the whole existing `row`? */
function isFullWriteAllowed(task, row) {
  if (task.updatedAt) {
    if (!row.updated_at) return true;
    return Date.parse(task.updatedAt) >= new Date(row.updated_at).getTime();
  }
  if (!row.created_at) return false;
  return Date.now() - new Date(row.created_at).getTime() < NEW_TASK_GRACE_MS;
}

/** Comparable form of a task field value, matching taskToColumns() coercion. */
function normField(col, v) {
  if (col === 'is_completed') return v ? 1 : 0;
  if (INT_COLS.has(col) || DEC_COLS.has(col)) return Number(v) || 0;
  return v === null || v === undefined ? '' : String(v);
}

/**
 * Stale-write protection for the tasks row.
 *
 * The old behaviour was a full-row upsert: whatever copy of the task a browser
 * held was written over every column. A tab whose copy was even a second old
 * silently reverted other people's Start / End / handoff / owner changes —
 * tasks "ending by themselves" and vanishing from dashboards.
 *
 * Now, for an existing task:
 *   • `_base` present (current bundle) — the field values the client last saw
 *     from the server. Only columns the client actually changed (payload !=
 *     base) are written; everything else keeps the DB's current value. This is
 *     a three-way merge, so concurrent edits to different fields both survive.
 *   • no `_base`, `updatedAt` present — full overwrite only if the client's
 *     copy is current; a stale copy is NOT written and the caller reports 409.
 *   • neither — full overwrite only if the row was created in the last
 *     NEW_TASK_GRACE_MS (follow-up saves of a task this client just created).
 *     Any older row is refused: an unversioned full-row write is exactly how
 *     an old tab / old machine / old bundle rolled back the whole table.
 *   • row does not exist — insert (new tasks, CSV imports).
 *
 * Child tables are append/upsert-only and are always processed.
 *
 * @returns {Promise<{stale, changedCols, mode, changes, newEvents, autoPaused}>}
 *   changedCols — columns written in merge mode; null for full write / insert
 *   mode        — 'merge' | 'full' | 'create' | 'refused_stale'
 *   changes     — [{field, from, to}] actually changed in the DB; for
 *                 'refused_stale', what the write WOULD have changed
 *   newEvents   — timer events inserted by this save
 *   autoPaused  — other task ids paused by the single-active-timer guard
 *   (used by the activity log — see backend/services/activityLog.service.js)
 */
export async function saveTaskToDb(conn, task) {
  const base = task._base && typeof task._base === 'object' ? { ...task._base } : null;
  normalizeTaskDates(task);
  if (base) normalizeTaskDates(base);
  const { cols, vals } = taskToColumns(task);

  const [cur] = await conn.query(
    'SELECT * FROM tasks WHERE id = ? LIMIT 1 FOR UPDATE',
    [task.id]
  );
  const exists = cur.length > 0;
  const row    = exists ? cur[0] : null;

  // Field-level diff of payload vs current DB row, restricted to `onlyCols`.
  const diffVsRow = (onlyCols) => cols.reduce((out, col, i) => {
    if (col === 'id' || (onlyCols && !onlyCols.includes(col))) return out;
    if (normField(col, vals[i]) === normField(col, row[col])) return out;
    out.push({ field: TASK_COLUMN_MAP[col], from: row[col], to: vals[i] });
    return out;
  }, []);

  let stale = false;
  let changedCols = null;
  let mode = exists ? 'full' : 'create';
  let changes = null;
  const newEvents = [];
  const autoPaused = [];

  if (exists && base) {
    changedCols = [];
    const setVals = [];
    cols.forEach((col, i) => {
      if (col === 'id') return;
      const key = TASK_COLUMN_MAP[col];
      if (!(key in base)) return; // no baseline for this field — leave DB value alone
      if (normField(col, vals[i]) === normField(col, base[key])) return;
      changedCols.push(col);
      setVals.push(vals[i]);
    });
    mode = 'merge';
    changes = diffVsRow(changedCols);
    if (changedCols.length) {
      await conn.query(
        `UPDATE tasks SET ${changedCols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
        [...setVals, task.id]
      );
    }
  } else if (exists && !isFullWriteAllowed(task, row)) {
    stale = true;
    mode = 'refused_stale';
    changes = diffVsRow(null);
  } else {
    if (exists) changes = diffVsRow(null);
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
  }

  // ── task_time_events — APPEND-ONLY, never delete ───────────────────────────
  // Race condition fixed: the old DELETE + re-INSERT pattern let User B's stale
  // task save wipe timer events that User A had just recorded.
  //
  // New approach: INSERT IGNORE skips rows that already exist in the DB
  // (matched by the UNIQUE INDEX idx_tte_unique on task_id+event_type+timestamp).
  // New events from the payload are added; existing events are left untouched.
  // To remove a time event, use the explicit DELETE endpoint.
  //
  // Near-duplicate guard added on top: the exact-timestamp UNIQUE index can
  // not catch the twin events both timer handlers emit ~1ms apart, so any
  // event within EVENT_DEDUP_WINDOW_MS of an already-recorded event of the
  // same type+owner on this task is skipped. See isDuplicateTimeEvent above.
  if (Array.isArray(task.timeEvents) && task.timeEvents.length) {
    const [existing] = await conn.query(
      'SELECT event_type, timestamp, owner FROM task_time_events WHERE task_id = ?',
      [task.id]
    );
    const seen = existing
      .map(e => ({ type: e.event_type || '', t: Date.parse(e.timestamp), owner: e.owner || '' }))
      .filter(e => !Number.isNaN(e.t));

    for (const ev of task.timeEvents) {
      if (isDuplicateTimeEvent(seen, ev)) continue;

      // Single-active-timer guard. An opening event pauses whatever else this
      // person has running, and is dropped outright if it would land on a task
      // they already have open — recording it would orphan the live segment.
      if (isOpeningEvent(ev.type) && ev.owner && ev.timestamp) {
        const { redundant, pausedTaskIds } = await enforceSingleActiveTimer(conn, {
          taskId:     task.id,
          owner:      ev.owner,
          timestamp:  ev.timestamp,
          department: ev.department || '',
        });
        autoPaused.push(...pausedTaskIds);
        if (redundant) continue;
      }

      const [ins] = await conn.query(
        `INSERT IGNORE INTO task_time_events
           (task_id, event_type, timestamp, department, owner)
         VALUES (?,?,?,?,?)`,
        [task.id, ev.type || '', ev.timestamp || '', ev.department || '', ev.owner || '']
      );
      if (ins.affectedRows) {
        newEvents.push({ type: ev.type || '', owner: ev.owner || '', timestamp: ev.timestamp || '' });
      }

      const t = Date.parse(ev.timestamp || '');
      if (!Number.isNaN(t)) seen.push({ type: ev.type || '', t, owner: ev.owner || '' });
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

  return { stale, changedCols, mode, changes, newEvents, autoPaused };
}
