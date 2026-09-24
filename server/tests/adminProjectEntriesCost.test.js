/**
 * GET /admin/projects/:id/entries — the project bill's labor cost.
 *
 * A daily-rate worker's day shared with another project costs this project only
 * its hours' share of the day rate (same rule as laborCostCents / job cost). An
 * 'unpaid' worker earns nothing — the statement already prices them at $0, so the
 * split-day subtraction must skip them too (it used to subtract the other
 * project's share of a day rate they never earned → a NEGATIVE labor cost).
 */

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

const entry = (over = {}) => ({
  id: 1, user_id: 10, project_id: 5, company_id: 'co-1', work_date: '2026-09-08',
  start_time: '08:00:00', end_time: '12:00:00', break_minutes: 0, wage_type: 'regular',
  overtime_hours_override: null, status: 'approved',
  worker_name: 'Dana', username: 'dana', hourly_rate: '200.00', rate_type: 'daily',
  overtime_rule: null, role_id: null, worker_type: 'employee', ...over,
});

function installDb({ own, other }) {
  pool.query.mockReset();
  pool.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (/SELECT \* FROM projects WHERE id/.test(s)) return { rows: [{ id: 5, name: 'P', prevailing_wage_rate: null }], rowCount: 1 };
    if (/JOIN unnest/.test(s)) return { rows: [...own, ...other].map(r => ({ ...r, rate: r.hourly_rate })) };
    if (/FROM time_entries te/.test(s) && /te\.project_id = \$1/.test(s)) return { rows: own.map(r => ({ ...r })) };
    if (/FROM settings/.test(s)) return { rows: [{ key: 'overtime_rule', value: 'none' }] };
    return { rows: [] };
  });
}

beforeEach(() => { mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'A' }; });

test('a $200 day split 4h/4h with another project costs this project $100', async () => {
  installDb({ own: [entry()], other: [entry({ id: 2, project_id: 6, start_time: '13:00:00', end_time: '17:00:00' })] });
  const res = await request(makeApp()).get('/api/admin/projects/5/entries');
  expect(res.status).toBe(200);
  expect(res.body.summary.total_cost).toBeCloseTo(100, 6);
});

test('an unpaid worker\'s split day costs $0, not a negative share', async () => {
  const unpaid = { worker_type: 'unpaid' };
  installDb({ own: [entry(unpaid)], other: [entry({ id: 2, project_id: 6, start_time: '13:00:00', end_time: '17:00:00', ...unpaid })] });
  const res = await request(makeApp()).get('/api/admin/projects/5/entries');
  expect(res.status).toBe(200);
  expect(res.body.summary.total_cost).toBe(0); // was −100
});
