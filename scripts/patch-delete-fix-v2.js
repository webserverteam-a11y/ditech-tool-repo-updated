#!/usr/bin/env node
/**
 * scripts/patch-delete-fix-v2.js  (V2.0)
 *
 * Fixes deleted tasks reappearing in the UI when the 30-second background
 * poll fires before the DELETE /api/tasks/:id request completes.
 *
 * ROOT CAUSE (missed in V1.0):
 *   The poll merge code has a "new tasks from server" block:
 *
 *     var newTasks = _pTasks.filter(st => !cur.find(lt => lt.id === st.id));
 *     return newTasks.length > 0 ? merged.concat(newTasks) : merged;
 *
 *   This was designed to surface tasks added by OTHER users. But it also
 *   re-adds tasks that were DELETED by the current user:
 *
 *     t=0     User deletes task → removed from local state (cur)
 *     t=0+    DELETE /api/tasks/:id fires (async, takes ~100–500ms)
 *     t=1s    Poll fires → server still has the task (DELETE not done)
 *             → task found in _pTasks but NOT in cur
 *             → newTasks includes the deleted task
 *             → merged.concat(newTasks) → task REAPPEARS in UI
 *
 *   Even if DELETE succeeds, any poll that fires within the DELETE round-trip
 *   window causes the reappearance. This explains why deletion was visually
 *   "working" (task left UI) but came back within 30 seconds.
 *
 * THE FIX — Three changes on top of V1.0:
 *
 *   1. _deletedIds global (new Set)
 *      Per-session, per-page-load Set of task IDs that have been explicitly
 *      deleted. Grows during the session; reset on page refresh (which is fine
 *      because by then DELETE should have completed in the DB).
 *
 *   2. Poll merge: exclude _deletedIds from newTasks
 *      Adds `&& !_deletedIds.has(st.id)` to the newTasks filter so that
 *      deleted tasks are never re-added from the server response, regardless
 *      of whether DELETE has completed in the DB yet.
 *
 *   3. Delete handlers: add IDs to _deletedIds
 *      Each of the three delete handlers (single, bulk, batch) adds the
 *      deleted task ID(s) to _deletedIds immediately, before any async work.
 *
 * UNDO COMPATIBILITY:
 *   When undo fires (d(ze)), the task is restored to local state (cur).
 *   The poll merge's cur.find() check then handles it correctly:
 *   - If task is in cur → cur.find() returns truthy → NOT in newTasks
 *     (handled by cur.map() instead — this is the correct path)
 *   _deletedIds is NOT cleaned up on undo. It doesn't need to be:
 *   once the task is back in cur, _deletedIds.has(id) is never reached
 *   because cur.find() already excludes it from newTasks.
 *
 * Idempotent: re-running detects the V2.0 marker and exits cleanly.
 * Creates a timestamped backup before writing.
 *
 * Apply order: run AFTER patch-delete-fix.js (V1.0)
 * Usage: node scripts/patch-delete-fix-v2.js
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
const MARKER = '/*TASK_DELETE_FIX_V2_0_APPLIED*/';
if (code.includes(MARKER)) {
  console.log('\nAlready patched (V2.0 marker found). Nothing to do.');
  process.exit(0);
}

if (!code.includes('/*TASK_DELETE_FIX_V1_0_APPLIED*/')) {
  die('patch-delete-fix.js (V1.0) must be applied before this patch.\n' +
      'Run: node scripts/patch-delete-fix.js');
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
const backup = BUNDLE.replace('.js', `.bak-delete-fix-v2-${ts}.js`);
fs.copyFileSync(BUNDLE, backup);
console.log(`\nBackup: ${path.basename(backup)}\n`);
console.log('Applying patches...\n');

// ── 1. Insert idempotency marker ──────────────────────────────────────────────
rep(
  '/*TASK_DELETE_FIX_V1_0_APPLIED*/',
  '/*TASK_DELETE_FIX_V1_0_APPLIED*/' + MARKER,
  'Insert V2.0 idempotency marker'
);

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 1 — Add _deletedIds global
// ─────────────────────────────────────────────────────────────────────────────
// Appended after _latestTasks in the same globals block injected by V1.0.
// Uses a Set for O(1) has() lookups in the poll merge filter.
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  'var _pendingSaves={};var _dtSnapshot=null;var _latestTasks=null;',
  'var _pendingSaves={};var _dtSnapshot=null;var _latestTasks=null;var _deletedIds=new Set();',
  'Add _deletedIds global (Set to track deleted task IDs)'
);

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 2 — Poll merge: exclude _deletedIds from newTasks re-addition
// ─────────────────────────────────────────────────────────────────────────────
// The original newTasks filter re-adds any server task missing from local
// state. We add a guard: if the ID was explicitly deleted in this session,
// never re-add it from the server response, regardless of poll timing.
//
// Before: !cur.find(lt => lt.id === st.id)
// After:  !cur.find(lt => lt.id === st.id) && !_deletedIds.has(st.id)
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  'var newTasks=_pTasks.filter(function(st){return!cur.find(function(lt){return lt.id===st.id})});return newTasks.length>0?merged.concat(newTasks):merged;',
  'var newTasks=_pTasks.filter(function(st){return!cur.find(function(lt){return lt.id===st.id})&&!(typeof _deletedIds!=="undefined"&&_deletedIds.has(st.id))});return newTasks.length>0?merged.concat(newTasks):merged;',
  'Poll merge: exclude _deletedIds from newTasks re-addition'
);

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 3a — Single task delete: add ID to _deletedIds
// ─────────────────────────────────────────────────────────────────────────────
// Inserted between the _dtSnapshot deletion and the d(filter) call,
// so the ID is in _deletedIds before the task leaves local state and before
// any poll can see the gap.
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  'typeof _dtSnapshot!=="undefined"&&_dtSnapshot&&(delete _dtSnapshot[C]),d(_=>_.filter(Ke=>Ke.id!==C)),Be(null)}}',
  'typeof _dtSnapshot!=="undefined"&&_dtSnapshot&&(delete _dtSnapshot[C]),typeof _deletedIds!=="undefined"&&_deletedIds.add(C),d(_=>_.filter(Ke=>Ke.id!==C)),Be(null)}}',
  'Single delete: add task ID to _deletedIds'
);

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 3b — Bulk delete: add each ID to _deletedIds inside the forEach
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  'K.forEach(function(id){fetch("/api/tasks/"+encodeURIComponent(id),{method:"DELETE"}).catch(function(){});typeof _dtSnapshot!=="undefined"&&_dtSnapshot&&(delete _dtSnapshot[id]);})',
  'K.forEach(function(id){fetch("/api/tasks/"+encodeURIComponent(id),{method:"DELETE"}).catch(function(){});typeof _dtSnapshot!=="undefined"&&_dtSnapshot&&(delete _dtSnapshot[id]);typeof _deletedIds!=="undefined"&&_deletedIds.add(id);})',
  'Bulk delete: add each task ID to _deletedIds'
);

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 3c — Batch upload remove: add each ID to _deletedIds inside the forEach
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  'C.taskIds.forEach(function(id){fetch("/api/tasks/"+encodeURIComponent(id),{method:"DELETE"}).catch(function(){});typeof _dtSnapshot!=="undefined"&&_dtSnapshot&&(delete _dtSnapshot[id]);})',
  'C.taskIds.forEach(function(id){fetch("/api/tasks/"+encodeURIComponent(id),{method:"DELETE"}).catch(function(){});typeof _dtSnapshot!=="undefined"&&_dtSnapshot&&(delete _dtSnapshot[id]);typeof _deletedIds!=="undefined"&&_deletedIds.add(id);})',
  'Batch upload remove: add each task ID to _deletedIds'
);

// ── Write patched bundle ──────────────────────────────────────────────────────
fs.writeFileSync(BUNDLE, code, 'utf-8');

console.log(`\n✅ ${changeCount} patch(es) applied successfully.`);
console.log(`Size after:    ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);
console.log('\nWhat changed:');
console.log('  1. _deletedIds = new Set() — per-session tracker of deleted task IDs');
console.log('  2. Poll merge: newTasks filter now excludes IDs in _deletedIds');
console.log('     → deleted tasks can never be re-inserted by the 30s poll');
console.log('  3. All 3 delete handlers now call _deletedIds.add(id) immediately');
console.log('     → ID is in the Set before the poll can see the gap');
console.log('');
console.log('Undo still works: d(ze) restores task to cur → cur.find() finds it');
console.log('  → _deletedIds check never even reached for in-cur tasks');
