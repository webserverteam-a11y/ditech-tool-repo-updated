#!/usr/bin/env node
/**
 * scripts/diagnose-open-timers.js
 *
 * READ-ONLY. Writes nothing, ever. Shows which timers are currently open
 * and how much each is contributing to today's timesheet right now.
 *
 * Use this to tell apart the two situations that look identical in the UI:
 *
 *   - Stale opens left over from before the timer fixes. The set of open
 *     tasks stays the SAME between runs; only their ages grow. Fixed by
 *     scripts/cleanup-timer-data.js.
 *
 *   - Something still creating opens. NEW task ids appear between runs, or
 *     one person has more than one open task despite the single-active-timer
 *     guard. That would mean a write path is bypassing timerGuard.js.
 *
 * Usage:
 *   node scripts/diagnose-open-timers.js
 *   node scripts/diagnose-open-timers.js --owner Imran
 */

import pool from '../backend/config/db.js';

const OPENING = new Set(['start', 'resume', 'rework_start']);
const CLOSING = new Set(['pause', 'end']);

const ownerIdx  = process.argv.indexOf('--owner');
const ONLY      = ownerIdx !== -1 ? process.argv[ownerIdx + 1] : null;

const fmt = ms => {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${String(m).padStart(2, '0')}m`;
};

async function main() {
  const [rows] = await pool.query(
    `SELECT task_id, event_type, timestamp, department, owner
       FROM task_time_events
      ORDER BY timestamp ASC, id ASC`
  );

  // Per (task, owner): is the newest event an opening one?
  const state = new Map();
  for (const r of rows) {
    const type = String(r.event_type || '').toLowerCase();
    const t = Date.parse(r.timestamp);
    if (Number.isNaN(t)) continue;
    const key = `${r.task_id}|${r.owner || ''}`;
    if (OPENING.has(type))      state.set(key, { ...r, t, type });
    else if (CLOSING.has(type)) state.delete(key);
  }

  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  const byOwner = new Map();
  for (const v of state.values()) {
    const owner = v.owner || '(admin / blank)';
    if (ONLY && owner !== ONLY) continue;
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(v);
  }

  console.log(`\nOPEN TIMERS RIGHT NOW  —  ${new Date().toISOString()}`);
  console.log('='.repeat(72));

  if (!byOwner.size) { console.log('\nNothing is open. Timesheets are not accruing.\n'); await pool.end(); return; }

  const sorted = [...byOwner.entries()].sort((a, b) => b[1].length - a[1].length);

  let grandLive = 0;
  for (const [owner, list] of sorted) {
    list.sort((a, b) => a.t - b.t);
    // Only opens dated today feed today's cell (the panel filters by calendar date).
    const todays = list.filter(v => String(v.timestamp).slice(0, 10) === today);
    const live   = todays.reduce((s, v) => s + (now - v.t), 0);
    grandLive += live;

    console.log(`\n${owner}  —  ${list.length} open timer(s), ${todays.length} dated today`);
    if (todays.length) {
      console.log(`  contributing to TODAY right now: ${fmt(live)}`
        + `   (growing ${todays.length} min per minute)`);
    }
    for (const v of list.slice(0, 12)) {
      const age = now - v.t;
      const flag = age > 24 * 3600000 ? '  <-- older than a day' : '';
      console.log(`    ${String(v.task_id).padEnd(16)} ${v.type.padEnd(7)}`
        + ` open ${fmt(age).padStart(9)}  since ${v.timestamp}${flag}`);
    }
    if (list.length > 12) console.log(`    ... and ${list.length - 12} more`);
  }

  console.log('\n' + '='.repeat(72));
  console.log(`Total being added to TODAY's timesheet by open timers: ${fmt(grandLive)}`);
  console.log('\nIf you re-run this in a few minutes and the TASK IDS are unchanged');
  console.log('(only ages grew), these are stale pre-fix timers — run:');
  console.log('    npm run cleanup-timers          # dry run, shows what it would do');
  console.log('    npm run cleanup-timers:apply    # after a DB backup');
  console.log('\nIf NEW task ids appear, or one person shows several open at once,');
  console.log('tell me — that would mean a write path is bypassing the guard.\n');

  await pool.end();
}

main().catch(e => { console.error('diagnose-open-timers failed:', e); process.exit(1); });
