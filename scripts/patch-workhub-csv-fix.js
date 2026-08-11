/**
 * patch-workhub-csv-fix.js
 *
 * Fixes three template-literal bugs in the Work Hub panel's CSV import/export
 * code across ALL dist/assets/index-*.js files. In the original source these
 * were written as plain "..." / '...' strings (or with an escaped "\${") in
 * places that need real backtick template-literal interpolation, so the
 * ${...} expressions never evaluated — they were emitted as literal text
 * instead.
 *
 * Bug 1 (root cause of "only one task saved after bulk CSV import"):
 *   Every imported row got the literal id "WH-${Date.now()}-${i}" (not
 *   interpolated — `i` isn't even in scope). All rows in a CSV import share
 *   the exact same id, so the backend's upsert-by-id collapses N rows into 1.
 *   Fix: real template literal using the row loop variable.
 *
 * Bug 2 (cosmetic): the "Imported N tasks" toast showed the literal text
 *   "${newTasks.length}" instead of the actual count.
 *
 * Bug 3 (CSV export corruption — see user-reported screenshot):
 *   The Title and Remarks cells used a template literal with an escaped
 *   "\$" (so it never interpolates) and referenced the wrong variable name
 *   ("t" instead of the map callback's "$" param). The exported CSV file's
 *   name had the same problem, plus referenced a "dateFrom" variable that
 *   doesn't exist in that scope (Work Hub has no date-range filter) — it was
 *   copy-pasted from the Action Board export.
 *
 * Idempotent — if the fixed strings are already present, the file is skipped.
 *
 * Run once: node scripts/patch-workhub-csv-fix.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');
const assetsDir = path.join(distDir, 'assets');

// Only the JS bundle(s) actually <script src>'d from dist/index.html are ever
// served (express.static + SPA fallback) — dist/assets/ also contains many
// stale bundles left over from previous builds. Minified variable names
// (e.g. the toast setter, the anchor element var) differ per build, so the
// exact-match replacements below only apply cleanly to the live bundle(s).
const indexHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf-8');
const liveFiles = [...indexHtml.matchAll(/src="\/assets\/(index-[^"]+\.js)"/g)].map(m => m[1]);
if (liveFiles.length === 0) {
  console.error('Could not find any live index-*.js bundle referenced in dist/index.html — aborting.');
  process.exit(1);
}

const REPLACEMENTS = [
  {
    name: 'import: task id collision',
    old: 'id:"WH-${Date.now()}-${i}"',
    new: 'id:`WH-${Date.now()}-${at}`',
  },
  {
    name: 'import: toast message',
    old: 'Z("✓ Imported ${newTasks.length} tasks")',
    new: 'Z(`✓ Imported ${_.length} tasks`)',
  },
  {
    name: 'export: title cell',
    old: "`\"\\${(t.title||'').replace(/\"/g,'\"\"')}\"`",
    new: "`\"${($.title||'').replace(/\"/g,'\"\"')}\"`",
  },
  {
    name: 'export: remarks cell',
    old: "`\"\\${(t.remarks||'').replace(/\"/g,'\"\"')}\"`",
    new: "`\"${($.remarks||'').replace(/\"/g,'\"\"')}\"`",
  },
  {
    name: 'export: filename',
    old: "h.download=\"workhub-${dateFrom||'all'}.csv\"",
    new: 'h.download=`workhub-${new Date().toISOString().split("T")[0]}.csv`',
  },
];

const files = liveFiles;
let patchedFiles = 0;
let skippedFiles = 0;

for (const file of files) {
  const filePath = path.join(assetsDir, file);
  let content = fs.readFileSync(filePath, 'utf-8');
  const alreadyPatched = REPLACEMENTS.every(r => content.includes(r.new));
  if (alreadyPatched) {
    console.log(`  ⏭  ${file}: already patched, skipping`);
    skippedFiles++;
    continue;
  }

  let fileChanged = false;
  let fileOk = true;

  for (const r of REPLACEMENTS) {
    if (content.includes(r.new)) continue; // this one already applied
    const count = content.split(r.old).length - 1;
    if (count !== 1) {
      console.error(`  ✗  ${file}: "${r.name}" anchor matched ${count} time(s), expected 1 — skipped`);
      fileOk = false;
      continue;
    }
    content = content.split(r.old).join(r.new);
    fileChanged = true;
  }

  if (!fileOk) {
    skippedFiles++;
    continue;
  }

  if (fileChanged) {
    fs.writeFileSync(filePath, content, 'utf-8');
    patchedFiles++;
    console.log(`  ✓  ${file}`);
  } else {
    skippedFiles++;
  }
}

console.log(`\nDone: ${patchedFiles} file(s) patched, ${skippedFiles} skipped.`);
