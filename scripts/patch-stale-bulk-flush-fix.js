#!/usr/bin/env node
/**
 * scripts/patch-stale-bulk-flush-fix.js  (V1.0)
 *
 * Fixes tasks silently flipping to Ended / Approved / Completed with nobody
 * having clicked anything ("auto-ended tasks").
 *
 * ROOT CAUSE
 * ──────────
 * patch-dirty-track-save.js replaced A0() with per-task dirty-tracked saves,
 * so the 1200ms debounce no longer writes the whole task list. But the FLUSH
 * path P() — the beforeunload / visibilitychange handler — was never
 * converted and still does:
 *
 *   fetch("/api/tasks", {method:"PUT", body: JSON.stringify(K.current), keepalive:true})
 *
 * K.current is a ref to the ENTIRE local task array. So every time a user
 * closes the tab, reloads, or switches away from and back to the tab, their
 * browser writes its full local copy of all ~4,500 tasks to the DB —
 * including every task they never touched.
 *
 * That local copy is only as fresh as the last 30s poll, and the poll skips
 * entirely whenever _pendingSaves is non-empty. So any task another user
 * changed in that window gets overwritten with this browser's older copy.
 * When the older copy says "Ended"/"Approved", the task is silently reverted
 * to a terminal state — with no `end` time event and no audit entry, because
 * no handler ran.
 *
 * EVIDENCE (production dump u877454648_ditech_tool, 4,515 tasks)
 * ───────────────────────────────────────────────────────────────
 * MySQL's ON UPDATE CURRENT_TIMESTAMP only bumps updated_at for rows whose
 * values actually changed, so each stale bulk flush leaves a fingerprint: a
 * cluster of tasks sharing one updated_at second. 65 such clusters exist.
 * Checking the terminal-state ones against both task_time_events and
 * audit_logs (±10 min):
 *
 *   2026-09-07 06:43:21    93 tasks → Approved   93 with no end event, no audit
 *   2026-04-03 13:03:09    42 tasks → Ended      42 with no end event, no audit
 *   2026-08-30 10:58:45    41 tasks → Ended      41 with no end event, no audit
 *   2026-05-06 15:14:37    35 tasks → Ended      35 with no end event, no audit
 *   2026-09-04 05:53:17    25 tasks → Ended      25 with no end event, no audit
 *   ... 19 of 20 clusters show zero user evidence (~440 tasks total)
 *
 * FIX
 * ───
 * Make P() flush the same way the pagehide handler directly above it already
 * does: send only tasks whose _dtSnap() differs from _dtSnapshot, one
 * per-task PUT each. Tasks the user never modified are never transmitted, so
 * they can no longer be clobbered by a stale local copy.
 *
 * Also drops the `A0(k0)` fallback on the initial load. If GET /api/tasks
 * ever returns empty or fails, that call writes the 15 hardcoded demo tasks
 * (T-001 "Blog Post Optimization", etc.) into the production DB.
 *
 * Idempotent: re-running detects the V1.0 marker and exits cleanly.
 * Creates a timestamped backup before writing.
 *
 * Apply order: run AFTER patch-dirty-track-save.js (needs _dtSnap/_dtSnapshot).
 * Usage: node scripts/patch-stale-bulk-flush-fix.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
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
const MARKER = '/*STALE_BULK_FLUSH_FIX_V1_0_APPLIED*/';
if (code.includes(MARKER)) {
  console.log('\nAlready patched (V1.0 marker found). Nothing to do.');
  process.exit(0);
}

// Requires the dirty-track machinery this patch reuses
if (!code.includes('/*DIRTY_TRACK_SAVE_V1_0_APPLIED*/')) {
  die('patch-dirty-track-save.js must be applied before this patch.\n' +
      'Run: node scripts/patch-dirty-track-save.js');
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
const backup = BUNDLE.replace('.js', `.bak-stale-flush-${ts}.js`);
fs.copyFileSync(BUNDLE, backup);
console.log(`\nBackup: ${path.basename(backup)}\n`);
console.log('Applying patches...\n');

// ── 1. Insert idempotency marker ──────────────────────────────────────────────
rep(
  '/*DIRTY_TRACK_SAVE_V1_0_APPLIED*/',
  '/*DIRTY_TRACK_SAVE_V1_0_APPLIED*/' + MARKER,
  'Insert V1.0 idempotency marker'
);

// ═══════════════════════════════════════════════════════════════════════════════
// 2. MAIN FIX — P() flush: whole-list PUT → dirty-only per-task PUTs
// ─────────────────────────────────────────────────────────────────────────────
// OLD: one PUT /api/tasks carrying all ~4,500 tasks from local state
// NEW: one PUT /api/tasks/:id per task that this browser actually changed
//
// Mirrors the pagehide handler's existing filter exactly:
//   _latestTasks.filter(t => _dtSnapshot[t.id] !== _dtSnap(t))
//
// _dtSnapshot===null means the first A0() snapshot has not been taken yet, so
// nothing on screen is known-clean — in that state we send nothing rather than
// guessing, which matches the pagehide handler's early return.
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  'fetch("/api/tasks",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(K.current),keepalive:!0}).catch(()=>{})',

  '(function(){' +
    'try{' +
      'if(typeof _dtSnapshot==="undefined"||_dtSnapshot===null)return;' +
      'var _dirty=(K.current||[]).filter(function(t){' +
        'return t&&t.id&&_dtSnapshot[t.id]!==_dtSnap(t);' +
      '});' +
      '_dirty.forEach(function(t){' +
        'fetch("/api/tasks/"+encodeURIComponent(t.id),{' +
          'method:"PUT",' +
          'headers:{"Content-Type":"application/json"},' +
          'body:JSON.stringify(t),' +
          'keepalive:!0' +
        '}).catch(function(){});' +
      '});' +
    '}catch(e){}' +
  '})()',

  'Fix: flush P() now sends only dirty tasks (was: whole local list, clobbering other users)'
);

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Remove the demo-seed write on empty/failed initial load
// ─────────────────────────────────────────────────────────────────────────────
// `Re&&Re.length>0 ? p(Re) : A0(k0)` — the else branch feeds the hardcoded k0
// demo task list to A0(), which on any call after the first writes those 15
// placeholder tasks into the production DB. An empty or failed load should
// change nothing.
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  'Re&&Re.length>0?p(Re):A0(k0)',
  'Re&&Re.length>0?p(Re):void 0',
  'Fix: empty/failed task load no longer writes the k0 demo tasks to the DB'
);

// ── Write patched bundle ──────────────────────────────────────────────────────
fs.writeFileSync(BUNDLE, code, 'utf-8');

console.log(`\n✅ ${changeCount} patch(es) applied successfully.`);
console.log(`Size after:    ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);
console.log('\nWhat changed:');
console.log('  1. The beforeunload/visibilitychange flush no longer PUTs the whole');
console.log('     local task list. It sends one per-task PUT for each task this');
console.log('     browser actually modified, matching the pagehide handler.');
console.log('     Tasks the user never touched are never transmitted, so a stale');
console.log('     tab can no longer revert other users\' tasks to Ended/Approved.');
console.log('  2. A failed or empty GET /api/tasks no longer seeds the DB with the');
console.log('     built-in k0 demo tasks.');
