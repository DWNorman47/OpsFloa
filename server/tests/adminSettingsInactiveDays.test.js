/**
 * PATCH /admin/settings — notification_inactive_days must be a positive whole number
 * (jobs/inactiveWorkers.js reads it as a day count).
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

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Ada' };
});

const settingWrites = () => pool.query.mock.calls.filter(c => /INSERT INTO settings/.test(c[0]));

test.each([3.5, '3.5', 0, -2])('rejects notification_inactive_days=%p', async (v) => {
  const res = await request(makeApp()).patch('/api/admin/settings').send({ notification_inactive_days: v });
  expect(res.status).toBe(400);
  expect(settingWrites()).toHaveLength(0);
});

test('accepts a positive whole number', async () => {
  const res = await request(makeApp()).patch('/api/admin/settings').send({ notification_inactive_days: 5 });
  expect(res.status).toBe(200);
  expect(settingWrites()[0][1]).toEqual(['co-1', 'notification_inactive_days', 5]);
});
