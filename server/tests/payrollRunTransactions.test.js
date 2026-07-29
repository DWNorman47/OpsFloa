let mockCurrentUser;

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePerm: () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePlan: () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireProAddon: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireCertifiedPayrollAddon: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  hasAdminPermission: () => true,
  requireSuperAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToAllWorkers: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../services/qbo', () => ({}));
jest.mock('../routes/inbox', () => ({ createInboxItem: jest.fn(), createInboxItemBatch: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const { logAudit } = require('../auditLog');
const adminRoute = require('../routes/admin');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: jest.fn() }; next(); });
  app.use('/api/admin', adminRoute);
  return app;
}

function mockClient(results) {
  const client = {
    query: jest.fn(),
    release: jest.fn(),
  };
  for (const result of results) client.query.mockResolvedValueOnce(result);
  pool.connect.mockResolvedValueOnce(client);
  return client;
}

beforeEach(() => {
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Payroll Admin' };
  pool.query.mockReset();
  pool.connect.mockReset();
  logAudit.mockReset();
});

test('mark-paid locks the run and updates checks in one transaction', async () => {
  const client = mockClient([
    {},
    { rowCount: 1, rows: [{ id: 9, status: 'finalized' }] },
    { rowCount: 2, rows: [{ id: 21 }, { id: 22 }] },
    {},
  ]);

  const res = await request(makeApp())
    .post('/api/admin/payroll-runs/9/paid')
    .send({ all: true });

  expect(res.status).toBe(200);
  expect(res.body.updated).toBe(2);
  expect(client.query.mock.calls[1][0]).toContain('FOR UPDATE');
  expect(client.query.mock.calls[2][0]).toContain("status = 'paid'");
  expect(client.query.mock.calls[3][0]).toBe('COMMIT');
  expect(logAudit).toHaveBeenCalledWith(
    'co-1',
    1,
    'Payroll Admin',
    'payroll.checks_paid',
    'payroll_run',
    '9',
    null,
    expect.objectContaining({ check_ids: [21, 22] })
  );
});

test('void locks the same run and rejects paid checks before changing status', async () => {
  const client = mockClient([
    {},
    { rowCount: 1, rows: [{ id: 9, status: 'finalized' }] },
    { rowCount: 1, rows: [{ '?column?': 1 }] },
    {},
  ]);

  const res = await request(makeApp())
    .post('/api/admin/payroll-runs/9/void')
    .send({});

  expect(res.status).toBe(409);
  expect(res.body.code).toBe('has_paid_checks');
  expect(client.query.mock.calls[1][0]).toContain('FOR UPDATE');
  expect(client.query.mock.calls[3][0]).toBe('ROLLBACK');
  expect(client.query.mock.calls.some(call => /UPDATE payroll_runs SET status = 'void'/.test(call[0]))).toBe(false);
});
