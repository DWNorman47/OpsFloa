/**
 * Pay-period generation from a Paycheck ruleset's schedule. Pure date logic (UTC,
 * no "now"), so it's deterministic and testable. Turns a schedule + a date window
 * into the individual paychecks (period covered + pay date), then groups them and
 * marks which check in each group the deductions apply to.
 *
 * This is what lets the run combine checks for a shared exempt threshold — e.g.
 * "every other Thursday, deduct on the 2nd check of each pair" or "15th & 30th,
 * deduct on the 30th, combined." See docs/plans/paycheck-rules.md.
 *
 * A pay date landing on a weekend can shift to the business day before/after; a
 * check is included when its ACTUAL (shifted) pay date is in [from, to].
 *
 * PERIOD BASIS (weekly/biweekly only — semimonthly/monthly periods are calendar
 * spans). How the pay period a check covers relates to its pay date:
 *   - `work_week`   two/one full work weeks ending on the last work-week-end BEFORE
 *                   the payday (aligns to the OT week; pay in arrears). Needs weekStart.
 *   - `prior_cycle` the previous whole cycle: the span ending one cycle before payday.
 *   - `on_payday`   the span ending ON the payday (the original behavior).
 */

const { PERIOD_BASES } = require('../constants/paycheckRuleEnums');

const DAY = 86400000;
const ms = isoStr => { const [y, m, d] = isoStr.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const iso = t => new Date(t).toISOString().slice(0, 10);
const weekday = t => new Date(t).getUTCDay();            // 0=Sun … 6=Sat
const addDays = (t, n) => t + n * DAY;
const lastDom = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m 1-12
const ymParts = isoStr => isoStr.split('-').map(Number);
const monthKey = (y, m) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;

function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = ms(value);
  return Number.isFinite(t) && iso(t) === value;
}

function dateRangeDays(from, to) {
  if (!isValidIsoDate(from) || !isValidIsoDate(to) || ms(to) < ms(from)) return null;
  return Math.floor((ms(to) - ms(from)) / DAY) + 1;
}

function shiftWeekend(t, mode) {
  if (mode !== 'before' && mode !== 'after') return t;
  const wd = weekday(t);
  if (wd === 6) return mode === 'before' ? addDays(t, -1) : addDays(t, 2); // Sat → Fri / Mon
  if (wd === 0) return mode === 'before' ? addDays(t, -2) : addDays(t, 1); // Sun → Fri / Mon
  return t;
}

/**
 * The [start, end] of the pay period a check covers, given its (unshifted) payday,
 * the span (13 for biweekly, 6 for weekly = days back from end), the basis, and
 * which weekday the work week starts on. Period alignment follows the scheduled
 * payday; only the check DATE weekend-shifts, never the period.
 */
function periodBounds(payT, span, basis, weekStart) {
  if (basis === 'prior_cycle') { const end = addDays(payT, -(span + 1)); return { startT: addDays(end, -span), endT: end }; }
  if (basis === 'work_week') {
    // Normalize like weekBounds.normWeekStart — `Number(0) || 1` would wrongly treat
    // Sunday-start (week_start = 0, the US default) as Monday, misaligning every period.
    const ws = Number.isFinite(Number(weekStart)) ? (((Number(weekStart) % 7) + 7) % 7) : 1;
    const weekEndDow = (ws + 6) % 7; // work-week end = day before the start (Mon start → Sun end)
    let back = (weekday(payT) - weekEndDow + 7) % 7;
    if (back === 0) back = 7; // land on the PRIOR week-end, strictly before payday
    const end = addDays(payT, -back);
    return { startT: addDays(end, -span), endT: end };
  }
  return { startT: addDays(payT, -span), endT: payT }; // on_payday
}

// `seq` is an ABSOLUTE, window-independent check index (weekly/biweekly only) so pair
// grouping anchors to the schedule, not to wherever the generation window starts.
// Without it, which two checks pair depends on the array's first element, so the
// admin run (group window), the worker stub (rolling 120d), and the period dropdown
// (firstWork−45d) could pair the SAME check differently → different net on one stub.
const makePeriod = (payT, span, basis, weekStart, shift, seq) => {
  const { startT, endT } = periodBounds(payT, span, basis, weekStart);
  const p = { periodStart: iso(startT), periodEnd: iso(endT), payDate: iso(shiftWeekend(payT, shift)) };
  if (Number.isInteger(seq)) p.seq = seq;
  return p;
};

// Scan a few days past each edge so a weekend-shifted pay date near the boundary is
// still tested; inclusion is always by the actual (shifted) pay date vs [from, to].
const PAD = 4 * DAY;

function weekly(sc, from, to, basis, weekStart) {
  const pw = Number(sc.payWeekday);
  if (!Number.isInteger(pw) || pw < 0 || pw > 6) return []; // guard: a non-weekday would spin forever
  const fromT = ms(from), toT = ms(to);
  let t = addDays(fromT, -4);
  while (weekday(t) !== pw) t = addDays(t, 1);
  const out = [];
  for (; t <= toT + PAD; t = addDays(t, 7)) {
    const payT = shiftWeekend(t, sc.weekendShift);
    // Absolute week index off the epoch — all paydays share a weekday, so this is a
    // stable +1 sequence independent of the window's first check.
    if (payT >= fromT && payT <= toT) out.push(makePeriod(t, 6, basis, weekStart, sc.weekendShift, Math.round(t / (7 * DAY))));
  }
  return out;
}

function biweekly(sc, from, to, basis, weekStart) {
  if (!sc.anchorDate) return []; // the anchor sets both cadence and weekday
  const anchor = ms(sc.anchorDate), fromT = ms(from), toT = ms(to);
  let t = anchor + Math.floor((fromT - anchor) / (14 * DAY)) * 14 * DAY;
  while (t < fromT - PAD) t = addDays(t, 14);
  const out = [];
  for (; t <= toT + PAD; t = addDays(t, 14)) {
    const payT = shiftWeekend(t, sc.weekendShift);
    // Absolute cycle index off the anchor — stable regardless of the window edge.
    if (payT >= fromT && payT <= toT) out.push(makePeriod(t, 13, basis, weekStart, sc.weekendShift, Math.round((t - anchor) / (14 * DAY))));
  }
  return out;
}

// Semimonthly/monthly periods are calendar spans (1st–15th, 16th–end, whole month),
// so the basis doesn't apply; iterate a month past each edge so a boundary weekend
// shift is still caught, and include by the shifted pay date.
function semimonthly(sc, from, to) {
  const days = [...new Set((sc.daysOfMonth || []).map(Number).filter(x => x >= 1 && x <= 31))].sort((a, b) => a - b).slice(0, 2);
  if (!days.length) return [];
  const fromT = ms(from), toT = ms(to);
  let [y, m] = ymParts(from);
  m--; if (m < 1) { m = 12; y--; }
  const [ty, tm] = ymParts(to);
  let ey = ty, em = tm + 1; if (em > 12) { em = 1; ey++; }
  const out = [];
  while (y < ey || (y === ey && m <= em)) {
    const last = lastDom(y, m);
    const uniq = [...new Set(days.map(x => Math.min(x, last)))].sort((a, b) => a - b);
    uniq.forEach((day, idx) => {
      const payT = shiftWeekend(Date.UTC(y, m - 1, day), sc.weekendShift);
      if (payT < fromT || payT > toT) return;
      const startDay = idx === 0 ? 1 : uniq[idx - 1] + 1;
      const isLast = idx === uniq.length - 1;
      // Absolute half-month index → floor(seq/2) is the calendar month, so pair grouping
      // pairs a month's two checks (the 15th & 30th) regardless of the generation window.
      const seq = y * 24 + (m - 1) * 2 + idx;
      out.push({
        periodStart: iso(Date.UTC(y, m - 1, startDay)),
        periodEnd: iso(Date.UTC(y, m - 1, isLast ? last : day)),
        payDate: iso(payT),
        seq,
        groupMonth: monthKey(y, m),
      });
    });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function monthly(sc, from, to) {
  const fromT = ms(from), toT = ms(to);
  let [y, m] = ymParts(from);
  m--; if (m < 1) { m = 12; y--; }
  const [ty, tm] = ymParts(to);
  let ey = ty, em = tm + 1; if (em > 12) { em = 1; ey++; }
  const out = [];
  while (y < ey || (y === ey && m <= em)) {
    const last = lastDom(y, m);
    const day = sc.dayOfMonth === 'last' ? last : Math.min(Number(sc.dayOfMonth) || last, last);
    const payT = shiftWeekend(Date.UTC(y, m - 1, day), sc.weekendShift);
    // Absolute month index — window-independent, so pair grouping pairs the same two months.
    if (payT >= fromT && payT <= toT) {
      out.push({
        periodStart: iso(Date.UTC(y, m - 1, 1)),
        periodEnd: iso(Date.UTC(y, m - 1, last)),
        payDate: iso(payT),
        seq: y * 12 + (m - 1),
        groupMonth: monthKey(y, m),
      });
    }
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * The paychecks a ruleset's schedule issues with a pay date in [from, to].
 * `weekStart` (0=Sun … 6=Sat, default Mon) drives the `work_week` period basis.
 */
function generatePeriods(schedule, from, to, weekStart = 1) {
  const sc = schedule || {};
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) return [];
  if (ms(to) < ms(from)) return [];
  const basis = PERIOD_BASES.includes(sc.periodBasis) ? sc.periodBasis : 'work_week';
  switch (sc.frequency) {
    case 'weekly': return weekly(sc, from, to, basis, weekStart);
    case 'biweekly': return biweekly(sc, from, to, basis, weekStart);
    case 'semimonthly': return semimonthly(sc, from, to);
    case 'monthly': return monthly(sc, from, to);
    default: return [];
  }
}

function markApply(group, applyOn) {
  const i = applyOn === 'first' ? 0 : applyOn === 'second' ? Math.min(1, group.length - 1) : group.length - 1;
  group.forEach((p, idx) => { p.deductionsApply = idx === i; });
}

/**
 * Group periods and flag which check the deductions land on.
 *   timing 'every'  → every check deducts (no grouping).
 *   groupBy 'pair'  → consecutive 2s; applyOn first|second|last within the pair.
 *   groupBy 'month' → periods sharing a pay-date month; applyOn within that month.
 * Returns the periods (copies) each with `groupKey` + `deductionsApply`.
 */
function groupPeriods(periods, { timing = 'grouped', groupBy = 'pair', applyOn = 'second' } = {}) {
  const rows = periods.map(p => ({ ...p }));
  if (timing === 'every') { rows.forEach((p, i) => { p.groupKey = String(i); p.deductionsApply = true; }); return rows; }
  if (groupBy === 'month') {
    const byMonth = {};
    // Semimonthly/monthly checks belong to their scheduled calendar month even
    // when a weekend shift moves the actual pay date into the next month.
    rows.forEach(p => { const k = p.groupMonth || p.payDate.slice(0, 7); (byMonth[k] = byMonth[k] || []).push(p); });
    Object.entries(byMonth).forEach(([k, g]) => { g.forEach(p => { p.groupKey = k; }); markApply(g, applyOn); });
  } else if (rows.length && rows.every(p => Number.isInteger(p.seq))) {
    // Anchor-stable pairing: pair by ABSOLUTE cycle index (floor(seq/2)), not array
    // position, so the same two checks always pair regardless of the window. The
    // group key is the absolute pair number, so it's identical across every surface.
    const byPair = new Map();
    rows.forEach(p => { const k = Math.floor(p.seq / 2); (byPair.get(k) || byPair.set(k, []).get(k)).push(p); });
    for (const [k, g] of byPair) { g.sort((a, b) => a.seq - b.seq); g.forEach(p => { p.groupKey = String(k); }); markApply(g, applyOn); }
  } else {
    // Fallback (semimonthly/monthly pair grouping, or seq-less periods): array pairing.
    for (let i = 0; i < rows.length; i += 2) {
      const g = rows.slice(i, i + 2);
      g.forEach(p => { p.groupKey = String(i / 2 | 0); });
      markApply(g, applyOn);
    }
  }
  return rows;
}

module.exports = { generatePeriods, groupPeriods, isValidIsoDate, dateRangeDays };
