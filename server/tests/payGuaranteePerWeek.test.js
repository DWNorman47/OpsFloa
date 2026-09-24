/**
 * The weekly-hours guarantee is a PER-WEEK floor, computed by the engine
 * (buildPayStatement) so every surface — pay stub, payroll CSV, OT report,
 * payroll JE and the QuickBooks contractor bill — reports the same number.
 *
 * Before, the engine pooled the guarantee across the period (guarantee × weeks vs
 * total hours) while the QBO bill priced each week on its own: a 50h week + a 30h
 * week paid no guarantee on the stub / payroll ($0) but billed 10h on the bill.
 *
 * Weeks follow the company week_start. A week belongs to the period holding its
 * LAST day (the same chronological attribution full-week OT loading uses): the
 * week's out-of-period hours (weekContextEntries) and leave (weekContextLeaveByDate)
 * count toward it, and a week that ends after `to` is the next period's.
 */

jest.mock('../db', () => ({ query: jest.fn() }));
const { buildPayStatement } = require('../utils/payStatement');

const S = { overtime_rule: 'none', week_start: 1, regular_shift_hours: 8, sick_pay_pct: 100, vacation_pay_pct: 100 };
const W = { id: 10, hourly_rate: 20, rate_type: 'hourly', guaranteed_weekly_hours: 40 };
const e = (d, start = '08:00:00', end = '16:00:00') => ({ user_id: 10, work_date: d, wage_type: 'regular', start_time: start, end_time: end, break_minutes: 0 });
const days = (list, s, t) => list.map(d => e(d, s, t));
const build = o => buildPayStatement({ worker: W, entries: [], settings: S, otConfig: null, ...o });

test('50h week + 30h week: 10h guarantee on the stub (was $0 pooled over the range)', () => {
  const st = build({
    entries: [
      ...days(['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'], '07:00:00', '17:00:00'),
      ...days(['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'], '08:00:00', '14:00:00'),
    ],
    from: '2026-09-07', to: '2026-09-20',
  });
  expect(st.hours.guaranteeShortfall).toBe(10);
  expect(st.cost.guarantee).toBe(200);
  expect(st.hours.guaranteeWeeks).toBe(2);
  expect(st.hours.guaranteeByWeek).toEqual([
    expect.objectContaining({ weekStart: '2026-09-07', shortfall: 0, cost: 0 }),
    expect.objectContaining({ weekStart: '2026-09-14', shortfall: 10, cost: 200 }),
  ]);
  expect(st.totals.grossWages).toBe(80 * 20 + 200);
});

test('semimonthly periods: each week is paid once, in the period holding its last day', () => {
  // Works 8h every Monday. Weeks (Mon start): Aug 31, Sep 7 → Sep 1–15; Sep 14, Sep 21 → Sep 16–30;
  // the week of Sep 28 ends Oct 4 → the October period.
  const mondays = ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'];
  const period = (from, to) => build({
    entries: days(mondays.filter(d => d >= from && d <= to)),
    weekContextEntries: days(mondays.filter(d => d < from || d > to)),
    from, to,
  });
  const a = period('2026-09-01', '2026-09-15');
  const b = period('2026-09-16', '2026-09-30');
  expect(a.hours.guaranteeByWeek.map(w => w.weekStart)).toEqual(['2026-08-31', '2026-09-07']);
  expect(a.hours.guaranteeShortfall).toBe(64); // the Aug 31 Monday (context) counts toward its week
  expect(b.hours.guaranteeByWeek.map(w => w.weekStart)).toEqual(['2026-09-14', '2026-09-21']);
  expect(b.hours.guaranteeShortfall).toBe(64);
  expect(a.cost.guarantee + b.cost.guarantee).toBe(2 * 1280);
});

test('a period shorter than a week pays no guarantee unless it holds the week\'s last day', () => {
  expect(build({ entries: [e('2026-09-08')], from: '2026-09-08', to: '2026-09-10' }).cost.guarantee).toBe(0); // was 32h × $20
  const end = build({ entries: [e('2026-09-12')], weekContextEntries: [e('2026-09-08')], from: '2026-09-11', to: '2026-09-13' });
  expect(end.hours.guaranteeShortfall).toBe(24); // 40 − (8 in-period + 8 context)
});

test('leave in the week counts, including leave before the period (weekContextLeaveByDate)', () => {
  const st = build({
    entries: [e('2026-09-10')],
    leave: { sick: 8, vacation: 0, leaveByDate: new Map([['2026-09-11', 8]]) },
    weekContextLeaveByDate: new Map([['2026-09-08', 8], ['2026-09-11', 8]]), // in-period date not double-counted
    from: '2026-09-10', to: '2026-09-13',
  });
  expect(st.hours.guaranteeShortfall).toBe(16); // 40 − (8 worked + 8 sick + 8 context sick)
});
