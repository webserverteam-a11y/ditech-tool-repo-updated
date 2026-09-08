#!/usr/bin/env node
/**
 * scripts/patch-config-default-wipe-fix.js  (V1.0)
 *
 * Fixes clients and users added through the tool silently disappearing and
 * being replaced by the built-in demo lists.
 *
 * ROOT CAUSE
 * ──────────
 * On load the app fetches its config, and each fetch swallows a non-2xx
 * response into `null` rather than throwing:
 *
 *   fetch("/api/config/users", ...).then(r => r.ok ? r.json() : null)
 *
 * Because that is not a rejection, the surrounding try/catch never fires and
 * execution continues into:
 *
 *   Be ? g(Be) : io("admin_options", od)      // od = 14 hardcoded clients
 *   Je && Je.length > 0 ? E(Je) : io("users", D0)   // D0 = 9 hardcoded users
 *   Ge ? U(Ge) : io("nav_access", {})
 *
 * So any browser that loads the page while the API returns 500/502/503 — a
 * redeploy, a restart, a brief DB error — immediately PUTs the hardcoded
 * demo defaults back to the server. The server then treats that payload as
 * authoritative:
 *
 *   PUT /api/config/users        → DELETE FROM users WHERE id NOT IN (...)
 *   PUT /api/config/admin_options → DELETE FROM clients WHERE name IN (...)
 *
 * Net effect: every user and client added through the tool is deleted, the
 * lists revert to the built-in demo data, and the default accounts' passwords
 * are reset to their demo values. No audit entry is written, because no user
 * performed an action.
 *
 * This is the same defect class as the `A0(k0)` task-seed call removed in
 * patch-stale-bulk-flush-fix.js — these are its three siblings, which that
 * patch missed.
 *
 * FIX
 * ───
 * A failed or empty config load must change nothing. Keep whatever is already
 * in the database and leave the in-memory defaults for display only.
 *
 * Idempotent: re-running detects the V1.0 marker and exits cleanly.
 * Creates a timestamped backup before writing.
 *
 * Usage: node scripts/patch-config-default-wipe-fix.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(REPO_ROOT, 'dist', 'assets');
const INDEX_HTML = path.join(REPO_ROOT, 'dist', 'index.html');

function die(msg) { console.error(`\nERROR: ${msg}`); process.exit(1); }

if (!fs.existsSync(INDEX_HTML)) die(`${INDEX_HTML} not found.`);
const html = fs.readFileSync(INDEX_HTML, 'utf-8');
const m = html.match(/index-[A-Za-z0-9_-]+\.js/);
if (!m) die('Could not find bundle reference in dist/index.html');
const BUNDLE = path.join(ASSETS_DIR, m[0]);
if (!fs.existsSync(BUNDLE)) die(`${BUNDLE} not found.`);

console.log(`\nTarget bundle: ${BUNDLE}`);
console.log(`Size before:   ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);

let code = fs.readFileSync(BUNDLE, 'utf-8');

const MARKER = '/*CONFIG_DEFAULT_WIPE_FIX_V1_0_APPLIED*/';
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

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backup = BUNDLE.replace('.js', `.bak-config-wipe-${ts}.js`);
fs.copyFileSync(BUNDLE, backup);
console.log(`\nBackup: ${path.basename(backup)}\n`);
console.log('Applying patches...\n');

rep('/*STALE_BULK_FLUSH_FIX_V1_0_APPLIED*/',
    '/*STALE_BULK_FLUSH_FIX_V1_0_APPLIED*/' + MARKER,
    'Insert V1.0 idempotency marker');

// A failed admin_options load must not overwrite the clients table with the
// built-in demo client list.
rep('Be?g(Be):io("admin_options",od)',
    'Be?g(Be):void 0',
    'Fix: failed admin_options load no longer overwrites clients with demo defaults');

// A failed or empty users load must not overwrite the users table with the
// built-in demo accounts (which also resets their passwords).
rep('Je&&Je.length>0?E(Je):io("users",D0)',
    'Je&&Je.length>0?E(Je):void 0',
    'Fix: failed users load no longer overwrites the users table with demo accounts');

// Same for nav access permissions.
rep('Ge?U(Ge):io("nav_access",{})',
    'Ge?U(Ge):void 0',
    'Fix: failed nav_access load no longer resets navigation permissions');

fs.writeFileSync(BUNDLE, code, 'utf-8');
console.log(`\n✅ ${changeCount} patch(es) applied successfully.`);
console.log(`Size after:    ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);
console.log('\nWhat changed:');
console.log('  A failed or empty config load now changes nothing. Previously it');
console.log('  wrote the built-in demo clients/users/nav-access back to the');
console.log('  server, which deleted everything added through the tool.');
