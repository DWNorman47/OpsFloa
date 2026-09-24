// RFI numbering serialized per company (advisory xact lock, like invoices) and RFI/punchlist
// PATCH optimistic-concurrency checks done atomically in the UPDATE WHERE.
let mockUser;
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockUser; next(); },
}));
jest.mock('../permissions', () => ({ requirePerm: () => (_req, _res, next) => next(), hasPerm: jest.fn(async () => true) }));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToCompanyAdmins: jest.fn(), sendPushToAllWorkers: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/tenantRefs', () => ({
  projectBelongsToCompany: jest.fn(async () => true),
  userBelongsToCompany: jest.fn(async () => true),
}));

const express = require('express');
const request = require('supertest');
const pool = require('../db');

function makeApp(path, router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: () => {} }; next(); });
  app.use(path, router);
  return app;
}
const TS = '2026-09-20T15:00:00.000Z';
let client;
beforeEach(() => {
  pool.query.mockReset(); pool.connect.mockReset();
  mockUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'A' };
  client = { query: jest.fn(async (...a) => pool.query(...a)), release: jest.fn() };
  pool.connect.mockResolvedValue(client);
});

describe('POST /rfis numbering', () => {
  test('takes a per-company advisory lock before the MAX+1 insert, in one transaction', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/INSERT INTO rfis/.test(sql)) return { rowCount: 1, rows: [{ id: 5 }] };
      return { rowCount: 1, rows: [{ id: 5 }] };
    });
    const res = await request(makeApp('/api/rfis', require('../routes/rfis')))
      .post('/api/rfis').send({ subject: 'Footing', date_submitted: '2026-09-20' });
    expect(res.status).toBe(201);
    const sqls = pool.query.mock.calls.map(c => c[0]);
    const lock = sqls.findIndex(s => /pg_advisory_xact_lock/.test(s));
    const ins = sqls.findIndex(s => /INSERT INTO rfis/.test(s));
    expect(sqls).toContain('BEGIN');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(ins);
    expect(pool.query.mock.calls[lock][1]).toEqual(['rfi_number:co-1']);
    expect(sqls).toContain('COMMIT');
  });
});

describe('PATCH /rfis/:id', () => {
  test('updated_at check is in the UPDATE WHERE → 409 when 0 rows', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, status: 'open', updated_at: new Date(TS) }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp('/api/rfis', require('../routes/rfis')))
      .patch('/api/rfis/5').send({ subject: 'x', updated_at: TS });
    expect(res.status).toBe(409);
    expect(pool.query.mock.calls[1][0]).toMatch(/UPDATE rfis/);
    expect(pool.query.mock.calls[1][0]).toMatch(/date_trunc\('milliseconds', updated_at\)/);
  });
});

describe('PATCH /punchlist/:id', () => {
  test('updated_at check is in the UPDATE WHERE → 409 when 0 rows', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 12, status: 'open', updated_at: new Date(TS) }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp('/api/punchlist', require('../routes/punchlist')))
      .patch('/api/punchlist/12').send({ status: 'in_progress', updated_at: TS });
    expect(res.status).toBe(409);
    expect(pool.query.mock.calls[1][0]).toMatch(/UPDATE punchlist_items/);
    expect(pool.query.mock.calls[1][0]).toMatch(/date_trunc\('milliseconds', updated_at\)/);
  });
});
