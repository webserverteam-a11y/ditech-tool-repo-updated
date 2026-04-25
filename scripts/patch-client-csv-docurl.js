/**
 * patch-client-csv-docurl.js
 *
 * Adds "Doc URL" column to the Client View CSV export (Fe function
 * inside the hy component) for all three role branches:
 *   - SEO (k):     after "Target URL" / be.targetUrl
 *   - Content (U): after "Actual Hours" / be.actualHours
 *   - Web (R):     after "Actual Hours" / be.actualHours
 *
 * Run once after build:
 *   node scripts/patch-client-csv-docurl.js
 *
 * Does NOT touch We (All Tasks export), m (Action Board export),
 * or any other patch scripts.
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

console.log('Patching Doc URL into Client View CSV export (Fe)...\n');

// Single replacement covering the entire Fe header+row construction
rep(
  // ── old (headers) ──
  'Fe=()=>{const h=["Intake Date","Task","Client","Stage","SEO Owner","Current Owner",' +
  '...k?["Content Owner","Content Status","SEO QC","Est Content Hrs","Actual Hrs","Web Owner","Web Status","Est Web Hrs","Target URL"]:[],' +
  '...U?["Content Status","SEO QC Status","Est Content Hrs","Actual Hours"]:[],' +
  '...R?["Web Status","Est Web Hrs","Target URL","Actual Hours"]:[]],' +
  // ── old (row data) ──
  '$=oe.map(be=>[be.intakeDate,`"${be.title.replace(/"/g,\'""\')}"`,' +
  'be.client,be.seoStage,be.seoOwner,be.currentOwner,' +
  '...k?[be.contentOwner||"",be.contentStatus||"",be.seoQcStatus||"",be.estHoursContent||"",be.actualHours||"",be.webOwner||"",be.webStatus||"",be.estHoursWeb||"",be.targetUrl||""]:[],' +
  '...U?[be.contentStatus||"",be.seoQcStatus||"",be.estHoursContent||"",be.actualHours||""]:[],' +
  '...R?[be.webStatus||"",be.estHoursWeb||"",be.targetUrl||"",be.actualHours||""]:[]].join(","))',

  // ── new (headers — "Doc URL" added to each branch) ──
  'Fe=()=>{const h=["Intake Date","Task","Client","Stage","SEO Owner","Current Owner",' +
  '...k?["Content Owner","Content Status","SEO QC","Est Content Hrs","Actual Hrs","Web Owner","Web Status","Est Web Hrs","Target URL","Doc URL"]:[],' +
  '...U?["Content Status","SEO QC Status","Est Content Hrs","Actual Hours","Doc URL"]:[],' +
  '...R?["Web Status","Est Web Hrs","Target URL","Actual Hours","Doc URL"]:[]],' +
  // ── new (row data — be.docUrl||"" added to each branch) ──
  '$=oe.map(be=>[be.intakeDate,`"${be.title.replace(/"/g,\'""\')}"`,' +
  'be.client,be.seoStage,be.seoOwner,be.currentOwner,' +
  '...k?[be.contentOwner||"",be.contentStatus||"",be.seoQcStatus||"",be.estHoursContent||"",be.actualHours||"",be.webOwner||"",be.webStatus||"",be.estHoursWeb||"",be.targetUrl||"",be.docUrl||""]:[],' +
  '...U?[be.contentStatus||"",be.seoQcStatus||"",be.estHoursContent||"",be.actualHours||"",be.docUrl||""]:[],' +
  '...R?[be.webStatus||"",be.estHoursWeb||"",be.targetUrl||"",be.actualHours||"",be.docUrl||""]:[]].join(","))',

  'Add Doc URL to Client View CSV export'
);

fs.writeFileSync(BUNDLE, code, 'utf-8');
console.log(`\nDone: ${changeCount} replacement(s) applied.`);
