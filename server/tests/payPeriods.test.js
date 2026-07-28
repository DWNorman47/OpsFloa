/**
 * Pay-period generation — deterministic UTC date logic. Pins the schedule cadences,
 * the period boundaries, weekend-shift, and the group/apply flags that let the run
 * combine checks for a shared exempt threshold.
 */

const { generatePeriods, groupPeriods } = require('../utils/payPeriods');
const dates = ps => ps.map(p => p.payDate);
const isWeekend = s => [0, 6].includes(new Date(s + 'T00:00:00Z').getUTCDay());

describe('generatePeriods', () => {
  test('weekly — a pay date each week on the pay weekday; period is the 7 days ending on it', () => {
    const ps = generatePeriods({ frequency: 'weekly', payWeekday: 4, weekendShift: 'none' }, '2026-01-01', '2026-01-31');
    expect(dates(ps)).toEqual(['2026-01-01', '2026-01-08', '2026-01-15', '2026-01-22', '2026-01-29']); // Thursdays
    expect(ps[1]).toMatchObject({ periodStart: '2026-01-02', periodEnd: '2026-01-08' });
  });

  test('biweekly — every other week from the anchor (David: every other Thursday)', () => {
    const ps = generatePeriods({ frequency: 'biweekly', anchorDate: '2026-01-08', weekendShift: 'none' }, '2026-01-01', '2026-02-28');
    expect(dates(ps)).toEqual(['2026-01-08', '2026-01-22', '2026-02-05', '2026-02-19']); // 14-day spacing
    expect(ps[0]).toMatchObject({ periodStart: '2025-12-26', periodEnd: '2026-01-08' });
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
});
