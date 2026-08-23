/**
 * setStockAbsolute — the cycle-count reconciliation primitive. A physical count is
 * authoritative, so completion SETS on-hand to the counted value (and returns the real
 * delta for the ledger), rather than adding a delta computed against the count-creation
 * snapshot — which double-counted any issue/receipt that landed while the count was open.
 */

jest.mock('../db', () => ({ query: jest.fn() }));

const inventory = require('../routes/inventory');
const { setStockAbsolute } = inventory;

// A mock TX client: first query is the FOR UPDATE current-qty read, second is the SET.
function mockClient(currentQty) {
  const calls = [];
  return {
    calls,
    query: jest.fn((sql, params) => {
      calls.push({ sql, params });
      if (/FOR UPDATE/.test(sql)) {
        return Promise.resolve(currentQty == null ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ quantity: currentQty }] });
      }
      return Promise.resolve({ rowCount: 1, rows: [] });
    }),
  };
}

describe('setStockAbsolute', () => {
  test('SETS on-hand to the counted value and returns the applied delta', async () => {
    const c = mockClient(80); // stock drifted to 80 while the count was open
    const applied = await setStockAbsolute(c, 'co-1', 42, 7, 80, null); // counted 80
    expect(applied).toBe(0); // already 80 — the old snapshot-delta path would have driven it to 60
    // The write is an absolute SET, never an additive quantity + delta.
    const setCall = c.calls.find(k => /INSERT INTO inventory_stock/.test(k.sql));
    expect(setCall.sql).toMatch(/DO UPDATE SET quantity = EXCLUDED\.quantity/);
    expect(setCall.sql).not.toMatch(/quantity \+ EXCLUDED/);
    expect(setCall.params).toEqual(['co-1', 42, 7, null, 80]); // target quantity, not a delta
  });

  test('returns counted − current when they differ (real shrinkage)', async () => {
    const c = mockClient(100);
    const applied = await setStockAbsolute(c, 'co-1', 42, 7, 90, 3); // counted 90 vs current 100
    expect(applied).toBe(-10);
    const setCall = c.calls.find(k => /INSERT INTO inventory_stock/.test(k.sql));
    expect(setCall.params[4]).toBe(90); // sets to 90, not 100 + (−10)
  });

  test('no existing stock row → current treated as 0, delta = target', async () => {
    const c = mockClient(null);
    const applied = await setStockAbsolute(c, 'co-1', 42, 7, 25, null);
    expect(applied).toBe(25);
  });

  test('locks the row (FOR UPDATE) before writing', async () => {
    const c = mockClient(5);
    await setStockAbsolute(c, 'co-1', 42, 7, 5, null);
    expect(/FOR UPDATE/.test(c.calls[0].sql)).toBe(true); // read+lock is first
  });
});
