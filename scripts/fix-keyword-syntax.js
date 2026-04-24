/**
 * fix-keyword-syntax.js
 * Fixes the "Missing initializer in const declaration" error introduced
 * by the useEffect injection. The useEffect call was placed inside a
 * const variable chain — invalid JS. Fix: prefix it with a dummy binding.
 */
import fs from 'fs';

const BUNDLE = 'dist/assets/index-xUiSJVv5.js';
let code = fs.readFileSync(BUNDLE, 'utf8');

// Find the bad pattern: v.useEffect(...),[],  — bare call inside const chain
// Replace with: _kwEff=v.useEffect(...),[],  — valid const binding
const idx = code.indexOf('v.useEffect(()=>{fetch("/api/historical-keywords")');
if (idx === -1) {
  console.log('NOT FOUND — already fixed or patch not applied.');
  process.exit(0);
}

// Check it is NOT already prefixed with an assignment
const before = code.slice(Math.max(0, idx - 5), idx);
if (before.endsWith('=')) {
  console.log('Already has assignment prefix — nothing to do.');
  process.exit(0);
}

// Prefix with dummy variable to make it a valid const entry
code = code.slice(0, idx) + '_kwEff=' + code.slice(idx);
fs.writeFileSync(BUNDLE, code, 'utf8');
console.log('FIXED: added _kwEff= prefix to useEffect call at index', idx);
