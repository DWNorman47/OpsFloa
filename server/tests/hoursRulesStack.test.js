/**
 * Additive stacking of set-time (add/remove-time 'at') rules.
 *
 * Default is 'replacing': among the rules that fired on one edge, the largest
 * wins — "+30 at 5:25" and "+60 at 5:50" pay 60, not 90 (that's what David was
 * told earlier). stack:true flips a rule to 'additive' so its minutes pile on
 * top: mark both and the same pair pays 90.
 */

const { parsePolicy, roundEntriesForPay } = require('../utils/hoursRules');

// A clip_end at 17:00 is the baseline the schedule-based credit lands on, so the
// paid end reads as 17:00 + total credit — easy to eyeball.
function policyWith(rules) {
  return parsePolicy(JSON.stringify({
    enabled: true,
    rules: [{ id: 'end', type: 'clip_end', when: { kind: 'every_day' }, at: '17:00' }, ...rules],
  }));
}
const R30 = { id: 'a', type: 'add_time', when: { kind: 'every_day' }, edge: 'after', base: 'schedule', mode: 'at', minutes: 30, at: '17:25' };
const R60 = { id: 'b', type: 'add_time', when: { kind: 'every_day' }, edge: 'after', base: 'schedule', mode: 'at', minutes: 60, at: '17:50' };

const paidEnd = (policy, end_time) => roundEntriesForPay(
  [{ user_id: 1, work_date: '2026-07-06', wage_type: 'regular', start_time: '07:00:00', end_time, break_minutes: 0 }],
  policy,
)[0].end_time;

describe('two set-time rules, both fired (clocked out 18:00, past 5:50)', () => {
  test('replacing (default): the larger wins → 60 min → 18:00', () => {
    expect(paidEnd(policyWith([R30, R60]), '18:00:00')).toBe('18:00:00');
  });

  test('both additive: they sum → 90 min → 18:30', () => {
    expect(paidEnd(policyWith([{ ...R30, stack: true }, { ...R60, stack: true }]), '18:00:00')).toBe('18:30:00');
  });

  test('mixed (only the +60 additive): sum on top of the biggest replacing → 90 → 18:30', () => {
    expect(paidEnd(policyWith([R30, { ...R60, stack: true }]), '18:00:00')).toBe('18:30:00');
  });
});

describe('stacking only matters once more than one rule fires', () => {
  test('clocked out 17:40 (only the 5:25 rule fired): additive and replacing agree → 30 → 17:30', () => {
    expect(paidEnd(policyWith([{ ...R30, stack: true }, { ...R60, stack: true }]), '17:40:00')).toBe('17:30:00');
    expect(paidEnd(policyWith([R30, R60]), '17:40:00')).toBe('17:30:00');
  });
});

describe('backward compatible', () => {
  test('no stack field anywhere behaves exactly as before (largest wins)', () => {
    expect(paidEnd(policyWith([R30, R60]), '18:00:00')).toBe('18:00:00'); // 60, not 90
  });

  test('the flag round-trips through parse only when true', () => {
    const p = policyWith([{ ...R30, stack: true }, R60]);
    const a = p.rules.find(r => r.id === 'a');
    const b = p.rules.find(r => r.id === 'b');
    expect(a.stack).toBe(true);
    expect(b.stack).toBeUndefined(); // absent stays absent, not false
  });
});
