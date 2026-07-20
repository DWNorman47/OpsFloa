/**
 * The Hours & Rules presets now emit custom rules (client HoursRulesSettings
 * PRESETS). These mirror those rule arrays to guard two things: every rule parses
 * (a typo would be silently dropped), and the California preset pays exactly like
 * the old fixed-slot California it replaced.
 */

const { parseRules, otConfigFromSettings, roundEntriesFromSettings } = require('../utils/hoursRules');
const { computeOT } = require('../utils/payCalculations');

const EVERY = { kind: 'every_day' };
const PRESET_RULES = {
  honduras: [
    { id: 'p1', type: 'round', when: EVERY, edge: 'in', reference: 'schedule', direction: 'against_worker', intervalMin: 60, graceMin: 15 },
    { id: 'p2', type: 'round', when: EVERY, edge: 'out', reference: 'schedule', direction: 'toward_worker', intervalMin: 60, graceMin: 30 },
    { id: 'p3', type: 'rest_day', when: { kind: 'weekdays', days: [0] }, mult: 2 },
    { id: 'p4', type: 'night_diff', when: EVERY, fromHour: 19, toHour: 5, pct: 25 },
  ],
  us_quarter: [
    { id: 'p1', type: 'round', when: EVERY, edge: 'both', reference: 'clock', direction: 'nearest', intervalMin: 15, graceMin: 0 },
  ],
  california: [
    { id: 'p1', type: 'round', when: EVERY, edge: 'both', reference: 'clock', direction: 'nearest', intervalMin: 15, graceMin: 0 },
    { id: 'p2', type: 'ot_tier', when: EVERY, basis: 'day', afterHours: 8, mult: 1.5 },
    { id: 'p3', type: 'ot_tier', when: EVERY, basis: 'day', afterHours: 12, mult: 2 },
    { id: 'p4', type: 'seventh_day', when: EVERY, firstHours: 8, firstMult: 1.5, afterMult: 2 },
  ],
};

describe('preset rule arrays parse cleanly (no typo silently dropped)', () => {
  for (const [name, rules] of Object.entries(PRESET_RULES)) {
    test(`${name}: all ${rules.length} rules survive parse`, () => {
      expect(parseRules(rules)).toHaveLength(rules.length);
    });
  }
});

describe('California preset ≡ the old fixed-slot California', () => {
  const std = Object.fromEntries([1, 2, 3, 4, 5].map(d => [String(d), { start: '07:00', end: '16:00', unpaidBreakMin: 60 }]));
  const oldCA = {
    enabled: true, standardHours: std,
    rounding: { clockIn: { reference: 'clock', intervalMin: 15, graceMin: 0, direction: 'nearest' }, clockOut: { reference: 'clock', intervalMin: 15, graceMin: 0, direction: 'nearest' } },
    overtime: { dailyBands: [{ afterHours: 8, mult: 1.5 }, { afterHours: 12, mult: 2 }], seventhDay: { enabled: true, firstHoursThreshold: 8, firstMult: 1.5, afterMult: 2 } },
    premiums: {}, rules: [],
  };
  const newCA = { enabled: true, standardHours: std, overtime: {}, premiums: {}, rules: PRESET_RULES.california };
  const entries = [{ user_id: 1, wage_type: 'regular', work_date: '2026-07-06', start_time: '07:07:00', end_time: '19:22:00', break_minutes: 0 }];
  const run = raw => {
    const s = { hours_rules: JSON.stringify(raw) };
    const rounded = roundEntriesFromSettings(entries.map(e => ({ ...e })), s);
    const ot = computeOT(rounded, 'daily', 8, 1, otConfigFromSettings(s));
    return { reg: ot.regularHours, ot: ot.overtimeHours, start: rounded[0].start_time, end: rounded[0].end_time };
  };

  test('identical rounding and regular/OT hours', () => {
    const a = run(oldCA), b = run(newCA);
    expect(b.start).toBe(a.start); // 07:07 → 07:00
    expect(b.end).toBe(a.end);     // 19:22 → 19:15
    expect(b.reg).toBeCloseTo(a.reg, 6);
    expect(b.ot).toBeCloseTo(a.ot, 6); // 12.25h → 8 reg + 4@1.5 + 0.25@2
  });
});
