#!/usr/bin/env node
/**
 * scripts/patch-concurrency-fix.js  (V1.0)
 *
 * Fixes two critical multi-user concurrency bugs:
 *
 * FIX A — End Job + QC/Content/Web assignment race condition
 * ─────────────────────────────────────────────────────────
 * ROOT CAUSE:
 *   The SEO WorkHub's $e function (End Job + assign to QC / Content / Web)
 *   only updated local React state and relied on the debounced bulk A0 save
 *   (1200 ms). When multiple users simultaneously clicked "End Job" for
 *   different tasks, each user's A0 bulk-save sent their ENTIRE task list to
 *   the server. The A0 merge only protected timeEvents counts — it did NOT
 *   protect assignment fields (executionState, currentOwner, seoQcStatus,
 *   contentStatus, webStatus, qcReviews). So User A's stale snapshot of
 *   User B's task could overwrite User B's just-submitted QC assignment.
 *
 * FIX:
 *   A1. After updating local state, immediately call _saveTaskById() on the
 *       changed task (same pattern the timer handler Xe already uses).
 *       This atomically writes ONLY that task to the DB before A0 runs,
 *       so no other user's bulk save can clobber it.
 *   A2. Fix the "reviewer" undefined-variable bug: seoOwner was set to
 *       `reviewer||N.seoOwner` where `reviewer` was never declared in scope
 *       (always undefined), so the seoOwner never changed on QC submit.
 *       Changed to `Pe||N.seoOwner` (Pe is the reviewer param passed in).
 *
 * FIX B — New task / assignment not visible to assigned user immediately
 * ───────────────────────────────────────────────────────────────────────
 * ROOT CAUSE:
 *   The only refresh mechanism was the visibilitychange handler (tab
 *   focus). A task assigned to User B by User A only appeared after User B
 *   switched browser tabs and came back. There was no periodic polling.
 *
 * FIX:
 *   Add a 30-second background poll that fetches /api/tasks and merges
 *   fresh data into local state using a safe strategy:
 *     • Tasks with pending single-saves in flight → SKIPPED (won't overwrite
 *       data that _saveTaskById is currently sending to DB).
 *     • Existing local tasks → updated from server UNLESS local has more
 *       timeEvents (keeps locally-recorded timer events that haven't landed
 *       in DB yet).
 *     • Local tasks not yet in DB (freshly created, debounce pending) →
 *       PRESERVED (polling only adds server tasks, never removes local ones).
 *     • NEW tasks from server not present locally → ADDED immediately.
 *   This ensures newly assigned tasks appear within 30 seconds without any
 *   user action.
 *
 * Idempotent: re-running detects the V1.0 marker and exits cleanly.
 * Creates a timestamped backup before writing.
 *
 * Usage:
 *   node scripts/patch-concurrency-fix.js
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

// Find the active bundle from index.html
const html = fs.readFileSync(INDEX_HTML, 'utf-8');
const m = html.match(/index-[A-Za-z0-9_-]+\.js/);
if (!m) die('Could not find bundle reference in dist/index.html');
const BUNDLE = path.join(ASSETS_DIR, m[0]);
if (!fs.existsSync(BUNDLE)) die(`${BUNDLE} not found.`);

console.log(`\nTarget bundle: ${BUNDLE}`);
console.log(`Size before:   ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);

let code = fs.readFileSync(BUNDLE, 'utf-8');

// ── Idempotency check ─────────────────────────────────────────────────────────
const MARKER = '/*CONCURRENCY_FIX_V1_0_APPLIED*/';
if (code.includes(MARKER)) {
  console.log('\nAlready patched (V1.0 marker found). Nothing to do.');
  process.exit(0);
}

let changeCount = 0;

function rep(oldStr, newStr, label) {
  const parts = code.split(oldStr);
  if (parts.length !== 2) {
    if (parts.length === 1) die(`[${label}]: anchor NOT found in bundle. The bundle may have been rebuilt. Re-run the Vite build and retry.`);
    die(`[${label}]: anchor matched ${parts.length - 1} times (expected exactly 1). Aborting to prevent incorrect patch.`);
  }
  code = parts[0] + newStr + parts[1];
  changeCount++;
  console.log(`  ✔ ${label}`);
}

// ── Backup ────────────────────────────────────────────────────────────────────
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backup = BUNDLE.replace('.js', `.bak-concurrency-${ts}.js`);
fs.copyFileSync(BUNDLE, backup);
console.log(`\nBackup created: ${path.basename(backup)}\n`);

console.log('Applying patches...\n');

// ── Insert marker right after the existing V5.1 marker ───────────────────────
rep(
  '/*BUNDLE_FIXES_V5_1_APPLIED*/',
  `/*BUNDLE_FIXES_V5_1_APPLIED*/${MARKER}`,
  'Insert V1.0 idempotency marker'
);

// ═══════════════════════════════════════════════════════════════════════════════
// FIX A2 — reviewer undefined-variable bug
// ─────────────────────────────────────────────────────────────────────────────
// Old: seoOwner:reviewer||N.seoOwner   (reviewer is never declared → always undefined)
// New: seoOwner:Pe||N.seoOwner         (Pe is the reviewer/assignee passed as 5th param)
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  'seoOwner:reviewer||N.seoOwner',
  'seoOwner:Pe||N.seoOwner',
  'Fix A2: reviewer undefined → Pe (seoOwner now correctly set on QC submit)'
);

// ═══════════════════════════════════════════════════════════════════════════════
// FIX A1 — $e End Job + assign: add immediate _saveTaskById call
// ─────────────────────────────────────────────────────────────────────────────
// The $e function ends with:  N}))},We=v.useMemo...
// We insert an IIFE after the p(m=>m.map(...)) call that:
//   1. Reads the task from the s[] snapshot (same as Xe timer handler)
//   2. Rebuilds the updated task using the exact same logic as the state update
//   3. Calls _saveTaskById(updatedTask) for atomic single-task DB write
//
// Key points:
//   • Uses 'ge' (the timestamp captured at the top of $e) for consistency
//   • Uses 's.find(...)' to get the current task (same pattern as Xe)
//   • Uses 'g' (currentUser) and 'Pe' (reviewer param) from closure
//   • The IIFE avoids polluting the outer scope
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  'N}))},We=v.useMemo',

  // After the p(m=>m.map(...)) call, immediately call _saveTaskById on the
  // updated task so concurrent bulk-saves from other users can never overwrite it.
  'N}));' +
  '(function(){' +
    'var _et=s.find(function(_t){return _t.id===h});' +
    'if(_et){' +
      // Build updated timeEvents (same as what the map callback does)
      'var _eTe=[..._et.timeEvents||[],{type:"end",timestamp:ge,department:_et.currentOwner,owner:(g==null?void 0:g.ownerName)||""}];' +
      'var _eu=void 0;' +
      'if($==="qc_submit"){' +
        'var _eQc={id:"qc_"+Date.now(),submittedBy:(g==null?void 0:g.ownerName)||"",submittedByDept:_et.currentOwner,submittedAt:ge,assignedTo:Pe||_et.seoOwner||"",estHours:ie,note:be||void 0};' +
        '_eu=Object.assign({},_et,{' +
          'timeEvents:_eTe,' +
          'executionState:"Not Started",' +
          'currentOwner:"SEO",' +
          'seoOwner:Pe||_et.seoOwner,' +
          'seoQcStatus:"Pending QC",' +
          'contentStatus:_et.currentOwner==="Content"?"QC Submitted":_et.contentStatus,' +
          'webStatus:_et.currentOwner==="Web"?"QC Submitted":_et.webStatus,' +
          'qcReviews:[..._et.qcReviews||[],_eQc]' +
        '});' +
      '}else if($==="content"){' +
        '_eu=Object.assign({},_et,{' +
          'timeEvents:_eTe,' +
          'executionState:"Not Started",' +
          'currentOwner:"Content",' +
          'contentOwner:Pe||_et.contentOwner,' +
          'contentAssignedDate:be||ge.split("T")[0],' +
          'contentStatus:"Assigned",' +
          'estHoursContent:ie,' +
          'seoQcStatus:"In Progress"' +
        '});' +
      '}else if($==="web"){' +
        '_eu=Object.assign({},_et,{' +
          'timeEvents:_eTe,' +
          'executionState:"Not Started",' +
          'currentOwner:"Web",' +
          'webAssignedDate:ge.split("T")[0],' +
          'webStatus:"Assigned",' +
          'estHoursWeb:ie,' +
          'seoQcStatus:"In Progress"' +
        '});' +
      '}else if($==="done"){' +
        '_eu=Object.assign({},_et,{' +
          'timeEvents:_eTe,' +
          'executionState:"Ended",' +
          'isCompleted:true,' +
          'seoQcStatus:"Completed"' +
        '});' +
      '}' +
      'if(_eu)_saveTaskById(_eu);' +
    '}' +
  '})()' +
  '},We=v.useMemo',

  'Fix A1: $e End Job → add _saveTaskById for atomic DB write (prevents multi-user race condition)'
);

// ═══════════════════════════════════════════════════════════════════════════════
// FIX B — Periodic 30-second background poll for task visibility
// ─────────────────────────────────────────────────────────────────────────────
// Inserts a new useEffect that polls /api/tasks every 30 seconds.
//
// Safe merge strategy:
//   • Skips if any single-task save is in flight (_pendingSaves non-empty)
//   • For tasks in both local & server: uses server version but keeps local
//     timeEvents if local has more (protects uncommitted timer events)
//   • For tasks ONLY in local: kept as-is (protects tasks pending first save)
//   • For tasks ONLY in server (new assignments): added to local state
//
// The poll starts only after the context is initialised (R.current is true).
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  '},[P,he]),v.useEffect(()=>{H?localStorage.setItem("seo_current_user"',

  '},[P,he]),' +
  // New polling useEffect
  'v.useEffect(()=>{' +
    // Don't start polling until context initialised
    'if(!R.current)return;' +
    'var _pollId=setInterval(function(){' +
      // Skip if any single-task save is already in flight
      'if(typeof _pendingSaves!=="undefined"&&Object.keys(_pendingSaves).length>0)return;' +
      'fetch("/api/tasks",{cache:"no-store"})' +
        '.then(function(r){return r.ok?r.json():null})' +
        '.then(function(_pTasks){' +
          'if(!_pTasks||!Array.isArray(_pTasks)||!_pTasks.length)return;' +
          'p(function(cur){' +
            // Build lookup of server tasks
            'var _sMap={};' +
            '_pTasks.forEach(function(t){_sMap[t.id]=t});' +
            // Update existing local tasks from server (keep more-timeEvents local)
            'var merged=cur.map(function(lt){' +
              'var st=_sMap[lt.id];' +
              // Task not yet in DB (pending creation) → keep local as-is
              'if(!st)return lt;' +
              // Keep local timeEvents if more (uncommitted timer events)
              'return(lt.timeEvents||[]).length>(st.timeEvents||[]).length' +
                '?Object.assign({},st,{timeEvents:lt.timeEvents})' +
                ':st;' +
            '});' +
            // Add brand-new tasks from server that aren't in local state yet
            'var newTasks=_pTasks.filter(function(st){' +
              'return!cur.find(function(lt){return lt.id===st.id})' +
            '});' +
            'return newTasks.length>0?merged.concat(newTasks):merged;' +
          '});' +
        '})' +
        '.catch(function(){});' +  // silent on network errors
    '},30000);' +  // poll every 30 seconds
    'return function(){clearInterval(_pollId)};' +
  '},[]),' +
  'v.useEffect(()=>{H?localStorage.setItem("seo_current_user"',

  'Fix B: Add 30-second background poll so newly assigned tasks appear without tab-switch'
);

// ── Write patched bundle ───────────────────────────────────────────────────────
fs.writeFileSync(BUNDLE, code, 'utf-8');

console.log(`\n✅ ${changeCount} patch(es) applied successfully.`);
console.log(`Size after:    ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);
console.log('\nPatches applied:');
console.log('  A1 — $e End Job now calls _saveTaskById immediately (race condition fixed)');
console.log('  A2 — reviewer undefined-variable bug fixed (seoOwner now correctly assigned)');
console.log('  B  — 30s background poll added (new/assigned tasks visible within 30s)');
