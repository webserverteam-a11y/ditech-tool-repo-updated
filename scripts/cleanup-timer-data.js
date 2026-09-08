#!/usr/bin/env node
/**
 * scripts/cleanup-timer-data.js
 *
 * Repairs the historical damage left by the three timer defects fixed in
 * backend/utils/timerGuard.js, backend/utils/saveTask.js and
 * scripts/patch-stale-bulk-flush-fix.js.
 *
 * DRY RUN BY DEFAULT — writes nothing unless you pass --apply.
 *
 * HOW IT DECIDES WHAT TO CHANGE
 * ─────────────────────────────
 * It replays every task_time_events row, oldest first, through the exact
 * rules the server now enforces, and materialises the difference:
 *
 *   1. Near-duplicate events (same task+type+owner within 2s)
 *      → the twin the double-writing timer handlers produced. DELETE.
 *
 *   2. Redundant opening events (a start/resume for an owner who already has
 *      that task running)
 *      → recording these is what orphaned the previous segment. DELETE.
 *
 *   3. Segments left open when the owner started something else
 *      → INSERT the `pause` the single-active-timer rule would have written,
 *        at the moment they moved on.
 *
 * Because it is a replay of the real event stream rather than a heuristic,
 * every change is one the fixed server would have made at the time.
 *
 * TASK STATES ARE REPORTED, NEVER CHANGED
 * ───────────────────────────────────────
 * Tasks that a stale bulk flush pushed to Ended/Approved/Completed are
 * listed at the end but never rewritten — this script cannot know which of
 * them have since been legitimately completed. Reopen them by hand from the
 * report.
 *
 * Usage:
 *   node scripts/cleanup-timer-data.js              # dry run, prints report
 *   node scripts/cleanup-timer-data.js --apply      # perform the writes
 *   node scripts/cleanup-timer-data.js --json out.json
 */

import fs from 'fs';
import pool from '../backend/config/db.js';

const APPLY     = process.argv.includes('--apply');
const jsonIdx   = process.argv.indexOf('--json');
const JSON_OUT  = jsonIdx !== -1 ? process.argv[jsonIdx + 1] : null;

const DEDUP_MS = 2000;
const OPENING  = new Set(['start', 'resume', 'rework_start']);
const CLOSING  = new Set(['pause', 'end']);

const h = ms => (ms / 3600000);

function loggedMs(events, nowMs) {
  let total = 0, open = null;
  for (const e of events) {
    const t = Date.parse(e.timestamp);
    if (Number.isNaN(t)) continue;
    if (OPENING.has(e.type)) open = t;
    else if (CLOSING.has(e.type) && open) { total += t - open; open = null; }
  }
  if (open !== null && nowMs) total += Math.max(0, nowMs - open);
  return total;
}

/** Per-owner-per-day logged hours, keyed "owner|YYYY-MM-DD". */
function personDayHours(events) {
  const buckets = {};
  for (const e of events) {
    if (!e.owner) continue;
    const day = String(e.timestamp).slice(0, 10);
    ((buckets[`${e.owner}|${day}`] ||= {})[e.task_id] ||= []).push(e);
  }
  const out = {};
  for (const key of Object.keys(buckets)) {
    const day   = key.split('|')[1];
    const eod   = Date.parse(`${day}T23:59:59Z`);
    let ms = 0;
    for (const taskId of Object.keys(buckets[key])) ms += loggedMs(buckets[key][taskId], eod);
    out[key] = h(ms);
  }
  return out;
}

async function main() {
  console.log(`\n${APPLY ? 'APPLY MODE — changes WILL be written' : 'DRY RUN — nothing will be written'}\n`);

  const [rows] = await pool.query(
    `SELECT id, task_id, event_type, timestamp, department, owner
       FROM task_time_events
      ORDER BY timestamp ASC, id ASC`
  );
  const events = rows
    .map(r => ({ ...r, type: String(r.event_type || '').toLowerCase() }))
    .filter(e => e.timestamp && !Number.isNaN(Date.parse(e.timestamp)));

  console.log(`Loaded ${rows.length.toLocaleString()} timer events `
    + `(${(rows.length - events.length).toLocaleString()} skipped as unparseable).\n`);

  // ── replay ────────────────────────────────────────────────────────────────
  const deleteDup       = [];   // rows to delete (near-duplicate twins)
  const deleteRedundant = [];   // rows to delete (re-start on an already-open task)
  const insertPause     = [];   // pause rows to add
  const kept            = [];

  const seenByTask  = new Map();   // task_id -> [{type,t,owner}]
  const openByOwner = new Map();   // owner   -> Map(task_id -> department)

  for (const e of events) {
    const t = Date.parse(e.timestamp);

    const seen = seenByTask.get(e.task_id) || [];
    if (seen.some(s => s.type === e.type && s.owner === e.owner && Math.abs(s.t - t) < DEDUP_MS)) {
      deleteDup.push(e);
      continue;
    }

    if (OPENING.has(e.type) && e.owner) {
      const running = openByOwner.get(e.owner) || new Map();
      if (running.has(e.task_id)) { deleteRedundant.push(e); continue; }
      for (const [otherTask, otherDept] of running) {
        const pause = {
          task_id: otherTask, event_type: 'pause', type: 'pause',
          timestamp: e.timestamp, department: otherDept, owner: e.owner,
        };
        insertPause.push(pause);
        kept.push(pause);
      }
      running.clear();
      running.set(e.task_id, e.department || '');
      openByOwner.set(e.owner, running);
    }
    if (CLOSING.has(e.type) && e.owner) openByOwner.get(e.owner)?.delete(e.task_id);

    kept.push(e);
    seen.push({ type: e.type, t, owner: e.owner });
    seenByTask.set(e.task_id, seen);
  }

  // ── report: events ────────────────────────────────────────────────────────
  console.log('EVENT REPAIRS');
  console.log('─'.repeat(70));
  console.log(`  delete — near-duplicate twins (<2s apart) : ${deleteDup.length.toLocaleString()}`);
  console.log(`  delete — redundant re-starts             : ${deleteRedundant.length.toLocaleString()}`);
  console.log(`  insert — auto-pause events               : ${insertPause.length.toLocaleString()}`);
  console.log(`  events remaining after repair            : ${kept.length.toLocaleString()}`
    + `  (was ${events.length.toLocaleString()})`);

  // ── report: hours ─────────────────────────────────────────────────────────
  const before = personDayHours(events);
  const after  = personDayHours(kept);
  const overBefore = Object.keys(before).filter(k => before[k] > 24);
  const overAfter  = Object.keys(after).filter(k => after[k] > 24);

  console.log('\nTIMESHEET IMPACT');
  console.log('─'.repeat(70));
  console.log(`  person-days logging more than 24h — before: ${overBefore.length}, after: ${overAfter.length}`);

  const changed = Object.keys(before)
    .filter(k => Math.abs((after[k] ?? 0) - before[k]) > 0.05)
    .sort((a, b) => (before[b] - (after[b] ?? 0)) - (before[a] - (after[a] ?? 0)));

  if (changed.length) {
    console.log(`\n  ${changed.length} person-days change. Largest corrections:\n`);
    console.log(`    ${'DATE'.padEnd(12)}${'PERSON'.padEnd(11)}${'BEFORE'.padStart(9)}${'AFTER'.padStart(9)}`);
    for (const k of changed.slice(0, 25)) {
      const [owner, day] = k.split('|');
      console.log(`    ${day.padEnd(12)}${owner.padEnd(11)}`
        + `${before[k].toFixed(1).padStart(8)}h${(after[k] ?? 0).toFixed(1).padStart(8)}h`);
    }
    if (changed.length > 25) console.log(`    ... and ${changed.length - 25} more`);
  }

  // ── report: tasks a stale bulk flush likely closed ─────────────────────────
  // Fingerprint: MySQL only bumps updated_at for rows that actually changed, so
  // a stale whole-list PUT leaves a cluster of tasks sharing one updated_at
  // second. Terminal-state members of such a cluster with neither an `end`
  // event nor an audit entry near that moment had no user action behind them.
  const [taskRows] = await pool.query(
    `SELECT id, title, client, seo_owner, execution_state, updated_at
       FROM tasks
      WHERE execution_state IN ('Ended','Approved','Completed')`
  );
  const [auditRows] = await pool.query(
    `SELECT task_id, action, timestamp FROM audit_logs
      WHERE action IN ('Task Closed','Task Approved')`
  );

  const endByTask = new Map();
  for (const e of events) {
    if (e.type !== 'end') continue;
    if (!endByTask.has(e.task_id)) endByTask.set(e.task_id, []);
    endByTask.get(e.task_id).push(Date.parse(e.timestamp));
  }
  const auditByTask = new Map();
  for (const a of auditRows) {
    if (!auditByTask.has(a.task_id)) auditByTask.set(a.task_id, []);
    auditByTask.get(a.task_id).push(Date.parse(a.timestamp));
  }

  const clusters = new Map();
  for (const t of taskRows) {
    const key = String(t.updated_at);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(t);
  }

  const suspect = [];
  const WINDOW = 10 * 60 * 1000;
  for (const [key, list] of clusters) {
    if (list.length < 10) continue;             // a cluster, not a single action
    const wall = Date.parse(String(key).replace(' ', 'T') + 'Z');
    for (const t of list) {
      const hasEnd   = (endByTask.get(t.id)   || []).some(x => Math.abs(x - wall) < WINDOW);
      const hasAudit = (auditByTask.get(t.id) || []).some(x => Math.abs(x - wall) < WINDOW);
      if (!hasEnd && !hasAudit) suspect.push({ ...t, cluster: key, clusterSize: list.length });
    }
  }

  console.log('\nTASKS CLOSED WITH NO USER ACTION  (reported only — never rewritten)');
  console.log('─'.repeat(70));
  if (!suspect.length) {
    console.log('  none found.');
  } else {
    console.log(`  ${suspect.length} task(s) sit in a terminal state with no end event and no`);
    console.log('  audit entry near the bulk write that put them there.\n');
    const byCluster = {};
    for (const s of suspect) (byCluster[s.cluster] ||= []).push(s);
    for (const [c, list] of Object.entries(byCluster).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`    ${c}  ${String(list.length).padStart(3)} task(s)  e.g. `
        + list.slice(0, 3).map(s => `${s.id} (${s.execution_state})`).join(', '));
    }
    console.log('\n  Full list is in the --json output.');
  }

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({
      generatedAt: new Date().toISOString(),
      applied: APPLY,
      deleteDuplicateIds: deleteDup.map(e => e.id),
      deleteRedundantIds: deleteRedundant.map(e => e.id),
      insertPause,
      hoursBefore: before,
      hoursAfter: after,
      suspectTasks: suspect,
    }, null, 2));
    console.log(`\nFull report written to ${JSON_OUT}`);
  }

  // ── apply ─────────────────────────────────────────────────────────────────
  if (!APPLY) {
    console.log('\n' + '─'.repeat(70));
    console.log('DRY RUN — nothing was written. Re-run with --apply to perform these');
    console.log('changes. Take a database backup first.');
    await pool.end();
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const ids = [...deleteDup, ...deleteRedundant].map(e => e.id);
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      await conn.query(
        `DELETE FROM task_time_events WHERE id IN (${chunk.map(() => '?').join(',')})`,
        chunk
      );
    }

    for (let i = 0; i < insertPause.length; i += 500) {
      const chunk = insertPause.slice(i, i + 500);
      await conn.query(
        `INSERT INTO task_time_events (task_id, event_type, timestamp, department, owner) VALUES ?`,
        [chunk.map(p => [p.task_id, 'pause', p.timestamp, p.department || '', p.owner || ''])]
      );
    }

    await conn.commit();
    console.log(`\n✅ Applied: ${ids.length.toLocaleString()} events deleted, `
      + `${insertPause.length.toLocaleString()} pause events inserted.`);
    console.log('   Task execution states were left untouched, as documented above.');
  } catch (e) {
    await conn.rollback().catch(() => {});
    console.error('\n❌ Rolled back — nothing was changed. Error:', e.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch(e => {
  console.error('cleanup-timer-data failed:', e);
  process.exit(1);
});
