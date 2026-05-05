/**
 * patch-keyword-db-persist.js
 * Patches the keyword panel to persist all keyword CRUD operations
 * to the database API instead of localStorage.
 *
 * Patches:
 * 1. Dy() — returns [] instead of reading localStorage
 * 2. Ay() — no-op instead of writing localStorage
 * 3. E()  — just setState, no Ay call
 * 4. Injects useEffect to load keywords from GET /api/historical-keywords
 * 5. h()  — POST new keyword to API
 * 6. ht() — PATCH edited keyword to API
 * 7. et() — DELETE keyword via API
 */
import fs from 'fs';

const BUNDLE = 'dist/assets/index-xUiSJVv5.js';
let code = fs.readFileSync(BUNDLE, 'utf8');
let patchCount = 0;

function patch(label, oldStr, newStr) {
  if (!code.includes(oldStr)) {
    console.log(`SKIP [${label}]: already patched or anchor changed`);
    return;
  }
  const count = code.split(oldStr).length - 1;
  if (count !== 1) {
    console.error(`FAIL [${label}]: found ${count} matches (expected 1)`);
    process.exit(1);
  }
  code = code.replace(oldStr, newStr);
  patchCount++;
  console.log(`OK   [${label}]`);
}

// ── Patch 1: Replace Dy — return empty array instead of localStorage ──
patch(
  'Dy: return []',
  'function Dy(){try{return JSON.parse(localStorage.getItem(wx)||"[]")}catch{return[]}}',
  'function Dy(){return[]}'
);

// ── Patch 2: Replace Ay — no-op instead of localStorage write ──
patch(
  'Ay: no-op',
  'function Ay(s){localStorage.setItem(wx,JSON.stringify(s))}',
  'function Ay(s){}'
);

// ── Patch 3: Remove Ay call from E, keep just setState ──
patch(
  'E: remove Ay',
  'E=m=>{j(m),Ay(m)}',
  'E=m=>{j(m)}'
);

// ── Patch 4: Inject useEffect to load from API on mount ──
// Insert right before Xe=v.useMemo (but only if not already injected)
const useEffectCode = `v.useEffect(()=>{fetch("/api/historical-keywords").then(r=>r.json()).then(data=>{j(data.map(r=>({id:String(r.id),source:r.source||"historical",date:r.date||"",client:r.client||"",seoOwner:r.seoOwner||"",taskTitle:r.taskTitle||"",focusedKw:r.keyword||"",volume:r.volume||0,marRank:r.rank||0,currentRank:r.currentRank||0,targetUrl:r.targetUrl||""})))}).catch(()=>{})},[]),`;

if (code.includes('fetch("/api/historical-keywords")')) {
  console.log('SKIP [useEffect: load from API]: already injected');
} else {
  patch(
    'useEffect: load from API',
    'Xe=v.useMemo(',
    useEffectCode + 'Xe=v.useMemo('
  );
}

// ── Patch 5: h() — POST new keyword to API, use DB id ──
const oldH = `,h=()=>{if(!X.focusedKw||!X.client)return;const m={id:\`hist_manual_\${Date.now()}\`,source:"historical",date:X.date,client:X.client,seoOwner:X.seoOwner,taskTitle:X.taskTitle,focusedKw:X.focusedKw,volume:Number(X.volume)||0,marRank:Number(X.marRank)||void 0,currentRank:Number(X.currentRank)||void 0,targetUrl:X.targetUrl};E([...g,m]),oe(!1),Qe({date:new Date().toISOString().split("T")[0],client:p.clients[0]||"",seoOwner:p.seoOwners[0]||"",taskTitle:"",focusedKw:"",volume:"",marRank:"",currentRank:"",targetUrl:""})}`;

const newH = `,h=()=>{if(!X.focusedKw||!X.client)return;const m={id:\`hist_manual_\${Date.now()}\`,source:"historical",date:X.date,client:X.client,seoOwner:X.seoOwner,taskTitle:X.taskTitle,focusedKw:X.focusedKw,volume:Number(X.volume)||0,marRank:Number(X.marRank)||void 0,currentRank:Number(X.currentRank)||void 0,targetUrl:X.targetUrl};fetch("/api/historical-keywords/add",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(m)}).then(r=>r.json()).then(r=>{if(r.id)m.id=String(r.id);j([...g,m])}).catch(()=>j([...g,m])),oe(!1),Qe({date:new Date().toISOString().split("T")[0],client:p.clients[0]||"",seoOwner:p.seoOwners[0]||"",taskTitle:"",focusedKw:"",volume:"",marRank:"",currentRank:"",targetUrl:""})}`;

patch('h: POST to API', oldH, newH);

// ── Patch 6: ht() — PATCH edited keyword to API ──
const oldHt = `,ht=m=>{if(m.source==="task"&&m.taskId)d(N=>N.map(Ae=>Ae.id===m.taskId?{...Ae,focusedKw:Ge.focusedKw,volume:Number(Ge.volume)||Ae.volume,marRank:Number(Ge.marRank)||Ae.marRank,currentRank:Number(Ge.currentRank)||Ae.currentRank,targetUrl:Ge.targetUrl||Ae.targetUrl}:Ae));else{const N=m.id.replace("hist:",""),Ae=g.map(Te=>Te.id===N?{...Te,date:Ge.date,client:Ge.client,seoOwner:Ge.seoOwner,taskTitle:Ge.taskTitle,focusedKw:Ge.focusedKw,volume:Number(Ge.volume)||0,marRank:Number(Ge.marRank)||void 0,currentRank:Number(Ge.currentRank)||void 0,targetUrl:Ge.targetUrl||""}:Te);E(Ae)}Je(null)}`;

const newHt = `,ht=m=>{if(m.source==="task"&&m.taskId)d(N=>N.map(Ae=>Ae.id===m.taskId?{...Ae,focusedKw:Ge.focusedKw,volume:Number(Ge.volume)||Ae.volume,marRank:Number(Ge.marRank)||Ae.marRank,currentRank:Number(Ge.currentRank)||Ae.currentRank,targetUrl:Ge.targetUrl||Ae.targetUrl}:Ae));else{const N=m.id.replace("hist:",""),Ae=g.map(Te=>Te.id===N?{...Te,date:Ge.date,client:Ge.client,seoOwner:Ge.seoOwner,taskTitle:Ge.taskTitle,focusedKw:Ge.focusedKw,volume:Number(Ge.volume)||0,marRank:Number(Ge.marRank)||void 0,currentRank:Number(Ge.currentRank)||void 0,targetUrl:Ge.targetUrl||""}:Te);j(Ae);fetch("/api/historical-keywords/"+encodeURIComponent(N),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({focusedKw:Ge.focusedKw,volume:Number(Ge.volume)||0,marRank:Number(Ge.marRank)||0,currentRank:Number(Ge.currentRank)||0,targetUrl:Ge.targetUrl||"",date:Ge.date,client:Ge.client,seoOwner:Ge.seoOwner,taskTitle:Ge.taskTitle})}).catch(()=>{})}Je(null)}`;

patch('ht: PATCH to API', oldHt, newHt);

// ── Patch 7: et() — DELETE keyword via API ──
const oldEt = `,et=m=>{if(m.source==="historical"||m.source==="upload"){const N=m.id.replace("hist:","");E(g.filter(Ae=>Ae.id!==N))}}`;

const newEt = `,et=m=>{if(m.source==="historical"||m.source==="upload"){const N=m.id.replace("hist:","");j(g.filter(Ae=>Ae.id!==N));fetch("/api/historical-keywords/"+encodeURIComponent(N),{method:"DELETE"}).catch(()=>{})}}`;

patch('et: DELETE via API', oldEt, newEt);

// ── Write patched bundle ──
fs.writeFileSync(BUNDLE, code);
console.log(`\nDone — ${patchCount} patches applied to ${BUNDLE}`);
