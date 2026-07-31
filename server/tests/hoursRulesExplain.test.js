/**
 * Explain trace — the opt-in per-entry rule trace that powers the Team Member
 * Report's "why is this number what it is" expander.
 *
 * Two properties matter most:
 *   1. The trace names what actually fired (rounding, clip, adjust, auto-break),
 *      with the real effect and the rule id(s) so the UI can link them.
 *   2. It NEVER changes the math: paid start/end/break with explain on must equal
 *      the values with explain off. The trace rides alongside, it doesn't steer.
 */

const { parsePolicy, roundEntriesForPay } = require('../utils/hoursRules');

const entry = (over = {}) => ({ user_id: 1, work_date: '2026-07-06', wage_type: 'regular', start_time: '07:07:00', end_time: '17:22:00', break_minutes: 0, ...over });
const withExplain = (policy, e = entry()) => roundEntriesForPay([e], policy, { explain: true })[0];
const plain = (policy, e = entry()) => roundEntriesForPay([e], policy)[0];

describe('explain trace — what fired', () => {
  test('rounding names the from→to and the driving round rule', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rules: [{ id: 'r1', type: 'round', when: { kind: 'every_day' }, edge: 'both', reference: 'clock', direction: 'nearest', intervalMin: 15 }],
    }));
    const o = withExplain(policy);
    const inItem = o.explain.find(x => x.code === 'rounding_in');
    const outItem = o.explain.find(x => x.code === 'rounding_out');
    expect(inItem).toMatchObject({ fromTime: '07:07:00', toTime: '07:00:00', ruleId: 'r1' });
    expect(outItem).toMatchObject({ fromTime: '17:22:00', toTime: '17:15:00', ruleId: 'r1' });
  });

  test('global rounding config (no rule) traces with ruleId null', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rounding: {
        clockIn: { reference: 'clock', intervalMin: 15, graceMin: 0, direction: 'nearest' },
        clockOut: { reference: 'clock', intervalMin: 15, graceMin: 0, direction: 'nearest' },
      },
    }));
    const o = withExplain(policy);
    expect(o.explain.find(x => x.code === 'rounding_in')).toMatchObject({ toTime: '07:00:00', ruleId: null });
  });

  test('a clip_end rule traces the boundary it pulled the punch back to', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rules: [{ id: 'c1', type: 'clip_end', when: { kind: 'every_day' }, at: '17:00', behavior: 'ignore' }],
    }));
    const o = withExplain(policy, entry({ start_time: '08:00:00', end_time: '17:30:00' }));
    const clip = o.explain.find(x => x.code === 'clip_end');
    expect(clip).toMatchObject({ toMin: 1020, ruleIds: ['c1'] }); // 17:00 = 1020 min
    expect(o.end_time).toBe('17:00:00');
  });

  test('a schedule-anchored add_time traces the real paid movement + rule id', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      standardHours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), { start: '07:00', end: '17:00' }])),
      rules: [{ id: 'a1', type: 'add_time', when: { kind: 'every_day' }, edge: 'after', base: 'schedule', mode: 'at', anchor: 'schedule', minutes: 30, offsetMin: 25 }],
    }));
    const o = withExplain(policy, entry({ start_time: '07:00:00', end_time: '17:25:00' }));
    const add = o.explain.find(x => x.code === 'add_time');
    expect(add).toMatchObject({ edge: 'after', ruleIds: ['a1'] });
    expect(add.deltaMin).toBe(5); // punch 17:25 → paid 17:30 (scheduled 17:00 + 30) = +5 on this line
    expect(o.end_time).toBe('17:30:00');
  });

  test('an auto_break rule traces the minutes it added', () => {
    const policy = parsePolicy(JSON.stringify({
      enabled: true,
      rules: [{ id: 'b1', type: 'auto_break', when: { kind: 'every_day' }, minutes: 30, trigger: { kind: 'after_hours', hours: 6 } }],
    }));
    const o = withExplain(policy, entry({ start_time: '08:00:00', end_time: '17:00:00', break_minutes: 0 }));
    const br = o.explain.find(x => x.code === 'auto_break');
    expect(br).toMatchObject({ breakMin: 30, addedMin: 30, ruleIds: ['b1'] });
    expect(o.break_minutes).toBe(30);
  });

  test('an untouched entry gets no explain and the same reference', () => {
    const policy = parsePolicy(JSON.stringify({ enabled: true, rules: [{ id: 'x', type: 'clip_end', when: { kind: 'every_day' }, at: '23:00', behavior: 'ignore' }] }));
    const e = entry({ start_time: '08:00:00', end_time: '16:00:00' }); // ends well before 23:00 → clip never binds
    const o = roundEntriesForPay([e], policy, { explain: true })[0];
    expect(o).toBe(e); // nothing fired → identical object, no explain key
    expect(o.explain).toBeUndefined();
  });
});

describe('explain never changes the math', () => {
  const policies = [
    ['rounding', { enabled: true, rounding: { clockIn: { reference: 'clock', intervalMin: 15, graceMin: 0, direction: 'nearest' }, clockOut: { reference: 'clock', intervalMin: 15, graceMin: 0, direction: 'nearest' } } }],
    ['clip', { enabled: true, rules: [{ id: 'c', type: 'clip_end', when: { kind: 'every_day' }, at: 1020, behavior: 'ignore' }] }],
    ['add_time', { enabled: true, standardHours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), { start: '07:00', end: '17:00' }])), rules: [{ id: 'a', type: 'add_time', when: { kind: 'every_day' }, edge: 'after', base: 'schedule', mode: 'at', anchor: 'schedule', minutes: 30, offsetMin: 25 }] }],
    ['auto_break', { enabled: true, rules: [{ id: 'b', type: 'auto_break', when: { kind: 'every_day' }, minutes: 30, trigger: { kind: 'after_hours', hours: 6 } }] }],
  ];
  test.each(policies)('%s: paid start/end/break identical with explain on vs off', (_name, raw) => {
    const policy = parsePolicy(JSON.stringify(raw));
    const e = entry({ start_time: '07:07:00', end_time: '17:22:00', break_minutes: 0 });
    const off = plain(policy, e);
    const on = withExplain(policy, e);
    expect({ s: on.start_time, e: on.end_time, b: on.break_minutes })
      .toEqual({ s: off.start_time, e: off.end_time, b: off.break_minutes });
  });
});
