/**
 * `window_mult` rule — a GOVERNING multiplier for hours worked inside a
 * day-of-week + clock-time window, regardless of the daily/weekly OT threshold.
 *
 * The motivating case (a weekend premium schedule) is the first test:
 *   Saturday 05:00–19:00 → 1.25×
 *   Saturday 19:00 → Sunday 05:00 → 1.5×
 *   Sunday 05:00 → Monday 05:00 → 2×
 * expressed as three windows anchored on their START weekday, the later two
 * wrapping past midnight. Covered hours are carved out of the normal OT calc and
 * priced entirely at the window multiplier.
 */

jest.mock('../db', () => ({ query: jest.fn() }));

const { computeOT, annotateEntryOvertime, otBandsCost } = require('../utils/payCalculations');
const { otConfigFromSettings, parsePolicy } = require('../utils/hoursRules');
const { computePaid } = require('../utils/paidHours');

// 2026-07-06 is a Monday, so 07-11 = Sat, 07-12 = Sun, 07-13 = Mon.
const SAT = '2026-07-11', SUN = '2026-07-12', MON = '2026-07-13';
const e = (work_date, start_time, end_time, extra = {}) =>
  ({ wage_type: 'regular', break_minutes: 0, work_date, start_time, end_time, ...extra });
const cfg = rules => otConfigFromSettings({ hours_rules: JSON.stringify({ enabled: true, rules }) });
// Bands as {mult: hours}, order-independent.
const bandMap = r => Object.fromEntries(r.otBands.map(b => [b.mult, +b.hours.toFixed(4)]));

const WEEKEND = [
  { id: 'w1', type: 'window_mult', when: { kind: 'weekdays', days: [6] }, from: '05:00', to: '19:00', mult: 1.25 },
  { id: 'w2', type: 'window_mult', when: { kind: 'weekdays', days: [6] }, from: '19:00', to: '05:00', mult: 1.5 },
  { id: 'w3', type: 'window_mult', when: { kind: 'weekdays', days: [0] }, from: '05:00', to: '05:00', mult: 2 },
];

describe('window_mult — the weekend schedule', () => {
  test('a plain Saturday shift is 1.25× throughout', () => {
    const r = computeOT([e(SAT, '08:00', '16:00')], 'daily', 8, 1, cfg(WEEKEND));
    expect(r.regularHours).toBeCloseTo(0);
    expect(r.overtimeHours).toBeCloseTo(8);
    expect(bandMap(r)).toEqual({ 1.25: 8 });
  });

  test('a Saturday evening shift straddles the 19:00 boundary (1.25 → 1.5)', () => {
    const r = computeOT([e(SAT, '18:00', '22:00')], 'daily', 8, 1, cfg(WEEKEND));
    expect(r.overtimeHours).toBeCloseTo(4);
    expect(bandMap(r)).toEqual({ 1.25: 1, 1.5: 3 });
  });

  test('an overnight Sat→Sun shift crosses two windows (1.5 then 2×)', () => {
    // 22:00 Sat → 06:00 Sun: 22:00–05:00 in the 1.5 window (7h), 05:00–06:00 in the 2× window (1h).
    const r = computeOT([e(SAT, '22:00', '06:00')], 'daily', 8, 1, cfg(WEEKEND));
    expect(r.overtimeHours).toBeCloseTo(8);
    expect(bandMap(r)).toEqual({ 1.5: 7, 2: 1 });
  });

  test('a Sunday-into-Monday shift stays 2× up to Monday 05:00', () => {
    // 20:00 Sun → 04:00 Mon: all inside Sun 05:00 → Mon 05:00.
    const r = computeOT([e(SUN, '20:00', '04:00')], 'daily', 8, 1, cfg(WEEKEND));
    expect(r.overtimeHours).toBeCloseTo(8);
    expect(bandMap(r)).toEqual({ 2: 8 });
  });

  test('the whole Saturday is premium even past 8h — no plain daily OT split', () => {
    // 10h Saturday: without the window it would be 8 reg + 2 OT; with it, 10 @ 1.25.
    const r = computeOT([e(SAT, '07:00', '17:00')], 'daily', 8, 1, cfg([WEEKEND[0]]));
    expect(r.regularHours).toBeCloseTo(0);
    expect(bandMap(r)).toEqual({ 1.25: 10 });
  });

  test('prices out at the window multipliers through the pay pipeline', () => {
    const settings = {
      overtime_threshold: 8, overtime_multiplier: 1.5, week_start: 1,
      hours_rules: JSON.stringify({ enabled: true, rules: WEEKEND }),
    };
    const r = computePaid([e(SAT, '08:00', '16:00', { user_id: 1 })], settings, { rule: 'daily' });
    expect(bandMap(r)).toEqual({ 1.25: 8 });
    expect(otBandsCost(r.otBands, 100, 1.5)).toBeCloseTo(8 * 100 * 1.25); // $1,000
  });
});

describe('window_mult — semantics', () => {
  test('overlapping windows: the highest multiplier wins each minute', () => {
    const OV = [
      { id: 'a', type: 'window_mult', when: { kind: 'every_day' }, from: '05:00', to: '19:00', mult: 1.25 },
      { id: 'b', type: 'window_mult', when: { kind: 'every_day' }, from: '06:00', to: '10:00', mult: 2 },
    ];
    // 05:00–11:00: 05–06 @1.25, 06–10 @2, 10–11 @1.25 → {1.25:2, 2:4}.
    const r = computeOT([e(SAT, '05:00', '11:00')], 'none', 8, 1, cfg(OV));
    expect(r.overtimeHours).toBeCloseTo(6);
    expect(bandMap(r)).toEqual({ 1.25: 2, 2: 4 });
  });

  test('a break never inflates premium hours (capped at paid duration)', () => {
    // 09:00–17:00 gross 8h with a 60-min break = 7h paid, all inside the Sat window.
    const r = computeOT([e(SAT, '09:00', '17:00', { break_minutes: 60 })], 'none', 8, 1, cfg([WEEKEND[0]]));
    expect(r.regularHours).toBeCloseTo(0);
    expect(r.overtimeHours).toBeCloseTo(7);
    expect(bandMap(r)).toEqual({ 1.25: 7 });
  });

  test('window premium applies even under the "none" overtime rule', () => {
    const r = computeOT([e(SAT, '08:00', '16:00')], 'none', 8, 1, cfg(WEEKEND));
    expect(r.overtimeHours).toBeCloseTo(8);
    expect(bandMap(r)).toEqual({ 1.25: 8 });
  });

  test('hours outside every window fall through to the normal OT calc', () => {
    // Friday (no window) 10h day, daily threshold 8 → 8 reg + 2 OT at the default mult.
    const FRI = '2026-07-10';
    const r = computeOT([e(FRI, '07:00', '17:00')], 'daily', 8, 1, cfg(WEEKEND));
    expect(r.regularHours).toBeCloseTo(8);
    expect(r.overtimeHours).toBeCloseTo(2);
    expect(bandMap(r)).toEqual({ null: 2 }); // mult:null = "use the default multiplier"
  });

  test('per-entry OT reconciles with the summary total', () => {
    const rows = [e(SAT, '08:00', '16:00'), e(SAT, '18:00', '22:00'), e(SUN, '20:00', '23:00')];
    const summary = computeOT(rows.map(x => ({ ...x })), 'daily', 8, 1, cfg(WEEKEND));
    const annotated = annotateEntryOvertime(rows.map(x => ({ ...x })), 'daily', 8, 1, cfg(WEEKEND));
    const perEntry = annotated.reduce((s, x) => s + x.overtime_hours, 0);
    expect(perEntry).toBeCloseTo(summary.overtimeHours);
  });
});

describe('window_mult — parse & backward-compat', () => {
  test('valid rule parses to minutes; malformed ones are dropped', () => {
    const p = parsePolicy(JSON.stringify({ enabled: true, rules: [
      { id: 'ok',  type: 'window_mult', when: { kind: 'weekdays', days: [6] }, from: '05:00', to: '19:00', mult: 1.25 },
      { id: 'nom', type: 'window_mult', when: { kind: 'every_day' }, from: '05:00', to: '19:00' },        // no mult
      { id: 'bad', type: 'window_mult', when: { kind: 'every_day' }, from: 'nope', to: '19:00', mult: 2 },// bad time
    ] }));
    const w = p.rules.filter(r => r.type === 'window_mult');
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ from: 300, to: 1140, mult: 1.25 });
  });

  test('no window rules → computeOT is unchanged', () => {
    const noWindows = cfg([{ id: 't', type: 'ot_tier', when: { kind: 'every_day' }, basis: 'day', afterHours: 8, mult: 1.5 }]);
    const r = computeOT([e(MON, '07:00', '17:00')], 'daily', 8, 1, noWindows);
    expect(r.regularHours).toBeCloseTo(8);
    expect(r.overtimeHours).toBeCloseTo(2);
    expect(bandMap(r)).toEqual({ 1.5: 2 });
  });
});
