#!/usr/bin/env node
/**
 * scripts/patch-timesheet-url-cols.js
 *
 * Adds "Doc URL" and "Target URL" columns to the Timesheet panel's
 * pending-tasks table (the table shown on the main Timesheet tab).
 *
 * Both fields already exist in the DB and API response (docUrl / targetUrl).
 * This patch makes them visible as columns in the UI table.
 *
 * Four replacements applied to the main bundle:
 *
 *   R1. Column header arrays — inserts "Doc URL","Target URL" after "Task"
 *       in both variants of the ternary (read-only and editable mode).
 *
 *   R2. Empty-state colSpan — updates the "No pending tasks for …" cell
 *       from colSpan:8 to colSpan:10 to cover the 2 new columns.
 *
 *   R3. Row data cells — inserts two <td> cells (Doc URL link and Target URL
 *       link) after the Task title cell, before the Client cell, in each row.
 *
 *   R4. Footer colSpan — updates "Total in range" label span from
 *       colSpan:be?4:5 to colSpan:be?6:7 to absorb the 2 new columns.
 *
 * Idempotent: re-running detects the patch marker and exits cleanly.
 * Creates a timestamped backup before writing.
 *
 * Usage:
 *   node scripts/patch-timesheet-url-cols.js
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
const MARKER = '/*TIMESHEET_URL_COLS_APPLIED*/';
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

// ── R1: Column header arrays ──────────────────────────────────────────────
// Inserts "Doc URL","Target URL" after "Task" in both variants of the ternary.
// Before: be?["Task","Client",...]:["Task","Client",...]
// After:  be?["Task","Doc URL","Target URL","Client",...]:["Task","Doc URL","Target URL","Client",...]
rep(
  `be?["Task","Client","Stage","Dept","Assigned Date","Est Hrs","Status"]:["Task","Client","Stage","Dept","Assigned Date ✎","Est Hrs","Status","Move to range"]`,
  `be?["Task","Doc URL","Target URL","Client","Stage","Dept","Assigned Date","Est Hrs","Status"]:["Task","Doc URL","Target URL","Client","Stage","Dept","Assigned Date ✎","Est Hrs","Status","Move to range"]`,
  'R1: Timesheet table column headers'
);

// ── R2: Empty-state colSpan ───────────────────────────────────────────────
// Updates the "No pending tasks" empty row from colSpan:8 to colSpan:10
// to cover the 2 new columns (9 when be=true, 10 when be=false — use max).
rep(
  `colSpan:8,style:{padding:20,textAlign:"center",color:"var(--color-text-tertiary)",fontStyle:"italic",fontSize:12},children:["No pending tasks for "`,
  `colSpan:10,style:{padding:20,textAlign:"center",color:"var(--color-text-tertiary)",fontStyle:"italic",fontSize:12},children:["No pending tasks for "`,
  'R2: Empty-state colSpan 8 -> 10'
);

// ── R3: Row data cells ────────────────────────────────────────────────────
// Inserts two <td> cells (Doc URL and Target URL) after the Task title cell
// and before the Client cell, in every rendered row.
//
// Each cell shows a short clickable link when the URL is set, or "—" if not.
const R3_OLD =
  `children:["⚠ Overdue — was ",at]})]})` +
  `,n.jsx("td",{style:{padding:"8px 10px",borderBottom:"0.5px solid #E2E8F0",fontSize:11,color:"var(--color-text-secondary)",whiteSpace:"nowrap"},children:Ke.client})`;

const R3_NEW =
  `children:["⚠ Overdue — was ",at]}]})` +
  `,n.jsx("td",{style:{padding:"8px 10px",borderBottom:"0.5px solid #E2E8F0",maxWidth:140},children:Ke.docUrl?n.jsx("a",{href:Ke.docUrl,target:"_blank",rel:"noreferrer",style:{fontSize:10,color:"#185FA5",display:"block",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:130},children:"Doc"}):n.jsx("span",{style:{color:"#9CA3AF",fontSize:11},children:"—"})})` +
  `,n.jsx("td",{style:{padding:"8px 10px",borderBottom:"0.5px solid #E2E8F0",maxWidth:140},children:Ke.targetUrl?n.jsx("a",{href:Ke.targetUrl,target:"_blank",rel:"noreferrer",style:{fontSize:10,color:"#185FA5",display:"block",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:130},children:"URL"}):n.jsx("span",{style:{color:"#9CA3AF",fontSize:11},children:"—"})})` +
  `,n.jsx("td",{style:{padding:"8px 10px",borderBottom:"0.5px solid #E2E8F0",fontSize:11,color:"var(--color-text-secondary)",whiteSpace:"nowrap"},children:Ke.client})`;

rep(R3_OLD, R3_NEW, 'R3: Row data cells — Doc URL + Target URL <td>s');

// ── R4: Footer colSpan ────────────────────────────────────────────────────
// Extends the "Total in range" footer label span to absorb 2 new columns.
// be=true:  4 -> 6  (covers Task,DocURL,TargetURL,Client,Stage,Dept)
// be=false: 5 -> 7  (same + AssignedDate✎ is added when not read-only)
rep(
  `colSpan:be?4:5,style:{padding:"7px 10px",fontSize:11,fontWeight:600,color:"#1E40AF"},children:"Total in range"`,
  `colSpan:be?6:7,style:{padding:"7px 10px",fontSize:11,fontWeight:600,color:"#1E40AF"},children:"Total in range"`,
  'R4: Footer colSpan be?4:5 -> be?6:7'
);

// ── Inject idempotency marker ─────────────────────────────────────────────
// Append to the very end of the bundle so future runs can detect this patch.
code += MARKER;
changes++;

// ── Write out ─────────────────────────────────────────────────────────────
fs.writeFileSync(BUNDLE, code, 'utf-8');

console.log(`\nSize after:    ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);
console.log(`Changes applied: ${changes}`);
console.log('\nDONE.');
console.log(`Rollback (if needed):  cp "${backup}" "${BUNDLE}"`);
