/**
 * Inventory quantity / money guards:
 *  - worker cycle-count submit without counted_uom_id counts in the line's STOCK UOM
 *  - issue/transfer auto-convert handles the unitless (null UOM) base row both ways
 *  - low-stock / valuation sum stock in BASE units (quantity × UOM factor)
 *  - same-location bin moves are rejected (bin is not part of the stock key)
 *  - PO status transitions are enforced; received POs can't be reopened/deleted
 *  - archive guards use EXISTS(quantity <> 0), not SUM(quantity) > 0
 *  - PO email footer escapes the company name
 */

let mockCurrentUser;
let mockPermissions;

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  hasPerm: jest.fn(async (_req, key) => mockPermissions.has(key)),
  requirePerm: key => async (req, res, next) => {
    req.user = mockCurrentUser;
    if (!mockPermissions.has(key)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  },
}));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../r2', () => ({ uploadBase64: jest.fn() }));
jest.mock('../storage', () => ({ checkStorageLimit: jest.fn(), incrementStorage: jest.fn() }));
jest.mock('../push', () => ({ sendPushToCompanyAdmins: jest.fn() }));
jest.mock('../routes/inbox', () => ({ createInboxItemBatch: jest.fn() }));
jest.mock('../routes/admin', () => ({
  getAdvancedSettings: jest.fn(async () => ({ item_units: { defaults: ['each'], custom: [], suppressed: [] } })),
  ADVANCED_DEFAULTS: {},
}));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn(async () => {}) }));
jest.mock('../currency', () => ({
  formatCurrency: jest.fn(n => `$${Number(n).toFixed(2)}`),
  companyCurrency: jest.fn(async () => 'USD'),
}));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const inventory = require('../routes/inventory');
const { autoConvertIssueUom } = inventory;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: jest.fn() }; next(); });
  app.use('/api/inventory', inventory);
  return app;
}

// A tx client whose query() dispatches on SQL via [regex, result] pairs (first match wins).
function dispatchClient(routes) {
  const client = {
    query: jest.fn(async (sql) => {
      for (const [re, result] of routes) {
        if (re.test(sql)) return typeof result === 'function' ? result(sql) : result;
      }
      return { rowCount: 0, rows: [] };
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
  return client;
}

const ADMIN = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Ada' };
const WORKER = { id: 7, company_id: 'co-1', role: 'worker', full_name: 'Wes' };

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rowCount: 0, rows: [{ count: '1' }] });
  pool.connect.mockReset();
  mockCurrentUser = ADMIN;
  mockPermissions = new Set(['manage_inventory']);
});

// ── 1. Worker cycle-count submit UOM ──────────────────────────────────────────
describe('POST /cycle-counts/:id/submit — missing counted_uom_id', () => {
  function submitClient() {
    return dispatchClient([
      [/FROM inventory_cycle_counts WHERE id=\$1 AND company_id=\$2 FOR UPDATE/, { rowCount: 1, rows: [{ id: 3, status: 'in_progress' }] }],
      [/FROM inventory_cycle_count_lines l\s+JOIN inventory_items/, { rowCount: 1, rows: [{ id: 50, item_id: 11, stock_uom_id: 5, expected_qty: '10', line_status: 'pending' }] }],
      // Stock UOM is a box of 30; there is no other UOM on this item in this fixture.
      [/SELECT factor FROM inventory_item_uoms/, { rowCount: 1, rows: [{ factor: '30' }] }],
      [/UPDATE inventory_count_assignments/, { rowCount: 1, rows: [{ id: 99 }] }],
      [/FROM settings/, { rowCount: 0, rows: [] }],
    ]);
  }

  test('counts "10" as 10 of the stock UOM (box), not 10 base units', async () => {
    mockCurrentUser = WORKER;
    mockPermissions = new Set(['view_inventory']);
    const rnd = jest.spyOn(Math, 'random').mockReturnValue(0.999); // no audit sampling
    const client = submitClient();
    const res = await request(makeApp())
      .post('/api/inventory/cycle-counts/3/submit')
      .send({ line_id: 50, role: 'counter', counted_qty: 10 });
    rnd.mockRestore();
    expect(res.status).toBe(200);
    const upd = client.query.mock.calls.find(c => /SET counted_qty=\$1, counted_uom_id=\$2, counted_by=\$3/.test(c[0]));
    expect(upd).toBeTruthy();
    const [qty, uomId, , variance] = upd[1];
    expect(qty).toBe(10);
    expect(uomId).toBe(5);      // recorded in the stock UOM, not null (base)
    expect(variance).toBe(0);   // 10 boxes counted vs 10 boxes expected
  });

  test('an explicit counted_uom_id still converts (30 each → 1 box)', async () => {
    mockCurrentUser = WORKER;
    mockPermissions = new Set(['view_inventory']);
    const rnd = jest.spyOn(Math, 'random').mockReturnValue(0.999);
    const client = dispatchClient([
      [/FROM inventory_cycle_counts WHERE id=\$1 AND company_id=\$2 FOR UPDATE/, { rowCount: 1, rows: [{ id: 3, status: 'in_progress' }] }],
      [/FROM inventory_cycle_count_lines l\s+JOIN inventory_items/, { rowCount: 1, rows: [{ id: 50, item_id: 11, stock_uom_id: 5, expected_qty: '1', line_status: 'pending' }] }],
      [/SELECT factor FROM inventory_item_uoms/, (/* sql */) => ({ rowCount: 1, rows: [{ factor: client.query.mock.calls.filter(c => /SELECT factor FROM inventory_item_uoms/.test(c[0])).length === 1 ? '1' : '30' }] })],
      [/UPDATE inventory_count_assignments/, { rowCount: 1, rows: [{ id: 99 }] }],
    ]);
    const res = await request(makeApp())
      .post('/api/inventory/cycle-counts/3/submit')
      .send({ line_id: 50, role: 'counter', counted_qty: 30, counted_uom_id: 6 });
    rnd.mockRestore();
    expect(res.status).toBe(200);
    const upd = client.query.mock.calls.find(c => /SET counted_qty=\$1, counted_uom_id=\$2, counted_by=\$3/.test(c[0]));
    expect(upd[1][1]).toBe(6);
    expect(upd[1][3]).toBeCloseTo(0);
  });
});

// ── 2. autoConvertIssueUom with the unitless base row ─────────────────────────
describe('autoConvertIssueUom', () => {
  function convClient(otherRow) {
    return {
      query: jest.fn(async (sql) => {
        if (/FROM inventory_stock s/.test(sql)) return otherRow ? { rowCount: 1, rows: [otherRow] } : { rowCount: 0, rows: [] };
        return { rowCount: 0, rows: [] }; // no own row for the requested UOM
      }),
    };
  }

  test('issuing 30 in the default (null) unit converts onto the box row (1 box)', async () => {
    const c = convClient({ uom_id: 5, stock_factor: '30', req_factor: '1' });
    const out = await autoConvertIssueUom(c, 'co-1', 11, 2, null, 30);
    expect(out).toEqual({ uomId: 5, qty: 1 });
  });

  test('the lookup includes unitless stock rows and COALESCEs both factors', async () => {
    const c = convClient({ uom_id: null, stock_factor: '1', req_factor: '30' });
    const out = await autoConvertIssueUom(c, 'co-1', 11, 2, 5, 2); // 2 boxes from a unitless row
    expect(out).toEqual({ uomId: null, qty: 60 });
    const sql = c.query.mock.calls.find(k => /FROM inventory_stock s/.test(k[0]))[0];
    expect(sql).not.toMatch(/s\.uom_id IS NOT NULL/);
  });

  test('own row present → no conversion (null unit included)', async () => {
    const c = { query: jest.fn(async () => ({ rowCount: 1, rows: [{ quantity: '4' }] })) };
    expect(await autoConvertIssueUom(c, 'co-1', 11, 2, null, 3)).toEqual({ uomId: null, qty: 3 });
  });
});

// ── 3. Base-unit sums ─────────────────────────────────────────────────────────
describe('stock sums are in base units', () => {
  test('GET /stock/low multiplies by the UOM factor', async () => {
    pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
    await request(makeApp()).get('/api/inventory/stock/low');
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toMatch(/SUM\(s\.quantity \* COALESCE\(u\.factor, 1\)\)/);
    expect(sql).not.toMatch(/SUM\(s\.quantity\)/);
  });

  test('GET /valuation multiplies by the UOM factor (rows + grand total)', async () => {
    pool.query.mockResolvedValue({ rowCount: 0, rows: [{ grand_total: '0', total_items: '0' }] });
    await request(makeApp()).get('/api/inventory/valuation');
    for (const [sql] of pool.query.mock.calls) {
      expect(sql).toMatch(/s\.quantity \* COALESCE\(u\.factor, 1\)/);
      expect(sql).not.toMatch(/SUM\(s\.quantity\)/);
    }
  });
});

// ── 4. Same-location bin move ─────────────────────────────────────────────────
describe('same-location bin moves', () => {
  function binClient(rowQty) {
    return dispatchClient([
      [/SELECT id, unit_cost FROM inventory_items/, { rowCount: 1, rows: [{ id: 11, unit_cost: '1' }] }],
      [/FROM inventory_locations/, { rowCount: 1, rows: [{ id: 2 }] }],
      [/FROM inventory_bays b/, { rowCount: 1, rows: [{ rack_id: 8, area_id: 9, location_id: 2 }] }],
      [/FROM inventory_racks r/, { rowCount: 1, rows: [{ area_id: 9, location_id: 2 }] }],
      [/FROM inventory_areas WHERE/, { rowCount: 1, rows: [{ location_id: 2 }] }],
      [/SELECT quantity FROM inventory_stock[\s\S]*FOR UPDATE/, { rowCount: 1, rows: [{ quantity: String(rowQty) }] }],
      [/INSERT INTO inventory_transactions/, { rowCount: 1, rows: [{ id: 900 }] }],
    ]);
  }
  const stockWrites = c => c.query.mock.calls.filter(k => /INSERT INTO inventory_stock|UPDATE inventory_stock/.test(k[0]));

  test('moving PART of a row to another bin is rejected and writes nothing', async () => {
    const c = binClient(10);
    const res = await request(makeApp()).post('/api/inventory/transactions')
      .send({ type: 'transfer', item_id: 11, quantity: 3, from_location_id: 2, to_location_id: 2, bay_id: 4 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('partial_bin_move');
    expect(stockWrites(c)).toHaveLength(0);
  });

  test('moving the WHOLE row re-bins it without changing quantity', async () => {
    const c = binClient(10);
    const res = await request(makeApp()).post('/api/inventory/transactions')
      .send({ type: 'transfer', item_id: 11, quantity: 10, from_location_id: 2, to_location_id: 2, bay_id: 4 });
    expect(res.status).toBe(201);
    const w = stockWrites(c);
    expect(w).toHaveLength(1);
    expect(w[0][0]).toMatch(/UPDATE inventory_stock\s+SET area_id=\$5/);
    expect(w[0][0]).not.toMatch(/quantity\s*=/);
  });
});

// ── 5. PO status transitions ──────────────────────────────────────────────────
describe('purchase order lifecycle guards', () => {
  function poQuery(status, hasReceipts) {
    pool.query.mockImplementation(async (sql) => {
      if (/FROM purchase_orders/.test(sql) && /SELECT/.test(sql)) {
        return { rowCount: 1, rows: [{ id: 1, status, has_receipts: hasReceipts }] };
      }
      return { rowCount: 1, rows: [{ id: 1, status }] };
    });
  }
  const statusUpdate = () => pool.query.mock.calls.find(c => /UPDATE purchase_orders SET/.test(c[0]));

  test('received → draft is refused', async () => {
    poQuery('received', true);
    const res = await request(makeApp()).patch('/api/inventory/purchase-orders/1').send({ status: 'draft' });
    expect(res.status).toBe(409);
    expect(statusUpdate()).toBeUndefined();
  });

  test('submitted → draft is refused once anything was received', async () => {
    poQuery('submitted', true);
    const res = await request(makeApp()).patch('/api/inventory/purchase-orders/1').send({ status: 'draft' });
    expect(res.status).toBe(409);
  });

  test('submitted → draft is allowed when nothing was received', async () => {
    poQuery('submitted', false);
    const res = await request(makeApp()).patch('/api/inventory/purchase-orders/1').send({ status: 'draft' });
    expect(res.status).toBe(200);
    expect(statusUpdate()).toBeTruthy();
  });

  test('draft → received (skipping receipt) is refused', async () => {
    poQuery('draft', false);
    const res = await request(makeApp()).patch('/api/inventory/purchase-orders/1').send({ status: 'received' });
    expect(res.status).toBe(409);
  });

  test('partial → received (close short) is allowed', async () => {
    poQuery('partial', true);
    const res = await request(makeApp()).patch('/api/inventory/purchase-orders/1').send({ status: 'received' });
    expect(res.status).toBe(200);
  });

  test('DELETE of a draft that has receipts is refused (no hard delete)', async () => {
    poQuery('draft', true);
    const res = await request(makeApp()).delete('/api/inventory/purchase-orders/1');
    expect(res.status).toBe(409);
    expect(pool.query.mock.calls.find(c => /DELETE FROM purchase_orders/.test(c[0]))).toBeUndefined();
  });

  test('receive with every line skipped leaves the PO status alone', async () => {
    const client = dispatchClient([
      [/FROM purchase_orders WHERE id=\$1 AND company_id=\$2 FOR UPDATE/, { rowCount: 1, rows: [{ id: 1, status: 'submitted' }] }],
      [/FROM inventory_locations/, { rowCount: 1, rows: [{ id: 2 }] }],
      [/FROM purchase_order_lines pol/, { rowCount: 0, rows: [] }],
      [/SUM\(qty_ordered\)/, { rowCount: 1, rows: [{ ordered: '5', received: '0' }] }],
    ]);
    pool.query.mockResolvedValue({ rowCount: 1, rows: [{ id: 1, status: 'submitted' }] });
    const res = await request(makeApp()).post('/api/inventory/purchase-orders/1/receive')
      .send({ location_id: 2, lines: [{ line_id: 999, qty_to_receive: 3 }] });
    expect(res.status).toBe(200);
    expect(client.query.mock.calls.find(c => /UPDATE purchase_orders SET status/.test(c[0]))).toBeUndefined();
  });
});

// ── 6. Archive guards ─────────────────────────────────────────────────────────
describe('archive guards use EXISTS(quantity <> 0)', () => {
  test('item with +10/−10 rows (sum 0) is still blocked', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ has_stock: true }] });
    const res = await request(makeApp()).delete('/api/inventory/items/11');
    expect(res.status).toBe(409);
    expect(pool.query.mock.calls[0][0]).toMatch(/EXISTS/);
    expect(pool.query.mock.calls[0][0]).toMatch(/quantity <> 0/);
  });

  test('location with nonzero rows is blocked', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ has_stock: true }] });
    const res = await request(makeApp()).delete('/api/inventory/locations/2');
    expect(res.status).toBe(409);
    expect(pool.query.mock.calls[0][0]).toMatch(/quantity <> 0/);
  });
});

// ── 7. PO email footer escaping ───────────────────────────────────────────────
test('PO email escapes the company name in the footer', async () => {
  const { sendEmail } = require('../email');
  pool.query
    .mockResolvedValueOnce({ rowCount: 1, rows: [{
      po_number: 'PO-1', company_name: '<img src=x onerror=alert(1)>', supplier_email: 's@x.com',
      supplier_name: 'Sup', order_date: '2026-09-01',
    }] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ item_name: 'Bolt', sku: 'B1', unit: 'ea', qty_ordered: '2', unit_cost: null }] });
  const res = await request(makeApp()).post('/api/inventory/purchase-orders/1/email');
  expect(res.status).toBe(200);
  const html = sendEmail.mock.calls[0][2];
  expect(html).not.toContain('<img src=x');
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
});
