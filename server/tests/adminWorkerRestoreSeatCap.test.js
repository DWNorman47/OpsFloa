/**
 * PATCH /admin/workers/:id/restore must enforce the plan seat cap — otherwise a
 * Free/Starter company can archive→create→restore its way past the paid seat count.
 * Create and invite already check the cap; this pins that restore does too.
 */

let mockCurrentUser;
jest.mock('../middleware/auth', () => ({
  requireAuth:  (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePermission: () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
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

function makeApp() { const app = express(); app.use(express.json()); app.use('/api/admin', adminRoute); return app; }

const freeCompany = { rows: [{ plan: 'free', subscription_status: 'active', trial_ends_at: null, bonus_seats: 0 }] };
const restored = { rowCount: 1, rows: [{ id: 9, full_name: 'Jo', username: 'jo', role: 'worker', language: 'en', hourly_rate: 25 }] };

beforeEach(() => {
  pool.query.mockReset();
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Admin' };
});

describe('PATCH /admin/workers/:id/restore — seat cap', () => {
  test('403 when restoring a worker would exceed the plan seat cap', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ role: 'worker' }] }) // target lookup
      .mockResolvedValueOnce(freeCompany)                                 // checkWorkerLimit: company (cap 3)
      .mockResolvedValueOnce({ rows: [{ count: '3' }] });                 // checkWorkerLimit: active count = 3
    const res = await request(makeApp()).patch('/api/admin/workers/9/restore');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('worker_limit_reached');
    // No UPDATE ran (only the 3 read queries).
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  test('restores when under the cap', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ role: 'worker' }] })
      .mockResolvedValueOnce(freeCompany)
      .mockResolvedValueOnce({ rows: [{ count: '2' }] }) // 2 < 3
      .mockResolvedValueOnce(restored);                  // UPDATE ... RETURNING
    const res = await request(makeApp()).patch('/api/admin/workers/9/restore');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(9);
  });

  test('an archived ADMIN is restored without a worker-cap check', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ role: 'admin' }] }) // target is an admin
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, full_name: 'Boss', username: 'boss', role: 'admin', language: 'en', hourly_rate: null }] });
    const res = await request(makeApp()).patch('/api/admin/workers/5/restore');
    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(2); // lookup + UPDATE, no checkWorkerLimit
  });

  test('404 when the archived worker is not found', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp()).patch('/api/admin/workers/9/restore');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /admin/workers/:id/restore — Business seat cap', () => {
  const business = (over = {}) => ({ rows: [{ plan: 'business', subscription_status: 'active', trial_ends_at: null, bonus_seats: 0, paid_worker_seats: 5, ...over }] });

  test('403 at the Business cap (15 included + 5 paid = 20, and 20 active)', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ role: 'worker' }] })
      .mockResolvedValueOnce(business())                 // 15 + 5 = 20
      .mockResolvedValueOnce({ rows: [{ count: '20' }] }); // at cap
    const res = await request(makeApp()).patch('/api/admin/workers/9/restore');
    expect(res.status).toBe(403);
    expect(res.body.limit).toBe(20);
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  test('restores under the Business cap (19 < 20)', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ role: 'worker' }] })
      .mockResolvedValueOnce(business())
      .mockResolvedValueOnce({ rows: [{ count: '19' }] })
      .mockResolvedValueOnce(restored);
    const res = await request(makeApp()).patch('/api/admin/workers/9/restore');
    expect(res.status).toBe(200);
  });

  test('grace: paid_worker_seats NULL (subscription not yet synced) → unlimited', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ role: 'worker' }] })
      .mockResolvedValueOnce(business({ paid_worker_seats: null })) // not synced → grace
      .mockResolvedValueOnce(restored); // no COUNT query — returns null before it
    const res = await request(makeApp()).patch('/api/admin/workers/9/restore');
    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(3); // lookup + company (grace, no count) + UPDATE
  });
});
