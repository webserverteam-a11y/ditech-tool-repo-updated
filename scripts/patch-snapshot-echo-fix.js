#!/usr/bin/env node
/**
 * scripts/patch-snapshot-echo-fix.js  (V1.0)
 *
 * Fixes tasks ending / reverting / vanishing on their own when several people
 * have the app open ("ye task apne aap end kaise ho rahe hai?").
 *
 * ROOT CAUSE
 * ──────────
 * patch-dirty-track-save.js made A0() save only tasks whose fields differ from
 * _dtSnapshot. But _dtSnapshot is only updated after THIS tab saves a task.
 * Three code paths replace local tasks with fresh server data without
 * touching the snapshot:
 *
 *   1. the 30-second background poll merge
 *   2. the visibilitychange refresh (switching back to the tab)
 *   3. _handleSaveConfirm (inline-edit Save button)
 *
 * So whenever another user changes a task, every OTHER open tab picks up the
 * change, sees it as "dirty" 1.2s later, and PUTs its full copy of the task
 * back. PUT /api/tasks/:id overwrites every column, and the copy it sends is
 * as old as that tab's fetch. Any change made in between — Start, End, a
 * handoff to Content, an owner/date change — is reverted. With N tabs open,
 * each change is echoed N times, each echo a chance to clobber the next one.
 *
 * _handleSaveConfirm is worse: it PUTs EVERY task (not just the edited ones)
 * from a fetch taken a moment earlier, so anything anyone changed during that
 * bulk save is rolled back.
 *
 * FIX
 * ───
 *   • _snapSync(t): record t as the snapshot baseline. Applied to every task
 *     the poll / visibility refresh / bulk save takes from the server, so
 *     those are no longer treated as local edits and never echoed back.
 *   • _handleSaveConfirm sends only the tasks that were actually edited.
 *
 * Idempotent: re-running detects the V1.0 marker and exits cleanly.
 * Creates a timestamped backup before writing.
 *
 * Apply order: run AFTER patch-dirty-track-save.js and patch-poll-merge-fix.js
 * Usage: node scripts/patch-snapshot-echo-fix.js
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
const MARKER = '/*SNAPSHOT_ECHO_FIX_V1_0_APPLIED*/';
if (code.includes(MARKER)) {
  console.log('\nAlready patched (V1.0 marker found). Nothing to do.');
  process.exit(0);
}

if (!code.includes('function _dtSnap(t)')) {
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
const backup = BUNDLE.replace('.js', `.bak-snapshot-echo-${ts}.js`);
fs.copyFileSync(BUNDLE, backup);
console.log(`\nBackup: ${path.basename(backup)}\n`);
console.log('Applying patches...\n');

// ── 1. Marker + _snapSync helper ──────────────────────────────────────────────
// _snapSync marks a task as "matches the server" so A0 does not echo it back.
rep(
  'function _saveTaskById(t){',
  MARKER +
  'function _snapSync(t){if(_dtSnapshot!==null&&t&&t.id)_dtSnapshot[t.id]=_dtSnap(t);return t}' +
  'function _saveTaskById(t){',
  'Insert marker + _snapSync() helper'
);

// ── 2. 30-second poll merge ───────────────────────────────────────────────────
rep(
  'if(_hp)return lt;return(lt.timeEvents||[]).length>(st.timeEvents||[]).length?Object.assign({},st,{timeEvents:lt.timeEvents}):st;});' +
  'var newTasks=_pTasks.filter(function(st){return!cur.find(function(lt){return lt.id===st.id})&&!(typeof _deletedIds!=="undefined"&&_deletedIds.has(st.id))});',

  'if(_hp)return lt;return _snapSync((lt.timeEvents||[]).length>(st.timeEvents||[]).length?Object.assign({},st,{timeEvents:lt.timeEvents}):st);});' +
  'var newTasks=_pTasks.filter(function(st){return!cur.find(function(lt){return lt.id===st.id})&&!(typeof _deletedIds!=="undefined"&&_deletedIds.has(st.id))});' +
  'newTasks.forEach(_snapSync);',

  'Poll merge: server-sourced tasks become the snapshot baseline'
);

// ── 3. visibilitychange refresh ───────────────────────────────────────────────
rep(
  'return Be.map(function(st){var lt=cur.find(function(x){return x.id===st.id});if(lt&&(lt.timeEvents||[]).length>(st.timeEvents||[]).length){return Object.assign({},st,{timeEvents:lt.timeEvents})}return st})',
  'return Be.map(function(st){var lt=cur.find(function(x){return x.id===st.id});if(lt&&(lt.timeEvents||[]).length>(st.timeEvents||[]).length){return _snapSync(Object.assign({},st,{timeEvents:lt.timeEvents}))}return _snapSync(st)})',
  'Visibility refresh: server-sourced tasks become the snapshot baseline'
);

// ── 4. _handleSaveConfirm: only PUT edited tasks ──────────────────────────────
rep(
  'return fetch("/api/tasks",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(merged)})',
  'return fetch("/api/tasks",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(merged.filter(function(t){return!!_PE[t.id]}))})',
  'Inline-edit Save: send only edited tasks, not the whole list'
);
rep(
  '_sOT(newById);_sPE({});_sSM(!1);d(merged);',
  '_sOT(newById);_sPE({});_sSM(!1);merged.forEach(_snapSync);d(merged);',
  'Inline-edit Save: saved list becomes the snapshot baseline'
);

// ── Write patched bundle ──────────────────────────────────────────────────────
fs.writeFileSync(BUNDLE, code, 'utf-8');

console.log(`\n✅ ${changeCount} patch(es) applied successfully.`);
console.log(`Size after:    ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);
console.log('\nWhat changed:');
console.log('  Tasks loaded from the server (poll, tab refocus, inline-edit save)');
console.log('  are no longer re-saved by every open tab, so one user\'s stale copy');
console.log('  can no longer overwrite another user\'s Start / End / handoff.');
console.log('\n  Everyone must hard-refresh (Ctrl+Shift+R) — old tabs keep echoing.');
