#!/usr/bin/env node
/**
 * scripts/patch-bundle-fixes.js  (V5.1)
 *
 * Applies 2 timer-race fixes + 4 Action Board dept-gating fixes.
 * Pure Node.js — no npm install needed, uses only built-in `fs` and `path`.
 *
 * What it does:
 *   B1. Adds a _pendingSaves tracker that registers each _saveTaskById
 *       single-task save while it's in flight. Also makes the P() flush
 *       handler SKIP the bulk /api/tasks PUT when any single-save is
 *       in flight — this prevents the race where switching tabs fast
 *       causes a stale bulk-save to overwrite your fresh click.
 *
 *   B2. Raises the bulk-save debounce from 150ms to 1200ms AND makes the
 *       debounced A0 bulk-save SKIP itself when any single-save is in
 *       flight. 1200ms gives single-saves plenty of time to complete
 *       at the server before any bulk save can run.
 *
 *   Pass A. Department-based dept gating on Action Board Pause/End/Resume
 *           buttons (both icon and labeled layouts). Mirrors the EXACT
 *           IIFE pattern used by the existing Start button — each button
 *           block gets its own scope that computes canAct inline. NO
 *           handler-level guards (that's what crashed V4). NO shared
 *           helpers. Only button-level disable + visual dim.
 *
 * WHAT THIS PATCHER DOES NOT DO (lessons learned from V3/V4):
 *   - Does NOT add any executionState rank logic to the A0 merge.
 *   - Does NOT touch the visibilitychange refetch merge.
 *   - Does NOT inject handler-level guards in Te/Qe/Xe.
 *   - Does NOT define any new helpers like _canUserAct or _deptBlockedToast.
 *   - Does NOT touch WorkHub panels (SEO or Non-SEO) — Action Board only.
 *
 * Idempotent: re-running detects the V5.1 marker and exits cleanly.
 * Upgrade-safe: detects V5 marker and applies only the Pass A additions.
 * Creates a timestamped backup before writing.
 *
 * Usage:
 *   node scripts/patch-bundle-fixes.js
 *
 * Wired as `postinstall` hook in package.json for Hostinger auto-deploy.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(REPO_ROOT, 'dist', 'assets');
const INDEX_HTML = path.join(REPO_ROOT, 'dist', 'index.html');

function die(msg) {
  console.error(`ERROR: ${msg}`);
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

console.log(`Target bundle: ${BUNDLE}`);
console.log(`Size before:   ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);

let code = fs.readFileSync(BUNDLE, 'utf-8');

// ── Idempotency check ────────────────────────────────────────────────────
// V5.1 marker: includes V5 (B1+B2 timer race) + Pass A (Action Board dept gating)
const MARKER = '/*BUNDLE_FIXES_V5_1_APPLIED*/';
const OLD_MARKER_V5 = '/*BUNDLE_FIXES_V5_MINIMAL_APPLIED*/'; // V5 (B1+B2 only)
if (code.includes(MARKER)) {
  console.log('\nAlready patched (V5.1 marker found). Nothing to do.');
  process.exit(0);
}

// ── Backup ───────────────────────────────────────────────────────────────
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 15);
const backup = `${BUNDLE}.bak-${ts}`;
fs.copyFileSync(BUNDLE, backup);
console.log(`Backup created: ${backup}`);

let changes = 0;
const v5AlreadyApplied = code.includes(OLD_MARKER_V5);
if (v5AlreadyApplied) {
  console.log('V5 marker detected — B1+B2 timer race fixes already applied. Will apply only Pass A.');
}

function rep(oldStr, newStr, label) {
  const parts = code.split(oldStr);
  if (parts.length === 1) {
    console.error(`  FAIL [${label}]: anchor not found`);
    process.exit(1);
  }
  if (parts.length > 2) {
    console.error(`  FAIL [${label}]: anchor matched ${parts.length - 1} times (expected 1)`);
    process.exit(1);
  }
  code = parts[0] + newStr + parts[1];
  changes++;
  console.log(`  OK   [${label}]`);
}

console.log('\nApplying fixes...');

// If V5 (B1+B2) is already applied, skip re-applying them.
if (v5AlreadyApplied) {
  // Upgrade the V5 marker in-place to V5.1 so future runs detect the full set
  code = code.replace(OLD_MARKER_V5, MARKER);
  console.log('  OK   [Marker upgrade: V5 -> V5.1]');
  changes++;
} else {

// ─────────────────────────────────────────────────────────────────────────
// B1 part 1: Add _pendingSaves tracker + integrate it into _saveTaskById
//
// Pristine _saveTaskById (fire-and-forget):
//   function _saveTaskById(t){fetch("/api/tasks/"+...).catch(...)}
//
// New version adds a key to _pendingSaves when the fetch starts, removes
// it when the fetch completes (success or fail). The V5 marker is
// injected here too so future runs can detect the patch.
// ─────────────────────────────────────────────────────────────────────────
const OLD_SAVE =
  'function _saveTaskById(t){' +
  'fetch("/api/tasks/"+encodeURIComponent(t.id),{' +
  'method:"PUT",' +
  'headers:{"Content-Type":"application/json"},' +
  'body:JSON.stringify(t)' +
  '}).catch(function(e){console.error("Failed to save task "+t.id+":",e)})' +
  '}';

const NEW_SAVE =
  MARKER +
  'var _pendingSaves={};' +
  'function _saveTaskById(t){' +
  'var _k=t.id+"_"+Date.now()+"_"+Math.random();' +
  '_pendingSaves[_k]=1;' +
  'return fetch("/api/tasks/"+encodeURIComponent(t.id),{' +
  'method:"PUT",' +
  'headers:{"Content-Type":"application/json"},' +
  'body:JSON.stringify(t)' +
  '}).then(function(r){delete _pendingSaves[_k];return r})' +
  '.catch(function(e){delete _pendingSaves[_k];console.error("Failed to save task "+t.id+":",e)})' +
  '}';

rep(OLD_SAVE, NEW_SAVE, 'B1a: _pendingSaves tracker + _saveTaskById integration');

// ─────────────────────────────────────────────────────────────────────────
// B2: Debounce 150ms -> 1200ms AND skip A0 if single-saves in flight
//
// Pristine:
//   ke.current=setTimeout(()=>{A0(d);try{localStorage.setItem(...)}catch{}
//     ke.current=void 0},150)
//
// New: wait 1200ms, then check _pendingSaves — if any single-save is
// pending, skip A0 entirely (the DB is already being updated correctly
// by the single-save).
// ─────────────────────────────────────────────────────────────────────────
const OLD_DEBOUNCE =
  'ke.current=setTimeout(()=>{A0(d);try{localStorage.setItem("seo_tasks",JSON.stringify(d))}catch{}ke.current=void 0},150)';

const NEW_DEBOUNCE =
  'ke.current=setTimeout(()=>{' +
  'if(typeof _pendingSaves!=="undefined"&&Object.keys(_pendingSaves).length>0){' +
  'ke.current=void 0;return' +
  '}' +
  'A0(d);' +
  'try{localStorage.setItem("seo_tasks",JSON.stringify(d))}catch{}' +
  'ke.current=void 0' +
  '},1200)';

rep(OLD_DEBOUNCE, NEW_DEBOUNCE, 'B2: debounce 150ms->1200ms + skip A0 if pending');

// ─────────────────────────────────────────────────────────────────────────
// B1 part 2: Also guard the P() flush handler (called on beforeunload +
// visibilitychange). Skip the bulk /api/tasks PUT if any single-save is
// in flight — this prevents the tab-switch race.
//
// Pristine:
//   ke.current&&(clearTimeout(ke.current),ke.current=void 0,
//     fetch("/api/tasks",{method:"PUT",...,body:JSON.stringify(K.current),
//       keepalive:!0}).catch(()=>{}))
//
// New: only do the flush if there are no in-flight single-saves. If
// single-saves are pending, they're handling the state correctly — the
// bulk flush would only race and potentially write stale data.
// ─────────────────────────────────────────────────────────────────────────
const OLD_FLUSH =
  'ke.current&&(clearTimeout(ke.current),ke.current=void 0,' +
  'fetch("/api/tasks",{method:"PUT",headers:{"Content-Type":"application/json"},' +
  'body:JSON.stringify(K.current),keepalive:!0}).catch(()=>{}))';

const NEW_FLUSH =
  'ke.current&&(clearTimeout(ke.current),ke.current=void 0,' +
  '(typeof _pendingSaves!=="undefined"&&Object.keys(_pendingSaves).length>0)?void 0:' +
  'fetch("/api/tasks",{method:"PUT",headers:{"Content-Type":"application/json"},' +
  'body:JSON.stringify(K.current),keepalive:!0}).catch(()=>{}))';

rep(OLD_FLUSH, NEW_FLUSH, 'B1b: P() flush skips bulk PUT if single-saves pending');

} // end: if (!v5AlreadyApplied) — B1/B2 block

// ═════════════════════════════════════════════════════════════════════════
// PASS A: Department-based dept gating on Action Board Pause/End/Resume
//
// The pristine Start button already uses this exact IIFE pattern:
//   (u.executionState==="Not Started"||!u.executionState)&&(()=>{
//     const userDept=(i?.role==="content")?"Content":(i?.role==="web")?"Web":"SEO";
//     const canStart=g||u.currentOwner===userDept;
//     return <button>...</button>
//   })()
//
// We mirror that pattern for the In Progress / Rework block (Pause + End)
// and the Paused block (Resume + End), in BOTH layouts:
//   - icon variant (compact rows, p-1.5 class)
//   - labeled variant (big buttons with text, px-4 py-2 class)
//
// SAFETY: Each replacement wraps an existing block in its own IIFE scope,
// so `canAct` is defined exactly where it's needed. NO reliance on
// outer-scope variables. Mirrors Start's proven pattern.
// ═════════════════════════════════════════════════════════════════════════

// Shared IIFE header to compute canAct in scope
const IIFE_HEAD =
  '(()=>{' +
    'const userDept=(i?.role==="content")?"Content":(i?.role==="web")?"Web":"SEO";' +
    'const canAct=g||u.currentOwner===userDept;' +
    'return ';
const IIFE_TAIL = '})()';

// ── Pass A1: Icon variant, In Progress/Rework block (Pause + End) ────────
const OLD_ICON_INPROG =
  '(u.executionState==="In Progress"||u.executionState==="Rework")&&n.jsxs(n.Fragment,{children:[' +
  'n.jsx("button",{onClick:()=>Te(u.id,"pause","Paused"),className:"p-1.5 bg-amber-100 hover:bg-amber-200 text-amber-700 rounded-md",title:"Pause",children:n.jsx(Qs,{className:"w-3.5 h-3.5"})}),' +
  'n.jsx("button",{onClick:()=>R(u),className:"p-1.5 bg-emerald-100 hover:bg-emerald-200 text-emerald-700 rounded-md",title:"End Task",children:n.jsx(pn,{className:"w-3.5 h-3.5"})})]})';

const NEW_ICON_INPROG =
  '(u.executionState==="In Progress"||u.executionState==="Rework")&&' +
  IIFE_HEAD +
  'n.jsxs(n.Fragment,{children:[' +
  'n.jsx("button",{onClick:()=>canAct&&Te(u.id,"pause","Paused"),disabled:!canAct,className:`p-1.5 rounded-md ${canAct?"bg-amber-100 hover:bg-amber-200 text-amber-700":"bg-slate-100 text-slate-300 cursor-not-allowed"}`,title:canAct?"Pause":`With ${u.currentOwner} team`,children:n.jsx(Qs,{className:"w-3.5 h-3.5"})}),' +
  'n.jsx("button",{onClick:()=>canAct&&R(u),disabled:!canAct,className:`p-1.5 rounded-md ${canAct?"bg-emerald-100 hover:bg-emerald-200 text-emerald-700":"bg-slate-100 text-slate-300 cursor-not-allowed"}`,title:canAct?"End Task":`With ${u.currentOwner} team`,children:n.jsx(pn,{className:"w-3.5 h-3.5"})})]})' +
  IIFE_TAIL;

rep(OLD_ICON_INPROG, NEW_ICON_INPROG, 'Pass A1: Icon variant In Progress (Pause + End) dept-gated');

// ── Pass A2: Icon variant, Paused block (Resume + End) ───────────────────
const OLD_ICON_PAUSED =
  'u.executionState==="Paused"&&n.jsxs(n.Fragment,{children:[' +
  'n.jsx("button",{onClick:()=>Te(u.id,"resume","In Progress"),className:"p-1.5 bg-indigo-100 hover:bg-indigo-200 text-indigo-700 rounded-md",title:"Resume",children:n.jsx(Zn,{className:"w-3.5 h-3.5"})}),' +
  'n.jsx("button",{onClick:()=>R(u),className:"p-1.5 bg-emerald-100 hover:bg-emerald-200 text-emerald-700 rounded-md",title:"End Task",children:n.jsx(pn,{className:"w-3.5 h-3.5"})})]})';

const NEW_ICON_PAUSED =
  'u.executionState==="Paused"&&' +
  IIFE_HEAD +
  'n.jsxs(n.Fragment,{children:[' +
  'n.jsx("button",{onClick:()=>canAct&&Te(u.id,"resume","In Progress"),disabled:!canAct,className:`p-1.5 rounded-md ${canAct?"bg-indigo-100 hover:bg-indigo-200 text-indigo-700":"bg-slate-100 text-slate-300 cursor-not-allowed"}`,title:canAct?"Resume":`With ${u.currentOwner} team`,children:n.jsx(Zn,{className:"w-3.5 h-3.5"})}),' +
  'n.jsx("button",{onClick:()=>canAct&&R(u),disabled:!canAct,className:`p-1.5 rounded-md ${canAct?"bg-emerald-100 hover:bg-emerald-200 text-emerald-700":"bg-slate-100 text-slate-300 cursor-not-allowed"}`,title:canAct?"End Task":`With ${u.currentOwner} team`,children:n.jsx(pn,{className:"w-3.5 h-3.5"})})]})' +
  IIFE_TAIL;

rep(OLD_ICON_PAUSED, NEW_ICON_PAUSED, 'Pass A2: Icon variant Paused (Resume + End) dept-gated');

// ── Pass A3: Labeled variant, In Progress/Rework block (Pause + End) ─────
const OLD_LBL_INPROG =
  '(u.executionState==="In Progress"||u.executionState==="Rework")&&n.jsxs(n.Fragment,{children:[' +
  'n.jsxs("button",{onClick:()=>Te(u.id,"pause","Paused"),className:"flex items-center gap-2 px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium rounded-lg",children:[n.jsx(Qs,{className:"w-4 h-4"})," Pause"]}),' +
  'n.jsxs("button",{onClick:()=>R(u),className:"flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg",children:[n.jsx(pn,{className:"w-4 h-4"})," End Task"]})]})';

const NEW_LBL_INPROG =
  '(u.executionState==="In Progress"||u.executionState==="Rework")&&' +
  IIFE_HEAD +
  'n.jsxs(n.Fragment,{children:[' +
  'n.jsxs("button",{onClick:()=>canAct&&Te(u.id,"pause","Paused"),disabled:!canAct,title:canAct?"Pause":`This task is currently with the ${u.currentOwner} team`,className:`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${canAct?"bg-amber-500 hover:bg-amber-600 text-white cursor-pointer":"bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200"}`,children:[n.jsx(Qs,{className:"w-4 h-4"})," Pause",!canAct&&n.jsx("span",{className:"text-xs opacity-75 ml-1",children:`(${u.currentOwner})`})]}),' +
  'n.jsxs("button",{onClick:()=>canAct&&R(u),disabled:!canAct,title:canAct?"End Task":`This task is currently with the ${u.currentOwner} team`,className:`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${canAct?"bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer":"bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200"}`,children:[n.jsx(pn,{className:"w-4 h-4"})," End Task",!canAct&&n.jsx("span",{className:"text-xs opacity-75 ml-1",children:`(${u.currentOwner})`})]})]})' +
  IIFE_TAIL;

rep(OLD_LBL_INPROG, NEW_LBL_INPROG, 'Pass A3: Labeled variant In Progress (Pause + End) dept-gated');

// ── Pass A4: Labeled variant, Paused block (Resume + End) ────────────────
const OLD_LBL_PAUSED =
  'u.executionState==="Paused"&&n.jsxs(n.Fragment,{children:[' +
  'n.jsxs("button",{onClick:()=>Te(u.id,"resume","In Progress"),className:"flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg",children:[n.jsx(Zn,{className:"w-4 h-4"})," Resume"]}),' +
  'n.jsxs("button",{onClick:()=>R(u),className:"flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg",children:[n.jsx(pn,{className:"w-4 h-4"})," End Task"]})]})';

const NEW_LBL_PAUSED =
  'u.executionState==="Paused"&&' +
  IIFE_HEAD +
  'n.jsxs(n.Fragment,{children:[' +
  'n.jsxs("button",{onClick:()=>canAct&&Te(u.id,"resume","In Progress"),disabled:!canAct,title:canAct?"Resume":`This task is currently with the ${u.currentOwner} team`,className:`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${canAct?"bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer":"bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200"}`,children:[n.jsx(Zn,{className:"w-4 h-4"})," Resume",!canAct&&n.jsx("span",{className:"text-xs opacity-75 ml-1",children:`(${u.currentOwner})`})]}),' +
  'n.jsxs("button",{onClick:()=>canAct&&R(u),disabled:!canAct,title:canAct?"End Task":`This task is currently with the ${u.currentOwner} team`,className:`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${canAct?"bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer":"bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200"}`,children:[n.jsx(pn,{className:"w-4 h-4"})," End Task",!canAct&&n.jsx("span",{className:"text-xs opacity-75 ml-1",children:`(${u.currentOwner})`})]})]})' +
  IIFE_TAIL;

rep(OLD_LBL_PAUSED, NEW_LBL_PAUSED, 'Pass A4: Labeled variant Paused (Resume + End) dept-gated');

// ── Write out ────────────────────────────────────────────────────────────
fs.writeFileSync(BUNDLE, code, 'utf-8');

console.log(`\nSize after:    ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);
console.log(`Changes applied: ${changes}`);
console.log('\nDONE.');
console.log(`Rollback (if needed):  cp "${backup}" "${BUNDLE}"`);
