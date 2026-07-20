/**
 * migrateFixedSlots — Phase 4 safety proof. Converting a policy's fixed-slot
 * config into custom rules must not change anyone's pay. This runs the SAME
 * entries through the original (fixed-slot) policy and the migrated (rules-only)
 * policy and asserts identical results — rounding, regular/OT hours, and OT cost.
 */

const {
  migrateFixedSlots, hasFixedSlots, roundEntriesFromSettings, otConfigFromSettings,
} = require('../utils/hoursRules');
const { computeOT, otBandsCost, nightPremiumCost } = require('../utils/payCalculations');

// A representative company: schedule Mon–Fri 08–17, quarter-hour rounding in the
// worker's favor, California-style daily OT tiers + 7th day, and premiums.
const FIXED = {
  enabled: true,
  standardHours: Object.fromEntries([1, 2, 3, 4, 5].map(d => [String(d), { start: '08:00', end: '17:00' }])),
  rounding: {
    clockIn:  { reference: 'clock', intervalMin: 15, graceMin: 0, direction: 'nearest' },
    clockOut: { reference: 'clock', intervalMin: 15, graceMin: 0, direction: 'nearest' },
  },
  overtime: {
    dailyBands: [{ afterHours: 8, mult: 1.5 }, { afterHours: 12, mult: 2 }],
    seventhDay: { enabled: true, firstHoursThreshold: 8, firstMult: 1.5, afterMult: 2 },
  },
  premiums: {
    restDayMult: 2,          // Sat/Sun (not in workDays) → whole day @2×
    minDailyHours: 4,
    nightDifferential: { fromHour: 22, toHour: 5, pct: 10 },
  },
  rules: [],
};

const WEEK = ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12'];
const entries = WEEK.map(d => ({ user_id: 1, wage_type: 'regular', work_date: d, start_time: '07:07:00', end_time: '18:22:00', break_minutes: 0 }));

const settings = raw => ({ hours_rules: JSON.stringify(raw) });

describe('migrateFixedSlots — round-trip equivalence', () => {
  const migrated = migrateFixedSlots(FIXED);

  test('the fixed slots are cleared and turned into rules', () => {
    expect(hasFixedSlots(FIXED)).toBe(true);
    expect(hasFixedSlots(migrated)).toBe(false);
    expect(migrated.overtime).toEqual({});
    expect(migrated.premiums).toEqual({});
    // one rule per: 2 rounding edges, 2 OT tiers, 7th-day, rest-day, min-daily, night
    const kinds = migrated.rules.map(r => r.type).sort();
    expect(kinds).toEqual(['min_daily', 'night_diff', 'ot_tier', 'ot_tier', 'rest_day', 'round', 'round', 'seventh_day']);
    expect(migrated.standardHours).toEqual(FIXED.standardHours); // schedule preserved
  });

  test('rounding is identical after migration', () => {
    const orig = roundEntriesFromSettings(entries.map(e => ({ ...e })), settings(FIXED));
    const mig  = roundEntriesFromSettings(entries.map(e => ({ ...e })), settings(migrated));
    expect(mig.map(e => [e.start_time, e.end_time])).toEqual(orig.map(e => [e.start_time, e.end_time]));
  });

  test('regular/OT hours and OT cost are identical after migration', () => {
    const rate = 20;
    const run = raw => {
      const rounded = roundEntriesFromSettings(entries.map(e => ({ ...e })), settings(raw));
      const cfg = otConfigFromSettings(settings(raw));
      const ot = computeOT(rounded, 'daily', 8, 1, cfg);
      const cost = otBandsCost(ot.otBands, rate, 1.5) + nightPremiumCost(rounded, cfg && cfg.nightDifferential, rate);
      return { reg: ot.regularHours, ot: ot.overtimeHours, cost };
    };
    const a = run(FIXED), b = run(migrated);
    expect(b.reg).toBeCloseTo(a.reg, 6);
    expect(b.ot).toBeCloseTo(a.ot, 6);
    expect(b.cost).toBeCloseTo(a.cost, 6);
  });

  test('a policy with no fixed slots is a no-op (idempotent)', () => {
    const rulesOnly = migrateFixedSlots(FIXED);
    const again = migrateFixedSlots(rulesOnly);
    expect(again.rules.map(r => r.type).sort()).toEqual(rulesOnly.rules.map(r => r.type).sort());
    expect(hasFixedSlots(again)).toBe(false);
    expect(hasFixedSlots({ enabled: true, rules: [] })).toBe(false);
  });
});
