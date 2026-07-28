/**
 * Paycheck run engine — ruleset resolution (the setup-error tie-breaker), role
 * deduction scoping, and the per-check deduction math (exempt → deduct → cap → floor).
 */

const { resolveRuleset, deductionsForRole, computeRuleNet, applyGroupDeductions } = require('../utils/paycheckRun');

describe('resolveRuleset — assignment by role, errors are surfaced not guessed', () => {
  const RS = [{ id: 'a', name: 'A', roles: [1, 2] }, { id: 'b', name: 'B', roles: [3] }];

  test('no rulesets configured → no ruleset (just deductions), not an error', () => {
    expect(resolveRuleset([], 1)).toEqual({ ruleset: null });
  });
  test('worker with no role → no_role error', () => {
    expect(resolveRuleset(RS, null)).toEqual({ error: 'no_role' });
  });
  test('role matches nothing → no_ruleset error', () => {
    expect(resolveRuleset(RS, 9).error).toBe('no_ruleset');
  });
  test('role matches exactly one → that ruleset', () => {
    expect(resolveRuleset(RS, 2).ruleset.id).toBe('a');
  });
  test('role matches more than one → multiple_rulesets error with the names', () => {
    const dup = [{ id: 'a', name: 'A', roles: [1] }, { id: 'b', name: 'B', roles: [1] }];
    const r = resolveRuleset(dup, 1);
    expect(r.error).toBe('multiple_rulesets');
    expect(r.matches).toEqual(['A', 'B']);
  });
});

describe('deductionsForRole — company-wide + role-scoped', () => {
  const DEDS = [
    { id: 'ss', name: 'SS', kind: 'percent', value: 6, roleIds: [] },       // company-wide
    { id: 'union', name: 'Union', kind: 'fixed', value: 20, roleIds: [3] },  // role 3 only
  ];
  test('a role gets company-wide + its own role deductions', () => {
    expect(deductionsForRole(DEDS, 3).map(d => d.id)).toEqual(['ss', 'union']);
  });
  test('another role gets only the company-wide ones', () => {
    expect(deductionsForRole(DEDS, 1).map(d => d.id)).toEqual(['ss']);
  });
});

describe('computeRuleNet — exempt → deduct → cap → min-net floor', () => {
  const tax10 = [{ id: 'x', name: 'Tax', kind: 'percent', value: 10, cap: null }];

  test('exempt reduces the base a percent deduction computes from', () => {
    const rs = { deductions: { exemptAmountCents: 100000 } }; // $1,000 exempt
    const c = computeRuleNet(5000, tax10, rs);               // base 4000 → 10% = 400
    expect(c.base).toBe(4000);
    expect(c.deductionTotal).toBe(400);
    expect(c.net).toBe(4600);
  });

  test('null ruleset → deductions on full gross (no exempt/cap/floor)', () => {
    const c = computeRuleNet(5000, tax10, null);
    expect(c.deductionTotal).toBe(500);
    expect(c.net).toBe(4500);
  });

  test('cap by amount', () => {
    const rs = { deductions: { cap: { type: 'amount', valueCents: 25000 } } }; // $250 cap
    expect(computeRuleNet(5000, tax10, rs).deductionTotal).toBe(250);          // 500 → capped 250
  });

  test('cap by percent of base', () => {
    const tax40 = [{ id: 'x', name: 'Tax', kind: 'percent', value: 40, cap: null }];
    const rs = { deductions: { cap: { type: 'percent', valuePct: 25 } } };     // 25% of 5000 = 1250
    expect(computeRuleNet(5000, tax40, rs).deductionTotal).toBe(1250);         // 2000 → capped 1250
  });

  test('min-net floor: deductions never push net below the floor', () => {
    const rs = { deductions: { minNetCents: 480000 } };  // net never below $4,800
    const c = computeRuleNet(5000, tax10, rs);           // 10% = 500 → net 4500 < 4800
    expect(c.net).toBe(4800);
    expect(c.deductionTotal).toBe(200);                  // floored
  });

  test('baseGross overrides the deduction base but net comes off the check gross', () => {
    const c = computeRuleNet(6000, tax10, { deductions: { exemptAmountCents: 1100000 } }, 12000);
    expect(c.base).toBe(1000);          // (12000 combined − 11000 exempt)
    expect(c.deductionTotal).toBe(100); // 10% of 1000
    expect(c.net).toBe(5900);           // 6000 check − 100
  });
});

describe('applyGroupDeductions — combine the group, exempt once, deduct on the flagged check', () => {
  test("David's biweekly: two $6,000 checks, $11k exempt, deduct on the 2nd (10%)", () => {
    const ded = [{ id: 'x', name: 'Tax', kind: 'percent', value: 10, cap: null }];
    const rs = { deductions: { exemptAmountCents: 1100000 } }; // $11,000
    const [c1, c2] = applyGroupDeductions([
      { groupKey: '0', deductionsApply: false, gross: 6000 },
      { groupKey: '0', deductionsApply: true, gross: 6000 },
    ], ded, rs);
    expect(c1.deductionTotal).toBe(0);   // first check untouched
    expect(c1.net).toBe(6000);
    expect(c2.base).toBe(1000);          // 12000 combined − 11000 exempt
    expect(c2.deductionTotal).toBe(100); // 10% of 1000
    expect(c2.net).toBe(5900);           // 6000 − 100
  });
});
