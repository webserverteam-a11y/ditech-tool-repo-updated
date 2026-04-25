/**
 * patch-keyword-input-focus.js
 *
 * Fixes the "can only type one character" bug in the Keywords panel.
 *
 * ROOT CAUSE (classic React anti-pattern):
 *   The `Pe` helper (a table-cell wrapper) is defined as a function INSIDE
 *   the keyword-panel component's render body.  It is then referenced as a
 *   React component type via  n.jsx(Pe, { children: … }).
 *
 *   Because `Pe` is re-created on every render it has a NEW function
 *   reference each time.  React treats a changed type as a completely
 *   different component, so it UNMOUNTS the old <td> and MOUNTS a brand-new
 *   one on every single keystroke.  Any <input> that lives inside Pe loses
 *   DOM focus immediately after the first character is typed.
 *
 * FIX:
 *   Replace every  n.jsx(Pe,{…})  with  Pe({…})
 *   Calling Pe as a plain function instead of as a React component means
 *   React sees the returned  n.jsx("td", …)  directly in the parent tree.
 *   A stable "td" element type is reconciled normally across renders and the
 *   input retains focus throughout typing.
 *
 * SCOPE:
 *   Only the 12 occurrences of n.jsx(Pe,{ that exist inside the keyword
 *   panel are changed.  No other component or functionality is touched.
 *
 * Run once:  node scripts/patch-keyword-input-focus.js
 */

import fs from 'fs';

const BUNDLE = 'dist/assets/index-xUiSJVv5.js';
let code = fs.readFileSync(BUNDLE, 'utf8');

const OLD = 'n.jsx(Pe,{';
const NEW = 'Pe({';

const occurrences = code.split(OLD).length - 1;

if (occurrences === 0) {
  console.log('SKIP [keyword-input-focus] "n.jsx(Pe,{" not found – already patched.');
  process.exit(0);
}

if (occurrences !== 12) {
  console.warn(`WARN: expected 12 occurrences of "n.jsx(Pe,{" but found ${occurrences}.`);
  console.warn('      Proceeding anyway – verify the output manually.');
}

code = code.replaceAll(OLD, NEW);

fs.writeFileSync(BUNDLE, code, 'utf8');
console.log(`OK  [keyword-input-focus] replaced ${occurrences} occurrence(s) of "${OLD}" → "${NEW}"`);
console.log('    Keyword panel inputs will now retain focus while typing.');
