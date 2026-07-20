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
// ADDED TIME IS PAID TIME, NOT CLOCK TIME. This is the rule that governs
// `add_time`, and getting it backwards produces nonsense. The credit is added to
// the SCHEDULED end, not to the punch. The punch only decides *which* rung the
// worker reached:
//
//   scheduled end 5:00pm; rungs "at 5:25 → +30" and "at 5:51 → +60"
//     still on at 5:24  → no rung   → 5:00 + 0  = 5:00
//     still on at 5:25  → rung 1    → 5:00 + 30 = 5:30
//     still on at 5:50  → rung 1    → 5:00 + 30 = 5:30
//     still on at 5:51  → rung 2    → 5:00 + 60 = 6:00
//
// Adding to the punch instead would make 5:51 + 60 = 6:51, which is nonsense —
// it pays a worker more for clocking out later within the same rung, which is
// the exact thing a rung exists to stop.
//
// RUNGS DO NOT ACCUMULATE. Each rung names the TOTAL credit at that point, so
// the largest rung reached wins. 5:51 has passed both rungs; it earns 60, not
// 90. (Read the customer's own words that way and they line up: "past 5:25 add
// a half hour; past 5:50 add an hour" — an hour, not another half hour.)
//
// `base: 'punch'` is available for the company that genuinely wants a flat
// bonus on top of the actual punch. It is not the default, because it is the
// nonsense above.
//
// STAGE ORDER IS FIXED, NOT AUTHORABLE. Rules are a set; the pipeline is a
// sequence. Two rules in a different order produce a different invoice, so the
// order is a property of the engine and an admin can't get it wrong:
//
//   1. clip      — clip_start / clip_end bound the paid punch
//   2. adjust    — add_time / remove_time set the paid end from the schedule
//   3. break     — auto_break sets the deducted break
//   4. classify  — overtime, downstream in computeOT
//
// Adjust before classify is a decision, not an accident: it means added time
// COUNTS toward the overtime threshold. A 9.5h day plus a 0.5h late-stay credit
// is 10h, which under an 8h threshold is 2h of overtime — not 1.5h of overtime
// and 0.5h of regular.
const RULE_TYPES = ['clip_start', 'clip_end', 'add_time', 'remove_time', 'auto_break', 'round', 'ot_tier',
  'rest_day', 'min_daily', 'seventh_day', 'night_diff'];
const ROUND_EDGES = ['in', 'out', 'both']; // which punch edge a `round` rule rounds
const OT_TIER_BASES = ['day', 'week'];     // an ot_tier rule counts hours per day or per week
const RULE_WHEN_KINDS = [
  'every_day', 'weekdays', 'month_days', 'month_weekdays',
  'nth_days',      // every Nth calendar day from an anchor date
  'months',        // only in these calendar months
  'nth_months',    // every Nth month from an anchor month
  'month_weeks',   // days in the Nth week of the month (day 1-7 = week 1)
  'nth_weeks',     // days in every Nth week from an anchor (e.g. biweekly)
];
const RULE_EDGES = ['before', 'after'];
// Where the credit is measured from. 'schedule' = the scheduled start/end (the
// default, and the only one that behaves sensibly for a ladder); 'punch' = the
// worker's actual punch, for a flat bonus.
const RULE_BASES = ['schedule', 'punch'];
// 'at'    — one threshold, one credit.
// 'every' — a repeating ladder: from T, every N minutes, another `minutes` of
//           credit. Cheap to author when the rungs happen to be evenly spaced;
//           uneven ladders (like the 25/26-minute one above) still need one
//           'at' rule per rung.
const RULE_MODES = ['at', 'every'];
// Where an add/remove-time TRIGGER is measured from. 'clock' = a fixed wall-clock
// time (`at`/`from`) — the only sensible option when everyone finishes at the same
// hour. 'schedule' = an OFFSET (`offsetMin`) off the worker's scheduled edge — the
// End Time rule if one is set, else their own scheduled end/start — so "25 min past
// quitting time" fires no matter what hour each worker actually finishes. This is
// the TRIGGER anchor and is independent of `base` ('schedule'|'punch'), which only
// decides where the credit LANDS.
const RULE_ANCHORS = ['clock', 'schedule'];
const BREAK_TRIGGERS = ['always', 'after_hours'];
// What a Start/End Time rule DOES about a punch outside the boundary. Only
// 'ignore' is enforced today — it's pure pay math (don't pay time outside the
// boundary) and fully reversible. 'prevent' (block the clock-in) and 'auto'
// (clock them in/out for them) are enforcement behaviors that live in the live
// clock, not the pay transform; the field is carried now so wiring them later
// needs no migration, exactly as `premiums: {}` was carried before it was live.
const CLIP_START_BEHAVIORS = ['ignore', 'prevent', 'auto'];  // early clock-in
const CLIP_END_BEHAVIORS   = ['ignore', 'auto'];             // late clock-out (can't "prevent" a clock-out)

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
 * Is this date the LAST occurrence of its weekday in the month? Works for any
 * weekday — "last Friday" is just the common example. It can't be written as a
 * fixed nth because a month has four or five of each weekday.
 */
function isLastWeekdayOfMonth(workDate) {
  const s = String(workDate).substring(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const daysInMonth = new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate();
  return +m[3] + 7 > daysInMonth;
}

/**
 * Which week of the month a date falls in, defined as 7-day blocks counted
 * from day 1: days 1-7 → week 1, 8-14 → 2, … 29-31 → 5. This is a deliberate,
 * unambiguous definition and NOT calendar weeks — "the first week" doesn't
 * depend on which weekday the 1st happens to be. (It equals nthWeekdayOfMonth,
 * because the 15th is both the 3rd of its weekday and in the 3rd block.)
 */
function weekOfMonth(workDate) {
  const dom = dayOfMonth(workDate);
  return dom == null ? null : Math.floor((dom - 1) / 7) + 1;
}

/** The highest week block present in a date's month (4 or 5). */
function lastWeekOfMonth(workDate) {
  const s = String(workDate).substring(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const daysInMonth = new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate();
  return Math.floor((daysInMonth - 1) / 7) + 1;
}

/** Calendar month (1-12) for "YYYY-MM-DD". null when unparseable. */
function monthOf(workDate) {
  const m = String(workDate).substring(0, 10).match(/^\d{4}-(\d{2})-\d{2}$/);
  return m ? parseInt(m[1], 10) : null;
}

/** UTC midnight for "YYYY-MM-DD", or null. */
function dateUTC(s) {
  const m = String(s).substring(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}

/**
 * Whole days from `from` to `to` (negative if `to` is earlier). Both are parsed
 * as UTC midnight, so this is a pure calendar-day count with no DST drift —
 * which is the whole reason the engine keeps dates as bare strings.
 */
function daysBetween(from, to) {
  const a = dateUTC(from);
  const b = dateUTC(to);
  if (a == null || b == null) return null;
  return Math.round((b - a) / 86400000);
}

/** Whole months from "YYYY-MM[-DD]" to "YYYY-MM-DD" (negative if earlier). */
function monthsBetween(from, to) {
  const a = String(from).match(/^(\d{4})-(\d{2})/);
  const b = String(to).match(/^(\d{4})-(\d{2})/);
  if (!a || !b) return null;
  return (+b[1] - +a[1]) * 12 + (+b[2] - +a[2]);
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
  if (w.kind === 'months') {
    const months = (Array.isArray(w.months) ? w.months : []).map(m => intIn(m, 1, 12)).filter(m => m != null);
    return months.length ? { kind: 'months', months: [...new Set(months)] } : null;
  }
  // An "every Nth" pattern is meaningless without an anchor to count from —
  // "every 3rd day" is only a rule once you say which day was the first.
  if (w.kind === 'nth_days') {
    const every = intIn(w.every, 1, 3650);
    const start = dateUTC(w.start) != null ? String(w.start).substring(0, 10) : null;
    return every && start ? { kind: 'nth_days', start, every } : null;
  }
  if (w.kind === 'nth_months') {
    const every = intIn(w.every, 1, 120);
    const start = /^\d{4}-\d{2}/.test(String(w.start || '')) ? String(w.start).substring(0, 7) : null;
    if (!every || !start) return null;
    // Optional: restrict to given days of the month within each Nth month.
    const days = (Array.isArray(w.days) ? w.days : []).map(d => intIn(d, 1, 31)).filter(d => d != null);
    return { kind: 'nth_months', start, every, days: days.length ? [...new Set(days)] : null };
  }
  if (w.kind === 'month_weeks') {
    // Week values 1-5, or -1 for the last week of the month.
    const weeks = (Array.isArray(w.weeks) ? w.weeks : [])
      .map(x => (x === -1 ? -1 : intIn(x, 1, 5)))
      .filter(x => x != null);
    return weeks.length ? { kind: 'month_weeks', weeks: [...new Set(weeks)] } : null;
  }
  if (w.kind === 'nth_weeks') {
    // Same shape as nth_days but counted in 7-day blocks from the anchor — the
    // anchor sets both the phase and the block boundary, which is exactly what
    // a biweekly pay cycle needs.
    const every = intIn(w.every, 1, 520);
    const start = dateUTC(w.start) != null ? String(w.start).substring(0, 10) : null;
    return every && start ? { kind: 'nth_weeks', start, every } : null;
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
    case 'clip_end': {
      // No time = nothing to clip to.
      if (at == null) return null;
      const allowed = raw.type === 'clip_start' ? CLIP_START_BEHAVIORS : CLIP_END_BEHAVIORS;
      const behavior = allowed.includes(raw.behavior) ? raw.behavior : 'ignore';
      return { ...base, at, behavior };
    }

    case 'add_time':
    case 'remove_time': {
      const minutes = Number(raw.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) return null;
      const edge = RULE_EDGES.includes(raw.edge) ? raw.edge : 'after';
      const ref = RULE_BASES.includes(raw.base) ? raw.base : 'schedule';
      const mode = RULE_MODES.includes(raw.mode) ? raw.mode : 'at';
      const anchor = RULE_ANCHORS.includes(raw.anchor) ? raw.anchor : 'clock';
      const everyOf = () => {
        const everyMin = Number(raw.everyMin);
        return Number.isFinite(everyMin) && everyMin > 0 ? everyMin : null;
      };
      if (anchor === 'schedule') {
        // Trigger is measured from the scheduled edge: `offsetMin` minutes past it
        // ('after') or before it ('before'). No absolute time is stored — the edge
        // is resolved per worker at pay time (see ruleCredit's anchorBase).
        const offsetMin = Number(raw.offsetMin);
        if (!Number.isFinite(offsetMin) || offsetMin < 0) return null;
        if (mode === 'every') {
          const everyMin = everyOf();
          return everyMin == null ? null
            : { ...base, edge, base: ref, mode, anchor, offsetMin, everyMin, minutes };
        }
        return { ...base, edge, base: ref, mode: 'at', anchor, offsetMin, minutes };
      }
      if (mode === 'every') {
        const from = toMin(raw.from);
        const everyMin = everyOf();
        if (from == null || everyMin == null) return null;
        return { ...base, edge, base: ref, mode, anchor, from, everyMin, minutes };
      }
      return at == null ? null : { ...base, edge, base: ref, mode: 'at', anchor, at, minutes };
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

    case 'round': {
      // A when-scoped override of the fixed-slot rounding: same math (roundEdge),
      // but it can target one edge and only fire on certain days. direction 'off'
      // is a valid rule ("don't round on Saturday").
      const edge = ROUND_EDGES.includes(raw.edge) ? raw.edge : 'both';
      const reference = ROUNDING_REFERENCES.includes(raw.reference) ? raw.reference : 'schedule';
      const direction = ROUNDING_DIRECTIONS.includes(raw.direction) ? raw.direction : 'nearest';
      const intervalMin = Number(raw.intervalMin);
      if (!Number.isFinite(intervalMin) || intervalMin <= 0) return null;
      const g = Number(raw.graceMin);
      const graceMin = Number.isFinite(g) && g >= 0 ? g : 0;
      return { ...base, edge, reference, direction, intervalMin, graceMin };
    }

    case 'ot_tier': {
      // One overtime tier: hours past `afterHours` in the bucket (day or week) are
      // paid at `mult`× base. Several ot_tier rules compose into a band list. When
      // scoped by `when`, they define the tiers for those days only (else the
      // fixed-slot OT config applies) — resolved per bucket in computeOT.
      const afterHours = Number(raw.afterHours);
      const mult = Number(raw.mult);
      if (!Number.isFinite(afterHours) || afterHours < 0) return null;
      if (!Number.isFinite(mult) || mult <= 0) return null;
      const basis = OT_TIER_BASES.includes(raw.basis) ? raw.basis : 'day';
      return { ...base, basis, afterHours, mult };
    }

    case 'rest_day': {
      // Whole day at `mult`× on the days `when` selects (the rest days).
      const mult = Number(raw.mult);
      if (!Number.isFinite(mult) || mult <= 0) return null;
      return { ...base, mult };
    }

    case 'min_daily': {
      // Reporting-time pay: a floor of paid regular hours on a matching short day.
      const hours = Number(raw.hours);
      if (!Number.isFinite(hours) || hours <= 0) return null;
      return { ...base, hours };
    }

    case 'seventh_day': {
      // 7th consecutive worked day of a workweek → whole day OT (first N hours at
      // one mult, the rest at a higher one). Workweek-detected, so `when` is not
      // used for scoping — carried for schema uniformity.
      const firstHours = Number(raw.firstHours);
      const firstMult = Number(raw.firstMult);
      const afterMult = Number(raw.afterMult);
      if (!Number.isFinite(firstMult) || firstMult <= 0) return null;
      if (!Number.isFinite(afterMult) || afterMult <= 0) return null;
      return { ...base, firstHours: Number.isFinite(firstHours) && firstHours >= 0 ? firstHours : 0, firstMult, afterMult };
    }

    case 'night_diff': {
      // Additive % premium on hours inside a nightly window [fromHour, toHour).
      const fromHour = Number(raw.fromHour), toHour = Number(raw.toHour), pct = Number(raw.pct);
      if (![fromHour, toHour].every(x => Number.isFinite(x) && x >= 0 && x <= 24)) return null;
      if (!Number.isFinite(pct) || pct <= 0) return null;
      return { ...base, fromHour, toHour, pct };
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
  switch (w.kind) {
    case 'every_day':
      return true;

    case 'weekdays': {
      const wd = weekdayOf(workDate);
      return wd != null && w.days.includes(wd);
    }

    case 'month_days': {
      const dom = dayOfMonth(workDate);
      return dom != null && w.days.includes(dom);
    }

    case 'months': {
      const mo = monthOf(workDate);
      return mo != null && w.months.includes(mo);
    }

    case 'nth_days': {
      // Never fires before its anchor — an every-Nth pattern counted backwards
      // from the anchor would silently cover dates the author never meant.
      const d = daysBetween(w.start, workDate);
      return d != null && d >= 0 && d % w.every === 0;
    }

    case 'nth_months': {
      const m = monthsBetween(w.start, workDate);
      if (m == null || m < 0 || m % w.every !== 0) return false;
      if (!w.days) return true;
      const dom = dayOfMonth(workDate);
      return dom != null && w.days.includes(dom);
    }

    case 'month_weeks': {
      const wk = weekOfMonth(workDate);
      if (wk == null) return false;
      if (w.weeks.includes(wk)) return true;
      return w.weeks.includes(-1) && wk === lastWeekOfMonth(workDate);
    }

    case 'nth_weeks': {
      // Never before the anchor, same as nth_days.
      const d = daysBetween(w.start, workDate);
      return d != null && d >= 0 && Math.floor(d / 7) % w.every === 0;
    }

    case 'month_weekdays': {
      const wd = weekdayOf(workDate);
      if (wd == null) return false;
      const nth = nthWeekdayOfMonth(workDate);
      return w.patterns.some(p => p.weekday === wd
        && (p.week === -1 ? isLastWeekdayOfMonth(workDate) : p.week === nth));
    }

    default:
      return false;
  }
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
  let minDailyHours = parseFloat(prem.minDailyHours) || 0;
  let nightDifferential = (prem.nightDifferential && parseFloat(prem.nightDifferential.pct) > 0)
    ? prem.nightDifferential : null;
  let seventhDay = has7th ? o.seventhDay : null;

  // ── Custom-rule builder equivalents (override the fixed slots when present) ──
  const rules = p.rules || [];
  // ot_tier rules — resolved per bucket in computeOT (a matching rule's bands
  // override the fixed-slot config for its days).
  const tierRules = rules.filter(r => r.type === 'ot_tier');
  // min_daily rules — resolved per bucket in computeOT (per-day floor).
  const minDailyRules = rules.filter(r => r.type === 'min_daily');
  // rest_day rule: `when` selects the rest days; the whole day pays at `mult`×.
  const restRule = rules.find(r => r.type === 'rest_day');
  if (restRule) {
    const days = daysFromWhen(restRule.when);
    if (days.length) restDay = { mult: restRule.mult, days };
  }
  // seventh_day rule: overrides the fixed-slot 7th-day config (workweek-detected).
  const sevenRule = rules.find(r => r.type === 'seventh_day');
  if (sevenRule) seventhDay = { enabled: true, firstHoursThreshold: sevenRule.firstHours, firstMult: sevenRule.firstMult, afterMult: sevenRule.afterMult };
  // night_diff rule: overrides the fixed-slot night differential.
  const nightRule = rules.find(r => r.type === 'night_diff');
  if (nightRule) nightDifferential = { fromHour: nightRule.fromHour, toHour: nightRule.toHour, pct: nightRule.pct };

  const has7thFinal = !!seventhDay;
  if (!hasDaily && !hasWeekly && !has7thFinal && !restDay && !minDailyHours && !nightDifferential
      && tierRules.length === 0 && minDailyRules.length === 0) return null;
  return {
    dailyBands:  hasDaily  ? o.dailyBands  : [],
    weeklyBands: hasWeekly ? o.weeklyBands : [],
    seventhDay,
    restDay,
    minDailyHours,
    nightDifferential,
    tierRules,
    minDailyRules,
  };
}

// The weekday set a `when` selects, for turning a rest_day rule into rest days.
// Only weekday-shaped patterns map cleanly; a specific-date pattern yields none.
function daysFromWhen(when) {
  if (!when) return [];
  if (when.kind === 'weekdays') return [...new Set((when.days || []).map(Number))].filter(d => d >= 0 && d <= 6);
  if (when.kind === 'every_day') return [0, 1, 2, 3, 4, 5, 6];
  return [];
}

/**
 * Migrate a policy's fixed-slot config (rounding / overtime bands + 7th-day /
 * premiums) into the equivalent custom rules, and clear the slots. Pure: takes
 * a RAW policy object (JSON.parse of hours_rules) and returns a new raw object
 * with migrated rules appended and the fixed slots emptied — serialize + re-parse
 * for use. `standardHours`, `display`, and `enabled` are preserved.
 *
 * The rule equivalents are proven behavior-identical to the slots
 * (payCalculations + hoursRules*.test.js), so re-running the same entries through
 * the migrated policy yields the same pay — see hoursRulesMigrate.test.js.
 */
function migrateFixedSlots(raw) {
  const p = (raw && typeof raw === 'object') ? raw : {};
  let n = 0;
  const nextId = () => `m${++n}`;
  const every = { kind: 'every_day' };
  const rules = Array.isArray(p.rules) ? [...p.rules] : [];

  // Rounding → a round rule per edge that actually rounds.
  const rnd = p.rounding || {};
  for (const [key, edge] of [['clockIn', 'in'], ['clockOut', 'out']]) {
    const c = rnd[key];
    if (c && c.direction && c.direction !== 'off') {
      rules.push({ id: nextId(), type: 'round', when: every, edge,
        reference: c.reference || 'schedule', direction: c.direction,
        intervalMin: c.intervalMin, graceMin: c.graceMin || 0 });
    }
  }

  // Overtime bands → ot_tier rules; 7th-day → seventh_day.
  const o = p.overtime || {};
  for (const [list, basis] of [[o.dailyBands, 'day'], [o.weeklyBands, 'week']]) {
    if (Array.isArray(list)) for (const b of list) {
      const afterHours = parseFloat(b.afterHours), mult = parseFloat(b.mult);
      if (Number.isFinite(afterHours) && afterHours >= 0 && Number.isFinite(mult) && mult > 0) {
        rules.push({ id: nextId(), type: 'ot_tier', when: every, basis, afterHours, mult });
      }
    }
  }
  if (o.seventhDay && o.seventhDay.enabled === true) {
    rules.push({ id: nextId(), type: 'seventh_day', when: every,
      firstHours: parseFloat(o.seventhDay.firstHoursThreshold) || 0,
      firstMult: parseFloat(o.seventhDay.firstMult) || 1.5,
      afterMult: parseFloat(o.seventhDay.afterMult) || 2 });
  }

  // Premiums → rest_day / min_daily / night_diff.
  const prem = p.premiums || {};
  const restMult = parseFloat(prem.restDayMult);
  const workDays = Object.keys(p.standardHours || {})
    .filter(k => p.standardHours[k] && p.standardHours[k].start).map(Number);
  if (Number.isFinite(restMult) && restMult > 0 && workDays.length > 0) {
    const days = [0, 1, 2, 3, 4, 5, 6].filter(d => !workDays.includes(d));
    if (days.length) rules.push({ id: nextId(), type: 'rest_day', when: { kind: 'weekdays', days }, mult: restMult });
  }
  const minH = parseFloat(prem.minDailyHours);
  if (Number.isFinite(minH) && minH > 0) rules.push({ id: nextId(), type: 'min_daily', when: every, hours: minH });
  const nd = prem.nightDifferential;
  if (nd && parseFloat(nd.pct) > 0) {
    rules.push({ id: nextId(), type: 'night_diff', when: every,
      fromHour: parseFloat(nd.fromHour) || 0, toHour: parseFloat(nd.toHour) || 0, pct: parseFloat(nd.pct) });
  }

  return {
    ...p,
    rules,
    rounding: {
      clockIn:  { reference: 'schedule', intervalMin: 15, graceMin: 0, direction: 'off' },
      clockOut: { reference: 'schedule', intervalMin: 15, graceMin: 0, direction: 'off' },
    },
    overtime: {},
    premiums: {},
  };
}

/** True when a raw policy still carries any fixed-slot config worth migrating. */
function hasFixedSlots(raw) {
  const p = (raw && typeof raw === 'object') ? raw : {};
  const rnd = p.rounding || {};
  if ((rnd.clockIn && rnd.clockIn.direction && rnd.clockIn.direction !== 'off')
    || (rnd.clockOut && rnd.clockOut.direction && rnd.clockOut.direction !== 'off')) return true;
  const o = p.overtime || {};
  if ((Array.isArray(o.dailyBands) && o.dailyBands.length) || (Array.isArray(o.weeklyBands) && o.weeklyBands.length)) return true;
  if (o.seventhDay && o.seventhDay.enabled === true) return true;
  const prem = p.premiums || {};
  if (parseFloat(prem.restDayMult) > 0 || parseFloat(prem.minDailyHours) > 0
    || (prem.nightDifferential && parseFloat(prem.nightDifferential.pct) > 0)) return true;
  return false;
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

// ── Policy validation ────────────────────────────────────────────────────────

/**
 * Coherence check for a rule list beyond "can each rule be parsed". Currently a
 * no-op: the one rule it used to enforce — Add/Remove Time needs a Start/End Time
 * rule to measure from — was relaxed so that Add/Remove Time falls back to the
 * worker's scheduled hours when there's no such rule (and no-ops when there's no
 * schedule either), so it's no longer incoherent on its own.
 *
 * @returns {Array<{id, code, message}>} empty when the policy is coherent
 */
function validatePolicy(policy) {
  // Add/Remove Time used to be REFUSED when there was no Start/End Time rule to
  // measure from. It no longer is: with no such rule the credit measures from the
  // worker's scheduled hours (shift → worker → company standard hours, via
  // `expected` in applyRules), and with no schedule for the day either the rule is
  // a no-op — applyRules never adds onto the raw punch. So there's nothing
  // incoherent left to catch here. Kept as the validation seam (and to preserve
  // the export/contract) in case future rule combinations need guarding.
  void policy;
  return [];
}

/** Same, straight off the raw `hours_rules` string. */
function validatePolicyRaw(raw) {
  return validatePolicy(parsePolicy(raw));
}

// ── Rule pipeline ────────────────────────────────────────────────────────────

/**
 * How much credit one add_time/remove_time rule grants for a given punch, in
 * minutes. 0 when the punch hasn't reached the rule's threshold.
 *
 * A rung names the TOTAL credit at that point, not an increment — see the
 * header. `every` mode is the one exception: each repetition is another
 * `minutes`, because that's what "every N minutes, add M" means.
 */
function ruleCredit(rule, punchMin, anchorBase = null) {
  // The trigger threshold. 'clock' anchor: a fixed wall-clock time (`at`/`from`).
  // 'schedule' anchor: an offset off the scheduled edge — `anchorBase` is that edge
  // (baseEnd for 'after', baseStart for 'before'), already resolved by applyRules.
  // With no schedule to resolve, a schedule-anchored rule can't know when to fire,
  // so it doesn't (0) — mirroring how a schedule-BASED credit no-ops with no baseline.
  let threshold;
  if (rule.anchor === 'schedule') {
    if (anchorBase == null) return 0;
    threshold = rule.edge === 'after' ? anchorBase + rule.offsetMin : anchorBase - rule.offsetMin;
  } else {
    threshold = rule.mode === 'every' ? rule.from : rule.at;
  }
  // 'after' measures a late clock-out; 'before' measures an early clock-in.
  const past = rule.edge === 'after' ? punchMin - threshold : threshold - punchMin;
  // Inclusive: the customer's rule reads "clocked in TO or past 5:25", so 5:25
  // exactly must earn the rung.
  if (past < 0) return 0;
  if (rule.mode === 'every') return (Math.floor(past / rule.everyMin) + 1) * rule.minutes;
  return rule.minutes;
}

/** The winning credit for one edge: the largest rung reached, not their sum. */
function bestCredit(rules, type, edge, punchMin, anchorBase = null) {
  let best = 0;
  for (const r of rules) {
    if (r.type !== type || r.edge !== edge) continue;
    const c = ruleCredit(r, punchMin, anchorBase);
    if (c > best) best = c;
  }
  return best;
}

/**
 * Run the rule list against one already-rounded punch.
 *
 * @param startMin,endMin  paid punch after rounding, minutes since midnight
 * @param loggedBreakMin   what the worker typed at clock-out
 * @param rules            parsed, already filtered to this date
 * @param expected         {startMin, endMin} scheduled day, or null
 * @returns {{startMin, endMin, breakMin}}
 */
function applyRules(startMin, endMin, loggedBreakMin, rules, expected = null) {
  // The punch as it arrived. Rung thresholds are ALWAYS judged against this,
  // never against the clipped value — an End Time rule at 5:00 would otherwise
  // pull every punch back to 5:00 and no rung could ever fire.
  const punchStart = startMin;
  const punchEnd = endMin;

  let s = startMin;
  let e = endMin;

  // ── 1. Clip ── bound the paid punch, and establish the baseline the ladder
  // measures from. clip_start ("Start Time") is "ignore anything before this";
  // it deliberately does NOT dock a late arrival — clocking in at 7:20 still
  // pays from 7:20, because max() only ever moves the start forward.
  //
  // The tightest rule wins when several match: the latest Start Time, the
  // earliest End Time. Two rules that both bound a day can only be read one way
  // without asking an admin to think about precedence.
  //
  // Behavior: 'ignore' and 'prevent' both mean "don't pay outside the
  // boundary", so both clamp the paid punch here. ('prevent' also blocks the
  // clock-in live, but if an early punch slips through — offline, an admin edit
  // — clamping is the right pay-side backstop.) 'auto' means "pay from the
  // boundary regardless" and is NOT enforced yet; it's not selectable in the
  // UI, so this only skips a hand-written policy, and doing nothing is the safe
  // choice — we never invent paid time a worker didn't clock.
  let baseStart = null;
  let baseEnd = null;
  for (const r of rules) {
    if (r.type === 'clip_start') {
      // The boundary is the ladder baseline no matter the behavior.
      baseStart = baseStart == null ? r.at : Math.max(baseStart, r.at);
      if (r.behavior !== 'auto') s = Math.max(s, r.at);
    } else if (r.type === 'clip_end') {
      baseEnd = baseEnd == null ? r.at : Math.min(baseEnd, r.at);
      if (r.behavior !== 'auto') e = Math.min(e, r.at);
    }
  }
  // No End Time rule for this day → fall back to the scheduled day. Validation
  // requires the rule (see validatePolicy), so this only catches a policy
  // written straight into the DB.
  if (baseEnd == null && expected) baseEnd = expected.endMin;
  if (baseStart == null && expected) baseStart = expected.startMin;
  if (e < s) e = s;

  // ── 2. Adjust ── the credit lands on the BASELINE, not on the punch. The
  // punch decides which rung was reached; it is not the thing added to.
  const hasAfter = rules.some(r => (r.type === 'add_time' || r.type === 'remove_time') && r.edge === 'after');
  if (hasAfter) {
    const net = bestCredit(rules, 'add_time', 'after', punchEnd, baseEnd)
              - bestCredit(rules, 'remove_time', 'after', punchEnd, baseEnd);
    const scheduleBased = rules.some(r => r.edge === 'after' && r.base === 'schedule'
      && (r.type === 'add_time' || r.type === 'remove_time'));

    if (scheduleBased) {
      // The credit lands on the baseline — an End Time rule if one is set, else
      // the scheduled end (shift / worker or company standard hours, via
      // `expected`). With NO baseline at all there's nothing to measure from, so
      // the rule simply doesn't fire — we never add onto the raw punch (the
      // 5:51→6:51 nonsense). Only staying LATE is governed by the ladder; leaving
      // early is just a short day, not a reason to invent hours to the baseline.
      if (baseEnd != null && punchEnd > baseEnd) e = baseEnd + net;
    } else {
      // base 'punch': a flat bonus on the actual punch, by design.
      e = e + net;
    }
  }

  // The clock-in edge, mirrored: credit moves the paid start EARLIER off the
  // baseline.
  const hasBefore = rules.some(r => (r.type === 'add_time' || r.type === 'remove_time') && r.edge === 'before');
  if (hasBefore) {
    const net = bestCredit(rules, 'add_time', 'before', punchStart, baseStart)
              - bestCredit(rules, 'remove_time', 'before', punchStart, baseStart);
    const scheduleBased = rules.some(r => r.edge === 'before' && r.base === 'schedule'
      && (r.type === 'add_time' || r.type === 'remove_time'));

    if (scheduleBased) {
      // Same as the end edge: measure from the Start Time rule or the scheduled
      // start; no baseline → no-op, never off the raw punch.
      if (baseStart != null && punchStart < baseStart) s = baseStart - net;
    } else {
      s = s - net;
    }
  }

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

    const dayRules = rules.filter(r => ruleMatchesDate(r, e.work_date));

    // Rounding first: the rule list operates on the paid punch, not the raw one.
    // A `round` rule is a when-scoped override of the fixed-slot rounding config
    // for its edge(s) — later matching rules win; with none, the global config
    // applies exactly as before.
    let cfgIn = policy.rounding.clockIn, cfgOut = policy.rounding.clockOut;
    for (const r of dayRules) {
      if (r.type !== 'round') continue;
      const cfg = { reference: r.reference, intervalMin: r.intervalMin, graceMin: r.graceMin, direction: r.direction };
      if (r.edge === 'in' || r.edge === 'both') cfgIn = cfg;
      if (r.edge === 'out' || r.edge === 'both') cfgOut = cfg;
    }
    const { start, end } = applyRounding(e.start_time, e.end_time, expected, { clockIn: cfgIn, clockOut: cfgOut });
    let finalStart = start;
    let finalEnd = end;
    let breakMin = e.break_minutes;

    if (dayRules.length) {
      const out = applyRules(toMin(start), toMin(end), e.break_minutes, dayRules, expected);
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
  migrateFixedSlots,
  hasFixedSlots,
  ROUNDING_DIRECTIONS,
  ROUNDING_REFERENCES,
  RULE_TYPES,
  RULE_WHEN_KINDS,
  RULE_EDGES,
  RULE_BASES,
  RULE_MODES,
  RULE_ANCHORS,
  BREAK_TRIGGERS,
  CLIP_START_BEHAVIORS,
  CLIP_END_BEHAVIORS,
  parsePolicy,
  parseRules,
  validatePolicy,
  validatePolicyRaw,
  resolveExpected,
  roundEdge,
  applyRounding,
  applyRules,
  ruleCredit,
  ruleMatchesDate,
  roundEntriesForPay,
  // exported for tests
  toMin,
  toHHMMSS,
  weekdayOf,
  dayOfMonth,
  monthOf,
  nthWeekdayOfMonth,
  isLastWeekdayOfMonth,
  weekOfMonth,
  lastWeekOfMonth,
  daysBetween,
  monthsBetween,
};
