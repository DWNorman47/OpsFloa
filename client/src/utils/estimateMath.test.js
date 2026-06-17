import { describe, test, expect } from 'vitest';
import { computeBreakdown } from './estimateMath';

// These mirror server/constants/projectMoneyEnums.js computeEstimateTotals.
// If the server cascade ever changes, these numbers must change in
// lockstep — the PDF totals are only trustworthy if the two agree.

describe('computeBreakdown', () => {
  test('passes the subtotal straight through with no markup', () => {
    const b = computeBreakdown({ subtotalCents: 100000 });
    expect(b).toEqual({ subtotal: 100000, overhead: 0, margin: 0, contingency: 0, tax: 0, total: 100000 });
  });

  test('applies overhead on the subtotal', () => {
    const b = computeBreakdown({ subtotalCents: 100000, overheadPct: 10 });
    expect(b.overhead).toBe(10000);
    expect(b.total).toBe(110000);
  });

  test('margin compounds on subtotal + overhead', () => {
    const b = computeBreakdown({ subtotalCents: 100000, overheadPct: 10, marginPct: 20 });
    // base for margin = 110000 → margin 22000 → total 132000
    expect(b.margin).toBe(22000);
    expect(b.total).toBe(132000);
  });

  test('contingency compounds on subtotal+overhead+margin', () => {
    const b = computeBreakdown({ subtotalCents: 100000, overheadPct: 10, marginPct: 20, contingencyPct: 5 });
    // preCont = 132000 → contingency 6600 → 138600
    expect(b.contingency).toBe(6600);
    expect(b.total).toBe(138600);
  });

  test('tax compounds last, on the full pre-tax base', () => {
    const b = computeBreakdown({
      subtotalCents: 100000, overheadPct: 10, marginPct: 20, contingencyPct: 5, taxPct: 8,
    });
    // preTax = 138600 → tax round(11088) = 11088 → total 149688
    expect(b.tax).toBe(11088);
    expect(b.total).toBe(149688);
  });

  test('rounds each step to whole cents (matches server Math.round per step)', () => {
    // 33333 * 7.5% = 2499.975 → rounds to 2500
    const b = computeBreakdown({ subtotalCents: 33333, overheadPct: 7.5 });
    expect(b.overhead).toBe(2500);
    expect(b.total).toBe(35833);
  });

  test('coerces string cents and string percentages (PG returns strings)', () => {
    const b = computeBreakdown({ subtotalCents: '100000', overheadPct: '10', taxPct: '5' });
    expect(b.overhead).toBe(10000);
    // preTax = 110000 → tax 5500 → 115500
    expect(b.tax).toBe(5500);
    expect(b.total).toBe(115500);
  });

  test('clamps a negative subtotal to zero', () => {
    const b = computeBreakdown({ subtotalCents: -5000, overheadPct: 10 });
    expect(b.subtotal).toBe(0);
    expect(b.total).toBe(0);
  });

  test('treats missing / NaN inputs as zero', () => {
    const b = computeBreakdown({});
    expect(b.total).toBe(0);
    const b2 = computeBreakdown({ subtotalCents: 100000, overheadPct: 'abc' });
    expect(b2.overhead).toBe(0);
    expect(b2.total).toBe(100000);
  });
});
