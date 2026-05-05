/**
 * patch-add-docurl-csv.js
 *
 * Adds a "Doc URL" column to the Client View CSV export (the re/m/st/etc.
 * function inside the py component) across ALL dist/assets/index-*.js files.
 *
 * Two replacements per file:
 *   1. Header array: insert "Doc URL" between "Target URL" and "Actual Hrs"
 *   2. Row data:     insert <taskVar>.docUrl||"" after <taskVar>.targetUrl||""
 *
 * Idempotent — if "Doc URL" is already present, the file is skipped.
 *
 * Run once:  node scripts/patch-add-docurl-csv.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.join(__dirname, '..', 'dist', 'assets');

const files = fs.readdirSync(assetsDir).filter(f => f.startsWith('index-') && f.endsWith('.js'));

let patched = 0;
let skipped = 0;

// --- Replacement 1: Header array (plain string) ---
const OLD_HEADER = '"Target URL","Actual Hrs","Overrun","Remarks"]';
const NEW_HEADER = '"Target URL","Doc URL","Actual Hrs","Overrun","Remarks"]';

// --- Replacement 2: Row data (regex — variable name differs per file) ---
const ROW_RE = /("Not Started",)(\w+)(\.targetUrl\|\|"")/g;
const ROW_REPL = '$1$2$3,$2.docUrl||""';

for (const file of files) {
  const filePath = path.join(assetsDir, file);
  let content = fs.readFileSync(filePath, 'utf-8');

  // Idempotency: skip if already patched
  if (content.includes(NEW_HEADER)) {
    console.log(`  ⏭  ${file}: already patched, skipping`);
    skipped++;
    continue;
  }

  // --- Replacement 1: Headers ---
  const headerParts = content.split(OLD_HEADER);
  if (headerParts.length !== 2) {
    const count = headerParts.length - 1;
    console.error(`  ✗  ${file}: header anchor matched ${count} time(s), expected 1 — skipped`);
    skipped++;
    continue;
  }
  content = headerParts[0] + NEW_HEADER + headerParts[1];

  // --- Replacement 2: Row data ---
  const rowMatches = content.match(ROW_RE);
  if (!rowMatches || rowMatches.length !== 1) {
    const count = rowMatches ? rowMatches.length : 0;
    console.error(`  ✗  ${file}: row anchor matched ${count} time(s), expected 1 — skipped`);
    skipped++;
    continue;
  }
  content = content.replace(ROW_RE, ROW_REPL);

  fs.writeFileSync(filePath, content, 'utf-8');
  patched++;
  console.log(`  ✓  ${file}`);
}

console.log(`\nDone: ${patched} files patched, ${skipped} skipped`);
