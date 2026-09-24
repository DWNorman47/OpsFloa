const pool = require('../db');
const logger = require('../logger');
const { wallDateInTZ } = require('./timeFormat');
const { ADMIN_SETTINGS_DEFAULTS } = require('../settingsDefaults');
const { USER_RATE_TYPES } = require('../constants/userEnums');
const { FAR_PAST, dayKey, rowInEffect, governedSpan, widenSpanToWeeks, lockedPeriodsInSpan, isValidDate, makeRateBook } = require('./rateHistory');

/**
 * WRITE side of effective-dated rates (migration 0209). The read side — the
 * resolver the pay engine uses — is utils/rateHistory.js.
 *
 * The old columns stay the CURRENT-rate cache (many screens read them):
 *   users.hourly_rate / users.rate_type, projects.prevailing_wage_rate,
 *   settings.default_hourly_rate, settings.prevailing_wage_rate (0210)
 * After every history write the cache is recomputed = the row in effect TODAY in
 * the company's time zone; a daily job (jobs/rateCacheRefresh.js) catches
 * future-dated rows the day they take effect.
 *
 * Before the FIRST dated change for an owner that has no history yet (created by
 * a path that never wrote any), the current cache is snapshotted as the
 * '1900-01-01' baseline — so a change "from today" never re-prices the past.
 */

const KINDS = {
  worker: {
    table: 'worker_rate_history', owner: 'user_id', rateCol: 'hourly_rate',
    entityType: 'worker', auditAction: 'worker.rate_history',
  },
  project: {
    table: 'project_prevailing_rate_history', owner: 'project_id', rateCol: 'rate',
    entityType: 'project', auditAction: 'project.prevailing_rate_history',
  },
  company: {
    table: 'company_default_rate_history', owner: 'company_id', rateCol: 'rate',
    entityType: 'settings', auditAction: 'settings.default_rate_history',
    settingKey: 'default_hourly_rate',
  },
  // The company prevailing-wage fallback (0210): what a prevailing entry earns when
  // its project has no prevailing rate of its own. Cache = settings.prevailing_wage_rate.
  company_prevailing: {
    table: 'company_prevailing_rate_history', owner: 'company_id', rateCol: 'rate',
    entityType: 'settings', auditAction: 'settings.prevailing_rate_history',
    settingKey: 'prevailing_wage_rate',
  },
};

// Company-level histories (one per company, no separate owner id).
const isCompanyKind = kind => kind === 'company' || kind === 'company_prevailing';

/**
 * Last resort when a company has no company_timezone and no user (active or the
 * owner) has a time zone on file. It used to be a silent 'America/Phoenix' guess —
 * wrong for most companies and invisible. Now it's UTC, and it's LOGGED (once per
 * company per process) so the missing setting shows up in the logs.
 */
const FALLBACK_TIMEZONE = 'UTC';
const warnedNoTimezone = new Set();

const firstTz = r => (r && r.rows && r.rows[0] && String(r.rows[0].timezone || '').trim()) || null;

/**
 * The company's IANA time zone:
 *   1. settings.company_timezone (default '' = unset)
 *   2. the most common users.timezone among ACTIVE users (seeded from real
 *      clock-ins, 0098)
 *   3. the company owner's users.timezone (worker_type 'owner', else the
 *      earliest admin), whether or not they're active
 *   4. FALLBACK_TIMEZONE (UTC), logged once per company
 */
async function companyTimezone(companyId, db = pool) {
  const r = await db.query("SELECT value FROM settings WHERE company_id = $1 AND key = 'company_timezone'", [companyId]);
  const own = r && r.rows && r.rows[0] && String(r.rows[0].value || '').trim();
  if (own) return own;
  const common = firstTz(await db.query(
    `SELECT timezone FROM users
      WHERE company_id = $1 AND active = true AND timezone IS NOT NULL AND timezone <> ''
      GROUP BY timezone ORDER BY COUNT(*) DESC, timezone LIMIT 1`,
    [companyId]
  ));
  if (common) return common;
  const owner = firstTz(await db.query(
    `SELECT timezone FROM users
      WHERE company_id = $1 AND timezone IS NOT NULL AND timezone <> ''
        AND (worker_type = 'owner' OR role IN ('admin', 'super_admin'))
      ORDER BY (worker_type = 'owner') DESC, created_at ASC, id ASC LIMIT 1`,
    [companyId]
  ));
  if (owner) return owner;
  if (!warnedNoTimezone.has(companyId)) {
    warnedNoTimezone.add(companyId);
    logger.warn({ companyId }, `company has no time zone on file (company_timezone setting, users, owner) — using ${FALLBACK_TIMEZONE} for "today"; set Company Settings → time zone`);
  }
  return FALLBACK_TIMEZONE;
}

/** Today's date ('YYYY-MM-DD') in the company's time zone (see companyTimezone). */
async function companyToday(companyId, db = pool) {
  return wallDateInTZ(new Date(), await companyTimezone(companyId, db));
}

const ownerParams = (kind, companyId, ownerId) => (isCompanyKind(kind) ? [companyId] : [companyId, ownerId]);
const ownerWhere = (kind) => (isCompanyKind(kind) ? 'h.company_id = $1' : `h.company_id = $1 AND h.${KINDS[kind].owner} = $2`);

/** Every row for one owner, oldest first, with the author's name. */
async function listHistory(kind, companyId, ownerId, db = pool) {
  const k = KINDS[kind];
  const typeCol = kind === 'worker' ? 'h.rate_type,' : '';
  const r = await db.query(
    `SELECT h.id, h.${k.rateCol} AS rate, ${typeCol} to_char(h.effective_date, 'YYYY-MM-DD') AS effective_date,
            h.note, h.created_at, h.created_by, u.full_name AS created_by_name
       FROM ${k.table} h
       LEFT JOIN users u ON u.id = h.created_by
      WHERE ${ownerWhere(kind)}
      ORDER BY h.effective_date ASC, h.id ASC`,
    ownerParams(kind, companyId, ownerId)
  );
  return (r.rows || []).map(row => ({
    ...row,
    rate: row.rate == null ? null : parseFloat(row.rate),
    ...(kind === 'worker' ? { rate_type: row.rate_type || 'hourly' } : {}),
    effective_date: dayKey(row.effective_date),
    initial: dayKey(row.effective_date) === FAR_PAST,
  }));
}

/** The current cache value for an owner: { rate, rate_type? } or null when the owner doesn't exist. */
async function readCache(kind, companyId, ownerId, db = pool) {
  if (kind === 'worker') {
    const r = await db.query('SELECT hourly_rate, rate_type FROM users WHERE id = $1 AND company_id = $2', [ownerId, companyId]);
    if (!r.rows || !r.rows.length) return null;
    return { rate: r.rows[0].hourly_rate == null ? null : parseFloat(r.rows[0].hourly_rate), rate_type: r.rows[0].rate_type || 'hourly' };
  }
  if (kind === 'project') {
    const r = await db.query('SELECT prevailing_wage_rate FROM projects WHERE id = $1 AND company_id = $2', [ownerId, companyId]);
    if (!r.rows || !r.rows.length) return null;
    return { rate: r.rows[0].prevailing_wage_rate == null ? null : parseFloat(r.rows[0].prevailing_wage_rate) };
  }
  const key = KINDS[kind].settingKey;
  const r = await db.query(`SELECT value FROM settings WHERE company_id = $1 AND key = '${key}'`, [companyId]);
  const v = r.rows && r.rows[0] ? parseFloat(r.rows[0].value) : NaN;
  return { rate: Number.isFinite(v) ? v : ADMIN_SETTINGS_DEFAULTS[key] };
}

/** Insert (or replace, same date) one history row. */
async function upsertRow(kind, { companyId, ownerId, rate, rateType, effectiveDate, note = null, createdBy = null }, db = pool) {
  const k = KINDS[kind];
  if (kind === 'worker') {
    return db.query(
      `INSERT INTO worker_rate_history (company_id, user_id, hourly_rate, rate_type, effective_date, note, created_by)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7)
       ON CONFLICT (user_id, effective_date) DO UPDATE
         SET hourly_rate = EXCLUDED.hourly_rate, rate_type = EXCLUDED.rate_type, note = EXCLUDED.note,
             created_by = EXCLUDED.created_by, created_at = NOW()
       RETURNING id`,
      [companyId, ownerId, rate, rateType || 'hourly', effectiveDate, note, createdBy]
    );
  }
  if (kind === 'project') {
    return db.query(
      `INSERT INTO ${k.table} (company_id, project_id, rate, effective_date, note, created_by)
       VALUES ($1, $2, $3, $4::date, $5, $6)
       ON CONFLICT (project_id, effective_date) DO UPDATE
         SET rate = EXCLUDED.rate, note = EXCLUDED.note, created_by = EXCLUDED.created_by, created_at = NOW()
       RETURNING id`,
      [companyId, ownerId, rate, effectiveDate, note, createdBy]
    );
  }
  return db.query(
    `INSERT INTO ${k.table} (company_id, rate, effective_date, note, created_by)
     VALUES ($1, $2, $3::date, $4, $5)
     ON CONFLICT (company_id, effective_date) DO UPDATE
       SET rate = EXCLUDED.rate, note = EXCLUDED.note, created_by = EXCLUDED.created_by, created_at = NOW()
     RETURNING id`,
    [companyId, rate, effectiveDate, note, createdBy]
  );
}

/**
 * The owner's history, snapshotting the current cache as the 1900-01-01 baseline
 * first when there is none (see header). Returns the rows (oldest first).
 */
async function ensureBaseline(kind, companyId, ownerId, db = pool) {
  let rows = await listHistory(kind, companyId, ownerId, db);
  if (rows.length) return rows;
  const cache = await readCache(kind, companyId, ownerId, db);
  if (!cache) return rows;
  await upsertRow(kind, {
    companyId, ownerId, rate: cache.rate, rateType: cache.rate_type, effectiveDate: FAR_PAST,
    note: 'Rate on file before rate history was recorded',
  }, db);
  rows = await listHistory(kind, companyId, ownerId, db);
  return rows;
}

/**
 * Recompute the cache = the row in effect `today`. Returns the value written.
 * Company default: the settings row is (re)written as text, like the settings PATCH.
 */
async function refreshCache(kind, companyId, ownerId, today, db = pool) {
  const rows = await listHistory(kind, companyId, ownerId, db);
  const book = makeRateBook({ defaultRows: rows }); // sorts + normalizes
  const row = rowInEffect(book.defaults, today);
  if (!row) return null;
  if (kind === 'worker') {
    await db.query('UPDATE users SET hourly_rate = $1, rate_type = $2 WHERE id = $3 AND company_id = $4', [row.rate, row.rate_type || 'hourly', ownerId, companyId]);
    return { rate: row.rate, rate_type: row.rate_type || 'hourly' };
  }
  if (kind === 'project') {
    await db.query('UPDATE projects SET prevailing_wage_rate = $1 WHERE id = $2 AND company_id = $3', [row.rate, ownerId, companyId]);
    return { rate: row.rate };
  }
  await db.query(
    `INSERT INTO settings (company_id, key, value) VALUES ($1, '${KINDS[kind].settingKey}', $2)
     ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [companyId, String(row.rate)]
  );
  return { rate: row.rate };
}

/**
 * Locked pay periods (pay_periods rows — every row IS a lock) whose pay a change
 * dated `effectiveDate` would alter: the span the row governs, i.e. from its date
 * up to the day before the owner's next later row (open-ended if none; from
 * 1900-01-01 when the row is / becomes the earliest — see governedSpan), WIDENED
 * to whole pay weeks: weekly OT and the weighted-average regular rate price a
 * period with the rest of its week as context, so a change dated Thursday still
 * alters a locked period that ended the Wednesday before. For a delete, pass the
 * deleted row's date with the remaining rows.
 */
async function lockedImpact(companyId, otherRows, effectiveDate, db = pool) {
  const ws = await db.query("SELECT value FROM settings WHERE company_id = $1 AND key = 'week_start'", [companyId]);
  const weekStart = ws && ws.rows && ws.rows[0] ? ws.rows[0].value : ADMIN_SETTINGS_DEFAULTS.week_start;
  const span = widenSpanToWeeks(governedSpan(otherRows, effectiveDate), weekStart);
  const r = await db.query(
    `SELECT id, to_char(period_start, 'YYYY-MM-DD') AS period_start, to_char(period_end, 'YYYY-MM-DD') AS period_end, label
       FROM pay_periods WHERE company_id = $1 AND period_end >= $2::date ORDER BY period_start`,
    [companyId, span.from]
  );
  return lockedPeriodsInSpan(r.rows || [], span);
}

/** Locked periods a change dated `effectiveDate` would reach (no write). */
async function checkLocked(kind, companyId, ownerId, effectiveDate, db = pool) {
  const rows = await listHistory(kind, companyId, ownerId, db);
  // No history yet → addChange will snapshot the cache as the 1900-01-01 baseline
  // first, so the change is NOT the earliest row (don't flag every past period).
  const others = rows.length ? rows : [{ effective_date: FAR_PAST }];
  return lockedImpact(companyId, others.filter(r => r.effective_date !== effectiveDate), effectiveDate, db);
}

/** The 409 body for a backdate into locked periods without `confirm_locked`. */
function lockedConflict(periods) {
  return {
    error: `This change reaches ${periods.length} locked pay period${periods.length === 1 ? '' : 's'}. Their pay will be recalculated at the new rate. Confirm to save anyway.`,
    code: 'locked_periods',
    locked_periods: periods,
    locked_count: periods.length,
  };
}

/**
 * Validate a change body. Returns { error } or { value: { rate, rateType, effectiveDate, note } }.
 * `rate` null is allowed for a worker (→ company default) and a project (→ no
 * project rate); the company default must be a positive number (same rule as the
 * settings PATCH).
 */
function validateChange(kind, body, today) {
  const b = body || {};
  let rate = b.rate;
  if (rate === '' || rate === undefined) rate = null;
  if (rate !== null) {
    rate = typeof rate === 'number' ? rate : parseFloat(rate);
    if (!Number.isFinite(rate) || rate < 0) return { error: 'rate must be a non-negative number' };
  }
  if (kind === 'company' && !(rate > 0)) return { error: 'The company default rate must be greater than 0' };
  // The company prevailing fallback may be 0 (same rule as the settings PATCH), never empty.
  if (kind === 'company_prevailing' && rate === null) return { error: 'The company prevailing wage rate is required' };
  let rateType = null;
  if (kind === 'worker') {
    // Omitted → keep the type in effect on that date (resolved in addChange).
    rateType = b.rate_type == null || b.rate_type === '' ? null : b.rate_type;
    if (rateType !== null && !USER_RATE_TYPES.includes(rateType)) return { error: `rate_type must be one of: ${USER_RATE_TYPES.join(', ')}` };
  }
  const effectiveDate = b.effective_date == null || b.effective_date === '' ? today : String(b.effective_date);
  if (!isValidDate(effectiveDate)) return { error: 'effective_date must be a valid YYYY-MM-DD date' };
  const note = b.note == null ? null : String(b.note).trim().slice(0, 500) || null;
  return { value: { rate, rateType, effectiveDate, note } };
}

/**
 * Add a dated change end-to-end: baseline, locked-period check, upsert, cache
 * refresh. Returns { conflict } (409 body) when it would reach locked periods
 * without confirmLocked, else { rows, cache, lockedPeriods, previous }.
 */
async function addChange(kind, { companyId, ownerId, change, confirmLocked = false, createdBy = null, today = null }, db = pool) {
  const day = today || await companyToday(companyId, db);
  const rows = await ensureBaseline(kind, companyId, ownerId, db);
  const others = rows.filter(r => r.effective_date !== change.effectiveDate);
  const locked = await lockedImpact(companyId, others, change.effectiveDate, db);
  if (locked.length && !confirmLocked) return { conflict: lockedConflict(locked) };
  const previous = rowInEffect(makeRateBook({ defaultRows: rows }).defaults, change.effectiveDate);
  const rateType = kind === 'worker' ? (change.rateType || (previous && previous.rate_type) || 'hourly') : null;
  await upsertRow(kind, { companyId, ownerId, rate: change.rate, rateType, effectiveDate: change.effectiveDate, note: change.note, createdBy }, db);
  const cache = await refreshCache(kind, companyId, ownerId, day, db);
  const after = await listHistory(kind, companyId, ownerId, db);
  return { rows: after, cache, lockedPeriods: locked, previous: previous ? { rate: previous.rate, rate_type: previous.rate_type, effective_date: previous.effective_date } : null, today: day };
}

/**
 * Delete one row (never the last one). Returns { notFound } | { lastRow } |
 * { conflict } | { rows, cache, lockedPeriods, deleted }.
 */
async function deleteChange(kind, { companyId, ownerId, rowId, confirmLocked = false, today = null }, db = pool) {
  const rows = await listHistory(kind, companyId, ownerId, db);
  const target = rows.find(r => String(r.id) === String(rowId));
  if (!target) return { notFound: true };
  if (rows.length <= 1) return { lastRow: true };
  const others = rows.filter(r => r.id !== target.id);
  // Deleting the earliest row hands its dates — AND every date before it — to the
  // next row (earliest-row rule); governedSpan starts that span at 1900-01-01.
  const locked = await lockedImpact(companyId, others, target.effective_date, db);
  if (locked.length && !confirmLocked) return { conflict: lockedConflict(locked) };
  const k = KINDS[kind];
  await db.query(`DELETE FROM ${k.table} h WHERE h.id = $${isCompanyKind(kind) ? 2 : 3} AND ${ownerWhere(kind)}`, [...ownerParams(kind, companyId, ownerId), target.id]);
  const day = today || await companyToday(companyId, db);
  const cache = await refreshCache(kind, companyId, ownerId, day, db);
  const after = await listHistory(kind, companyId, ownerId, db);
  return { rows: after, cache, lockedPeriods: locked, deleted: target };
}

/**
 * Initial history row for a NEW owner (worker invite/create, project create,
 * company signup): the first rate is dated 1900-01-01 — it's the rate for all
 * time until a dated change. Idempotent.
 */
async function recordInitialRate(kind, { companyId, ownerId, rate, rateType = 'hourly', createdBy = null }, db = pool) {
  const k = KINDS[kind];
  const conflictCols = isCompanyKind(kind) ? 'company_id, effective_date' : `${k.owner}, effective_date`;
  if (kind === 'worker') {
    return db.query(
      `INSERT INTO worker_rate_history (company_id, user_id, hourly_rate, rate_type, effective_date, note, created_by)
       VALUES ($1, $2, $3, $4, $5::date, 'Initial rate', $6) ON CONFLICT (${conflictCols}) DO NOTHING`,
      [companyId, ownerId, rate, rateType || 'hourly', FAR_PAST, createdBy]
    );
  }
  if (kind === 'project') {
    return db.query(
      `INSERT INTO project_prevailing_rate_history (company_id, project_id, rate, effective_date, note, created_by)
       VALUES ($1, $2, $3, $4::date, 'Initial rate', $5) ON CONFLICT (${conflictCols}) DO NOTHING`,
      [companyId, ownerId, rate, FAR_PAST, createdBy]
    );
  }
  return db.query(
    `INSERT INTO ${k.table} (company_id, rate, effective_date, note, created_by)
     VALUES ($1, $2, $3::date, 'Initial rate', $4) ON CONFLICT (${conflictCols}) DO NOTHING`,
    [companyId, rate, FAR_PAST, createdBy]
  );
}

/**
 * Daily cache refresh (jobs/rateCacheRefresh.js): for every company with a real
 * dated change, set each cache to the row in effect on the company's local
 * today. Set-based and idempotent (only rows that differ are touched).
 */
async function refreshAllCaches(db = pool) {
  const cos = await db.query(
    `SELECT c.company_id, s.value AS tz FROM (
       SELECT company_id FROM worker_rate_history WHERE effective_date > DATE '1900-01-01'
       UNION SELECT company_id FROM project_prevailing_rate_history WHERE effective_date > DATE '1900-01-01'
       UNION SELECT company_id FROM company_default_rate_history WHERE effective_date > DATE '1900-01-01'
       UNION SELECT company_id FROM company_prevailing_rate_history WHERE effective_date > DATE '1900-01-01'
     ) c LEFT JOIN settings s ON s.company_id = c.company_id AND s.key = 'company_timezone'`
  );
  let updated = 0;
  for (const { company_id: companyId, tz } of cos.rows || []) {
    // Same zone resolution as companyToday (an empty company_timezone is not UTC).
    const today = tz && String(tz).trim() ? wallDateInTZ(new Date(), tz) : await companyToday(companyId, db);
    const w = await db.query(
      `UPDATE users u SET hourly_rate = h.hourly_rate, rate_type = h.rate_type
         FROM (SELECT DISTINCT ON (user_id) user_id, hourly_rate, rate_type
                 FROM worker_rate_history WHERE company_id = $1 AND effective_date <= $2::date
                ORDER BY user_id, effective_date DESC) h
        WHERE u.id = h.user_id AND u.company_id = $1
          AND (u.hourly_rate IS DISTINCT FROM h.hourly_rate OR u.rate_type IS DISTINCT FROM h.rate_type)`,
      [companyId, today]
    );
    const p = await db.query(
      `UPDATE projects p SET prevailing_wage_rate = h.rate
         FROM (SELECT DISTINCT ON (project_id) project_id, rate
                 FROM project_prevailing_rate_history WHERE company_id = $1 AND effective_date <= $2::date
                ORDER BY project_id, effective_date DESC) h
        WHERE p.id = h.project_id AND p.company_id = $1
          AND p.prevailing_wage_rate IS DISTINCT FROM h.rate`,
      [companyId, today]
    );
    const d = await db.query(
      `INSERT INTO settings (company_id, key, value)
       SELECT $1, 'default_hourly_rate', (h.rate::float8)::text FROM (
         SELECT rate FROM company_default_rate_history WHERE company_id = $1 AND effective_date <= $2::date
          ORDER BY effective_date DESC LIMIT 1) h
       ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value
         WHERE settings.value IS DISTINCT FROM EXCLUDED.value`,
      [companyId, today]
    );
    const pd = await db.query(
      `INSERT INTO settings (company_id, key, value)
       SELECT $1, 'prevailing_wage_rate', (h.rate::float8)::text FROM (
         SELECT rate FROM company_prevailing_rate_history WHERE company_id = $1 AND effective_date <= $2::date
          ORDER BY effective_date DESC LIMIT 1) h
       ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value
         WHERE settings.value IS DISTINCT FROM EXCLUDED.value`,
      [companyId, today]
    );
    updated += (w.rowCount || 0) + (p.rowCount || 0) + (d.rowCount || 0) + ((pd && pd.rowCount) || 0);
  }
  return { companies: (cos.rows || []).length, updated };
}

module.exports = {
  KINDS,
  FALLBACK_TIMEZONE,
  isCompanyKind,
  companyTimezone,
  companyToday,
  listHistory,
  readCache,
  ensureBaseline,
  upsertRow,
  refreshCache,
  lockedImpact,
  lockedConflict,
  checkLocked,
  validateChange,
  addChange,
  deleteChange,
  recordInitialRate,
  refreshAllCaches,
};
