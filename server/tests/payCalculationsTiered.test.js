/**
 * Tests for tiered overtime in computeOT / computeDailyPayCosts (Milestone 2).
 * The headline is California-style daily tiers (1.5× after 8h, 2× after 12h),
 * plus the guarantee that with no tiered config the output is byte-identical to
 * the single-tier behavior every existing pay calc relies on.
 */

const { computeOT, computeDailyPayCosts, otBandsCost } = require('../utils/payCalculations');

// One entry spanning `hours` decimal hours on a given date, no break.
function entry(date, hours, over = {}) {
  const end = `${String(Math.floor(hours)).padStart(2, '0')}:${String(Math.round((hours % 1) * 60)).padStart(2, '0')}:00`;
  return { wage_type: 'regular', work_date: date, start_time: '00:00:00', end_time: end, break_minutes: 0, ...over };
}

const CA = { dailyBands: [{ afterHours: 8, mult: 1.5 }, { afterHours: 12, mult: 2 }] };

describe('backward compatibility (no tiered config)', () => {
  test('single 10h day → 8 reg + 2 OT, one null-mult band', () => {
    const r = computeOT([entry('2026-07-06', 10)], 'daily', 8);
    expect(r.regularHours).toBeCloseTo(8, 5);
    expect(r.overtimeHours).toBeCloseTo(2, 5);
    expect(r.otBands).toEqual([{ hours: 2, mult: null }]);
  });
  test('no overtime → empty otBands', () => {
    const r = computeOT([entry('2026-07-06', 6)], 'daily', 8);
    expect(r.overtimeHours).toBeCloseTo(0, 5);
    expect(r.otBands).toEqual([]);
  });
});

describe('tiered daily OT (CA: 1.5× after 8, 2× after 12)', () => {
  test('13h day → 8 reg, 4h @1.5, 1h @2', () => {
    const r = computeOT([entry('2026-07-06', 13)], 'daily', 8, 1, CA);
    expect(r.regularHours).toBeCloseTo(8, 5);
    expect(r.overtimeHours).toBeCloseTo(5, 5);
    expect(r.otBands).toEqual([{ hours: 4, mult: 1.5 }, { hours: 1, mult: 2 }]);
  });
  test('10h day → 8 reg, 2h @1.5, nothing at 2×', () => {
    const r = computeOT([entry('2026-07-06', 10)], 'daily', 8, 1, CA);
    expect(r.otBands).toEqual([{ hours: 2, mult: 1.5 }]);
  });
  test('tiers are per-day, not summed across days', () => {
    // Two 10h days → each 2h @1.5; never crosses into the 2× tier.
    const r = computeOT([entry('2026-07-06', 10), entry('2026-07-07', 10)], 'daily', 8, 1, CA);
    expect(r.regularHours).toBeCloseTo(16, 5);
    expect(r.otBands).toEqual([{ hours: 4, mult: 1.5 }]);
  });
});

describe('otBandsCost pricing', () => {
  test('prices each tier at its own multiplier', () => {
    const bands = [{ hours: 4, mult: 1.5 }, { hours: 1, mult: 2 }];
    expect(otBandsCost(bands, 10, 1.5)).toBeCloseTo(4 * 10 * 1.5 + 1 * 10 * 2, 5); // 80
  });
  test('null-mult band falls back to the default multiplier (single-tier parity)', () => {
    expect(otBandsCost([{ hours: 2, mult: null }], 10, 1.5)).toBeCloseTo(2 * 10 * 1.5, 5); // 30
  });
  test('single-tier cost equals the old overtimeHours × rate × mult formula', () => {
    const rate = 20, mult = 1.5;
    const { overtimeHours, otBands } = computeOT([entry('2026-07-06', 11)], 'daily', 8);
    expect(otBandsCost(otBands, rate, mult)).toBeCloseTo(overtimeHours * rate * mult, 5);
  });
});

describe('override interaction', () => {
  test('overridden entry OT is priced at the default multiplier, not tiered', () => {
    const r = computeOT([entry('2026-07-06', 13, { overtime_hours_override: 3 })], 'daily', 8, 1, CA);
    expect(r.overtimeHours).toBeCloseTo(3, 5);   // override wins
    expect(r.regularHours).toBeCloseTo(10, 5);   // 13 total − 3 OT
    expect(r.otBands).toEqual([{ hours: 3, mult: null }]);
  });
});

describe('computeDailyPayCosts with tiers', () => {
  test('daily-rate OT priced per tier off dailyRate/threshold', () => {
    // dailyRate 160, threshold 8 → base OT hourly 20. 13h day → 4@1.5 + 1@2.
    const dc = computeDailyPayCosts([entry('2026-07-06', 13)], 'daily', 8, 160, 1.5, CA);
    expect(dc.regularCost).toBeCloseTo(160, 5);           // 1 day
    expect(dc.overtimeCost).toBeCloseTo(4 * 20 * 1.5 + 1 * 20 * 2, 5); // 160
  });
  test('no config → same as the pre-tiered daily formula', () => {
    const dc = computeDailyPayCosts([entry('2026-07-06', 11)], 'daily', 8, 160, 1.5);
    expect(dc.overtimeCost).toBeCloseTo(3 * 20 * 1.5, 5); // 3 OT hrs × (160/8) × 1.5
  });
});

describe('7th-consecutive-day premium (California)', () => {
  // Workweek Mon 2026-07-06 … Sun 2026-07-12 (weekStart = Monday).
  const WEEK = ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12'];
  const cfg = {
    dailyBands: [{ afterHours: 8, mult: 1.5 }, { afterHours: 12, mult: 2 }],
    seventhDay: { enabled: true, firstHoursThreshold: 8, firstMult: 1.5, afterMult: 2 },
  };

  test('all 7 days × 8h → 6 days regular, the 7th all OT @1.5', () => {
    const r = computeOT(WEEK.map(d => entry(d, 8)), 'daily', 8, 1, cfg);
    expect(r.regularHours).toBeCloseTo(48, 5);
    expect(r.overtimeHours).toBeCloseTo(8, 5);
    expect(r.otBands).toEqual([{ hours: 8, mult: 1.5 }]);
  });

  test('7th day of 10h → first 8h @1.5, remaining 2h @2 (no regular that day)', () => {
    const entries = WEEK.map((d, i) => entry(d, i === 6 ? 10 : 8));
    const r = computeOT(entries, 'daily', 8, 1, cfg);
    expect(r.regularHours).toBeCloseTo(48, 5);
    expect(r.otBands).toEqual([{ hours: 8, mult: 1.5 }, { hours: 2, mult: 2 }]);
  });

  test('only 6 days worked → no 7th-day premium, normal tiers apply', () => {
    // Mon–Sat, with Saturday a 10h day → 2h into the 1.5× tier, no 7th day.
    const entries = WEEK.slice(0, 6).map((d, i) => entry(d, i === 5 ? 10 : 8));
    const r = computeOT(entries, 'daily', 8, 1, cfg);
    expect(r.regularHours).toBeCloseTo(48, 5);
    expect(r.otBands).toEqual([{ hours: 2, mult: 1.5 }]);
  });

  test('disabled 7th-day config leaves the last day on normal tiers', () => {
    const r = computeOT(WEEK.map(d => entry(d, 8)), 'daily', 8, 1, { dailyBands: cfg.dailyBands });
    expect(r.regularHours).toBeCloseTo(56, 5); // all 7 days regular
    expect(r.overtimeHours).toBeCloseTo(0, 5);
  });
});

describe('weekly tiered OT', () => {
  test('weekly bands slice the week bucket', () => {
    const cfg = { weeklyBands: [{ afterHours: 40, mult: 1.5 }, { afterHours: 50, mult: 2 }] };
    // Five 11h days in one week = 55h → 40 reg, 10 @1.5, 5 @2.
    const days = ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10'];
    const r = computeOT(days.map(d => entry(d, 11)), 'weekly', 40, 1, cfg);
    expect(r.regularHours).toBeCloseTo(40, 5);
    expect(r.otBands).toEqual([{ hours: 10, mult: 1.5 }, { hours: 5, mult: 2 }]);
  });
});
