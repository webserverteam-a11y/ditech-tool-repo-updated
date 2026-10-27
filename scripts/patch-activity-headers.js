#!/usr/bin/env node
/**
 * scripts/patch-activity-headers.js  (V1.0)
 *
 * Tags every /api request with who sent it, for the server-side activity log
 * (backend/services/activityLog.service.js).
 *
 * Headers added:
 *   X-User        — logged-in user (ownerName || name), URI-encoded
 *   X-Tab-Id      — random id per browser tab (sessionStorage), so two tabs
 *                   or two machines of the same user can be told apart
 *   X-App-Loaded  — when this tab loaded its code; a tab loaded before the
 *                   last deploy is running old code
 *   X-App-Bundle  — bundle file name this tab is running
 *
 * Implemented as a window.fetch wrapper so every existing call site is
 * covered without touching each one. navigator.sendBeacon cannot carry
 * headers; those requests are still logged, just without these fields.
 *
 * Idempotent: re-running detects the V1.0 marker and exits cleanly.
 * Creates a timestamped backup before writing.
 *
 * Usage: node scripts/patch-activity-headers.js
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
const MARKER = '/*ACTIVITY_HEADERS_V1_0_APPLIED*/';
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
const backup = BUNDLE.replace('.js', `.bak-activity-headers-${ts}.js`);
fs.copyFileSync(BUNDLE, backup);
console.log(`\nBackup: ${path.basename(backup)}\n`);
console.log('Applying patches...\n');

// ── 1. fetch wrapper, installed at module top level ───────────────────────────
// Anchored on the same top-level statement the other runtime patches use.
rep(
  'var _pendingSaves={};',
  MARKER +
  '(function(){try{' +
    'var _of=window.fetch;if(!_of||_of.__activityTagged)return;' +
    'var tab="";try{tab=sessionStorage.getItem("seo_tab_id")||""}catch(e){}' +
    'if(!tab){tab=Math.random().toString(36).slice(2,10)+Date.now().toString(36);' +
      'try{sessionStorage.setItem("seo_tab_id",tab)}catch(e){}}' +
    'var loaded=new Date().toISOString();' +
    'var bundle="";try{var s=document.querySelector(\'script[src*="/assets/index-"]\');' +
      'bundle=s?s.getAttribute("src").split("/").pop():""}catch(e){}' +
    'function who(){try{var u=JSON.parse(localStorage.getItem("seo_current_user")||"null");' +
      'return u?(u.ownerName||u.name||""):""}catch(e){return""}}' +
    'var wrapped=function(input,init){try{' +
      'var url=typeof input==="string"?input:(input&&input.url)||"";' +
      'if(url.indexOf("/api/")===0||url.indexOf(location.origin+"/api/")===0){' +
        'init=Object.assign({},init||{});' +
        'var h=new Headers(init.headers||(typeof input!=="string"&&input.headers)||{});' +
        'h.set("X-Tab-Id",tab);h.set("X-App-Loaded",loaded);h.set("X-App-Bundle",bundle);' +
        'var u=who();if(u)h.set("X-User",encodeURIComponent(u));' +
        'init.headers=h}' +
    '}catch(e){}return _of.call(this,input,init)};' +
    'wrapped.__activityTagged=true;window.fetch=wrapped' +
  '}catch(e){}})();' +
  'var _pendingSaves={};',
  'Insert marker + fetch wrapper adding X-User / X-Tab-Id / X-App-Loaded / X-App-Bundle'
);

// ── Write patched bundle ──────────────────────────────────────────────────────
fs.writeFileSync(BUNDLE, code, 'utf-8');

console.log(`\n✅ ${changeCount} patch(es) applied successfully.`);
console.log(`Size after:    ${fs.statSync(BUNDLE).size.toLocaleString()} bytes`);
console.log('\nWhat changed:');
console.log('  Every /api request now says which user, tab and app version sent it.');
