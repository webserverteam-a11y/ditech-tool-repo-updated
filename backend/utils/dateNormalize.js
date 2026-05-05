/**
 * dateNormalize.js — Date parsing helpers used by task routes.
 *
 * Extracted verbatim from server.js. Logic unchanged.
 *
 *   normalizeDate(val)       — converts DD-MM-YYYY, DD/MM/YYYY, MM-DD-YYYY,
 *                              MM/DD/YYYY, YYYY/MM/DD to YYYY-MM-DD.
 *   normalizeTaskDates(task) — mutates task.intakeDate, contentAssignedDate,
 *                              webAssignedDate to YYYY-MM-DD. Defaults
 *                              intakeDate to today when blank.
 */

export function normalizeDate(val) {
  if (!val || typeof val !== 'string') return val;
  const s = val.trim();
  if (!s) return s;

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // YYYY/MM/DD
  let m = s.match(/^(\d{4})[\/](\d{1,2})[\/](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;

  // DD-MM-YYYY or DD/MM/YYYY  (day > 12 disambiguates from MM-DD-YYYY)
  // MM-DD-YYYY or MM/DD/YYYY  (month > 12 is impossible, so first > 12 means day)
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const year = m[3];
    if (a > 12) {
      // a must be day → DD-MM-YYYY
      return `${year}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
    }
    if (b > 12) {
      // b must be day → MM-DD-YYYY
      return `${year}-${String(a).padStart(2, '0')}-${String(b).padStart(2, '0')}`;
    }
    // Ambiguous (both ≤ 12): assume DD-MM-YYYY (common in Indian locale)
    return `${year}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
  }

  return s;
}

const TASK_DATE_FIELDS = ['intakeDate', 'contentAssignedDate', 'webAssignedDate'];

export function normalizeTaskDates(task) {
  const today = new Date().toISOString().split('T')[0];
  for (const field of TASK_DATE_FIELDS) {
    if (task[field]) {
      task[field] = normalizeDate(task[field]);
    }
  }
  // If intakeDate is missing or blank, default to today so the task is never
  // silently hidden by the Action Board's date filter.
  if (!task.intakeDate || !task.intakeDate.trim()) {
    task.intakeDate = today;
  }
  return task;
}
