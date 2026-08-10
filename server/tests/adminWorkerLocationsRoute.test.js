/**
 * GET /admin/worker-locations — the Location history feed (worker's recorded
 * clock-in/out points in a date range), plus the location fields now returned by
 * GET /admin/entries/recently-approved for the approved-entry detail popup.
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

describe('GET /admin/worker-locations', () => {
  test('400 when user_id is missing', async () => {
    const res = await request(makeApp()).get('/api/admin/worker-locations?from=2026-08-01&to=2026-08-07');
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('returns the worker rows and passes company + user + range params', async () => {
    pool.query.mockResolvedValueOnce({ rows: [
      { id: 10, work_date: '2026-08-03', start_time: '08:00:00', end_time: '16:00:00', status: 'approved',
        clock_in_lat: '30.1', clock_in_lng: '-97.7', clock_out_lat: null, clock_out_lng: null, project_name: 'Alpha' },
    ] });
    const res = await request(makeApp()).get('/api/admin/worker-locations?user_id=5&from=2026-08-01&to=2026-08-07');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(10);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/clock_in_lat IS NOT NULL OR te\.clock_out_lat IS NOT NULL/);
    expect(params).toEqual(['co-1', 5, '2026-08-01', '2026-08-07']);
  });

  test('worker_access_ids scoping: a worker outside the caller\'s scope returns [] without querying', async () => {
    setUser({ worker_access_ids: [7, 8] });
    const res = await request(makeApp()).get('/api/admin/worker-locations?user_id=5&from=2026-08-01&to=2026-08-07');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('GET /admin/entries/recently-approved (enriched fields)', () => {
  test('range mode selects location + approver/source fields and excludes finalized entries', async () => {
    pool.query.mockResolvedValueOnce({ rows: [
      { id: 1, worker_name: 'Sam', clock_in_lat: '30.1', approved_by_name: 'Boss', clock_source: 'worker' },
    ] });
    const res = await request(makeApp()).get('/api/admin/entries/recently-approved?from=2026-08-01&to=2026-08-07');
    expect(res.status).toBe(200);
    const [sql] = pool.query.mock.calls[0];
    // New fields present in the SELECT
    expect(sql).toMatch(/te\.clock_in_lat, te\.clock_in_lng, te\.clock_out_lat, te\.clock_out_lng/);
    expect(sql).toMatch(/approver\.full_name AS approved_by_name/);
    // Range mode still filters out entries inside a finalized payroll run
    expect(sql).toMatch(/pr\.status = 'finalized'/);
  });
});
