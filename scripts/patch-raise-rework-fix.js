#!/usr/bin/env node
/**
 * scripts/patch-raise-rework-fix.js  (V1.0)
 *
 * Fixes Action Board "Raise Rework" / "Confirm Rework" not persisting —
 * after confirming a rework assignment the task reverts to its previous state.
 *
 * ROOT CAUSE:
 *   The Action Board's M() Confirm Rework handler only updates local React
 *   state via d() (setState). It never calls _saveTaskById() for an immediate
 *   DB write.
 *
 *   After patch-a0-merge-fix.js (V2.0), the A0 bulk-save merge was changed
 *   to prefer SERVER values for all assignment fields (currentOwner,
 *   executionState, seoQcStatus, contentStatus, webStatus, contentOwner,
 *   webOwner, reworkEntries). This means:
 *
 *   1. User fills Raise Rework modal and clicks "Confirm Rework"
 *   2. M() updates local React state (assignment looks correct in UI)
 *   3. ~1200 ms later A0 fires → fetches fresh server data (still OLD values)
 *   4. A0's server-wins merge reverts M()'s local changes → UI snaps back
 *   5. Nothing was written to DB → on page reload all changes are lost
 *
 *   This is the exact same bug pattern fixed for bt() (End Task) by
 *   patch-action-board-handoff-fix.js. The Raise Rework path was missed.
 *
 * FIX:
 *   After M()'s d() state update, inject an IIFE that:
 *     1. Copies A (task snapshot captured when Raise Rework was clicked) into _rw
 *     2. Appends a "pause" time event if the task was In Progress
 *     3. Applies the same assignment mutations as M()'s d() callback:
 *          executionState  → "Not Started"
 *          currentOwner    → assigned dept (Content or Web)
 *          seoQcStatus     → "Rework"
 *          contentOwner / webOwner, assigned date, status → "Rework"
 *     4. Adds the new rework entry using Ze.id from M()'s closure so that
 *        the rework_id matches between React state and DB — no duplicate entries
 *     5. Updates the latest QC review outcome to "Rework"
 *     6. Calls _saveTaskById(_rw) for an immediate PUT /api/tasks/:id
 *
 *   Only the M() Confirm Rework code path is modified.
 *   All other Action Board functionality is untouched.
 *
 * Idempotent: re-running detects the V1.0 marker and exits cleanly.
 * Creates a timestamped backup before writing.
 *
 * Usage:
 *   node scripts/patch-raise-rework-fix.js
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

// Detect active bundle from index.html
const html = fs.readFileSync(INDEX_HTML, 'utf-8');
const m    = html.match(/index-[A-Za-z0-9_-]+\.js/);
if (!m) die('Could not find bundle reference in dist/index.html');
const BUNDLE = path.join(ASSETS_DIR, m[0]);
if (!fs.existsSync(BUNDLE)) die(`${BUNDLE} not found.`);

console.log(`\nTarget bundle: ${BUNDLE}`);
console.log(`Size before:   ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);

let code = fs.readFileSync(BUNDLE, 'utf-8');

// ── Idempotency check ─────────────────────────────────────────────────────────
const MARKER = '/*RAISE_REWORK_FIX_V1_0_APPLIED*/';
if (code.includes(MARKER)) {
  console.log('\nAlready patched (V1.0 marker found). Nothing to do.');
  process.exit(0);
}

let changeCount = 0;

function rep(oldStr, newStr, label) {
  const parts = code.split(oldStr);
  if (parts.length === 1) {
    die(`[${label}]: anchor NOT found in bundle.\n` +
        'The bundle may have been rebuilt with a different hash.\n' +
        'Update the anchor strings in this script to match the new bundle.');
  }
  if (parts.length > 2) {
    die(`[${label}]: anchor matched ${parts.length - 1} times (expected exactly 1). Aborting.`);
  }
  code = parts[0] + newStr + parts[1];
  changeCount++;
  console.log(`  \u2714 ${label}`);
}

// ── Backup ────────────────────────────────────────────────────────────────────
const ts     = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backup = BUNDLE.replace('.js', `.bak-raise-rework-${ts}.js`);
fs.copyFileSync(BUNDLE, backup);
console.log(`\nBackup created: ${path.basename(backup)}\n`);

console.log('Applying patches...\n');

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN FIX — Action Board M(): inject _saveTaskById after Confirm Rework
// ─────────────────────────────────────────────────────────────────────────────
//
// The M() function ends its d() state-update with a QC review mutation, then
// calls G(null) to close the Raise Rework modal:
//
//   ...reworkEntries:[...Ne.reworkEntries||[],Ze],timeEvents:He,
//   qcReviews:(()=>{...outcome:"Rework",completedAt:new Date().toISOString()},
//   gt})()}})),G(null)},
//
// We inject an IIFE between the d() call and G(null), so it runs right after
// the optimistic React state update but before the modal is dismissed.
//
// Closure variables available (same scope as M()):
//   A   — task object captured when "Raise Rework" was clicked (via C(u))
//   ee  — rework form state: { estHours, assignedDept, assignedOwner, date }
//   Ze  — the new rework entry object computed in M() before d() was called;
//          Ze.id is reused here so state and DB share the same rework_id
//   i   — currentUser object (has .ownerName)
//   ht  — helper that returns { activeMs, ... } for a task
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  // ANCHOR — unique string at the end of M()'s d() state-update (1 match confirmed)
  'outcome:"Rework",completedAt:new Date().toISOString()},gt})()}})),G(null)},',

  // REPLACEMENT — same d() closure end + IIFE for immediate DB save + G(null)
  'outcome:"Rework",completedAt:new Date().toISOString()},gt})()}}));' +

  // ── IIFE: rebuild mutated task and save to DB immediately ──────────────────
  '(function(){' +
    'if(!A)return;' +
    'var _gt=new Date().toISOString();' +
    // Shallow copy of the task snapshot captured at Raise Rework click time
    'var _rw=Object.assign({},A);' +
    // Time events: pause the task if it was actively running
    'var _te=[...(A.timeEvents||[])];' +
    'if(A.executionState==="In Progress"){' +
      '_te.push({type:"pause",timestamp:_gt,department:A.currentOwner,owner:(i==null?void 0:i.ownerName)||""});' +
    '}' +
    '_rw.timeEvents=_te;' +
    // Apply same assignment mutations as M()'s d() callback
    '_rw.executionState="Not Started";' +
    '_rw.currentOwner=ee.assignedDept;' +
    '_rw.seoQcStatus="Rework";' +
    'if(ee.assignedDept==="Content"){' +
      '_rw.contentOwner=ee.assignedOwner;' +
      '_rw.contentAssignedDate=ee.date;' +
      '_rw.contentStatus="Rework";' +
    '}else{' +
      '_rw.webOwner=ee.assignedOwner;' +
      '_rw.webAssignedDate=ee.date;' +
      '_rw.webStatus="Rework";' +
    '}' +
    // Rebuild new rework entry — reuse Ze.id so state and DB have matching rework_id
    'var _ce=ht(A).activeMs/36e5;' +
    'var _fe=parseFloat(ee.estHours)||0;' +
    'var _pe=A.estHours||0;' +
    'var _Ce=_pe>0&&_ce+_fe<=_pe;' +
    'var _Ze={id:Ze.id,date:ee.date,estHours:_fe,assignedDept:ee.assignedDept,' +
      'assignedOwner:ee.assignedOwner,withinEstimate:_Ce,' +
      'hoursAlreadySpent:parseFloat(_ce.toFixed(2)),startTimestamp:""};' +
    '_rw.reworkEntries=[...(A.reworkEntries||[]),_Ze];' +
    // Update latest QC review outcome to "Rework"
    'if(A.qcReviews&&A.qcReviews.length>0){' +
      'var _qr=[...A.qcReviews];' +
      '_qr[_qr.length-1]=Object.assign({},_qr[_qr.length-1],{outcome:"Rework",completedAt:_gt});' +
      '_rw.qcReviews=_qr;' +
    '}' +
    // Atomic DB write — same as _saveTaskById used by Te (timer) and bt() (End Task)
    '_saveTaskById(_rw);' +
  '})()' + MARKER +
  // ── original modal-close call (unchanged) ──────────────────────────────────
  ';G(null)},',

  'Action Board M(): inject _saveTaskById after Confirm Rework for immediate DB persistence'
);

// ── Write patched bundle ──────────────────────────────────────────────────────
fs.writeFileSync(BUNDLE, code, 'utf-8');

console.log(`\n\u2705 ${changeCount} patch(es) applied successfully.`);
console.log(`Size after:    ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);
console.log('\nPatches applied:');
console.log('  V1.0 — Action Board M() Confirm Rework now calls _saveTaskById immediately');
console.log('         Fixes: Raise Rework assignment not persisting (reverts after ~1200 ms)');
console.log('         Assigns task to Content/Web team with correct owner, status, rework entry');
