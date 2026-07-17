/**
 * hoursRules — the configurable work-hour / pay rules engine.
 *
 * This module is a pure, database-free transform. Given a company's rules
 * policy and a day's raw punch (actual clock-in / clock-out), it produces the
 * *paid* punch times that the rest of the pay math (payCalculations.js) then
 * treats exactly as it treats raw times today.
 *
 * DESIGN GUARANTEE — default is a no-op. If a company has no policy, or the
 * policy is disabled, `roundEntriesForPay` returns the entries byte-identical
 * to their input (raw start/end preserved). `computeOT` and every pay-calc call
 * site therefore behave exactly as they did before this feature existed. A
 * company only sees any change after it explicitly enables a policy.
 *
 * The raw punch is never mutated — paid times are computed on read and returned
 * on *copies*, so a misconfigured rule can be turned off and every number
 * reverts to the actual punches with no data to un-migrate.
 *
 * Milestone 1 (this file's initial scope): the reference cascade
 * (shift → per-worker standard hours → company standard hours) and punch
 * rounding (per-edge interval + grace + direction). Tiered OT and premiums
 * (rest-day, night differential, minimum daily hours) layer on later without
 * changing this transform.
 */

// ── Policy shape & defaults ─────────────────────────────────────────────────

// The canonical "do nothing" policy. Any absent/invalid field falls back to the
// matching field here, so a partial policy is always safe to evaluate.
const DEFAULT_POLICY = {
  version: 1,
  enabled: false,
  // Per-weekday expected hours. Key = day of week, 0=Sunday … 6=Saturday.
  // A null day is a non-working / rest day (no schedule reference).
  standardHours: {
    // e.g. "1": { start: '07:00', end: '16:00', unpaidBreakMin: 60 }
  },
  rounding: {
    // reference: 'schedule' rounds relative to the expected start/end;
    //            'clock' rounds to a wall-clock grid (e.g. US nearest-15),
    //            ignoring the schedule.
    // direction: 'against_worker' | 'toward_worker' | 'nearest' | 'off'
    clockIn:  { reference: 'schedule', intervalMin: 15, graceMin: 0, direction: 'off' },
    clockOut: { reference: 'schedule', intervalMin: 15, graceMin: 0, direction: 'off' },
  },
  // Milestone 3 — carried in the schema now so enabling them later needs no
  // migration. Ignored by the M1 transform.
  premiums: {},
  display: { showActualAndPaid: true },
};

const ROUNDING_DIRECTIONS = ['against_worker', 'toward_worker', 'nearest', 'off'];
const ROUNDING_REFERENCES = ['schedule', 'clock'];

// ── The rule list (Milestone 4) ──────────────────────────────────────────────
//
// `rounding` above is a fixed-slot policy: one clock-in edge, one clock-out
// edge, a closed vocabulary of interval/grace/direction. It covers a large
// class of real rules and cannot express the ones it wasn't designed for. The
// rule list is the open-ended half — a company writes as many small rules as it
// needs and they compose.
//
// COMPOSITION IS THE WHOLE DESIGN. A rung-by-rung ladder ("stay to 5:25 → +30
// min; to 5:50 → another 30; to 6:25 → another 30") is not a rule type. It's
// three `add_time` rules that all fire, and their sum is the ladder. That's why
// there's no repeating/every-N-minutes form: it looks more powerful and is
// actually less, because real negotiated ladders don't have even spacing.
// The same trick covers breaks — one `auto_break` per expected break.
//
// STAGE ORDER IS FIXED, NOT AUTHORABLE. Rules are a set; the pipeline is a
// sequence. Two rules in a different order produce a different invoice, so the
// order is a property of the engine and an admin can't get it wrong:
//
//   1. clip      — clip_start / clip_end bound the paid punch
//   2. adjust    — add_time / remove_time shift the paid end
//   3. break     — auto_break sets the deducted break
//   4. classify  — overtime, downstream in computeOT
//
// Adjust before classify is a decision, not an accident: it means added time
// COUNTS toward the overtime threshold. A 9.5h day plus a 0.5h late-stay credit
// is 10h, which under an 8h threshold is 2h of overtime — not 1.5h of overtime
// and 0.5h of regular.
const RULE_TYPES = ['clip_start', 'clip_end', 'add_time', 'remove_time', 'auto_break'];
const RULE_WHEN_KINDS = ['every_day', 'weekdays', 'month_days', 'month_weekdays'];
const RULE_EDGES = ['before', 'after'];
const BREAK_TRIGGERS = ['always', 'after_hours'];

// ── Time helpers (minutes-since-midnight ↔ "HH:MM[:SS]") ─────────────────────

/** "HH:MM[:SS]" → integer minutes since midnight (seconds truncated). null-safe. */
function toMin(hhmm) {
  if (hhmm == null) return null;
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** Integer minutes → "HH:MM:SS" (matches the DB TIME string format). */
function toHHMMSS(min) {
  const m = ((min % 1440) + 1440) % 1440; // wrap into [0,1440)
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;
}

/**
 * Day of week (0=Sun … 6=Sat) for a "YYYY-MM-DD" date string, computed in a
 * timezone-independent way. new Date('YYYY-MM-DD') parses as UTC midnight, so
 * getUTCDay() gives the intended calendar weekday regardless of server TZ.
 */
function weekdayOf(workDate) {
  const s = String(workDate).substring(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
}

/** Day of month (1-31) for "YYYY-MM-DD". null when unparseable. */
function dayOfMonth(workDate) {
  const m = String(workDate).substring(0, 10).match(/^\d{4}-\d{2}-(\d{2})$/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Which occurrence of its own weekday this date is within its month — the "2"
 * in "second Tuesday". Days 1-7 are the 1st occurrence, 8-14 the 2nd, and so on.
 */
function nthWeekdayOfMonth(workDate) {
  const dom = dayOfMonth(workDate);
  return dom == null ? null : Math.floor((dom - 1) / 7) + 1;
}

/**
 * Is this date the LAST occurrence of its weekday in the month? "Last Friday"
 * is a real payroll rule and can't be written as a fixed nth — a month has four
 * or five Fridays depending on the month.
 */
function isLastWeekdayOfMonth(workDate) {
  const s = String(workDate).substring(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const daysInMonth = new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate();
  return +m[3] + 7 > daysInMonth;
}

// ── Policy parsing ───────────────────────────────────────────────────────────

// ── Rule parsing ─────────────────────────────────────────────────────────────

const intIn = (v, lo, hi) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

/** Normalize a rule's day selector, or null if it can never match anything. */
function parseWhen(raw) {
  const w = (raw && typeof raw === 'object') ? raw : {};
  if (!RULE_WHEN_KINDS.includes(w.kind)) return null;
  if (w.kind === 'every_day') return { kind: 'every_day' };

  if (w.kind === 'weekdays') {
    const days = (Array.isArray(w.days) ? w.days : []).map(d => intIn(d, 0, 6)).filter(d => d != null);
    return days.length ? { kind: 'weekdays', days: [...new Set(days)] } : null;
  }
  if (w.kind === 'month_days') {
    const days = (Array.isArray(w.days) ? w.days : []).map(d => intIn(d, 1, 31)).filter(d => d != null);
    return days.length ? { kind: 'month_days', days: [...new Set(days)] } : null;
  }
  // month_weekdays: [{week, weekday}] — week 1-5, or -1 meaning "last".
  const patterns = (Array.isArray(w.patterns) ? w.patterns : [])
    .map(p => ({ week: intIn(p?.week, -1, 5), weekday: intIn(p?.weekday, 0, 6) }))
    .filter(p => p.week != null && p.weekday != null && p.week !== 0);
  return patterns.length ? { kind: 'month_weekdays', patterns } : null;
}

/** Normalize one rule, or null to drop it. */
function parseRule(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  if (!RULE_TYPES.includes(raw.type)) return null;
  const when = parseWhen(raw.when);
  if (!when) return null;

  const base = { id: String(raw.id || `r${index}`), type: raw.type, when };
  const at = toMin(raw.at);

  switch (raw.type) {
    case 'clip_start':
    case 'clip_end':
      // No time = nothing to clip to.
      return at == null ? null : { ...base, at };

    case 'add_time':
    case 'remove_time': {
      const minutes = Number(raw.minutes);
      if (at == null || !Number.isFinite(minutes) || minutes <= 0) return null;
      const edge = RULE_EDGES.includes(raw.edge) ? raw.edge : 'after';
      return { ...base, edge, at, minutes };
    }

    case 'auto_break': {
      const minutes = Number(raw.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) return null;
      const t = (raw.trigger && typeof raw.trigger === 'object') ? raw.trigger : {};
      const kind = BREAK_TRIGGERS.includes(t.kind) ? t.kind : 'always';
      const hours = Number(t.hours);
      // after_hours without a usable threshold would silently behave as
      // 'always' and deduct from every short day. Drop it instead.
      if (kind === 'after_hours' && !(Number.isFinite(hours) && hours > 0)) return null;
      return { ...base, minutes, trigger: kind === 'after_hours' ? { kind, hours } : { kind: 'always' } };
    }

    default:
      return null;
  }
}

function parseRules(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(parseRule).filter(Boolean);
}

/** Does this rule apply to this calendar date? */
function ruleMatchesDate(rule, workDate) {
  const w = rule.when;
  if (w.kind === 'every_day') return true;
  if (w.kind === 'weekdays') {
    const wd = weekdayOf(workDate);
    return wd != null && w.days.includes(wd);
  }
  if (w.kind === 'month_days') {
    const dom = dayOfMonth(workDate);
    return dom != null && w.days.includes(dom);
  }
  const wd = weekdayOf(workDate);
  if (wd == null) return false;
  const nth = nthWeekdayOfMonth(workDate);
  return w.patterns.some(p => p.weekday === wd
    && (p.week === -1 ? isLastWeekdayOfMonth(workDate) : p.week === nth));
}

/**
 * Parse the stored `hours_rules` setting (a JSON string) into a normalized
 * policy object. Anything malformed or missing degrades to DEFAULT_POLICY (the
 * no-op), never throws — a bad policy must never break payroll.
 */
function parsePolicy(raw) {
  if (!raw) return DEFAULT_POLICY;
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return DEFAULT_POLICY; }
  }
  if (!obj || typeof obj !== 'object') return DEFAULT_POLICY;

  const edge = (e, fallback) => {
    const src = (e && typeof e === 'object') ? e : {};
    const direction = ROUNDING_DIRECTIONS.includes(src.direction) ? src.direction : fallback.direction;
    const reference = ROUNDING_REFERENCES.includes(src.reference) ? src.reference : fallback.reference;
    const intervalMin = Number.isFinite(src.intervalMin) && src.intervalMin > 0 ? src.intervalMin : fallback.intervalMin;
    const graceMin = Number.isFinite(src.graceMin) && src.graceMin >= 0 ? src.graceMin : fallback.graceMin;
    return { reference, intervalMin, graceMin, direction };
  };

  const rounding = obj.rounding && typeof obj.rounding === 'object' ? obj.rounding : {};
  return {
    version: obj.version || 1,
    enabled: obj.enabled === true,
    standardHours: (obj.standardHours && typeof obj.standardHours === 'object') ? obj.standardHours : {},
    rounding: {
      clockIn:  edge(rounding.clockIn,  DEFAULT_POLICY.rounding.clockIn),
      clockOut: edge(rounding.clockOut, DEFAULT_POLICY.rounding.clockOut),
    },
    // The rule list. Anything that doesn't parse cleanly is DROPPED, not
    // repaired — same posture as the rest of parsePolicy, but the choice is
    // sharper here: a half-understood rule that still fires would quietly bill
    // the wrong number, and a wrong invoice is worse than a missing rule.
    rules: parseRules(obj.rules),
    // Tiered overtime + 7th-consecutive-day config (Milestone 2). Passed
    // through with light normalization; the pay calculator (resolveBands)
    // validates individual bands.
    overtime: (obj.overtime && typeof obj.overtime === 'object') ? obj.overtime : {},
    premiums: (obj.premiums && typeof obj.premiums === 'object') ? obj.premiums : {},
    display: {
      showActualAndPaid: obj.display?.showActualAndPaid !== false,
    },
  };
}

/**
 * Extract the tiered-overtime config for the pay calculator from a company
 * `settings` object, or null when there's nothing tiered configured (so
 * computeOT stays on its single-tier path). Returns
 * `{ dailyBands, weeklyBands, seventhDay }` when the enabled policy defines
 * bands or a 7th-day rule.
 */
function otConfigFromSettings(settings) {
  const p = parsePolicy(settings && settings.hours_rules);
  if (!p.enabled) return null;
  const o = p.overtime || {};
  const prem = p.premiums || {};
  const hasDaily  = Array.isArray(o.dailyBands)  && o.dailyBands.length  > 0;
  const hasWeekly = Array.isArray(o.weeklyBands) && o.weeklyBands.length > 0;
  const has7th    = o.seventhDay && o.seventhDay.enabled === true;

  // Rest-day premium: the rest days are the weekdays with NO standard hours.
  // Only meaningful when the schedule actually defines working days (otherwise
  // "every day is a rest day" — which we must not do).
  const workDays = Object.keys(p.standardHours || {})
    .filter(k => p.standardHours[k] && p.standardHours[k].start)
    .map(Number);
  const restMult = parseFloat(prem.restDayMult);
  let restDay = null;
  if (Number.isFinite(restMult) && restMult > 0 && workDays.length > 0) {
    const days = [0, 1, 2, 3, 4, 5, 6].filter(d => !workDays.includes(d));
    if (days.length) restDay = { mult: restMult, days };
  }
  const minDailyHours = parseFloat(prem.minDailyHours) || 0;
  const nightDifferential = (prem.nightDifferential && parseFloat(prem.nightDifferential.pct) > 0)
    ? prem.nightDifferential : null;

  if (!hasDaily && !hasWeekly && !has7th && !restDay && !minDailyHours && !nightDifferential) return null;
  return {
    dailyBands:  hasDaily  ? o.dailyBands  : [],
    weeklyBands: hasWeekly ? o.weeklyBands : [],
    seventhDay:  has7th    ? o.seventhDay  : null,
    restDay,
    minDailyHours,
    nightDifferential,
  };
}

// ── Reference cascade ────────────────────────────────────────────────────────

/**
 * Resolve the expected (scheduled) start/end for one worker on one day, in
 * priority order — the first layer that answers wins:
 *   1. an assigned shift for that date          (most specific)
 *   2. the worker's own standard hours override
 *   3. the company standard hours for that weekday
 *   4. none → returns null (schedule-relative rules simply don't fire)
 *
 * @returns {{startMin:number, endMin:number, unpaidBreakMin:number}|null}
 *          null when the day has no reference (unknown or an explicit rest day).
 */
function resolveExpected(policy, workDate, { shift, workerStandard } = {}) {
  // 1. Shift for the day.
  if (shift && shift.start_time && shift.end_time) {
    return {
      startMin: toMin(shift.start_time),
      endMin: toMin(shift.end_time),
      unpaidBreakMin: Number.isFinite(shift.unpaidBreakMin) ? shift.unpaidBreakMin : 0,
    };
  }
  // 2. Per-worker standard hours (same weekday-keyed shape as the company map).
  const wd = weekdayOf(workDate);
  const fromMap = (map) => {
    if (!map || wd == null) return null;
    const day = map[String(wd)];
    if (!day || !day.start || !day.end) return null; // null day = rest/non-working
    return {
      startMin: toMin(day.start),
      endMin: toMin(day.end),
      unpaidBreakMin: Number.isFinite(day.unpaidBreakMin) ? day.unpaidBreakMin : 0,
    };
  };
  return fromMap(workerStandard) || fromMap(policy.standardHours) || null;
}

// ── Rounding math ────────────────────────────────────────────────────────────

const ceilTo  = (v, i) => Math.ceil(v / i) * i;
const floorTo = (v, i) => Math.floor(v / i) * i;
const roundTo = (v, i) => Math.round(v / i) * i;

/**
 * Round one edge of a punch. Returns the paid minute-of-day for that edge.
 *
 * @param rawMin      actual punch minute-of-day
 * @param expectedMin expected (scheduled) minute-of-day, or null if unknown
 * @param cfg         { reference, intervalMin, graceMin, direction }
 * @param edge        'in' | 'out'
 */
function roundEdge(rawMin, expectedMin, cfg, edge) {
  const { reference, intervalMin: I, graceMin: G, direction } = cfg;
  if (direction === 'off') return rawMin;

  // Clock-grid mode: round the wall clock to the interval, independent of any
  // expected time. 'nearest' is the usual case (US quarter-hour rule);
  // against/toward bias the grid down/up.
  if (reference === 'clock') {
    if (direction === 'nearest') return roundTo(rawMin, I);
    // In the worker's favor = pay more time: earlier in, later out.
    if (direction === 'toward_worker') return edge === 'in' ? floorTo(rawMin, I) : ceilTo(rawMin, I);
    // Against the worker = pay less time: later in, earlier out.
    return edge === 'in' ? ceilTo(rawMin, I) : floorTo(rawMin, I);
  }

  // Schedule-relative mode with no schedule for this day (rest day / unset) —
  // there's nothing to measure lateness against, so leave the punch untouched.
  if (expectedMin == null) return rawMin;

  // Schedule-relative mode: measure lateness/overage against the expected time.
  const delta = rawMin - expectedMin; // in: +late/-early ; out: +over/-under

  if (direction === 'nearest') {
    return expectedMin + roundTo(delta, I);
  }

  if (edge === 'in') {
    const late = delta;
    if (direction === 'against_worker') {
      // Late by at least the grace → paid start jumps up to the next interval
      // boundary past the expected start (docking the fraction). Otherwise (early
      // or within grace) paid start = expected start; you aren't paid before it.
      if (late >= G && late > 0) return expectedMin + ceilTo(late, I);
      return expectedMin;
    }
    // toward_worker: reward an early arrival by paying from the rounded-earlier
    // grid; lateness is forgiven back to the expected start (never docked).
    if (late < 0) return expectedMin + floorTo(late, I);
    return expectedMin;
  }

  // edge === 'out'
  const over = delta;
  if (direction === 'toward_worker') {
    // Worked past the end by at least the grace → paid end rounds up to the next
    // interval boundary (the Honduran "30 min over ⇒ full extra hour"). Otherwise
    // paid end = expected end; a small overage isn't paid.
    if (over >= G && over > 0) return expectedMin + ceilTo(over, I);
    return expectedMin;
  }
  // against_worker: leaving early docks down to the interval boundary; staying
  // late is not paid (capped at the expected end).
  if (over < 0) return expectedMin + floorTo(over, I);
  return expectedMin;
}

/**
 * Apply the rounding policy to one raw punch pair.
 * @returns {{start:string, end:string}} paid "HH:MM:SS" times. The paid duration
 *          is clamped to be non-negative (a start rounded past the end ⇒ 0h).
 */
function applyRounding(rawStart, rawEnd, expected, rounding) {
  const rs = toMin(rawStart);
  const re = toMin(rawEnd);
  if (rs == null || re == null) return { start: rawStart, end: rawEnd };

  const es = expected ? expected.startMin : null;
  const ee = expected ? expected.endMin : null;

  let ps = roundEdge(rs, es, rounding.clockIn, 'in');
  let pe = roundEdge(re, ee, rounding.clockOut, 'out');

  // Never let rounding invert the interval.
  if (pe < ps) pe = ps;

  return { start: toHHMMSS(ps), end: toHHMMSS(pe) };
}

// ── Rule pipeline ────────────────────────────────────────────────────────────

/**
 * Run the rule list against one already-rounded punch.
 *
 * @param startMin,endMin  paid punch after rounding, minutes since midnight
 * @param loggedBreakMin   what the worker typed at clock-out
 * @param rules            parsed, already filtered to this date
 * @returns {{startMin, endMin, breakMin}}
 */
function applyRules(startMin, endMin, loggedBreakMin, rules) {
  let s = startMin;
  let e = endMin;

  // ── 1. Clip ── bound the paid punch. clip_start is "ignore anything before
  // this" (a worker may clock in at 6:30, but the day is not paid before 7:00);
  // it deliberately does NOT dock a late arrival — clocking in at 7:20 still
  // pays from 7:20, because max() only ever moves the start forward.
  for (const r of rules) {
    if (r.type === 'clip_start') s = Math.max(s, r.at);
    else if (r.type === 'clip_end') e = Math.min(e, r.at);
  }
  if (e < s) e = s;

  // ── 2. Adjust ── every add_time/remove_time rule is evaluated against the
  // SAME snapshot (sc/ec) and the deltas are summed, then applied once.
  //
  // This is the trap the whole ladder depends on. Applying each rule in turn
  // would let the first credit push the clock-out past the next rule's
  // threshold: a 5:30 punch gets +30 → 6:00, which now satisfies "after 5:50"
  // → +30 → 6:30, which satisfies "after 6:25"… A rung ladder would run away
  // to the end of the day off one late punch.
  const sc = s;
  const ec = e;
  let delta = 0;
  for (const r of rules) {
    if (r.type !== 'add_time' && r.type !== 'remove_time') continue;
    // 'after' tests the clock-out against the threshold; 'before' tests the
    // clock-in. Both are inclusive — the customer's rule reads "clocked in TO
    // or past 5:25", so 5:25:00 exactly must earn the credit.
    const hit = r.edge === 'after' ? ec >= r.at : sc <= r.at;
    if (!hit) continue;
    delta += r.type === 'add_time' ? r.minutes : -r.minutes;
  }
  e += delta;
  if (e < s) e = s;

  // ── 3. Break ── one auto_break rule per EXPECTED break; a rule fires only if
  // its trigger is satisfied by the hours actually on the clock.
  //
  // Compare TOTALS, take the larger, and never sum the two. The worker's
  // break_minutes is already deducted everywhere in the app, so adding an
  // automatic hour on top of it would deduct the lunch twice.
  //
  // Totals rather than per-break matching is also the only thing the data
  // supports: break_minutes is a single integer, so "they took three breaks"
  // is not knowable. It gives the right answer anyway — two of three expected
  // 30-min breaks logged is 60 against 90 expected, so max() supplies the
  // missing 30 without needing to count anything.
  const workedHours = (e - s) / 60;
  let expectedBreak = 0;
  for (const r of rules) {
    if (r.type !== 'auto_break') continue;
    if (r.trigger.kind === 'after_hours' && workedHours < r.trigger.hours) continue;
    expectedBreak += r.minutes;
  }
  const breakMin = Math.max(expectedBreak, Number(loggedBreakMin) || 0);

  return { startMin: s, endMin: e, breakMin };
}

// ── Batch transform (the single insertion point for pay-calc sites) ──────────

/**
 * Return a copy of `entries` with each entry's start_time/end_time replaced by
 * their paid (rounded) values, ready to hand to computeOT/hoursWorked unchanged.
 *
 * No-op guarantee: if the policy is disabled the input array is returned as-is
 * (same reference), so callers pay nothing and behavior is identical to today.
 *
 * Each adjusted entry keeps its raw punch on `raw_start_time`/`raw_end_time` and
 * carries a `rounding_adjusted` flag, so serializers can surface "actual vs
 * paid" without a second computation.
 *
 * @param entries  rows with { start_time, end_time, work_date, user_id, ... }
 * @param policy   a parsed policy (from parsePolicy)
 * @param ctx      { shiftMap?, workerStandardById? } optional reference sources:
 *                 shiftMap keyed by `${user_id}|${YYYY-MM-DD}` → shift row;
 *                 workerStandardById keyed by user_id → weekday standardHours map.
 */
function roundEntriesForPay(entries, policy, ctx = {}) {
  if (!policy || !policy.enabled) return entries;
  const inOff = policy.rounding.clockIn.direction === 'off';
  const outOff = policy.rounding.clockOut.direction === 'off';
  const rules = policy.rules || [];
  // Nothing configured on either mechanism → same array reference, as before.
  if (inOff && outOff && rules.length === 0) return entries;

  const { shiftMap, workerStandardById } = ctx;
  // Whether to surface the original punch alongside the paid time. When a company
  // opts for "paid only", we still round but don't expose the raw punch.
  const showRaw = policy.display?.showActualAndPaid !== false;
  return entries.map(e => {
    if (!e.start_time || !e.end_time) return e;
    const dateStr = String(e.work_date).substring(0, 10);
    const shift = shiftMap ? shiftMap[`${e.user_id}|${dateStr}`] : null;
    const workerStandard = workerStandardById ? workerStandardById[e.user_id] : null;
    const expected = resolveExpected(policy, e.work_date, { shift, workerStandard });

    // Rounding first: the rule list operates on the paid punch, not the raw one.
    const { start, end } = applyRounding(e.start_time, e.end_time, expected, policy.rounding);

    const dayRules = rules.filter(r => ruleMatchesDate(r, e.work_date));
    let finalStart = start;
    let finalEnd = end;
    let breakMin = e.break_minutes;

    if (dayRules.length) {
      const out = applyRules(toMin(start), toMin(end), e.break_minutes, dayRules);
      finalStart = toHHMMSS(out.startMin);
      finalEnd = toHHMMSS(out.endMin);
      breakMin = out.breakMin;
    }

    const breakChanged = breakMin !== e.break_minutes;
    if (finalStart === e.start_time && finalEnd === e.end_time && !breakChanged) return e;

    return {
      ...e,
      start_time: finalStart,
      end_time: finalEnd,
      ...(breakChanged ? { break_minutes: breakMin, raw_break_minutes: e.break_minutes } : {}),
      ...(showRaw ? { raw_start_time: e.start_time, raw_end_time: e.end_time } : {}),
      rounding_adjusted: true,
    };
  });
}

/**
 * Convenience for route handlers: round a batch of entries using the policy
 * stored on a company `settings` object (the `hours_rules` key). Equivalent to
 * `roundEntriesForPay(entries, parsePolicy(settings.hours_rules), ctx)`. Returns
 * the input untouched when there's no policy.
 */
function roundEntriesFromSettings(entries, settings, ctx = {}) {
  return roundEntriesForPay(entries, parsePolicy(settings && settings.hours_rules), ctx);
}

module.exports = {
  DEFAULT_POLICY,
  roundEntriesFromSettings,
  otConfigFromSettings,
  ROUNDING_DIRECTIONS,
  ROUNDING_REFERENCES,
  RULE_TYPES,
  RULE_WHEN_KINDS,
  RULE_EDGES,
  BREAK_TRIGGERS,
  parsePolicy,
  parseRules,
  resolveExpected,
  roundEdge,
  applyRounding,
  applyRules,
  ruleMatchesDate,
  roundEntriesForPay,
  // exported for tests
  toMin,
  toHHMMSS,
  weekdayOf,
  dayOfMonth,
  nthWeekdayOfMonth,
  isLastWeekdayOfMonth,
};
