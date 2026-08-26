/**
 * Premium rules (Phase 3): rest_day, min_daily, seventh_day, night_diff as
 * custom rules. rest_day / seventh_day / night_diff feed the existing otConfig
 * (computeOT + nightPremiumCost unchanged); min_daily resolves per bucket. With
 * no premium rules everything is unchanged (the 95 payCalculations tests + the
 * fixed-slot premium tests still pass).
 */

const { computeOT, nightPremiumCost, annotateEntryOvertime } = require('../utils/payCalculations');
const { parsePolicy, otConfigFromSettings } = require('../utils/hoursRules');

const MON = '2026-07-06'; // weekdayOf === 1
const SAT = '2026-07-11'; // weekdayOf === 6
const e = (work_date, start_time, end_time, extra = {}) => ({ wage_type: 'regular', break_minutes: 0, work_date, start_time, end_time, ...extra });
const otConfig = (rules) => otConfigFromSettings({ hours_rules: JSON.stringify({ enabled: true, rules }) });

describe('rest_day rule', () => {
  test('Saturday whole day at 2× via a weekday-scoped rest_day rule', () => {
    const cfg = otConfig([{ id: 'r', type: 'rest_day', when: { kind: 'weekdays', days: [6] }, mult: 2 }]);
    expect(cfg.restDay).toEqual({ mult: 2, days: [6], ruleId: 'r' });
    const sat = computeOT([e(SAT, '08:00', '14:00')], 'daily', 8, 1, cfg); // 6h Saturday → all OT @2×
    expect(sat.regularHours).toBeCloseTo(0);
    expect(sat.overtimeHours).toBeCloseTo(6);
    expect(sat.otBands).toEqual([{ hours: 6, mult: 2 }]);
    const mon = computeOT([e(MON, '08:00', '14:00')], 'daily', 8, 1, cfg); // weekday → normal (6h reg)
    expect(mon.regularHours).toBeCloseTo(6);
    expect(mon.overtimeHours).toBeCloseTo(0);
  });
});

describe('explain: overtime carries the driving rule id (report deep-link)', () => {
  const SUN = '2026-07-12'; // weekdayOf === 0
  test('rest_day, seventh_day, and window OT each set entry.overtime_ruleId', () => {
    // rest_day (Saturday): whole day OT → the rest_day rule id.
    const rest = otConfig([{ id: 'rest1', type: 'rest_day', when: { kind: 'weekdays', days: [6] }, mult: 2 }]);
    const satE = [e(SAT, '08:00', '14:00')];
    annotateEntryOvertime(satE, 'daily', 8, 1, rest);
    expect(satE[0].overtime_reason).toBe('rest_day');
    expect(satE[0].overtime_ruleId).toBe('rest1');

    // window_mult (Sunday all day 2×): window OT → the window rule id.
    const win = otConfig([{ id: 'win1', type: 'window_mult', when: { kind: 'weekdays', days: [0] }, from: '05:00', to: '05:00', mult: 2 }]);
    const sunE = [e(SUN, '08:00', '12:00')];
    annotateEntryOvertime(sunE, 'daily', 8, 1, win);
    expect(sunE[0].overtime_reason).toBe('window');
    expect(sunE[0].overtime_ruleId).toBe('win1');

    // seventh_day: the 7th consecutive day → the seventh_day rule id.
    const sd = otConfig([{ id: 'sd1', type: 'seventh_day', when: { kind: 'every_day' }, firstHours: 0, firstMult: 2, afterMult: 2 }]);
    const week = ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12']
      .map(d => e(d, '08:00', '16:00'));
    annotateEntryOvertime(week, 'daily', 8, 1, sd);
    const seventh = week[6];
    expect(seventh.overtime_reason).toBe('seventh_day');
    expect(seventh.overtime_ruleId).toBe('sd1');

    // ot_tier: threshold OT driven by a custom tier → the tier rule id.
    const tier = otConfig([{ id: 'tier1', type: 'ot_tier', when: { kind: 'every_day' }, basis: 'day', afterHours: 6, mult: 2 }]);
    const tierE = [e(MON, '08:00', '17:00')]; // 9h, tier split at 6 → 3h OT
    annotateEntryOvertime(tierE, 'daily', 8, 1, tier);
    expect(tierE[0].overtime_reason).toBe('daily');
    expect(tierE[0].overtime_ruleId).toBe('tier1');

    // base daily threshold (no premium rule): overtime, but NO rule id (it's a setting).
    const plain = otConfig([]);
    const longDay = [e(MON, '06:00', '18:00')]; // 12h → 4h OT past 8
    annotateEntryOvertime(longDay, 'daily', 8, 1, plain);
    expect(longDay[0].overtime_reason).toBe('daily');
    expect(longDay[0].overtime_ruleId).toBeNull();
  });
});

describe('min_daily rule (per-bucket, scoped)', () => {
  test('weekday floor tops a short day; a non-matching day is untouched', () => {
    const cfg = otConfig([{ id: 'm', type: 'min_daily', when: { kind: 'weekdays', days: [1, 2, 3, 4, 5] }, hours: 4 }]);
    const mon = computeOT([e(MON, '08:00', '10:00')], 'daily', 8, 1, cfg); // 2h weekday → floored to 4 reg
    expect(mon.regularHours).toBeCloseTo(4);
    expect(mon.overtimeHours).toBeCloseTo(0);
    const sat = computeOT([e(SAT, '08:00', '10:00')], 'daily', 8, 1, cfg); // 2h Saturday, not scoped → 2 reg
    expect(sat.regularHours).toBeCloseTo(2);
  });
});

describe('seventh_day rule', () => {
  test('7 consecutive worked days → the 7th is whole-day OT', () => {
    const cfg = otConfig([{ id: 's', type: 'seventh_day', when: { kind: 'every_day' }, firstHours: 8, firstMult: 1.5, afterMult: 2 }]);
    expect(cfg.seventhDay).toMatchObject({ enabled: true, firstHoursThreshold: 8, firstMult: 1.5, afterMult: 2 });
    const week = ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12']
      .map(d => e(d, '08:00', '16:00')); // 8h × 7 days (Mon–Sun), weekStart Monday
    const r = computeOT(week, 'daily', 8, 1, cfg);
    expect(r.regularHours).toBeCloseTo(48); // 6 days × 8h
    expect(r.overtimeHours).toBeCloseTo(8); // 7th day (Sunday), all OT
  });
});

describe('night_diff rule', () => {
  test('populates the night differential; nightPremiumCost prices the window', () => {
    const cfg = otConfig([{ id: 'n', type: 'night_diff', when: { kind: 'every_day' }, fromHour: 22, toHour: 5, pct: 10 }]);
    expect(cfg.nightDifferential).toMatchObject({ fromHour: 22, toHour: 5, pct: 10 });
    const cost = nightPremiumCost([e(MON, '22:00', '02:00')], cfg.nightDifferential, 10); // 4 night hrs × $10 × 10%
    expect(cost).toBeCloseTo(4);
  });
});

describe('premium rules — parse & no-op', () => {
  test('parse drops premiums with a bad multiplier / percentage', () => {
    const p = parsePolicy(JSON.stringify({ enabled: true, rules: [
      { id: 'a', type: 'rest_day', when: { kind: 'weekdays', days: [6] }, mult: 0 },   // mult<=0 → dropped
      { id: 'b', type: 'night_diff', when: { kind: 'every_day' }, fromHour: 22, toHour: 5, pct: 0 }, // pct<=0 → dropped
      { id: 'c', type: 'min_daily', when: { kind: 'every_day' }, hours: 4 },            // valid
    ] }));
    const kinds = p.rules.map(r => r.type);
    expect(kinds).toEqual(['min_daily']);
  });

  test('no premium rules → otConfig has no premiums', () => {
    expect(otConfig([])).toBeNull();
  });
});
