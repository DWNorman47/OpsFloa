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
