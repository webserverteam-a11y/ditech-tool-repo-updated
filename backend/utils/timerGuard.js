/**
 * timerGuard.js — Single-active-timer enforcement.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Nothing in the app stopped one person from having many timers running at
 * once, and the timesheet credits every open segment (now - open) in
 * parallel for the current day — see loggedMsFromEvents() in timesheetCalc.js.
 * So N forgotten timers report N x wall-clock. In the production dump that
 * produced 31 person-days over 24 logged hours, topping out at a single user
 * showing 162h 31m in one day across ~100 tasks.
 *
 * The two ways a person ends up with several timers running:
 *
 *   1. They genuinely start a second task without pausing the first. Nothing
 *      warned them, and the first task keeps accruing silently.
 *   2. A stray Start lands on a task that was ALREADY running for them. Every
 *      elapsed-time calculator treats an opening event as OVERWRITING the
 *      pending open, so the earlier segment is silently orphaned and never
 *      closes — it just accrues until the end of the day.
 *
 * WHAT THIS DOES
 * ──────────────
 * Enforced on the server so it holds regardless of which screen, tab, or
 * stale bundle the write came from — the Action Board, WorkHub, Action Board
 * 2.0 and the atomic events endpoint all funnel through here.
 *
 * When a Start/Resume/Rework-start for owner O lands on task T at time TS:
 *
 *   • Every OTHER task where O currently has an open segment gets a `pause`
 *     event at TS, and its execution_state is moved to 'Paused' so the UI
 *     agrees with the event log.
 *   • If O already has T itself open, the new opening event is REDUNDANT and
 *     is reported as such — recording it would orphan the live segment
 *     (cause 2 above). The caller skips the insert.
 *
 * Ownership is tracked per (task, owner): "which tasks does this person have
 * running", which is how the timesheet attributes time. A pause recorded by
 * somebody else does not close your segment.
 */

/** Event types that open a timing segment. */
const OPENING_TYPES = new Set(['start', 'resume', 'rework_start']);
/** Event types that close one. */
const CLOSING_TYPES = new Set(['pause', 'end']);

export function isOpeningEvent(type) {
  return OPENING_TYPES.has(String(type || '').toLowerCase());
}

export function isClosingEvent(type) {
  return CLOSING_TYPES.has(String(type || '').toLowerCase());
}

/**
 * Tasks on which `owner` currently has an open (unclosed) segment.
 *
 * Determined from the owner's own latest event per task: if it is an opening
 * type, that task is running for them. `asOf` (ISO string) bounds the scan so
 * a replayed/backdated save can not be judged against events that come after
 * it; omit it to mean "right now".
 *
 * @returns {Promise<Array<{taskId: string, since: string, department: string}>>}
 */
export async function findOpenTasksForOwner(conn, owner, { asOf = null, excludeTaskId = null } = {}) {
  if (!owner) return []; // blank owner == admin action; not attributable to a person

  const params = [owner];
  let bound = '';
  if (asOf) { bound = ' AND timestamp <= ?'; params.push(asOf); }

  // Latest event per task for this owner. `timestamp` is an ISO-8601 string
  // with a fixed shape, so lexicographic MAX() is chronological MAX().
  const [rows] = await conn.query(
    `SELECT e.task_id, e.event_type, e.timestamp, e.department
       FROM task_time_events e
       JOIN (
         SELECT task_id, MAX(timestamp) AS mx
           FROM task_time_events
          WHERE owner = ?${bound}
          GROUP BY task_id
       ) latest
         ON latest.task_id = e.task_id AND latest.mx = e.timestamp
      WHERE e.owner = ?${bound}`,
    asOf ? [...params, owner, asOf] : [...params, owner]
  );

  const open = [];
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.task_id)) continue;       // ties on identical timestamps
    seen.add(r.task_id);
    if (!isOpeningEvent(r.event_type)) continue;
    if (excludeTaskId && r.task_id === excludeTaskId) continue;
    open.push({ taskId: r.task_id, since: r.timestamp, department: r.department || '' });
  }
  return open;
}

/**
 * Enforce "one running task per person" for an incoming opening event.
 *
 * Pauses every other task this owner has running, then reports whether the
 * incoming event should be recorded at all.
 *
 * @returns {Promise<{redundant: boolean, pausedTaskIds: string[]}>}
 *   redundant     — owner already has THIS task open; skip the insert
 *   pausedTaskIds — other tasks auto-paused to make room
 */
export async function enforceSingleActiveTimer(conn, { taskId, owner, timestamp, department = '' }) {
  if (!owner || !taskId || !timestamp) return { redundant: false, pausedTaskIds: [] };

  const running = await findOpenTasksForOwner(conn, owner, { asOf: timestamp });

  const redundant = running.some(r => r.taskId === taskId);
  const toPause   = running.filter(r => r.taskId !== taskId);

  for (const r of toPause) {
    await conn.query(
      `INSERT INTO task_time_events (task_id, event_type, timestamp, department, owner)
       VALUES (?, 'pause', ?, ?, ?)`,
      [r.taskId, timestamp, r.department || department, owner]
    );
    // Keep execution_state consistent with the event log, but never downgrade a
    // task that has already reached a terminal state through some other path.
    await conn.query(
      `UPDATE tasks
          SET execution_state = 'Paused', updated_at = NOW()
        WHERE id = ?
          AND execution_state IN ('In Progress', 'Rework')`,
      [r.taskId]
    );
  }

  return { redundant, pausedTaskIds: toPause.map(r => r.taskId) };
}
