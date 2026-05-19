#!/usr/bin/env node
/**
 * scripts/patch-timesheet-logged-url-cols.js
 *
 * Adds "Doc URL" and "Target URL" columns to the Timesheet panel's
 * LOGGED-TIME table (the task rows shown under each owner's section,
 * columns: Task | Client | Dept | Owner | Est hrs | Logged | Productive | Overrun | Rework).
 *
 * Both fields already exist in the DB and API response (docUrl / targetUrl).
 * This patch makes them visible as the 2nd and 3rd columns after "Task".
 *
 * Two replacements applied to the main bundle:
 *
 *   R1. Column header array — inserts Doc URL and Target URL objects after
 *       the Task entry in the headers array.
 *
 *   R2. Row data cells — inserts two <td> cells (Doc URL link and Target URL
 *       link) after the Task title cell, before the Client cell, in each row.
 *
 * Idempotent: re-running detects the patch marker and exits cleanly.
 * Creates a timestamped backup before writing.
 *
 * Usage:
 *   node scripts/patch-timesheet-logged-url-cols.js
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

// ── Idempotency check ─────────────────────────────────────────────────────
const MARKER = '/*TIMESHEET_LOGGED_URL_COLS_APPLIED*/';
if (code.includes(MARKER)) {
  console.log('\nAlready patched (marker found). Nothing to do.');
  process.exit(0);
}

// ── Backup ────────────────────────────────────────────────────────────────
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 15);
const backup = `${BUNDLE}.bak-${ts}`;
fs.copyFileSync(BUNDLE, backup);
console.log(`Backup created: ${backup}`);

let changes = 0;

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

// ── R1: Column header array ───────────────────────────────────────────────
// Inserts Doc URL and Target URL header objects after the Task header entry.
rep(
  `{label:"Task",align:"left",minW:200},{label:"Client",align:"left",minW:100}`,
  `{label:"Task",align:"left",minW:200},{label:"Doc URL",align:"left",minW:80},{label:"Target URL",align:"left",minW:80},{label:"Client",align:"left",minW:100}`,
  'R1: Logged-time table column headers'
);

// ── R2: Row data cells ────────────────────────────────────────────────────
// Inserts two <td> cells (Doc URL link and Target URL link) after the Task
// title cell and before the Client cell in every rendered row.
rep(
  `n.jsx("td",{style:{padding:"9px 10px",borderBottom:"0.5px solid var(--color-border-tertiary)",fontSize:12,color:"var(--color-text-secondary)",whiteSpace:"nowrap"},children:ae.client})`,
  `n.jsx("td",{style:{padding:"9px 10px",borderBottom:"0.5px solid var(--color-border-tertiary)",maxWidth:100},children:ae.docUrl?n.jsx("a",{href:ae.docUrl,target:"_blank",rel:"noreferrer",style:{fontSize:10,color:"#185FA5",display:"block",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:90},children:"Doc \u2197"}):n.jsx("span",{style:{color:"#9CA3AF",fontSize:11},children:"\u2014"})}),n.jsx("td",{style:{padding:"9px 10px",borderBottom:"0.5px solid var(--color-border-tertiary)",maxWidth:100},children:ae.targetUrl?n.jsx("a",{href:ae.targetUrl,target:"_blank",rel:"noreferrer",style:{fontSize:10,color:"#185FA5",display:"block",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:90},children:"URL \u2197"}):n.jsx("span",{style:{color:"#9CA3AF",fontSize:11},children:"\u2014"})}),n.jsx("td",{style:{padding:"9px 10px",borderBottom:"0.5px solid var(--color-border-tertiary)",fontSize:12,color:"var(--color-text-secondary)",whiteSpace:"nowrap"},children:ae.client})`,
  'R2: Row data cells — Doc URL + Target URL <td>s'
);

// ── Inject idempotency marker ─────────────────────────────────────────────
code += MARKER;
changes++;

// ── Write out ─────────────────────────────────────────────────────────────
fs.writeFileSync(BUNDLE, code, 'utf-8');

console.log(`\nSize after:    ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);
console.log(`Changes applied: ${changes}`);
console.log('\nDONE.');
console.log(`Rollback (if needed):  copy "${backup}" "${BUNDLE}"`);
