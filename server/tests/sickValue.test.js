/**
 * sick_value rule + sickHoursForPeriod: an approved 'sick' day is paid the hours
 * its weekday rule gives (e.g. Mon+Thu = 9h, Fri = 8h), as its own category.
 * A day matching no rule is worth 0; overlapping requests don't double-count;
 * days are clipped to the pay period; no rules → 0 (unchanged).
 */

const { sickHoursForPeriod } = require('../utils/payCalculations');
const { sickRulesFromSettings } = require('../utils/hoursRules');

const sickRules = (rules) => sickRulesFromSettings({ hours_rules: JSON.stringify({ enabled: true, rules }) });

// David's example: Mon(1) + Thu(4) = 9h, Fri(5) = 8h.
const RULES = [
  { id: 'a', type: 'sick_value', when: { kind: 'weekdays', days: [1, 4] }, hours: 9 },
  { id: 'b', type: 'sick_value', when: { kind: 'weekdays', days: [5] }, hours: 8 },
];
// Week of Mon 2026-07-06 … Sun 2026-07-12.
const WK = ['2026-07-06', '2026-07-12'];
const req = (start_date, end_date) => ({ start_date, end_date });

describe('parse', () => {
  test('sick_value rules parse with hours + when', () => {
    const r = sickRules(RULES);
    expect(r.map(x => x.hours)).toEqual([9, 8]);
    expect(r[0].type).toBe('sick_value');
  });
});

describe('sickHoursForPeriod', () => {
  const rules = sickRules(RULES);

  test('a Mon–Fri sick week values each day by its weekday rule', () => {
    // Mon 9 + Tue 0 + Wed 0 + Thu 9 + Fri 8 = 26
    expect(sickHoursForPeriod([req('2026-07-06', '2026-07-10')], rules, ...WK)).toBe(26);
  });

  test('a single Friday is worth 8', () => {
    expect(sickHoursForPeriod([req('2026-07-10', '2026-07-10')], rules, ...WK)).toBe(8);
  });

  test('a day with no matching rule (Tuesday) is worth 0', () => {
    expect(sickHoursForPeriod([req('2026-07-07', '2026-07-07')], rules, ...WK)).toBe(0);
  });

  test('days are clipped to the pay period', () => {
    // Sick Mon–Fri but the period is only Mon–Wed → just Monday's 9
    expect(sickHoursForPeriod([req('2026-07-06', '2026-07-10')], rules, '2026-07-06', '2026-07-08')).toBe(9);
  });

  test('overlapping requests do not double-count a day', () => {
    expect(sickHoursForPeriod([req('2026-07-06', '2026-07-06'), req('2026-07-06', '2026-07-07')], rules, ...WK)).toBe(9);
  });

  test('no sick_value rules → 0 (unchanged)', () => {
    expect(sickHoursForPeriod([req('2026-07-06', '2026-07-10')], [], ...WK)).toBe(0);
  });

  test('no requests → 0', () => {
    expect(sickHoursForPeriod([], rules, ...WK)).toBe(0);
  });
});
