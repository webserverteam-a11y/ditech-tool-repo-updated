#!/usr/bin/env node
/**
 * scripts/patch-session-timeout.js  (V1.0)
 *
 * 24-hour session timeout + stale-tab reload.
 *
 * WHY
 * ───
 * Login lives only in the browser: the user object is kept in
 * localStorage "seo_current_user" and never expires. A machine that was
 * logged in weeks ago is still logged in today, and a tab left open for days
 * keeps running whatever bundle it loaded back then — which is how an old
 * system re-saved stale task copies over newer data.
 *
 * WHAT
 * ────
 *   • Login records its time in localStorage "seo_login_at".
 *   • More than 24h after login the user is logged out (both keys cleared)
 *     and the page reloads to the login screen.
 *   • A tab open for more than 24h reloads, so it picks up the current bundle
 *     even if the user logged in again from another tab.
 *   • Checked on page load, every 60s, and when the tab becomes visible.
 *   • Users already logged in when this ships (no "seo_login_at" yet) get
 *     24h counted from their first page load after deploy, not an instant
 *     logout.
 *
 * Timers are server-side events, so a running timer keeps running across the
 * logout; the user sees it again after logging back in.
 *
 * NOTE: this is client-side only. It does not secure the API — the server
 * still has no session check (backend/middleware/auth.js is a pass-through).
 *
 * Idempotent: re-running detects the V1.0 marker and exits cleanly.
 * Creates a timestamped backup before writing.
 *
 * Usage: node scripts/patch-session-timeout.js
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
const MARKER = '/*SESSION_TIMEOUT_V1_0_APPLIED*/';
if (code.includes(MARKER)) {
  console.log('\nAlready patched (V1.0 marker found). Nothing to do.');
  process.exit(0);
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
const backup = BUNDLE.replace('.js', `.bak-session-timeout-${ts}.js`);
fs.copyFileSync(BUNDLE, backup);
console.log(`\nBackup: ${path.basename(backup)}\n`);
console.log('Applying patches...\n');

// ── 1. Session helpers + startup check + periodic check ───────────────────────
// Inserted at module top level, before React first reads "seo_current_user",
// so an expired login is cleared before the app renders.
rep(
  'var _pendingSaves={};',
  MARKER +
  'var _SESSION_MAX_MS=24*60*60*1000,_tabLoadedAt=Date.now();' +
  'function _markLogin(){try{localStorage.setItem("seo_login_at",String(Date.now()))}catch(e){}}' +
  'function _sessionExpired(){try{' +
    'if(!localStorage.getItem("seo_current_user"))return false;' +
    'var at=Number(localStorage.getItem("seo_login_at"));' +
    'if(!at){_markLogin();return false}' +       // logged in before this shipped
    'return Date.now()-at>_SESSION_MAX_MS' +
  '}catch(e){return false}}' +
  'function _endSession(){try{localStorage.removeItem("seo_current_user");localStorage.removeItem("seo_login_at")}catch(e){}}' +
  'if(_sessionExpired())_endSession();' +
  'function _sessionCheck(){' +
    'if(_sessionExpired()){_endSession();location.reload();return}' +
    'if(Date.now()-_tabLoadedAt>_SESSION_MAX_MS)location.reload()' +
  '}' +
  'setInterval(_sessionCheck,60000);' +
  'document.addEventListener("visibilitychange",function(){if(!document.hidden)_sessionCheck()});' +
  'var _pendingSaves={};',
  'Insert marker + session helpers and checks'
);

// ── 2. Record login time ──────────────────────────────────────────────────────
rep(
  'return Je?(F(Je),!0):!1}',
  'return Je?(_markLogin(),F(Je),!0):!1}',
  'Login: record seo_login_at'
);

// ── Write patched bundle ──────────────────────────────────────────────────────
fs.writeFileSync(BUNDLE, code, 'utf-8');

console.log(`\n✅ ${changeCount} patch(es) applied successfully.`);
console.log(`Size after:    ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);
console.log('\nWhat changed:');
console.log('  Users are logged out 24h after login; tabs open 24h+ reload.');
