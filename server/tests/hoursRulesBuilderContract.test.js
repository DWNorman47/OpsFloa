/**
 * The contract between the rule builder UI and the engine.
 *
 * The builder writes JSON; the engine reads it. Nothing in the type system
 * connects them, so a renamed field or a stringified number would sail through
 * the client build, get dropped by `parseRules` on the server, and produce a
 * policy that silently does less than the admin configured. That failure is
 * invisible — no error, just a smaller number on an invoice.
 *
 * These fixtures are exactly what `coerceDraft` in
 * client/src/components/HoursRuleBuilder.jsx emits, one per rule type. If a
 * change to either side breaks the pairing, this fails.
 */

const { parseRules, parsePolicy, validatePolicy, roundEntriesForPay, toMin } =
  require('../utils/hoursRules');

// ── Verbatim builder output ──────────────────────────────────────────────────
const BUILDER_OUTPUT = [
  { id: 'ra1b2c', type: 'clip_start', when: { kind: 'weekdays', days: [1, 2, 3, 4, 5] }, at: '07:00' },
  { id: 'rd3e4f', type: 'clip_end', when: { kind: 'weekdays', days: [1, 2, 3, 4, 5] }, at: '17:00' },
  { id: 'rg5h6i', type: 'add_time', when: { kind: 'weekdays', days: [1, 2, 3, 4, 5] }, edge: 'after', base: 'schedule', mode: 'at', minutes: 30, at: '17:25' },
  { id: 'rj7k8l', type: 'add_time', when: { kind: 'weekdays', days: [1, 2, 3, 4, 5] }, edge: 'after', base: 'schedule', mode: 'every', minutes: 30, from: '17:25', everyMin: 25 },
  { id: 'rm9n0o', type: 'remove_time', when: { kind: 'every_day' }, edge: 'before', base: 'punch', mode: 'at', minutes: 15, at: '06:00' },
  { id: 'rp1q2r', type: 'auto_break', when: { kind: 'every_day' }, minutes: 60, trigger: { kind: 'always' } },
  { id: 'rs3t4u', type: 'auto_break', when: { kind: 'every_day' }, minutes: 30, trigger: { kind: 'after_hours', hours: 6 } },
  { id: 'rv5w6x', type: 'clip_start', when: { kind: 'month_weekdays', patterns: [{ week: -1, weekday: 5 }] }, at: '08:00' },
  { id: 'ry7z8a', type: 'clip_start', when: { kind: 'nth_days', start: '2026-07-06', every: 3 }, at: '08:00' },
  { id: 'rb9c0d', type: 'clip_start', when: { kind: 'nth_months', start: '2026-07', every: 2 }, at: '08:00' },
  { id: 're1f2g', type: 'clip_start', when: { kind: 'months', months: [7, 12] }, at: '08:00' },
  { id: 'rh3i4j', type: 'clip_start', when: { kind: 'month_days', days: [1, 15] }, at: '08:00' },
  { id: 'rk5l6m', type: 'clip_start', when: { kind: 'month_weeks', weeks: [1, -1] }, at: '08:00' },
  { id: 'rn7o8p', type: 'clip_start', when: { kind: 'nth_weeks', start: '2026-07-06', every: 2 }, at: '08:00' },
];

describe('every rule the builder can emit survives the engine', () => {
  test('none are dropped', () => {
    const parsed = parseRules(BUILDER_OUTPUT);
    const lost = BUILDER_OUTPUT.filter(r => !parsed.some(p => p.id === r.id)).map(r => `${r.id}/${r.type}/${r.when.kind}`);
    expect(lost).toEqual([]);
    expect(parsed).toHaveLength(BUILDER_OUTPUT.length);
  });

  test('every rule type the builder offers is one the engine knows', () => {
    const { RULE_TYPES, RULE_WHEN_KINDS } = require('../utils/hoursRules');
    // Mirrors the <option> values in the builder's type + when selects.
    const uiTypes = ['clip_start', 'clip_end', 'add_time', 'remove_time', 'auto_break', 'round'];
    const uiWhen = ['every_day', 'weekdays', 'month_days', 'month_weekdays', 'nth_days', 'months', 'nth_months', 'month_weeks', 'nth_weeks'];
    expect(uiTypes.every(x => RULE_TYPES.includes(x))).toBe(true);
    expect(uiWhen.every(x => RULE_WHEN_KINDS.includes(x))).toBe(true);
    // And nothing the engine supports is missing from the UI — a rule type
    // nobody can reach is a rule type nobody has.
    expect(RULE_TYPES.sort()).toEqual(uiTypes.sort());
    expect(RULE_WHEN_KINDS.sort()).toEqual(uiWhen.sort());
  });

  test('the round trip through JSON is lossless', () => {
    const policy = { version: 1, enabled: true, rules: BUILDER_OUTPUT };
    const reparsed = parsePolicy(JSON.stringify(policy));
    expect(reparsed.rules.map(r => r.id)).toEqual(BUILDER_OUTPUT.map(r => r.id));
  });
});

describe('add/remove time: schedule fallback (no Start/End rule required)', () => {
  test('the customer ladder as the builder would emit it is valid', () => {
    const policy = parsePolicy(JSON.stringify({ enabled: true, rules: BUILDER_OUTPUT }));
    expect(validatePolicy(policy)).toEqual([]);
  });

  test('add_time without a Start/End rule is now ALLOWED — it falls back to the schedule', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rules: [{ id: 'x', type: 'add_time', when: { kind: 'every_day' }, edge: 'after', base: 'schedule', mode: 'at', minutes: 30, at: '17:25' }],
    }));
    expect(validatePolicy(policy)).toEqual([]);
  });

  test('with no Start/End rule, add_time measures from the scheduled hours', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      // company standard hours give the baseline (keyed every weekday: 07:00–17:00)
      standardHours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), { start: '07:00', end: '17:00' }])),
      rules: [{ id: 'x', type: 'add_time', when: { kind: 'every_day' }, edge: 'after', base: 'schedule', mode: 'at', minutes: 30, at: '17:25' }],
    }));
    const paidEnd = (end_time) => roundEntriesForPay(
      [{ user_id: 1, work_date: '2026-07-06', wage_type: 'regular', start_time: '07:00:00', end_time, break_minutes: 0 }],
      policy,
    )[0].end_time;
    expect(paidEnd('17:25:00')).toBe('17:30:00'); // scheduled end 17:00 + 30
    expect(paidEnd('17:24:00')).toBe('17:00:00'); // below the rung → paid to the scheduled end, same as an End Time rule
  });

  test('with no rule AND no schedule, add_time is a no-op — never adds onto the raw punch', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rules: [{ id: 'x', type: 'add_time', when: { kind: 'every_day' }, edge: 'after', base: 'schedule', mode: 'at', minutes: 30, at: '17:25' }],
    }));
    const out = roundEntriesForPay(
      [{ user_id: 1, work_date: '2026-07-06', wage_type: 'regular', start_time: '07:00:00', end_time: '17:51:00', break_minutes: 0 }],
      policy,
    )[0];
    expect(out.end_time).toBe('17:51:00'); // no baseline → no credit (not 18:51)
  });

  test('base:punch needs no baseline, so it is not gated', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rules: [{ id: 'x', type: 'add_time', when: { kind: 'every_day' }, edge: 'after', base: 'punch', mode: 'at', minutes: 30, at: '17:25' }],
    }));
    expect(validatePolicy(policy)).toEqual([]);
  });
});

describe("the builder's own example produces David's table", () => {
  // Built exactly as an admin would: a Start Time rule, an End Time rule, then
  // two rungs. No standardHours — the End Time rule is the baseline.
  const policy = parsePolicy(JSON.stringify({
    enabled: true,
    rules: [
      { id: 'a', type: 'clip_start', when: { kind: 'every_day' }, at: '07:00' },
      { id: 'b', type: 'clip_end', when: { kind: 'every_day' }, at: '17:00' },
      { id: 'c', type: 'add_time', when: { kind: 'every_day' }, edge: 'after', base: 'schedule', mode: 'at', minutes: 30, at: '17:25' },
      { id: 'd', type: 'add_time', when: { kind: 'every_day' }, edge: 'after', base: 'schedule', mode: 'at', minutes: 60, at: '17:51' },
    ],
  }));

  const paidEnd = (end_time) => roundEntriesForPay(
    [{ user_id: 1, work_date: '2026-07-06', wage_type: 'regular', start_time: '07:00:00', end_time, break_minutes: 0 }],
    policy,
  )[0].end_time;

  test.each([
    ['17:24:00', '17:00:00'],
    ['17:25:00', '17:30:00'],
    ['17:50:00', '17:30:00'],
    ['17:51:00', '18:00:00'],
  ])('%s → %s, configured entirely from the builder', (punch, expected) => {
    expect(paidEnd(punch)).toBe(expected);
  });

  test('no standardHours needed — the End Time rule is the baseline', () => {
    expect(policy.standardHours).toEqual({});
    expect(toMin(paidEnd('17:25:00'))).toBe(toMin('17:30'));
  });
});
