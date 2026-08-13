/**
 * min_daily "no clock-in" guarantee: a min_daily rule with requiresClockin=false
 * also grants its floor on matching days the worker DIDN'T clock in, gated by
 * activeWindow — they must have clocked in that 'week' or anywhere in the 'period'.
 * A fully-absent window is never paid. Worked days behave exactly as before, and
 * with no `range` (or requiresClockin=true) nothing changes.
 */

const { computeOT } = require('../utils/payCalculations');
const { otConfigFromSettings } = require('../utils/hoursRules');

// weekStart = Monday (1). Two consecutive weeks:
const W1 = { MON: '2026-07-06', TUE: '2026-07-07', WED: '2026-07-08', THU: '2026-07-09', FRI: '2026-07-10' };
const W2 = { MON: '2026-07-13', TUE: '2026-07-14' };
const RANGE = { from: '2026-07-06', to: '2026-07-19' }; // covers both weeks

const e = (work_date, start_time, end_time, extra = {}) =>
  ({ wage_type: 'regular', break_minutes: 0, work_date, start_time, end_time, ...extra });
const otConfig = (rules) => otConfigFromSettings({ hours_rules: JSON.stringify({ enabled: true, rules }) });

// min_daily 8h on weekdays; requiresClockin/activeWindow overridable
const minRule = (over = {}) =>
  otConfig([{ id: 'm', type: 'min_daily', when: { kind: 'weekdays', days: [1, 2, 3, 4, 5] }, hours: 8, ...over }]);

describe('parse defaults', () => {
  test('requiresClockin defaults true, activeWindow defaults week', () => {
    const cfg = minRule();
    expect(cfg.minDailyRules[0].requiresClockin).toBe(true);
    expect(cfg.minDailyRules[0].activeWindow).toBe('week');
  });
  test('explicit false / period round-trip', () => {
    const cfg = minRule({ requiresClockin: false, activeWindow: 'period' });
    expect(cfg.minDailyRules[0].requiresClockin).toBe(false);
    expect(cfg.minDailyRules[0].activeWindow).toBe('period');
  });
});

describe('backward compatibility', () => {
  const worked = [e(W1.MON, '08:00', '16:00')]; // one 8h Monday, week 1

  test('requiresClockin=true → absent days never paid, even with a range', () => {
    const r = computeOT(worked, 'daily', 8, 1, minRule(), RANGE);
    expect(r.regularHours).toBeCloseTo(8); // only the worked Monday
  });

  test('requiresClockin=false but NO range → no synthesis (unchanged)', () => {
    const r = computeOT(worked, 'daily', 8, 1, minRule({ requiresClockin: false }), null);
    expect(r.regularHours).toBeCloseTo(8);
  });

  test('the per-day floor still tops a short WORKED day', () => {
    const short = [e(W1.MON, '08:00', '10:00')]; // 2h Monday
    const r = computeOT(short, 'daily', 8, 1, minRule({ requiresClockin: false }), null);
    expect(r.regularHours).toBeCloseTo(8); // floored, no range needed for worked days
  });
});

describe('activeWindow = week', () => {
  test('absent weekdays in a WORKED week are guaranteed; an absent week is not', () => {
    // Worked only Monday of week 1 (8h). Range covers weeks 1 and 2.
    const r = computeOT([e(W1.MON, '08:00', '16:00')], 'daily', 8, 1, minRule({ requiresClockin: false, activeWindow: 'week' }), RANGE);
    // Week 1: Mon worked 8 + Tue/Wed/Thu/Fri guaranteed 8 each = 8 + 32 = 40.
    // Week 2: no clock-in that week → nothing.
    expect(r.regularHours).toBeCloseTo(40);
    expect(r.overtimeHours).toBeCloseTo(0);
  });
});

describe('activeWindow = period', () => {
  test('absent weekdays across the whole period are guaranteed once they worked at all', () => {
    const r = computeOT([e(W1.MON, '08:00', '16:00')], 'daily', 8, 1, minRule({ requiresClockin: false, activeWindow: 'period' }), RANGE);
    // Week 1: 8 (Mon) + 32 (Tue–Fri). Week 2: all 5 weekdays (07-13..17) guaranteed = 40. Total 80.
    expect(r.regularHours).toBeCloseTo(80);
    expect(r.overtimeHours).toBeCloseTo(0);
  });

  test('a worker who never clocked in at all is paid nothing', () => {
    const r = computeOT([], 'daily', 8, 1, minRule({ requiresClockin: false, activeWindow: 'period' }), RANGE);
    expect(r.regularHours).toBeCloseTo(0);
  });
});

// One-week range (Mon 07-06 … Sun 07-12), weekStart Monday.
const WK = { from: '2026-07-06', to: '2026-07-12' };
const daysWorked = (dates) => dates.map(d => e(d, '08:00', '16:00')); // 8h each

describe('activeWindow = every_weekday (guarantee a weekday if all OTHER weekdays were worked)', () => {
  // Rule targets Friday only.
  const fri = () => otConfig([{ id: 'm', type: 'min_daily', when: { kind: 'weekdays', days: [5] }, hours: 8, requiresClockin: false, activeWindow: 'every_weekday' }]);
  test('empty Friday is guaranteed when Mon–Thu were worked', () => {
    const r = computeOT(daysWorked(['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09']), 'daily', 8, 1, fri(), WK);
    expect(r.regularHours).toBeCloseTo(40); // 32 worked + 8 guaranteed Friday
  });
  test('not guaranteed when a weekday (Thu) is missing', () => {
    const r = computeOT(daysWorked(['2026-07-06', '2026-07-07', '2026-07-08']), 'daily', 8, 1, fri(), WK);
    expect(r.regularHours).toBeCloseTo(24); // Friday not earned
  });

  // Weekend TARGET: a Sunday rule on 'every_weekday' should pay once Mon–Fri were
  // worked — Saturday is irrelevant (it's not a weekday). Regression for the case
  // that confused a real setup: Sat had no clock-in but the Sunday still earns.
  const sunWk = () => otConfig([{ id: 'm', type: 'min_daily', when: { kind: 'weekdays', days: [0] }, hours: 8, requiresClockin: false, activeWindow: 'every_weekday' }]);
  test('empty Sunday is guaranteed when Mon–Fri were worked (Saturday irrelevant)', () => {
    // Mon–Fri only; no Saturday clock-in.
    const r = computeOT(daysWorked(['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10']), 'daily', 8, 1, sunWk(), WK);
    expect(r.regularHours).toBeCloseTo(48); // 40 worked + 8 guaranteed Sunday
  });
  test('Sunday not guaranteed when a weekday (Wed) is missing', () => {
    const r = computeOT(daysWorked(['2026-07-06', '2026-07-07', '2026-07-09', '2026-07-10']), 'daily', 8, 1, sunWk(), WK);
    expect(r.regularHours).toBeCloseTo(32); // Sunday not earned
  });
});

describe('week gate consults attendance OUTSIDE the pulled range (pay-rule window principle)', () => {
  // Sunday guarantee on "every weekday that week". Range starts Tuesday, so Monday
  // (07-06) is out of the pulled range. The gate must still see the real Monday
  // clock-in via range.workedDays, or the earned Sunday guarantee flickers away.
  const sunWk = () => otConfig([{ id: 'm', type: 'min_daily', when: { kind: 'weekdays', days: [0] }, hours: 8, requiresClockin: false, activeWindow: 'every_weekday' }]);
  const RANGE_TUE = { from: '2026-07-07', to: '2026-07-12' }; // Tue → Sun; Monday 07-06 excluded
  const tueToFri = daysWorked(['2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10']);
  test('without the widened attendance, clipping Monday drops the Sunday guarantee', () => {
    const r = computeOT(tueToFri, 'daily', 8, 1, sunWk(), RANGE_TUE);
    expect(r.regularHours).toBeCloseTo(32); // Sunday not earned — Monday unseen
  });
  test('Monday supplied via range.workedDays → Sunday still earns its 8h', () => {
    const r = computeOT(tueToFri, 'daily', 8, 1, sunWk(), { ...RANGE_TUE, workedDays: new Set(['2026-07-06']) });
    expect(r.regularHours).toBeCloseTo(40); // 32 worked + 8 guaranteed Sunday
  });
});

describe('rest day and a no-clock-in guarantee coexist', () => {
  // A rest-day rule and a min_daily no-clock-in guarantee on the same day are NOT
  // contradictory: an EMPTY rest day still earns the guarantee at the regular rate,
  // while an actually-worked rest day is paid at the rest-day premium. The guarantee
  // is opt-in per day, so if an admin created it for a rest day it should pay.
  const sunGuarantee = { id: 'm', type: 'min_daily', when: { kind: 'weekdays', days: [0] }, hours: 8, requiresClockin: false, activeWindow: 'every_weekday' };
  const restSun = { id: 'rest', type: 'rest_day', when: { kind: 'weekdays', days: [0] }, mult: 2 };
  const monFri = ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10'];
  test('Sunday guarantee fires without a rest-day rule', () => {
    const r = computeOT(daysWorked(monFri), 'daily', 8, 1, otConfig([sunGuarantee]), WK);
    expect(r.regularHours).toBeCloseTo(48); // 40 worked + 8 guaranteed Sunday
  });
  test('empty rest-day Sunday still earns the guarantee at regular rate', () => {
    const r = computeOT(daysWorked(monFri), 'daily', 8, 1, otConfig([restSun, sunGuarantee]), WK);
    expect(r.regularHours).toBeCloseTo(48);   // 40 worked + 8 guaranteed (regular)
    expect(r.overtimeHours).toBeCloseTo(0);   // guaranteed hours are NOT the rest-day premium
  });
  test('a WORKED rest-day Sunday is paid the rest-day premium, not the guarantee', () => {
    // Mon–Fri + a worked Sunday 07-12 (8h). The worked day takes the rest-day
    // premium; the guarantee only fills empty days, so it does not also apply here.
    const r = computeOT(daysWorked([...monFri, '2026-07-12']), 'daily', 8, 1, otConfig([restSun, sunGuarantee]), WK);
    expect(r.regularHours).toBeCloseTo(40);          // just the Mon–Fri worked hours
    expect(r.overtimeHours).toBeCloseTo(8);          // Sunday 8h at the rest-day premium
    expect(r.otBands).toEqual([{ hours: 8, mult: 2 }]);
  });
});

describe('activeWindow = every_other_day (guarantee a day if EVERY other day of the week was worked)', () => {
  // Rule targets Sunday only.
  const sun = () => otConfig([{ id: 'm', type: 'min_daily', when: { kind: 'weekdays', days: [0] }, hours: 8, requiresClockin: false, activeWindow: 'every_other_day' }]);
  test('empty Sunday is guaranteed when Mon–Sat were all worked', () => {
    const r = computeOT(daysWorked(['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11']), 'daily', 8, 1, sun(), WK);
    expect(r.regularHours).toBeCloseTo(56); // 48 worked + 8 guaranteed Sunday
  });
  test('not guaranteed when a day (Sat) is missing', () => {
    const r = computeOT(daysWorked(['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10']), 'daily', 8, 1, sun(), WK);
    expect(r.regularHours).toBeCloseTo(40); // Sunday not earned
  });
});
