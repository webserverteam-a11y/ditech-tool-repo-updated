/**
 * taskMapping.js — Task (snake_case DB row) ↔ (camelCase JSON) mapping.
 *
 * Extracted verbatim from server.js. Logic unchanged.
 *
 * Exports:
 *   TASK_COLUMN_MAP   — db column → json key map
 *   TASK_COLS         — list of db column names (in order)
 *   INT_COLS          — columns cast to Number (int)
 *   DEC_COLS          — columns cast to Number (decimal)
 *   DATE_COLS         — columns treated as date strings
 *   rowToTask(row)    — DB row → json task (without child arrays populated)
 *   taskToColumns(t)  — json task → { cols, vals } for INSERT/UPDATE
 *   groupBy(arr, key) — simple in-memory group helper
 */

export const TASK_COLUMN_MAP = {
  id: 'id',
  title: 'title',
  client: 'client',
  intake_date: 'intakeDate',
  seo_owner: 'seoOwner',
  seo_stage: 'seoStage',
  seo_qc_status: 'seoQcStatus',
  focused_kw: 'focusedKw',
  volume: 'volume',
  mar_rank: 'marRank',
  current_rank: 'currentRank',
  est_hours: 'estHours',
  est_hours_seo: 'estHoursSEO',
  est_hours_content: 'estHoursContent',
  est_hours_web: 'estHoursWeb',
  actual_hours: 'actualHours',
  content_assigned_date: 'contentAssignedDate',
  content_owner: 'contentOwner',
  content_status: 'contentStatus',
  web_assigned_date: 'webAssignedDate',
  web_owner: 'webOwner',
  target_url: 'targetUrl',
  web_status: 'webStatus',
  current_owner: 'currentOwner',
  days_in_stage: 'daysInStage',
  remarks: 'remarks',
  is_completed: 'isCompleted',
  execution_state: 'executionState',
  doc_url: 'docUrl',
  dept_type: 'deptType',
  task_type: 'taskType',
  platform: 'platform',
  deliverable_url: 'deliverableUrl',
  due_date: 'dueDate',
  assigned_to: 'assignedTo',
  ad_budget: 'adBudget',
  est_hours_seo_review: 'estHoursSEOReview',
  qc_submitted_at: 'qcSubmittedAt',
  est_hours_content_rework: 'estHoursContentRework',
};

export const INT_COLS = new Set([
  'volume',
  'mar_rank',
  'current_rank',
  'days_in_stage',
]);

export const DEC_COLS = new Set([
  'est_hours',
  'est_hours_seo',
  'est_hours_content',
  'est_hours_web',
  'actual_hours',
  'ad_budget',
  'est_hours_seo_review',
  'est_hours_content_rework',
]);

export const DATE_COLS = new Set([
  'intake_date',
  'content_assigned_date',
  'web_assigned_date',
  'due_date',
]);

export const TASK_COLS = Object.keys(TASK_COLUMN_MAP);

export function groupBy(arr, key) {
  const m = {};
  for (const item of arr) {
    const k = item[key];
    if (!m[k]) m[k] = [];
    m[k].push(item);
  }
  return m;
}

/** DB row → camelCase task object (without child arrays populated) */
export function rowToTask(row) {
  const task = {};
  for (const col of TASK_COLS) {
    const key = TASK_COLUMN_MAP[col];
    let val = row[col];
    if (val === null || val === undefined) {
      if (INT_COLS.has(col) || DEC_COLS.has(col)) val = 0;
      else if (col === 'is_completed') val = false;
      else val = '';
    }
    if (col === 'is_completed') val = !!val;
    if (INT_COLS.has(col)) val = Number(val) || 0;
    if (DEC_COLS.has(col)) val = Number(val) || 0;
    task[key] = val;
  }
  task.timeEvents = [];
  task.qcReviews = [];
  task.reworkEntries = [];
  return task;
}

/** camelCase task object → { cols, vals } for INSERT/UPDATE */
export function taskToColumns(task) {
  const cols = [];
  const vals = [];
  for (const col of TASK_COLS) {
    const key = TASK_COLUMN_MAP[col];
    let val = task[key];
    if (val === undefined) val = null;
    if (col === 'is_completed') val = val ? 1 : 0;
    if ((INT_COLS.has(col) || DEC_COLS.has(col)) && (val === '' || val === null)) val = 0;
    cols.push(col);
    vals.push(val);
  }
  return { cols, vals };
}
