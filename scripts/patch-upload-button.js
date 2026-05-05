/**
 * patch-upload-button.js
 *
 * Restores the missing Upload button in the Keyword Reporting panel.
 *
 * The upload logic (CSV parsing, smart upsert by keyword+client) is fully
 * working in the bundle — the button was simply replaced with null at some
 * point. This patch puts it back between the Template button and the
 * Backup & Restore button.
 *
 * After this patch the header buttons will be:
 *   ↓ Template   ↑ Upload CSV   Backup & Restore   History   ↓ Export CSV
 *
 * Run once:
 *   node scripts/patch-upload-button.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(__dirname, '..', 'dist', 'assets', 'index-xUiSJVv5.js');

if (!fs.existsSync(BUNDLE)) {
  console.error('ERROR: Bundle not found at', BUNDLE);
  process.exit(1);
}

let code = fs.readFileSync(BUNDLE, 'utf-8');
let changeCount = 0;

function rep(oldStr, newStr, label) {
  if (!code.includes(oldStr)) {
    console.log(`  ⏭ ${label}: already patched, skipping.`);
    return;
  }
  const parts = code.split(oldStr);
  if (parts.length !== 2) {
    console.error(`FAILED [${label}]: anchor matched ${parts.length - 1} times (expected 1)`);
    process.exit(1);
  }
  code = parts[0] + newStr + parts[1];
  changeCount++;
  console.log(`  ✓ ${label}`);
}

console.log('Patching Upload button restore...\n');

// ─────────────────────────────────────────────────────────────────────────────
// Replace the null placeholder with the Upload CSV button.
//
// The hidden <input type="file"> (ref=i, onChange=h) is already in place —
// h() is the CSV parse handler, and i is the ref used to trigger the picker.
// We just need a visible button that calls i.current.click().
// ─────────────────────────────────────────────────────────────────────────────
rep(
  'n.jsx("input",{type:"file",accept:".csv",ref:i,className:"hidden",onChange:h}),null,',

  'n.jsx("input",{type:"file",accept:".csv",ref:i,className:"hidden",onChange:h}),' +
  // Upload CSV button — triggers the hidden file input
  'n.jsxs("button",{' +
    'onClick:function(){if(i&&i.current)i.current.click()},' +
    'className:"flex items-center gap-2 bg-white hover:bg-zinc-50 text-zinc-700 px-3 py-2 rounded-md text-sm font-medium border border-zinc-300 shadow-sm",' +
    'title:"Upload a CSV to add or update keyword records",' +
    'children:[n.jsx(xa,{size:15})," Upload CSV"]' +
  '}),' +

  '',

  'Restore Upload CSV button (was null)'
);

if (changeCount > 0) {
  fs.writeFileSync(BUNDLE, code, 'utf-8');
  console.log(`\n✅ Patched successfully — ${changeCount} replacement applied.`);
} else {
  console.log(`\n✅ Already patched — no changes needed.`);
}
