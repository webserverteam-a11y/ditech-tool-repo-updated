#!/usr/bin/env node
/**
 * scripts/patch-a0-merge-fix.js  (V2.0)
 *
 * THE REAL ROOT CAUSE FIX — A0 bulk-save merge overwrites other users' data
 * ──────────────────────────────────────────────────────────────────────────
 *
 * WHY THE PREVIOUS FIX WASN'T ENOUGH
 * ────────────────────────────────────
 * The previous patch (patch-concurrency-fix.js V1.0) added _saveTaskById()
 * to the $e End Job handler. This ensures the current user's own task gets
 * written to DB immediately. BUT 1200ms later, A0 (the bulk-save) fires and
 * iterates over the entire local task list. For tasks owned by OTHER users,
 * the current user has STALE local state (before the other user's action).
 *
 * The bug is in A0's merge:
 *
 *   payload = s.map(function(t) {
 *     var sv = fm[t.id];           // sv = fresh server version
 *     if (sv) {
 *       return Object.assign({}, t, {   // ← 't' (LOCAL stale) as base!
 *         timeEvents: merged
 *       });
 *     }
 *     return t;
 *   });
 *
 * Object.assign({}, t, {...}) means ALL fields NOT explicitly overridden
 * come from 't' (local state). For User B's task, 't' is User A's stale
 * snapshot. So fields like currentOwner, executionState, seoQcStatus,
 * contentStatus, webStatus, seoOwner, contentOwner, webOwner, assignedTo,
 * qcReviews, reworkEntries all come from stale local data → OVERWRITING
 * User B's just-committed changes in the database.
 *
 * CONCRETE SCENARIO
 * ──────────────────
 * t=0:    User A has local state: Task B = {executionState:"In Progress", currentOwner:"SEO"}
 * t=200ms: User B clicks End Job on Task B → _saveTaskById → DB updated:
 *          Task B = {executionState:"Not Started", currentOwner:"Content", contentStatus:"Assigned"}
 * t=1200ms: User A's debounce fires → A0 runs
 *   - Fetches fresh: gets Task B correctly from server ✓
 *   - But: Object.assign({}, t_A_stale, {timeEvents:merged})
 *   - t_A_stale.currentOwner = "SEO" (old!)
 *   - t_A_stale.executionState = "In Progress" (old!)
 *   - Result: writes back WRONG data for Task B to DB ✗
 *
 * THE FIX (this patch)
 * ─────────────────────
 * Change A0's merge to use the SERVER version as base for all
 * assignment/status fields, while keeping LOCAL values for inline-editable
 * fields (title, remarks, estHours, etc.) to preserve unsaved text edits.
 *
 * New merge:
 *   return Object.assign({}, t, {
 *     timeEvents:    mergedTe,                      // keep local if more
 *     executionState: highestRank(t, sv),            // rank-based winner
 *     currentOwner:  sv.currentOwner,               // ← server wins
 *     seoQcStatus:   sv.seoQcStatus,                // ← server wins
 *     contentStatus: sv.contentStatus,              // ← server wins
 *     webStatus:     sv.webStatus,                  // ← server wins
 *     isCompleted:   sv.isCompleted,                // ← server wins
 *     assignedTo:    sv.assignedTo,                 // ← server wins
 *     seoOwner:      sv.seoOwner,                   // ← server wins
 *     contentOwner:  sv.contentOwner,               // ← server wins
 *     webOwner:      sv.webOwner,                   // ← server wins
 *     qcReviews:     sv.qcReviews,                  // ← server wins (all reviews)
 *     reworkEntries: sv.reworkEntries,              // ← server wins
 *   });
 *
 * Why this is safe:
 *  - By the time A0 runs, _saveTaskById has already completed for the
 *    current user's own tasks (A0 is blocked by _pendingSaves guard while
 *    _saveTaskById is in flight). So sv (fresh) already has the current
 *    user's correct assignment changes.
 *  - Other users' tasks: sv has their fresh data → preserved ✓
 *  - Inline edits (title, remarks, estHours): 't' is base → preserved ✓
 *  - timeEvents: local wins if more → uncommitted timer events preserved ✓
 *  - executionState: rank-based → highest state wins ✓
 *
 * Idempotent: re-running detects the V2.0 marker and exits cleanly.
 * Creates a timestamped backup before writing.
 *
 * Usage:
 *   node scripts/patch-a0-merge-fix.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(REPO_ROOT, 'dist', 'assets');
const INDEX_HTML = path.join(REPO_ROOT, 'dist', 'index.html');

function die(msg) {
  console.error(`\nERROR: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(INDEX_HTML)) die(`${INDEX_HTML} not found.`);
if (!fs.existsSync(ASSETS_DIR)) die(`${ASSETS_DIR} not found.`);

const html = fs.readFileSync(INDEX_HTML, 'utf-8');
const m = html.match(/index-[A-Za-z0-9_-]+\.js/);
if (!m) die('Could not find bundle reference in dist/index.html');
const BUNDLE = path.join(ASSETS_DIR, m[0]);
if (!fs.existsSync(BUNDLE)) die(`${BUNDLE} not found.`);

console.log(`\nTarget bundle: ${BUNDLE}`);
console.log(`Size before:   ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);

let code = fs.readFileSync(BUNDLE, 'utf-8');

// ── Idempotency ───────────────────────────────────────────────────────────────
const MARKER = '/*A0_MERGE_FIX_V2_0_APPLIED*/';
if (code.includes(MARKER)) {
  console.log('\nAlready patched (V2.0 marker found). Nothing to do.');
  process.exit(0);
}

let changeCount = 0;

function rep(oldStr, newStr, label) {
  const parts = code.split(oldStr);
  if (parts.length !== 2) {
    if (parts.length === 1) die(`[${label}]: anchor NOT found. Bundle may have been rebuilt — re-run the build first.`);
    die(`[${label}]: anchor matched ${parts.length - 1} times (expected 1). Aborting.`);
  }
  code = parts[0] + newStr + parts[1];
  changeCount++;
  console.log(`  ✔ ${label}`);
}

// ── Backup ────────────────────────────────────────────────────────────────────
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backup = BUNDLE.replace('.js', `.bak-a0merge-${ts}.js`);
fs.copyFileSync(BUNDLE, backup);
console.log(`\nBackup: ${path.basename(backup)}\n`);

console.log('Applying patches...\n');

// ── Insert marker ─────────────────────────────────────────────────────────────
rep(
  '/*CONCURRENCY_FIX_V1_0_APPLIED*/',
  `/*CONCURRENCY_FIX_V1_0_APPLIED*/${MARKER}`,
  'Insert V2.0 idempotency marker'
);

// ═══════════════════════════════════════════════════════════════════════════════
// THE MAIN FIX — A0 bulk-save merge
// ─────────────────────────────────────────────────────────────────────────────
// OLD: Object.assign({},t,{timeEvents:...})
//       ↑ 't' (local) as base → ALL other fields come from local stale state
//
// NEW: Object.assign({},t,{timeEvents:..., <all assignment fields from sv>})
//       ↑ Still uses 't' as base (preserves inline edits to title/remarks/etc.)
//       ↑ But explicitly OVERRIDES every assignment/status field with fresh sv
//
// This prevents User A's stale local state from overwriting User B's changes
// while still preserving User A's own inline text edits that haven't been
// saved to DB yet (those are non-assignment scalar fields).
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  // EXACT current merge string (verified unique in file)
  'payload=s.map(function(t){var sv=fm[t.id];if(sv){var sLen=(sv.timeEvents||[]).length;var lLen=(t.timeEvents||[]).length;return Object.assign({},t,{timeEvents:lLen>=sLen?t.timeEvents||[]:sv.timeEvents})}return t})',

  // NEW merge: override all assignment/status fields with server (sv) values
  'payload=s.map(function(t){' +
    'var sv=fm[t.id];' +
    'if(sv){' +
      'var sLen=(sv.timeEvents||[]).length;' +
      'var lLen=(t.timeEvents||[]).length;' +
      // Merge timeEvents: keep local if it has more (uncommitted timer events)
      'var _mt=lLen>=sLen?t.timeEvents||[]:sv.timeEvents;' +
      // executionState: keep the higher-ranked state (protects against stale bulk-save
      // downgrading a state that was just set by a timer click on slow network)
      'var _sr={"Not Started":0,"In Progress":1,"Paused":2,"Rework":2,"Ended":3,"Completed":3,"Approved":3};' +
      'var _me=(_sr[t.executionState]||0)>(_sr[sv.executionState]||0)?t.executionState:sv.executionState;' +
      // Return: local as base (preserves title/remarks/estHours/etc. inline edits)
      // but override every assignment/status field with fresh server value
      'return Object.assign({},t,{' +
        'timeEvents:_mt,' +
        'executionState:_me,' +
        // ↓ ALL of these come from server to prevent multi-user clobbering ↓
        'currentOwner:sv.currentOwner,' +
        'seoQcStatus:sv.seoQcStatus,' +
        'contentStatus:sv.contentStatus,' +
        'webStatus:sv.webStatus,' +
        'isCompleted:sv.isCompleted,' +
        'assignedTo:sv.assignedTo,' +
        'seoOwner:sv.seoOwner,' +
        'contentOwner:sv.contentOwner,' +
        'webOwner:sv.webOwner,' +
        // Child arrays: always trust server (INSERT IGNORE / upsert-only on backend
        // means server always has the superset of all users' submitted records)
        'qcReviews:sv.qcReviews,' +
        'reworkEntries:sv.reworkEntries' +
      '});' +
    '}' +
    'return t;' +  // task not in DB yet (pending first save): keep local as-is
  '})',

  'Fix: A0 merge now takes assignment/status fields from server (prevents multi-user overwrite)'
);

// ── Write patched bundle ───────────────────────────────────────────────────────
fs.writeFileSync(BUNDLE, code, 'utf-8');

console.log(`\n✅ ${changeCount} patch(es) applied.`);
console.log(`Size after:    ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);
console.log('\nWhat changed:');
console.log('  A0 merge now uses server (fresh) values for all assignment and');
console.log('  status fields: currentOwner, executionState, seoQcStatus,');
console.log('  contentStatus, webStatus, isCompleted, assignedTo, seoOwner,');
console.log('  contentOwner, webOwner, qcReviews, reworkEntries.');
console.log('  Local state is still used as base (preserves inline text edits).');
console.log('  timeEvents: local wins if more. executionState: rank-based winner.');
