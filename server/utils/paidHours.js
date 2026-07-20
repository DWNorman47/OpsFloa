const pool = require('../db');
const { ADMIN_SETTINGS_DEFAULTS, applySettingsRows } = require('../settingsDefaults');
const { roundEntriesFromSettings, otConfigFromSettings } = require('./hoursRules');
const { computeOT, otBandsCost, nightPremiumCost } = require('./payCalculations');

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
 * @param opts     { rule: 'daily'|'weekly'|'none', ctx: {shiftMap, workerStandardById} }
 * @returns {{paid, regularHours, overtimeHours, otBands, otConfig}}
 */
function computePaid(entries, settings, { rule = 'daily', ctx = {} } = {}) {
  const paid = roundEntriesFromSettings(entries || [], settings, ctx);
  const otConfig = otConfigFromSettings(settings);
  const { threshold, weekStart } = payNumbers(settings);
  const { regularHours, overtimeHours, otBands } = computeOT(paid, rule, threshold, weekStart, otConfig);
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
    const rule = rows[0].ot_rule || 'daily';
    const { paid, regularHours, otBands, otConfig } = computePaid(rows, settings, { rule });
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
  te.user_id, te.work_date, te.start_time, te.end_time, te.break_minutes,
  te.wage_type, te.overtime_hours_override,
  COALESCE(u.hourly_rate, 0) AS rate,
  COALESCE(u.overtime_rule, 'daily') AS ot_rule`;

module.exports = {
  loadSettings,
  payNumbers,
  computePaid,
  laborCostCents,
  LABOR_ENTRY_COLUMNS,
};
