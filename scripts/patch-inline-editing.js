/**
 * patch-inline-editing.js
 *
 * Adds inline editing to the Task Entry panel in the active bundle.
 * Run once:  node scripts/patch-inline-editing.js
 *
 * Changes scoped to the Sy (TaskEntry) component only.
 * Does NOT touch the Add row, filters, Backup & Restore, History, CSV, or delete logic.
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
    console.error(`FAILED [${label}]: anchor matched ${parts.length - 1} times (expected 1)`);
    process.exit(1);
  }
  code = parts[0] + newStr + parts[1];
  changeCount++;
  console.log(`  ✓ ${label}`);
}

console.log('Patching inline editing into TaskEntry (Sy)...\n');

// ─────────────────────────────────────────────
// 1. Expand context destructuring to include currentUser
// ─────────────────────────────────────────────
rep(
  'function Sy(){const{tasks:s,setTasks:d,adminOptions:p}=hn()',
  'function Sy(){const{tasks:s,setTasks:d,adminOptions:p,currentUser:_cu}=hn()',
  'context destructuring'
);

// ─────────────────────────────────────────────
// 2. Add new state variables into the const chain
//    Insert after the QC review state, before the pt= function
// ─────────────────────────────────────────────
rep(
  'note:""}),pt=C=>{',
  'note:""}),' +
  '[_OT,_sOT]=v.useState({}),' +        // originalTasks
  '[_PE,_sPE]=v.useState({}),' +         // pendingEdits
  '[_SSM,_sSM]=v.useState(!1),' +        // showSaveModal
  '[_IS,_sIS]=v.useState(!1),' +         // isSaving
  '[_TT,_sTT]=v.useState(null),' +       // toast
  'pt=C=>{',
  'add state variables'
);

// ─────────────────────────────────────────────
// 3. Add computed values, handlers, and effects
//    Break the const chain at bt=We() and add logic before return
// ─────────────────────────────────────────────

const LOGIC_BLOCK = [
  // End the const chain and add _NF + _DI as final const items
  'bt=We(),' +
  '_NF=["volume","marRank","currentRank","estHoursSEO","estHoursContent","estHoursWeb","daysInStage"],' +
  '_DI=v.useMemo(function(){return new Set(Object.keys(_PE))},[_PE]);',

  // hasChanges (var so it's accessible in return)
  'var _HC=_DI.size>0;',

  // [NEW] cellValue — merge pendingEdits on top of task
  'function _cv(C,F){return _PE[C.id]&&_PE[C.id][F]!==void 0?_PE[C.id][F]:C[F]!=null?C[F]:""}',

  // [NEW] handleFieldChange — accumulate per-field deltas
  'function _hfc(tid,fn,rv){' +
    'if(fn==="id")return;' +
    'var co=_NF.includes(fn)?(rv===""?"":Number(rv)):rv;' +
    '_sPE(function(prev){' +
      'var ed=Object.assign({},prev[tid]||{});' +
      'ed[fn]=co;' +
      'if(_OT[tid]&&String(ed[fn])===String(_OT[tid][fn]))delete ed[fn];' +
      'if(Object.keys(ed).length===0){var nx=Object.assign({},prev);delete nx[tid];return nx}' +
      'var nx2=Object.assign({},prev);nx2[tid]=ed;return nx2' +
    '})' +
  '}',

  // [NEW] showToast helper
  'function _showToast(msg,type){_sTT({message:msg,type:type||"success"});setTimeout(function(){_sTT(null)},3500)}',

  // [NEW] handleSaveConfirm — fetch-then-merge + audit + global refresh
  'function _handleSaveConfirm(){' +
    '_sIS(!0);' +
    'fetch("/api/tasks").then(function(r){return r.json()}).then(function(fresh){' +
      'var merged=fresh.map(function(t){' +
        'if(!_PE[t.id])return t;' +
        'var e=Object.assign({},t,_PE[t.id]);' +
        'return e' +
      '});' +
      'return fetch("/api/tasks",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(merged)}).then(function(sr){' +
        'if(!sr.ok)throw new Error("Save failed");' +
        // Audit logging
        'var auditEvents=[];' +
        'for(var tid in _PE){' +
          'var edits=_PE[tid];var orig=_OT[tid]||{};' +
          'for(var field in edits){' +
            'auditEvents.push({' +
              'action:"task_field_edit",source:"TaskEntry",' +
              'taskId:tid,taskTitle:orig.title||"",client:orig.client||"",' +
              'field:field,' +
              'oldValue:String(orig[field]!=null?orig[field]:""),' +
              'newValue:String(edits[field]),' +
              'userName:_cu?_cu.name||_cu.ownerName||"":"",' +
              'userRole:_cu?_cu.role||"":"",' +
              'timestamp:new Date().toISOString()' +
            '})' +
          '}' +
        '}' +
        'if(auditEvents.length>0)fetch("/api/audit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(auditEvents)}).catch(function(){});' +
        // Update local state
        'var newById={};merged.forEach(function(t){newById[t.id]=Object.assign({},t)});' +
        '_sOT(newById);_sPE({});_sSM(!1);' +
        // Update global context (triggers debounced re-save, harmless)
        'd(merged);' +
        '_showToast("Changes saved successfully","success")' +
      '})' +
    '}).catch(function(){' +
      '_showToast("Save failed \\u2014 please try again","error")' +
    '}).finally(function(){_sIS(!1)})}',

  // [NEW] useEffect — populate originalTasks from context tasks
  'v.useEffect(function(){' +
    'if(Object.keys(_PE).length===0){' +
      'var byId={};s.forEach(function(t){byId[t.id]=Object.assign({},t)});_sOT(byId)' +
    '}' +
  '},[s]);',

  // [NEW] useEffect — beforeunload navigation guard
  'v.useEffect(function(){' +
    'if(!_HC)return;' +
    'var h=function(e){e.preventDefault();e.returnValue=""};' +
    'window.addEventListener("beforeunload",h);' +
    'return function(){window.removeEventListener("beforeunload",h)}' +
  '},[_HC]);',

  // Resume the return statement
  'return n.jsxs("div"',
].join('');

rep(
  'bt=We();return n.jsxs("div"',
  LOGIC_BLOCK,
  'add logic block before return'
);

// ─────────────────────────────────────────────
// 4. Column render replacements — existing row edits
//    Change from Te (auto-save) to _hfc (pending edits)
//    Change values from C.field to _cv(C,"field")
// ─────────────────────────────────────────────

// intakeDate
rep(
  'Q(C.intakeDate,"date",_=>Te(C.id,"intakeDate",_))',
  'Q(_cv(C,"intakeDate"),"date",_=>_hfc(C.id,"intakeDate",_))',
  'col: intakeDate'
);

// title
rep(
  'Q(C.title,"text",_=>Te(C.id,"title",_),"min-w-[200px]")',
  'Q(_cv(C,"title"),"text",_=>_hfc(C.id,"title",_),"min-w-[200px]")',
  'col: title'
);

// client
rep(
  'f(C.client,p.clients,_=>Te(C.id,"client",_))',
  'f(_cv(C,"client"),p.clients,_=>_hfc(C.id,"client",_))',
  'col: client'
);

// seoOwner
rep(
  'f(C.seoOwner,p.seoOwners,_=>Te(C.id,"seoOwner",_))',
  'f(_cv(C,"seoOwner"),p.seoOwners,_=>_hfc(C.id,"seoOwner",_))',
  'col: seoOwner'
);

// seoStage
rep(
  'f(C.seoStage,p.seoStages,_=>Te(C.id,"seoStage",_))',
  'f(_cv(C,"seoStage"),p.seoStages,_=>_hfc(C.id,"seoStage",_))',
  'col: seoStage'
);

// seoQcStatus — change from read-only badge to editable select
rep(
  'qe(C.seoQcStatus)}',
  'f(_cv(C,"seoQcStatus"),["Pending","Done","Review"],_=>_hfc(C.id,"seoQcStatus",_))}',
  'col: seoQcStatus (badge → select)'
);

// focusedKw
rep(
  'Q(C.focusedKw,"text",_=>Te(C.id,"focusedKw",_))',
  'Q(_cv(C,"focusedKw"),"text",_=>_hfc(C.id,"focusedKw",_))',
  'col: focusedKw'
);

// volume
rep(
  'Q(C.volume,"number",_=>Te(C.id,"volume",_),"min-w-[70px]")',
  'Q(_cv(C,"volume"),"number",_=>_hfc(C.id,"volume",_),"min-w-[70px]")',
  'col: volume'
);

// marRank (monthlyRank)
rep(
  'Q(C.marRank,"number",_=>Te(C.id,"marRank",_),"min-w-[70px]")',
  'Q(_cv(C,"marRank"),"number",_=>_hfc(C.id,"marRank",_),"min-w-[70px]")',
  'col: marRank'
);

// currentRank (curRank)
rep(
  'Q(C.currentRank,"number",_=>Te(C.id,"currentRank",_),"min-w-[70px]")',
  'Q(_cv(C,"currentRank"),"number",_=>_hfc(C.id,"currentRank",_),"min-w-[70px]")',
  'col: currentRank'
);

// deltaRank — computed, use cellValue for source values
rep(
  ':(C.marRank||0)-(C.currentRank||0)})',
  ':(_cv(C,"marRank")||0)-(_cv(C,"currentRank")||0)})',
  'col: deltaRank (computed)'
);

// estHoursSEO (synced with estHours)
rep(
  'Q(C.estHoursSEO||C.estHours,"number",_=>{Te(C.id,"estHoursSEO",_),Te(C.id,"estHours",_)},"min-w-[70px]")',
  'Q(_cv(C,"estHoursSEO"),"number",_=>{_hfc(C.id,"estHoursSEO",_),_hfc(C.id,"estHours",_)},"min-w-[70px]")',
  'col: estHoursSEO'
);

// estHoursContent
rep(
  'Q(C.estHoursContent,"number",_=>Te(C.id,"estHoursContent",_),"min-w-[70px]")',
  'Q(_cv(C,"estHoursContent"),"number",_=>_hfc(C.id,"estHoursContent",_),"min-w-[70px]")',
  'col: estHoursContent'
);

// estHoursWeb
rep(
  'Q(C.estHoursWeb,"number",_=>Te(C.id,"estHoursWeb",_),"min-w-[70px]")',
  'Q(_cv(C,"estHoursWeb"),"number",_=>_hfc(C.id,"estHoursWeb",_),"min-w-[70px]")',
  'col: estHoursWeb'
);

// contentAssignedDate
rep(
  'Q(C.contentAssignedDate,"date",_=>Te(C.id,"contentAssignedDate",_))',
  'Q(_cv(C,"contentAssignedDate"),"date",_=>_hfc(C.id,"contentAssignedDate",_))',
  'col: contentAssignedDate'
);

// contentOwner
rep(
  'f(C.contentOwner||"",p.contentOwners,_=>Te(C.id,"contentOwner",_))',
  'f(_cv(C,"contentOwner"),p.contentOwners,_=>_hfc(C.id,"contentOwner",_))',
  'col: contentOwner'
);

// webAssignedDate
rep(
  'Q(C.webAssignedDate,"date",_=>Te(C.id,"webAssignedDate",_))',
  'Q(_cv(C,"webAssignedDate"),"date",_=>_hfc(C.id,"webAssignedDate",_))',
  'col: webAssignedDate'
);

// webOwner
rep(
  'f(C.webOwner||"",p.webOwners,_=>Te(C.id,"webOwner",_))',
  'f(_cv(C,"webOwner"),p.webOwners,_=>_hfc(C.id,"webOwner",_))',
  'col: webOwner'
);

// targetUrl
rep(
  'Q(C.targetUrl,"text",_=>Te(C.id,"targetUrl",_))',
  'Q(_cv(C,"targetUrl"),"text",_=>_hfc(C.id,"targetUrl",_))',
  'col: targetUrl'
);

// docUrl
rep(
  'Q(C.docUrl||"","text",_=>Te(C.id,"docUrl",_))',
  'Q(_cv(C,"docUrl"),"text",_=>_hfc(C.id,"docUrl",_))',
  'col: docUrl'
);

// currentOwner
rep(
  'f(C.currentOwner,["SEO","Content","Web","Completed"],_=>Te(C.id,"currentOwner",_))',
  'f(_cv(C,"currentOwner"),["SEO","Content","Web","Completed"],_=>_hfc(C.id,"currentOwner",_))',
  'col: currentOwner'
);

// daysInStage
rep(
  'Q(C.daysInStage,"number",_=>Te(C.id,"daysInStage",_),"min-w-[70px]")',
  'Q(_cv(C,"daysInStage"),"number",_=>_hfc(C.id,"daysInStage",_),"min-w-[70px]")',
  'col: daysInStage'
);

// remarks
rep(
  'Q(C.remarks,"text",_=>Te(C.id,"remarks",_),"min-w-[200px]")',
  'Q(_cv(C,"remarks"),"text",_=>_hfc(C.id,"remarks",_),"min-w-[200px]")',
  'col: remarks'
);

// ─────────────────────────────────────────────
// 5. Dirty row indicator — amber left border on rows with pending edits
// ─────────────────────────────────────────────
rep(
  'n.jsxs("tr",{className:Ft("hover:bg-blue-50/50 transition-colors",K.has(C.id)?"bg-indigo-50/60":"",te.has(C.id)?"bg-yellow-50 ring-1 ring-yellow-300":""),children:[',
  'n.jsxs("tr",{style:_PE[C.id]?{borderLeft:"3px solid #f59e0b"}:{},className:Ft("hover:bg-blue-50/50 transition-colors",K.has(C.id)?"bg-indigo-50/60":"",te.has(C.id)?"bg-yellow-50 ring-1 ring-yellow-300":""),children:[',
  'dirty row indicator'
);

// ─────────────────────────────────────────────
// 6. Save Changes button — in top bar, after History button
//    The History button is the last child in the flex gap-2 div.
//    Its closing sequence ends with: children:Ue.length})]})
//    Then the parent div closes with: ]})
// ─────────────────────────────────────────────

const SAVE_BUTTON =
  ',_HC&&n.jsxs("button",{onClick:function(){_sSM(!0)},' +
  'className:"flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-2 rounded-md text-sm font-medium shadow-sm",' +
  'children:["Save Changes (",_DI.size,")"]})';

rep(
  'children:Ue.length})]})]})',
  'children:Ue.length})]})' + SAVE_BUTTON + ']})',
  'Save Changes button'
);

// ─────────────────────────────────────────────
// 7. Toast notification renderer + Save Confirm Modal
//    Add toast at start of return JSX children,
//    and modal after the existing confirmation dialog
// ─────────────────────────────────────────────

// Toast — fixed position notification
const TOAST_JSX =
  '_TT&&n.jsx("div",{style:{' +
    'position:"fixed",bottom:24,right:24,zIndex:9999,' +
    'background:_TT.type==="success"?"#10b981":"#ef4444",' +
    'color:"#fff",padding:"10px 18px",borderRadius:8,' +
    'boxShadow:"0 4px 12px rgba(0,0,0,0.15)",fontSize:14' +
  '},children:_TT.message}),';

rep(
  'return n.jsxs("div",{className:"space-y-4",children:[Re&&n.jsx(vy,{...Re,onCancel:()=>Be(null)})',
  'return n.jsxs("div",{className:"space-y-4",children:[' + TOAST_JSX + 'Re&&n.jsx(vy,{...Re,onCancel:()=>Be(null)})',
  'toast renderer'
);

// Save Confirm Modal — after the existing confirmation dialog
const SAVE_MODAL_JSX =
  ',_SSM&&n.jsx("div",{style:{' +
    'position:"fixed",top:0,left:0,width:"100vw",height:"100vh",' +
    'zIndex:2147483647,display:"flex",alignItems:"center",' +
    'justifyContent:"center",padding:16,background:"rgba(0,0,0,0.4)"' +
  '},children:n.jsxs("div",{className:"bg-white rounded-2xl shadow-xl max-w-sm w-full p-6",children:[' +
    'n.jsx("p",{className:"font-bold text-zinc-900 text-base mb-2",children:"Save changes?"}),' +
    'n.jsxs("p",{className:"text-sm text-zinc-500 mb-6",children:["You have ",_DI.size," task(s) with unsaved changes."]}),' +
    'n.jsxs("div",{className:"flex gap-3 justify-end",children:[' +
      'n.jsx("button",{onClick:function(){_sSM(!1)},className:"px-4 py-2 text-sm font-medium text-zinc-600 hover:text-zinc-900 border border-zinc-200 rounded-lg",children:"Cancel"}),' +
      'n.jsx("button",{onClick:function(){_sPE({});_sSM(!1)},className:"px-4 py-2 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50",children:"Discard"}),' +
      'n.jsx("button",{onClick:_handleSaveConfirm,disabled:_IS,className:"px-4 py-2 text-sm font-medium text-white rounded-lg "+(_IS?"bg-emerald-400 cursor-wait":"bg-emerald-600 hover:bg-emerald-700"),children:_IS?"Saving...":"Yes, save"})' +
    ']})' +
  ']})})';

rep(
  'Re&&n.jsx(vy,{...Re,onCancel:()=>Be(null)})',
  'Re&&n.jsx(vy,{...Re,onCancel:()=>Be(null)})' + SAVE_MODAL_JSX,
  'Save Confirm Modal'
);

// ─────────────────────────────────────────────
// Done — write the patched file
// ─────────────────────────────────────────────
fs.writeFileSync(BUNDLE, code, 'utf-8');
console.log(`\n✅ Patched successfully — ${changeCount} replacements applied.`);
console.log('   Restart the server to see changes.');
