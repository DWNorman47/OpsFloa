/**
 * ONE worker set for every payroll surface that totals a company's pay:
 * the QuickBooks payroll journal (POST /qbo/push-payroll), the payroll CSV
 * (GET /admin/payroll-export) and the overtime report (GET /admin/overtime-report).
 *
 * The JE had been widened to "anyone with approved time/leave in range" (so a
 * deactivated worker's wages aren't reversed on a corrected re-push) while the
 * CSV / OT report still loaded only ACTIVE role='worker' users — the JE then
 * included owners/admins the payroll CSV never paid, and the CSV dropped a worker
 * deactivated mid-period. Rule (utils/payStatement.js payrollWorkers):
 *   - approved time OR approved sick/vacation in [from,to], any active flag,
 *     OR active with a weekly-hours guarantee (owed a top-up with no time);
 *   - never worker_type 'owner' / 'unpaid';
 *   - no "salaried" flag exists, so role admin / super_admin only when they have
 *     their own hourly/daily rate > 0 (an owner-operator logging time for job
 *     cost isn't on payroll at the company default rate).
 */

let mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'A' };
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
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToAllWorkers: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../routes/inbox', () => ({ createInboxItem: jest.fn(), createInboxItemBatch: jest.fn() }));
jest.mock('../services/qbo', () => ({ createJournalEntry: jest.fn(), createBill: jest.fn(), timeActivityHours: jest.fn() }));
jest.mock('../utils/payStatement', () => {
  const actual = jest.requireActual('../utils/payStatement');
  return { ...actual, companyStatements: jest.fn() };
});

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const qbo = require('../services/qbo');
const { companyStatements, PAYROLL_WORKERS_SQL } = require('../utils/payStatement');
const adminRoute = require('../routes/admin');
const qboRoute = require('../routes/qbo');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoute);
  app.use('/api/qbo', qboRoute);
  return app;
}

const worker = { id: 10, full_name: 'A', invoice_name: null, hourly_rate: 20, rate_type: 'hourly', overtime_rule: null, role_id: null, guaranteed_weekly_hours: 0 };
const stmt = () => ({
  rates: { rate: 20, rateType: 'hourly' },
  hours: { regular: 8, overtime: 0, prevailing: 0, sick: 0, vacation: 0, guaranteeShortfall: 0, total: 8, mileage: 0, night: 0 },
  cost: { regular: 160, overtime: 0, prevailing: 0, night: 0, sick: 0, vacation: 0, guarantee: 0 },
  totals: { grossWages: 160, netWages: 160 },
});

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (/FROM users/.test(s)) return { rows: [worker] };
    if (/SELECT qbo_realm_id FROM companies/.test(s)) return { rows: [{ qbo_realm_id: 'r' }] };
    return { rows: [], rowCount: 0 };
  });
  companyStatements.mockReset();
  companyStatements.mockImplementation(async ({ workers }) => new Map(workers.map(w => [w.id, stmt()])));
  qbo.createJournalEntry.mockReset();
  qbo.createJournalEntry.mockResolvedValue({ Id: 'JE-1', TotalAmt: 160 });
});

const usersSql = () => pool.query.mock.calls.map(c => String(c[0])).filter(s => /FROM users u/.test(s) && /guaranteed_weekly_hours/.test(s));

test('the shared worker-set SQL: any active flag, approved time/leave, no owner/unpaid, admins only with a rate', () => {
  const s = PAYROLL_WORKERS_SQL;
  expect(s).not.toMatch(/u\.active = true AND u\.role = 'worker'/);
  expect(s).not.toMatch(/u\.role = 'worker'/);
  expect(s).toMatch(/NOT IN \('owner', 'unpaid'\)/);
  // Admins: a rate > 0 in effect during the range (rate history), not today's rate.
  expect(s).toMatch(/u\.role NOT IN \('admin', 'super_admin'\)\s+OR EXISTS \(SELECT 1 FROM worker_rate_history h/);
  expect(s).toMatch(/h\.hourly_rate > 0\s+AND h\.effective_date <= \$3::date/);
  expect(s).toMatch(/FROM time_entries te[\s\S]*te\.status = 'approved'/);
  expect(s).toMatch(/FROM time_off_requests r[\s\S]*r\.status = 'approved'/);
});

test('payroll CSV, overtime report and the payroll JE all load the SAME worker set', async () => {
  const q = '?from=2026-09-01&to=2026-09-07';
  const csv = await request(makeApp()).get('/api/admin/payroll-export' + q);
  expect(csv.status).toBe(200);
  const csvSql = usersSql();
  pool.query.mockClear();
  const ot = await request(makeApp()).get('/api/admin/overtime-report' + q);
  expect(ot.status).toBe(200);
  const otSql = usersSql();
  pool.query.mockClear();
  const je = await request(makeApp()).post('/api/qbo/push-payroll')
    .send({ from: '2026-09-01', to: '2026-09-07', debit_account_id: 'D', credit_account_id: 'C' });
  expect(je.status).toBe(200);
  const jeSql = usersSql();
  expect(csvSql).toEqual([PAYROLL_WORKERS_SQL]);
  expect(otSql).toEqual([PAYROLL_WORKERS_SQL]);
  expect(jeSql).toEqual([PAYROLL_WORKERS_SQL]);
});
