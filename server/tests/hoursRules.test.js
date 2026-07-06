/**
 * Tests for the hoursRules engine (Milestone 1: reference cascade + punch
 * rounding). The two Honduran rules the customer described are the headline
 * fixtures; US quarter-hour rounding proves the generic 'clock/nearest' path;
 * and the no-op guarantee proves an existing company sees zero change.
 */

const {
  parsePolicy,
  resolveExpected,
  applyRounding,
  roundEntriesForPay,
  toMin,
  weekdayOf,
} = require('../utils/hoursRules');
const { computeOT } = require('../utils/payCalculations');

// A company standard day of 07:00–16:00 with a 1h lunch, Mon–Sat, Sunday rest.
function stdHours() {
  const day = { start: '07:00', end: '16:00', unpaidBreakMin: 60 };
  return { '1': day, '2': day, '3': day, '4': day, '5': day, '6': { start: '07:00', end: '12:00', unpaidBreakMin: 0 } };
}

// The Honduran policy: late arrival docks to the hour; overtime rounds up to the hour.
function honduranPolicy() {
  return parsePolicy(JSON.stringify({
    enabled: true,
    standardHours: stdHours(),
    rounding: {
      clockIn:  { reference: 'schedule', intervalMin: 60, graceMin: 15, direction: 'against_worker' },
      clockOut: { reference: 'schedule', intervalMin: 60, graceMin: 30, direction: 'toward_worker' },
    },
  }));
}

// 2026-07-06 is a Monday (a working day under stdHours).
const MON = '2026-07-06';
const SUN = '2026-07-05';

describe('time helpers', () => {
  test('toMin parses HH:MM and HH:MM:SS', () => {
    expect(toMin('07:00')).toBe(420);
    expect(toMin('16:30:00')).toBe(990);
    expect(toMin(null)).toBeNull();
  });
  test('weekdayOf is timezone-independent', () => {
    expect(weekdayOf(MON)).toBe(1); // Monday
    expect(weekdayOf(SUN)).toBe(0); // Sunday
  });
});

describe('reference cascade', () => {
  const policy = honduranPolicy();
  test('company standard hours answer a normal weekday', () => {
    const exp = resolveExpected(policy, MON);
    expect(exp).toEqual({ startMin: 420, endMin: 960, unpaidBreakMin: 60 });
  });
  test('rest day (Sunday) has no reference', () => {
    expect(resolveExpected(policy, SUN)).toBeNull();
  });
  test('a per-worker override beats company hours', () => {
    const workerStandard = { '1': { start: '06:00', end: '15:00' } };
    const exp = resolveExpected(policy, MON, { workerStandard });
    expect(exp.startMin).toBe(360); // 06:00
  });
  test('an assigned shift beats everything', () => {
    const shift = { start_time: '05:30', end_time: '14:00' };
    const workerStandard = { '1': { start: '06:00', end: '15:00' } };
    const exp = resolveExpected(policy, MON, { shift, workerStandard });
    expect(exp.startMin).toBe(330); // 05:30
  });
});

describe('Honduran late-arrival rule (against_worker, 60m, grace 15)', () => {
  const policy = honduranPolicy();
  const exp = resolveExpected(policy, MON);
  const round = (rawIn) => applyRounding(rawIn, '16:00', exp, policy.rounding).start;

  test('15 minutes late → first hour docked (paid from 08:00)', () => {
    expect(round('07:15')).toBe('08:00:00');
  });
  test('any lateness past the hour still docks to the next hour', () => {
    expect(round('07:45')).toBe('08:00:00');
  });
  test('10 minutes late → forgiven, paid from 07:00', () => {
    expect(round('07:10')).toBe('07:00:00');
  });
  test('on time → paid from 07:00', () => {
    expect(round('07:00')).toBe('07:00:00');
  });
  test('early arrival is not paid before the scheduled start', () => {
    expect(round('06:40')).toBe('07:00:00');
  });
  test('90 minutes late → paid from 09:00', () => {
    expect(round('08:30')).toBe('09:00:00');
  });
});

describe('Honduran overtime rule (toward_worker, 60m, grace 30)', () => {
  const policy = honduranPolicy();
  const exp = resolveExpected(policy, MON);
  const round = (rawOut) => applyRounding('07:00', rawOut, exp, policy.rounding).end;

  test('30 minutes over → paid a full extra hour (to 17:00)', () => {
    expect(round('16:30')).toBe('17:00:00');
  });
  test('20 minutes over → not enough, paid to 16:00', () => {
    expect(round('16:20')).toBe('16:00:00');
  });
  test('leaving on time → paid to 16:00', () => {
    expect(round('16:00')).toBe('16:00:00');
  });
  test('70 minutes over → paid to 18:00', () => {
    expect(round('17:10')).toBe('18:00:00');
  });
  test('leaving early is not extended', () => {
    expect(round('15:30')).toBe('16:00:00');
  });
});

describe('combined: the two headline examples end to end', () => {
  const policy = honduranPolicy();
  const exp = resolveExpected(policy, MON);
  test('arrive 07:15, leave 16:30 → paid 08:00–17:00', () => {
    const { start, end } = applyRounding('07:15', '16:30', exp, policy.rounding);
    expect(start).toBe('08:00:00');
    expect(end).toBe('17:00:00');
  });
});

describe('US quarter-hour (clock grid, nearest, 15m)', () => {
  const policy = parsePolicy(JSON.stringify({
    enabled: true,
    rounding: {
      clockIn:  { reference: 'clock', intervalMin: 15, direction: 'nearest' },
      clockOut: { reference: 'clock', intervalMin: 15, direction: 'nearest' },
    },
  }));
  // No standardHours needed — clock-grid rounding ignores the schedule.
  const round = (rin, rout) => applyRounding(rin, rout, null, policy.rounding);

  test('08:07 rounds down to 08:00 (7-minute rule)', () => {
    expect(round('08:07', '17:00').start).toBe('08:00:00');
  });
  test('08:08 rounds up to 08:15', () => {
    expect(round('08:08', '17:00').start).toBe('08:15:00');
  });
  test('16:52 out rounds to 16:45; 16:53 to 17:00', () => {
    expect(round('08:00', '16:52').end).toBe('16:45:00');
    expect(round('08:00', '16:53').end).toBe('17:00:00');
  });
});

describe('clamp: rounding never inverts the interval', () => {
  const policy = honduranPolicy();
  const exp = resolveExpected(policy, MON);
  test('arrive very late, leave right after → paid start caps the end (0h)', () => {
    // Arrive 15:15 (paid start 16:00), leave 15:30 (before expected end → 16:00).
    const { start, end } = applyRounding('15:15', '15:30', exp, policy.rounding);
    expect(start).toBe('16:00:00');
    expect(end).toBe('16:00:00');
  });
});

describe('no-op guarantee', () => {
  test('disabled policy returns the same array reference', () => {
    const entries = [{ user_id: 1, work_date: MON, start_time: '07:15:00', end_time: '16:30:00' }];
    const policy = parsePolicy(JSON.stringify({ enabled: false, standardHours: stdHours() }));
    expect(roundEntriesForPay(entries, policy)).toBe(entries);
  });
  test('missing/garbage policy is a no-op', () => {
    const entries = [{ user_id: 1, work_date: MON, start_time: '07:15:00', end_time: '16:30:00' }];
    expect(roundEntriesForPay(entries, parsePolicy(null))).toBe(entries);
    expect(roundEntriesForPay(entries, parsePolicy('{not json'))).toBe(entries);
  });
  test('both edges off → no-op even when enabled', () => {
    const entries = [{ user_id: 1, work_date: MON, start_time: '07:15:00', end_time: '16:30:00' }];
    const policy = parsePolicy(JSON.stringify({ enabled: true, standardHours: stdHours() }));
    expect(roundEntriesForPay(entries, policy)).toBe(entries);
  });
});

describe('roundEntriesForPay batch transform', () => {
  const policy = honduranPolicy();
  test('adjusts times, preserves raw punch, flags the entry', () => {
    const entries = [{ user_id: 1, work_date: MON, start_time: '07:15:00', end_time: '16:30:00' }];
    const out = roundEntriesForPay(entries, policy);
    expect(out).not.toBe(entries);              // new array (copy)
    expect(out[0].start_time).toBe('08:00:00');
    expect(out[0].end_time).toBe('17:00:00');
    expect(out[0].raw_start_time).toBe('07:15:00');
    expect(out[0].raw_end_time).toBe('16:30:00');
    expect(out[0].rounding_adjusted).toBe(true);
    expect(entries[0].start_time).toBe('07:15:00'); // input untouched
  });
  test('a rest-day entry is left unchanged (no reference to round against)', () => {
    const entries = [{ user_id: 1, work_date: SUN, start_time: '07:15:00', end_time: '16:30:00' }];
    const out = roundEntriesForPay(entries, policy);
    expect(out[0].start_time).toBe('07:15:00');
    expect(out[0].rounding_adjusted).toBeUndefined();
  });
  test('an on-schedule entry is returned as-is (not flagged)', () => {
    const entries = [{ user_id: 1, work_date: MON, start_time: '07:00:00', end_time: '16:00:00' }];
    const out = roundEntriesForPay(entries, policy);
    expect(out[0].rounding_adjusted).toBeUndefined();
  });
  test('shiftMap reference overrides company hours for the matching day', () => {
    const entries = [{ user_id: 5, work_date: MON, start_time: '05:40:00', end_time: '14:00:00' }];
    const shiftMap = { [`5|${MON}`]: { start_time: '05:30', end_time: '14:00' } };
    const out = roundEntriesForPay(entries, policy, { shiftMap });
    // Expected start 05:30; arrived 05:40 (10 late < grace 15) → paid 05:30.
    expect(out[0].start_time).toBe('05:30:00');
  });
});

describe('integration with the real computeOT (the wiring contract)', () => {
  // A 07:15–16:30 day with a 1h lunch: raw = 8.25h → 8 reg + 0.25 OT (daily@8).
  const rawEntry = () => [{
    user_id: 1, work_date: MON, wage_type: 'regular',
    start_time: '07:15:00', end_time: '16:30:00', break_minutes: 60,
  }];

  test('disabled policy ⇒ computeOT output is identical to raw', () => {
    const off = parsePolicy(JSON.stringify({ enabled: false, standardHours: stdHours() }));
    const rawOut = computeOT(rawEntry(), 'daily', 8);
    const paidOut = computeOT(roundEntriesForPay(rawEntry(), off), 'daily', 8);
    expect(paidOut).toEqual(rawOut);
    expect(rawOut.regularHours).toBeCloseTo(8, 5);
    expect(rawOut.overtimeHours).toBeCloseTo(0.25, 5);
  });

  test('Honduran policy rounds the punch, changing the computed hours', () => {
    // Paid 08:00–17:00 − 1h lunch = 8.00h → 8 reg + 0 OT (the 15m tail is docked).
    const paid = roundEntriesForPay(rawEntry(), honduranPolicy());
    const { regularHours, overtimeHours } = computeOT(paid, 'daily', 8);
    expect(regularHours).toBeCloseTo(8, 5);
    expect(overtimeHours).toBeCloseTo(0, 5);
  });

  test('overtime_hours_override survives the rounding transform', () => {
    const entries = roundEntriesForPay(
      [{ ...rawEntry()[0], overtime_hours_override: 2 }],
      honduranPolicy()
    );
    expect(entries[0].overtime_hours_override).toBe(2);
    const { overtimeHours } = computeOT(entries, 'daily', 8);
    expect(overtimeHours).toBeCloseTo(2, 5); // override wins over the auto split
  });
});
