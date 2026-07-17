/**
 * The hours-rules rule list (Milestone 4) — the open-ended half of the policy.
 *
 * The headline fixture is a real customer's day, described as:
 *   "Every day deducts a lunch hour automatically. Ignore clocking in before
 *    7am. If clocked in to or past 5:25pm, add a half hour to the day's hours
 *    worked; if to or past 5:50pm, add an hour; then past 6:25, add another
 *    half hour, and so on. All time on Saturday is overtime."
 *
 * None of that is a rule type. It's five small rules that compose — which is
 * the point of the design, and what these tests exist to prove.
 */

const {
  parsePolicy,
  parseRules,
  applyRules,
  ruleMatchesDate,
  roundEntriesForPay,
  toMin,
  nthWeekdayOfMonth,
  isLastWeekdayOfMonth,
} = require('../utils/hoursRules');
const { computeOT } = require('../utils/payCalculations');

const WEEKDAYS = [1, 2, 3, 4, 5];

// The customer's policy. The ladder is four `add_time` rungs, not a feature.
function customerPolicy() {
  return parsePolicy(JSON.stringify({
    enabled: true,
    rules: [
      { id: 'lunch', type: 'auto_break', when: { kind: 'every_day' }, minutes: 60, trigger: { kind: 'always' } },
      { id: 'in7',   type: 'clip_start', when: { kind: 'weekdays', days: WEEKDAYS }, at: '07:00' },
      { id: 'l1',    type: 'add_time',   when: { kind: 'weekdays', days: WEEKDAYS }, edge: 'after', at: '17:25', minutes: 30 },
      { id: 'l2',    type: 'add_time',   when: { kind: 'weekdays', days: WEEKDAYS }, edge: 'after', at: '17:50', minutes: 30 },
      { id: 'l3',    type: 'add_time',   when: { kind: 'weekdays', days: WEEKDAYS }, edge: 'after', at: '18:25', minutes: 30 },
      { id: 'l4',    type: 'add_time',   when: { kind: 'weekdays', days: WEEKDAYS }, edge: 'after', at: '18:50', minutes: 30 },
    ],
  }));
}

// 2026-07-06 Mon · 2026-07-11 Sat
const MON = '2026-07-06';
const SAT = '2026-07-11';

const entry = (over = {}) => ({
  user_id: 1, work_date: MON, wage_type: 'regular',
  start_time: '07:00:00', end_time: '17:00:00', break_minutes: 0, ...over,
});

// Paid hours for one entry after the policy runs, lunch included.
function paidHours(e, policy = customerPolicy()) {
  const [out] = roundEntriesForPay([e], policy);
  return (toMin(out.end_time) - toMin(out.start_time)) / 60 - (out.break_minutes || 0) / 60;
}

describe('the ladder — rungs compose into a step function', () => {
  // Each row is the customer's own description, read back.
  test.each([
    ['17:24:00', 0.0, 'a minute short of the first rung earns nothing'],
    ['17:25:00', 0.5, 'to or past 5:25 → half an hour (inclusive)'],
    ['17:35:00', 0.5, 'between rungs it stays at half an hour'],
    ['17:49:00', 0.5, 'still half an hour right up to the next rung'],
    ['17:50:00', 1.0, 'to or past 5:50 → an hour'],
    ['18:00:00', 1.0, 'past 5:50 but not 6:25 stays at an hour'],
    ['18:25:00', 1.5, 'past 6:25 → another half hour'],
    ['18:50:00', 2.0, 'and so on'],
  ])('clock out %s → +%s (%s)', (end_time, credit) => {
    // Worked 07:00→end, minus the lunch hour, plus the ladder credit.
    const worked = (toMin(end_time) - toMin('07:00')) / 60 - 1;
    expect(paidHours(entry({ end_time }))).toBeCloseTo(worked + credit, 5);
  });

  test('a rung does NOT push the punch into the next rung', () => {
    // The trap: applying rungs one at a time would take a 17:30 punch to 18:00
    // (satisfying "after 17:50"), then to 18:30, and run away down the ladder.
    // All rungs must read the same snapshot.
    const worked = (toMin('17:30') - toMin('07:00')) / 60 - 1; // 9.5
    expect(paidHours(entry({ end_time: '17:30:00' }))).toBeCloseTo(worked + 0.5, 5);
  });

  test('the ladder does not fire on Saturday — it is scoped to weekdays', () => {
    const sat = entry({ work_date: SAT, end_time: '18:00:00' });
    // 07:00→18:00 = 11h, minus the everyday lunch, no credit.
    expect(paidHours(sat)).toBeCloseTo(10, 5);
  });
});

describe('clip_start — ignore the early clock-in', () => {
  test('clocking in before 7 is not paid', () => {
    expect(paidHours(entry({ start_time: '06:30:00' }))).toBeCloseTo(9, 5); // 07:00→17:00 − lunch
  });

  test('clocking in AFTER 7 is not silently forgiven', () => {
    // max() only moves the start forward. Arriving at 07:20 pays from 07:20 —
    // clipping must not become "everyone is paid from 7 regardless".
    expect(paidHours(entry({ start_time: '07:20:00' }))).toBeCloseTo(8 + 40 / 60, 5);
  });

  test('it does not dock a late arrival to an interval either', () => {
    // Distinct from the rounding engine's against_worker, which would round
    // 07:20 up to 07:30. A clip is a clamp, not a rounding.
    const [out] = roundEntriesForPay([entry({ start_time: '07:20:00' })], customerPolicy());
    expect(out.start_time).toBe('07:20:00');
  });
});

describe('auto_break — max(expected, logged), never the sum', () => {
  test('no logged break → the expected hour is deducted', () => {
    expect(paidHours(entry({ break_minutes: 0 }))).toBeCloseTo(9, 5);
  });

  test('a logged break shorter than expected → the expected hour wins', () => {
    // 30 logged vs 60 expected → 60. NOT 90: break_minutes is already deducted
    // everywhere downstream, so summing would take the lunch twice.
    expect(paidHours(entry({ break_minutes: 30 }))).toBeCloseTo(9, 5);
  });

  test('a logged break LONGER than expected wins — they really were away', () => {
    expect(paidHours(entry({ break_minutes: 90 }))).toBeCloseTo(8.5, 5);
  });

  test("the customer's count logic falls out of comparing totals", () => {
    // "Three breaks expected, two found → one auto break." Three 30-min rules
    // = 90 expected; two logged at 30 each = 60; max() supplies the missing 30.
    // Nothing counts breaks — break_minutes is one integer, so it can't.
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rules: [1, 2, 3].map(i => ({
        id: `b${i}`, type: 'auto_break', when: { kind: 'every_day' }, minutes: 30, trigger: { kind: 'always' },
      })),
    }));
    const [twoFound] = roundEntriesForPay([entry({ break_minutes: 60 })], policy);
    expect(twoFound.break_minutes).toBe(90);

    const [allThree] = roundEntriesForPay([entry({ break_minutes: 90 })], policy);
    expect(allThree.break_minutes).toBe(90); // nothing added

    // "A 10 and a 20 minute break is the same as two 15s" — only the total is
    // compared, so an odd split that still totals 90 adds nothing either.
    const [oddSplit] = roundEntriesForPay([entry({ break_minutes: 90 })], policy);
    expect(oddSplit.break_minutes).toBe(90);
  });

  test('after_hours trigger spares a short day', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rules: [{ id: 'b', type: 'auto_break', when: { kind: 'every_day' }, minutes: 30, trigger: { kind: 'after_hours', hours: 6 } }],
    }));
    // A 3-hour morning keeps its 3 hours.
    expect(paidHours(entry({ end_time: '10:00:00' }), policy)).toBeCloseTo(3, 5);
    // A 10-hour day pays the break.
    expect(paidHours(entry({ end_time: '17:00:00' }), policy)).toBeCloseTo(9.5, 5);
  });

  test('the raw break is preserved when the rule overrides it', () => {
    const [out] = roundEntriesForPay([entry({ break_minutes: 15 })], customerPolicy());
    expect(out.break_minutes).toBe(60);
    expect(out.raw_break_minutes).toBe(15);
  });
});

describe('added time counts toward overtime', () => {
  test("a 0.5 credit on a 9.5h day makes 2h of OT, not 1.5", () => {
    // David: "The +0.5 counts toward the 8 hours." The credit extends the paid
    // punch, so classification sees 10h and the whole 2h over the threshold is
    // overtime. The alternative — credit after classification — would give
    // 1.5h OT + 0.5h regular and a different invoice.
    const [paid] = roundEntriesForPay([entry({ end_time: '17:30:00' })], customerPolicy());
    const { regularHours, overtimeHours } = computeOT([paid], 'daily', 8);
    expect(regularHours).toBeCloseTo(8, 5);
    expect(overtimeHours).toBeCloseTo(2, 5);
  });
});

describe('day selectors', () => {
  const r = when => ({ type: 'clip_start', when, at: '07:00' });

  test('every_day matches anything', () => {
    expect(ruleMatchesDate(parseRules([r({ kind: 'every_day' })])[0], SAT)).toBe(true);
  });

  test('weekdays matches by day of week', () => {
    const rule = parseRules([r({ kind: 'weekdays', days: WEEKDAYS })])[0];
    expect(ruleMatchesDate(rule, MON)).toBe(true);
    expect(ruleMatchesDate(rule, SAT)).toBe(false);
  });

  test('month_days matches by date of month', () => {
    const rule = parseRules([r({ kind: 'month_days', days: [6, 20] })])[0];
    expect(ruleMatchesDate(rule, '2026-07-06')).toBe(true);
    expect(ruleMatchesDate(rule, '2026-07-07')).toBe(false);
  });

  test('month_weekdays matches "first Monday"', () => {
    const rule = parseRules([r({ kind: 'month_weekdays', patterns: [{ week: 1, weekday: 1 }] })])[0];
    expect(ruleMatchesDate(rule, '2026-07-06')).toBe(true);  // 1st Monday of July
    expect(ruleMatchesDate(rule, '2026-07-13')).toBe(false); // 2nd
  });

  test('month_weekdays week:-1 means the LAST one, which is not a fixed nth', () => {
    // July 2026 has 4 Mondays (6,13,20,27); August has 5 (3,10,17,24,31).
    const rule = parseRules([r({ kind: 'month_weekdays', patterns: [{ week: -1, weekday: 1 }] })])[0];
    expect(ruleMatchesDate(rule, '2026-07-27')).toBe(true);
    expect(ruleMatchesDate(rule, '2026-07-20')).toBe(false);
    expect(ruleMatchesDate(rule, '2026-08-31')).toBe(true);
    expect(ruleMatchesDate(rule, '2026-08-24')).toBe(false);
  });

  test('nth/last helpers', () => {
    expect(nthWeekdayOfMonth('2026-07-06')).toBe(1);
    expect(nthWeekdayOfMonth('2026-07-13')).toBe(2);
    expect(isLastWeekdayOfMonth('2026-07-27')).toBe(true);
    expect(isLastWeekdayOfMonth('2026-07-20')).toBe(false);
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
    ['clip with no time',       { type: 'clip_start', when: { kind: 'every_day' } }],
    ['add_time with no time',   { type: 'add_time', when: { kind: 'every_day' }, minutes: 30 }],
    ['add_time zero minutes',   { type: 'add_time', when: { kind: 'every_day' }, at: '17:25', minutes: 0 }],
    ['add_time negative',       { type: 'add_time', when: { kind: 'every_day' }, at: '17:25', minutes: -30 }],
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

  test('rules is absent / not an array → no rules, no throw', () => {
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
    const policy = parsePolicy(JSON.stringify({ enabled: true }));
    const entries = [entry()];
    expect(roundEntriesForPay(entries, policy)).toBe(entries);
  });

  test('a rule that matches no day leaves its entry untouched', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rules: [{ type: 'auto_break', when: { kind: 'weekdays', days: [0] }, minutes: 60, trigger: { kind: 'always' } }],
    }));
    const [out] = roundEntriesForPay([entry()], policy); // MON vs Sunday-only rule
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
    expect(paidHours(entry({ end_time: '19:00:00' }), policy)).toBeCloseTo(10, 5); // capped at 17:00
  });

  test('remove_time subtracts, and cannot invert the punch', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rules: [{ type: 'remove_time', when: { kind: 'every_day' }, edge: 'after', at: '07:30', minutes: 600 }],
    }));
    expect(paidHours(entry(), policy)).toBeCloseTo(0, 5); // clamped, never negative
  });

  test("edge 'before' tests the clock-in", () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rules: [{ type: 'add_time', when: { kind: 'every_day' }, edge: 'before', at: '07:00', minutes: 30 }],
    }));
    expect(paidHours(entry({ start_time: '06:45:00' }), policy)).toBeCloseTo(10.75, 5); // 06:45→17:00 +0.5
    expect(paidHours(entry({ start_time: '07:15:00' }), policy)).toBeCloseTo(9.75, 5);  // no credit
  });
});

describe('applyRules directly — order of stages', () => {
  test('clip runs before adjust: the credit is judged on the clipped punch', () => {
    // A clip_end at 17:00 plus a rung at 17:25 must not both fire — after
    // clipping, the punch is 17:00 and the rung's threshold is not met.
    const rules = parseRules([
      { type: 'clip_end', when: { kind: 'every_day' }, at: '17:00' },
      { type: 'add_time', when: { kind: 'every_day' }, edge: 'after', at: '17:25', minutes: 30 },
    ]);
    const out = applyRules(toMin('07:00'), toMin('18:00'), 0, rules);
    expect(out.endMin).toBe(toMin('17:00'));
  });

  test('adjust runs before break: the break trigger sees the adjusted day', () => {
    const rules = parseRules([
      { type: 'add_time', when: { kind: 'every_day' }, edge: 'after', at: '12:00', minutes: 60 },
      { type: 'auto_break', when: { kind: 'every_day' }, minutes: 30, trigger: { kind: 'after_hours', hours: 6 } },
    ]);
    // 07:00→12:30 is 5.5h — under the trigger. The +1h credit takes it to 6.5h,
    // which does fire the break.
    const out = applyRules(toMin('07:00'), toMin('12:30'), 0, rules);
    expect(out.endMin).toBe(toMin('13:30'));
    expect(out.breakMin).toBe(30);
  });
});
