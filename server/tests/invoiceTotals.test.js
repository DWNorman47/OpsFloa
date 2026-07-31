/**
 * Native-invoice header math + enums (migration 0149). An invoice bills line
 * items + tax, with an optional owner-side retainage held back. Simpler than an
 * estimate (no overhead/margin/contingency cascade). Rounded at the line, summed
 * at the header — the values must agree with the PDF and a calculator.
 */

const {
  computeInvoiceTotals, computeLineTotal,
  INVOICE_STATUSES, INVOICE_FROZEN_STATUSES, INVOICE_PAYMENT_METHODS, INVOICE_AUDIT_ACTIONS,
} = require('../constants/projectMoneyEnums');

describe('computeInvoiceTotals', () => {
  test('subtotal = Σ lines, then tax, then retainage held off the total', () => {
    const lines = [
      { total_cents: computeLineTotal({ qty: 120, unit_cost_cents: 6500 }) }, // 780,000
      { total_cents: computeLineTotal({ qty: 1, unit_cost_cents: 420000 }) }, // 420,000
    ];
    const r = computeInvoiceTotals({ lines, tax_pct: 8.25, retainage_pct: 10 });
    expect(r.subtotal).toBe(1200000);
    expect(r.tax).toBe(99000);              // round(1,200,000 × 8.25%)
    expect(r.total).toBe(1299000);          // subtotal + tax
    expect(r.retainage_held).toBe(129900);  // round(1,299,000 × 10%)
  });

  test('no tax / no retainage → total is just the subtotal', () => {
    const r = computeInvoiceTotals({ lines: [{ total_cents: 50000 }] });
    expect(r).toEqual({ subtotal: 50000, tax: 0, total: 50000, retainage_held: 0 });
  });

  test('empty + malformed lines coerce to zero (a bad POST cannot poison the total)', () => {
    expect(computeInvoiceTotals({ lines: [] })).toEqual({ subtotal: 0, tax: 0, total: 0, retainage_held: 0 });
    expect(computeInvoiceTotals({ lines: [{ total_cents: NaN }, { total_cents: -5 }] }).subtotal).toBe(0);
  });
});

describe('invoice enums', () => {
  test('expected values, frozen', () => {
    expect(INVOICE_STATUSES).toEqual(['draft', 'sent', 'partial', 'paid', 'void']);
    expect(INVOICE_FROZEN_STATUSES).toEqual(['sent', 'partial', 'paid', 'void']); // only 'draft' is editable
    expect(INVOICE_PAYMENT_METHODS).toEqual(['check', 'card', 'cash', 'ach', 'other']);
    expect(INVOICE_AUDIT_ACTIONS).toEqual(['created', 'sent', 'payment', 'voided']);
    [INVOICE_STATUSES, INVOICE_PAYMENT_METHODS].forEach(a => expect(Object.isFrozen(a)).toBe(true));
  });
});
