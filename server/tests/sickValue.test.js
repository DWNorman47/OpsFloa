/**
 * computeLeaveHours: approved sick/vacation time-off → paid { sick, vacation }
 * hours, valued schedule-first. Precedence for a FULL day: scheduled shift hours
 * → weekday leave-value rule → company Regular Shift default. Partial requests
 * (an `hours` value) pay exactly that. Vacation works identically to sick.
 */

const { computeLeaveHours, shiftHoursByDate } = require('../utils/payCalculations');
const { sickRulesFromSettings } = require('../utils/hoursRules');

// One weekday leave rule: Monday(1) = 9h. (Everything else falls through.)
const rules = sickRulesFromSettings({ hours_rules: JSON.stringify({
  enabled: true, rules: [{ id: 'a', type: 'sick_value', when: { kind: 'weekdays', days: [1] }, hours: 9 }],
}) });
const WK = ['2026-07-06', '2026-07-12']; // Mon 07-06 … Sun 07-12
const NO_SHIFTS = new Map();
const DEF = 8; // Regular Shift default
const full = (type, start_date, end_date) => ({ type, hours: null, start_date, end_date });

describe('shiftHoursByDate', () => {
  test('sums shift durations per day', () => {
    const m = shiftHoursByDate([{ shift_date: '2026-07-06', start_time: '08:00:00', end_time: '12:00:00' }]);
    expect(m.get('2026-07-06')).toBeCloseTo(4);
  });
});

describe('computeLeaveHours — full-day precedence', () => {
  test('scheduled shift hours win over the rule', () => {
    const shifts = shiftHoursByDate([{ shift_date: '2026-07-06', start_time: '08:00:00', end_time: '12:00:00' }]); // 4h Mon
    const r = computeLeaveHours([full('sick', '2026-07-06', '2026-07-06')], shifts, rules, DEF, ...WK);
    expect(r).toEqual({ sick: 4, vacation: 0 }); // 4 scheduled, not 9 (rule)
  });

  test('no shift → the weekday rule (Monday = 9)', () => {
    const r = computeLeaveHours([full('sick', '2026-07-06', '2026-07-06')], NO_SHIFTS, rules, DEF, ...WK);
    expect(r.sick).toBe(9);
  });

  test('no shift and no rule → the Regular Shift default (Tuesday = 8)', () => {
    const r = computeLeaveHours([full('sick', '2026-07-07', '2026-07-07')], NO_SHIFTS, rules, DEF, ...WK);
    expect(r.sick).toBe(8);
  });
});

describe('computeLeaveHours — partial + vacation + edges', () => {
  test('a partial request pays exactly the logged hours', () => {
    const r = computeLeaveHours([{ type: 'sick', hours: 2, start_date: '2026-07-07', end_date: '2026-07-07' }], NO_SHIFTS, rules, DEF, ...WK);
    expect(r.sick).toBe(2);
  });

  test('a partial straddling the period start is NOT paid here (anchored to its start date)', () => {
    // Logged 6h partial that started in the PREVIOUS period (07-04). The fetch
    // query returns it because its end (07-08) overlaps this period, but the lump
    // must be paid in the period containing its start — not double-paid here.
    const r = computeLeaveHours(
      [{ type: 'sick', hours: 6, start_date: '2026-07-04', end_date: '2026-07-08' }],
      NO_SHIFTS, rules, DEF, ...WK
    );
    expect(r.sick).toBe(0);
  });

  test('a partial that starts inside the period IS paid here', () => {
    const r = computeLeaveHours(
      [{ type: 'sick', hours: 6, start_date: '2026-07-07', end_date: '2026-07-13' }],
      NO_SHIFTS, rules, DEF, ...WK
    );
    expect(r.sick).toBe(6);
  });

  test('vacation is valued the same way, on its own total', () => {
    const r = computeLeaveHours([
      full('vacation', '2026-07-06', '2026-07-06'), // Mon → rule 9
      full('sick', '2026-07-07', '2026-07-07'),      // Tue → default 8
    ], NO_SHIFTS, rules, DEF, ...WK);
    expect(r).toEqual({ sick: 8, vacation: 9 });
  });

  test('overlapping same-type requests do not double-count a day', () => {
    const r = computeLeaveHours([full('sick', '2026-07-06', '2026-07-06'), full('sick', '2026-07-06', '2026-07-07')], NO_SHIFTS, rules, DEF, ...WK);
    expect(r.sick).toBe(9 + 8); // Mon 9 + Tue 8, Monday counted once
  });

  test('days are clipped to the pay period', () => {
    // Sick Mon–Fri but the period is only Mon–Tue → Mon 9 + Tue 8 = 17
    const r = computeLeaveHours([full('sick', '2026-07-06', '2026-07-10')], NO_SHIFTS, rules, DEF, '2026-07-06', '2026-07-07');
    expect(r.sick).toBe(17);
  });

  test('no requests / no range → zero', () => {
    expect(computeLeaveHours([], NO_SHIFTS, rules, DEF, ...WK)).toEqual({ sick: 0, vacation: 0 });
    expect(computeLeaveHours([full('sick', '2026-07-06', '2026-07-06')], NO_SHIFTS, rules, DEF, null, null)).toEqual({ sick: 0, vacation: 0 });
  });
});

describe('computeLeaveHours — detail breakdown (explain)', () => {
  test('records how each leave day got its hours', () => {
    const detail = [];
    const shifts = shiftHoursByDate([{ shift_date: '2026-07-06', start_time: '08:00:00', end_time: '12:00:00' }]); // Mon 4h
    computeLeaveHours([
      full('sick', '2026-07-06', '2026-07-06'),                                          // Mon scheduled → schedule
      full('sick', '2026-07-07', '2026-07-07'),                                          // Tue no shift/rule → default
      { type: 'vacation', hours: 2, start_date: '2026-07-08', end_date: '2026-07-08' },   // partial
    ], shifts, rules, DEF, ...WK, detail);
    expect(detail).toEqual([
      { type: 'sick', date: '2026-07-06', hours: 4, source: 'schedule' },
      { type: 'sick', date: '2026-07-07', hours: 8, source: 'default' },
      { type: 'vacation', date: '2026-07-08', hours: 2, source: 'partial' },
    ]);
  });

  test('a rule-valued day carries the winning rule id', () => {
    const detail = [];
    computeLeaveHours([full('sick', '2026-07-06', '2026-07-06')], NO_SHIFTS, rules, DEF, ...WK, detail); // Mon rule = 9
    expect(detail).toEqual([{ type: 'sick', date: '2026-07-06', hours: 9, source: 'rule', ruleId: 'a' }]);
  });
});

describe('computeLeaveHours — applies (sick / vacation / both)', () => {
  const RANGE = ['2026-07-06', '2026-07-19']; // two Mondays: 07-06 and 07-13
  const ruleFor = (applies) => sickRulesFromSettings({ hours_rules: JSON.stringify({
    enabled: true, rules: [{ id: 'x', type: 'sick_value', when: { kind: 'weekdays', days: [1] }, hours: 9, applies }],
  }) });

  test('a sick-only rule values a sick day but not a vacation day', () => {
    const r = computeLeaveHours([
      full('sick', '2026-07-06', '2026-07-06'),      // Monday → rule 9
      full('vacation', '2026-07-13', '2026-07-13'),  // Monday, but rule is sick-only → default 8
    ], NO_SHIFTS, ruleFor('sick'), DEF, ...RANGE);
    expect(r).toEqual({ sick: 9, vacation: 8 });
  });

  test('a vacation-only rule values a vacation day but not a sick day', () => {
    const r = computeLeaveHours([
      full('sick', '2026-07-06', '2026-07-06'),      // Monday, rule is vacation-only → default 8
      full('vacation', '2026-07-13', '2026-07-13'),  // Monday → rule 9
    ], NO_SHIFTS, ruleFor('vacation'), DEF, ...RANGE);
    expect(r).toEqual({ sick: 8, vacation: 9 });
  });

  test("a 'both' rule (and a legacy rule with no applies) values either", () => {
    const both = computeLeaveHours([full('sick', '2026-07-06', '2026-07-06'), full('vacation', '2026-07-13', '2026-07-13')], NO_SHIFTS, ruleFor('both'), DEF, ...RANGE);
    expect(both).toEqual({ sick: 9, vacation: 9 });
    // A rule stored before `applies` existed parses to applies:'both' → same result.
    const legacy = computeLeaveHours([full('sick', '2026-07-06', '2026-07-06')], NO_SHIFTS, [{ type: 'sick_value', when: { kind: 'weekdays', days: [1] }, hours: 9 }], DEF, ...RANGE);
    expect(legacy.sick).toBe(9);
  });
});
