let mockCurrentUser;

jest.mock('../middleware/auth', () => ({
  requireAuth:                  (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin:                 (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePermission:            () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePerm:                  () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePlan:                  () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireProAddon:              (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireCertifiedPayrollAddon: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  hasAdminPermission:           () => true,
  requireSuperAdmin:            (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToAllWorkers: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../services/qbo', () => ({}));
jest.mock('../routes/inbox', () => ({
  createInboxItem: jest.fn(), createInboxItemBatch: jest.fn(),
}));
jest.mock('../r2', () => ({
  getPresignedUploadUrl: jest.fn(),
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

describe('POST /admin/workers/invite', () => {
  beforeEach(() => {
    pool.query.mockReset();
    mockCurrentUser = {
      id: 1,
      company_id: 'co-1',
      role: 'admin',
      full_name: 'Test Admin',
    };
  });

  test('stores the employment and pay settings selected by the inviter', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ plan: 'business', subscription_status: 'active', trial_ends_at: null }],
      })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 35 }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: 22,
          username: 'arivera',
          full_name: 'Alex Rivera',
          first_name: 'Alex',
          last_name: 'Rivera',
          role: 'worker',
          role_id: 35,
          language: 'Spanish',
          hourly_rate: '420.00',
          rate_type: 'daily',
          overtime_rule: 'weekly',
          worker_type: 'contractor',
          classification: 'Electrician',
          email: 'alex@example.com',
        }],
      });

    const res = await request(makeApp())
      .post('/api/admin/workers/invite')
      .send({
        first_name: 'Alex',
        last_name: 'Rivera',
        full_name: 'Alex Rivera',
        email: 'alex@example.com',
        role: 'worker',
        language: 'Spanish',
        hourly_rate: 420,
        rate_type: 'daily',
        overtime_rule: 'weekly',
        worker_type: 'contractor',
        classification: 'Electrician',
      });

    expect(res.status).toBe(201);
    const insertCall = pool.query.mock.calls[3];
    expect(insertCall[0]).toContain('first_name');
    expect(insertCall[0]).toContain('worker_type');
    expect(insertCall[0]).toContain('classification');
    expect(insertCall[1].slice(0, 14)).toEqual([
      'co-1',
      'arivera',
      'Alex Rivera',
      'Alex',
      'Rivera',
      'worker',
      35,
      'Spanish',
      420,
      'daily',
      'weekly',
      'contractor',
      'Electrician',
      'alex@example.com',
    ]);
  });
});
