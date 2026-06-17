// Tests for the worker self-service /me/booking endpoints. The narrower
// surface vs the admin /users/:id/booking path: workers can edit their
// role label / timezone / windows, but NOT flip their own bookable flag.

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
jest.mock('../db', () => {
  const q = jest.fn();
  return { query: q, connect: jest.fn().mockResolvedValue({ query: (...a) => q(...a), release: jest.fn() }) };
});
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool    = require('../db');
const route   = require('../routes/booking');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', route);
  return app;
}

beforeEach(() => {
  pool.query.mockReset();
  mockCurrentUser = { id: 5, company_id: 'co-1', role: 'worker', full_name: 'Worker Bob' };
});

describe('GET /api/me/booking', () => {
  test('returns the caller user + windows', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        id: 5, full_name: 'Worker Bob', bookable: true,
        bookable_role_label: 'Estimator', timezone: 'America/Phoenix',
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: 1, weekday: 1, start_time: '09:00:00', end_time: '17:00:00', active: true,
      }] });
    const res = await request(makeApp()).get('/api/me/booking');
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(5);
    expect(res.body.windows).toHaveLength(1);
  });

  test('404 if user lookup returns no row', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp()).get('/api/me/booking');
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/me/booking', () => {
  test('400 on invalid weekday', async () => {
    pool.query.mockResolvedValueOnce(undefined);  // BEGIN
    const res = await request(makeApp())
      .put('/api/me/booking')
      .send({ windows: [{ weekday: 7, start_time: '09:00', end_time: '17:00' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/weekday/);
  });

  test('400 on end_time <= start_time', async () => {
    pool.query.mockResolvedValueOnce(undefined);
    const res = await request(makeApp())
      .put('/api/me/booking')
      .send({ windows: [{ weekday: 1, start_time: '17:00', end_time: '09:00' }] });
    expect(res.status).toBe(400);
  });

  test('400 on missing start_time / end_time', async () => {
    pool.query.mockResolvedValueOnce(undefined);
    const res = await request(makeApp())
      .put('/api/me/booking')
      .send({ windows: [{ weekday: 1, start_time: '09:00' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/start_time and end_time required/);
  });

  test('does NOT accept `bookable` flag (only admin path can flip it)', async () => {
    // BEGIN → UPDATE users (for timezone) → COMMIT → SELECT user → SELECT windows
    pool.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rows: [{ id: 5, full_name: 'Worker Bob', bookable: false, bookable_role_label: null, timezone: 'America/Phoenix' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp())
      .put('/api/me/booking')
      .send({ bookable: true, timezone: 'America/Phoenix' });
    expect(res.status).toBe(200);
    // The UPDATE should NOT have included a "bookable = ..." clause —
    // the route ignores that field even though it's in the body.
    const updateCall = pool.query.mock.calls.find(c =>
      typeof c[0] === 'string' && /UPDATE users SET/.test(c[0])
    );
    if (updateCall) {
      expect(updateCall[0]).not.toMatch(/\bbookable\s*=/);
    }
  });
});
