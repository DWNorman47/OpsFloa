/**
 * Schedule-relative trigger anchor for add/remove-time rules.
 *
 * The `at`/`from` clock time only makes sense when everyone finishes at the same
 * hour. `anchor: 'schedule'` measures the trigger from each worker's OWN scheduled
 * end (or start) instead — an offset in minutes — so "+30 once they're 25 min past
 * quitting time" fires whether the shift ends at 17:00 or 14:00.
 *
 * This is the TRIGGER anchor; it is independent of `base` (where the credit lands).
 */

const { parsePolicy, roundEntriesForPay, ruleCredit } = require('../utils/hoursRules');

// A policy whose only rule is a schedule-anchored "add {minutes} once {offset} min
// past the scheduled end", with the whole week scheduled to `end`.
function policyEndingAt(end, rule) {
  return parsePolicy(JSON.stringify({
    enabled: true,
    standardHours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), { start: '07:00', end }])),
    rules: [rule],
  }));
}

const AT = { id: 'a', type: 'add_time', when: { kind: 'every_day' }, edge: 'after', base: 'schedule', mode: 'at', anchor: 'schedule', minutes: 30, offsetMin: 25 };

const paidEnd = (policy, end_time) => roundEntriesForPay(
  [{ user_id: 1, work_date: '2026-07-06', wage_type: 'regular', start_time: '07:00:00', end_time, break_minutes: 0 }],
  policy,
)[0].end_time;

describe('schedule anchor adapts the trigger to each shift end', () => {
  test('a 17:00 shift: +30 once 25 min past → fires at 17:25', () => {
    const p = policyEndingAt('17:00', AT);
    expect(paidEnd(p, '17:25:00')).toBe('17:30:00'); // scheduled end 17:00 + 30
    expect(paidEnd(p, '17:24:00')).toBe('17:00:00'); // one minute short → paid to scheduled end
  });

  test('a 14:00 shift: the SAME rule fires at 14:25, no clock time to change', () => {
    const p = policyEndingAt('14:00', AT);
    expect(paidEnd(p, '14:25:00')).toBe('14:30:00'); // adapts: 14:00 + 30
    expect(paidEnd(p, '14:24:00')).toBe('14:00:00');
  });

  test('offset 0 means "any time past the scheduled end"', () => {
    const p = policyEndingAt('17:00', { ...AT, offsetMin: 0 });
    expect(paidEnd(p, '17:01:00')).toBe('17:30:00'); // 1 min over → the +30 rung
    expect(paidEnd(p, '17:00:00')).toBe('17:00:00'); // exactly on time → not late, no credit
  });

  test('with no schedule to resolve, the rule no-ops (never adds onto the raw punch)', () => {
    const p = parsePolicy(JSON.stringify({ enabled: true, rules: [AT] }));
    expect(paidEnd(p, '17:51:00')).toBe('17:51:00'); // no baseline → untouched, not 17:30
  });

  test('an End Time rule is the anchor when set, overriding the schedule', () => {
    const p = parsePolicy(JSON.stringify({
      enabled: true,
      standardHours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), { start: '07:00', end: '17:00' }])),
      rules: [{ id: 'e', type: 'clip_end', when: { kind: 'every_day' }, at: '16:00' }, AT],
    }));
    // Anchor is the End Time rule (16:00), so the rung is 16:25, and the credit
    // lands on 16:00 + 30 = 16:30.
    expect(paidEnd(p, '16:25:00')).toBe('16:30:00');
    expect(paidEnd(p, '16:24:00')).toBe('16:00:00');
  });
});

describe('schedule anchor, ladder (every) mode', () => {
  const EVERY = { ...AT, mode: 'every', everyMin: 30 };
  const p = policyEndingAt('17:00', EVERY);

  test.each([
    ['17:24:00', '17:00:00'], // short of the first rung → scheduled end
    ['17:25:00', '17:30:00'], // rung 1: +30
    ['17:55:00', '18:00:00'], // rung 2: +60
    ['18:25:00', '18:30:00'], // rung 3: +90
  ])('%s → %s', (punch, expected) => {
    expect(paidEnd(p, punch)).toBe(expected);
  });
});

describe('the clock anchor is unchanged (regression)', () => {
  test('a fixed 17:25 threshold still keys off the wall clock, not the schedule', () => {
    const p = parsePolicy(JSON.stringify({
      enabled: true,
      standardHours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), { start: '07:00', end: '14:00' }])),
      rules: [{ id: 'c', type: 'add_time', when: { kind: 'every_day' }, edge: 'after', base: 'punch', mode: 'at', anchor: 'clock', minutes: 30, at: '17:25' }],
    }));
    // Schedule ends 14:00, but the clock-anchored rule ignores that and only
    // fires at the wall-clock 17:25.
    expect(paidEnd(p, '17:25:00')).toBe('17:55:00'); // base:punch → 17:25 + 30
    expect(paidEnd(p, '17:24:00')).toBe('17:24:00'); // below the fixed time → untouched
  });
});

describe('ruleCredit resolves the schedule-relative threshold from anchorBase', () => {
  const rule = { type: 'add_time', edge: 'after', mode: 'at', anchor: 'schedule', minutes: 30, offsetMin: 25 };
  test('fires at anchorBase + offset, inclusive', () => {
    expect(ruleCredit(rule, 1045, 1020)).toBe(30); // baseEnd 17:00 (1020) + 25 = 1045 → hit
    expect(ruleCredit(rule, 1044, 1020)).toBe(0);  // one minute short
  });
  test('no anchorBase → 0 (cannot resolve the trigger)', () => {
    expect(ruleCredit(rule, 1200, null)).toBe(0);
  });
  test('before edge measures offset BEFORE the scheduled start', () => {
    const early = { ...rule, edge: 'before' };
    expect(ruleCredit(early, 455, 480)).toBe(30); // start 08:00 (480) − 25 = 455 → clocked in that early
    expect(ruleCredit(early, 456, 480)).toBe(0);
  });
});
