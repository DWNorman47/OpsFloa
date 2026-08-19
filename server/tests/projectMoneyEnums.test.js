const {
  ESTIMATE_STATUSES,
  ESTIMATE_FROZEN_STATUSES,
  MONEY_CATEGORIES,
  ESTIMATE_AUDIT_ACTIONS,
  ESTIMATE_AUDIT_ACTOR_KINDS,
  computeEstimateTotals,
  computeLineTotal,
} = require('../constants/projectMoneyEnums');

describe('ESTIMATE_STATUSES', () => {
  test('matches the migration 0104 CHECK constraint', () => {
    expect([...ESTIMATE_STATUSES].sort()).toEqual(
      ['accepted', 'declined', 'draft', 'expired', 'sent', 'withdrawn']
    );
  });

  test('is frozen', () => {
    expect(Object.isFrozen(ESTIMATE_STATUSES)).toBe(true);
  });
});

describe('ESTIMATE_FROZEN_STATUSES', () => {
  test('is a subset of ESTIMATE_STATUSES', () => {
    for (const s of ESTIMATE_FROZEN_STATUSES) {
      expect(ESTIMATE_STATUSES).toContain(s);
    }
  });

  test('does NOT include draft or withdrawn (those remain editable / re-editable)', () => {
    expect(ESTIMATE_FROZEN_STATUSES).not.toContain('draft');
    expect(ESTIMATE_FROZEN_STATUSES).not.toContain('withdrawn');
  });
});

describe('MONEY_CATEGORIES', () => {
  test('matches the migration 0104 CHECK constraint and the planned reuse on budget/CO/expense categories', () => {
    // Order matters — it's the reading order on the PDF and the budget
    // bar. Keeping the assertion order-sensitive flags accidental reorders.
    expect([...MONEY_CATEGORIES]).toEqual(
      ['labor', 'materials', 'equipment', 'subs', 'overhead', 'contingency', 'other']
    );
  });

  test('is frozen', () => {
    expect(Object.isFrozen(MONEY_CATEGORIES)).toBe(true);
  });
});

describe('ESTIMATE_AUDIT_ACTIONS', () => {
  test('matches the migration 0104 CHECK constraint', () => {
    expect([...ESTIMATE_AUDIT_ACTIONS].sort()).toEqual(
      ['accepted', 'converted', 'created', 'declined', 'expired', 'sent', 'withdrawn']
    );
  });
});

describe('ESTIMATE_AUDIT_ACTOR_KINDS', () => {
  test('matches the migration 0104 CHECK constraint', () => {
    expect([...ESTIMATE_AUDIT_ACTOR_KINDS].sort()).toEqual(['admin', 'client', 'system']);
  });
});

// ── Money math ───────────────────────────────────────────────────────────────

describe('computeLineTotal', () => {
  test('rounds qty × unit_cost to whole cents', () => {
    expect(computeLineTotal({ qty: 3, unit_cost_cents: 1500 })).toBe(4500);
  });

  test('rounds at the line (not floored)', () => {
    expect(computeLineTotal({ qty: 3, unit_cost_cents: 1633 })).toBe(4899);    // 3 × 16.33 = 48.99
    expect(computeLineTotal({ qty: 2.5, unit_cost_cents: 1000 })).toBe(2500);  // 2.5 × 10.00 = 25.00
    expect(computeLineTotal({ qty: 1, unit_cost_cents: 1233 })).toBe(1233);    // unchanged
  });

  test('returns 0 for negative qty or unit_cost (defensive)', () => {
    expect(computeLineTotal({ qty: -1, unit_cost_cents: 1000 })).toBe(0);
    expect(computeLineTotal({ qty: 1, unit_cost_cents: -1000 })).toBe(0);
  });

  test('returns 0 for non-finite inputs (a malformed POST cannot poison the line)', () => {
    expect(computeLineTotal({ qty: NaN, unit_cost_cents: 1000 })).toBe(0);
    expect(computeLineTotal({ qty: 1, unit_cost_cents: Infinity })).toBe(0);
  });
});

describe('computeEstimateTotals', () => {
  test('layered math: subtotal → +overhead → +margin → +contingency → +tax', () => {
    // subtotal = 100000  (one $1000 line)
    // overhead = 10% → 10000
    // margin_base = 110000; margin = 20% → 22000
    // pre_contingency = 132000; contingency = 5% → 6600
    // pre_tax = 138600; tax = 8% → 11088
    // total = 149688
    const t = computeEstimateTotals({
      lines: [{ total_cents: 100000 }],
      overhead_pct: 10,
      margin_pct: 20,
      contingency_pct: 5,
      tax_pct: 8,
    });
    expect(t).toEqual({
      subtotal: 100000,
      overhead: 10000,
      margin: 22000,
      contingency: 6600,
      tax: 11088,
      total: 149688,
    });
  });

  test('alternate/optional lines are excluded from the subtotal; base+allowance count', () => {
    const t = computeEstimateTotals({
      lines: [
        { total_cents: 100000, line_type: 'base' },
        { total_cents: 20000, line_type: 'allowance' },
        { total_cents: 50000, line_type: 'alternate' },   // excluded
        { total_cents: 30000, line_type: 'optional' },     // excluded
        { total_cents: 5000 },                             // no type → base
      ],
      overhead_pct: 0, margin_pct: 0, contingency_pct: 0, tax_pct: 0,
    });
    expect(t.subtotal).toBe(125000);  // 100000 + 20000 + 5000
    expect(t.total).toBe(125000);
  });

  test('zero percentages collapse cleanly to subtotal', () => {
    const t = computeEstimateTotals({
      lines: [{ total_cents: 5000 }, { total_cents: 3000 }],
      overhead_pct: 0, margin_pct: 0, contingency_pct: 0, tax_pct: 0,
    });
    expect(t.total).toBe(8000);
    expect(t.subtotal).toBe(8000);
  });

  test('rounding is applied at each layer (not at the end)', () => {
    // subtotal=333 ; overhead 1% = round(3.33) = 3 ; margin_base = 336 ;
    // margin 1% = round(3.36) = 3 ; pre_contingency = 339 ;
    // contingency 1% = round(3.39) = 3 ; pre_tax = 342 ;
    // tax 1% = round(3.42) = 3 ; total = 345
    const t = computeEstimateTotals({
      lines: [{ total_cents: 333 }],
      overhead_pct: 1, margin_pct: 1, contingency_pct: 1, tax_pct: 1,
    });
    expect(t).toEqual({
      subtotal: 333, overhead: 3, margin: 3, contingency: 3, tax: 3, total: 345,
    });
  });

  test('ignores negative line totals (a corrupted line cannot reduce subtotal)', () => {
    const t = computeEstimateTotals({
      lines: [{ total_cents: 5000 }, { total_cents: -2000 }],
      overhead_pct: 0, margin_pct: 0, contingency_pct: 0, tax_pct: 0,
    });
    expect(t.subtotal).toBe(5000);
  });

  test('empty lines → all zeros', () => {
    const t = computeEstimateTotals({
      lines: [],
      overhead_pct: 50, margin_pct: 50, contingency_pct: 50, tax_pct: 50,
    });
    expect(t).toEqual({ subtotal: 0, overhead: 0, margin: 0, contingency: 0, tax: 0, total: 0 });
  });
});
