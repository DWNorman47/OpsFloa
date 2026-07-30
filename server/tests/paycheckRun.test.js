/**
 * Paycheck run engine — ruleset resolution (the setup-error tie-breaker), role
 * deduction scoping, and the per-check deduction math (exempt → deduct → cap → floor).
 */

const { resolveRuleset, deductionsForRole, computeRuleNet, applyGroupDeductions, groupOpts } = require('../utils/paycheckRun');

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

  test('combineGroup:false → the flagged check figures on its OWN gross, not the pair', () => {
    const ded = [{ id: 'x', name: 'Tax', kind: 'percent', value: 10, cap: null }];
    const rs = { deductions: { exemptAmountCents: 100000, combineGroup: false } }; // $1,000 exempt
    const [, c2] = applyGroupDeductions([
      { groupKey: '0', deductionsApply: false, gross: 3000 },
      { groupKey: '0', deductionsApply: true, gross: 3000 },
    ], ded, rs);
    expect(c2.base).toBe(2000);          // own 3000 − 1000 exempt (NOT the combined 6000)
    expect(c2.deductionTotal).toBe(200); // 10% of 2000
  });
});

describe('groupOpts — flatten nested deductions.group.{by,applyOn} → flat for groupPeriods', () => {
  test('maps the nested shape', () => {
    expect(groupOpts({ timing: 'grouped', group: { by: 'month', applyOn: 'last' } }))
      .toEqual({ timing: 'grouped', groupBy: 'month', applyOn: 'last' });
  });
  test('missing group → undefined groupBy/applyOn (never crashes)', () => {
    expect(groupOpts({ timing: 'every' })).toEqual({ timing: 'every', groupBy: undefined, applyOn: undefined });
    expect(groupOpts(undefined)).toEqual({ timing: undefined, groupBy: undefined, applyOn: undefined });
  });
});

describe('computeRuleNet — itemized lines always foot to the (capped) total, never negative', () => {
  const sum = ls => Math.round(ls.reduce((a, l) => a + l.amount, 0) * 100) / 100;

  test('a total cap trims the lines proportionally; they still sum to the total', () => {
    const ded = [
      { id: 'a', name: 'A', kind: 'fixed', value: 3.33, cap: null },
      { id: 'b', name: 'B', kind: 'fixed', value: 3.33, cap: null },
      { id: 'c', name: 'C', kind: 'fixed', value: 3.34, cap: null },
    ];
    const c = computeRuleNet(1000, ded, { deductions: { cap: { type: 'amount', valueCents: 500 } } });
    expect(c.deductionTotal).toBe(5);
    expect(sum(c.lines)).toBe(5);                     // foots exactly
    expect(c.lines.every(l => l.amount >= 0)).toBe(true);
  });

  test('a 1-cent trim near the float boundary is not skipped', () => {
    const ded = [{ id: 'x', name: 'X', kind: 'fixed', value: 0.29, cap: null }];
    const c = computeRuleNet(1000, ded, { deductions: { cap: { type: 'amount', valueCents: 28 } } });
    expect(c.deductionTotal).toBe(0.28);
    expect(sum(c.lines)).toBe(0.28);
  });

  test('many sub-cent lines under a hard cap never produce a negative line', () => {
    const ded = Array.from({ length: 4 }, (_, i) => ({ id: String(i), name: 'd' + i, kind: 'fixed', value: 0.01, cap: null }));
    const c = computeRuleNet(1000, ded, { deductions: { cap: { type: 'amount', valueCents: 2 } } });
    expect(c.deductionTotal).toBe(0.02);
    expect(sum(c.lines)).toBe(0.02);
    expect(c.lines.every(l => l.amount >= 0)).toBe(true); // was [.01,.01,.01,-.01] before the fix
  });
});
