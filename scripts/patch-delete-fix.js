#!/usr/bin/env node
/**
 * scripts/patch-delete-fix.js  (V1.0)
 *
 * Fixes task deletion not persisting to the database.
 *
 * ROOT CAUSE:
 *   All three delete handlers (single-task, bulk, batch-upload-remove) only
 *   removed tasks from React state — they never called DELETE /api/tasks/:id.
 *   Tasks appeared deleted in the UI within a session, but remained in the DB.
 *   On page refresh or when another user opened the app, deleted tasks returned.
 *
 * THREE HANDLERS FIXED:
 *
 *   1. Pe — single task delete ("Delete this task?" dialog)
 *      Adds: fetch DELETE /api/tasks/:id  (deletes from DB)
 *      Adds: delete _dtSnapshot[C]        (see undo logic below)
 *
 *   2. be — bulk delete (multi-select checkbox delete)
 *      Adds: K.forEach → fetch DELETE for each selected task ID
 *      Adds: delete _dtSnapshot[id] for each
 *
 *   3. ge — batch upload remove ("Remove batch" dialog)
 *      Adds: C.taskIds.forEach → fetch DELETE for each task in the batch
 *      Adds: delete _dtSnapshot[id] for each
 *
 * UNDO COMPATIBILITY:
 *   The 30-second undo mechanism (y() → ze snapshot → d(ze) restore) is fully
 *   preserved. Here's how undo still works after this patch:
 *
 *   When a task is deleted:
 *     1. y(description) captures current tasks as ze (includes the deleted task)
 *     2. fetch DELETE fires (task removed from DB)
 *     3. delete _dtSnapshot[id] — marks task as UNKNOWN to dirty-tracking
 *     4. d(filter) removes task from React state (UI shows deletion)
 *
 *   When user clicks Undo (within 30 seconds):
 *     1. d(ze) restores previous tasks state — deleted task reappears in UI
 *     2. useEffect([d]) fires → _latestTasks=d (includes restored task)
 *     3. Debounce fires → A0(d)
 *     4. _dtSnapshot[id] is undefined (we deleted it in step 3 above)
 *     5. _dtSnap(task) !== undefined → task detected as DIRTY
 *     6. _saveTaskById(task) fires → PUT /api/tasks/:id → task RE-CREATED in DB
 *     7. On success: _dtSnapshot[id] = snap → snapshot updated
 *
 *   The dirty-track mechanism (from patch-dirty-track-save.js) automatically
 *   handles undo re-creation. No changes to the undo handler are needed.
 *
 * HANDLERS NOT TOUCHED:
 *   - Restore from backup (d(ce))     — not a delete operation
 *   - Undo last action (d(ze))        — undo handler, works via dirty-track
 *   - CSV upload confirm (d([...ee])) — adds tasks, not a delete
 *   - Cancel upload discard           — clears in-memory state only
 *
 * Idempotent: re-running detects the V1.0 marker and exits cleanly.
 * Creates a timestamped backup before writing.
 *
 * Apply order: run AFTER patch-visibility-flush.js
 * Usage: node scripts/patch-delete-fix.js
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
const MARKER = '/*TASK_DELETE_FIX_V1_0_APPLIED*/';
if (code.includes(MARKER)) {
  console.log('\nAlready patched (V1.0 marker found). Nothing to do.');
  process.exit(0);
}

if (!code.includes('/*VISIBILITY_FLUSH_V1_0_APPLIED*/')) {
  die('patch-visibility-flush.js must be applied before this patch.\n' +
      'Run: node scripts/patch-visibility-flush.js');
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
const backup = BUNDLE.replace('.js', `.bak-delete-fix-${ts}.js`);
fs.copyFileSync(BUNDLE, backup);
console.log(`\nBackup: ${path.basename(backup)}\n`);
console.log('Applying patches...\n');

// ── 1. Insert idempotency marker ──────────────────────────────────────────────
rep(
  '/*VISIBILITY_FLUSH_V1_0_APPLIED*/',
  '/*VISIBILITY_FLUSH_V1_0_APPLIED*/' + MARKER,
  'Insert V1.0 idempotency marker'
);

// ── Helper: DELETE fetch + _dtSnapshot removal (inlined per handler) ──────────
// Shared logic per task ID:
//   fetch("/api/tasks/"+encodeURIComponent(id),{method:"DELETE"}).catch(fn)
//   typeof _dtSnapshot!=="undefined"&&_dtSnapshot&&(delete _dtSnapshot[id])
//
// Fire-and-forget: .catch() swallows network errors silently.
// _dtSnapshot guard: safe to call even if patch-dirty-track-save wasn't applied
// (typeof check prevents ReferenceError on undefined global).

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 1 — Single task delete (Pe handler)
// ─────────────────────────────────────────────────────────────────────────────
// C = single task ID (string, captured in Pe's closure)
//
// Inserted AFTER y() captures the undo snapshot but BEFORE d(filter) removes
// from state. Order matters for undo:
//   y()         → ze = [...s] includes C (task still in state at this point)
//   fetch DELETE → task deleted from DB
//   delete _dtSnapshot[C] → dirty-track will auto-re-save if undo fires
//   d(filter)   → task removed from UI
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  // ANCHOR — unique in bundle (verified)
  'onConfirm:()=>{y(`Deleted task: ${(M==null?void 0:M.title)||C}`),d(_=>_.filter(Ke=>Ke.id!==C)),Be(null)}}',

  // REPLACEMENT — add DELETE + _dtSnapshot removal before the state filter
  'onConfirm:()=>{' +
    'y(`Deleted task: ${(M==null?void 0:M.title)||C}`),' +
    'fetch("/api/tasks/"+encodeURIComponent(C),{method:"DELETE"}).catch(function(){}),' +
    'typeof _dtSnapshot!=="undefined"&&_dtSnapshot&&(delete _dtSnapshot[C]),' +
    'd(_=>_.filter(Ke=>Ke.id!==C)),' +
    'Be(null)' +
  '}}',

  'Fix single-task delete: add DELETE /api/tasks/:id + _dtSnapshot removal'
);

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 2 — Bulk delete (be handler)
// ─────────────────────────────────────────────────────────────────────────────
// K = Set of selected task IDs (Set.prototype.forEach iterates values)
//
// forEach fires DELETE for each selected ID. Parallel fetch calls — each is
// independent and fire-and-forget. The DB backend handles concurrent single-task
// DELETEs safely (each runs in its own transaction).
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  // ANCHOR — unique in bundle (verified)
  'onConfirm:()=>{y(`Bulk delete of ${K.size} tasks`),d(C=>C.filter(M=>!K.has(M.id))),ue(new Set),Be(null)}}',

  // REPLACEMENT — iterate K (Set), DELETE each, remove from _dtSnapshot
  'onConfirm:()=>{' +
    'y(`Bulk delete of ${K.size} tasks`),' +
    'K.forEach(function(id){' +
      'fetch("/api/tasks/"+encodeURIComponent(id),{method:"DELETE"}).catch(function(){});' +
      'typeof _dtSnapshot!=="undefined"&&_dtSnapshot&&(delete _dtSnapshot[id]);' +
    '}),' +
    'd(C=>C.filter(M=>!K.has(M.id))),' +
    'ue(new Set),' +
    'Be(null)' +
  '}}',

  'Fix bulk delete: add DELETE /api/tasks/:id for each selected task'
);

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 3 — Batch upload remove (ge handler)
// ─────────────────────────────────────────────────────────────────────────────
// C = upload batch object { uploadedBy, timestamp, taskCount, taskIds: string[] }
// C.taskIds = array of task ID strings belonging to this upload batch
//
// Parallel DELETE calls for all tasks in the batch. Also removes the batch
// entry from upload history (P state setter — unchanged).
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  // ANCHOR — unique in bundle (verified)
  'onConfirm:()=>{y(`Removed batch upload by ${C.uploadedBy}`),d(M=>M.filter(_=>!C.taskIds.includes(_.id))),P(M=>M.filter(_=>_.id!==C.id)),Be(null)}}',

  // REPLACEMENT — iterate C.taskIds (Array), DELETE each, remove from _dtSnapshot
  'onConfirm:()=>{' +
    'y(`Removed batch upload by ${C.uploadedBy}`),' +
    'C.taskIds.forEach(function(id){' +
      'fetch("/api/tasks/"+encodeURIComponent(id),{method:"DELETE"}).catch(function(){});' +
      'typeof _dtSnapshot!=="undefined"&&_dtSnapshot&&(delete _dtSnapshot[id]);' +
    '}),' +
    'd(M=>M.filter(_=>!C.taskIds.includes(_.id))),' +
    'P(M=>M.filter(_=>_.id!==C.id)),' +
    'Be(null)' +
  '}}',

  'Fix batch upload remove: add DELETE /api/tasks/:id for each task in batch'
);

// ── Write patched bundle ──────────────────────────────────────────────────────
fs.writeFileSync(BUNDLE, code, 'utf-8');

console.log(`\n✅ ${changeCount} patch(es) applied successfully.`);
console.log(`Size after:    ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);
console.log('\nWhat changed:');
console.log('  1. Single task delete: now calls DELETE /api/tasks/:id + clears _dtSnapshot entry');
console.log('     Undo: d(ze) restores task to UI → dirty-track detects it as new → auto-saves to DB');
console.log('  2. Bulk delete: now calls DELETE /api/tasks/:id for each selected task (parallel)');
console.log('     Undo restores all selected tasks; each auto-saved back to DB via dirty-track');
console.log('  3. Batch upload remove: now calls DELETE /api/tasks/:id for each task in batch');
console.log('     Undo restores all batch tasks; each auto-saved back to DB via dirty-track');
console.log('\nHandlers NOT touched (confirmed safe):');
console.log('  - Restore from backup (d(ce))');
console.log('  - Undo last action (d(ze))');
console.log('  - CSV upload confirm');
console.log('  - Cancel upload discard');
