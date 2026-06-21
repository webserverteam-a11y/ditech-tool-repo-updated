#!/usr/bin/env node
/**
 * scripts/patch-dirty-track-save.js  (V1.0)
 *
 * Replaces the A0 bulk-save (GET all + PUT all) with dirty-track per-task saves.
 * This is the core architectural fix for multi-user task revert issues.
 *
 * ROOT CAUSES FIXED BY THIS PATCH:
 *
 *   Reason 2 — A0 sends ALL tasks including stale copies of other users' tasks
 *   ──────────────────────────────────────────────────────────────────────────
 *   A0 did: GET /api/tasks → merge local+server → PUT /api/tasks (all 1000)
 *   Even for tasks you never touched, A0 sent your local (stale) copy.
 *   If another user assigned Task X 200ms ago, your A0 overwrote their assignment
 *   with your stale local copy of Task X.
 *
 *   Reason 3 — Rank guard blocks correct executionState on handoff
 *   ──────────────────────────────────────────────────────────────
 *   The A0 merge had a rank guard: never let executionState go DOWN in rank.
 *   Assigning SEO→Content sets executionState="Not Started" (rank 0).
 *   Server still showed "In Progress" (rank 1) before the save landed.
 *   A0 merge picked rank 1 → overwrote "Not Started" → wrong state in DB.
 *
 *   Reason 4 — Sequential saves of 1000 tasks = 5 seconds of DB locks
 *   ──────────────────────────────────────────────────────────────────
 *   PUT /api/tasks saves all tasks one-by-one. 1000 tasks × ~5ms = ~5 seconds
 *   of back-to-back DB transactions. With 5+ concurrent users each triggering
 *   A0 every 800ms, the DB is under constant lock pressure → timeouts → retries.
 *
 * THE FIX — Three changes to the frontend:
 *
 *   1. Add _dtSnapshot (dirty-track snapshot) global
 *      A plain object mapping taskId → JSON snapshot of last-saved task state.
 *      On first A0 call: snapshot all existing tasks without saving (they're in DB).
 *      On subsequent calls: compare each task against its snapshot.
 *
 *   2. Replace A0 entirely — dirty-track + per-task saves
 *      New A0(s):
 *        • First call → just take snapshot, return (tasks already in DB)
 *        • Subsequent calls → for each task:
 *            - Compute current snapshot
 *            - If different from stored snapshot → task changed → _saveTaskById(t)
 *            - On save success → update stored snapshot
 *            - On save failure → do NOT update snapshot → auto-retried next A0
 *        Only changed tasks hit the DB. Unchanged tasks = zero writes.
 *
 *   3. Remove global _pendingSaves guard from A0 debounce
 *      Old debounce skipped A0 entirely if ANY task had a pending save.
 *      That meant Task Y's changes were not saved while Task X was saving.
 *      With dirty tracking + per-task key fix, _saveTaskById itself handles
 *      the per-task dedup — the global guard is no longer needed.
 *
 * CONCRETE IMPROVEMENT:
 *   Before: 1 task changes → A0 sends 1000 tasks → 5 seconds of DB writes
 *   After:  1 task changes → A0 saves 1 task → ~5ms of DB writes
 *
 *   Before: User A's A0 overwrites User B's just-assigned task (stale copy)
 *   After:  User A never touches tasks they didn't change → no clobbering
 *
 * Idempotent: re-running detects the V1.0 marker and exits cleanly.
 * Creates a timestamped backup before writing.
 *
 * Apply order: run AFTER patch-pending-saves-key-fix.js
 * Usage: node scripts/patch-dirty-track-save.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(REPO_ROOT, 'dist', 'assets');
const INDEX_HTML = path.join(REPO_ROOT, 'dist', 'index.html');

function die(msg) {
  console.error(`\nERROR: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(INDEX_HTML)) die(`${INDEX_HTML} not found.`);
if (!fs.existsSync(ASSETS_DIR)) die(`${ASSETS_DIR} not found.`);

const html = fs.readFileSync(INDEX_HTML, 'utf-8');
const m    = html.match(/index-[A-Za-z0-9_-]+\.js/);
if (!m) die('Could not find bundle reference in dist/index.html');
const BUNDLE = path.join(ASSETS_DIR, m[0]);
if (!fs.existsSync(BUNDLE)) die(`${BUNDLE} not found.`);

console.log(`\nTarget bundle: ${BUNDLE}`);
console.log(`Size before:   ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);

let code = fs.readFileSync(BUNDLE, 'utf-8');

// ── Idempotency check ─────────────────────────────────────────────────────────
const MARKER = '/*DIRTY_TRACK_SAVE_V1_0_APPLIED*/';
if (code.includes(MARKER)) {
  console.log('\nAlready patched (V1.0 marker found). Nothing to do.');
  process.exit(0);
}

if (!code.includes('/*PENDING_SAVES_KEY_FIX_V1_0_APPLIED*/')) {
  die('patch-pending-saves-key-fix.js must be applied before this patch.\n' +
      'Run: node scripts/patch-pending-saves-key-fix.js');
}

let changeCount = 0;

function rep(oldStr, newStr, label) {
  const parts = code.split(oldStr);
  if (parts.length === 1) {
    die(`[${label}]: anchor NOT found in bundle.\n` +
        'The bundle may have been rebuilt. Re-apply all patches from scratch.');
  }
  if (parts.length > 2) {
    die(`[${label}]: anchor matched ${parts.length - 1} times (expected 1). Aborting.`);
  }
  code = parts[0] + newStr + parts[1];
  changeCount++;
  console.log(`  ✔ ${label}`);
}

// ── Backup ────────────────────────────────────────────────────────────────────
const ts     = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backup = BUNDLE.replace('.js', `.bak-dirty-track-${ts}.js`);
fs.copyFileSync(BUNDLE, backup);
console.log(`\nBackup: ${path.basename(backup)}\n`);
console.log('Applying patches...\n');

// ── 1. Insert idempotency marker ──────────────────────────────────────────────
rep(
  '/*PENDING_SAVES_KEY_FIX_V1_0_APPLIED*/',
  '/*PENDING_SAVES_KEY_FIX_V1_0_APPLIED*/' + MARKER,
  'Insert V1.0 idempotency marker'
);

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 1 — Inject _dtSnapshot global next to _pendingSaves
// ─────────────────────────────────────────────────────────────────────────────
// _dtSnapshot: null = not yet initialized (first A0 call will populate it)
//              object = map of taskId → JSON string of last successfully saved task
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  'var _pendingSaves={};',
  'var _pendingSaves={};var _dtSnapshot=null;',
  'Inject _dtSnapshot global (dirty-track snapshot store)'
);

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 2 — Replace the entire A0 function with dirty-track per-task saves
// ─────────────────────────────────────────────────────────────────────────────
//
// OLD A0 (GET all + PUT all — every single state change):
//   function A0(s) {
//     fetch("/api/tasks", {cache:"no-store"})
//       .then(fresh => {
//         var payload = s;
//         if (fresh) {
//           // merge: server wins on assignment fields, rank guard on executionState
//           payload = s.map(t => Object.assign({}, t, {sv fields...}));
//         }
//         return fetch("/api/tasks", {method:"PUT", body: JSON.stringify(payload)});
//         // ↑ sends ALL 1000 tasks. 5 seconds of sequential DB writes.
//       })
//   }
//
// NEW A0 (dirty-track — saves only changed tasks):
//   function A0(s) {
//     if(_dtSnapshot === null) {
//       // First call: tasks already in DB, just snapshot them
//       _dtSnapshot = {};
//       s.forEach(t => _dtSnapshot[t.id] = snap(t));
//       return;
//     }
//     s.forEach(t => {
//       var snap = snapshot(t);
//       if(_dtSnapshot[t.id] !== snap) {     // changed (or new task not yet in snapshot)
//         _saveTaskById(t).then(resp => {
//           if(resp && resp.ok !== false) _dtSnapshot[t.id] = snap;
//           // On failure: snapshot NOT updated → auto-retried on next A0
//         });
//       }
//     });
//   }
//
// _dtSnap(t) snapshots all user-editable scalar fields. Child arrays
// (timeEvents, qcReviews, reworkEntries) are excluded from comparison —
// they have their own atomic endpoints and are always sent in the full
// task body of _saveTaskById so they persist regardless.
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  // ANCHOR — entire old A0 function (verified unique in bundle)
  'function A0(s){fetch("/api/tasks",{cache:"no-store"}).then(function(r){return r.ok?r.json():null}).then(function(fresh){var payload=s;if(fresh&&Array.isArray(fresh)){var fm={};fresh.forEach(function(t){fm[t.id]=t});payload=s.map(function(t){var sv=fm[t.id];if(sv){var sLen=(sv.timeEvents||[]).length;var lLen=(t.timeEvents||[]).length;var _mt=lLen>=sLen?t.timeEvents||[]:sv.timeEvents;var _sr={"Not Started":0,"In Progress":1,"Paused":2,"Rework":2,"Ended":3,"Completed":3,"Approved":3};var _me=(_sr[t.executionState]||0)>(_sr[sv.executionState]||0)?t.executionState:sv.executionState;return Object.assign({},t,{timeEvents:_mt,executionState:_me,currentOwner:sv.currentOwner,seoQcStatus:sv.seoQcStatus,contentStatus:sv.contentStatus,webStatus:sv.webStatus,isCompleted:sv.isCompleted,assignedTo:sv.assignedTo,seoOwner:sv.seoOwner,contentOwner:sv.contentOwner,webOwner:sv.webOwner,qcReviews:sv.qcReviews,reworkEntries:sv.reworkEntries});}return t;})}return fetch("/api/tasks",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)})}).catch(function(d){console.error("Failed to save tasks:",d)})}',

  // REPLACEMENT — dirty-track per-task saves
  // _dtSnap: snapshots all scalar user-editable fields for change detection.
  // Excludes timeEvents/qcReviews/reworkEntries (child arrays have own endpoints
  // but are still sent in the full PUT body so they're always persisted).
  'function _dtSnap(t){' +
    'return JSON.stringify([' +
      't.id,t.title,t.client,t.focusedKw,t.volume,t.marRank,t.currentRank,' +
      't.estHours,t.estHoursSEO,t.estHoursContent,t.estHoursWeb,' +
      't.estHoursContentRework,t.estHoursSEOReview,t.actualHours,' +
      't.contentAssignedDate,t.contentOwner,t.contentStatus,' +
      't.webAssignedDate,t.webOwner,t.webStatus,t.targetUrl,' +
      't.currentOwner,t.daysInStage,t.remarks,t.isCompleted,' +
      't.executionState,t.docUrl,t.deptType,t.taskType,t.platform,' +
      't.deliverableUrl,t.dueDate,t.assignedTo,t.adBudget,' +
      't.qcSubmittedAt,t.seoOwner,t.seoStage,t.seoQcStatus,t.intakeDate' +
    ']);' +
  '}' +
  'function A0(s){' +
    // First call after page load: just snapshot, don't re-save (already in DB)
    'if(_dtSnapshot===null){' +
      '_dtSnapshot={};' +
      's.forEach(function(t){_dtSnapshot[t.id]=_dtSnap(t);});' +
      'return;' +
    '}' +
    // Subsequent calls: save only tasks that actually changed
    's.forEach(function(t){' +
      'var _snap=_dtSnap(t);' +
      // Changed if: snapshot differs (modified field) OR task is new (not in snapshot yet)
      'if(_dtSnapshot[t.id]!==_snap){' +
        '(function(_s,_t){' +
          '_saveTaskById(_t).then(function(resp){' +
            // Only update snapshot on HTTP success (resp exists and is not an error)
            // On failure: snapshot stays old → task detected as dirty again → auto-retry
            'if(resp&&resp.ok!==false){_dtSnapshot[_t.id]=_s;}' +
          '}).catch(function(){' +
            // Network error: snapshot not updated → will retry next A0
          '});' +
        '})(_snap,t);' +
      '}' +
    '});' +
  '}',

  'Replace A0 bulk-save with dirty-track per-task saves (eliminates stale overwrites + DB lock pressure)'
);

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 3 — Remove global _pendingSaves guard from A0 debounce
// ─────────────────────────────────────────────────────────────────────────────
// Old guard: if ANY task has a pending save → skip A0 entirely.
// This meant Task Y's changes were silently not saved while Task X was saving.
//
// With the new A0 (dirty-track):
//   - _saveTaskById itself debounces per task via _pendingSaves[taskId] key
//   - If Task X is in-flight: _saveTaskById returns Promise.resolve() immediately
//   - Task Y is independent → its _saveTaskById fires normally
//
// The global guard is no longer needed. Remove it.
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  // ANCHOR — global _pendingSaves guard + A0 call inside debounce timeout
  'if(typeof _pendingSaves!=="undefined"&&Object.keys(_pendingSaves).length>0){ke.current=void 0;return}A0(d);',

  // REPLACEMENT — just call A0 directly (per-task dedup is inside _saveTaskById)
  'A0(d);',

  'Remove global _pendingSaves guard from debounce (per-task dedup now in _saveTaskById)'
);

// ── Write patched bundle ──────────────────────────────────────────────────────
fs.writeFileSync(BUNDLE, code, 'utf-8');

console.log(`\n✅ ${changeCount} patch(es) applied successfully.`);
console.log(`Size after:    ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);
console.log('\nWhat changed:');
console.log('  1. _dtSnapshot global added: tracks last-saved state per task.');
console.log('  2. A0 replaced with dirty-track saves:');
console.log('     - First run: snapshots all tasks (no writes — already in DB)');
console.log('     - Subsequent runs: only saves tasks whose state changed');
console.log('     - On save success: snapshot updated');
console.log('     - On save failure: snapshot NOT updated → auto-retry next A0');
console.log('     - No more GET /api/tasks before save (no merge race)');
console.log('     - No more PUT /api/tasks with all 1000 tasks (no stale overwrites)');
console.log('     - No more rank guard blocking handoff executionState resets');
console.log('  3. Global _pendingSaves guard removed from debounce:');
console.log('     - Per-task dedup is now inside _saveTaskById (_pendingSaves[taskId])');
console.log('     - Multiple tasks can save in parallel without blocking each other');
