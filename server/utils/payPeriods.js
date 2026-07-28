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
 * A pay date landing on a weekend can shift to the business day before/after; the
 * PERIOD boundaries follow the natural schedule (only the pay date shifts).
 */

const DAY = 86400000;
const ms = isoStr => { const [y, m, d] = isoStr.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const iso = t => new Date(t).toISOString().slice(0, 10);
const weekday = t => new Date(t).getUTCDay();            // 0=Sun … 6=Sat
const addDays = (t, n) => t + n * DAY;
const lastDom = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m 1-12
const ymParts = isoStr => isoStr.split('-').map(Number);

function shiftWeekend(t, mode) {
  if (mode !== 'before' && mode !== 'after') return t;
  const wd = weekday(t);
  if (wd === 6) return mode === 'before' ? addDays(t, -1) : addDays(t, 2); // Sat → Fri / Mon
  if (wd === 0) return mode === 'before' ? addDays(t, -2) : addDays(t, 1); // Sun → Fri / Mon
  return t;
}
const period = (startT, endT, payT, shift) =>
  ({ periodStart: iso(startT), periodEnd: iso(endT), payDate: iso(shiftWeekend(payT, shift)) });

function weekly(sc, from, to) {
  const pw = Number(sc.payWeekday);
  const end = ms(to);
  let t = ms(from);
  while (weekday(t) !== pw && t <= end) t = addDays(t, 1);
  const out = [];
  for (; t <= end; t = addDays(t, 7)) out.push(period(addDays(t, -6), t, t, sc.weekendShift));
  return out;
}

function biweekly(sc, from, to) {
  if (!sc.anchorDate) return []; // the anchor sets both cadence and weekday
  const anchor = ms(sc.anchorDate), fromT = ms(from), toT = ms(to);
  let t = anchor + Math.floor((fromT - anchor) / (14 * DAY)) * 14 * DAY;
  while (t < fromT) t = addDays(t, 14);
  const out = [];
  for (; t <= toT; t = addDays(t, 14)) out.push(period(addDays(t, -13), t, t, sc.weekendShift));
  return out;
}

function semimonthly(sc, from, to) {
  const days = [...new Set((sc.daysOfMonth || []).map(Number).filter(x => x >= 1 && x <= 31))].sort((a, b) => a - b).slice(0, 2);
  if (!days.length) return [];
  const fromT = ms(from), toT = ms(to);
  let [y, m] = ymParts(from);
  const [ty, tm] = ymParts(to);
  const out = [];
  while (y < ty || (y === ty && m <= tm)) {
    const last = lastDom(y, m);
    const uniq = [...new Set(days.map(x => Math.min(x, last)))].sort((a, b) => a - b);
    uniq.forEach((day, idx) => {
      const payT = Date.UTC(y, m - 1, day);
      if (payT < fromT || payT > toT) return;
      const startDay = idx === 0 ? 1 : uniq[idx - 1] + 1;
      const isLast = idx === uniq.length - 1;
      out.push(period(Date.UTC(y, m - 1, startDay), Date.UTC(y, m - 1, isLast ? last : day), payT, sc.weekendShift));
    });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function monthly(sc, from, to) {
  const fromT = ms(from), toT = ms(to);
  let [y, m] = ymParts(from);
  const [ty, tm] = ymParts(to);
  const out = [];
  while (y < ty || (y === ty && m <= tm)) {
    const last = lastDom(y, m);
    const day = sc.dayOfMonth === 'last' ? last : Math.min(Number(sc.dayOfMonth) || last, last);
    const payT = Date.UTC(y, m - 1, day);
    if (payT >= fromT && payT <= toT) out.push(period(Date.UTC(y, m - 1, 1), Date.UTC(y, m - 1, last), payT, sc.weekendShift));
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** The paychecks a ruleset's schedule issues with a pay date in [from, to]. */
function generatePeriods(schedule, from, to) {
  const sc = schedule || {};
  if (ms(to) < ms(from)) return [];
  switch (sc.frequency) {
    case 'weekly': return weekly(sc, from, to);
    case 'biweekly': return biweekly(sc, from, to);
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
    rows.forEach(p => { const k = p.payDate.slice(0, 7); (byMonth[k] = byMonth[k] || []).push(p); });
    Object.entries(byMonth).forEach(([k, g]) => { g.forEach(p => { p.groupKey = k; }); markApply(g, applyOn); });
  } else {
    for (let i = 0; i < rows.length; i += 2) {
      const g = rows.slice(i, i + 2);
      g.forEach(p => { p.groupKey = String(i / 2 | 0); });
      markApply(g, applyOn);
    }
  }
  return rows;
}

module.exports = { generatePeriods, groupPeriods };
