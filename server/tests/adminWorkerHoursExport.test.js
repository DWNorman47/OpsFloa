/**
 * Tests for GET /admin/export/worker-hours — the per-worker approved-hours CSV
 * summary. Verifies the Regular/OT/Total math (Regular = Total − OT), the
 * totals row, the 400 guard, and worker_access_ids scoping.
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

describe('GET /admin/export/worker-hours', () => {
  test('400 when from/to are missing', async () => {
    const res = await request(makeApp()).get('/api/admin/export/worker-hours');
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('computes Regular/OT/Total + days per worker (approved, daily OT@8)', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ key: 'overtime_threshold', value: '8' }] }) // getSettings
      .mockResolvedValueOnce({ rows: [{ id: 5, full_name: 'Alex Rivera', invoice_name: null, overtime_rule: 'daily' }] }) // workers
      .mockResolvedValueOnce({ rows: [ // approved entries
        { user_id: 5, wage_type: 'regular', start_time: '08:00', end_time: '18:00', work_date: '2026-06-01', break_minutes: 0 }, // 10h → 8 reg + 2 OT
        { user_id: 5, wage_type: 'regular', start_time: '08:00', end_time: '14:00', work_date: '2026-06-02', break_minutes: 0 }, // 6h → 6 reg
      ] });

    const res = await request(makeApp()).get('/api/admin/export/worker-hours?from=2026-06-01&to=2026-06-30');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.split(/\r?\n/);
    expect(lines[0]).toBe('Worker,Regular Hrs,OT Hrs,Total Hrs,Days Worked');
    expect(lines).toContain('"Alex Rivera",14.00,2.00,16.00,2');
    expect(lines[lines.length - 1]).toBe('"TOTAL",14.00,2.00,16.00,2');
    // approved-only filter present
    expect(pool.query.mock.calls[2][0]).toMatch(/status = 'approved'/);
  });

  test('honors worker_access_ids scope in both queries', async () => {
    setUser({ worker_access_ids: [5, 6] });
    pool.query
      .mockResolvedValueOnce({ rows: [] })  // settings
      .mockResolvedValueOnce({ rows: [] })  // workers
      .mockResolvedValueOnce({ rows: [] }); // entries
    const res = await request(makeApp()).get('/api/admin/export/worker-hours?from=2026-06-01&to=2026-06-30');
    expect(res.status).toBe(200);
    const [workersSql, workersParams] = pool.query.mock.calls[1];
    const [entriesSql, entriesParams] = pool.query.mock.calls[2];
    expect(workersSql).toMatch(/id = ANY\(/);
    expect(entriesSql).toMatch(/user_id = ANY\(/);
    expect(workersParams).toContainEqual([5, 6]);
    expect(entriesParams).toContainEqual([5, 6]);
  });
});
