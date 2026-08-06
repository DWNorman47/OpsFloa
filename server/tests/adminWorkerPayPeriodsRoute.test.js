/**
 * GET /admin/workers/:id/pay-periods — the "This/Last paycheck" preset source.
 *
 * Resolves the worker's role → single paycheck ruleset, generates periods around
 * today, and returns the current (latest already-started) period and the one before
 * it. The route reads the real "now", so we assert date-robust invariants (span,
 * ordering, current ≤ today) rather than hard-coded ranges, plus the no-ruleset gate.
 */

let mockCurrentUser;

jest.mock('../middleware/auth', () => ({
  requireAuth:  (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePerm:  () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePlan:  () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
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

const DAY = 86400000;
const ymdMs = ymd => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const daysBetween = (a, b) => Math.round((ymdMs(b) - ymdMs(a)) / DAY);

beforeEach(() => { pool.query.mockReset(); mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin' }; });

// The route runs: SELECT role_id (worker), then getSettings (SELECT key,value).
function mockWorkerAndSettings(roleId, settingsRows) {
  pool.query
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ role_id: roleId }] }) // worker lookup
    .mockResolvedValueOnce({ rows: settingsRows });                      // getSettings
}

test('404 when the worker does not exist', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
  const res = await request(makeApp()).get('/api/admin/workers/99/pay-periods');
  expect(res.status).toBe(404);
});

test('no paycheck rules configured → both periods null (presets omitted)', async () => {
  mockWorkerAndSettings(5, []); // no paycheck_rules setting
  const res = await request(makeApp()).get('/api/admin/workers/5/pay-periods');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ current: null, previous: null });
});

test("worker's role matches no ruleset → both periods null", async () => {
  const rules = { rulesets: [{ id: 'w', name: 'Weekly', roles: [7], schedule: { frequency: 'weekly', payWeekday: 5 } }] };
  mockWorkerAndSettings(5, [{ key: 'paycheck_rules', value: JSON.stringify(rules) }]); // role 5 ∉ [7]
  const res = await request(makeApp()).get('/api/admin/workers/5/pay-periods');
  expect(res.body).toEqual({ current: null, previous: null });
});

test('weekly schedule → current is a 7-day span already started; previous is the week before', async () => {
  const rules = { rulesets: [{ id: 'w', name: 'Weekly', roles: [5], schedule: { frequency: 'weekly', payWeekday: 5, periodBasis: 'on_payday' } }] };
  mockWorkerAndSettings(5, [
    { key: 'paycheck_rules', value: JSON.stringify(rules) },
    { key: 'week_start', value: '1' },
  ]);
  const res = await request(makeApp()).get('/api/admin/workers/5/pay-periods');
  expect(res.status).toBe(200);
  const { current, previous } = res.body;
  const today = new Date().toISOString().slice(0, 10);

  // A weekly period covers 7 days (on_payday: payT-6 … payT).
  expect(daysBetween(current.period_start, current.period_end)).toBe(6);
  // The current period has already started.
  expect(current.period_start <= today).toBe(true);
  // Previous sits exactly one week earlier and ends the day before current begins.
  expect(daysBetween(previous.period_start, current.period_start)).toBe(7);
  expect(daysBetween(previous.period_end, current.period_end)).toBe(7);
});

test('semimonthly schedule → current spans part of the month and is already started', async () => {
  const rules = { rulesets: [{ id: 's', name: 'SM', roles: [5], schedule: { frequency: 'semimonthly', daysOfMonth: [15, 30] } }] };
  mockWorkerAndSettings(5, [{ key: 'paycheck_rules', value: JSON.stringify(rules) }]);
  const res = await request(makeApp()).get('/api/admin/workers/5/pay-periods');
  expect(res.status).toBe(200);
  const today = new Date().toISOString().slice(0, 10);
  expect(res.body.current).not.toBeNull();
  expect(res.body.current.period_start <= today).toBe(true);
  // Previous period ends strictly before the current one begins.
  expect(res.body.previous.period_end < res.body.current.period_start).toBe(true);
});
