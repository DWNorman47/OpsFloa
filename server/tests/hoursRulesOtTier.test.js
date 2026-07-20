/**
 * `ot_tier` rule (Phase 2 of migrating the fixed slots into the custom-rule
 * builder). An ot_tier rule defines an overtime band, resolved per bucket in
 * computeOT — so a `when`-scoped rule sets different tiers on different days.
 * With no ot_tier rules, computeOT is byte-identical to before (covered by the
 * existing 95 payCalculations tests).
 */

const { computeOT, annotateEntryOvertime, otBandsCost } = require('../utils/payCalculations');
const { parsePolicy, otConfigFromSettings } = require('../utils/hoursRules');

// A Monday (weekdayOf('2026-07-06') === 1) and the Saturday of that week.
const MON = '2026-07-06';
const SAT = '2026-07-11';
const e = (work_date, start_time, end_time, extra = {}) => ({ wage_type: 'regular', break_minutes: 0, work_date, start_time, end_time, ...extra });

function otConfig(rules, extra = {}) {
  return otConfigFromSettings({ hours_rules: JSON.stringify({ enabled: true, rules, ...extra }) });
}

describe('ot_tier — single & tiered bands (daily)', () => {
  test('one tier: OT past 8h/day at 1.5×', () => {
    const cfg = otConfig([{ id: 't1', type: 'ot_tier', when: { kind: 'every_day' }, basis: 'day', afterHours: 8, mult: 1.5 }]);
    const r = computeOT([e(MON, '06:00', '17:00')], 'daily', 8, 1, cfg); // 11h → 8 reg, 3 OT
    expect(r.regularHours).toBeCloseTo(8);
    expect(r.overtimeHours).toBeCloseTo(3);
    expect(r.otBands).toEqual([{ hours: 3, mult: 1.5 }]);
  });

  test('two tiers compose: 8h→1.5×, 12h→2× (California-style)', () => {
    const cfg = otConfig([
      { id: 't1', type: 'ot_tier', when: { kind: 'every_day' }, basis: 'day', afterHours: 8, mult: 1.5 },
      { id: 't2', type: 'ot_tier', when: { kind: 'every_day' }, basis: 'day', afterHours: 12, mult: 2 },
    ]);
    const r = computeOT([e(MON, '05:00', '19:00')], 'daily', 8, 1, cfg); // 14h → 8 reg, 4 @1.5, 2 @2
    expect(r.regularHours).toBeCloseTo(8);
    expect(r.overtimeHours).toBeCloseTo(6);
    expect(otBandsCost(r.otBands, 10, 1.5)).toBeCloseTo(4 * 10 * 1.5 + 2 * 10 * 2); // $100
  });
});

describe('ot_tier — when-scoped (different tiers on different days)', () => {
  test('a Saturday-only tier changes only Saturday; weekdays use the default', () => {
    // Sat: OT after 0h (everything OT @2×). Weekdays fall back to the plain 8h threshold.
    const cfg = otConfig([{ id: 's', type: 'ot_tier', when: { kind: 'weekdays', days: [6] }, basis: 'day', afterHours: 0, mult: 2 }]);
    const mon = computeOT([e(MON, '06:00', '17:00')], 'daily', 8, 1, cfg); // weekday, no scoped tier → 8/3
    expect(mon.regularHours).toBeCloseTo(8);
    expect(mon.overtimeHours).toBeCloseTo(3);

    const sat = computeOT([e(SAT, '08:00', '12:00')], 'daily', 8, 1, cfg); // 4h, all OT @2×
    expect(sat.regularHours).toBeCloseTo(0);
    expect(sat.overtimeHours).toBeCloseTo(4);
    expect(sat.otBands).toEqual([{ hours: 4, mult: 2 }]);
  });
});

describe('ot_tier — parse + report reconciliation + backward compat', () => {
  test('parses and defaults a bad basis to "day"; drops a tier with no mult', () => {
    const p = parsePolicy(JSON.stringify({ enabled: true, rules: [
      { id: 'a', type: 'ot_tier', when: { kind: 'every_day' }, basis: 'fortnight', afterHours: 8, mult: 1.5 },
      { id: 'b', type: 'ot_tier', when: { kind: 'every_day' }, afterHours: 8 }, // no mult → dropped
    ] }));
    const tiers = p.rules.filter(r => r.type === 'ot_tier');
    expect(tiers).toHaveLength(1);
    expect(tiers[0]).toMatchObject({ basis: 'day', afterHours: 8, mult: 1.5 });
  });

  test('per-entry OT column reconciles with the summary under a scoped tier', () => {
    const cfg = otConfig([{ id: 't1', type: 'ot_tier', when: { kind: 'every_day' }, basis: 'day', afterHours: 8, mult: 1.5 }]);
    const entries = [e(MON, '06:00', '12:00'), e(MON, '13:00', '18:00')]; // 6h + 5h = 11h, 3h OT
    annotateEntryOvertime(entries, 'daily', 8, 1, cfg);
    const sum = entries.reduce((s, x) => s + x.overtime_hours, 0);
    expect(sum).toBeCloseTo(computeOT(entries.map(x => ({ ...x })), 'daily', 8, 1, cfg).overtimeHours);
    expect(sum).toBeCloseTo(3);
  });

  test('no ot_tier rules → plain single-tier OT (unchanged)', () => {
    const cfg = otConfig([]); // no OT config at all
    expect(cfg).toBeNull();
    const r = computeOT([e(MON, '06:00', '17:00')], 'daily', 8, 1, cfg); // 11h → 8/3, default mult
    expect(r.regularHours).toBeCloseTo(8);
    expect(r.overtimeHours).toBeCloseTo(3);
    expect(r.otBands).toEqual([{ hours: 3, mult: null }]);
  });
});
