// Remove the Not Started / Paused capsule block from index.html
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(__dirname, '..', 'dist', 'index.html');
let html = readFileSync(htmlPath, 'utf8');

const START_MARKER = '<!-- \u2500\u2500 Action Board: Not Started & Paused summary capsules';
const END_MARKER   = '</body>';

const startIdx = html.indexOf(START_MARKER);
const endIdx   = html.indexOf(END_MARKER);

if (startIdx === -1) { console.error('START MARKER NOT FOUND'); process.exit(1); }
if (endIdx   === -1) { console.error('END MARKER NOT FOUND');   process.exit(1); }

// Keep everything before the capsule block, then close body + html normally
const before = html.slice(0, startIdx);
const newHtml = before.trimEnd() + '\n</body>\n\n</html>\n';

writeFileSync(htmlPath, newHtml, 'utf8');
console.log('Capsule block removed. Lines:', newHtml.split('\n').length);
