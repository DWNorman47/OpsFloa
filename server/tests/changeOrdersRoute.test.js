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
jest.mock('../middleware/commercialAccess', () => ({
  requireCommercialAccess: (req, _res, next) => next(),
}));
jest.mock('../db', () => {
  const q = jest.fn();
  return { query: q, connect: jest.fn().mockResolvedValue({ query: (...a) => q(...a), release: jest.fn() }) };
});
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool    = require('../db');
const coRoute = require('../routes/changeOrders');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', coRoute);
  app.use('/api/public/change-orders', coRoute.publicRouter);
  return app;
}

beforeEach(() => {
  pool.query.mockReset();
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Admin' };
});

// ── List filtering ────────────────────────────────────────────────────────────

describe('GET /api/change-orders', () => {
  test('rejects invalid status filter', async () => {
    const res = await request(makeApp()).get('/api/change-orders').query({ status: 'bogus' });
    expect(res.status).toBe(400);
  });
});

// ── Create with cross-tenant gate ─────────────────────────────────────────────

describe('POST /api/projects/:projectId/change-orders', () => {
  test('400 on missing description', async () => {
    const res = await request(makeApp())
      .post('/api/projects/10/change-orders')
      .send({});
    expect(res.status).toBe(400);
  });

  test('404 when project not in caller company', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)                                // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })                // SELECT project
      .mockResolvedValueOnce(undefined);                               // ROLLBACK
    const res = await request(makeApp())
      .post('/api/projects/10/change-orders')
      .send({ description: 'Add second floor' });
    expect(res.status).toBe(404);
  });
});

// ── Frozen-state edits ────────────────────────────────────────────────────────

describe('PATCH /api/change-orders/:id', () => {
  test('409 when CO is frozen at sent', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 7, status: 'sent', co_number: 'CO-001', project_id: 10 }],
    });
    const res = await request(makeApp()).patch('/api/change-orders/7').send({ description: 'new' });
    expect(res.status).toBe(409);
  });

  test('409 when CO is frozen at accepted', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 7, status: 'accepted', co_number: 'CO-001', project_id: 10 }],
    });
    const res = await request(makeApp()).patch('/api/change-orders/7').send({ description: 'new' });
    expect(res.status).toBe(409);
  });
});

// ── Send ──────────────────────────────────────────────────────────────────────

describe('POST /api/change-orders/:id/send', () => {
  test('409 when CO is not in draft', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7, status: 'sent', co_number: 'CO-001' }] })
      .mockResolvedValueOnce(undefined);
    const res = await request(makeApp()).post('/api/change-orders/7/send');
    expect(res.status).toBe(409);
  });
});

// ── Public accept — token validation ──────────────────────────────────────────

describe('POST /api/public/change-orders/accept/:token', () => {
  test('400 when typed_name missing', async () => {
    const res = await request(makeApp())
      .post('/api/public/change-orders/accept/tok')
      .send({ authorized: true });
    expect(res.status).toBe(400);
  });

  test('400 when authorized not true', async () => {
    const res = await request(makeApp())
      .post('/api/public/change-orders/accept/tok')
      .send({ typed_name: 'Jane' });
    expect(res.status).toBe(400);
  });

  test('404 when token does not match', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce(undefined);
    const res = await request(makeApp())
      .post('/api/public/change-orders/accept/tok')
      .send({ typed_name: 'Jane', authorized: true });
    expect(res.status).toBe(404);
  });

  test('409 when CO not in sent', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7, project_id: 10, status: 'accepted', co_number: 'CO-001' }] })
      .mockResolvedValueOnce(undefined);
    const res = await request(makeApp())
      .post('/api/public/change-orders/accept/tok')
      .send({ typed_name: 'Jane', authorized: true });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/public/change-orders/decline/:token', () => {
  test('404 when token does not match', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)                 // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce(undefined);                // ROLLBACK
    const res = await request(makeApp())
      .post('/api/public/change-orders/decline/tok')
      .send({});
    expect(res.status).toBe(404);
  });

  test('409 when CO not in sent', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)                                          // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7, status: 'accepted' }] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce(undefined);                                         // ROLLBACK
    const res = await request(makeApp())
      .post('/api/public/change-orders/decline/tok')
      .send({});
    expect(res.status).toBe(409);
  });

  test('declines a sent CO under a row lock (FOR UPDATE + status guard)', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)                                       // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7, status: 'sent' }] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })                       // UPDATE ... declined
      .mockResolvedValueOnce(undefined);                                      // COMMIT
    const res = await request(makeApp())
      .post('/api/public/change-orders/decline/tok')
      .send({});
    expect(res.status).toBe(200);
    const sel = pool.query.mock.calls.find(c => /SELECT id, status FROM change_orders/.test(c[0]));
    expect(sel[0]).toMatch(/FOR UPDATE/);
    const upd = pool.query.mock.calls.find(c => /UPDATE change_orders SET status='declined'/.test(c[0]));
    expect(upd[0]).toMatch(/AND status='sent'/);
  });
});
