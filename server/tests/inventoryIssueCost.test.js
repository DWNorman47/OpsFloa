/**
 * POST /api/inventory/transactions — the unit_cost snapshotted on a transaction feeds job
 * costing. Only an inventory manager may override it; a worker posting an `issue` always gets
 * the catalog cost, whatever the body says.
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

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const inventory = require('../routes/inventory');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: jest.fn() }; next(); });
  app.use('/api/inventory', inventory);
  return app;
}

let client;
beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
  client = {
    query: jest.fn(async (sql) => {
      if (/SELECT id, unit_cost FROM inventory_items/.test(sql)) return { rowCount: 1, rows: [{ id: 11, unit_cost: '4.25' }] };
      if (/FROM inventory_locations/.test(sql)) return { rowCount: 1, rows: [{ id: 2 }] };
      if (/INSERT INTO inventory_transactions/.test(sql)) return { rowCount: 1, rows: [{ id: 900 }] };
      return { rowCount: 0, rows: [] };
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
});

const txnInsert = () => client.query.mock.calls.find(c => /INSERT INTO inventory_transactions/.test(c[0]));
const body = { type: 'issue', item_id: 11, quantity: 2, from_location_id: 2, unit_cost: 0.01 };

test('worker issue ignores the body unit_cost and snapshots the catalog cost', async () => {
  mockCurrentUser = { id: 7, company_id: 'co-1', role: 'worker' };
  mockPermissions = new Set(['view_inventory']);
  await request(makeApp()).post('/api/inventory/transactions').send(body);
  expect(txnInsert()).toBeTruthy();
  expect(txnInsert()[1][10]).toBe('4.25');
});

test('inventory manager may override the snapshot cost', async () => {
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin' };
  mockPermissions = new Set(['manage_inventory']);
  await request(makeApp()).post('/api/inventory/transactions').send({ ...body, unit_cost: 3.5 });
  expect(txnInsert()[1][10]).toBe(3.5);
});

test('a manager sending junk / negative unit_cost falls back to the catalog cost', async () => {
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin' };
  mockPermissions = new Set(['manage_inventory']);
  await request(makeApp()).post('/api/inventory/transactions').send({ ...body, unit_cost: -5 });
  expect(txnInsert()[1][10]).toBe('4.25');
});
