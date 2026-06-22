/**
 * Cross-tenant and lifecycle gates on /api/estimates. The route is
 * a brand-new surface; these tests pin the rules so phase-2 (categorized
 * budget) and phase-3 (spend integration) can build on a stable contract.
 */

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
  const queryMock = jest.fn();
  // pool.connect() returns a client with query()/release() — used by
  // the TX paths. Fall through to the same mock so test setups can drive
  // both modes.
  const fakeClient = {
    query:   (...args) => queryMock(...args),
    release: jest.fn(),
  };
  return {
    query:   queryMock,
    connect: jest.fn().mockResolvedValue(fakeClient),
  };
});

jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool    = require('../db');
const estimatesRoute = require('../routes/estimates');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/estimates', estimatesRoute);
  app.use('/api/public/estimates', estimatesRoute.publicRouter);
  return app;
}

function setUser({ id = 1, company_id = 'co-1', role = 'admin' } = {}) {
  mockCurrentUser = { id, company_id, role, full_name: 'Test Admin' };
}

beforeEach(() => {
  pool.query.mockReset();
  setUser();
});

// ───────────────────────────────────────────────────────────────────────────
// GET /estimates
// ───────────────────────────────────────────────────────────────────────────

describe('GET /api/estimates', () => {
  test('rejects an invalid status filter (must be in the enum)', async () => {
    const res = await request(makeApp()).get('/api/estimates').query({ status: 'bogus' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid status');
  });

  test('paginates with company_id scoping', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })   // COUNT
      .mockResolvedValueOnce({ rows: [] });                // SELECT

    const res = await request(makeApp()).get('/api/estimates').query({ page: 1, limit: 25 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: [], total: 0, page: 1 });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PATCH /estimates/:id — frozen states are 409
// ───────────────────────────────────────────────────────────────────────────

describe('PATCH /api/estimates/:id', () => {
  test('rejects with 404 when the estimate is in a different company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp())
      .patch('/api/estimates/42')
      .send({ project_name: 'X', client_name_snapshot: 'Y' });
    expect(res.status).toBe(404);
  });

  test('rejects with 409 when the estimate is sent (frozen)', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'sent' }] });
    const res = await request(makeApp())
      .patch('/api/estimates/42')
      .send({ project_name: 'X', client_name_snapshot: 'Y' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/frozen/i);
  });

  test('rejects with 400 when project_name missing', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'draft' }] });
    const res = await request(makeApp())
      .patch('/api/estimates/42')
      .send({ client_name_snapshot: 'Y' });   // project_name missing
    expect(res.status).toBe(400);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PUT /estimates/:id/lines — frozen states are 409
// ───────────────────────────────────────────────────────────────────────────

describe('PUT /api/estimates/:id/lines', () => {
  test('rejects when lines is not an array', async () => {
    const res = await request(makeApp())
      .put('/api/estimates/42/lines')
      .send({ lines: 'not-an-array' });
    expect(res.status).toBe(400);
  });

  test('rejects with 400 on an unknown category', async () => {
    const res = await request(makeApp())
      .put('/api/estimates/42/lines')
      .send({ lines: [{ category: 'banana', description: 'd', qty: 1, unit_cost_cents: 100 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid line/i);
  });

  test('rejects with 409 when estimate is frozen', async () => {
    pool.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'accepted' }] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce(undefined); // ROLLBACK
    const res = await request(makeApp())
      .put('/api/estimates/42/lines')
      .send({ lines: [{ category: 'labor', description: 'Demo', qty: 1, unit_cost_cents: 1000 }] });
    expect(res.status).toBe(409);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /estimates/:id/send — only from draft
// ───────────────────────────────────────────────────────────────────────────

describe('POST /api/estimates/:id/send', () => {
  test('rejects with 404 when the estimate is in a different company', async () => {
    pool.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })  // SELECT ... FOR UPDATE
      .mockResolvedValueOnce(undefined); // ROLLBACK
    const res = await request(makeApp()).post('/api/estimates/42/send');
    expect(res.status).toBe(404);
  });

  test('rejects with 409 when not in draft', async () => {
    pool.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, status: 'sent', estimate_number: 'EST-2026-0001' }] })
      .mockResolvedValueOnce(undefined); // ROLLBACK
    const res = await request(makeApp()).post('/api/estimates/42/send');
    expect(res.status).toBe(409);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /estimates/:id/convert — only from accepted, once
// ───────────────────────────────────────────────────────────────────────────

describe('POST /api/estimates/:id/convert', () => {
  test('rejects with 409 when status is not accepted', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        id: 42, status: 'sent', estimate_number: 'EST-2026-0001',
        project_name: 'X', total_cents: 100000, client_id: null, project_address: null,
        converted_project_id: null,
      }] })
      .mockResolvedValueOnce(undefined);
    const res = await request(makeApp()).post('/api/estimates/42/convert');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/accepted/i);
  });

  test('rejects with 409 if already converted', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{
        id: 42, status: 'accepted', estimate_number: 'EST-2026-0001',
        project_name: 'X', total_cents: 100000, client_id: null, project_address: null,
        converted_project_id: 99,
      }] })
      .mockResolvedValueOnce(undefined);
    const res = await request(makeApp()).post('/api/estimates/42/convert');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already converted/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Public accept/decline — token-keyed, no auth
// ───────────────────────────────────────────────────────────────────────────

describe('POST /api/public/estimates/accept/:token', () => {
  test('rejects with 400 if typed_name missing', async () => {
    const res = await request(makeApp())
      .post('/api/public/estimates/accept/sometoken')
      .send({ authorized: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/typed_name/);
  });

  test('rejects with 400 if authorized checkbox not set', async () => {
    const res = await request(makeApp())
      .post('/api/public/estimates/accept/sometoken')
      .send({ typed_name: 'Jane Doe' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/authorization/);
  });

  test('rejects with 404 when no estimate matches the token hash', async () => {
    pool.query
      .mockResolvedValueOnce({})                        // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT ... FOR UPDATE
      .mockResolvedValueOnce({});                       // ROLLBACK
    const res = await request(makeApp())
      .post('/api/public/estimates/accept/bogus-token')
      .send({ typed_name: 'Jane Doe', authorized: true });
    expect(res.status).toBe(404);
  });

  test('rejects with 409 when the estimate is no longer in sent status', async () => {
    pool.query
      .mockResolvedValueOnce({})                        // BEGIN
      .mockResolvedValueOnce({                          // SELECT ... FOR UPDATE
        rowCount: 1,
        rows: [{ id: 42, company_id: 'co-1', status: 'accepted', estimate_number: 'EST-2026-0001', valid_until: null }],
      })
      .mockResolvedValueOnce({});                       // ROLLBACK
    const res = await request(makeApp())
      .post('/api/public/estimates/accept/sometoken')
      .send({ typed_name: 'Jane Doe', authorized: true });
    expect(res.status).toBe(409);
  });

  test('accept records signer name + IP and audits as client actor', async () => {
    pool.query
      .mockResolvedValueOnce({})                        // BEGIN
      .mockResolvedValueOnce({                          // SELECT ... FOR UPDATE
        rowCount: 1,
        rows: [{ id: 42, company_id: 'co-1', status: 'sent', estimate_number: 'EST-2026-0001', valid_until: null }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // UPDATE accepted
      .mockResolvedValueOnce({})                        // COMMIT
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // estimate_audit INSERT

    const res = await request(makeApp())
      .post('/api/public/estimates/accept/sometoken')
      .send({ typed_name: 'Jane Doe', authorized: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Verify the UPDATE captured the typed name
    const updateCall = pool.query.mock.calls.find(c => /UPDATE estimates SET/.test(c[0]) && /accepted_signer_name/.test(c[0]));
    expect(updateCall).toBeDefined();
    expect(updateCall[1][0]).toBe('Jane Doe');
  });
});

describe('POST /api/public/estimates/decline/:token', () => {
  test('rejects with 404 when token does not match', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp())
      .post('/api/public/estimates/decline/sometoken')
      .send({});
    expect(res.status).toBe(404);
  });

  test('rejects with 409 when not in sent', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, status: 'declined' }] });
    const res = await request(makeApp())
      .post('/api/public/estimates/decline/sometoken')
      .send({});
    expect(res.status).toBe(409);
  });
});
