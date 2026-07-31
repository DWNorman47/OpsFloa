let mockCurrentUser;
let mockPermissions;

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => {
    req.user = mockCurrentUser;
    next();
  },
  hasPerm: jest.fn(async (_req, key) => mockPermissions.has(key)),
  requirePerm: key => async (req, res, next) => {
    req.user = mockCurrentUser;
    if (!mockPermissions.has(key)) {
      return res.status(403).json({ error: 'Insufficient permissions', required: key });
    }
    next();
  },
}));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../r2', () => ({ uploadBase64: jest.fn() }));
jest.mock('../storage', () => ({
  checkStorageLimit: jest.fn(),
  incrementStorage: jest.fn(),
}));
jest.mock('../push', () => ({ sendPushToCompanyAdmins: jest.fn() }));
jest.mock('../routes/inbox', () => ({ createInboxItemBatch: jest.fn() }));
jest.mock('../routes/admin', () => ({
  getAdvancedSettings: jest.fn(async () => ({
    item_units: { defaults: ['each'], custom: [], suppressed: [] },
  })),
  ADVANCED_DEFAULTS: {},
}));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const inventory = require('../routes/inventory');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = { error: jest.fn() };
    next();
  });
  app.use('/api/inventory', inventory);
  return app;
}

function mockClient(results) {
  const query = jest.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  const client = { query, release: jest.fn() };
  pool.connect.mockResolvedValue(client);
  return client;
}

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockReset();
  pool.connect.mockReset();
  mockCurrentUser = {
    id: 7,
    company_id: 'co-1',
    full_name: 'Worker Seven',
    role: 'worker',
  };
  mockPermissions = new Set();
});

test('inventory reads require view_inventory or manage_inventory', async () => {
  const denied = await request(makeApp()).get('/api/inventory/items');
  expect(denied.status).toBe(403);
  expect(denied.body.code).toBe('missing_permission');
  expect(pool.query).not.toHaveBeenCalled();

  mockPermissions.add('view_inventory');
  pool.query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ count: '0' }] });
  const allowed = await request(makeApp()).get('/api/inventory/items');
  expect(allowed.status).toBe(200);
});

test('cycle-count validation occurs before an assignment is claimed', async () => {
  mockPermissions.add('view_inventory');
  const client = mockClient([
    undefined,
    { rowCount: 1, rows: [{ id: 5, status: 'in_progress' }] },
    {
      rowCount: 1,
      rows: [{
        id: 20,
        item_id: 30,
        expected_qty: '4',
        stock_uom_id: null,
        line_status: 'accepted',
      }],
    },
    undefined,
  ]);

  const res = await request(makeApp())
    .post('/api/inventory/cycle-counts/5/submit')
    .send({ line_id: 20, role: 'counter', counted_qty: 4 });

  expect(res.status).toBe(409);
  const sql = client.query.mock.calls.map(call => String(call[0])).join('\n');
  expect(sql).toContain('FOR UPDATE OF l');
  expect(sql).not.toContain("SET status='submitted'");
  expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
  expect(client.release).toHaveBeenCalled();
});

test('cycle-count submission rejects a UOM from another item before claiming', async () => {
  mockPermissions.add('view_inventory');
  const client = mockClient([
    undefined,
    { rowCount: 1, rows: [{ id: 5, status: 'in_progress' }] },
    {
      rowCount: 1,
      rows: [{
        id: 20,
        item_id: 30,
        expected_qty: '4',
        stock_uom_id: null,
        line_status: 'pending',
      }],
    },
    { rowCount: 0, rows: [] },
    undefined,
  ]);

  const res = await request(makeApp())
    .post('/api/inventory/cycle-counts/5/submit')
    .send({ line_id: 20, role: 'counter', counted_qty: 4, counted_uom_id: 99 });

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/does not belong/);
  expect(client.query.mock.calls[3][1]).toEqual([99, 30, 'co-1']);
  expect(client.query.mock.calls.map(call => String(call[0])).join('\n')).not.toContain("SET status='submitted'");
});

test('purchase-order creation rejects a supplier outside the company before numbering', async () => {
  mockPermissions.add('manage_inventory');
  const client = mockClient([
    undefined,
    { rowCount: 0, rows: [] },
    undefined,
  ]);

  const res = await request(makeApp())
    .post('/api/inventory/purchase-orders')
    .send({ supplier_id: 88 });

  expect(res.status).toBe(400);
  expect(res.body.error).toBe('Supplier not found');
  const sql = client.query.mock.calls.map(call => String(call[0])).join('\n');
  expect(sql).not.toContain('pg_advisory_xact_lock');
  expect(sql).not.toContain('INSERT INTO purchase_orders');
});

test('issue transactions validate and decrement the selected source bin', async () => {
  mockPermissions.add('view_inventory');
  const client = mockClient([
    undefined,
    { rowCount: 1, rows: [{ id: 30, unit_cost: '2.00' }] },
    { rowCount: 1, rows: [{ id: 10 }] },
    { rowCount: 1, rows: [{ location_id: 10 }] },
    { rowCount: 1, rows: [{ id: 77 }] },
    undefined,
    undefined,
  ]);
  pool.query.mockResolvedValue({ rowCount: 1, rows: [{ quantity: '8' }] });

  const res = await request(makeApp())
    .post('/api/inventory/transactions')
    .send({
      type: 'issue',
      item_id: 30,
      quantity: 2,
      from_location_id: 10,
      area_id: 41,
    });

  expect(res.status).toBe(201);
  const stockWrite = client.query.mock.calls.find(call => String(call[0]).includes('INSERT INTO inventory_stock'));
  expect(stockWrite[1]).toEqual(['co-1', 30, 10, null, -2, 41, null, null, null]);
});

test('item UOM deletion is scoped to the item in the URL', async () => {
  mockPermissions.add('manage_inventory');
  pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

  const res = await request(makeApp())
    .delete('/api/inventory/items/30/uoms/99');

  expect(res.status).toBe(404);
  expect(pool.query.mock.calls[0][0]).toContain('u.item_id=$3');
  expect(pool.query.mock.calls[0][1]).toEqual(['99', 'co-1', '30']);
});
