#!/usr/bin/env node
/**
 * scripts/patch-poll-merge-fix.js  (V1.0)
 *
 * Fixes the 30-second background poll overwriting in-flight task saves.
 *
 * ROOT CAUSE:
 *   The poll checks _pendingSaves at the moment the 30-second timer FIRES,
 *   then starts a GET /api/tasks fetch that takes 200-600ms to return.
 *   The actual state merge runs AFTER the response arrives — not at fire time.
 *
 *   Race timeline:
 *     t=0ms    Poll fires → _pendingSaves empty → GET /api/tasks starts
 *     t=50ms   User assigns task X → local state updated → _saveTaskById fires
 *                → _pendingSaves["taskX_..."] = 1
 *     t=600ms  Poll GET returns OLD server data (fetched before save landed)
 *              → p(cur => merge()) runs
 *              → cur.taskX  = { currentOwner: "Content" }  (local — NEW)
 *              → _pTasks.taskX = { currentOwner: "SEO" }   (server — OLD)
 *              → merge picks server (timeEvents same count) → REVERTS assignment
 *     t=800ms  A0 debounce fires → sees reverted local state → writes old
 *              assignment back to DB → task fully reverted in DB
 *
 *   The poll only checked _pendingSaves at fire time. By merge time the save
 *   was already in flight — but the check was long gone.
 *
 * FIX:
 *   Inside the merge map callback (which runs AFTER the fetch completes),
 *   check _pendingSaves per task before applying server state. Handles both
 *   key formats:
 *     - Old format: "taskId_timestamp_random"  (pre patch-pending-saves-key-fix)
 *     - New format: "taskId"                   (post patch-pending-saves-key-fix)
 *
 *   If the task has a save in flight → keep local state unchanged.
 *   If no save in flight → apply server state as before.
 *
 * Idempotent: re-running detects the V1.0 marker and exits cleanly.
 * Creates a timestamped backup before writing.
 *
 * Apply order: run AFTER patch-action-board-handoff-fix.js
 * Usage: node scripts/patch-poll-merge-fix.js
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
const MARKER = '/*POLL_MERGE_FIX_V1_0_APPLIED*/';
if (code.includes(MARKER)) {
  console.log('\nAlready patched (V1.0 marker found). Nothing to do.');
  process.exit(0);
}

// Require previous patch to be applied first
if (!code.includes('/*ACTION_BOARD_HANDOFF_FIX_V1_0_APPLIED*/')) {
  die('patch-action-board-handoff-fix.js must be applied before this patch.\n' +
      'Run: node scripts/patch-action-board-handoff-fix.js');
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
const backup = BUNDLE.replace('.js', `.bak-poll-merge-${ts}.js`);
fs.copyFileSync(BUNDLE, backup);
console.log(`\nBackup: ${path.basename(backup)}\n`);
console.log('Applying patches...\n');

// ── 1. Insert idempotency marker ──────────────────────────────────────────────
rep(
  '/*ACTION_BOARD_HANDOFF_FIX_V1_0_APPLIED*/',
  '/*ACTION_BOARD_HANDOFF_FIX_V1_0_APPLIED*/' + MARKER,
  'Insert V1.0 idempotency marker'
);

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN FIX — Poll merge map callback: check _pendingSaves per task
// ─────────────────────────────────────────────────────────────────────────────
//
// OLD merge (blindly applies server state):
//   var merged = cur.map(function(lt) {
//     var st = _sMap[lt.id];
//     if(!st) return lt;
//     return (lt.timeEvents||[]).length > (st.timeEvents||[]).length
//       ? Object.assign({}, st, {timeEvents: lt.timeEvents})
//       : st;   // ← returns full OLD server state, reverts local assignment
//   });
//
// NEW merge (skips tasks with in-flight saves):
//   var merged = cur.map(function(lt) {
//     var st = _sMap[lt.id];
//     if(!st) return lt;
//     var _hp = hasPending(lt.id);   // ← new: check per task
//     if(_hp) return lt;             // ← save in-flight → keep local untouched
//     return (lt.timeEvents||[]).length > (st.timeEvents||[]).length
//       ? Object.assign({}, st, {timeEvents: lt.timeEvents})
//       : st;
//   });
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  // ANCHOR — exact poll merge map callback from live bundle
  'var merged=cur.map(function(lt){var st=_sMap[lt.id];if(!st)return lt;return(lt.timeEvents||[]).length>(st.timeEvents||[]).length?Object.assign({},st,{timeEvents:lt.timeEvents}):st;});',

  // REPLACEMENT — same logic + per-task _pendingSaves check at merge time
  'var merged=cur.map(function(lt){' +
    'var st=_sMap[lt.id];' +
    'if(!st)return lt;' +
    // Check both key formats:
    //   Old: "taskId_timestamp_random"  → indexOf(taskId+"_") === 0
    //   New: "taskId"                   → _pendingSaves[lt.id] directly
    'var _hp=typeof _pendingSaves!=="undefined"&&' +
      '(!!_pendingSaves[lt.id]||' +
      'Object.keys(_pendingSaves).some(function(k){return k.indexOf(lt.id+"_")===0;}));' +
    // Save in-flight for this task → do NOT apply server state
    'if(_hp)return lt;' +
    'return(lt.timeEvents||[]).length>(st.timeEvents||[]).length' +
      '?Object.assign({},st,{timeEvents:lt.timeEvents})' +
      ':st;' +
  '});',

  'Fix: poll merge now checks _pendingSaves per task at merge time (not just at fire time)'
);

// ── Write patched bundle ──────────────────────────────────────────────────────
fs.writeFileSync(BUNDLE, code, 'utf-8');

console.log(`\n✅ ${changeCount} patch(es) applied successfully.`);
console.log(`Size after:    ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);
console.log('\nWhat changed:');
console.log('  The 30-second poll merge now checks _pendingSaves per task inside');
console.log('  the merge callback — not just at the moment the timer fires.');
console.log('  Tasks with in-flight saves are kept as local state; old server');
console.log('  data from the poll fetch is discarded for those tasks.');
console.log('  This closes the race window that caused assignment reverts.');
