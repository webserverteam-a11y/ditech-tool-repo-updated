#!/usr/bin/env node
/**
 * scripts/patch-action-board-handoff-fix.js  (V1.0)
 *
 * Fixes Action Board End Task actions (Assign to Web/Content Team,
 * QC Submit to SEO, Close Task Bypass, Mark Approved, etc.) not
 * persisting to the database — changes appear in UI but revert on reload.
 *
 * ROOT CAUSE:
 *   The Action Board's bt() End Task handler only updates local React state
 *   via d() (setState). It never calls _saveTaskById() for an immediate DB
 *   write.
 *
 *   After patch-a0-merge-fix.js (V2.0), the A0 bulk-save merge was changed
 *   to prefer SERVER values for all assignment fields (currentOwner,
 *   executionState, seoQcStatus, contentStatus, webStatus, seoOwner,
 *   contentOwner, webOwner, qcReviews, reworkEntries). This means:
 *
 *   1. User clicks End Task → bt() updates local React state (looks correct)
 *   2. ~1200 ms later A0 fires → fetches fresh server data (still OLD values)
 *   3. A0's server-wins merge reverts bt()'s local changes → UI snaps back
 *   4. Nothing was written to DB → on page reload all changes are lost
 *
 *   The rank-based executionState merge makes it worse: local "Not Started"
 *   (rank 0) loses to server "In Progress" (rank 1) → fully reverted.
 *
 *   The WorkHub's $e End Job handler was already fixed by
 *   patch-concurrency-fix.js (V1.0) with the same _saveTaskById pattern.
 *   The Action Board's bt() was missed.
 *
 * FIX:
 *   After bt()'s logAudit call (still inside the try block), inject an IIFE
 *   that:
 *     1. Copies U (task snapshot set when End Task was clicked) into _bh
 *     2. Appends the "end" time event
 *     3. Closes any open rework entry
 *     4. Applies the same switch/case assignment logic as bt()
 *     5. Calls _saveTaskById(_bh) for an immediate PUT /api/tasks/:id
 *
 *   This mirrors EXACTLY what patch-concurrency-fix.js did for $e.
 *
 * Idempotent: re-running detects the V1.0 marker and exits cleanly.
 * Creates a timestamped backup before writing.
 *
 * Usage:
 *   node scripts/patch-action-board-handoff-fix.js
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
const MARKER = '/*ACTION_BOARD_HANDOFF_FIX_V1_0_APPLIED*/';
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
const backup = BUNDLE.replace('.js', `.bak-ab-handoff-${ts}.js`);
fs.copyFileSync(BUNDLE, backup);
console.log(`\nBackup created: ${path.basename(backup)}\n`);

console.log('Applying patches...\n');

// ── 1. Insert idempotency marker ──────────────────────────────────────────────
rep(
  '/*A0_MERGE_FIX_V2_0_APPLIED*/',
  '/*A0_MERGE_FIX_V2_0_APPLIED*/' + MARKER,
  'Insert V1.0 idempotency marker'
);

// ═══════════════════════════════════════════════════════════════════════════════
// 2. MAIN FIX — Action Board bt(): inject _saveTaskById after state update
// ─────────────────────────────────────────────────────────────────────────────
//
// The bt() function ends its try block with:
//   const Ze = {assign_content:"Assigned to Content",...,close:"Task Closed"};
//   U && logAudit({...source:"action_board",note:fe?`Assigned to: ${fe}`:void 0})
// } finally { R(null); ue("select_action"); ye(null) }
//
// We inject an IIFE between the logAudit call and the closing } of try,
// so it runs right after bt()'s state update and audit log, but before
// the finally block clears U.
//
// Closure variables available (same scope as bt()):
//   u   — action: "assign_content"|"assign_web"|"qc_seo"|"qc_web"|"approve"|"rework"|"close"
//   ce  — assignment date string (param passed from Confirm Assignment button)
//   fe  — assignee name (param)
//   pe  — estHours number (param)
//   Ce  — docUrl string (param)
//   U   — task object (state set via R(task) when End Task button clicked)
//   i   — currentUser object (component prop; has .ownerName, .role)
//   f   — qc estHours state (useState "0.25")
//   Ie  — qc note state (useState "")
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  // ANCHOR — unique string at the end of bt()'s try block
  // The Ze dict + logAudit call with source:"action_board" is unique to bt()
  'close:"Task Closed"};U&&logAudit({action:Ze[u]||u,taskId:U.id,taskTitle:U.title,client:U.client||"",source:"action_board",note:fe?`Assigned to: ${fe}`:void 0})}finally{',

  // REPLACEMENT — same logAudit call + IIFE + original finally opener
  'close:"Task Closed"};U&&logAudit({action:Ze[u]||u,taskId:U.id,taskTitle:U.title,client:U.client||"",source:"action_board",note:fe?`Assigned to: ${fe}`:void 0});' +

  // ── IIFE: rebuild mutated task and save to DB immediately ──────────────────
  '(function(){' +
    // Guard: U must be set (it always is inside bt(), but be safe)
    'if(!U)return;' +
    // Current timestamp for this end event
    'var _gt=new Date().toISOString();' +
    // Start from a shallow copy of U (the task snapshot at End Task click time)
    'var _bh=Object.assign({},U);' +
    // Append the "end" time event
    '_bh.timeEvents=[...(U.timeEvents||[]),{type:"end",timestamp:_gt,department:U.currentOwner,owner:(i==null?void 0:i.ownerName)||""}];' +
    // Apply docUrl if provided
    'if(Ce)_bh.docUrl=Ce;' +
    // Close any open rework entry (same logic as bt()'s Ne.reworkEntries block)
    'if(U.reworkEntries&&U.reworkEntries.length>0){' +
      'var _lr=U.reworkEntries[U.reworkEntries.length-1];' +
      'if(_lr.startTimestamp&&!_lr.endTimestamp){' +
        'var _rms=new Date(_gt).getTime()-new Date(_lr.startTimestamp).getTime();' +
        '_bh.reworkEntries=[...U.reworkEntries.slice(0,-1),Object.assign({},_lr,{endTimestamp:_gt,durationMs:_rms})];' +
      '}' +
    '}' +
    // Apply the same assignment mutations as bt()'s switch block
    'switch(u){' +
      // ── assign to Content team ──────────────────────────────────────────
      'case"assign_content":' +
        '_bh.currentOwner="Content";_bh.contentOwner=fe;_bh.contentAssignedDate=ce;' +
        '_bh.executionState="Not Started";_bh.contentStatus="Assigned";_bh.estHoursContent=pe;' +
        'break;' +
      // ── assign to Web team ──────────────────────────────────────────────
      'case"assign_web":' +
        '_bh.currentOwner="Web";_bh.webOwner=fe;_bh.webAssignedDate=ce;' +
        '_bh.executionState="Not Started";_bh.webStatus="Assigned";_bh.estHoursWeb=pe;' +
        'break;' +
      // ── QC submit to SEO ────────────────────────────────────────────────
      'case"qc_seo":{' +
        '_bh.currentOwner="SEO";_bh.seoOwner=fe;_bh.executionState="Not Started";' +
        '_bh.seoQcStatus="Pending QC";' +
        'if(U.currentOwner==="Content")_bh.contentStatus="QC Submitted";' +
        'else if(U.currentOwner==="Web")_bh.webStatus="QC Submitted";' +
        '_bh.intakeDate=_gt.split("T")[0];' +
        'var _qc={id:"qc_"+Date.now(),' +
          'submittedBy:(i==null?void 0:i.ownerName)||U.contentOwner||U.webOwner||"",' +
          'submittedByDept:(i==null?void 0:i.role)==="content"?"Content":"Web",' +
          'submittedAt:_gt,assignedTo:fe,estHours:parseFloat(f)||.25,note:Ie||void 0};' +
        '_bh.qcReviews=[...(U.qcReviews||[]),_qc];' +
        'break;}' +
      // ── QC submit to Web team ────────────────────────────────────────────
      'case"qc_web":{' +
        '_bh.currentOwner="Web";_bh.webOwner=fe;_bh.executionState="Not Started";_bh.webStatus="Pending QC";' +
        'var _qcw={id:"qc_"+Date.now(),' +
          'submittedBy:(i==null?void 0:i.ownerName)||"",' +
          'submittedByDept:(i==null?void 0:i.role)==="content"?"Content":"Web",' +
          'submittedAt:_gt,assignedTo:fe,estHours:parseFloat(f)||.25,note:Ie||void 0};' +
        '_bh.qcReviews=[...(U.qcReviews||[]),_qcw];' +
        'break;}' +
      // ── Mark Approved ────────────────────────────────────────────────────
      'case"approve":{' +
        '_bh.seoQcStatus="Approved";_bh.isCompleted=true;_bh.currentOwner="Completed";_bh.executionState="Ended";' +
        'if(U.contentStatus)_bh.contentStatus="Approved";' +
        'if(U.webStatus)_bh.webStatus="Approved";' +
        'if(_bh.qcReviews&&_bh.qcReviews.length>0){' +
          'var _qa=[..._bh.qcReviews];' +
          '_qa[_qa.length-1]=Object.assign({},_qa[_qa.length-1],{outcome:"Approved",completedAt:_gt});' +
          '_bh.qcReviews=_qa;' +
        '}break;}' +
      // ── Mark Rework ──────────────────────────────────────────────────────
      'case"rework":{' +
        '_bh.seoQcStatus="Rework";_bh.executionState="Rework";' +
        'if(U.contentStatus&&U.contentStatus!=="Approved")_bh.contentStatus="Rework";' +
        'if(U.webStatus&&U.webStatus!=="Approved")_bh.webStatus="Rework";' +
        'if(_bh.qcReviews&&_bh.qcReviews.length>0){' +
          'var _qr=[..._bh.qcReviews];' +
          '_qr[_qr.length-1]=Object.assign({},_qr[_qr.length-1],{outcome:"Rework",completedAt:_gt});' +
          '_bh.qcReviews=_qr;' +
        '}break;}' +
      // ── Close Task (Bypass) ──────────────────────────────────────────────
      'case"close":' +
        '_bh.currentOwner="Completed";_bh.isCompleted=true;_bh.executionState="Ended";' +
        '_bh.seoQcStatus="Completed";' +
        'if(U.contentStatus)_bh.contentStatus="Completed";' +
        '_bh.webStatus="Completed";' +
        'break;' +
    '}' +
    // Atomic DB write — same as _saveTaskById used by timer handler Te and WorkHub $e
    '_saveTaskById(_bh);' +
  '})()' +
  // ── original finally block (unchanged) ──────────────────────────────────────
  '}finally{',

  'Action Board bt(): inject _saveTaskById after state update for immediate DB persistence'
);

// ── Write patched bundle ──────────────────────────────────────────────────────
fs.writeFileSync(BUNDLE, code, 'utf-8');

console.log(`\n\u2705 ${changeCount} patch(es) applied successfully.`);
console.log(`Size after:    ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);
console.log('\nPatches applied:');
console.log('  V1.0 — Action Board bt() End Task now calls _saveTaskById immediately');
console.log('         Fixes: Assign to Web Team, Assign to Content Team,');
console.log('                QC Submit to SEO, QC Submit to Web, Mark Approved, Close Task (Bypass)');
