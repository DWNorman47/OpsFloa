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

const { rateAwarePay, hasSimpleOtConfig } = require('../utils/rateAwareOvertime');

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
