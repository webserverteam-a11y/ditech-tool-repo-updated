#!/usr/bin/env node
/**
 * scripts/patch-save-base.js  (V1.0)
 *
 * Sends the "last seen from server" field values (`_base`) with every task
 * save, so the server can merge field-by-field instead of overwriting the
 * whole row. Pairs with the stale-write protection in
 * backend/utils/saveTask.js — see saveTaskToDb().
 *
 * WHY
 * ───
 * patch-snapshot-echo-fix.js stopped the known path where every open tab
 * echoed other people's changes back as full-row writes. But any future
 * path that saves a stale copy would reintroduce "tasks ending / reverting by
 * themselves". With `_base`, the server writes only the fields this user
 * actually changed (payload != base), so a stale copy can no longer revert
 * someone else's change — whatever code path the save comes from.
 *
 * The base comes from _dtSnapshot, which the dirty tracker already keeps per
 * task. _dtSnap() stores it as a positional array; SNAP_KEYS below names
 * those positions. The patch verifies _dtSnap() still has exactly that
 * shape before applying, so a rebuilt bundle can't silently misalign fields.
 *
 * Changes:
 *   • _withBase(t)       — attaches _base from _dtSnapshot[t.id] (if any)
 *   • _saveTaskById()    — sends _withBase(t)
 *   • P() flush          — sends _withBase(t)
 *   • _handleSaveConfirm — base is the fresh server copy the edits apply to
 *
 * Idempotent: re-running detects the V1.0 marker and exits cleanly.
 * Creates a timestamped backup before writing.
 *
 * Apply order: run AFTER patch-snapshot-echo-fix.js
 * Usage: node scripts/patch-save-base.js
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
const MARKER = '/*SAVE_BASE_V1_0_APPLIED*/';
if (code.includes(MARKER)) {
  console.log('\nAlready patched (V1.0 marker found). Nothing to do.');
  process.exit(0);
}

if (!code.includes('/*SNAPSHOT_ECHO_FIX_V1_0_APPLIED*/')) {
  die('patch-snapshot-echo-fix.js must be applied before this patch.\n' +
      'Run: node scripts/patch-snapshot-echo-fix.js');
}

// Positional fields of _dtSnap(), in order.
const SNAP_KEYS = [
  'id', 'title', 'client', 'focusedKw', 'volume', 'marRank', 'currentRank',
  'estHours', 'estHoursSEO', 'estHoursContent', 'estHoursWeb',
  'estHoursContentRework', 'estHoursSEOReview', 'actualHours',
  'contentAssignedDate', 'contentOwner', 'contentStatus',
  'webAssignedDate', 'webOwner', 'webStatus', 'targetUrl', 'currentOwner',
  'daysInStage', 'remarks', 'isCompleted', 'executionState', 'docUrl',
  'deptType', 'taskType', 'platform', 'deliverableUrl', 'dueDate',
  'assignedTo', 'adBudget', 'qcSubmittedAt', 'seoOwner', 'seoStage',
  'seoQcStatus', 'intakeDate',
];
const EXPECTED_DTSNAP =
  'function _dtSnap(t){return JSON.stringify([' + SNAP_KEYS.map(k => 't.' + k).join(',') + ']);}';
if (!code.includes(EXPECTED_DTSNAP)) {
  die('_dtSnap() does not have the expected field list — SNAP_KEYS would misalign.\n' +
      'Update SNAP_KEYS in this script to match the bundle.');
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
const backup = BUNDLE.replace('.js', `.bak-save-base-${ts}.js`);
fs.copyFileSync(BUNDLE, backup);
console.log(`\nBackup: ${path.basename(backup)}\n`);
console.log('Applying patches...\n');

// ── 1. Marker + _withBase helper ──────────────────────────────────────────────
rep(
  'function _saveTaskById(t){',
  MARKER +
  'var _SNAP_KEYS=' + JSON.stringify(SNAP_KEYS) + ';' +
  'function _withBase(t){' +
    'var s=_dtSnapshot&&t&&_dtSnapshot[t.id];if(!s)return t;' +
    'try{var a=JSON.parse(s),b={};_SNAP_KEYS.forEach(function(k,i){b[k]=a[i]});' +
    'return Object.assign({},t,{_base:b})}catch(e){return t}}' +
  'function _saveTaskById(t){',
  'Insert marker + _withBase() helper'
);

// ── 2. _saveTaskById sends the base ───────────────────────────────────────────
rep(
  'body:JSON.stringify(t)}).then(function(r){delete _pendingSaves[_k]',
  'body:JSON.stringify(_withBase(t))}).then(function(r){delete _pendingSaves[_k]',
  '_saveTaskById(): send _base'
);

// ── 3. P() unload/visibility flush sends the base ─────────────────────────────
rep(
  'body:JSON.stringify(t),keepalive:!0}',
  'body:JSON.stringify(_withBase(t)),keepalive:!0}',
  'P() flush: send _base'
);

// ── 4. Inline-edit Save: base is the fresh server copy ────────────────────────
rep(
  'var e=Object.assign({},t,_PE[t.id]);return e',
  'var e=Object.assign({},t,_PE[t.id],{_base:t});return e',
  'Inline-edit Save: send _base'
);
// _base must not stay on the tasks put into React state.
rep(
  'merged.forEach(_snapSync);d(merged);',
  'merged=merged.map(function(t){if(!t._base)return t;var c=Object.assign({},t);delete c._base;return c});merged.forEach(_snapSync);d(merged);',
  'Inline-edit Save: strip _base before updating state'
);

// ── Write patched bundle ──────────────────────────────────────────────────────
fs.writeFileSync(BUNDLE, code, 'utf-8');

console.log(`\n✅ ${changeCount} patch(es) applied successfully.`);
console.log(`Size after:    ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);
console.log('\nWhat changed:');
console.log('  Every task save now carries the values the user last saw from the');
console.log('  server. The server writes only fields the user actually changed.');
