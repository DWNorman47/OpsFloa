/**
 * GET /admin/entries/recently-rejected (mirror of recently-approved) and
 * PATCH /admin/entries/:id/unreject (rejected → pending).
 */

let mockCurrentUser;

jest.mock('../middleware/auth', () => ({
  requireAuth:  (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePerm:  () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePlan:  () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireProAddon: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireCertifiedPayrollAddon: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  hasAdminPermission: () => true,
  requireSuperAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToAllWorkers: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../services/qbo', () => ({}));
jest.mock('../routes/inbox', () => ({ createInboxItem: jest.fn(), createInboxItemBatch: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const adminRoute = require('../routes/admin');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoute);
  return app;
}
function setUser(over = {}) {
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Test Admin', worker_access_ids: null, ...over };
}
beforeEach(() => { pool.query.mockReset(); setUser(); });

describe('GET /admin/entries/recently-rejected', () => {
  test('no range → last 24h of rejections (status rejected, approved_at window)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 3, worker_name: 'Sam', approval_note: 'wrong project' }] });
    const res = await request(makeApp()).get('/api/admin/entries/recently-rejected');
    expect(res.status).toBe(200);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/te\.status = 'rejected'/);
    expect(sql).toMatch(/approved_at >= NOW\(\) - INTERVAL '24 hours'/);
    expect(sql).toMatch(/te\.approval_note/);         // rejection reason returned
    expect(params).toEqual(['co-1']);
  });

  test('with range → filters by work_date, no finalized-payroll filter', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(makeApp()).get('/api/admin/entries/recently-rejected?from=2026-08-01&to=2026-08-07');
    expect(res.status).toBe(200);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/te\.work_date >= \$2::date/);
    expect(sql).toMatch(/te\.work_date <= \$3::date/);
    expect(sql).not.toMatch(/payroll_run_checks/); // rejected entries aren't in payroll
    expect(params).toEqual(['co-1', '2026-08-01', '2026-08-07']);
  });
});

describe('PATCH /admin/entries/:id/unreject', () => {
  test('restores a rejected entry to pending', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, status: 'pending' }] });
    const res = await request(makeApp()).patch('/api/admin/entries/5/unreject');
    expect(res.status).toBe(200);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/SET status = 'pending', approval_note = NULL/);
    expect(sql).toMatch(/AND status = 'rejected'/); // only acts on rejected rows
  });

  test('404 when the entry is not rejected', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp()).patch('/api/admin/entries/5/unreject');
    expect(res.status).toBe(404);
  });
});
