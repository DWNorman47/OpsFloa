/**
 * Offline-replay idempotency for the remaining service-worker-queued create routes
 * (migration 0205): safety talks, equipment (item / hours / checkout / maintenance), RFIs,
 * sub reports, inspections + inspection templates. A replay carrying an Idempotency-Key that
 * already produced a row returns that row with 200 and never INSERTs again; a first request
 * stores the key; a lost ON CONFLICT race returns the winner; no key → unchanged behavior.
 */

let mockUser;
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../push', () => ({ sendPushToAllWorkers: jest.fn() }));
jest.mock('../storage', () => ({ checkStorageLimit: jest.fn(), incrementStorage: jest.fn(), decrementStorage: jest.fn() }));
jest.mock('../r2', () => ({
  uploadBase64: jest.fn(), getPresignedUploadUrl: jest.fn(), deleteByUrl: jest.fn(), getObjectMetadataByUrl: jest.fn(),
  safeKeyFromPublicUrl: jest.requireActual('../r2').safeKeyFromPublicUrl,
  keyBelongsTo: jest.requireActual('../r2').keyBelongsTo,
}));
jest.mock('../utils/projectCost', () => ({ projectFrozen: jest.fn(async () => false) }));
jest.mock('../middleware/commercialAccess', () => ({ requireCommercialAccess: (_req, _res, next) => next() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const { sendPushToAllWorkers } = require('../push');

const KEY = '3f1c2b9a-8d7e-4f60-a1b2-c3d4e5f60718';

function makeApp(path, router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: () => {} }; next(); });
  app.use(path, router);
  return app;
}

let client;
beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockReset();
  mockUser = { id: 1, company_id: 'co-1', full_name: 'Admin Amy', role: 'admin' };
  client = { query: jest.fn(async (...a) => pool.query(...a)), release: jest.fn() };
  pool.connect.mockResolvedValue(client);
});

// Build a pool.query implementation: dedup lookups on `table` hit `existingId` (or, for the race
// case, miss first then hit), INSERTs return `insertRows`, anything else → `fallback(sql)`.
function mockDb({ table, existingId = null, raceWinnerId = null, insertRows = [{ id: 500 }], fallback = () => ({ rowCount: 1, rows: [{ id: 500 }] }) }) {
  let lookups = 0;
  const lookupRe = new RegExp(`SELECT id FROM ${table} WHERE company_id = \\$1 AND client_request_id = \\$2`);
  const insertRe = new RegExp(`INSERT INTO ${table}\\b`);
  pool.query.mockImplementation(async (sql) => {
    if (lookupRe.test(sql)) {
      lookups++;
      const id = existingId ?? (raceWinnerId && lookups > 1 ? raceWinnerId : null);
      return id ? { rowCount: 1, rows: [{ id }] } : { rowCount: 0, rows: [] };
    }
    if (insertRe.test(sql)) {
      if (existingId) throw new Error('must not INSERT on a replay');
      return raceWinnerId ? { rowCount: 0, rows: [] } : { rowCount: insertRows.length, rows: insertRows };
    }
    return fallback(sql);
  });
}
const insertCall = (table) => pool.query.mock.calls.find(c => new RegExp(`INSERT INTO ${table}\\b`).test(c[0]));

const CASES = [
  {
    name: 'POST /safety-talks',
    table: 'safety_talks',
    mount: '/api/safety-talks', path: '/api/safety-talks', router: () => require('../routes/safetyTalks'),
    body: { title: 'Ladders', talk_date: '2026-09-20' },
  },
  {
    name: 'POST /equipment',
    table: 'equipment_items',
    mount: '/api/equipment', path: '/api/equipment', router: () => require('../routes/equipment'),
    body: { name: 'Skid steer', type: 'Loader' },
  },
  {
    name: 'POST /equipment/:id/hours (worker)',
    table: 'equipment_hours', worker: true,
    mount: '/api/equipment', path: '/api/equipment/4/hours', router: () => require('../routes/equipment'),
    body: { log_date: '2026-09-20', hours: 3 },
  },
  {
    name: 'POST /equipment/:id/checkout (worker)',
    table: 'equipment_checkouts', worker: true,
    mount: '/api/equipment', path: '/api/equipment/4/checkout', router: () => require('../routes/equipment'),
    body: {},
    fallback: (sql) => (/SELECT status FROM equipment_items/.test(sql) ? { rowCount: 1, rows: [{ status: 'available' }] } : { rowCount: 1, rows: [{ id: 500 }] }),
  },
  {
    name: 'POST /equipment/:id/maintenance',
    table: 'equipment_maintenance_logs',
    mount: '/api/equipment', path: '/api/equipment/4/maintenance', router: () => require('../routes/equipment'),
    body: { log_date: '2026-09-20' },
  },
  {
    name: 'POST /rfis',
    table: 'rfis',
    mount: '/api/rfis', path: '/api/rfis', router: () => require('../routes/rfis'),
    body: { subject: 'Footing depth', date_submitted: '2026-09-20' },
  },
  {
    name: 'POST /sub-reports',
    table: 'sub_reports',
    mount: '/api/sub-reports', path: '/api/sub-reports', router: () => require('../routes/subReports'),
    body: { report_date: '2026-09-20', sub_company: 'Acme' },
  },
  {
    name: 'POST /inspections',
    table: 'inspections',
    mount: '/api/inspections', path: '/api/inspections', router: () => require('../routes/inspections'),
    body: { name: 'Rebar', inspected_at: '2026-09-20' },
  },
  {
    name: 'POST /inspections/templates',
    table: 'inspection_templates',
    mount: '/api/inspections', path: '/api/inspections/templates', router: () => require('../routes/inspections'),
    body: { name: 'Pre-pour' },
  },
];

describe.each(CASES)('$name', (c) => {
  const app = () => makeApp(c.mount, c.router());
  beforeEach(() => { if (c.worker) mockUser = { id: 7, company_id: 'co-1', full_name: 'Worker Seven', role: 'worker' }; });

  test('replay of a saved request returns the existing row (200), no INSERT', async () => {
    mockDb({ table: c.table, existingId: 77, fallback: () => ({ rowCount: 1, rows: [{ id: 77 }] }) });
    const res = await request(app()).post(c.path).set('Idempotency-Key', KEY).send(c.body);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(77);
    expect(insertCall(c.table)).toBeUndefined();
  });

  test('first request stores the key with an ON CONFLICT guard', async () => {
    mockDb({ table: c.table, fallback: c.fallback });
    const res = await request(app()).post(c.path).set('Idempotency-Key', KEY).send(c.body);
    expect(res.status).toBe(201);
    const [sql, params] = insertCall(c.table);
    expect(sql).toMatch(/client_request_id/);
    expect(params).toContain(KEY);
    if (c.table !== 'equipment_checkouts') expect(sql).toMatch(/ON CONFLICT \(company_id, client_request_id\)/);
  });

  test('no key → no dedup lookup, key stored as NULL', async () => {
    mockDb({ table: c.table, fallback: c.fallback });
    const res = await request(app()).post(c.path).send(c.body);
    expect(res.status).toBe(201);
    expect(pool.query.mock.calls.some(q => /client_request_id = \$2/.test(q[0]))).toBe(false);
    const params = insertCall(c.table)[1];
    expect(params[params.length - 1]).toBeNull();
  });

  if (c.table !== 'equipment_checkouts') {
    test('lost ON CONFLICT race returns the winning row with 200', async () => {
      mockDb({ table: c.table, raceWinnerId: 88, fallback: () => ({ rowCount: 1, rows: [{ id: 88 }] }) });
      const res = await request(app()).post(c.path).set('Idempotency-Key', KEY).send(c.body);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(88);
    });
  }
});

test('safety-talk replay does not re-send the push blast to every worker', async () => {
  mockDb({ table: 'safety_talks', existingId: 77, fallback: () => ({ rowCount: 1, rows: [{ id: 77 }] }) });
  await request(makeApp('/api/safety-talks', require('../routes/safetyTalks')))
    .post('/api/safety-talks').set('Idempotency-Key', KEY).send({ title: 'Ladders', talk_date: '2026-09-20' });
  expect(sendPushToAllWorkers).not.toHaveBeenCalled();
});

test('equipment checkout: a unique violation on replay resolves to the existing checkout', async () => {
  let lookups = 0;
  pool.query.mockImplementation(async (sql) => {
    if (/SELECT id FROM equipment_checkouts WHERE company_id/.test(sql)) {
      lookups++;
      return lookups > 1 ? { rowCount: 1, rows: [{ id: 91 }] } : { rowCount: 0, rows: [] };
    }
    if (/SELECT status FROM equipment_items/.test(sql)) return { rowCount: 1, rows: [{ status: 'available' }] };
    if (/INSERT INTO equipment_checkouts/.test(sql)) { const e = new Error('dup'); e.code = '23505'; throw e; }
    if (/SELECT \* FROM equipment_checkouts WHERE id/.test(sql)) return { rowCount: 1, rows: [{ id: 91 }] };
    return { rowCount: 0, rows: [] };
  });
  const res = await request(makeApp('/api/equipment', require('../routes/equipment')))
    .post('/api/equipment/4/checkout').set('Idempotency-Key', KEY).send({});
  expect(res.status).toBe(200);
  expect(res.body.id).toBe(91);
});

test('findIdByRequestKey refuses a non-identifier table name', async () => {
  const { findIdByRequestKey } = require('../utils/idempotencyKey');
  await expect(findIdByRequestKey(pool, 'rfis; DROP TABLE x', 'co-1', KEY)).rejects.toThrow(/bad table/);
  expect(await findIdByRequestKey(pool, 'rfis', 'co-1', null)).toBeNull();
});
