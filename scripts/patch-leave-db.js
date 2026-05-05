/**
 * patch-leave-db.js
 *
 * Moves Leave & Holidays data from localStorage to the MySQL database.
 * After this patch:
 *   - On tab open: records are fetched from GET /api/leave-records
 *   - On add: POST /api/leave-records saves one record to DB immediately
 *   - On remove: DELETE /api/leave-records/:id removes from DB immediately
 *   - localStorage is no longer used for leave records
 *   - Data is the same for every user, every device, every location
 *
 * Field mapping (frontend → DB):
 *   owner  → user_name
 *   date   → leave_date
 *   type   → leave_type
 *   note   → reason
 *
 * Run after all other patches:
 *   node scripts/patch-leave-db.js
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

console.log('Patching Leave & Holidays → DB storage...\n');

// ─────────────────────────────────────────────────────────────────────────────
// Fix 1: Replace Ty() and Ny() with DB-backed equivalents
//
// Old: Ty() reads from localStorage, Ny() writes to localStorage
// New: Ty() returns [] (initial state only — real load happens in useEffect)
//      Ny() is a no-op (DB saves happen via POST/DELETE directly)
// ─────────────────────────────────────────────────────────────────────────────
rep(
  'function Ty(){try{var _raw=JSON.parse(localStorage.getItem(jx)||"[]");if(!Array.isArray(_raw))return[];var _clean=_raw.filter(function(r){return r&&typeof r==="object"&&r.id&&r.date&&typeof r.date==="string"&&r.date.trim()&&r.owner;});if(_clean.length!==_raw.length){try{localStorage.setItem(jx,JSON.stringify(_clean))}catch(e){}console.warn("Leave records: dropped "+(_raw.length-_clean.length)+" corrupted record(s) from localStorage");}return _clean;}catch{return[]}}function Ny(s){localStorage.setItem(jx,JSON.stringify(s))}',

  // Ty: returns empty array — actual load happens in useEffect via API
  'function Ty(){return[]}' +
  // Ny: no-op — DB saves happen individually via POST/DELETE
  'function Ny(s){}',

  'Fix 1: Ty() returns [] and Ny() is no-op (DB handles persistence)'
);

// ─────────────────────────────────────────────────────────────────────────────
// Fix 2: Replace E setter and add DB load on mount
//
// Old: E=S=>{j(S),Ny(S)}  — sets state + writes localStorage
// New: E=S=>{j(S)}         — sets state only (no localStorage write)
//      + adds a useEffect that fetches leave records from DB on mount
//
// The DB response uses: { id, userName, leaveDate, leaveType, reason }
// The frontend expects:  { id, owner,    date,      type,      note   }
// We map them on load.
// ─────────────────────────────────────────────────────────────────────────────
rep(
  'E=S=>{j(S),Ny(S)},[H,F]=v.useState("today")',

  // E: state-only setter, no localStorage
  'E=S=>{j(S)},' +
  // useEffect: load leave records from DB on component mount
  // Map server field names → frontend field names
  'v.useEffect(()=>{' +
    'fetch("/api/leave-records",{cache:"no-store"})' +
      '.then(function(r){return r.ok?r.json():[]})' +
      '.then(function(rows){' +
        'if(!Array.isArray(rows))return;' +
        'j(rows.map(function(r){' +
          'return{' +
            'id:r.id,' +
            // leaveDate comes as a Date object from MySQL — convert to YYYY-MM-DD string
            'date:r.leaveDate?String(r.leaveDate).slice(0,10):"",' +
            'owner:r.userName||"",' +
            'type:r.leaveType||"full",' +
            'note:r.reason||""' +
          '};' +
        '}));' +
      '})' +
      '.catch(function(e){console.error("Failed to load leave records:",e)});' +
  '},[]),' +
  '[H,F]=v.useState("today")',

  'Fix 2: Load leave records from DB on mount, state-only setter'
);

// ─────────────────────────────────────────────────────────────────────────────
// Fix 3: Replace Save button — POST single record to DB
//
// Old: creates record in local state + localStorage
// New: POST to /api/leave-records, on success add to local state
//      Maps frontend fields → server fields
// ─────────────────────────────────────────────────────────────────────────────
rep(
  'onClick:()=>{if(!Ve.date||!Ve.date.trim()){alert("Please select a date before saving.");return;}if(!Ve.owner||!Ve.owner.trim()){alert("Please select an owner before saving.");return;}if(!Ve.type||!Ve.type.trim()){alert("Please select a leave type before saving.");return;}const S={id:`lv_${Date.now()}`,...Ve};E([...g,S]);te(!1);}',

  'onClick:()=>{' +
    // Validate
    'if(!Ve.date||!Ve.date.trim()){alert("Please select a date before saving.");return;}' +
    'if(!Ve.owner||!Ve.owner.trim()){alert("Please select an owner before saving.");return;}' +
    'if(!Ve.type||!Ve.type.trim()){alert("Please select a leave type before saving.");return;}' +
    // Build the record with a temp ID
    'var _newId="lv_"+Date.now();' +
    // POST to DB — map frontend fields to server fields
    'fetch("/api/leave-records",{' +
      'method:"POST",' +
      'headers:{"Content-Type":"application/json"},' +
      'body:JSON.stringify({' +
        'id:_newId,' +
        'owner:Ve.owner,' +
        'date:Ve.date,' +
        'type:Ve.type,' +
        'note:Ve.note||""' +
      '})' +
    '}).then(function(r){return r.ok?r.json():Promise.reject(r)})' +
    '.then(function(res){' +
      // Use the ID returned by server (may differ if server generated one)
      'var _savedId=(res&&res.id)||_newId;' +
      'E([...g,{id:_savedId,owner:Ve.owner,date:Ve.date,type:Ve.type,note:Ve.note||""}]);' +
      'te(!1);' +
    '}).catch(function(e){' +
      'console.error("Failed to save leave record:",e);' +
      'alert("Failed to save leave record. Please try again.");' +
    '});' +
  '}',

  'Fix 3: Save button POSTs to DB'
);

// ─────────────────────────────────────────────────────────────────────────────
// Fix 4: Replace Remove button — DELETE single record from DB
//
// Old: E(g.filter(de=>de.id!==S.id))  — filters local state + localStorage
// New: DELETE /api/leave-records/:id, on success filter local state
// ─────────────────────────────────────────────────────────────────────────────
rep(
  'onClick:()=>E(g.filter(de=>de.id!==S.id)),style:{fontSize:10,padding:"2px 7px",borderRadius:5,border:"0.5px solid #F09595",color:"#791F1F",background:"#FCEBEB",cursor:"pointer"},children:"Remove"',

  'onClick:()=>{' +
    'fetch("/api/leave-records/"+encodeURIComponent(S.id),{method:"DELETE"})' +
      '.then(function(r){return r.ok?r.json():Promise.reject(r)})' +
      '.then(function(){E(g.filter(function(de){return de.id!==S.id}))})' +
      '.catch(function(e){' +
        'console.error("Failed to delete leave record:",e);' +
        'alert("Failed to remove leave record. Please try again.");' +
      '});' +
  '},style:{fontSize:10,padding:"2px 7px",borderRadius:5,border:"0.5px solid #F09595",color:"#791F1F",background:"#FCEBEB",cursor:"pointer"},children:"Remove"',

  'Fix 4: Remove button DELETEs from DB'
);

fs.writeFileSync(BUNDLE, code, 'utf-8');
console.log(`\n✅ Patched successfully — ${changeCount} replacements applied.`);
console.log('   Deploy the updated server.js AND the patched bundle, then restart.');
console.log('\n📋 One-time cleanup — run in browser console to clear old localStorage data:');
console.log('   localStorage.removeItem("seo_leave_records")');
