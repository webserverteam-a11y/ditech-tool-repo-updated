/**
 * csvParser.js — Minimal CSV row parser that respects quoted fields.
 * Used by the historical-keywords CSV upload route.
 * Extracted from server.js, logic unchanged.
 */

export function parseCsvLine(line) {
  const cols = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQ = !inQ;
      continue;
    }
    if (ch === ',' && !inQ) {
      cols.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cols.push(cur.trim());
  return cols;
}

/**
 * Find the first column whose header includes any of the given candidate
 * substrings. Returns the index, or -1.
 */
export function findHeaderIdx(headers, candidates) {
  for (const c of candidates) {
    const idx = headers.findIndex((h) => h.includes(c));
    if (idx >= 0) return idx;
  }
  return -1;
}
