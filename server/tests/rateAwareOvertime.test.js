/**
 * Rate-aware overtime — the scenario matrix from docs/plans/rate-aware-overtime.md,
 * as executable expected-pay assertions. These ARE the spec of "accurate": each
 * row is a real-world situation with the dollars that situation should pay, so the
 * money math is reviewable without reading engine code.
 *
 * Method: 'rate_when_worked' (default) prices each OT hour at the rate it earned;
 * 'weighted_average' uses the FLSA blended regular rate. All hours count toward
 * ONE threshold regardless of wage_type.
 */

const { rateAwarePay, splitRateAware, hasSimpleOtConfig } = require('../utils/rateAwareOvertime');

// One entry. Rate is decided by baseRateOf per test (by wage_type / project).
const mk = (work_date, start, end, wage_type = 'regular', project_id = null, break_minutes = 0) =>
  ({ work_date, start_time: `${start}:00`, end_time: `${end}:00`, wage_type, project_id, break_minutes });

// prevailing → $45, civilian → $30 (the Oregon excavator's two rates)
const excavatorRate = e => (e.wage_type === 'prevailing' ? 45 : 30);
const flat = r => () => r;

const MON = '2026-07-06', TUE = '2026-07-07', WED = '2026-07-08',
      THU = '2026-07-09', FRI = '2026-07-10', SAT = '2026-07-11';

describe('rate_when_worked (default)', () => {
  test('A: excavator — 6h prevailing @45 THEN 4h civilian @30, daily-8 → $420', () => {
    const entries = [
      mk(MON, '06:00', '12:00', 'prevailing', 1), // 6h @45
      mk(MON, '12:00', '16:00', 'regular'),        // 4h @30 (last 2h are OT)
    ];
    const r = rateAwarePay(entries, { rule: 'daily', threshold: 8, otMult: 1.5, baseRateOf: excavatorRate });
    expect(r.straightHours).toBeCloseTo(8, 5);
    expect(r.overtimeHours).toBeCloseTo(2, 5);
    expect(r.cost).toBeCloseTo(420, 2); // 6*45 + 2*30 + 2*30*1.5
  });

  test('B: same day, civilian FIRST then prevailing → $435 (order matters)', () => {
    const entries = [
      mk(MON, '06:00', '10:00', 'regular'),        // 4h @30
      mk(MON, '10:00', '16:00', 'prevailing', 1),  // 6h @45 (last 2h are OT)
    ];
    const r = rateAwarePay(entries, { rule: 'daily', threshold: 8, otMult: 1.5, baseRateOf: excavatorRate });
    expect(r.cost).toBeCloseTo(435, 2); // 4*30 + 4*45 + 2*45*1.5
  });

  test('C: Kentucky call center — 45h regular @18, weekly-40 → $855', () => {
    const entries = [MON, TUE, WED, THU, FRI].map(d => mk(d, '08:00', '17:00')); // 5 × 9h = 45h
    const r = rateAwarePay(entries, { rule: 'weekly', threshold: 40, otMult: 1.5, baseRateOf: flat(18) });
    expect(r.straightHours).toBeCloseTo(40, 5);
    expect(r.overtimeHours).toBeCloseTo(5, 5);
    expect(r.cost).toBeCloseTo(855, 2); // 40*18 + 5*18*1.5
  });

  test('D: Honduras elevator co — 9h @L.100, daily-8, 1.25× → L.925', () => {
    const r = rateAwarePay([mk(MON, '08:00', '17:00')], { rule: 'daily', threshold: 8, otMult: 1.25, baseRateOf: flat(100) });
    expect(r.cost).toBeCloseTo(925, 2); // 8*100 + 1*100*1.25
  });

  test('E: pure prevailing week — 48h @45, weekly-40 → $2,340 (the WH-347 core case)', () => {
    const entries = [MON, TUE, WED, THU, FRI, SAT].map(d => mk(d, '08:00', '16:00', 'prevailing', 1)); // 6 × 8h = 48h
    const r = rateAwarePay(entries, { rule: 'weekly', threshold: 40, otMult: 1.5, baseRateOf: flat(45) });
    expect(r.overtimeHours).toBeCloseTo(8, 5);
    expect(r.cost).toBeCloseTo(2340, 2); // 40*45 + 8*45*1.5
  });

  test('F: break longer than the shift clamps to 0 (never negative)', () => {
    const r = rateAwarePay([mk(MON, '08:00', '09:00', 'regular', null, 120)], { rule: 'daily', threshold: 8, otMult: 1.5, baseRateOf: flat(30) });
    expect(r.straightHours).toBeCloseTo(0, 5);
    expect(r.cost).toBeCloseTo(0, 2);
  });

  test('rule "none" pays every hour straight (OT turned off)', () => {
    const entries = [mk(MON, '06:00', '18:00', 'prevailing', 1)]; // 12h
    const r = rateAwarePay(entries, { rule: 'none', threshold: 8, otMult: 1.5, baseRateOf: flat(45) });
    expect(r.overtimeHours).toBeCloseTo(0, 5);
    expect(r.cost).toBeCloseTo(12 * 45, 2);
  });
});

describe('overtime_wage_priority = regular_first (opt-in — OT off regular first, keep prevailing whole)', () => {
  // The requested scenario: 3h regular THEN 6h prevailing, daily-8.
  const scenario = [
    mk(MON, '06:00', '09:00', 'regular'),        // 3h @30
    mk(MON, '09:00', '15:00', 'prevailing', 1),  // 6h @45
  ];

  test('default (chronological) puts the OT hour on the later prevailing hour', () => {
    const s = splitRateAware(scenario, { rule: 'daily', threshold: 8, otMult: 1.5, baseRateOf: excavatorRate });
    expect(s.prevailingHours).toBeCloseTo(5, 5);   // 1 PW hour became OT
    expect(s.regularHours).toBeCloseTo(3, 5);
    expect(s.overtimeHours).toBeCloseTo(1, 5);
    const r = rateAwarePay(scenario, { rule: 'daily', threshold: 8, otMult: 1.5, baseRateOf: excavatorRate });
    expect(r.cost).toBeCloseTo(382.5, 2); // 3*30 + 5*45 + 1*45*1.5
  });

  test('regular_first → 6 PW straight, 2 regular straight, 1 REGULAR OT', () => {
    const opts = { rule: 'daily', threshold: 8, otMult: 1.5, baseRateOf: excavatorRate, wagePriority: 'regular_first' };
    const s = splitRateAware(scenario, opts);
    expect(s.prevailingHours).toBeCloseTo(6, 5); // all prevailing stays straight
    expect(s.regularHours).toBeCloseTo(2, 5);
    expect(s.overtimeHours).toBeCloseTo(1, 5);
    const r = rateAwarePay(scenario, opts);
    expect(r.cost).toBeCloseTo(375, 2); // 6*45 + 2*30 + 1*30*1.5  (OT at the regular rate)
  });

  test('the inverse of Test B: civilian-first-then-PW no longer makes prevailing OT', () => {
    const entries = [
      mk(MON, '06:00', '10:00', 'regular'),        // 4h @30
      mk(MON, '10:00', '16:00', 'prevailing', 1),  // 6h @45
    ];
    const s = splitRateAware(entries, { rule: 'daily', threshold: 8, otMult: 1.5, baseRateOf: excavatorRate, wagePriority: 'regular_first' });
    expect(s.prevailingHours).toBeCloseTo(6, 5);
    expect(s.regularHours).toBeCloseTo(2, 5);
    expect(s.overtimeHours).toBeCloseTo(2, 5);
    const r = rateAwarePay(entries, { rule: 'daily', threshold: 8, otMult: 1.5, baseRateOf: excavatorRate, wagePriority: 'regular_first' });
    expect(r.cost).toBeCloseTo(420, 2); // 6*45 + 2*30 + 2*30*1.5  (was $435 prevailing-OT under chronological)
  });

  test('spillover: when regular hours < OT, the excess OT still falls on prevailing', () => {
    const entries = [
      mk(MON, '06:00', '06:30', 'regular'),        // 0.5h @30
      mk(MON, '06:30', '15:30', 'prevailing', 1),  // 9h @45
    ]; // 9.5h, daily-8 → 1.5h OT; only 0.5h regular to absorb
    const s = splitRateAware(entries, { rule: 'daily', threshold: 8, otMult: 1.5, baseRateOf: excavatorRate, wagePriority: 'regular_first' });
    expect(s.prevailingHours).toBeCloseTo(8, 5);   // 1 PW hour spilled into OT
    expect(s.regularHours).toBeCloseTo(0, 5);       // all 0.5 regular went to OT
    expect(s.overtimeHours).toBeCloseTo(1.5, 5);
    const r = rateAwarePay(entries, { rule: 'daily', threshold: 8, otMult: 1.5, baseRateOf: excavatorRate, wagePriority: 'regular_first' });
    expect(r.cost).toBeCloseTo(450, 2); // 8*45 + 1*45*1.5 + 0.5*30*1.5
  });

  test('pure prevailing over the threshold is unchanged (nothing to protect)', () => {
    const entries = [mk(MON, '06:00', '16:00', 'prevailing', 1)]; // 10h
    const chrono = rateAwarePay(entries, { rule: 'daily', threshold: 8, otMult: 1.5, baseRateOf: flat(45) });
    const regfirst = rateAwarePay(entries, { rule: 'daily', threshold: 8, otMult: 1.5, baseRateOf: flat(45), wagePriority: 'regular_first' });
    expect(regfirst.cost).toBeCloseTo(chrono.cost, 2);
    expect(regfirst.cost).toBeCloseTo(495, 2); // 8*45 + 2*45*1.5
  });

  test('weekly rule: mixed week draws the weekly OT off regular first', () => {
    const entries = [
      mk(MON, '08:00', '16:00', 'prevailing', 1), // 8h PW
      mk(TUE, '08:00', '16:00', 'prevailing', 1), // 8h PW
      mk(WED, '08:00', '16:00', 'prevailing', 1), // 8h PW
      mk(THU, '08:00', '16:00', 'prevailing', 1), // 8h PW  (32 PW)
      mk(FRI, '08:00', '17:00', 'regular'),        // 9h reg (41 total → 1h OT)
    ];
    const s = splitRateAware(entries, { rule: 'weekly', threshold: 40, weekStart: 1, otMult: 1.5, baseRateOf: excavatorRate, wagePriority: 'regular_first' });
    expect(s.prevailingHours).toBeCloseTo(32, 5); // all PW straight
    expect(s.regularHours).toBeCloseTo(8, 5);
    expect(s.overtimeHours).toBeCloseTo(1, 5);     // the 1 OT hour is regular
  });
});

describe('weighted_average (opt-in)', () => {
  test('mixed week 30h @45 + 15h @30 (45h, weekly-40) → $1,900', () => {
    const entries = [
      mk(MON, '07:00', '17:00', 'prevailing', 1), // 10h @45
      mk(TUE, '07:00', '17:00', 'prevailing', 1), // 10h @45
      mk(WED, '07:00', '17:00', 'prevailing', 1), // 10h @45
      mk(THU, '07:00', '17:00', 'regular'),        // 10h @30
      mk(FRI, '08:00', '13:00', 'regular'),        // 5h  @30
    ];
    const r = rateAwarePay(entries, { rule: 'weekly', threshold: 40, otMult: 1.5, baseRateOf: excavatorRate, method: 'weighted_average' });
    // straight = 30*45 + 15*30 = 1800; regRate = 1800/45 = 40; premium = 5*40*0.5 = 100
    expect(r.cost).toBeCloseTo(1900, 2);
  });
});

describe('hasSimpleOtConfig — gate to the per-band engine', () => {
  test('plain / no config → rate-aware path', () => {
    expect(hasSimpleOtConfig(null)).toBe(true);
    expect(hasSimpleOtConfig({ dailyBands: [], weeklyBands: [], tierRules: [] })).toBe(true);
  });
  test('fixed-slot tiered bands must NOT flatten to one multiplier (per-band path)', () => {
    // California-style stored as fixed-slot bands — otConfigFromSettings emits
    // these un-migrated. Missing this routed them through the flat rate-aware
    // path and silently dropped the 2× tier.
    expect(hasSimpleOtConfig({ dailyBands: [{ afterHours: 8, mult: 1.5 }, { afterHours: 12, mult: 2 }] })).toBe(false);
    expect(hasSimpleOtConfig({ weeklyBands: [{ afterHours: 40, mult: 1.5 }] })).toBe(false);
  });
  test('other premiums also route to the per-band path', () => {
    expect(hasSimpleOtConfig({ tierRules: [{}] })).toBe(false);
    expect(hasSimpleOtConfig({ restDay: { mult: 2, days: [0] } })).toBe(false);
    expect(hasSimpleOtConfig({ seventhDay: { enabled: true } })).toBe(false);
    expect(hasSimpleOtConfig({ nightDifferential: { pct: 10 } })).toBe(false);
    expect(hasSimpleOtConfig({ minDailyHours: 4 })).toBe(false);
    expect(hasSimpleOtConfig({ windowRules: [{}] })).toBe(false);
  });
});

describe('invariant: single rate → both methods agree', () => {
  test('45h all @18, weekly-40 → $855 either way', () => {
    const entries = [MON, TUE, WED, THU, FRI].map(d => mk(d, '08:00', '17:00'));
    const rw = rateAwarePay(entries, { rule: 'weekly', threshold: 40, otMult: 1.5, baseRateOf: flat(18), method: 'rate_when_worked' });
    const wa = rateAwarePay(entries, { rule: 'weekly', threshold: 40, otMult: 1.5, baseRateOf: flat(18), method: 'weighted_average' });
    expect(rw.cost).toBeCloseTo(855, 2);
    expect(wa.cost).toBeCloseTo(855, 2);
  });
});
