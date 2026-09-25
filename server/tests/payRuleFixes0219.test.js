/**
 * Pay-rule fixes (review 2026-09-24, migration 0219 batch) — engine side.
 * Ported from the reviewer's scratch proofs (review.test.js / review2.test.js),
 * inverted to assert the FIXED behaviour:
 *   1. toward_worker schedule rounding only snaps within the grace; overnight
 *      schedules frame their end on the next day for a same-day punch.
 *   2. full-day leave pays the Regular Shift default only on working days; a
 *      0-hour Time Off Value rule is valid.
 *   3. leave on one day is capped at that day's value (no stacking).
 *   4. auto_break is evaluated once per worker-day, across split entries.
 */
const HR = require('../utils/hoursRules');
const PC = require('../utils/payCalculations');

describe('rounding — toward_worker only snaps within the grace', () => {
  const edge = (direction, reference = 'schedule') => ({ reference, intervalMin: 15, graceMin: 5, direction });

  test('schedule 08–17, punch 08:00–11:00 toward_worker → paid 08:00–11:00 (was 17:00)', () => {
    const exp = { startMin: 8 * 60, endMin: 17 * 60 };
    const r = HR.applyRounding('08:00:00', '11:00:00', exp, { clockIn: edge('toward_worker'), clockOut: edge('toward_worker') });
    expect(r).toEqual({ start: '08:00:00', end: '11:00:00' });
  });

  test('arriving late beyond grace is not snapped back to the schedule', () => {
    const exp = { startMin: 8 * 60, endMin: 17 * 60 };
    const r = HR.applyRounding('12:00:00', '13:00:00', exp, { clockIn: edge('toward_worker'), clockOut: edge('toward_worker') });
    expect(r).toEqual({ start: '12:00:00', end: '13:00:00' });
    expect(PC.hoursWorked(r.start, r.end)).toBe(1);
  });

  test('beyond grace rounds the actual punch in the worker\'s favour (per interval)', () => {
    const exp = { startMin: 8 * 60, endMin: 17 * 60 };
    const r = HR.applyRounding('08:10:00', '16:50:00', exp, { clockIn: edge('toward_worker'), clockOut: edge('toward_worker') });
    // 10 min late (> 5 grace) → floor to 08:00; 10 min early (> 5 grace) → ceil to 17:00
    expect(r).toEqual({ start: '08:00:00', end: '17:00:00' });
    const r2 = HR.applyRounding('08:20:00', '16:35:00', exp, { clockIn: edge('toward_worker'), clockOut: edge('toward_worker') });
    expect(r2).toEqual({ start: '08:15:00', end: '16:45:00' });
  });

  test('within the grace still counts as the scheduled edge', () => {
    const exp = { startMin: 8 * 60, endMin: 17 * 60 };
    const r = HR.applyRounding('08:04:00', '16:56:00', exp, { clockIn: edge('toward_worker'), clockOut: edge('toward_worker') });
    expect(r).toEqual({ start: '08:00:00', end: '17:00:00' });
  });

  test('full pipeline: toward_worker policy, 12:00–13:00 punch → 1h (was 9h)', () => {
    const pol = { enabled: true, standardHours: { '1': { start: '08:00', end: '17:00' } }, rounding: { clockIn: edge('toward_worker'), clockOut: edge('toward_worker') } };
    const out = HR.roundEntriesFromSettings([{ user_id: 1, work_date: '2026-09-14', start_time: '12:00:00', end_time: '13:00:00', break_minutes: 0 }], { hours_rules: JSON.stringify(pol) });
    expect(PC.entryDuration(out[0])).toBe(1);
  });

  test('Honduras preset: punch 07:00–11:00 is paid 4h, not 9h', () => {
    const EVERY = { kind: 'every_day' };
    const pol = { enabled: true, standardHours: { '1': { start: '07:00', end: '16:00' } }, rules: [
      { id: 'p1', type: 'round', when: EVERY, edge: 'in', reference: 'schedule', direction: 'against_worker', intervalMin: 60, graceMin: 15 },
      { id: 'p2', type: 'round', when: EVERY, edge: 'out', reference: 'schedule', direction: 'toward_worker', intervalMin: 60, graceMin: 30 },
    ] };
    const out = HR.roundEntriesFromSettings([{ user_id: 1, work_date: '2026-09-14', start_time: '07:00:00', end_time: '11:00:00', break_minutes: 0 }], { hours_rules: JSON.stringify(pol) });
    expect(out[0].end_time).toBe('11:00:00');
    expect(PC.entryDuration(out[0])).toBe(4);
    // Headline behaviours unchanged: 30 min over → full extra hour; 30 min early (= grace) → 16:00.
    const late = HR.roundEntriesFromSettings([{ user_id: 1, work_date: '2026-09-14', start_time: '07:00:00', end_time: '16:30:00', break_minutes: 0 }], { hours_rules: JSON.stringify(pol) });
    expect(late[0].end_time).toBe('17:00:00');
    const early = HR.roundEntriesFromSettings([{ user_id: 1, work_date: '2026-09-14', start_time: '07:00:00', end_time: '15:30:00', break_minutes: 0 }], { hours_rules: JSON.stringify(pol) });
    expect(early[0].end_time).toBe('16:00:00');
  });
});

describe('rounding — overnight schedule (22:00–06:00)', () => {
  const edge = (direction) => ({ reference: 'schedule', intervalMin: 15, graceMin: 5, direction });
  const exp = { startMin: 22 * 60, endMin: 6 * 60 };

  test('same-day punch 22:00–23:30, against_worker out → 1.5h (was 0h)', () => {
    const r = HR.applyRounding('22:00:00', '23:30:00', exp, { clockIn: edge('against_worker'), clockOut: edge('against_worker') });
    expect(r).toEqual({ start: '22:00:00', end: '23:30:00' });
    expect(PC.hoursWorked(r.start, r.end)).toBe(1.5);
  });

  test('full overnight punch still pays to 06:00', () => {
    const r = HR.applyRounding('22:00:00', '06:00:00', exp, { clockIn: edge('against_worker'), clockOut: edge('against_worker') });
    expect(r).toEqual({ start: '22:00:00', end: '06:00:00' });
  });

  test('schedule-based add_time on an overnight shift does not fire on a same-day punch', () => {
    const rules = HR.parseRules([{ id: 'a', type: 'add_time', when: { kind: 'every_day' }, edge: 'after', base: 'schedule', anchor: 'schedule', offsetMin: 0, minutes: 30 }]);
    const out = HR.applyRules(22 * 60, 23 * 60 + 30, 0, rules, { startMin: 22 * 60, endMin: 6 * 60 });
    expect(out.endMin).toBe(23 * 60 + 30);
  });
});

describe('leave valuation — working days only', () => {
  test('full-day vacation Fri–Mon, no shifts, no rules → Fri + Mon only (16h, was 32h)', () => {
    const r = PC.computeLeaveHours([{ type: 'vacation', hours: null, start_date: '2026-09-04', end_date: '2026-09-07' }], new Map(), [], 8, '2026-09-01', '2026-09-30');
    expect(r.vacation).toBe(16);
    expect(r.leaveByDate.get('2026-09-05') || 0).toBe(0);
  });

  test('weekday-only Time Off Value rule → weekends are 0 (20h, was 36h)', () => {
    const pol = { enabled: true, rules: [{ id: 'tv', type: 'sick_value', when: { kind: 'weekdays', days: [1, 2, 3, 4, 5] }, hours: 10, applies: 'both' }] };
    const rules = HR.sickRulesFromSettings({ hours_rules: JSON.stringify(pol) });
    const r = PC.computeLeaveHours([{ type: 'vacation', hours: null, start_date: '2026-09-04', end_date: '2026-09-07' }], new Map(), rules, 8, '2026-09-01', '2026-09-30');
    expect(r.vacation).toBe(20);
  });

  test('working days come from the policy standard hours (Mon–Sat company pays Saturday)', () => {
    const day = { start: '07:00', end: '16:00' };
    const pol = { enabled: false, standardHours: { 1: day, 2: day, 3: day, 4: day, 5: day, 6: day } };
    const rules = HR.sickRulesFromSettings({ hours_rules: JSON.stringify(pol) });
    expect([...rules.workDays].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    const r = PC.computeLeaveHours([{ type: 'vacation', hours: null, start_date: '2026-09-04', end_date: '2026-09-07' }], new Map(), rules, 8, '2026-09-01', '2026-09-30');
    expect(r.vacation).toBe(24); // Fri + Sat + Mon
  });

  test('the factory carries the same work days', () => {
    const f = HR.sickRulesByRoleFactory({});
    expect([...f(null, 1).workDays].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  test('a scheduled weekend shift is still valued', () => {
    const r = PC.computeLeaveHours([{ type: 'sick', hours: null, start_date: '2026-09-05', end_date: '2026-09-05' }], new Map([['2026-09-05', 6]]), [], 8, '2026-09-01', '2026-09-30');
    expect(r.sick).toBe(6);
  });

  test('opts.workDays overrides', () => {
    const r = PC.computeLeaveHours([{ type: 'sick', hours: null, start_date: '2026-09-05', end_date: '2026-09-06' }], new Map(), [], 8, '2026-09-01', '2026-09-30', null, { workDays: [0, 6] });
    expect(r.sick).toBe(16);
  });

  test('a 0-hour Time Off Value rule parses and zeroes its days', () => {
    const parsed = HR.parseRules([{ id: 'z', type: 'sick_value', when: { kind: 'weekdays', days: [5] }, hours: 0 }]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].hours).toBe(0);
    const r = PC.computeLeaveHours([{ type: 'vacation', hours: null, start_date: '2026-09-04', end_date: '2026-09-04' }], new Map(), parsed, 8, '2026-09-01', '2026-09-30');
    expect(r.vacation).toBe(0);
  });

  test('a blank / negative Time Off Value is still dropped', () => {
    expect(HR.parseRules([{ id: 'b', type: 'sick_value', when: { kind: 'every_day' }, hours: '' }])).toHaveLength(0);
    expect(HR.parseRules([{ id: 'n', type: 'sick_value', when: { kind: 'every_day' }, hours: -1 }])).toHaveLength(0);
  });
});

describe('leave valuation — one day never pays more than the day', () => {
  test('sick + vacation + two partials on one 8h day → 8h total (was 24h)', () => {
    const r = PC.computeLeaveHours([
      { type: 'sick', hours: null, start_date: '2026-09-08', end_date: '2026-09-08' },
      { type: 'vacation', hours: null, start_date: '2026-09-08', end_date: '2026-09-08' },
      { type: 'sick', hours: 4, start_date: '2026-09-08', end_date: '2026-09-08' },
      { type: 'sick', hours: 4, start_date: '2026-09-08', end_date: '2026-09-08' },
    ], new Map(), [], 8, '2026-09-01', '2026-09-30');
    expect(r.sick + r.vacation).toBe(8);
    expect(r.sick).toBe(8);     // the first full day fills the cap
    expect(r.leaveByDate.get('2026-09-08')).toBe(8);
  });

  test('two partials that fit under the day both pay', () => {
    const r = PC.computeLeaveHours([
      { type: 'sick', hours: 3, start_date: '2026-09-08', end_date: '2026-09-08' },
      { type: 'vacation', hours: 4, start_date: '2026-09-08', end_date: '2026-09-08' },
    ], new Map(), [], 8, '2026-09-01', '2026-09-30');
    expect(r.sick).toBe(3);
    expect(r.vacation).toBe(4);
  });

  test('partials on a non-working day do not stack (largest one pays)', () => {
    const r = PC.computeLeaveHours([
      { type: 'sick', hours: 3, start_date: '2026-09-05', end_date: '2026-09-05' },
      { type: 'sick', hours: 4, start_date: '2026-09-05', end_date: '2026-09-05' },
    ], new Map(), [], 8, '2026-09-01', '2026-09-30');
    expect(r.sick).toBe(4);
  });

  test('capped lines are flagged in the explain detail', () => {
    const detail = [];
    PC.computeLeaveHours([
      { type: 'sick', hours: null, start_date: '2026-09-08', end_date: '2026-09-08' },
      { type: 'vacation', hours: 4, start_date: '2026-09-08', end_date: '2026-09-08' },
    ], new Map(), [], 6, '2026-09-01', '2026-09-30', detail);
    expect(detail).toEqual([{ type: 'sick', date: '2026-09-08', hours: 6, source: 'default' }]);
  });
});

describe('auto_break — once per worker-day', () => {
  const settings = (trigger) => ({ hours_rules: JSON.stringify({ enabled: true, rules: [{ id: 'b', type: 'auto_break', when: { kind: 'every_day' }, minutes: 30, trigger }] }) });
  const day = [
    { user_id: 1, work_date: '2026-09-14', start_time: '07:00:00', end_time: '12:00:00', break_minutes: 0 },
    { user_id: 1, work_date: '2026-09-14', start_time: '12:00:00', end_time: '17:00:00', break_minutes: 0 },
  ];
  const total = (out) => out.reduce((s, e) => s + PC.entryDuration(e), 0);

  test('always: a split 5h+5h day deducts ONE 30-min break (9.5h, was 9h)', () => {
    const out = HR.roundEntriesFromSettings(day, settings({ kind: 'always' }));
    expect(total(out)).toBe(9.5);
  });

  test('after 6h: the day total (10h) triggers the break even when split 5+5 (was 10h)', () => {
    const out = HR.roundEntriesFromSettings(day, settings({ kind: 'after_hours', hours: 6 }));
    expect(total(out)).toBe(9.5);
    const one = HR.roundEntriesFromSettings([{ ...day[0], end_time: '17:00:00' }], settings({ kind: 'after_hours', hours: 6 }));
    expect(PC.entryDuration(one[0])).toBe(9.5);
  });

  test('the break lands on the longest entry', () => {
    const out = HR.roundEntriesFromSettings([
      { ...day[0], end_time: '09:00:00' },
      { ...day[1], start_time: '09:00:00' },
    ], settings({ kind: 'always' }));
    expect(out[0].break_minutes || 0).toBe(0);
    expect(out[1].break_minutes).toBe(30);
  });

  test('logged breaks across the day count toward the expected break', () => {
    const out = HR.roundEntriesFromSettings([
      { ...day[0], break_minutes: 15 },
      { ...day[1], break_minutes: 15 },
    ], settings({ kind: 'always' }));
    expect(total(out)).toBe(9.5); // 15 + 15 logged = 30 expected → nothing added
  });

  test('different workers / days are independent', () => {
    const out = HR.roundEntriesFromSettings([
      day[0],
      { ...day[1], user_id: 2 },
      { ...day[1], work_date: '2026-09-15' },
    ], settings({ kind: 'always' }));
    expect(out.map(e => e.break_minutes)).toEqual([30, 30, 30]);
  });

  test('explain trace names the auto_break on the entry that took it', () => {
    const out = HR.roundEntriesFromSettings(day, settings({ kind: 'always' }), { explain: true });
    const notes = out.flatMap(e => (e.explain || []).filter(x => x.code === 'auto_break'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ addedMin: 30, ruleIds: ['b'] });
  });

  test('autoBreakForDay spills when one entry cannot absorb the break', () => {
    const r = HR.autoBreakForDay([{ workedMin: 20, loggedBreak: 0 }, { workedMin: 15, loggedBreak: 0 }], HR.parseRules([{ id: 'b', type: 'auto_break', when: { kind: 'every_day' }, minutes: 30, trigger: { kind: 'always' } }]));
    expect(r.breaks).toEqual([20, 10]);
  });
});
