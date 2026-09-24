/**
 * admin.js:
 *  - GET /admin/analytics: hours subtract break_minutes, rejected entries excluded, and the
 *    custom-range daily series returns the LATEST 90 days (ascending), not the oldest 90.
 *  - GET /admin/projects/metrics: entries restricted to ACTIVE projects in SQL.
 *  - GET /admin/pending-count: one cheap COUNT for the dashboard badge.
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
jest.mock('../utils/rateHistory', () => ({
  ...jest.requireActual('../utils/rateHistory'),
  loadRateBook: jest.fn(async () => ({})),
  workerRateOn: jest.fn(() => ({ rate: 30 })),
}));

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
beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockImplementation(async () => ({ rowCount: 0, rows: [] }));
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'A', worker_access_ids: null };
});
const sqlCalls = re => pool.query.mock.calls.filter(c => re.test(c[0]));

describe('GET /admin/analytics', () => {
  test('every hours query subtracts breaks and excludes rejected entries', async () => {
    const res = await request(makeApp()).get('/api/admin/analytics');
    expect(res.status).toBe(200);
    const hourQueries = sqlCalls(/FROM time_entries/);
    expect(hourQueries.length).toBe(5);
    for (const [sql] of hourQueries) {
      expect(sql).toMatch(/break_minutes/);
      expect(sql).toMatch(/status IS DISTINCT FROM 'rejected'/);
    }
  });

  test('custom-range daily series keeps the latest 90 days, returned ascending', async () => {
    await request(makeApp()).get('/api/admin/analytics?from=2025-01-01&to=2026-09-01');
    const [daily] = sqlCalls(/work_date::text as date/);
    expect(daily[0]).toMatch(/ORDER BY work_date DESC\s+LIMIT 90/);
    expect(daily[0]).toMatch(/ORDER BY date ASC/);
  });
});

describe('GET /admin/projects/metrics', () => {
  test('entries are restricted to active projects in SQL', async () => {
    const res = await request(makeApp()).get('/api/admin/projects/metrics');
    expect(res.status).toBe(200);
    const [entries] = sqlCalls(/FROM time_entries te/);
    expect(entries[0]).toMatch(/JOIN projects p ON p\.id = te\.project_id/);
    expect(entries[0]).toMatch(/p\.active = true/);
  });
});

describe('GET /admin/pending-count', () => {
  test('returns a single pending COUNT', async () => {
    pool.query.mockImplementation(async () => ({ rows: [{ count: '4' }] }));
    const res = await request(makeApp()).get('/api/admin/pending-count');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pending_approvals: 4 });
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toMatch(/COUNT\(\*\)[\s\S]*status = 'pending'/);
  });

  test('scopes to the admin\'s worker access list when set', async () => {
    mockCurrentUser.worker_access_ids = [5, 6];
    pool.query.mockImplementation(async () => ({ rows: [{ count: '1' }] }));
    await request(makeApp()).get('/api/admin/pending-count');
    expect(pool.query.mock.calls[0][0]).toMatch(/user_id = ANY\(\$2\)/);
    expect(pool.query.mock.calls[0][1]).toEqual(['co-1', [5, 6]]);
  });
});
