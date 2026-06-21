#!/usr/bin/env node
/**
 * scripts/patch-visibility-flush.js  (V1.0)
 *
 * Fixes task saves being lost when a user quickly switches browser tabs.
 *
 * ROOT CAUSE:
 *   When a user makes a change (e.g., assigns a task) and switches tabs within
 *   ~1200ms (before the debounce fires), a race window opens:
 *
 *     t=0ms    User assigns task → React state updates locally
 *              → debounce timer starts (1200ms)
 *              → _pendingSaves is EMPTY (save hasn't fired yet)
 *     t=200ms  User switches tab → browser throttles background timers
 *     t=500ms  30s poll fires (if near its cycle) → fetches OLD server data
 *              → merge checks _pendingSaves[taskId] → EMPTY (save not in-flight yet)
 *              → applies old server data → local state REVERTED
 *     t=1200ms Debounce fires → A0(d) compares _dtSnapshot to current state
 *              → current state now matches _dtSnapshot (poll already reverted it)
 *              → NO SAVE → change is permanently lost
 *
 * THE FIX — Four changes to the frontend bundle:
 *
 *   1. _latestTasks global
 *      Tracks the most recent React tasks state at all times. Null until first
 *      state change, then always reflects the latest tasks array.
 *
 *   2. visibilitychange listener
 *      When the tab goes hidden (tab switch / minimize), immediately calls
 *      A0(_latestTasks). This fires _saveTaskById for any dirty task BEFORE
 *      background throttling can delay the debounce.
 *      Sets _pendingSaves[taskId] = 1 immediately, so if the 30s poll fires
 *      shortly after, the merge sees the save in-flight and keeps local state.
 *
 *   3. pagehide listener (sendBeacon)
 *      When the user closes the tab entirely, uses navigator.sendBeacon to
 *      fire-and-forget save any dirty tasks. sendBeacon is guaranteed to
 *      complete even during page unload — unlike fetch, which can be cancelled.
 *      Covers the edge case where visibilitychange fired but save didn't finish.
 *
 *   4. _latestTasks=d in debounce useEffect
 *      Set SYNCHRONOUSLY inside the useEffect (before the 1200ms setTimeout),
 *      so _latestTasks is always current from the moment state changes — not
 *      after the 1200ms timer expires. This is what makes visibilitychange work.
 *
 * TIMELINE AFTER FIX:
 *   t=0ms    User assigns task → React state updates → useEffect([d]) fires
 *            → _latestTasks=d (immediate, before setTimeout)
 *            → 1200ms timer starts
 *   t=200ms  User switches tab → document.hidden = true
 *            → visibilitychange fires → A0(_latestTasks) called
 *            → _saveTaskById(dirtyTask) fires → _pendingSaves[taskId] = 1
 *   t=500ms  30s poll fires → merge checks _pendingSaves[taskId] → SET
 *            → poll keeps local state unchanged ✓
 *   t=700ms  PUT /api/tasks/:id completes → DB has new assignment ✓
 *            → _dtSnapshot[taskId] updated → _pendingSaves[taskId] deleted
 *   t=1200ms Debounce fires → A0(d) → snapshot matches → no duplicate save ✓
 *
 * Idempotent: re-running detects the V1.0 marker and exits cleanly.
 * Creates a timestamped backup before writing.
 *
 * Apply order: run AFTER patch-dirty-track-save.js
 * Usage: node scripts/patch-visibility-flush.js
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
const MARKER = '/*VISIBILITY_FLUSH_V1_0_APPLIED*/';
if (code.includes(MARKER)) {
  console.log('\nAlready patched (V1.0 marker found). Nothing to do.');
  process.exit(0);
}

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
const backup = BUNDLE.replace('.js', `.bak-vis-flush-${ts}.js`);
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
// FIX 1+2+3 — _latestTasks global + visibilitychange + pagehide listeners
// ─────────────────────────────────────────────────────────────────────────────
// Injected right after _dtSnapshot so all three share the same scope.
//
// visibilitychange: fires when tab hides (switch/minimize)
//   → calls A0(_latestTasks) immediately to flush dirty saves
//   → A0 is idempotent: if a save is already in-flight for this task,
//     _saveTaskById returns Promise.resolve() immediately (per-task dedup)
//
// pagehide: fires when tab closes or user navigates away
//   → sendBeacon fires dirty tasks as fire-and-forget POST to PUT /:id
//   → guaranteed to complete even during page unload (unlike fetch)
//   → guards: _latestTasks must be set, _dtSnapshot must be initialized,
//     _dtSnap must be defined (all guaranteed by dirty-track-save patch)
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  'var _pendingSaves={};var _dtSnapshot=null;',

  'var _pendingSaves={};var _dtSnapshot=null;var _latestTasks=null;' +

  // visibilitychange: immediate A0 flush when tab goes hidden
  'document.addEventListener("visibilitychange",function(){' +
    'if(document.hidden&&_latestTasks&&_dtSnapshot!==null){' +
      'A0(_latestTasks);' +
    '}' +
  '});' +

  // pagehide: sendBeacon dirty tasks on tab close (survives page unload)
  'window.addEventListener("pagehide",function(){' +
    'if(!_latestTasks||_dtSnapshot===null)return;' +
    '_latestTasks.filter(function(t){' +
      'return _dtSnapshot[t.id]!==_dtSnap(t);' +
    '}).forEach(function(t){' +
      'try{' +
        'navigator.sendBeacon(' +
          '"/api/tasks/"+encodeURIComponent(t.id),' +
          'new Blob([JSON.stringify(t)],{type:"application/json"})' +
        ');' +
      '}catch(e){}' +
    '});' +
  '});',

  'Add _latestTasks global + visibilitychange flush + pagehide sendBeacon'
);

// ═══════════════════════════════════════════════════════════════════════════════
// FIX 4 — Set _latestTasks=d synchronously inside debounce useEffect
// ─────────────────────────────────────────────────────────────────────────────
// The debounce useEffect runs synchronously in React's commit phase whenever
// tasks state `d` changes — BEFORE the 1200ms setTimeout fires.
//
// By setting _latestTasks=d here (via comma operator before clearTimeout),
// _latestTasks is always current from the moment of state change, not after
// 1200ms. This means visibilitychange always has the latest tasks to flush.
//
// OLD:
//   if(R.current)return clearTimeout(ke.current),ke.current=setTimeout(...)
// NEW:
//   if(R.current)return _latestTasks=d,clearTimeout(ke.current),ke.current=setTimeout(...)
// ═══════════════════════════════════════════════════════════════════════════════
rep(
  // ANCHOR — unique in bundle (ke.current=setTimeout appears exactly once)
  'if(R.current)return clearTimeout(ke.current),ke.current=setTimeout(()=>{A0(d);try{localStorage.setItem("seo_tasks",JSON.stringify(d))}catch{}ke.current=void 0},1200),()=>clearTimeout(ke.current)},[d])',

  // REPLACEMENT — _latestTasks=d before clearTimeout (comma operator = runs immediately)
  'if(R.current)return _latestTasks=d,clearTimeout(ke.current),ke.current=setTimeout(()=>{A0(d);try{localStorage.setItem("seo_tasks",JSON.stringify(d))}catch{}ke.current=void 0},1200),()=>clearTimeout(ke.current)},[d])',

  'Set _latestTasks=d immediately on every tasks state change (before 1200ms debounce fires)'
);

// ── Write patched bundle ──────────────────────────────────────────────────────
fs.writeFileSync(BUNDLE, code, 'utf-8');

console.log(`\n✅ ${changeCount} patch(es) applied successfully.`);
console.log(`Size after:    ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);
console.log('\nWhat changed:');
console.log('  1. _latestTasks global: always holds current React tasks state.');
console.log('  2. visibilitychange listener: when tab goes hidden, calls A0(_latestTasks)');
console.log('     immediately — flushes dirty saves before 1200ms debounce expires.');
console.log('     _pendingSaves[taskId] gets set, blocking poll merge from reverting.');
console.log('  3. pagehide listener: when tab closes, sendBeacon fires dirty tasks');
console.log('     as fire-and-forget — guaranteed to complete even during unload.');
console.log('  4. _latestTasks=d: runs synchronously in useEffect (before setTimeout),');
console.log('     so visibilitychange always flushes the actual latest state.');
