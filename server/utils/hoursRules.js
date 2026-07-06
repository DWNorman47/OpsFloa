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

// ── Policy parsing ───────────────────────────────────────────────────────────

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
    premiums: (obj.premiums && typeof obj.premiums === 'object') ? obj.premiums : {},
    display: {
      showActualAndPaid: obj.display?.showActualAndPaid !== false,
    },
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
  if (inOff && outOff) return entries;

  const { shiftMap, workerStandardById } = ctx;
  return entries.map(e => {
    if (!e.start_time || !e.end_time) return e;
    const dateStr = String(e.work_date).substring(0, 10);
    const shift = shiftMap ? shiftMap[`${e.user_id}|${dateStr}`] : null;
    const workerStandard = workerStandardById ? workerStandardById[e.user_id] : null;
    const expected = resolveExpected(policy, e.work_date, { shift, workerStandard });

    const { start, end } = applyRounding(e.start_time, e.end_time, expected, policy.rounding);
    if (start === e.start_time && end === e.end_time) return e;

    return {
      ...e,
      start_time: start,
      end_time: end,
      raw_start_time: e.start_time,
      raw_end_time: e.end_time,
      rounding_adjusted: true,
    };
  });
}

module.exports = {
  DEFAULT_POLICY,
  ROUNDING_DIRECTIONS,
  ROUNDING_REFERENCES,
  parsePolicy,
  resolveExpected,
  roundEdge,
  applyRounding,
  roundEntriesForPay,
  // exported for tests
  toMin,
  toHHMMSS,
  weekdayOf,
};
