/**
 * patch-timer-race-fix.js
 *
 * Fixes the timer stopping / resetting when user switches tabs immediately
 * after clicking Start/Pause/End.
 *
 * Three changes:
 *   1. Debounce delay: 150ms → 800ms. Gives _saveTaskById enough time to
 *      land in DB before the bulk save A0 fires. Previously 150ms was too
 *      short — the bulk save would race against the single-task save.
 *
 *   2. Debounce skips A0 entirely if _pendingSaves has entries. If a
 *      single-task save is already in flight (timer action just happened),
 *      there is no need to also fire a bulk save — it would only race.
 *
 *   3. A0 merge logic now protects executionState (same rank logic as the
 *      visibilitychange fix). Previously A0's fresh-fetch-then-merge only
 *      protected timeEvents count, so it could bulk-save a downgraded
 *      executionState ("Not Started") back to the DB, undoing the timer start.
 *
 * Run after patch-timer-fix.js and patch-visibility-fix.js:
 *   node scripts/patch-timer-race-fix.js
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
    console.error(`FAILED [${label}]: anchor not found`);
    process.exit(1);
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

console.log('Patching timer race condition fix...\n');

// ─────────────────────────────────────────────────────────────────────────────
// Fix 1 + 2: Debounce — increase delay 150ms → 800ms AND skip A0 if a
//            single-task save (_saveTaskById) is already in flight.
//
// Old: always fires A0 after 150ms of any state change
// New: waits 800ms, and skips A0 entirely if _pendingSaves has entries
// ─────────────────────────────────────────────────────────────────────────────
rep(
  'if(R.current)return clearTimeout(ke.current),ke.current=setTimeout(()=>{A0(d);try{localStorage.setItem("seo_tasks",JSON.stringify(d))}catch{}ke.current=void 0},150),()=>clearTimeout(ke.current)},[d])',

  'if(R.current)return clearTimeout(ke.current),ke.current=setTimeout(()=>{' +
    // Skip bulk save if a single-task save is already in flight
    'if(typeof _pendingSaves!=="undefined"&&Object.keys(_pendingSaves).length>0){' +
      'ke.current=void 0;' +
      'return;' +
    '}' +
    'A0(d);' +
    'try{localStorage.setItem("seo_tasks",JSON.stringify(d))}catch{}' +
    'ke.current=void 0' +
  // Increased from 150ms to 800ms — gives _saveTaskById time to land in DB
  '},800),()=>clearTimeout(ke.current)},[d])',

  'Fix 1+2: debounce 150ms→800ms + skip A0 if _pendingSaves active'
);

// ─────────────────────────────────────────────────────────────────────────────
// Fix 3: A0 merge — protect executionState from being downgraded by stale
//         server data during the fresh-fetch-then-merge step.
//
// Old: only protects timeEvents count, takes executionState blindly from local
//      (which could itself be stale if the merge ran before DB landed)
// New: keeps whichever executionState ranks higher (local vs server)
// ─────────────────────────────────────────────────────────────────────────────
rep(
  'payload=s.map(function(t){var sv=fm[t.id];if(sv){var sLen=(sv.timeEvents||[]).length;var lLen=(t.timeEvents||[]).length;return Object.assign({},t,{timeEvents:lLen>=sLen?t.timeEvents||[]:sv.timeEvents})}return t})',

  'payload=s.map(function(t){' +
    'var sv=fm[t.id];' +
    'if(sv){' +
      'var sLen=(sv.timeEvents||[]).length;' +
      'var lLen=(t.timeEvents||[]).length;' +
      'var mergedTe=lLen>=sLen?t.timeEvents||[]:sv.timeEvents;' +
      // Protect executionState — never let a stale server value downgrade local
      'var _sr={"Not Started":0,"In Progress":1,"Paused":2,"Ended":3,"Completed":3,"Approved":3};' +
      'var localRank=_sr[t.executionState]||0;' +
      'var serverRank=_sr[sv.executionState]||0;' +
      'var mergedState=localRank>=serverRank?t.executionState:sv.executionState;' +
      'var mergedCompleted=localRank>=serverRank?t.isCompleted:sv.isCompleted;' +
      'return Object.assign({},t,{' +
        'timeEvents:mergedTe,' +
        'executionState:mergedState,' +
        'isCompleted:mergedCompleted' +
      '})' +
    '}' +
    'return t' +
  '})',

  'Fix 3: A0 merge protects executionState rank'
);

fs.writeFileSync(BUNDLE, code, 'utf-8');
console.log(`\n✅ Patched successfully — ${changeCount} replacements applied.`);
console.log('   Restart the server to apply changes.');
