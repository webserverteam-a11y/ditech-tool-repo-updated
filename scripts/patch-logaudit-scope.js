/**
 * patch-logaudit-scope.js
 *
 * Fixes "ReferenceError: logAudit is not defined" caused by the Action Board
 * and Task Entry components calling logAudit() without including it in their
 * hn() (useAppContext) destructuring.
 *
 * Each component that calls logAudit needs it added to its hn() destructure.
 * Run from the project root:
 *   node scripts/patch-logaudit-scope.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(__dirname, '../dist/assets/index-xUiSJVv5.js');
let code = fs.readFileSync(bundlePath, 'utf8');

let patchCount = 0;

// ── Strategy ─────────────────────────────────────────────────────────────────
// 1. The Action Board component (q0) destructures:
//      const{tasks:s,setTasks:d,adminOptions:p,currentUser:i,isAdmin:g}=hn()
//    and then calls logAudit() bare → ReferenceError.
//    Fix: add ,logAudit to the destructuring.
//
// 2. The Task Entry component has a similar pattern.
//
// 3. Fallback: if we can't find the exact destructuring strings, inject
//    `var logAudit=window.logAudit||function(){};` at the top of the bundle
//    body as a global shim, and also provide window.logAudit via index.html.
// ─────────────────────────────────────────────────────────────────────────────

// Find all hn() destructurings that DON'T already include logAudit
// Pattern: const{...fields...}=hn() where logAudit is not in the fields
const hnPattern = /const\{([^}]{10,400})\}=hn\(\)/g;
let match;
const patches = [];

while ((match = hnPattern.exec(code)) !== null) {
  const fields = match[1];
  const fullMatch = match[0];
  const startIdx = match.index;

  if (fields.includes('logAudit')) continue; // already has it

  // Only patch components that actually CALL logAudit within the next 20000 chars
  const after = code.slice(startIdx, startIdx + 20000);
  if (!after.includes('logAudit(')) continue;

  patches.push({ startIdx, fullMatch, fields });
  console.log(`Found hn() at pos ${startIdx} without logAudit — will patch`);
  console.log(`  Fields: ${fields.slice(0, 80)}...`);
}

if (patches.length > 0) {
  // Apply patches in reverse order so positions stay valid
  patches.reverse().forEach(({ startIdx, fullMatch, fields }) => {
    const patched = `const{${fields},logAudit}=hn()`;
    code = code.slice(0, startIdx) + patched + code.slice(startIdx + fullMatch.length);
    patchCount++;
    console.log(`✓ Patched hn() at pos ${startIdx}`);
  });
} else {
  console.log('No hn() destructurings found that need patching.');
}

// ── Verify all logAudit call sites now have it in scope ─────────────────────
// As a belt-and-suspenders fallback, also inject a global shim at the start
// of the bundle so any missed call site (e.g. in setTimeout callbacks) still
// doesn't throw.
const shimMark = '/*__logAudit_shim__*/';
if (!code.includes(shimMark)) {
  // Inject right after the opening IIFE or module wrapper
  // The bundle starts with (function(){ — insert shim after the first '{'
  const insertAt = code.indexOf('{') + 1;
  const shim = `${shimMark}if(typeof logAudit==="undefined"){var logAudit=function(e){try{fetch("/api/audit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...e,timestamp:new Date().toISOString(),userName:(window.__dtUser&&window.__dtUser.name)||"",userRole:(window.__dtUser&&window.__dtUser.role)||""})})}catch(err){}}}`;
  code = code.slice(0, insertAt) + shim + code.slice(insertAt);
  patchCount++;
  console.log(`✓ Injected logAudit fallback shim at pos ${insertAt}`);
}

// Verify syntax
try {
  new Function(code);
  console.log('\nSyntax OK ✓');
} catch (e) {
  console.error('\nSYNTAX ERROR after patch:', e.message);
  process.exit(1);
}

fs.writeFileSync(bundlePath, code, 'utf8');
console.log(`\nDone — ${patchCount} patch(es) applied to ${path.basename(bundlePath)}`);
