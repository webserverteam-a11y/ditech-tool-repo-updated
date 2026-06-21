#!/usr/bin/env node
/**
 * scripts/patch-pending-saves-key-fix.js  (V1.0)
 *
 * Fixes _pendingSaves key so per-task save deduplication actually works.
 *
 * ROOT CAUSE:
 *   _saveTaskById was designed with a per-task dedup guard:
 *     if(_pendingSaves[_k]) return;   // skip if already saving this task
 *
 *   But the key _k was generated as:
 *     var _k = t.id + "_" + Date.now() + "_" + Math.random();
 *
 *   Because _k is ALWAYS unique (timestamp + random), the guard never
 *   triggers. If _saveTaskById is called twice for the same task in rapid
 *   succession, TWO concurrent PUT /api/tasks/:id requests fire — last one
 *   to land wins (race condition on same task).
 *
 *   Additionally, the poll merge fix (patch-poll-merge-fix.js) added a check:
 *     !!_pendingSaves[lt.id]
 *   which also never matches with the old key format.
 *
 * FIX:
 *   Change _k to just t.id. This makes:
 *     1. Per-task dedup work — second _saveTaskById call for same task
 *        while first is in-flight → skipped immediately via early return.
 *     2. Poll merge fix work correctly — _pendingSaves[lt.id] now matches.
 *     3. A0 debounce per-task guard work correctly (used in dirty-track patch).
 *
 *   The early return now returns Promise.resolve() so callers that chain
 *   .then() don't get a TypeError on undefined.
 *
 * Idempotent: re-running detects the V1.0 marker and exits cleanly.
 * Creates a timestamped backup before writing.
 *
 * Apply order: run AFTER patch-poll-merge-fix.js
 * Usage: node scripts/patch-pending-saves-key-fix.js
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
const MARKER = '/*PENDING_SAVES_KEY_FIX_V1_0_APPLIED*/';
if (code.includes(MARKER)) {
  console.log('\nAlready patched (V1.0 marker found). Nothing to do.');
  process.exit(0);
}

if (!code.includes('/*POLL_MERGE_FIX_V1_0_APPLIED*/')) {
  die('patch-poll-merge-fix.js must be applied before this patch.\n' +
      'Run: node scripts/patch-poll-merge-fix.js');
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
const backup = BUNDLE.replace('.js', `.bak-ps-key-${ts}.js`);
fs.copyFileSync(BUNDLE, backup);
console.log(`\nBackup: ${path.basename(backup)}\n`);
console.log('Applying patches...\n');

// ── 1. Insert idempotency marker ──────────────────────────────────────────────
rep(
  '/*POLL_MERGE_FIX_V1_0_APPLIED*/',
  '/*POLL_MERGE_FIX_V1_0_APPLIED*/' + MARKER,
  'Insert V1.0 idempotency marker'
);

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN FIX — _saveTaskById key: taskId_timestamp_random → taskId
// ─────────────────────────────────────────────────────────────────────────────
//
// OLD (dedup never works — key always unique):
//   function _saveTaskById(t) {
//     var _k = t.id + "_" + Date.now() + "_" + Math.random();
//     _pendingSaves[_k] = 1;
//     return fetch(...)
//   }
//
// NEW (dedup works — same task skipped if already in-flight):
//   function _saveTaskById(t) {
//     var _k = t.id;
//     if(_pendingSaves[_k]) return Promise.resolve();   // already saving this task
//     _pendingSaves[_k] = 1;
//     return fetch(...)
//   }
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  // ANCHOR — exact key generation + pendingSaves set from live bundle
  'var _k=t.id+"_"+Date.now()+"_"+Math.random();_pendingSaves[_k]=1;return fetch("/api/tasks/"+encodeURIComponent(t.id)',

  // REPLACEMENT — simple taskId key + early return if already saving
  'var _k=t.id;' +
  'if(_pendingSaves[_k])return Promise.resolve();' +
  '_pendingSaves[_k]=1;' +
  'return fetch("/api/tasks/"+encodeURIComponent(t.id)',

  'Fix: _pendingSaves key is now taskId only — per-task dedup now works correctly'
);

// ── Write patched bundle ──────────────────────────────────────────────────────
fs.writeFileSync(BUNDLE, code, 'utf-8');

console.log(`\n✅ ${changeCount} patch(es) applied successfully.`);
console.log(`Size after:    ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);
console.log('\nWhat changed:');
console.log('  _saveTaskById now uses taskId as the _pendingSaves key (not taskId_ts_rand).');
console.log('  Calling _saveTaskById twice for the same task while first is in-flight');
console.log('  now correctly skips the second call (returns Promise.resolve()).');
console.log('  The poll merge fix per-task check (!!_pendingSaves[lt.id]) now matches.');
