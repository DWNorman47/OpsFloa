/**
 * The hours-rules rule list (Milestone 4) — the open-ended half of the policy.
 *
 * THE FIXTURE THAT MATTERS is David's own table. He gave four examples so the
 * rule would be unambiguous; they are reproduced here verbatim and the engine
 * has to satisfy them exactly:
 *
 *      still clocked in at   pays to
 *            5:24             5:00
 *            5:25             5:30
 *            5:50             5:30
 *            5:51             6:00
 *
 * The lesson encoded in that table: **added time is paid time, not clock
 * time.** The credit lands on the SCHEDULED end (5:00), and the punch only
 * decides which rung was reached. An earlier version added the credit to the
 * punch, which made 5:51 pay to 6:51 — paying a worker more for clocking out
 * later within the same rung, which is the exact thing a rung exists to stop.
 *
 * The numbers themselves belong to the company, not to us. These tests pin the
 * *principle*; the 5:25s and 5:51s are that customer's to choose.
 */

const {
  parsePolicy,
  parseRules,
  applyRules,
  ruleMatchesDate,
  roundEntriesForPay,
  toMin,
  toHHMMSS,
  daysBetween,
  monthsBetween,
} = require('../utils/hoursRules');
const { computeOT } = require('../utils/payCalculations');

const WEEKDAYS = [1, 2, 3, 4, 5];
// A scheduled 7:00–17:00 day, Mon–Fri. The ladder is measured off that 17:00.
const STD = { start: '07:00', end: '17:00' };
const stdHours = () => ({ '1': STD, '2': STD, '3': STD, '4': STD, '5': STD });

// The customer's policy: a lunch hour, ignore the early clock-in, and a ladder
// whose rungs name TOTAL credit off the 17:00 scheduled end.
function customerPolicy() {
  return parsePolicy(JSON.stringify({
    enabled: true,
    standardHours: stdHours(),
    rules: [
      { id: 'lunch', type: 'auto_break', when: { kind: 'every_day' }, minutes: 60, trigger: { kind: 'always' } },
      { id: 'in7',   type: 'clip_start', when: { kind: 'weekdays', days: WEEKDAYS }, at: '07:00' },
      { id: 'l1',    type: 'add_time', when: { kind: 'weekdays', days: WEEKDAYS }, edge: 'after', at: '17:25', minutes: 30 },
      { id: 'l2',    type: 'add_time', when: { kind: 'weekdays', days: WEEKDAYS }, edge: 'after', at: '17:51', minutes: 60 },
      { id: 'l3',    type: 'add_time', when: { kind: 'weekdays', days: WEEKDAYS }, edge: 'after', at: '18:25', minutes: 90 },
    ],
  }));
}

const MON = '2026-07-06';
const SAT = '2026-07-11';

const entry = (over = {}) => ({
  user_id: 1, work_date: MON, wage_type: 'regular',
  start_time: '07:00:00', end_time: '17:00:00', break_minutes: 0, ...over,
});

const paidEnd = (e, policy = customerPolicy()) => roundEntriesForPay([e], policy)[0].end_time;

function paidHours(e, policy = customerPolicy()) {
  const [out] = roundEntriesForPay([e], policy);
  return (toMin(out.end_time) - toMin(out.start_time)) / 60 - (out.break_minutes || 0) / 60;
}

describe("David's table — the credit lands on the scheduled end", () => {
  test.each([
    ['17:24:00', '17:00:00'],
    ['17:25:00', '17:30:00'],
    ['17:50:00', '17:30:00'],
    ['17:51:00', '18:00:00'],
  ])('still clocked in at %s → pays to %s', (end_time, expected) => {
    expect(paidEnd(entry({ end_time }))).toBe(expected);
  });

  test('5:51 does NOT pay to 6:51 — the credit is not added to the punch', () => {
    expect(paidEnd(entry({ end_time: '17:51:00' }))).not.toBe('18:51:00');
  });

  test('within a rung, clocking out later earns nothing extra', () => {
    // The point of a rung. Every punch from 17:25 to 17:50 pays the same.
    const ends = ['17:25:00', '17:30:00', '17:40:00', '17:50:00'];
    expect(ends.map(end_time => paidEnd(entry({ end_time })))).toEqual(ends.map(() => '17:30:00'));
  });

  test('rungs do not accumulate — the largest reached wins', () => {
    // 18:25 has passed all three rungs. It earns 90, not 30+60+90.
    expect(paidEnd(entry({ end_time: '18:30:00' }))).toBe('18:30:00'); // 17:00 + 90
  });

  test('leaving early is a short day, not a ladder case', () => {
    // Nothing pays anyone to the scheduled end for going home at 15:00.
    expect(paidEnd(entry({ end_time: '15:00:00' }))).toBe('15:00:00');
  });

  test('the ladder is scoped to weekdays and stays off on Saturday', () => {
    expect(paidEnd(entry({ work_date: SAT, end_time: '18:00:00' }))).toBe('18:00:00');
  });
});

describe('base: punch — the flat bonus, for a company that wants it', () => {
  const policy = parsePolicy(JSON.stringify({
    enabled: true,
    standardHours: stdHours(),
    rules: [{ type: 'add_time', when: { kind: 'every_day' }, edge: 'after', base: 'punch', at: '17:25', minutes: 30 }],
  }));

  test('adds to the actual punch', () => {
    expect(paidEnd(entry({ end_time: '17:51:00' }), policy)).toBe('18:21:00');
  });

  test('schedule is the default when base is unspecified', () => {
    expect(parseRules([{ type: 'add_time', when: { kind: 'every_day' }, edge: 'after', at: '17:25', minutes: 30 }])[0].base)
      .toBe('schedule');
  });

  test('a schedule-based rule with no schedule for the day falls back to the punch', () => {
    // Saturday has no standardHours here, so there is no scheduled end to
    // measure from. Silently paying nothing would be worse than a flat add.
    const p = parsePolicy(JSON.stringify({
      enabled: true,
      standardHours: stdHours(),
      rules: [{ type: 'add_time', when: { kind: 'every_day' }, edge: 'after', at: '17:25', minutes: 30 }],
    }));
    expect(paidEnd(entry({ work_date: SAT, end_time: '17:51:00' }), p)).toBe('18:21:00');
  });
});

describe("mode: every — the repeating ladder that's back by request", () => {
  // "From 17:25, every 25 minutes, another 30 minutes of credit."
  const policy = parsePolicy(JSON.stringify({
    enabled: true,
    standardHours: stdHours(),
    rules: [{
      type: 'add_time', when: { kind: 'every_day' }, edge: 'after',
      mode: 'every', from: '17:25', everyMin: 25, minutes: 30,
    }],
  }));

  test.each([
    ['17:24:00', '17:00:00'], // before the first step
    ['17:25:00', '17:30:00'], // step 1 → +30
    ['17:49:00', '17:30:00'], // still step 1
    ['17:50:00', '18:00:00'], // step 2 → +60
    ['18:15:00', '18:30:00'], // step 3 → +90
  ])('%s → %s', (end_time, expected) => {
    expect(paidEnd(entry({ end_time }), policy)).toBe(expected);
  });

  test('it repeats indefinitely, unlike a fixed list of rungs', () => {
    // 17:25 → 21:00 is 215 min ⇒ 9 steps ⇒ +270. Off the 17:00 scheduled end
    // that's 21:30 — still a rung, not the punch.
    expect(paidEnd(entry({ end_time: '21:00:00' }), policy)).toBe('21:30:00');
  });
});

describe("edge: before — the clock-in side, mirrored", () => {
  const policy = parsePolicy(JSON.stringify({
    enabled: true,
    standardHours: stdHours(),
    rules: [{ type: 'add_time', when: { kind: 'every_day' }, edge: 'before', at: '06:30', minutes: 30 }],
  }));

  test('an early clock-in credits off the scheduled start', () => {
    expect(roundEntriesForPay([entry({ start_time: '06:15:00' })], policy)[0].start_time).toBe('06:30:00'); // 07:00 − 30
  });

  test('not early enough earns nothing', () => {
    expect(roundEntriesForPay([entry({ start_time: '06:45:00' })], policy)[0].start_time).toBe('07:00:00');
  });

  test('arriving late is not a credit case', () => {
    expect(roundEntriesForPay([entry({ start_time: '07:20:00' })], policy)[0].start_time).toBe('07:20:00');
  });
});

describe('clip_start — ignore the early clock-in', () => {
  test('clocking in before 7 is not paid', () => {
    expect(paidHours(entry({ start_time: '06:30:00' }))).toBeCloseTo(9, 5);
  });

  test('clocking in AFTER 7 is not silently forgiven', () => {
    // max() only moves the start forward — clipping must never become
    // "everyone is paid from 7 regardless".
    expect(paidHours(entry({ start_time: '07:20:00' }))).toBeCloseTo(8 + 40 / 60, 5);
  });

  test('a clip is a clamp, not a rounding — 07:20 stays 07:20', () => {
    expect(roundEntriesForPay([entry({ start_time: '07:20:00' })], customerPolicy())[0].start_time).toBe('07:20:00');
  });
});

describe('auto_break — max(expected, logged), never the sum', () => {
  test('no logged break → the expected hour is deducted', () => {
    expect(paidHours(entry({ break_minutes: 0 }))).toBeCloseTo(9, 5);
  });

  test('a logged break shorter than expected → the expected hour wins', () => {
    // NOT 90: break_minutes is already deducted everywhere downstream, so
    // summing would take the lunch twice.
    expect(paidHours(entry({ break_minutes: 30 }))).toBeCloseTo(9, 5);
  });

  test('a logged break LONGER than expected wins — they really were away', () => {
    expect(paidHours(entry({ break_minutes: 90 }))).toBeCloseTo(8.5, 5);
  });

  test("the count logic falls out of comparing totals", () => {
    // "Three expected, two found → one auto break." Three 30-min rules = 90
    // expected; two logged at 30 each = 60; max() supplies the missing 30.
    // Nothing counts breaks — break_minutes is one integer, so it can't.
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rules: [1, 2, 3].map(i => ({
        id: `b${i}`, type: 'auto_break', when: { kind: 'every_day' }, minutes: 30, trigger: { kind: 'always' },
      })),
    }));
    expect(roundEntriesForPay([entry({ break_minutes: 60 })], policy)[0].break_minutes).toBe(90);
    // "A 10 and a 20 minute break is the same as two 15s" — only totals are
    // compared, so any split summing to 90 adds nothing.
    expect(roundEntriesForPay([entry({ break_minutes: 90 })], policy)[0].break_minutes).toBe(90);
  });

  test('after_hours trigger spares a short day', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rules: [{ type: 'auto_break', when: { kind: 'every_day' }, minutes: 30, trigger: { kind: 'after_hours', hours: 6 } }],
    }));
    expect(paidHours(entry({ end_time: '10:00:00' }), policy)).toBeCloseTo(3, 5);
    expect(paidHours(entry({ end_time: '17:00:00' }), policy)).toBeCloseTo(9.5, 5);
  });

  test('the raw break is preserved when the rule overrides it', () => {
    const [out] = roundEntriesForPay([entry({ break_minutes: 15 })], customerPolicy());
    expect(out.break_minutes).toBe(60);
    expect(out.raw_break_minutes).toBe(15);
  });
});

describe('added time counts toward overtime', () => {
  test('the credit is classified, not bolted on after', () => {
    // David: "The +0.5 counts toward the 8 hours."
    // A 17:51 punch reaches the +60 rung → paid to 18:00 → 11h − 1h lunch = 10h,
    // so the whole 2h over the threshold is overtime.
    const [paid] = roundEntriesForPay([entry({ end_time: '17:51:00' })], customerPolicy());
    const { regularHours, overtimeHours } = computeOT([paid], 'daily', 8);
    expect(regularHours).toBeCloseTo(8, 5);
    expect(overtimeHours).toBeCloseTo(2, 5);
  });

  test('the credit changes the overtime, so it is genuinely inside the threshold', () => {
    // Same punch, no ladder: 07:00→17:51 = 10h51m − 1h = 9h51m ⇒ 1.85h OT.
    // With the ladder it is a clean 2h. If the credit were added after
    // classification these would be the same number.
    const bare = parsePolicy(JSON.stringify({
      enabled: true, standardHours: stdHours(),
      rules: [{ type: 'auto_break', when: { kind: 'every_day' }, minutes: 60, trigger: { kind: 'always' } }],
    }));
    const [noLadder] = roundEntriesForPay([entry({ end_time: '17:51:00' })], bare);
    expect(computeOT([noLadder], 'daily', 8).overtimeHours).toBeCloseTo(1.85, 2);
  });
});

describe('day selectors', () => {
  const r = when => ({ type: 'clip_start', when, at: '07:00' });
  const matches = (when, date) => ruleMatchesDate(parseRules([r(when)])[0], date);

  test('every_day matches anything', () => {
    expect(matches({ kind: 'every_day' }, SAT)).toBe(true);
  });

  test('weekdays matches by day of week', () => {
    expect(matches({ kind: 'weekdays', days: WEEKDAYS }, MON)).toBe(true);
    expect(matches({ kind: 'weekdays', days: WEEKDAYS }, SAT)).toBe(false);
  });

  test('month_days matches by date of month', () => {
    expect(matches({ kind: 'month_days', days: [6, 20] }, '2026-07-06')).toBe(true);
    expect(matches({ kind: 'month_days', days: [6, 20] }, '2026-07-07')).toBe(false);
  });

  test('month_weekdays matches "first Monday"', () => {
    const w = { kind: 'month_weekdays', patterns: [{ week: 1, weekday: 1 }] };
    expect(matches(w, '2026-07-06')).toBe(true);
    expect(matches(w, '2026-07-13')).toBe(false);
  });

  test('week:-1 means the LAST one, and works for ANY weekday', () => {
    // July 2026 has 4 Mondays (6,13,20,27); August has 5 (3,10,17,24,31) — so
    // "last" is not a fixed nth.
    const lastMon = { kind: 'month_weekdays', patterns: [{ week: -1, weekday: 1 }] };
    expect(matches(lastMon, '2026-07-27')).toBe(true);
    expect(matches(lastMon, '2026-07-20')).toBe(false);
    expect(matches(lastMon, '2026-08-31')).toBe(true);
    expect(matches(lastMon, '2026-08-24')).toBe(false);

    // Any day, not just Friday: last Wednesday of July 2026 is the 29th.
    const lastWed = { kind: 'month_weekdays', patterns: [{ week: -1, weekday: 3 }] };
    expect(matches(lastWed, '2026-07-29')).toBe(true);
    expect(matches(lastWed, '2026-07-22')).toBe(false);
  });

  test('months restricts to calendar months', () => {
    expect(matches({ kind: 'months', months: [7, 12] }, '2026-07-06')).toBe(true);
    expect(matches({ kind: 'months', months: [7, 12] }, '2026-08-06')).toBe(false);
  });

  test('nth_days counts from its anchor', () => {
    const w = { kind: 'nth_days', start: '2026-07-06', every: 3 };
    expect(matches(w, '2026-07-06')).toBe(true);  // day 0
    expect(matches(w, '2026-07-09')).toBe(true);  // day 3
    expect(matches(w, '2026-07-08')).toBe(false);
    expect(matches(w, '2026-08-05')).toBe(true);  // day 30, across the month end
  });

  test('nth_days never fires before its anchor', () => {
    const w = { kind: 'nth_days', start: '2026-07-06', every: 3 };
    expect(matches(w, '2026-07-03')).toBe(false); // −3 would be 0 mod 3
  });

  test('nth_months counts whole months from its anchor', () => {
    const w = { kind: 'nth_months', start: '2026-07', every: 2 };
    expect(matches(w, '2026-07-06')).toBe(true);
    expect(matches(w, '2026-08-06')).toBe(false);
    expect(matches(w, '2026-09-06')).toBe(true);
    expect(matches(w, '2027-01-06')).toBe(true);  // 6 months on, across the year
    expect(matches(w, '2026-05-06')).toBe(false); // before the anchor
  });

  test('nth_months can narrow to days within the month', () => {
    const w = { kind: 'nth_months', start: '2026-07', every: 2, days: [1, 15] };
    expect(matches(w, '2026-07-15')).toBe(true);
    expect(matches(w, '2026-07-16')).toBe(false); // right month, wrong day
    expect(matches(w, '2026-08-15')).toBe(false); // right day, wrong month
  });

  test('date arithmetic helpers', () => {
    expect(daysBetween('2026-07-06', '2026-08-05')).toBe(30);
    expect(daysBetween('2026-07-06', '2026-07-03')).toBe(-3);
    expect(monthsBetween('2026-07', '2027-01-06')).toBe(6);
  });
});

describe('a malformed rule is dropped, never guessed at', () => {
  // A rule that half-parses and still fires would bill a wrong number quietly.
  test.each([
    ['unknown type',            { type: 'teleport', when: { kind: 'every_day' } }],
    ['no selector',             { type: 'clip_start', at: '07:00' }],
    ['unknown selector kind',   { type: 'clip_start', when: { kind: 'whenever' }, at: '07:00' }],
    ['empty weekday list',      { type: 'clip_start', when: { kind: 'weekdays', days: [] }, at: '07:00' }],
    ['weekday out of range',    { type: 'clip_start', when: { kind: 'weekdays', days: [9] }, at: '07:00' }],
    ['month out of range',      { type: 'clip_start', when: { kind: 'months', months: [13] }, at: '07:00' }],
    ['nth_days with no anchor', { type: 'clip_start', when: { kind: 'nth_days', every: 3 }, at: '07:00' }],
    ['nth_days every: 0',       { type: 'clip_start', when: { kind: 'nth_days', start: '2026-07-06', every: 0 }, at: '07:00' }],
    ['nth_days bad anchor',     { type: 'clip_start', when: { kind: 'nth_days', start: 'soon', every: 3 }, at: '07:00' }],
    ['nth_months no anchor',    { type: 'clip_start', when: { kind: 'nth_months', every: 2 }, at: '07:00' }],
    ['clip with no time',       { type: 'clip_start', when: { kind: 'every_day' } }],
    ['add_time with no time',   { type: 'add_time', when: { kind: 'every_day' }, minutes: 30 }],
    ['add_time zero minutes',   { type: 'add_time', when: { kind: 'every_day' }, at: '17:25', minutes: 0 }],
    ['every mode, no from',     { type: 'add_time', when: { kind: 'every_day' }, mode: 'every', everyMin: 25, minutes: 30 }],
    ['every mode, no everyMin', { type: 'add_time', when: { kind: 'every_day' }, mode: 'every', from: '17:25', minutes: 30 }],
    ['break with no minutes',   { type: 'auto_break', when: { kind: 'every_day' }, trigger: { kind: 'always' } }],
    ['after_hours w/o hours',   { type: 'auto_break', when: { kind: 'every_day' }, minutes: 30, trigger: { kind: 'after_hours' } }],
    ['not an object',           'lunch'],
    ['null',                    null],
  ])('drops: %s', (_label, rule) => {
    expect(parseRules([rule])).toEqual([]);
  });

  test('a bad rule does not take its good neighbours down', () => {
    const rules = parseRules([
      { id: 'ok', type: 'clip_start', when: { kind: 'every_day' }, at: '07:00' },
      { type: 'nonsense' },
      { id: 'ok2', type: 'add_time', when: { kind: 'every_day' }, edge: 'after', at: '17:25', minutes: 30 },
    ]);
    expect(rules.map(r => r.id)).toEqual(['ok', 'ok2']);
  });

  test('rules absent / not an array → no rules, no throw', () => {
    expect(parsePolicy(JSON.stringify({ enabled: true })).rules).toEqual([]);
    expect(parsePolicy(JSON.stringify({ enabled: true, rules: 'lots' })).rules).toEqual([]);
  });
});

describe('the no-op guarantee still holds', () => {
  test('a disabled policy with rules changes nothing', () => {
    const policy = parsePolicy(JSON.stringify({ enabled: false, rules: [
      { type: 'auto_break', when: { kind: 'every_day' }, minutes: 60, trigger: { kind: 'always' } },
    ] }));
    const entries = [entry()];
    expect(roundEntriesForPay(entries, policy)).toBe(entries); // identity
  });

  test('enabled, rounding off, no rules → same array reference', () => {
    const entries = [entry()];
    expect(roundEntriesForPay(entries, parsePolicy(JSON.stringify({ enabled: true })))).toBe(entries);
  });

  test('a rule that matches no day leaves its entry untouched', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rules: [{ type: 'auto_break', when: { kind: 'weekdays', days: [0] }, minutes: 60, trigger: { kind: 'always' } }],
    }));
    const [out] = roundEntriesForPay([entry()], policy);
    expect(out.break_minutes).toBe(0);
    expect(out.rounding_adjusted).toBeUndefined();
  });
});

describe('clip_end and remove_time', () => {
  test('clip_end ignores time past the cutoff', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rules: [{ type: 'clip_end', when: { kind: 'every_day' }, at: '17:00' }],
    }));
    expect(paidHours(entry({ end_time: '19:00:00' }), policy)).toBeCloseTo(10, 5);
  });

  test('remove_time docks off the scheduled end', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      standardHours: stdHours(),
      rules: [{ type: 'remove_time', when: { kind: 'every_day' }, edge: 'after', at: '17:00', minutes: 30 }],
    }));
    expect(paidEnd(entry({ end_time: '17:30:00' }), policy)).toBe('16:30:00'); // 17:00 − 30
  });

  test('an adjustment can never invert the punch', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rules: [{ type: 'remove_time', when: { kind: 'every_day' }, edge: 'after', base: 'punch', at: '07:30', minutes: 600 }],
    }));
    expect(paidHours(entry(), policy)).toBeCloseTo(0, 5);
  });
});

describe('applyRules directly — stage order', () => {
  const exp = { startMin: toMin('07:00'), endMin: toMin('17:00') };

  test('the End Time rule is the ladder baseline, and rungs read the RAW punch', () => {
    // An End Time rule at 17:00 says "the day is not paid past 5:00 on its
    // own". It does NOT hide the punch from the rungs: an 18:00 clock-out has
    // still passed 17:25, so it earns the rung — measured off the 17:00
    // baseline the End Time rule established.
    //
    // Judging rungs on the clipped value instead would pull every punch back to
    // 17:00 and no rung could ever fire, which would make the two rule types
    // mutually exclusive.
    const rules = parseRules([
      { type: 'clip_end', when: { kind: 'every_day' }, at: '17:00' },
      { type: 'add_time', when: { kind: 'every_day' }, edge: 'after', at: '17:25', minutes: 30 },
    ]);
    expect(toHHMMSS(applyRules(toMin('07:00'), toMin('18:00'), 0, rules, exp).endMin)).toBe('17:30:00');
  });

  test('an End Time rule alone still caps the day', () => {
    const rules = parseRules([{ type: 'clip_end', when: { kind: 'every_day' }, at: '17:00' }]);
    expect(toHHMMSS(applyRules(toMin('07:00'), toMin('18:00'), 0, rules, exp).endMin)).toBe('17:00:00');
  });

  test('the End Time rule beats standardHours as the baseline', () => {
    // exp says the scheduled end is 17:00; the rule says 16:00. The rule wins,
    // so the rung lands on 16:30 rather than 17:30 — otherwise an admin could
    // set an End Time rule and watch the ladder ignore it.
    const rules = parseRules([
      { type: 'clip_end', when: { kind: 'every_day' }, at: '16:00' },
      { type: 'add_time', when: { kind: 'every_day' }, edge: 'after', at: '17:25', minutes: 30 },
    ]);
    expect(toHHMMSS(applyRules(toMin('07:00'), toMin('18:00'), 0, rules, exp).endMin)).toBe('16:30:00');
  });

  test('adjust runs before break: the break trigger sees the credited day', () => {
    const rules = parseRules([
      { type: 'add_time', when: { kind: 'every_day' }, edge: 'after', base: 'punch', at: '12:00', minutes: 60 },
      { type: 'auto_break', when: { kind: 'every_day' }, minutes: 30, trigger: { kind: 'after_hours', hours: 6 } },
    ]);
    // 07:00→12:30 is 5.5h, under the trigger; the +1h credit takes it to 6.5h,
    // which does fire the break.
    const out = applyRules(toMin('07:00'), toMin('12:30'), 0, rules, exp);
    expect(toHHMMSS(out.endMin)).toBe('13:30:00');
    expect(out.breakMin).toBe(30);
  });
});
