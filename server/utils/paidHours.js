const pool = require('../db');
const { ADMIN_SETTINGS_DEFAULTS, applySettingsRows } = require('../settingsDefaults');
const { roundEntriesFromSettings, otConfigFromSettings, sickRulesFromSettings, sickRulesByRoleFactory } = require('./hoursRules');
const { computeOT, otBandsCost, nightPremiumCost, shiftHoursByDate, computeLeaveHours } = require('./payCalculations');

/**
 * The ONE way to turn raw punches into paid hours and money.
 *
 * Why this exists: the hours-rules engine reached 4 of the 10 places that
 * convert hours into money. The others each grew their own version —
 * `qbo.js` and `scheduledReports.js` never called the engine at all;
 * WorkerMetrics rounded but hardcoded the `daily` rule and dropped the tiered
 * config; project spend was raw SQL that did flat hours × rate with no overtime
 * whatsoever. That was survivable only because no company had a policy enabled.
 * The moment one did, the invoice, the worker's screen and what landed in
 * QuickBooks would each report a different number for the same day — which is
 * worse than having no rules engine, because now it's an argument with a
 * customer about which screen is right.
 *
 * So: every path calls this. If a step belongs in the pay pipeline, it belongs
 * here, once.
 */

/** The three numbers the pipeline reads off company settings, coerced safely. */
function payNumbers(settings) {
  const s = settings || {};
  return {
    threshold: parseFloat(s.overtime_threshold) || 8,
    weekStart: parseInt(s.week_start ?? 1, 10),
    multiplier: parseFloat(s.overtime_multiplier) || 1.5,
  };
}

/**
 * The overtime rule to ACTUALLY apply for a worker. When a company turns off
 * "Allow overtime" (feature_overtime = false) no overtime accrues anywhere — the
 * same as a per-worker rule of 'none', which the engine already supports. Every
 * pay/labor-cost surface resolves the rule through here instead of reading
 * `overtime_rule` directly, so the toggle can't be honored on one surface and
 * ignored on another. Absent/true flag → the worker's rule (default 'daily').
 */
function otRuleFromSettings(settings, workerRule) {
  const off = settings && (settings.feature_overtime === false || settings.feature_overtime === '0' || settings.feature_overtime === 0);
  return off ? 'none' : (workerRule || 'daily');
}

/**
 * Load a company's settings. Was a private helper inside admin.js, so every
 * other route re-queried the settings table by hand — which is how two of them
 * ended up never reading `hours_rules`.
 */
async function loadSettings(companyId) {
  const r = await pool.query('SELECT key, value FROM settings WHERE company_id = $1', [companyId]);
  return applySettingsRows(r.rows, ADMIN_SETTINGS_DEFAULTS);
}

/**
 * Raw entries → paid entries + the regular/overtime split.
 *
 * @param entries  rows with {start_time,end_time,work_date,wage_type,break_minutes,...}
 * @param settings company settings (must include hours_rules to honour a policy)
 * @param opts     { rule: 'daily'|'weekly'|'none', ctx: {shiftMap, workerStandardById}, roleId }
 * @returns {{paid, regularHours, overtimeHours, otBands, otConfig}}
 *
 * `roleId` is this worker's `users.role_id`; when the policy carries role rules it
 * selects both the effective rule list (via the rounding engine) and the OT config.
 * Null/absent → the standard rules, identical to the company-wide behaviour.
 */
function computePaid(entries, settings, { rule = 'daily', ctx = {}, roleId = null, range = null } = {}) {
  // These entries are one worker's. When a role is supplied, tell the rounding
  // engine which role applies (workerRoleById) and select that role's OT config.
  let effCtx = ctx;
  if (roleId != null) {
    const workerRoleById = { ...(ctx.workerRoleById || {}) };
    for (const e of entries || []) {
      if (e && e.user_id != null && workerRoleById[e.user_id] === undefined) {
        workerRoleById[e.user_id] = roleId;
      }
    }
    effCtx = { ...ctx, workerRoleById };
  }
  const paid = roundEntriesFromSettings(entries || [], settings, effCtx);
  const otConfig = otConfigFromSettings(settings, roleId);
  const { threshold, weekStart } = payNumbers(settings);
  // `range` (the pay period being computed) enables the min_daily "no clock-in"
  // guarantee to fill empty days; absent → today's entry-only behaviour.
  const { regularHours, overtimeHours, otBands } = computeOT(paid, rule, threshold, weekStart, otConfig, range);
  return { paid, regularHours, overtimeHours, otBands, otConfig };
}

/**
 * Labor cost in cents for a set of entries.
 *
 * Groups by worker first, because overtime is a per-worker concept: the rule
 * (`users.overtime_rule`) and the rate are both the worker's, and a bucket
 * mixing two people's hours would invent overtime neither of them worked.
 * Each row must carry `user_id`, `rate`, and `ot_rule` (join them in the query).
 */
function laborCostCents(entries, settings) {
  const { multiplier } = payNumbers(settings);
  const byWorker = new Map();
  for (const e of entries || []) {
    const k = e.user_id ?? 'unknown';
    if (!byWorker.has(k)) byWorker.set(k, []);
    byWorker.get(k).push(e);
  }

  let dollars = 0;
  for (const rows of byWorker.values()) {
    const rate = parseFloat(rows[0].rate) || 0;
    if (!rate) continue;
    const rule = otRuleFromSettings(settings, rows[0].ot_rule);
    const { paid, regularHours, otBands, otConfig } = computePaid(rows, settings, { rule, roleId: rows[0].role_id ?? null });
    dollars += regularHours * rate;
    dollars += otBandsCost(otBands, rate, multiplier);
    if (otConfig && otConfig.nightDifferential) {
      dollars += nightPremiumCost(paid, otConfig.nightDifferential, rate);
    }
  }
  return Math.round(dollars * 100);
}

// The columns laborCostCents needs. Shared so a caller can't half-remember it —
// the ot_rule alias in particular is easy to leave out, and its absence silently
// defaults everyone to 'daily'.
//
// The CASE is not optional: start_time/end_time are bare TIME, so an overnight
// shift has end < start. The two SQL labor paths this replaced omitted it and
// wrapped the result in GREATEST(0, …), which turned every overnight shift into
// a negative interval clamped to zero — overnight labor cost $0.
const LABOR_ENTRY_COLUMNS = `
  te.user_id, to_char(te.work_date, 'YYYY-MM-DD') AS work_date, te.start_time, te.end_time, te.break_minutes,
  te.wage_type, te.overtime_hours_override,
  COALESCE(u.hourly_rate, 0) AS rate,
  COALESCE(u.overtime_rule, 'daily') AS ot_rule,
  u.role_id AS role_id`;

/**
 * Paid-leave pay multipliers from settings: sick and vacation each as a fraction
 * of the worker's base rate (100% → 1). Undefined/garbage → 1, so the cost is
 * unchanged for companies that never touch these. Apply as
 * `leaveHours * rate * mult`. Negative percents are clamped to 0 (never a credit).
 */
function leaveRateMultipliers(settings) {
  const s = settings || {};
  const frac = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n / 100 : 1; };
  return { sick: frac(s.sick_pay_pct), vacation: frac(s.vacation_pay_pct) };
}

/**
 * Paid { sick, vacation } hours for ONE worker over [from,to] — approved
 * sick/vacation time-off valued schedule-first (shift hours → weekday leave rule
 * → Regular Shift default), with partial requests paid their logged `hours`.
 * The single-worker path (worker invoice, a worker's own pay stubs).
 */
async function computeWorkerLeave({ companyId, userId, roleId, settings, from, to, withDetail = false }) {
  if (!from || !to) return withDetail ? { sick: 0, vacation: 0, detail: [] } : { sick: 0, vacation: 0 };
  const leaveRules = sickRulesFromSettings(settings, roleId);
  const [reqs, shifts] = await Promise.all([
    pool.query(
      `SELECT type, hours, start_date, end_date FROM time_off_requests
       WHERE user_id = $1 AND company_id = $2 AND type IN ('sick','vacation') AND status = 'approved'
         AND start_date <= $4::date AND end_date >= $3::date`,
      [userId, companyId, from, to]
    ),
    pool.query(
      `SELECT shift_date, start_time, end_time FROM shifts
       WHERE user_id = $1 AND company_id = $2 AND shift_date >= $3::date AND shift_date <= $4::date`,
      [userId, companyId, from, to]
    ),
  ]);
  // withDetail (the report's explain view) also returns the per-day valuation
  // breakdown — how each leave day got its hours (schedule / rule / default / partial).
  const detail = withDetail ? [] : null;
  const totals = computeLeaveHours(reqs.rows, shiftHoursByDate(shifts.rows), leaveRules, settings.regular_shift_hours, from, to, detail);
  return withDetail ? { ...totals, detail } : totals;
}

/**
 * Paid { sick, vacation } hours for a whole company's workers over [from,to] in
 * one pair of queries (payroll data + exports). Returns Map(userId → {sick,
 * vacation}); leave rules are resolved per worker's role.
 */
async function computeCompanyLeave({ companyId, workers, settings, from, to }) {
  const byUser = new Map();
  if (!from || !to) return byUser;
  const leaveByRole = sickRulesByRoleFactory(settings);
  const [reqs, shifts] = await Promise.all([
    pool.query(
      `SELECT user_id, type, hours, start_date, end_date FROM time_off_requests
       WHERE company_id = $1 AND type IN ('sick','vacation') AND status = 'approved'
         AND start_date <= $3::date AND end_date >= $2::date`,
      [companyId, from, to]
    ),
    pool.query(
      `SELECT user_id, shift_date, start_time, end_time FROM shifts
       WHERE company_id = $1 AND shift_date >= $2::date AND shift_date <= $3::date`,
      [companyId, from, to]
    ),
  ]);
  const reqByUser = new Map(), shiftByUser = new Map();
  for (const r of reqs.rows) { if (!reqByUser.has(r.user_id)) reqByUser.set(r.user_id, []); reqByUser.get(r.user_id).push(r); }
  for (const s of shifts.rows) { if (!shiftByUser.has(s.user_id)) shiftByUser.set(s.user_id, []); shiftByUser.get(s.user_id).push(s); }
  for (const w of workers || []) {
    byUser.set(w.id, computeLeaveHours(
      reqByUser.get(w.id) || [], shiftHoursByDate(shiftByUser.get(w.id) || []),
      leaveByRole(w.role_id), settings.regular_shift_hours, from, to
    ));
  }
  return byUser;
}

module.exports = {
  loadSettings,
  payNumbers,
  otRuleFromSettings,
  computePaid,
  laborCostCents,
  computeWorkerLeave,
  computeCompanyLeave,
  leaveRateMultipliers,
  LABOR_ENTRY_COLUMNS,
};
