// POST /admin/projects/:id/rfis numbers RFIs under the same per-company advisory
// transaction lock as POST /rfis (routes/rfis.js) — a bare MAX()+1 races.
let mockCurrentUser;
jest.mock('../middleware/auth', () => ({
  requireAuth:      (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin:     (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePermission: () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePerm:      () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePlan:      () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireProAddon:  (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireCertifiedPayrollAddon: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  hasAdminPermission: () => true,
  requireSuperAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToAllWorkers: jest.fn(), sendPushToCompanyAdmins: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../services/qbo', () => ({}));
jest.mock('../routes/inbox', () => ({ createInboxItem: jest.fn(), createInboxItemBatch: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const adminRoute = require('../routes/admin');

test('advisory xact lock rfi_number:<company> taken before the MAX+1 insert, in one transaction', async () => {
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'A' };
  const calls = [];
  const client = {
    query: jest.fn(async (sql, params) => {
      calls.push({ sql, params });
      if (/INSERT INTO rfis/.test(sql)) return { rowCount: 1, rows: [{ id: 5, rfi_number: 3 }] };
      return { rowCount: 0, rows: [] };
    }),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
  pool.query.mockImplementation(async (sql) => (/FROM projects/.test(sql) ? { rowCount: 1, rows: [{ id: 7 }] } : { rowCount: 0, rows: [] }));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: () => {} }; next(); });
  app.use('/api/admin', adminRoute);
  const res = await request(app).post('/api/admin/projects/7/rfis').send({ subject: 'Footing' });

  expect(res.status).toBe(201);
  const sqls = calls.map(c => c.sql);
  const lock = sqls.findIndex(s => /pg_advisory_xact_lock/.test(s));
  const ins = sqls.findIndex(s => /INSERT INTO rfis/.test(s));
  expect(sqls[0]).toBe('BEGIN');
  expect(lock).toBeGreaterThan(-1);
  expect(lock).toBeLessThan(ins);
  expect(calls[lock].params).toEqual(['rfi_number:co-1']);
  expect(sqls).toContain('COMMIT');
  expect(client.release).toHaveBeenCalled();
  expect(pool.query.mock.calls.some(c => /INSERT INTO rfis/.test(c[0]))).toBe(false);
});
