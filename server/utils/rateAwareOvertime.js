const { hoursWorked, annotateEntryOvertime } = require('./payCalculations');
const { DEFAULT_OVERTIME_RATE_METHOD } = require('../constants/payEnums');

/**
 * Rate-aware overtime pay for ONE worker's already-rounded entries, where hours
 * may be earned at different base rates in the same period — prevailing on one
 * job, civilian on the next, per-project prevailing rates. The existing engine
 * treats prevailing and regular as separate flat streams, so multi-rate hours
 * never earn overtime; this prices them correctly.
 *
 * Two methods (per-company setting `overtime_rate_method`):
 *   - 'rate_when_worked' (default): each OT hour is paid at the rate it earned.
 *     The hours that cross the threshold are OT (chronologically the later ones),
 *     at their own rate × the multiplier. Order-dependent; generalizes worldwide.
 *   - 'weighted_average': FLSA blended regular rate — total straight pay ÷ total
 *     hours, OT premium on that blend. Order-independent.
 *
 * SCOPE (v1): plain single-multiplier daily/weekly OT (and rule 'none'). Tiered
 * OT, rest-day, 7th-day and time-window premiums are NOT yet priced per-rate here
 * — they need per-entry, per-band attribution. The caller must route only
 * single-multiplier configs through this path (see hasSimpleOtConfig). All hours
 * still count toward ONE threshold regardless of wage_type — that's the fix.
 *
 * Pure: mutates nothing the caller owns (entries are cloned before annotation).
 *
 * @param {Array}  entries            rounded rows {start_time,end_time,break_minutes,work_date,wage_type,project_id,overtime_hours_override?}
 * @param {object} opts
 * @param {string} opts.rule          'daily' | 'weekly' | 'none'
 * @param {number} opts.threshold     OT threshold in hours
 * @param {number} [opts.weekStart=1] week start (0=Sun..6=Sat) for the weekly rule
 * @param {number} opts.otMult        the single OT multiplier (e.g. 1.5)
 * @param {function(object):number} opts.baseRateOf  entry → its hourly base rate
 * @param {string} [opts.method]      'rate_when_worked' | 'weighted_average'
 * @returns {{ straightHours:number, overtimeHours:number, cost:number, perEntry:Array }}
 */
function rateAwarePay(entries, { rule, threshold, weekStart = 1, otMult, baseRateOf, method = DEFAULT_OVERTIME_RATE_METHOD }) {
  const worked = (entries || []).filter(e => e.start_time && e.end_time);
  const dur = e => Math.max(0, hoursWorked(e.start_time, e.end_time) - (e.break_minutes || 0) / 60);

  // Treat every worked hour as ONE stream toward the threshold: clone with a
  // uniform wage_type so annotateEntryOvertime buckets + fills across ALL hours,
  // not just the 'regular' ones. otConfig is null (plain single-multiplier) — the
  // premium features are out of scope for v1 (see SCOPE). Clone so we never
  // mutate the caller's rows or their real wage_type.
  const clones = worked.map(e => ({
    start_time: e.start_time, end_time: e.end_time, break_minutes: e.break_minutes,
    work_date: e.work_date, wage_type: 'regular',
    overtime_hours_override: e.overtime_hours_override ?? null,
  }));
  annotateEntryOvertime(clones, rule, threshold, weekStart, null);

  let straightHours = 0, overtimeHours = 0;
  const perEntry = worked.map((e, i) => {
    const total = dur(e);
    const ot = Math.min(total, clones[i].overtime_hours || 0);
    const st = total - ot;
    straightHours += st;
    overtimeHours += ot;
    return { st, ot, baseRate: baseRateOf(e) };
  });

  let cost;
  if (method === 'weighted_average') {
    // Straight-time pay for every hour at its own rate, then a single blended
    // premium on the OT hours: premium = otHours × (Σ straight pay / Σ hours) ×
    // (mult − 1). Order-independent.
    const totalStraightPay = perEntry.reduce((s, p) => s + (p.st + p.ot) * p.baseRate, 0);
    const totalHours = straightHours + overtimeHours;
    const regularRate = totalHours > 0 ? totalStraightPay / totalHours : 0;
    cost = totalStraightPay + overtimeHours * regularRate * (otMult - 1);
  } else {
    // Each hour at its own rate; OT hours additionally × mult.
    cost = perEntry.reduce((s, p) => s + p.st * p.baseRate + p.ot * p.baseRate * otMult, 0);
  }

  return { straightHours, overtimeHours, cost, perEntry };
}

/**
 * True when an otConfig is plain single-multiplier OT that rateAwarePay can price
 * correctly today. Tiers, rest-day, 7th-day and window premiums return false —
 * the caller keeps those on the existing (single-rate) engine path until the
 * per-band attribution lands.
 */
function hasSimpleOtConfig(otConfig) {
  if (!otConfig) return true;
  if (Array.isArray(otConfig.tiers) && otConfig.tiers.length) return false;
  if (otConfig.restDay || otConfig.seventhDay || otConfig.minDailyHours) return false;
  if (Array.isArray(otConfig.windowRules) && otConfig.windowRules.length) return false;
  if (otConfig.nightDifferential) return false;
  return true;
}

module.exports = { rateAwarePay, hasSimpleOtConfig };
