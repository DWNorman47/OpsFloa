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

/** Day of week (0=Sun … 6=Sat) for a YYYY-MM-DD key, timezone-independent. */
function weekdayOfDate(dk) {
  const m = String(dk).substring(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
}

/** Minutes since midnight from an "HH:MM[:SS]" string (null-safe). */
function hmToMin(hhmm) {
  if (hhmm == null) return null;
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

/**
 * Hours of one entry that fall inside a nightly window [fromHour, toHour),
 * which may wrap midnight (e.g. 19→5). Gross overlap of the shift interval with
 * the recurring window; break minutes are not subtracted (the window's timing
 * relative to a break is unknown). Used for a night-shift differential.
 */
function nightHoursForEntry(e, fromHour, toHour) {
  const s = hmToMin(e.start_time);
  let en = hmToMin(e.end_time);
  if (s == null || en == null) return 0;
  if (en < s) en += 1440; // overnight shift
  const nf = fromHour * 60, nt = toHour * 60;
  let overlap = 0;
  for (let off = -1; off <= 1; off++) {
    const a = nf + off * 1440;
    const b = (nf < nt ? nt : nt + 1440) + off * 1440;
    overlap += Math.max(0, Math.min(en, b) - Math.max(s, a));
  }
  return overlap / 60;
}

/**
 * Additive night-shift differential cost for a batch of entries: night hours ×
 * base rate × (pct/100). Returns 0 when no night config is supplied.
 */
function nightPremiumCost(entries, nightCfg, baseRate) {
  if (!nightCfg) return 0;
  const pct = parseFloat(nightCfg.pct) || 0;
  if (!pct) return 0;
  const from = parseFloat(nightCfg.fromHour), to = parseFloat(nightCfg.toHour);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return entries.reduce((c, e) => c + nightHoursForEntry(e, from, to) * baseRate * (pct / 100), 0);
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

  // 7th-consecutive-day premium (daily rule only): when a worker worked all 7
  // days of a workweek, that week's chronologically-last worked day is paid
  // entirely as overtime — the first N hours at one multiplier, the rest at a
  // higher one (e.g. California: first 8h @1.5×, beyond @2×). No regular hours
  // accrue on that day.
  const sd = (otConfig && otConfig.seventhDay && otConfig.seventhDay.enabled && rule === 'daily')
    ? otConfig.seventhDay : null;
  // Rest-day premium (daily rule): any hours worked on a designated rest day are
  // paid entirely at a premium multiplier. Minimum-daily-hours: a short day is
  // guaranteed a floor of paid regular hours ("reporting time pay").
  const restDay  = (otConfig && otConfig.restDay && rule === 'daily') ? otConfig.restDay : null;
  const restDays = restDay ? new Set((restDay.days || []).map(Number)) : null;
  const minDaily = (otConfig && rule === 'daily') ? (parseFloat(otConfig.minDailyHours) || 0) : 0;
  let seventhFirst = 0, seventhRest = 0, restDayHours = 0;

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

    // Identify each week's 7th-day key: group worked days by workweek; a week
    // with all 7 days worked contributes its latest day.
    const seventhKeys = new Set();
    if (sd) {
      const byWeek = {};
      Object.keys(buckets).forEach(dk => {
        const wk = weekBucketKey(dk, weekStart);
        (byWeek[wk] = byWeek[wk] || []).push(dk);
      });
      Object.values(byWeek).forEach(daysArr => {
        if (daysArr.length >= 7) seventhKeys.add(daysArr.slice().sort().pop());
      });
    }
    const firstT = sd ? (parseFloat(sd.firstHoursThreshold) || 0) : 0;

    Object.entries(buckets).forEach(([dk, h]) => {
      if (restDays && restDays.has(weekdayOfDate(dk))) {
        restDayHours += h;                       // whole rest day at the premium
      } else if (sd && seventhKeys.has(dk)) {
        seventhFirst += Math.min(h, firstT);
        seventhRest  += Math.max(0, h - firstT);
      } else if (minDaily > 0 && h < minDaily) {
        autoReg += minDaily;                      // short day topped up to the floor
      } else {
        autoReg += Math.min(h, bands[0].afterHours);
        bands.forEach((b, i) => {
          const upper = i + 1 < bands.length ? bands[i + 1].afterHours : Infinity;
          bandTotals[i] += Math.max(0, Math.min(h, upper) - b.afterHours);
        });
      }
    });
  }

  const otBands = bands
    .map((b, i) => ({ hours: bandTotals[i], mult: b.mult }))
    .filter(b => b.hours > 0);
  if (restDay && restDayHours > 0) otBands.push({ hours: restDayHours, mult: parseFloat(restDay.mult) || 2 });
  if (sd && seventhFirst > 0) otBands.push({ hours: seventhFirst, mult: parseFloat(sd.firstMult) || 1.5 });
  if (sd && seventhRest > 0)  otBands.push({ hours: seventhRest,  mult: parseFloat(sd.afterMult)  || 2 });
  if (overrideOt > 0) otBands.push({ hours: overrideOt, mult: null });

  const overtimeHours = bandTotals.reduce((s, h) => s + h, 0) + restDayHours + seventhFirst + seventhRest + overrideOt;

  return {
    regularHours:  overrideReg + autoReg,
    overtimeHours,
    otBands,
  };
}

/**
 * Per-entry overtime allocation for report line items. Sets `overtime_hours` on
 * each entry (the OT portion; the rest of the entry is regular) and returns the
 * entries. Mirrors computeOT's day/week bucketing exactly, so the sum of the
 * per-entry OT equals computeOT(...).overtimeHours for the same inputs — a
 * report's line-item OT column always reconciles with its summary total.
 *
 * Within a bucket, regular hours are filled chronologically (earliest entries
 * first) up to the OT boundary; the remainder is overtime — the standard "hours
 * after the threshold are the overtime" reading. Non-'regular' wage types, and
 * short days topped up by a minimum-daily floor, get 0.
 */
function annotateEntryOvertime(entries, rule, threshold, weekStart = 1, otConfig = null) {
  for (const e of entries) e.overtime_hours = 0; // default for prevailing / non-regular
  const regular = entries.filter(e => e.wage_type === 'regular');

  // Per-entry admin override: OT = clamped override, carved out of the auto calc.
  const auto = [];
  for (const e of regular) {
    if (e.overtime_hours_override != null) {
      const total = entryDuration(e);
      e.overtime_hours = Math.max(0, Math.min(total, parseFloat(e.overtime_hours_override)));
    } else {
      auto.push(e);
    }
  }
  if (rule === 'none' || !auto.length) return entries;

  const bands = resolveBands(rule, threshold, otConfig);
  const boundary = bands[0].afterHours; // regular/OT split point (tiers only re-price above it)

  const sd = (otConfig && otConfig.seventhDay && otConfig.seventhDay.enabled && rule === 'daily') ? otConfig.seventhDay : null;
  const restDay = (otConfig && otConfig.restDay && rule === 'daily') ? otConfig.restDay : null;
  const restDays = restDay ? new Set((restDay.days || []).map(Number)) : null;
  const minDaily = (otConfig && rule === 'daily') ? (parseFloat(otConfig.minDailyHours) || 0) : 0;

  // bucket by day (daily) or workweek (weekly); entries stay in chronological order
  const buckets = new Map();
  for (const e of auto) {
    const key = rule === 'weekly' ? weekBucketKey(e.work_date, weekStart) : String(e.work_date).substring(0, 10);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(e);
  }

  // a workweek with all 7 days worked pays its last day entirely as OT
  const seventhKeys = new Set();
  if (sd) {
    const byWeek = {};
    for (const dk of buckets.keys()) { const wk = weekBucketKey(dk, weekStart); (byWeek[wk] = byWeek[wk] || []).push(dk); }
    Object.values(byWeek).forEach(days => { if (days.length >= 7) seventhKeys.add(days.slice().sort().pop()); });
  }

  for (const [dk, es] of buckets) {
    const total = es.reduce((s, e) => s + entryDuration(e), 0);
    if ((restDays && restDays.has(weekdayOfDate(dk))) || (sd && seventhKeys.has(dk))) {
      for (const e of es) e.overtime_hours = entryDuration(e); // whole day is OT
      continue;
    }
    if (minDaily > 0 && total < minDaily) continue; // short day topped up to floor → all regular
    let regLeft = boundary;
    for (const e of es) {
      const d = entryDuration(e);
      const r = Math.max(0, Math.min(d, regLeft));
      e.overtime_hours = d - r;
      regLeft -= r;
    }
  }
  return entries;
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

module.exports = { hoursWorked, computeOT, annotateEntryOvertime, computeDailyPayCosts, otBandsCost, resolveBands, nightHoursForEntry, nightPremiumCost };
