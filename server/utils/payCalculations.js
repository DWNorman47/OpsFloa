/**
 * Core pay calculation utilities shared by admin and timeEntries routes.
 * Exported so they can be unit-tested without touching the database.
 */

const { weekBucketKey } = require('./weekBounds');
// One-way dependency (hoursRules has no requires, so no cycle): ot_tier rules are
// `when`-scoped, so a bucket's bands can depend on its date.
const { ruleMatchesDate } = require('./hoursRules');

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

/** YYYY-MM-DD keys from `from` to `to` inclusive (UTC, TZ-independent). Bounded
 *  so a stray range can't loop unbounded. */
function eachDateKey(from, to) {
  const out = [];
  const mf = String(from).substring(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const mt = String(to).substring(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!mf || !mt) return out;
  let d = Date.UTC(+mf[1], +mf[2] - 1, +mf[3]);
  const end = Date.UTC(+mt[1], +mt[2] - 1, +mt[3]);
  for (let i = 0; d <= end && i < 2000; i++, d += 86400000) {
    out.push(new Date(d).toISOString().substring(0, 10));
  }
  return out;
}

/** The 7 YYYY-MM-DD keys of the weekStart-aligned week that contains `dk`. */
function weekDaysOf(dk, weekStart) {
  const m = String(dk).substring(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return [];
  const base = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const wd = new Date(base).getUTCDay();               // 0=Sun … 6=Sat
  const back = (((wd - weekStart) % 7) + 7) % 7;        // days since the week's start
  const start = base - back * 86400000;
  const out = [];
  for (let i = 0; i < 7; i++) out.push(new Date(start + i * 86400000).toISOString().substring(0, 10));
  return out;
}
const isWeekdayKey = (dk) => { const w = weekdayOfDate(dk); return w >= 1 && w <= 5; };

/** Total scheduled hours per YYYY-MM-DD from a worker's shifts (sum of shift
 *  durations that day; shifts carry no break). */
function shiftHoursByDate(shifts) {
  const m = new Map();
  for (const sh of shifts || []) {
    if (!sh || sh.shift_date == null) continue;
    const dk = String(sh.shift_date).substring(0, 10);
    m.set(dk, (m.get(dk) || 0) + hoursWorked(sh.start_time, sh.end_time));
  }
  return m;
}

/**
 * Paid sick + vacation hours over a pay period, valued SCHEDULE-first. For each
 * APPROVED sick/vacation request:
 *   - `hours` set (a partial day) → pay exactly that many hours;
 *   - otherwise (a full day) each day is worth, in order: the worker's SCHEDULED
 *     shift hours that day → the weekday leave-value rule → the company Regular
 *     Shift default. Days are clipped to [from,to] and de-duped per type.
 * Returns { sick, vacation } totals; no requests / no range → { 0, 0 }.
 *
 * @param requests       [{ type:'sick'|'vacation', hours:number|null, start_date, end_date }]
 * @param shiftsByDate   Map(YYYY-MM-DD → scheduled hours) from shiftHoursByDate
 * @param leaveRules     the Time Off Value rules; each carries `applies`
 *                       ('sick' | 'vacation' | 'both') selecting which leave it values
 * @param regularShiftHours  company Regular Shift default (last-resort hours)
 */
function computeLeaveHours(requests, shiftsByDate, leaveRules, regularShiftHours, from, to) {
  const totals = { sick: 0, vacation: 0 };
  if (!from || !to) return totals;
  const f = String(from).substring(0, 10), t = String(to).substring(0, 10);
  const rules = Array.isArray(leaveRules) ? leaveRules : [];
  const def = parseFloat(regularShiftHours) || 0;
  const seen = { sick: new Set(), vacation: new Set() }; // full-day de-dup, per type
  const ruleAppliesTo = (r, type) => { const a = r.applies || 'both'; return a === 'both' || a === type; };
  const dayValue = (dk, type) => {
    const sched = (shiftsByDate && shiftsByDate.get(dk)) || 0;
    if (sched > 0) return sched;                          // 1) scheduled shift hours
    let best = 0;
    for (const r of rules) if (ruleAppliesTo(r, type) && ruleMatchesDate(r, dk)) best = Math.max(best, parseFloat(r.hours) || 0);
    return best > 0 ? best : def;                         // 2) Time Off Value rule → 3) Regular Shift default
  };
  for (const req of requests || []) {
    if (!req) continue;
    const type = req.type === 'vacation' ? 'vacation' : 'sick';
    if (req.hours != null && req.hours !== '') {           // partial → pay the logged hours
      totals[type] += parseFloat(req.hours) || 0;
      continue;
    }
    if (req.start_date == null || req.end_date == null) continue;
    const s = String(req.start_date).substring(0, 10), e = String(req.end_date).substring(0, 10);
    for (const dk of eachDateKey(s < f ? f : s, e > t ? t : e)) {
      if (seen[type].has(dk)) continue;                    // dedup overlapping requests
      seen[type].add(dk);
      totals[type] += dayValue(dk, type);
    }
  }
  return totals;
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

/** "YYYY-MM-DD" shifted by `k` days, timezone-independent. Null on a bad key. */
function shiftDateStr(dk, k) {
  const m = String(dk).substring(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().substring(0, 10);
}

/**
 * Paid hours of one entry that fall inside each time-window multiplier, as a
 * `Map(mult → hours)`. A `window_mult` rule defines a day-of-week + clock-time
 * window (via its `when` and minutes-since-midnight `from`/`to`, where `to <= from`
 * wraps past midnight — so a window can run Sat 19:00 → Sun 05:00). We test the
 * window's anchor day against the entry's work_date and its two neighbours
 * (`k ∈ {-1,0,1}`) so a window that started the previous day and wraps into this
 * one is still counted. Overlapping windows: the **highest** multiplier wins each
 * minute. The total is capped at the entry's PAID duration (gross − break),
 * filling the higher multipliers first, so a break can never inflate premium hours.
 *
 * These are GOVERNING multipliers (the covered hours are carved out of the normal
 * OT calc and priced entirely at `mult`), not an additive premium like night_diff.
 */
function windowHoursForEntry(e, windowRules) {
  if (!windowRules || !windowRules.length) return new Map();
  const s = hmToMin(e.start_time);
  let en = hmToMin(e.end_time);
  if (s == null || en == null) return new Map();
  if (en <= s) en += 1440;                       // overnight shift (end == start → 0-length)
  const d0 = String(e.work_date).substring(0, 10);

  // Collect covered [lo, hi, mult] segments in minutes-from-work_date-midnight.
  const segs = [];
  for (const r of windowRules) {
    const wf = Number(r.from);
    let wt = Number(r.to);
    if (!Number.isFinite(wf) || !Number.isFinite(wt)) continue;
    if (wt <= wf) wt += 1440;                     // wrap; from == to → +1440 (full 24h)
    const mult = parseFloat(r.mult);
    if (!(mult > 0)) continue;
    for (const k of [-1, 0, 1]) {
      const anchor = shiftDateStr(d0, k);
      if (anchor == null || !ruleMatchesDate(r, anchor)) continue;
      const lo = Math.max(s, k * 1440 + wf);
      const hi = Math.min(en, k * 1440 + wt);
      if (hi > lo) segs.push([lo, hi, mult]);
    }
  }
  if (!segs.length) return new Map();

  // Resolve overlaps: over each elementary interval between boundaries, the
  // highest covering multiplier wins. Sum gross minutes per multiplier.
  const bounds = [...new Set(segs.flatMap(([lo, hi]) => [lo, hi]))].sort((a, b) => a - b);
  const grossByMult = new Map();
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i], b = bounds[i + 1];
    let best = 0;
    for (const [lo, hi, m] of segs) if (lo <= a && hi >= b && m > best) best = m;
    if (best > 0) grossByMult.set(best, (grossByMult.get(best) || 0) + (b - a));
  }

  // Cap at paid minutes, assigning to the higher multipliers first.
  let pool = Math.max(0, (en - s) - (Number(e.break_minutes) || 0));
  const out = new Map();
  for (const m of [...grossByMult.keys()].sort((a, b) => b - a)) {
    if (pool <= 0) break;
    const take = Math.min(grossByMult.get(m), pool);
    if (take > 0) { out.set(m, take / 60); pool -= take; }
  }
  return out;
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
 * Bands for one bucket. If any `when`-scoped ot_tier rule matches this bucket
 * (a date, for the daily rule; any week-basis rule, for the weekly rule), those
 * rules define the tiers for the bucket; otherwise the fixed-slot config applies
 * (resolveBands). With no ot_tier rules this is exactly resolveBands, so
 * computeOT is unchanged for every existing policy.
 */
function bandsForBucket(rule, threshold, otConfig, dk) {
  const tiers = otConfig && Array.isArray(otConfig.tierRules) ? otConfig.tierRules : [];
  if (tiers.length) {
    const basis = rule === 'weekly' ? 'week' : 'day';
    const applic = tiers.filter(r => r.basis === basis && (rule === 'weekly' || ruleMatchesDate(r, dk)));
    const bands = applic
      .map(r => ({ afterHours: parseFloat(r.afterHours), mult: parseFloat(r.mult) }))
      .filter(b => Number.isFinite(b.afterHours) && b.afterHours >= 0 && Number.isFinite(b.mult) && b.mult > 0)
      .sort((a, b) => a.afterHours - b.afterHours);
    if (bands.length) return bands;
  }
  return resolveBands(rule, threshold, otConfig);
}

/**
 * Minimum-daily-hours floor for one day bucket: a matching `min_daily` rule wins
 * (largest, if several), else the fixed-slot global floor. Daily rule only. With
 * no min_daily rules this is just the global value, so behavior is unchanged.
 */
function minDailyForBucket(otConfig, rule, dk) {
  if (rule !== 'daily' || !otConfig) return 0;
  const rules = Array.isArray(otConfig.minDailyRules) ? otConfig.minDailyRules : [];
  const matched = rules.filter(r => ruleMatchesDate(r, dk)).map(r => parseFloat(r.hours) || 0);
  if (matched.length) return Math.max(...matched);
  return parseFloat(otConfig.minDailyHours) || 0;
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
function computeOT(entries, rule, threshold, weekStart = 1, otConfig = null, range = null) {
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

  // OT hours accumulate by multiplier — bands can vary per bucket (ot_tier rules),
  // so we can't index a fixed bandTotals array. For a uniform policy this yields
  // the same {hours, mult} entries as before.
  const otByMult = new Map();
  const addOt = (hours, mult) => { if (hours > 0) otByMult.set(mult, (otByMult.get(mult) || 0) + hours); };
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
  let seventhFirst = 0, seventhRest = 0, restDayHours = 0;

  // Time-window multipliers: hours inside a day-of-week + clock-time window are a
  // governing premium, carved out per entry BEFORE bucketing so they never feed
  // (or trip) the daily/weekly OT threshold — they're paid at the window's mult
  // regardless of the OT rule. `residualOf` is the entry's remaining paid hours;
  // with no window rules it is entryDuration, so everything below is unchanged.
  const windowRules = (otConfig && Array.isArray(otConfig.windowRules)) ? otConfig.windowRules : [];
  const windowByMult = new Map();
  let windowTotal = 0;
  const residualOf = new Map();
  for (const e of auto) {
    let residual = entryDuration(e);
    if (windowRules.length) {
      for (const [m, h] of windowHoursForEntry(e, windowRules)) {
        windowByMult.set(m, (windowByMult.get(m) || 0) + h);
        windowTotal += h;
        residual -= h;
      }
      residual = Math.max(0, residual); // carve-out must not push a residual negative
    }
    // No window rules → residual is entryDuration verbatim, preserving the
    // long-break negative-hours quirk that pins upstream data-integrity bugs.
    residualOf.set(e, residual);
  }

  if (rule === 'none') {
    autoReg = auto.reduce((s, e) => s + residualOf.get(e), 0);
  } else {
    const buckets = {};
    auto.forEach(e => {
      const key = rule === 'weekly'
        ? weekBucketKey(e.work_date, weekStart)
        : e.work_date.toString().substring(0, 10);
      buckets[key] = (buckets[key] || 0) + residualOf.get(e);
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
      } else {
        const minD = minDailyForBucket(otConfig, rule, dk);
        if (minD > 0 && h < minD) {
          autoReg += minD;                        // short day topped up to the floor
        } else {
          const bb = bandsForBucket(rule, threshold, otConfig, dk);
          autoReg += Math.min(h, bb[0].afterHours);
          bb.forEach((b, i) => {
            const upper = i + 1 < bb.length ? bb[i + 1].afterHours : Infinity;
            addOt(Math.max(0, Math.min(h, upper) - b.afterHours), b.mult);
          });
        }
      }
    });

    // Minimum-daily guarantee WITHOUT a clock-in: a min_daily rule flagged
    // requiresClockin === false also grants its floor on matching days in the pay
    // period that have NO worked bucket ("guaranteed hours"). Gated so it isn't
    // paid to someone absent the whole window — the worker must have clocked in
    // that 'week' (activeWindow 'week') or anywhere in the 'period' ('period').
    // Worked days are already floored above; this only fills the empty ones, and
    // only when the caller passes the pay-period `range` (no range → unchanged).
    const minDailyRules = (otConfig && Array.isArray(otConfig.minDailyRules)) ? otConfig.minDailyRules : [];
    const noClockRules = minDailyRules.filter(r => r.requiresClockin === false && (parseFloat(r.hours) || 0) > 0);
    if (rule === 'daily' && noClockRules.length && range && range.from && range.to) {
      const activeWeeks = new Set(Object.keys(buckets).map(dk => weekBucketKey(dk, weekStart)));
      const workedAnyInPeriod = Object.keys(buckets).length > 0;
      for (const dk of eachDateKey(range.from, range.to)) {
        if (buckets[dk] != null) continue;                          // worked day — floored above
        if (restDays && restDays.has(weekdayOfDate(dk))) continue;  // don't guarantee a rest day
        let floor = 0;
        for (const r of noClockRules) {
          if (!ruleMatchesDate(r, dk)) continue;
          let gate;
          if (r.activeWindow === 'period') {
            gate = workedAnyInPeriod;
          } else if (r.activeWindow === 'every_weekday' || r.activeWindow === 'every_other_day') {
            // Empty day D qualifies only if the worker clocked in on the OTHER days
            // of D's week: every weekday (Mon–Fri) except D, or every day except D.
            const weekdaysOnly = r.activeWindow === 'every_weekday';
            gate = weekDaysOf(dk, weekStart).every(d =>
              d === dk                                   // D itself is the day being filled — irrelevant
              || (weekdaysOnly && !isWeekdayKey(d))      // weekends don't count for the weekday gate
              || buckets[d] != null);                    // otherwise that day must have been worked
          } else {
            gate = activeWeeks.has(weekBucketKey(dk, weekStart)); // 'week'
          }
          if (gate) floor = Math.max(floor, parseFloat(r.hours) || 0);
        }
        if (floor > 0) autoReg += floor;   // guaranteed regular hours (no OT)
      }
    }
  }

  const otBands = [...otByMult.entries()]
    .map(([mult, hours]) => ({ hours, mult }))
    .filter(b => b.hours > 0);
  if (restDay && restDayHours > 0) otBands.push({ hours: restDayHours, mult: parseFloat(restDay.mult) || 2 });
  if (sd && seventhFirst > 0) otBands.push({ hours: seventhFirst, mult: parseFloat(sd.firstMult) || 1.5 });
  if (sd && seventhRest > 0)  otBands.push({ hours: seventhRest,  mult: parseFloat(sd.afterMult)  || 2 });
  if (overrideOt > 0) otBands.push({ hours: overrideOt, mult: null });
  for (const [mult, hours] of windowByMult) if (hours > 0) otBands.push({ hours, mult });

  const tierOt = [...otByMult.values()].reduce((s, h) => s + h, 0);
  const overtimeHours = tierOt + restDayHours + seventhFirst + seventhRest + overrideOt + windowTotal;

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
  if (!auto.length) return entries;

  // Time-window multipliers: each entry's covered hours are OT regardless of
  // where they fall in the day/week, so seed every entry's OT with them and carve
  // them out of the residual that drives the normal reg/OT fill below. Mirrors
  // computeOT so the per-entry OT still sums to the summary total. No window rules
  // → windowSumOf is 0 everywhere and this is a no-op.
  const windowRules = (otConfig && Array.isArray(otConfig.windowRules)) ? otConfig.windowRules : [];
  const windowSumOf = new Map();
  for (const e of auto) {
    let ws = 0;
    if (windowRules.length) for (const h of windowHoursForEntry(e, windowRules).values()) ws += h;
    windowSumOf.set(e, ws);
    e.overtime_hours = ws;
  }
  if (rule === 'none') return entries; // no daily/weekly OT; window OT (if any) already set

  const sd = (otConfig && otConfig.seventhDay && otConfig.seventhDay.enabled && rule === 'daily') ? otConfig.seventhDay : null;
  const restDay = (otConfig && otConfig.restDay && rule === 'daily') ? otConfig.restDay : null;
  const restDays = restDay ? new Set((restDay.days || []).map(Number)) : null;

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
    if ((restDays && restDays.has(weekdayOfDate(dk))) || (sd && seventhKeys.has(dk))) {
      for (const e of es) e.overtime_hours = entryDuration(e); // whole day is OT (window hours included)
      continue;
    }
    // Window hours are already carved out; only the residual drives the reg/OT
    // fill. Without window rules `resid` is entryDuration verbatim (windowSumOf is
    // 0 and no clamp), so this matches the prior behaviour exactly.
    const residOf = e => windowRules.length ? Math.max(0, entryDuration(e) - windowSumOf.get(e)) : entryDuration(e);
    const residualTotal = es.reduce((s, e) => s + residOf(e), 0);
    const minD = minDailyForBucket(otConfig, rule, dk);
    if (minD > 0 && residualTotal < minD) continue; // residual floored to regular; window OT stays as seeded
    // regular/OT split point for THIS bucket (tiers only re-price above it) — per
    // bucket so a date-scoped ot_tier rule moves the boundary on its days.
    let regLeft = bandsForBucket(rule, threshold, otConfig, dk)[0].afterHours;
    for (const e of es) {
      const resid = residOf(e);
      const r = Math.max(0, Math.min(resid, regLeft));
      e.overtime_hours = windowSumOf.get(e) + (resid - r); // window OT + residual OT
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

module.exports = { hoursWorked, computeOT, annotateEntryOvertime, computeDailyPayCosts, otBandsCost, resolveBands, nightHoursForEntry, nightPremiumCost, windowHoursForEntry, shiftHoursByDate, computeLeaveHours };
