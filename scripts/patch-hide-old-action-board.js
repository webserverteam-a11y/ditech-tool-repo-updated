#!/usr/bin/env node
/**
 * scripts/patch-hide-old-action-board.js  (V1.0)
 *
 * Retires the old in-app Action Board. Everyone works in Action Board 2.0
 * (/alt-action-board), which saves field-by-field with a version check.
 *
 * Changes to the compiled bundle:
 *   1. The "Action Board" item is removed from the sidebar for every role.
 *   2. The old board's screen is replaced by a "moved" panel with a button
 *      that opens Action Board 2.0. This also covers the app's default tab
 *      (the old board) and any other path that would have shown it, so the
 *      old board's code is never mounted.
 *
 * The "Action Board 2.0" sidebar item (patch-add-alt-action-board-nav.js)
 * still appears: with "Action Board" gone it clones the "Work Hub" item.
 *
 * To undo: restore the .bak-hide-old-ab backup this script writes.
 *
 * Idempotent: re-running detects the V1.0 marker and exits cleanly.
 *
 * Usage: node scripts/patch-hide-old-action-board.js
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
const html = fs.readFileSync(INDEX_HTML, 'utf-8');
const m    = html.match(/index-[A-Za-z0-9_-]+\.js/);
if (!m) die('Could not find bundle reference in dist/index.html');
const BUNDLE = path.join(ASSETS_DIR, m[0]);
if (!fs.existsSync(BUNDLE)) die(`${BUNDLE} not found.`);

console.log(`\nTarget bundle: ${BUNDLE}`);
let code = fs.readFileSync(BUNDLE, 'utf-8');

const MARKER = '/*HIDE_OLD_ACTION_BOARD_V1_0_APPLIED*/';
if (code.includes(MARKER)) {
  console.log('\nAlready patched (V1.0 marker found). Nothing to do.');
  process.exit(0);
}

let changeCount = 0;
function rep(oldStr, newStr, label) {
  const parts = code.split(oldStr);
  if (parts.length === 1) die(`[${label}]: anchor NOT found in bundle.`);
  if (parts.length > 2) die(`[${label}]: anchor matched ${parts.length - 1} times (expected 1).`);
  code = parts[0] + newStr + parts[1];
  changeCount++;
  console.log(`  ✔ ${label}`);
}

const ts     = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backup = BUNDLE.replace('.js', `.bak-hide-old-ab-${ts}.js`);
fs.copyFileSync(BUNDLE, backup);
console.log(`Backup:        ${backup}`);

// 1. Sidebar: drop the "action" item for every role.
rep(
  'ye=K.filter(ke=>ze(ke.id))',
  'ye=K.filter(ke=>ke.id!=="action"&&ze(ke.id))',
  'sidebar: hide "Action Board"'
);

// 2. Panel shown instead of the old board.
const MOVED =
  MARKER +
  'function _AB2Moved(){return n.jsx("div",{className:"p-8 flex items-center justify-center",style:{minHeight:"60vh"},' +
  'children:n.jsxs("div",{className:"max-w-md w-full bg-white border border-slate-200 rounded-xl p-8 text-center shadow-sm",children:[' +
  'n.jsx("h2",{className:"text-xl font-bold text-slate-800 mb-2",children:"Action Board has moved"}),' +
  'n.jsx("p",{className:"text-slate-600 mb-6",children:"All task work now happens in Action Board 2.0. It opens in a new tab."}),' +
  'n.jsx("a",{href:"/alt-action-board",target:"_blank",rel:"noopener",className:"inline-block px-5 py-2.5 rounded-lg text-white font-medium",style:{background:"#1E2D8B"},children:"Open Action Board 2.0"})' +
  ']})})}';
rep('function Xy(){', MOVED + 'function Xy(){', 'add "moved" panel');

// 3. Render the panel wherever the old board was rendered.
rep('case"action":return n.jsx(q0,{});', 'case"action":return n.jsx(_AB2Moved,{});', 'view: action tab');
rep('default:return n.jsx(q0,{})}};', 'default:return n.jsx(_AB2Moved,{})}};', 'view: default tab');

fs.writeFileSync(BUNDLE, code, 'utf-8');
console.log(`\nDone: ${changeCount} change(s) applied.`);
