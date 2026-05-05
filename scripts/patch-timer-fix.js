/**
 * patch-timer-fix.js
 *
 * Fixes timer data loss caused by concurrent bulk saves overwriting
 * each other's timeEvents arrays.
 *
 * Changes:
 *   1. Adds a saveTaskById() helper that PUTs a single task atomically
 *      via the new PUT /api/tasks/:id endpoint.
 *   2. After every timer action (start/pause/resume/end) in every
 *      component that mutates timeEvents, immediately persists the
 *      updated task via saveTaskById — so the DB always has the latest
 *      timer state even if a concurrent bulk save arrives.
 *   3. Wraps the bulk-save function A0 with a fetch-fresh-then-merge
 *      step: before writing, it GETs the current server tasks and
 *      copies each task's timeEvents from the server into the outgoing
 *      payload, so bulk saves never clobber recent timer writes.
 *
 * Run once after other patches:
 *   node scripts/patch-timer-fix.js
 *
 * Does NOT modify any existing routes, patch scripts, or non-timer
 * behaviour.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BUNDLE = path.join(__dirname, '..', 'dist', 'assets', 'index-xUiSJVv5.js');
let code = fs.readFileSync(BUNDLE, 'utf-8');
let changeCount = 0;

function rep(oldStr, newStr, label) {
  if (!code.includes(oldStr)) {
    console.error(`FAILED [${label}]: anchor not found`);
    process.exit(1);
  }
  const parts = code.split(oldStr);
  if (parts.length !== 2) {
    console.error(
      `FAILED [${label}]: anchor matched ${parts.length - 1} times (expected 1)`
    );
    process.exit(1);
  }
  code = parts[0] + newStr + parts[1];
  changeCount++;
  console.log(`  \u2713 ${label}`);
}

console.log('Patching timer-safety into bundle...\n');

// ─────────────────────────────────────────────
// 1. Add saveTaskById helper and wrap A0 with
//    fetch-fresh-then-merge for timeEvents
// ─────────────────────────────────────────────
rep(
  'function A0(s){fetch("/api/tasks",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(s)}).catch(d=>console.error("Failed to save tasks:",d))}',

  // saveTaskById: atomic single-task PUT
  'function _saveTaskById(t){' +
    'fetch("/api/tasks/"+encodeURIComponent(t.id),{' +
      'method:"PUT",' +
      'headers:{"Content-Type":"application/json"},' +
      'body:JSON.stringify(t)' +
    '}).catch(function(e){console.error("Failed to save task "+t.id+":",e)})' +
  '}' +

  // A0: fetch-fresh-then-merge timeEvents before bulk save
  'function A0(s){' +
    'fetch("/api/tasks",{cache:"no-store"}).then(function(r){' +
      'return r.ok?r.json():null' +
    '}).then(function(fresh){' +
      'var payload=s;' +
      'if(fresh&&Array.isArray(fresh)){' +
        'var fm={};' +
        'fresh.forEach(function(t){fm[t.id]=t});' +
        'payload=s.map(function(t){' +
          'var sv=fm[t.id];' +
          'if(sv&&sv.timeEvents){' +
            'return Object.assign({},t,{timeEvents:sv.timeEvents})' +
          '}' +
          'return t' +
        '})' +
      '}' +
      'return fetch("/api/tasks",{' +
        'method:"PUT",' +
        'headers:{"Content-Type":"application/json"},' +
        'body:JSON.stringify(payload)' +
      '})' +
    '}).catch(function(d){console.error("Failed to save tasks:",d)})' +
  '}',

  'add saveTaskById + wrap A0 with merge'
);

// ─────────────────────────────────────────────
// 2. SEO WorkHub – Qe timer handler (hy component)
//    After setTasks (p(...)), find the updated task
//    and call _saveTaskById.
//    Anchor: the Qe function that ends with
//    ...Xe=(h,$,ie)=>{Qe(h,ie)}
// ─────────────────────────────────────────────

// The Qe function uses p(ie=>ie.map(...)) to update state.
// We wrap it so after setTasks completes, we compute the
// updated task and save it atomically.
//
// Original: Xe=(h,$,ie)=>{Qe(h,ie)}
// We replace to also fire _saveTaskById after Qe runs.
// Since setTasks is async (React batching), we re-derive the
// updated task inline from the current data and save it.
//
// Strategy: wrap Qe call to also explicitly compute the updated
// task by replaying the same logic, then call _saveTaskById.

rep(
  'Xe=(h,$,ie)=>{Qe(h,ie)}',

  'Xe=(h,$,ie)=>{' +
    'Qe(h,ie);' +
    // Re-derive the task with updated timeEvents inline
    'var _xt=s.find(function(_t){return _t.id===h});' +
    'if(_xt){' +
      'var _ts=new Date().toISOString();' +
      'var _te=[..._xt.timeEvents||[]];' +
      'var _es=_xt.executionState||"Not Started";' +
      'if(ie==="In Progress"&&_es!=="In Progress"){' +
        '_te.push({type:_es==="Paused"?"resume":"start",timestamp:_ts,department:_xt.currentOwner,owner:(g==null?void 0:g.ownerName)||""})' +
      '}else if(ie==="Paused"){' +
        '_te.push({type:"pause",timestamp:_ts,department:_xt.currentOwner,owner:(g==null?void 0:g.ownerName)||""})' +
      '}else if(ie==="Ended"){' +
        '_te.push({type:"end",timestamp:_ts,department:_xt.currentOwner,owner:(g==null?void 0:g.ownerName)||""})' +
      '}' +
      '_saveTaskById(Object.assign({},_xt,{executionState:ie,isCompleted:ie==="Ended",timeEvents:_te}))' +
    '}' +
  '}',

  'SEO WorkHub: saveTaskById after timer action'
);

// ─────────────────────────────────────────────
// 3. Action Board – Te timer handler
//    This function pushes start/resume/pause/end events
//    and calls d(pe=>pe.map(...)) to update global state.
//    We need to add a _saveTaskById call after it.
//
//    The Te function is assigned as:
//    Te=(u,ce,fe)=>{d(pe=>pe.map(Ce=>{...}))}
//    and it's followed by [f,Q]=v.useState("0.25")
//
//    Strategy: We wrap the Te call by replacing the
//    assignment to also fire _saveTaskById.
// ─────────────────────────────────────────────

// Find the closing of Te's d() call and what comes after
rep(
  'Te=(u,ce,fe)=>{d(pe=>pe.map(Ce=>{',

  'Te=(u,ce,fe)=>{' +
    // After setTasks, also persist the task atomically
    'var _abTask=s.find(function(_t){return _t.id===u});' +
    'if(_abTask){' +
      'var _abTs=new Date().toISOString();' +
      'var _abTe=[..._abTask.timeEvents||[]];' +
      'if(ce==="start"||ce==="resume"){' +
        '_abTe.push({type:ce,timestamp:_abTs,department:_abTask.currentOwner,owner:(i==null?void 0:i.ownerName)||""})' +
      '}else if(ce==="pause"||ce==="end"){' +
        '_abTe.push({type:ce,timestamp:_abTs,department:_abTask.currentOwner,owner:(i==null?void 0:i.ownerName)||""})' +
      '}' +
      '_saveTaskById(Object.assign({},_abTask,{executionState:fe,timeEvents:_abTe}))' +
    '}' +
    'd(pe=>pe.map(Ce=>{',

  'Action Board: saveTaskById after timer action'
);

// ─────────────────────────────────────────────
// 4. Non-SEO WorkHub (Iy component) – Qe timer handler
//    This simpler Qe pushes one timeEvent and calls d().
//    Anchor: Qe=(y,W,Fe)=>{d(h=>h.map($=>{if($.id!==y)
//    Followed by: Xe=(y,W)=>{
// ─────────────────────────────────────────────

rep(
  'Qe=(y,W,Fe)=>{d(h=>h.map($=>{if($.id!==y)return $;const ie=new Date().toISOString();return{...$,executionState:Fe,isCompleted:Fe==="Completed"||Fe==="Approved",timeEvents:[...$.timeEvents||[],{type:W,timestamp:ie,department:$.deptType||"Work",owner:(i==null?void 0:i.ownerName)||""}]}}))},Xe=(y,W)=>{',

  'Qe=(y,W,Fe)=>{' +
    // Save atomically first
    'var _nst=s.find(function(_t){return _t.id===y});' +
    'if(_nst){' +
      'var _nstTs=new Date().toISOString();' +
      '_saveTaskById(Object.assign({},_nst,{' +
        'executionState:Fe,' +
        'isCompleted:Fe==="Completed"||Fe==="Approved",' +
        'timeEvents:[..._nst.timeEvents||[],{type:W,timestamp:_nstTs,department:_nst.deptType||"Work",owner:(i==null?void 0:i.ownerName)||""}]' +
      '}))' +
    '}' +
    // Original setTasks call unchanged
    'd(h=>h.map($=>{if($.id!==y)return $;const ie=new Date().toISOString();return{...$,executionState:Fe,isCompleted:Fe==="Completed"||Fe==="Approved",timeEvents:[...$.timeEvents||[],{type:W,timestamp:ie,department:$.deptType||"Work",owner:(i==null?void 0:i.ownerName)||""}]}}))' +
  '},Xe=(y,W)=>{',

  'Non-SEO WorkHub: saveTaskById after timer action'
);

// ─────────────────────────────────────────────
// Done — write the patched file
// ─────────────────────────────────────────────
fs.writeFileSync(BUNDLE, code, 'utf-8');
console.log(
  `\n\u2705 Patched successfully \u2014 ${changeCount} replacements applied.`
);
console.log('   Restart the server to see changes.');
