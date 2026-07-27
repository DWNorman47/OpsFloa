/**
 * normalizePaycheckRules — defensive parse/clamp for the `paycheck_rules` setting.
 * The invariant: it NEVER throws and always returns a well-shaped policy, clamping
 * every fixed-value field to its allowed set (a bad settings row can't break a read).
 */

const { normalizePaycheckRules, normalizeRuleset } = require('../constants/paycheckRuleEnums');

describe('normalizePaycheckRules — safe parsing', () => {
  test('empty / null / garbage → empty policy', () => {
    for (const bad of ['', null, undefined, 'not json', '[1,2]', '42', JSON.stringify([1, 2])]) {
      expect(normalizePaycheckRules(bad)).toEqual({ version: 1, rulesets: [] });
    }
  });

  test('accepts a JSON string or a pre-parsed object', () => {
    const obj = { rulesets: [{ id: 'a', name: 'X' }] };
    expect(normalizePaycheckRules(JSON.stringify(obj)).rulesets).toHaveLength(1);
    expect(normalizePaycheckRules(obj).rulesets).toHaveLength(1);
  });

  test('caps the ruleset count at 50', () => {
    const many = { rulesets: Array.from({ length: 80 }, (_, i) => ({ id: `r${i}`, name: `R${i}` })) };
    expect(normalizePaycheckRules(many).rulesets).toHaveLength(50);
  });
});

describe('normalizeRuleset — field clamping', () => {
  test('bad enum values fall back to defaults', () => {
    const r = normalizeRuleset({
      schedule: { frequency: 'hourly', weekendShift: 'sideways', payWeekday: 99 },
      deductions: { timing: 'sometimes', group: { by: 'trio', applyOn: 'middle' }, scope: 'some', cap: { type: 'huge' } },
    }, 0);
    expect(r.schedule.frequency).toBe('biweekly');
    expect(r.schedule.weekendShift).toBe('none');
    expect(r.schedule.payWeekday).toBe(4);       // clamped default = Thursday
    expect(r.deductions.timing).toBe('every');
    expect(r.deductions.group.by).toBe('pair');
    expect(r.deductions.group.applyOn).toBe('second');
    expect(r.deductions.scope).toBe('all');
    expect(r.deductions.cap.type).toBe('none');
  });

  test('valid values pass through; money stays in cents; negatives floor to 0', () => {
    const r = normalizeRuleset({
      id: 'pr_x', name: 'Biweekly Thursday',
      schedule: { frequency: 'biweekly', payWeekday: 4, anchorDate: '2026-01-08', weekendShift: 'before' },
      deductions: {
        timing: 'grouped', group: { by: 'pair', applyOn: 'second' }, combineGroup: true,
        exemptAmountCents: 1100000, minNetCents: -500,
        cap: { type: 'percent', valuePct: 25, valueCents: 0 },
        scope: 'selected', selectedDeductionIds: ['d1', 'd2'],
      },
    }, 0);
    expect(r.schedule.frequency).toBe('biweekly');
    expect(r.schedule.anchorDate).toBe('2026-01-08');
    expect(r.schedule.weekendShift).toBe('before');
    expect(r.deductions.exemptAmountCents).toBe(1100000); // $11,000, untouched
    expect(r.deductions.minNetCents).toBe(0);             // negative floored
    expect(r.deductions.cap).toEqual({ type: 'percent', valueCents: 0, valuePct: 25 });
    expect(r.deductions.selectedDeductionIds).toEqual(['d1', 'd2']);
  });

  test('semi-monthly days: clamps to valid days-of-month, keeps at most two', () => {
    const r = normalizeRuleset({ schedule: { frequency: 'semimonthly', daysOfMonth: [15, 30, 40, 0] } }, 0);
    expect(r.schedule.daysOfMonth).toEqual([15, 30]); // 40 and 0 dropped, capped at 2
  });

  test('monthly "last" is preserved; a bad day defaults to 30', () => {
    expect(normalizeRuleset({ schedule: { frequency: 'monthly', dayOfMonth: 'last' } }, 0).schedule.dayOfMonth).toBe('last');
    expect(normalizeRuleset({ schedule: { frequency: 'monthly', dayOfMonth: 99 } }, 0).schedule.dayOfMonth).toBe(30);
  });

  test('combineGroup defaults to true, honored when false', () => {
    expect(normalizeRuleset({}, 0).deductions.combineGroup).toBe(true);
    expect(normalizeRuleset({ deductions: { combineGroup: false } }, 0).deductions.combineGroup).toBe(false);
  });

  test('missing id gets a stable index-based fallback; strings are length-capped', () => {
    const r = normalizeRuleset({ name: 'x'.repeat(200) }, 7);
    expect(r.id).toBe('pr_7');
    expect(r.name.length).toBe(120);
  });
});
