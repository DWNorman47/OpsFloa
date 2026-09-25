// Pay-period lock enforcement — ONE helper for every write path that changes paid
// time for a date (worker manual entries, clock-out/switch/mark-day, admin edits,
// approvals, rejections, unapprove/unlock, …).
//
// A locked pay period is a `pay_periods` row (company-wide; the row's existence IS
// the lock — deleting it unlocks). Any date inside [period_start, period_end] is
// frozen: its paid time must not change until an admin with manage_pay_periods
// unlocks the period.
//
// Usage in a route:
//   try { await assertNotLocked(pool, companyId, userId, [workDate]); }
//   catch (e) { if (sendIfPeriodLocked(res, e)) return; throw e; }
// or the non-throwing form:
//   const periods = await lockedPeriodsCovering(pool, companyId, [d1, d2]);
//   if (periods.length) return res.status(409).json(periodLockedBody(periods));
//
// For a single UPDATE that must not race a concurrent lock (approve), put
// notInLockedPeriodSql('te') inside the UPDATE's WHERE so the check and the write
// happen in the same statement.

const PERIOD_LOCKED = 'period_locked';

/** 'YYYY-MM-DD' for a pg DATE (parsed as LOCAL midnight), a Date, or a date string. */
function toYmd(d) {
  if (d == null || d === '') return null;
  if (d instanceof Date) {
    if (isNaN(d)) return null;
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const s = String(d);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

function ymdOut(v) { return toYmd(v) || v; }

/**
 * Locked pay periods covering any of `dates`. One query. Returns
 * [{ id, period_start, period_end, label }] with dates as 'YYYY-MM-DD'.
 */
async function lockedPeriodsCovering(db, companyId, dates) {
  const list = [...new Set((dates || []).map(toYmd).filter(Boolean))];
  if (!companyId || list.length === 0) return [];
  const r = await db.query(
    `SELECT pp.id, pp.period_start, pp.period_end, pp.label
       FROM pay_periods pp
      WHERE pp.company_id = $1
        AND EXISTS (SELECT 1 FROM unnest($2::date[]) AS d(day)
                     WHERE d.day BETWEEN pp.period_start AND pp.period_end)
      ORDER BY pp.period_start`,
    [companyId, list]
  );
  return (r.rows || []).map(p => ({
    id: p.id, period_start: ymdOut(p.period_start), period_end: ymdOut(p.period_end), label: p.label ?? null,
  }));
}

/** The 409 body for a write into a locked pay period. */
function periodLockedBody(periods) {
  const n = periods.length;
  const span = n === 1 ? ` (${periods[0].period_start} – ${periods[0].period_end})` : '';
  return {
    error: `This date is in a locked pay period${span}. An admin must unlock the pay period first.`,
    code: PERIOD_LOCKED,
    periods,
  };
}

class PeriodLockedError extends Error {
  constructor(periods) {
    super('period_locked');
    this.name = 'PeriodLockedError';
    this.status = 409;
    this.periods = periods;
    this.body = periodLockedBody(periods);
  }
}

/**
 * Throw PeriodLockedError (status 409, body {code:'period_locked', periods}) if a
 * locked pay period covers any of `dates`. `userId` is accepted for call-site
 * clarity / future per-worker locks; pay_periods are company-wide today.
 */
// eslint-disable-next-line no-unused-vars
async function assertNotLocked(db, companyId, userId, dates) {
  const periods = await lockedPeriodsCovering(db, companyId, dates);
  if (periods.length) throw new PeriodLockedError(periods);
}

/** If `err` is a PeriodLockedError, send the 409 and return true. */
function sendIfPeriodLocked(res, err) {
  if (err && err instanceof PeriodLockedError) {
    res.status(409).json(err.body);
    return true;
  }
  return false;
}

/**
 * SQL predicate (no params) — true when the time_entries row aliased `alias`
 * is NOT inside a locked pay period of its own company. Embed in an UPDATE's
 * WHERE so a period locked concurrently can't slip an approval through.
 */
function notInLockedPeriodSql(alias = 'time_entries') {
  return `NOT EXISTS (SELECT 1 FROM pay_periods pp_lock
                       WHERE pp_lock.company_id = ${alias}.company_id
                         AND ${alias}.work_date BETWEEN pp_lock.period_start AND pp_lock.period_end)`;
}

/** SQL expression → boolean: the row is inside a locked pay period (for list flags). */
function inLockedPeriodSql(alias = 'te') {
  return `EXISTS (SELECT 1 FROM pay_periods pp_lock
                   WHERE pp_lock.company_id = ${alias}.company_id
                     AND ${alias}.work_date BETWEEN pp_lock.period_start AND pp_lock.period_end)`;
}

module.exports = {
  PERIOD_LOCKED,
  toYmd,
  lockedPeriodsCovering,
  periodLockedBody,
  PeriodLockedError,
  assertNotLocked,
  sendIfPeriodLocked,
  notInLockedPeriodSql,
  inLockedPeriodSql,
};
