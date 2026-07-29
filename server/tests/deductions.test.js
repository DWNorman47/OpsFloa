/**
 * Payroll deductions — the gross → net math for the per-worker pay stub.
 *
 * Deductions are a company-wide JSON list plus per-worker rows, each a percent of
 * gross wages (optionally capped) or a fixed amount. Empty config must be a pure
 * no-op so a company that never touches the feature keeps a gross-only stub.
 */

const {
  parseCompanyDeductions,
  normalizeWorkerDeductions,
  computeDeductions,
  payStubTotals,
} = require('../utils/deductions');

describe('parseCompanyDeductions', () => {
  test('reads {items:[…]}, drops malformed entries', () => {
    const raw = JSON.stringify({ items: [
      { id: 'a', name: 'Social Security', kind: 'percent', value: 3.5, cap: 300 },
      { id: 'b', name: 'Uniform', kind: 'fixed', value: 100 },
      { id: 'c', name: 'Bad kind', kind: 'nonsense', value: 5 },   // bad kind → dropped
      { id: 'd', name: '', kind: 'percent', value: 5 },            // no name → dropped
      { id: 'e', name: 'Negative', kind: 'fixed', value: -1 },     // negative → dropped
      'junk',                                                      // not an object → dropped
    ] });
    const list = parseCompanyDeductions(raw);
    expect(list.map(d => d.name)).toEqual(['Social Security', 'Uniform']);
    expect(list[0]).toMatchObject({ kind: 'percent', value: 3.5, cap: 300 });
    expect(list[1]).toMatchObject({ kind: 'fixed', value: 100, cap: null });
  });

  test('empty / bad input is an empty list, never a throw', () => {
    expect(parseCompanyDeductions('')).toEqual([]);
    expect(parseCompanyDeductions(null)).toEqual([]);
    expect(parseCompanyDeductions('not json')).toEqual([]);
    expect(parseCompanyDeductions(JSON.stringify({ items: 'x' }))).toEqual([]);
  });

  test('also accepts a bare array', () => {
    expect(parseCompanyDeductions(JSON.stringify([{ name: 'X', kind: 'fixed', value: 10 }]))).toHaveLength(1);
  });

  test('a percent deduction over 100% is clamped to 100 (never drives net negative)', () => {
    const list = parseCompanyDeductions(JSON.stringify({ items: [
      { id: 'a', name: 'Fat finger', kind: 'percent', value: 150 }, // 150% typo
      { id: 'b', name: 'Fine', kind: 'percent', value: 60 },
      { id: 'c', name: 'Fixed big', kind: 'fixed', value: 5000 },   // fixed is NOT clamped
    ] }));
    expect(list.find(d => d.id === 'a').value).toBe(100); // clamped
    expect(list.find(d => d.id === 'b').value).toBe(60);  // untouched
    expect(list.find(d => d.id === 'c').value).toBe(5000); // fixed amounts are not percentages
    // A single 100% clamp means one deduction can take at most the whole check, never more.
    const { total } = computeDeductions(2000, [list.find(d => d.id === 'a')]);
    expect(total).toBe(2000); // 100% of 2000, not 3000
  });

  test('role scope: roleIds normalized to integer DB keys; absent = all employees', () => {
    const raw = JSON.stringify({ items: [
      { id: 'a', name: 'Union dues', kind: 'fixed', value: 20, roleIds: [3, 3, 'x', null, {}] },
      { id: 'b', name: 'Social Security', kind: 'percent', value: 6 }, // no roleIds → company-wide
    ] });
    const list = parseCompanyDeductions(raw);
    expect(list[0].roleIds).toEqual([3]);      // de-duped, invalid ids dropped
    expect(list[1].roleIds).toEqual([]);        // absent → all employees
  });

  test('an id-less legacy deduction receives a deterministic selectable id', () => {
    const [deduction] = parseCompanyDeductions([{ name: 'Union dues', kind: 'fixed', value: 20 }]);
    expect(deduction.id).toBe('legacy:Union dues:fixed:20');
  });
});

describe('normalizeWorkerDeductions', () => {
  test('maps active DB rows, skips inactive, prefixes ids', () => {
    const rows = [
      { id: 1, name: 'Loan repayment', kind: 'fixed', value: 50, cap_amount: null, active: true },
      { id: 2, name: 'Old garnishment', kind: 'fixed', value: 25, active: false }, // inactive → skipped
      { id: 3, name: 'Extra %', kind: 'percent', value: 2, cap_amount: 40, active: true },
    ];
    const list = normalizeWorkerDeductions(rows);
    expect(list.map(d => d.name)).toEqual(['Loan repayment', 'Extra %']);
    expect(list[0].id).toBe('w1');
    expect(list[1]).toMatchObject({ kind: 'percent', value: 2, cap: 40 });
  });
});

describe('computeDeductions', () => {
  const list = [
    { id: 'a', name: 'Social Security', kind: 'percent', value: 3.5, cap: null },
    { id: 'b', name: 'Uniform', kind: 'fixed', value: 100, cap: null },
  ];

  test('percent is off gross, fixed is flat, total rounds to cents', () => {
    const { lines, total } = computeDeductions(1000, list);
    expect(lines[0].amount).toBeCloseTo(35);   // 3.5% of 1000
    expect(lines[1].amount).toBeCloseTo(100);
    expect(total).toBeCloseTo(135);
  });

  test('a percent cap limits the amount', () => {
    const capped = [{ id: 'c', name: 'SS capped', kind: 'percent', value: 3.5, cap: 20 }];
    // 3.5% of 1000 = 35, capped to 20.
    expect(computeDeductions(1000, capped).total).toBeCloseTo(20);
    // 3.5% of 400 = 14, under the cap → uncapped.
    expect(computeDeductions(400, capped).total).toBeCloseTo(14);
  });

  test('empty list → zero, no lines', () => {
    expect(computeDeductions(1000, [])).toEqual({ lines: [], total: 0 });
    expect(computeDeductions(1000, null)).toEqual({ lines: [], total: 0 });
  });

  test('cents rounding is per-line then summed (no drift)', () => {
    const odd = [{ id: 'x', name: 'Tax', kind: 'percent', value: 7.65, cap: null }];
    // 7.65% of 333.33 = 25.4997... → 25.50
    expect(computeDeductions(333.33, odd).lines[0].amount).toBeCloseTo(25.5, 2);
  });
});

describe('payStubTotals', () => {
  test('net = gross − deductions + reimbursements', () => {
    const list = [
      { id: 'a', name: 'Social Security', kind: 'percent', value: 3.5, cap: null },
      { id: 'b', name: 'Housing Fund', kind: 'percent', value: 1.5, cap: null },
    ];
    // gross 2000, deductions 5% = 100, reimbursements 250 → net 2150.
    const r = payStubTotals(2000, 250, list);
    expect(r.gross_wages).toBeCloseTo(2000);
    expect(r.deductions_total).toBeCloseTo(100);
    expect(r.reimbursement_total).toBeCloseTo(250);
    expect(r.net_pay).toBeCloseTo(2150);
    expect(r.deductions).toHaveLength(2);
  });

  test('no deductions → net is just gross + reimbursements (gross-only stub preserved)', () => {
    const r = payStubTotals(1500, 0, []);
    expect(r.deductions).toEqual([]);
    expect(r.deductions_total).toBe(0);
    expect(r.net_pay).toBeCloseTo(1500);
  });

  test('deductions summing past gross are capped at gross — net never goes negative', () => {
    const list = [
      { id: 'a', name: 'Tax', kind: 'percent', value: 60, cap: null },      // 60% of 2000 = 1200
      { id: 'b', name: 'Garnishment', kind: 'fixed', value: 1500, cap: null }, // + 1500 = 2700 > gross
    ];
    const r = payStubTotals(2000, 0, list);
    expect(r.deductions_total).toBe(2000);                 // capped at gross, not 2700
    expect(r.net_pay).toBe(0);                             // never negative
    const linesSum = Math.round(r.deductions.reduce((a, l) => a + l.amount, 0) * 100) / 100;
    expect(linesSum).toBe(2000);                           // itemized lines still foot to the capped total
    expect(r.deductions.every(l => l.amount >= 0)).toBe(true);
  });

  test('reimbursements are still paid on top of a fully-consumed gross', () => {
    const list = [{ id: 'a', name: 'Tax', kind: 'percent', value: 100, cap: null }];
    const r = payStubTotals(1000, 150, list); // 100% deducted, $150 reimbursement added back
    expect(r.net_pay).toBe(150);
  });

  test('company ++ per-worker deductions stack', () => {
    const company = parseCompanyDeductions(JSON.stringify({ items: [
      { id: 'a', name: 'Social Security', kind: 'percent', value: 3.5 },
    ] }));
    const worker = normalizeWorkerDeductions([{ id: 9, name: 'Loan', kind: 'fixed', value: 200, active: true }]);
    const r = payStubTotals(1000, 0, company.concat(worker));
    // 35 (SS) + 200 (loan) = 235 → net 765.
    expect(r.deductions_total).toBeCloseTo(235);
    expect(r.net_pay).toBeCloseTo(765);
    expect(r.deductions.map(d => d.name)).toEqual(['Social Security', 'Loan']);
  });
});
