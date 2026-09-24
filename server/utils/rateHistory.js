const pool = require('../db');

/**
 * Effective-dated pay rates — the ONE place that answers "what rate did this
 * entry earn?" (migration 0209).
 *
 * Three histories: a worker's own rate + rate type (worker_rate_history), a
 * project's prevailing rate (project_prevailing_rate_history) and the company
 * default rate (company_default_rate_history).
 *
 * RESOLUTION RULE: the rate for a date is the history row with the greatest
 * effective_date <= that date. A change dated on the entry's own work_date
 * applies to it; a future-dated change never reaches earlier dates.
 *   - Worker: own rate missing / 0 → the company default in effect that day
 *     (the same fallback the engine has always had). rate_type comes from the
 *     worker's row in effect that day.
 *   - Prevailing: the project's row in effect that day; a NULL rate means "no
 *     project rate" → the caller's company prevailing fallback.
 *   - A date EARLIER than every row (a gap — backfill puts the first row at
 *     1900-01-01, so this only happens for rows created after a real date) uses
 *     the EARLIEST row: there is no older rate on record, so the first known
 *     rate is the best answer.
 *   - NO rows at all for that worker / project / company → the caller's
 *     current-rate cache (users.hourly_rate etc.), i.e. exactly the old
 *     behaviour. Keeps rows created by paths that never wrote history (QBO
 *     import, estimate → project, …) priced as before.
 *
 * `loadRateBook` is the batched loader (one query per history, no N+1);
 * everything else here is PURE so it can be unit-tested without a DB.
 */

const FAR_PAST = '1900-01-01';

// 'YYYY-MM-DD' from a Date / string (pg returns DATE as a local-midnight Date).
function dayKey(d) {
  if (d == null || d === '') return null;
  if (d instanceof Date) {
    if (isNaN(d)) return null;
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  return String(d).substring(0, 10);
}

const num = v => {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// Sort rows ascending by effective_date (stable) and normalize the date key.
function sortRows(rows) {
  return (rows || [])
    .map(r => ({ ...r, effective_date: dayKey(r.effective_date) }))
    .filter(r => r.effective_date)
    .sort((a, b) => a.effective_date.localeCompare(b.effective_date));
}

/**
 * The row in effect on `date` from rows sorted ascending: greatest
 * effective_date <= date; before every row → the earliest row; no rows → null.
 */
function rowInEffect(sortedRows, date) {
  if (!sortedRows || sortedRows.length === 0) return null;
  const d = dayKey(date);
  if (!d) return sortedRows[sortedRows.length - 1];
  let hit = null;
  for (const r of sortedRows) {
    if (r.effective_date <= d) hit = r; else break;
  }
  return hit || sortedRows[0];
}

/** Build the in-memory book from raw rows (any order). Keys are stringified ids. */
function makeRateBook({ workerRows = [], projectRows = [], defaultRows = [] } = {}) {
  const group = (rows, key) => {
    const m = new Map();
    for (const r of rows || []) {
      const k = String(r[key]);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    for (const [k, v] of m) m.set(k, sortRows(v));
    return m;
  };
  return {
    workers: group(workerRows, 'user_id'),
    projects: group(projectRows, 'project_id'),
    defaults: sortRows(defaultRows),
  };
}

/** Company default rate on `date`; no history → settings.default_hourly_rate. */
function defaultRateOn(book, date, settings = {}) {
  const row = book ? rowInEffect(book.defaults, date) : null;
  if (row) return num(row.rate) || 0;
  return num(settings && settings.default_hourly_rate) || 0;
}

/**
 * A worker's { rate, rateType, ownRate } on `date`. `worker` is the users row
 * (the current cache: hourly_rate / rate_type) used only when the worker has no
 * history rows. rate = own rate, or the company default in effect that day when
 * the own rate is missing / 0.
 */
function workerRateOn(book, worker, date, settings = {}) {
  const rows = book && worker && worker.id != null ? book.workers.get(String(worker.id)) : null;
  const row = rowInEffect(rows, date);
  const own = row ? num(row.hourly_rate) : num(worker && worker.hourly_rate);
  const rateType = (row ? row.rate_type : (worker && worker.rate_type)) === 'daily' ? 'daily' : 'hourly';
  const rate = own || defaultRateOn(book, date, settings);
  return { rate, rateType, ownRate: own };
}

/**
 * A project's prevailing rate on `date`, or null (= no project rate → caller's
 * company fallback). No history rows for the project → `fallbackMap[projectId]`
 * (the current projects.prevailing_wage_rate cache).
 */
function prevailingRateOn(book, projectId, date, fallbackMap = {}) {
  if (projectId == null) return null;
  const rows = book ? book.projects.get(String(projectId)) : null;
  if (rows && rows.length) {
    const row = rowInEffect(rows, date);
    return row ? num(row.rate) : null;
  }
  const f = fallbackMap ? fallbackMap[projectId] : null;
  return f != null && Number.isFinite(Number(f)) ? Number(f) : null;
}

/**
 * The date span a history row governs: [effective_date, next row's date − 1],
 * `to` null = open-ended. Used to find locked pay periods a change reaches.
 * `rows` are the OTHER rows of the same history (sorted or not).
 */
function governedSpan(rows, effectiveDate) {
  const d = dayKey(effectiveDate);
  const later = sortRows(rows).map(r => r.effective_date).filter(x => x > d);
  if (!later.length) return { from: d, to: null };
  const next = later[0];
  const m = next.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const prev = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) - 86400000).toISOString().substring(0, 10);
  return { from: d, to: prev };
}

/**
 * Locked pay periods (pay_periods rows) overlapping [span.from, span.to].
 * Returns [{ id, period_start, period_end, label }] as 'YYYY-MM-DD' strings.
 */
function lockedPeriodsInSpan(periods, span) {
  if (!span || !span.from) return [];
  return (periods || [])
    .map(p => ({ id: p.id, period_start: dayKey(p.period_start), period_end: dayKey(p.period_end), label: p.label || null }))
    .filter(p => p.period_end >= span.from && (span.to == null || p.period_start <= span.to))
    .sort((a, b) => a.period_start.localeCompare(b.period_start));
}

// A weighted rate: Σ(w·r)/Σw over [{w, r}]. When every r is the SAME (the normal,
// no-rate-change case) that r is returned verbatim — never a float-drifted blend —
// so a statement without a mid-period change is byte-identical to before.
function blendRate(pairs, fallback) {
  const list = (pairs || []).filter(p => p && Number.isFinite(p.r));
  if (!list.length) return fallback;
  const r0 = list[0].r;
  if (list.every(p => p.r === r0)) return r0;
  let wSum = 0, rwSum = 0;
  for (const p of list) { const w = Math.max(0, p.w || 0); wSum += w; rwSum += w * p.r; }
  return wSum > 0 ? rwSum / wSum : fallback;
}

/** Validate a 'YYYY-MM-DD' calendar date (rejects 2026-02-30). */
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1900 && y <= 2999;
}

// ─── Batched loader ────────────────────────────────────────────────────────

/**
 * Load the rate book for a company in ONE query per history.
 * @param companyId
 * @param userIds    worker ids to load (null → every worker of the company)
 * @param projectIds project ids to load (null → every project of the company)
 * @param to         last date that will be priced (rows after it can't apply;
 *                   null → no bound). Rows before the range are needed (the one
 *                   in effect at the start), so there's no lower bound.
 */
async function loadRateBook({ companyId, userIds = null, projectIds = null, to = null, db = pool }) {
  const toKey = dayKey(to);
  const uids = Array.isArray(userIds) ? [...new Set(userIds.filter(x => x != null).map(Number))] : null;
  const pids = Array.isArray(projectIds) ? [...new Set(projectIds.filter(x => x != null).map(Number))] : null;
  const [w, p, d] = await Promise.all([
    uids && uids.length === 0 ? { rows: [] } : db.query(
      `SELECT user_id, hourly_rate, rate_type, to_char(effective_date, 'YYYY-MM-DD') AS effective_date
         FROM worker_rate_history
        WHERE company_id = $1
          AND ($2::int[] IS NULL OR user_id = ANY($2::int[]))
          AND ($3::date IS NULL OR effective_date <= $3::date)
        ORDER BY user_id, effective_date`,
      [companyId, uids, toKey]
    ),
    pids && pids.length === 0 ? { rows: [] } : db.query(
      `SELECT project_id, rate, to_char(effective_date, 'YYYY-MM-DD') AS effective_date
         FROM project_prevailing_rate_history
        WHERE company_id = $1
          AND ($2::int[] IS NULL OR project_id = ANY($2::int[]))
          AND ($3::date IS NULL OR effective_date <= $3::date)
        ORDER BY project_id, effective_date`,
      [companyId, pids, toKey]
    ),
    db.query(
      `SELECT rate, to_char(effective_date, 'YYYY-MM-DD') AS effective_date
         FROM company_default_rate_history
        WHERE company_id = $1 AND ($2::date IS NULL OR effective_date <= $2::date)
        ORDER BY effective_date`,
      [companyId, toKey]
    ),
  ]);
  return makeRateBook({ workerRows: (w && w.rows) || [], projectRows: (p && p.rows) || [], defaultRows: (d && d.rows) || [] });
}

/** loadRateBook for a set of entry rows (user_id / project_id / work_date). */
async function loadRateBookForEntries(companyId, rows, db = pool) {
  const list = rows || [];
  let max = null;
  for (const r of list) { const k = dayKey(r.work_date); if (k && (!max || k > max)) max = k; }
  return loadRateBook({
    companyId, db, to: max,
    userIds: list.map(r => r.user_id),
    projectIds: list.map(r => r.project_id),
  });
}

/**
 * Rate book for LABOR_ENTRY_COLUMNS rows (they carry te.company_id). Null when the
 * rows are empty / carry no company (then laborCostCents prices at current rates).
 */
async function loadRateBookForLaborRows(rows, db = pool) {
  const list = rows || [];
  const withCo = list.find(r => r && r.company_id);
  if (!withCo) return null;
  return loadRateBookForEntries(withCo.company_id, list.filter(r => r.company_id === withCo.company_id), db);
}

module.exports = {
  FAR_PAST,
  dayKey,
  rowInEffect,
  makeRateBook,
  defaultRateOn,
  workerRateOn,
  prevailingRateOn,
  governedSpan,
  lockedPeriodsInSpan,
  isValidDate,
  blendRate,
  loadRateBook,
  loadRateBookForEntries,
  loadRateBookForLaborRows,
};
