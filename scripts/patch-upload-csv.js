/**
 * Patch compiled bundles to remove "Upload CSV" button/label at component level.
 * Keeps the hidden <input type="file"> elements intact.
 * Run once: node scripts/patch-upload-csv.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, '..', 'dist', 'assets');

// Pattern 1: Task Entry "Upload CSV" button
// Matches: n.jsxs("button",{onClick:()=>{var S;return(S=i.current)==null?void 0:S.click()},className:"flex items-center gap-2 bg-white hover:bg-zinc-50 text-zinc-700 px-3 py-2 rounded-md text-sm font-medium border border-zinc-300 shadow-sm",children:[n.jsx(Us,{size:15})," Upload CSV"]})
const taskEntryButtonRe = /n\.jsxs\("button",\{onClick:\(\)=>\{var \w+;return\(\w+=\w+\.current\)==null\?void 0:\w+\.click\(\)\},className:"flex items-center gap-2 bg-white hover:bg-zinc-50 text-zinc-700 px-3 py-2 rounded-md text-sm font-medium border border-zinc-300 shadow-sm",children:\[n\.jsx\(\w+,\{size:15\}\)," Upload CSV"\]\}\)/g;

// Pattern 2: Action Board "Upload CSV" label (contains a hidden file input inside)
// Matches: n.jsxs("label",{style:{display:"inline-flex",...,cursor:"pointer"},children:[n.jsx(Us,{size:13})," Upload CSV",n.jsx("input",{ref:i,type:"file",accept:".csv",onChange:se,style:{display:"none"}})]})
// Replacement keeps the hidden input, discards the label wrapper
const actionBoardLabelRe = /n\.jsxs\("label",\{style:\{display:"inline-flex",alignItems:"center",gap:5,padding:"6px 12px",borderRadius:8,fontSize:12,fontWeight:500,border:"0\.5px solid #185FA540",color:"#0C447C",background:"#E6F1FB",cursor:"pointer"\},children:\[n\.jsx\(\w+,\{size:13\}\)," Upload CSV",(n\.jsx\("input",\{ref:\w+,type:"file",accept:"\.csv",onChange:\w+,style:\{display:"none"\}\}\))\]\}\)/g;

const files = fs.readdirSync(assetsDir).filter(f => f.startsWith('index-') && f.endsWith('.js'));
let totalPatched = 0;

for (const file of files) {
  const filePath = path.join(assetsDir, file);
  let content = fs.readFileSync(filePath, 'utf-8');
  let patched = false;

  // Pattern 1: Replace Task Entry button with null
  const after1 = content.replace(taskEntryButtonRe, 'null');
  if (after1 !== content) {
    content = after1;
    patched = true;
    console.log(`  ${file}: removed Task Entry "Upload CSV" button`);
  }

  // Pattern 2: Replace Action Board label with just the hidden input
  const after2 = content.replace(actionBoardLabelRe, '$1');
  if (after2 !== content) {
    content = after2;
    patched = true;
    console.log(`  ${file}: removed Action Board "Upload CSV" label`);
  }

  if (patched) {
    fs.writeFileSync(filePath, content, 'utf-8');
    totalPatched++;
  }
}

console.log(`\nDone: ${totalPatched} file(s) patched.`);
