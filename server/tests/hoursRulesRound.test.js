/**
 * `round` rule (Phase 1 of migrating the fixed-slot sections into the custom-rule
 * builder). A round rule is a when-scoped override of the fixed-slot rounding for
 * its edge(s); the rounding math (roundEdge) is unchanged, so this only exercises
 * the new config-resolution path + parse.
 */

const { parseRules, parsePolicy, roundEntriesForPay } = require('../utils/hoursRules');

const entry = (over = {}) => ({ user_id: 1, work_date: '2026-07-06', wage_type: 'regular', start_time: '07:07:00', end_time: '17:22:00', break_minutes: 0, ...over });
const paid = (policy, e = entry()) => roundEntriesForPay([e], policy)[0];

describe('overnight punch is not collapsed to 0h by rounding/rules', () => {
  const overnight = (over = {}) => entry({ start_time: '22:07:00', end_time: '06:07:00', ...over });

  test('an overnight shift keeps its ~8h under a rounding policy (was paid $0)', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rules: [{ id: 'r1', type: 'round', when: { kind: 'every_day' }, edge: 'both', reference: 'clock', direction: 'nearest', intervalMin: 15 }],
    }));
    const o = paid(policy, overnight());
    expect(o.start_time).toBe('22:00:00');  // 22:07 → nearest 15
    expect(o.end_time).toBe('06:00:00');     // 06:07 → nearest 15 (NOT collapsed to 22:00)
  });

  test('overnight survives the applyRules path (a non-round rule present, rounding off)', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rounding: { clockIn: { direction: 'off' }, clockOut: { direction: 'off' } },
      rules: [{ id: 'b1', type: 'auto_break', when: { kind: 'every_day' }, trigger: { kind: 'after_hours', hours: 6 }, minutes: 30 }],
    }));
    const o = paid(policy, overnight({ start_time: '22:00:00', end_time: '06:00:00' }));
    expect(o.start_time).toBe('22:00:00');
    expect(o.end_time).toBe('06:00:00');     // not collapsed
  });

  test('an End Time (clip_end) rule at 06:00 caps an overnight shift instead of zeroing it', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rounding: { clockIn: { direction: 'off' }, clockOut: { direction: 'off' } },
      rules: [{ id: 'end', type: 'clip_end', when: { kind: 'every_day' }, at: '06:00', behavior: 'ignore' }],
    }));
    const o = paid(policy, overnight({ start_time: '22:00:00', end_time: '06:30:00' })); // punch out 06:30
    expect(o.start_time).toBe('22:00:00');
    expect(o.end_time).toBe('06:00:00');     // capped to the morning End Time, NOT collapsed to 22:00 ($0)
  });

  test('an after-edge clock add_time "every" ladder does not misfire across midnight', () => {
    // "Every 15 min past 06:00, add 5 min." Without the frame fix the extended punch
    // (end + 1440) measured a ~1470-min distance to the raw 06:00 threshold → ~99 rungs
    // (495 min added). Framed, it measures the true distance like a same-day shift.
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rounding: { clockIn: { direction: 'off' }, clockOut: { direction: 'off' } },
      rules: [{ id: 'ot', type: 'add_time', when: { kind: 'every_day' }, edge: 'after', anchor: 'clock', mode: 'every', from: '06:00', everyMin: 15, minutes: 5, base: 'punch' }],
    }));
    // Out BEFORE the threshold → nothing added (past < 0), not a full day of rungs.
    expect(paid(policy, overnight({ start_time: '22:00:00', end_time: '05:55:00' })).end_time).toBe('05:55:00');
    // Out 30 min past 06:00 → 3 rungs × 5 = 15 min → 06:45 (bounded), not ~14:45.
    expect(paid(policy, overnight({ start_time: '22:00:00', end_time: '06:30:00' })).end_time).toBe('06:45:00');
  });
});

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

describe('round rule — clock-out grace window (clock-grid, against_worker)', () => {
  // "Round by the hour, 10-minute grace." A clock-out within the grace of the hour
  // counts as that hour instead of being floored down — the fix for 4:59 → 4:00.
  const graceRule = () => parsePolicy(JSON.stringify({
    enabled: true,
    rules: [{ id: 'r1', type: 'round', when: { kind: 'every_day' }, edge: 'out', reference: 'clock', direction: 'against_worker', intervalMin: 60, graceMin: 10 }],
  }));
  const outAt = (end) => paid(graceRule(), entry({ start_time: '08:00:00', end_time: end })).end_time;

  test('16:50 (10 min before the hour) → counts as 17:00', () => { expect(outAt('16:50:00')).toBe('17:00:00'); });
  test('16:59 → 17:00 (used to floor to 16:00)', () => { expect(outAt('16:59:00')).toBe('17:00:00'); });
  test('16:49 (11 min before, past the grace) → floors to 16:00', () => { expect(outAt('16:49:00')).toBe('16:00:00'); });
  test('16:30 (well before) → floors to 16:00', () => { expect(outAt('16:30:00')).toBe('16:00:00'); });
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
