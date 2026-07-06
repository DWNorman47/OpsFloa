/**
 * Core pay calculation utilities shared by admin and timeEntries routes.
 * Exported so they can be unit-tested without touching the database.
 */

const { weekBucketKey } = require('./weekBounds');

/** Decimal hours between two HH:MM[:SS] strings. Handles midnight-crossing shifts. */
function hoursWorked(start, end) {
  let ms = new Date(`1970-01-01T${end}`) - new Date(`1970-01-01T${start}`);
  if (ms < 0) ms += 86400000;
  return ms / 3600000;
}

function entryDuration(e) {
  return hoursWorked(e.start_time, e.end_time) - (e.break_minutes || 0) / 60;
}

/**
 * Resolve the overtime *bands* for a bucket (day or week). A band is
 * `{ afterHours, mult }`: hours in the bucket above `afterHours` (and below the
 * next band's `afterHours`) are overtime paid at `mult`× the base rate.
 *
 * Single-tier (today's behavior) is just one band `{ afterHours: threshold,
 * mult: null }` — a null mult means "use the caller's default overtime
 * multiplier", so pricing is identical to the pre-tiered code.
 *
 * Tiered config comes from the hours-rules policy: `otConfig.dailyBands` /
 * `otConfig.weeklyBands`, e.g. `[{afterHours:8,mult:1.5},{afterHours:12,mult:2}]`.
 * The first band's `afterHours` is the regular/OT boundary.
 */
function resolveBands(rule, threshold, otConfig) {
  const list = otConfig ? (rule === 'weekly' ? otConfig.weeklyBands : otConfig.dailyBands) : null;
  if (Array.isArray(list) && list.length) {
    const bands = list
      .map(b => ({ afterHours: parseFloat(b.afterHours), mult: parseFloat(b.mult) }))
      .filter(b => Number.isFinite(b.afterHours) && b.afterHours >= 0 && Number.isFinite(b.mult) && b.mult > 0)
      .sort((a, b) => a.afterHours - b.afterHours);
    if (bands.length) return bands;
  }
  return [{ afterHours: threshold, mult: null }];
}

/**
 * Split an array of time entries into regularHours and overtimeHours, plus a
 * per-tier `otBands` breakdown for cost.
 *
 * Only entries with wage_type === 'regular' count toward OT.
 *
 * Per-entry admin override: if `entry.overtime_hours_override` is not null,
 * that entry is carved out of the automatic daily/weekly calc. The override
 * value is taken as the OT portion (clamped to 0..total), and the remainder
 * of the entry becomes regular. Overridden OT is priced at the default
 * multiplier (mult: null) — the override is an explicit manual escape hatch,
 * so it doesn't get sliced into tiers.
 *
 * @param {Array}  entries   - rows with {wage_type, start_time, end_time, work_date, break_minutes, overtime_hours_override?}
 * @param {string} rule      - 'daily' | 'weekly' | 'none'
 * @param {number} threshold - hours before OT kicks in (e.g. 8 for daily, 40 for weekly)
 * @param {number} [weekStart=1] - 0=Sun … 6=Sat (only affects the 'weekly' rule)
 * @param {object} [otConfig=null] - tiered-OT config {dailyBands, weeklyBands}; null = single tier
 * @returns {{regularHours:number, overtimeHours:number, otBands:Array<{hours:number,mult:number|null}>}}
 */
function computeOT(entries, rule, threshold, weekStart = 1, otConfig = null) {
  const regular = entries.filter(e => e.wage_type === 'regular');

  // Partition entries with an explicit override out of the automatic calc.
  const overridden = regular.filter(e => e.overtime_hours_override != null);
  const auto       = regular.filter(e => e.overtime_hours_override == null);

  let overrideReg = 0, overrideOt = 0;
  for (const e of overridden) {
    const total = entryDuration(e);
    const ot = Math.max(0, Math.min(total, parseFloat(e.overtime_hours_override)));
    overrideReg += total - ot;
    overrideOt  += ot;
  }

  const bands = resolveBands(rule, threshold, otConfig);
  const bandTotals = bands.map(() => 0);
  let autoReg = 0;

  if (rule === 'none') {
    autoReg = auto.reduce((s, e) => s + entryDuration(e), 0);
  } else {
    const buckets = {};
    auto.forEach(e => {
      const key = rule === 'weekly'
        ? weekBucketKey(e.work_date, weekStart)
        : e.work_date.toString().substring(0, 10);
      buckets[key] = (buckets[key] || 0) + entryDuration(e);
    });
    Object.values(buckets).forEach(h => {
      autoReg += Math.min(h, bands[0].afterHours);
      bands.forEach((b, i) => {
        const upper = i + 1 < bands.length ? bands[i + 1].afterHours : Infinity;
        bandTotals[i] += Math.max(0, Math.min(h, upper) - b.afterHours);
      });
    });
  }

  const otBands = bands
    .map((b, i) => ({ hours: bandTotals[i], mult: b.mult }))
    .filter(b => b.hours > 0);
  if (overrideOt > 0) otBands.push({ hours: overrideOt, mult: null });

  const overtimeHours = bandTotals.reduce((s, h) => s + h, 0) + overrideOt;

  return {
    regularHours:  overrideReg + autoReg,
    overtimeHours,
    otBands,
  };
}

/**
 * Cost of the overtime portion given an `otBands` breakdown and a base hourly
 * rate. Each band is priced at its own multiplier, falling back to
 * `defaultMult` for single-tier / override bands (mult: null).
 */
function otBandsCost(otBands, baseRate, defaultMult) {
  return (otBands || []).reduce((c, b) => c + b.hours * baseRate * (b.mult != null ? b.mult : defaultMult), 0);
}

/**
 * Compute regular and overtime pay costs for a daily-rate worker.
 * Daily workers earn `dailyRate` per distinct work day.
 * Overtime hours (above threshold) are paid at (dailyRate / threshold) × multiplier,
 * per tier when a tiered `otConfig` is supplied.
 * @param {Array}  entries          - all entries for one worker
 * @param {string} overtimeRule     - 'daily' | 'weekly' | 'none'
 * @param {number} threshold        - OT threshold in hours
 * @param {number} dailyRate        - amount earned per full day
 * @param {number} overtimeMultiplier
 * @param {object} [otConfig=null]  - tiered-OT config; null = single tier
 * @returns {{ regularCost: number, overtimeCost: number }}
 */
function computeDailyPayCosts(entries, overtimeRule, threshold, dailyRate, overtimeMultiplier, otConfig = null) {
  const regular = entries.filter(e => e.wage_type === 'regular');
  const days = new Set(regular.map(e => e.work_date.toString().substring(0, 10))).size;
  if (overtimeRule === 'none') {
    return { regularCost: days * dailyRate, overtimeCost: 0 };
  }
  const { otBands } = computeOT(entries, overtimeRule, threshold, 1, otConfig);
  return {
    regularCost: days * dailyRate,
    overtimeCost: otBandsCost(otBands, dailyRate / threshold, overtimeMultiplier),
  };
}

module.exports = { hoursWorked, computeOT, computeDailyPayCosts, otBandsCost, resolveBands };
