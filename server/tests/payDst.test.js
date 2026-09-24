/**
 * DST correction of paid hours.
 *
 * Pay hours come from the wall-clock TIME columns, so a shift that spans a DST
 * change was paid by the clock on the wall, not the time worked:
 *   22:00→06:00 across US fall-back (2026-11-01, America/Chicago) = 9 real hours, was paid 8;
 *   22:00→06:00 across spring-forward (2026-03-08)                = 7 real hours, was paid 8.
 * entryDuration now adds  -(offset(end_ts) - offset(start_ts))  when the row carries
 * start_ts, end_ts and a valid IANA timezone — and nothing otherwise (legacy rows
 * are byte-identical). Wall-clock stays the basis for rounding, windows, work_date.
 */

jest.mock('../db', () => ({ query: jest.fn() }));

const {
  entryDuration, dstAdjustHours, offsetMinutes, dstWallInterval,
  computeOT, annotateEntryOvertime, nightHoursForEntry, windowHoursForEntry,
} = require('../utils/payCalculations');
const { entryInstants } = require('../utils/timeFormat');
const { buildPayStatement } = require('../utils/payStatement');
const { computePaid, laborCostCents } = require('../utils/paidHours');
const { splitRateAware } = require('../utils/rateAwareOvertime');
const { otConfigFromSettings, roundEntriesFromSettings } = require('../utils/hoursRules');
const { calcH: limitCalcH } = require('../utils/projectHourLimits');

const CHI = 'America/Chicago';
const FALL = '2026-10-31';   // night of Sat 10-31 → Sun 11-01 (fall-back 02:00 CDT → 01:00 CST)
const SPRING = '2026-03-07'; // night of Sat 03-07 → Sun 03-08 (spring-forward 02:00 CST → 03:00 CDT)
const PLAIN = '2026-10-24';  // an ordinary Saturday night, no transition

// A row the way the write paths store it: wall-clock TIMEs + instants from entryInstants.
const row = (workDate, tz, over = {}) => {
  const start_time = over.start_time || '22:00:00';
  const end_time = over.end_time || '06:00:00';
  return {
    user_id: 1, work_date: workDate, wage_type: 'regular', break_minutes: 0, project_id: null,
    start_time, end_time, timezone: tz,
    ...entryInstants(workDate, start_time, end_time, tz),
    ...over,
  };
};

const SETTINGS = {
  overtime_threshold: 8, week_start: 1, overtime_multiplier: 1.5,
  prevailing_wage_rate: 45, default_hourly_rate: 30,
  sick_pay_pct: 100, vacation_pay_pct: 100, regular_shift_hours: 8, deductions: null,
};
const statement = (entries, over = {}) => buildPayStatement({
  worker: { id: 1, hourly_rate: 30, rate_type: 'hourly', overtime_rule: 'daily', role_id: null, guaranteed_weekly_hours: 0, ...(over.worker || {}) },
  entries, reimbursements: [], leave: { sick: 0, vacation: 0 }, deductions: [],
  otConfig: over.otConfig ?? null, projectRateMap: {}, settings: over.settings || SETTINGS,
  from: '2026-10-26', to: '2026-11-01', explain: false,
});

describe('offsetMinutes (Intl, Node ICU)', () => {
  test('Chicago CDT/CST and a zone without DST', () => {
    expect(offsetMinutes(Date.parse('2026-11-01T06:30:00Z'), CHI)).toBe(-300); // 01:30 CDT
    expect(offsetMinutes(Date.parse('2026-11-01T07:30:00Z'), CHI)).toBe(-360); // 01:30 CST
    expect(offsetMinutes(Date.parse('2026-11-01T07:30:00Z'), 'America/Phoenix')).toBe(-420);
    expect(offsetMinutes(Date.parse('2026-11-01T07:30:00Z'), 'UTC')).toBe(0);
    expect(offsetMinutes(Date.parse('2026-11-01T07:30:00Z'), 'Not/AZone')).toBeNull();
  });
  test('half-hour transition (Lord Howe) is resolved to the minute, not the hour', () => {
    expect(offsetMinutes(Date.parse('2026-04-04T14:59:00Z'), 'Australia/Lord_Howe')).toBe(660);
    expect(offsetMinutes(Date.parse('2026-04-04T15:01:00Z'), 'Australia/Lord_Howe')).toBe(630);
  });
});

describe('entryDuration — the one paid-hours definition', () => {
  test('fall-back overnight (Chicago) = 9h (was 8)', () => {
    expect(dstAdjustHours(row(FALL, CHI))).toBe(1);
    expect(entryDuration(row(FALL, CHI))).toBe(9);
  });
  test('spring-forward overnight (Chicago) = 7h (was 8)', () => {
    expect(dstAdjustHours(row(SPRING, CHI))).toBe(-1);
    expect(entryDuration(row(SPRING, CHI))).toBe(7);
  });
  test('real clock-out instants (not the entryInstants +24h form) give the same answer', () => {
    // 22:00 CDT = 03:00Z; 06:00 CST = 12:00Z → 9 real hours.
    const e = { ...row(FALL, CHI), start_ts: new Date('2026-11-01T03:00:00Z'), end_ts: new Date('2026-11-01T12:00:00Z') };
    expect(entryDuration(e)).toBe(9);
    // ISO strings (e.g. a JSON round-trip) work too.
    expect(entryDuration({ ...e, start_ts: e.start_ts.toISOString(), end_ts: e.end_ts.toISOString() })).toBe(9);
  });
  test('same shift with timezone null / invalid, or instants missing = 8h (unchanged)', () => {
    expect(entryDuration(row(FALL, CHI, { timezone: null }))).toBe(8);
    expect(entryDuration(row(FALL, CHI, { timezone: 'Mars/Olympus' }))).toBe(8);
    expect(entryDuration(row(FALL, CHI, { start_ts: null }))).toBe(8);
    expect(entryDuration(row(FALL, CHI, { end_ts: undefined }))).toBe(8);
    const legacy = row(FALL, CHI); delete legacy.start_ts; delete legacy.end_ts; delete legacy.timezone;
    expect(entryDuration(legacy)).toBe(8);
  });
  test('non-DST night, and zones without DST, are unchanged', () => {
    expect(entryDuration(row(PLAIN, CHI))).toBe(8);
    expect(entryDuration(row(FALL, 'America/Phoenix'))).toBe(8);
    expect(entryDuration(row(FALL, 'UTC'))).toBe(8);
    expect(entryDuration(row(SPRING, 'America/Phoenix'))).toBe(8);
  });
  test('a day shift on the transition date is unchanged', () => {
    expect(entryDuration(row('2026-11-01', CHI, { start_time: '08:00:00', end_time: '16:00:00' }))).toBe(8);
  });
  test('break still subtracts; never negative', () => {
    expect(entryDuration(row(FALL, CHI, { break_minutes: 30 }))).toBe(8.5);
    // 01:00→03:30 across spring-forward = 1.5 real h; a 2h break must clamp to 0, not go negative.
    expect(entryDuration(row('2026-03-08', CHI, { start_time: '01:00:00', end_time: '03:30:00', break_minutes: 120 }))).toBe(0);
  });
  test('multi-day forgotten clock-out (> 26h span) is left to the TIME columns', () => {
    const e = { ...row(FALL, CHI), start_ts: new Date('2026-10-30T03:00:00Z'), end_ts: new Date('2026-11-02T12:00:00Z') };
    expect(dstAdjustHours(e)).toBe(0);
    expect(entryDuration(e)).toBe(8);
  });
});

describe('daily OT buckets and per-entry allocation', () => {
  test('fall-back: daily OT computed on 9h → 8 reg + 1 OT', () => {
    const ot = computeOT([row(FALL, CHI)], 'daily', 8, 1);
    expect(ot.regularHours).toBe(8);
    expect(ot.overtimeHours).toBe(1);
    const [e] = annotateEntryOvertime([row(FALL, CHI)], 'daily', 8, 1);
    expect(e.overtime_hours).toBe(1);
  });
  test('spring-forward: 7h → 7 reg, 0 OT', () => {
    const ot = computeOT([row(SPRING, CHI)], 'daily', 8, 1);
    expect(ot.regularHours).toBe(7);
    expect(ot.overtimeHours).toBe(0);
  });
  test('the whole shift stays on its work_date; per-date sums reconcile to Σ entryDuration', () => {
    // Overnight fall-back shift (work_date 10-31) + a day shift on 11-01.
    const entries = [row(FALL, CHI), row('2026-11-01', CHI, { start_time: '14:00:00', end_time: '20:00:00' })];
    const total = entries.reduce((s, e) => s + entryDuration(e), 0);
    expect(total).toBe(15);
    const ot = computeOT(entries, 'daily', 8, 1);
    expect(ot.regularHours + ot.overtimeHours).toBe(total);
    expect(ot.overtimeHours).toBe(1); // 10-31 bucket = 9h (1 OT); 11-01 bucket = 6h
    const ann = annotateEntryOvertime(entries.map(e => ({ ...e })), 'daily', 8, 1);
    expect(ann.map(e => e.overtime_hours)).toEqual([1, 0]);
    // Weekly bucketing sees the same total.
    const wk = computeOT(entries, 'weekly', 40, 1);
    expect(wk.regularHours + wk.overtimeHours).toBe(total);
  });
  test('rate-aware path (plain OT config) uses the same 9h', () => {
    const s = splitRateAware([row(FALL, CHI)], { rule: 'daily', threshold: 8, weekStart: 1, otMult: 1.5, baseRateOf: () => 30 });
    expect(s.regularHours).toBe(8);
    expect(s.overtimeHours).toBe(1);
    expect(s.regularCost + s.overtimeCost).toBeCloseTo(8 * 30 + 1 * 45, 6);
  });
});

describe('night differential and window multipliers stay wall-clock, count real time', () => {
  test('night window 22→6: fall-back = 9 night hours, spring = 7, plain = 8', () => {
    expect(nightHoursForEntry(row(FALL, CHI), 22, 6)).toBe(9);
    expect(nightHoursForEntry(row(SPRING, CHI), 22, 6)).toBe(7);
    expect(nightHoursForEntry(row(PLAIN, CHI), 22, 6)).toBe(8);
    expect(nightHoursForEntry(row(FALL, CHI, { timezone: null }), 22, 6)).toBe(8);
  });
  test('the transition hour outside the night window does not change night hours', () => {
    // Window 22→01: the repeated 01:00–02:00 is outside it → still 3 night hours.
    expect(nightHoursForEntry(row(FALL, CHI), 22, 1)).toBe(3);
    expect(dstWallInterval(row(FALL, CHI))).toEqual({ lo: 1500, hi: 1560, sign: 1 });   // 01:00–02:00 next day
    expect(dstWallInterval(row(SPRING, CHI))).toEqual({ lo: 1560, hi: 1620, sign: -1 }); // 02:00–03:00 next day
  });
  test('window_mult covering the whole night pays the real hours, never more than paid', () => {
    const rules = [{ id: 'n', type: 'window_mult', when: { kind: 'every_day' }, from: 22 * 60, to: 6 * 60, mult: 1.5 }];
    expect(windowHoursForEntry(row(FALL, CHI), rules)).toEqual(new Map([[1.5, 9]]));
    expect(windowHoursForEntry(row(SPRING, CHI), rules)).toEqual(new Map([[1.5, 7]]));
    expect(windowHoursForEntry(row(PLAIN, CHI), rules)).toEqual(new Map([[1.5, 8]]));
    // Through computeOT: all window hours, nothing left for the residual.
    const ot = computeOT([row(SPRING, CHI)], 'daily', 8, 1, { windowRules: rules });
    expect(ot.regularHours).toBe(0);
    expect(ot.overtimeHours).toBe(7);
  });
});

describe('pay statement / pipeline', () => {
  test('gross for a fall-back shift = 9h × rate (no OT rule)', () => {
    const st = statement([row(FALL, CHI)], { worker: { overtime_rule: 'none' }, settings: { ...SETTINGS, overtime_rule: 'none' } });
    expect(st.hours.regular).toBe(9);
    expect(st.totals.grossWages).toBe(270);
    // Same shift with no timezone → the old 8h × 30.
    const legacy = statement([row(FALL, CHI, { timezone: null })], { worker: { overtime_rule: 'none' }, settings: { ...SETTINGS, overtime_rule: 'none' } });
    expect(legacy.totals.grossWages).toBe(240);
  });
  test('fall-back with daily OT: 8 reg + 1 OT = 240 + 45', () => {
    const st = statement([row(FALL, CHI)]);
    expect(st.hours.regular).toBe(8);
    expect(st.hours.overtime).toBe(1);
    expect(st.totals.grossWages).toBe(285);
  });
  test('spring-forward gross = 7h × rate', () => {
    const st = statement([row(SPRING, CHI)]);
    expect(st.hours.regular).toBe(7);
    expect(st.hours.overtime).toBe(0);
    expect(st.totals.grossWages).toBe(210);
  });
  test('prevailing hours on the premium path are DST-corrected too', () => {
    const otConfig = otConfigFromSettings({ hours_rules: JSON.stringify({ enabled: true, rules: [
      { id: 'n', type: 'night_diff', when: { kind: 'every_day' }, fromHour: 22, toHour: 6, pct: 10 },
    ] }) });
    const st = statement([row(FALL, CHI, { wage_type: 'prevailing' })], { otConfig });
    expect(st.hours.prevailing).toBe(9);
    expect(st.cost.prevailing).toBe(405); // 9 × 45
  });
  test('night differential premium on a fall-back shift is on 9 night hours', () => {
    const otConfig = otConfigFromSettings({ hours_rules: JSON.stringify({ enabled: true, rules: [
      { id: 'n', type: 'night_diff', when: { kind: 'every_day' }, fromHour: 22, toHour: 6, pct: 10 },
    ] }) });
    const st = statement([row(FALL, CHI)], { otConfig });
    expect(st.cost.night).toBe(27); // 9h × 30 × 10%
  });
  test('a rounding policy still applies on top (wall-clock rounding, then DST)', () => {
    const settings = { ...SETTINGS, hours_rules: JSON.stringify({
      enabled: true,
      rounding: {
        clockIn: { reference: 'clock', intervalMin: 15, graceMin: 0, direction: 'nearest' },
        clockOut: { reference: 'clock', intervalMin: 15, graceMin: 0, direction: 'nearest' },
      },
      rules: [],
    }) };
    // Punched 21:53 → 06:07 across fall-back; rounds to 22:00 → 06:00 wall = 8h wall, 9h real.
    const e = row(FALL, CHI, { start_time: '21:53:00', end_time: '06:07:00' });
    const [paid] = roundEntriesFromSettings([e], settings);
    expect(paid.start_time).toBe('22:00:00');
    expect(paid.end_time).toBe('06:00:00');
    expect(entryDuration(paid)).toBe(9);
    const r = computePaid([e], settings, { rule: 'daily' });
    expect(r.regularHours).toBe(8);
    expect(r.overtimeHours).toBe(1);
  });
  test('labor cost (LABOR_ENTRY_COLUMNS path) prices 9h', () => {
    const e = { ...row(FALL, CHI), rate: '30', ot_rule: 'none', rate_type: 'hourly', worker_type: 'employee' };
    expect(laborCostCents([e], { ...SETTINGS })).toBe(27000);
  });
  test('project hour-limit counter matches when handed the row', () => {
    const e = row(FALL, CHI);
    expect(limitCalcH(e.start_time, e.end_time, 0)).toBe(8);   // legacy signature unchanged
    expect(limitCalcH(e.start_time, e.end_time, 0, e)).toBe(9);
  });
});
