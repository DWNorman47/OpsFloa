/**
 * `round` rule (Phase 1 of migrating the fixed-slot sections into the custom-rule
 * builder). A round rule is a when-scoped override of the fixed-slot rounding for
 * its edge(s); the rounding math (roundEdge) is unchanged, so this only exercises
 * the new config-resolution path + parse.
 */

const { parseRules, parsePolicy, roundEntriesForPay } = require('../utils/hoursRules');

const entry = (over = {}) => ({ user_id: 1, work_date: '2026-07-06', wage_type: 'regular', start_time: '07:07:00', end_time: '17:22:00', break_minutes: 0, ...over });
const paid = (policy, e = entry()) => roundEntriesForPay([e], policy)[0];

describe('round rule — engine', () => {
  test('rounds both edges to the nearest interval on the wall clock', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rules: [{ id: 'r1', type: 'round', when: { kind: 'every_day' }, edge: 'both', reference: 'clock', direction: 'nearest', intervalMin: 15 }],
    }));
    const o = paid(policy);
    expect(o.start_time).toBe('07:00:00'); // 07:07 → nearest 15
    expect(o.end_time).toBe('17:15:00');   // 17:22 → nearest 15
  });

  test("edge 'out' rounds only the clock-out, leaving the clock-in exact", () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rules: [{ id: 'r1', type: 'round', when: { kind: 'every_day' }, edge: 'out', reference: 'clock', direction: 'nearest', intervalMin: 15 }],
    }));
    const o = paid(policy);
    expect(o.start_time).toBe('07:07:00'); // untouched
    expect(o.end_time).toBe('17:15:00');
  });

  test("direction 'off' overrides a global rounding config (turn rounding off)", () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rounding: {
        clockIn: { reference: 'clock', intervalMin: 15, graceMin: 0, direction: 'nearest' },
        clockOut: { reference: 'clock', intervalMin: 15, graceMin: 0, direction: 'nearest' },
      },
      rules: [{ id: 'r1', type: 'round', when: { kind: 'every_day' }, edge: 'both', direction: 'off', intervalMin: 15 }],
    }));
    const o = paid(policy);
    // the off rule wins over the global 'nearest' → punch stays exact
    expect(o.start_time).toBe('07:07:00');
    expect(o.end_time).toBe('17:22:00');
  });

  test('no round rule → the global rounding config still applies (backward compatible)', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rounding: {
        clockIn: { reference: 'clock', intervalMin: 15, graceMin: 0, direction: 'nearest' },
        clockOut: { reference: 'clock', intervalMin: 15, graceMin: 0, direction: 'nearest' },
      },
      rules: [],
    }));
    const o = paid(policy);
    expect(o.start_time).toBe('07:00:00');
    expect(o.end_time).toBe('17:15:00');
  });
});

describe('round rule — parse', () => {
  test('preserves the fields the builder emits', () => {
    const rules = parseRules([{ id: 'x', type: 'round', when: { kind: 'weekdays', days: [1, 2, 3, 4, 5] }, edge: 'out', reference: 'clock', direction: 'toward_worker', intervalMin: 15, graceMin: 5 }]);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ type: 'round', edge: 'out', reference: 'clock', direction: 'toward_worker', intervalMin: 15, graceMin: 5 });
  });

  test('drops a round rule with no usable interval', () => {
    expect(parseRules([{ type: 'round', when: { kind: 'every_day' }, edge: 'both' }])).toHaveLength(0);
  });

  test('defaults a bad edge/reference/direction to sane values', () => {
    const [r] = parseRules([{ type: 'round', when: { kind: 'every_day' }, edge: 'sideways', reference: 'moon', direction: 'diagonal', intervalMin: 10 }]);
    expect(r).toMatchObject({ edge: 'both', reference: 'schedule', direction: 'nearest', intervalMin: 10 });
  });
});
