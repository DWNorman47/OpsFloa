/**
 * Pay-period generation — deterministic UTC date logic. Pins the schedule cadences,
 * the period boundaries, weekend-shift, and the group/apply flags that let the run
 * combine checks for a shared exempt threshold.
 */

const { generatePeriods, groupPeriods } = require('../utils/payPeriods');
const dates = ps => ps.map(p => p.payDate);
const isWeekend = s => [0, 6].includes(new Date(s + 'T00:00:00Z').getUTCDay());

describe('generatePeriods', () => {
  test('weekly on_payday — a pay date each week on the pay weekday; period is the 7 days ending on it', () => {
    const ps = generatePeriods({ frequency: 'weekly', periodBasis: 'on_payday', payWeekday: 4, weekendShift: 'none' }, '2026-01-01', '2026-01-31');
    expect(dates(ps)).toEqual(['2026-01-01', '2026-01-08', '2026-01-15', '2026-01-22', '2026-01-29']); // Thursdays
    expect(ps[1]).toMatchObject({ periodStart: '2026-01-02', periodEnd: '2026-01-08' });
  });

  test('biweekly on_payday — every other week from the anchor (David: every other Thursday)', () => {
    const ps = generatePeriods({ frequency: 'biweekly', periodBasis: 'on_payday', anchorDate: '2026-01-08', weekendShift: 'none' }, '2026-01-01', '2026-02-28');
    expect(dates(ps)).toEqual(['2026-01-08', '2026-01-22', '2026-02-05', '2026-02-19']); // 14-day spacing
    expect(ps[0]).toMatchObject({ periodStart: '2025-12-26', periodEnd: '2026-01-08' });
  });

  test('biweekly work_week (default) — period is the two full work weeks ending the Sunday before payday', () => {
    // Thursday paydays Jul 2 & Jul 16; Mon-start work week → periods end the prior Sunday.
    const ps = generatePeriods({ frequency: 'biweekly', anchorDate: '2026-07-02', weekendShift: 'none' }, '2026-07-16', '2026-07-16', 1);
    expect(ps).toEqual([{ periodStart: '2026-06-29', periodEnd: '2026-07-12', payDate: '2026-07-16', seq: 1 }]);
  });

  test('biweekly work_week normalizes week_start=0 (Sunday) — NOT treated as Monday', () => {
    // The old `Number(0) || 1` bug read a Sunday-start week as Monday, misaligning every
    // period. Sunday-start → work week ends Saturday, so the period ends Jul 11 (Sat),
    // one day before the Monday-start result (Jul 12).
    const ps = generatePeriods({ frequency: 'biweekly', anchorDate: '2026-07-02', weekendShift: 'none' }, '2026-07-16', '2026-07-16', 0);
    expect(ps).toEqual([{ periodStart: '2026-06-28', periodEnd: '2026-07-11', payDate: '2026-07-16', seq: 1 }]);
  });

  test('biweekly prior_cycle — payday covers the previous completed 14-day cycle', () => {
    const ps = generatePeriods({ frequency: 'biweekly', periodBasis: 'prior_cycle', anchorDate: '2026-07-02', weekendShift: 'none' }, '2026-07-16', '2026-07-16');
    expect(ps).toEqual([{ periodStart: '2026-06-19', periodEnd: '2026-07-02', payDate: '2026-07-16', seq: 1 }]);
  });

  test('inclusion is by the actual (shifted) pay date, so a single-day pay-date window isolates one check', () => {
    // Anchor Jul 4 (Sat); with weekendShift after, the pay date is Mon Jul 6. Bracketing
    // the shifted date returns exactly that check even though the raw payday is Jul 4.
    const ps = generatePeriods({ frequency: 'biweekly', periodBasis: 'on_payday', anchorDate: '2026-07-04', weekendShift: 'after' }, '2026-07-06', '2026-07-06');
    expect(dates(ps)).toEqual(['2026-07-06']);
  });

  test('biweekly with no anchor yields nothing (the anchor sets the cadence)', () => {
    expect(generatePeriods({ frequency: 'biweekly', weekendShift: 'none' }, '2026-01-01', '2026-03-01')).toEqual([]);
  });

  test('semimonthly — 15th & 30th; "30" clamps to the last day in a short month', () => {
    const ps = generatePeriods({ frequency: 'semimonthly', daysOfMonth: [15, 30], weekendShift: 'none' }, '2026-02-01', '2026-02-28');
    expect(ps).toEqual([
      { periodStart: '2026-02-01', periodEnd: '2026-02-15', payDate: '2026-02-15' },
      { periodStart: '2026-02-16', periodEnd: '2026-02-28', payDate: '2026-02-28' }, // 30 → Feb 28
    ]);
  });

  test('monthly — one check per month; "last" is the month end', () => {
    const ps = generatePeriods({ frequency: 'monthly', dayOfMonth: 'last', weekendShift: 'none' }, '2026-01-01', '2026-03-31');
    expect(dates(ps)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(ps[0]).toMatchObject({ periodStart: '2026-01-01', periodEnd: '2026-01-31' });
  });

  test('weekend shift moves a pay date off Sat/Sun (period boundaries unchanged)', () => {
    const none = generatePeriods({ frequency: 'monthly', dayOfMonth: 'last', weekendShift: 'none' }, '2026-01-01', '2026-12-31');
    const before = generatePeriods({ frequency: 'monthly', dayOfMonth: 'last', weekendShift: 'before' }, '2026-01-01', '2026-12-31');
    expect(none.some(p => isWeekend(p.payDate))).toBe(true);   // some month-ends land on a weekend
    expect(before.every(p => !isWeekend(p.payDate))).toBe(true); // shifted off every weekend
  });

  test('out-of-order window → empty', () => {
    expect(generatePeriods({ frequency: 'weekly', payWeekday: 1 }, '2026-02-01', '2026-01-01')).toEqual([]);
  });
});

describe('groupPeriods — which check the deductions land on', () => {
  const biweekly = generatePeriods({ frequency: 'biweekly', anchorDate: '2026-01-08', weekendShift: 'none' }, '2026-01-01', '2026-02-28');

  test("pair + 'second' → the 2nd check of each pair deducts (David's biweekly case)", () => {
    const g = groupPeriods(biweekly, { timing: 'grouped', groupBy: 'pair', applyOn: 'second' });
    expect(g.map(p => p.deductionsApply)).toEqual([false, true, false, true]);
    expect(g[0].groupKey).toBe(g[1].groupKey);   // 08 & 22 are a pair
    expect(g[1].groupKey).not.toBe(g[2].groupKey);
  });

  test("month + 'last' → the last check in each month deducts (David's 15/30 case)", () => {
    const sm = generatePeriods({ frequency: 'semimonthly', daysOfMonth: [15, 30], weekendShift: 'none' }, '2026-02-01', '2026-03-31');
    const g = groupPeriods(sm, { timing: 'grouped', groupBy: 'month', applyOn: 'last' });
    // Feb: 15 (no) / 28 (yes, 30→28) ; Mar: 15 (no) / 30 (yes, 30 stays — period ends on the 31st)
    expect(g.map(p => `${p.payDate}:${p.deductionsApply}`)).toEqual([
      '2026-02-15:false', '2026-02-28:true', '2026-03-15:false', '2026-03-30:true',
    ]);
  });

  test("timing 'every' → every check deducts, no grouping", () => {
    const g = groupPeriods(biweekly, { timing: 'every' });
    expect(g.every(p => p.deductionsApply)).toBe(true);
  });

  test('pair grouping is anchor-stable — the same two checks pair regardless of the window', () => {
    const opts = { timing: 'grouped', groupBy: 'pair', applyOn: 'second' };
    const sched = { frequency: 'biweekly', anchorDate: '2026-01-08', weekendShift: 'none' };
    // Two windows with different left edges (the 2nd would flip pair parity under the old
    // array-index pairing). Feb 19 must pair with Feb 05 and deduct in BOTH.
    const wide = groupPeriods(generatePeriods(sched, '2026-01-01', '2026-04-30', 1), opts);
    const narrow = groupPeriods(generatePeriods(sched, '2026-02-01', '2026-04-30', 1), opts);
    const partner = (rows, pay) => rows.filter(p => p.groupKey === rows.find(x => x.payDate === pay).groupKey).map(p => p.payDate);
    expect(partner(wide, '2026-02-19')).toEqual(['2026-02-05', '2026-02-19']);
    expect(partner(narrow, '2026-02-19')).toEqual(['2026-02-05', '2026-02-19']);
    expect(wide.find(p => p.payDate === '2026-02-19').deductionsApply).toBe(true);
    expect(narrow.find(p => p.payDate === '2026-02-19').deductionsApply).toBe(true);
  });
});
