/**
 * Route smoke tests for subcontractors + sub POs + payments. The
 * payment auto-transition logic itself is covered by subcontractEnums
 * tests; here we pin the cross-tenant gates, the validation, and the
 * 409 lifecycle blocks.
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
jest.mock('../middleware/commercialAccess', () => ({
  requireCommercialAccess: (req, _res, next) => next(),
}));

jest.mock('../db', () => {
  const queryMock = jest.fn();
  const fakeClient = { query: (...a) => queryMock(...a), release: jest.fn() };
  return { query: queryMock, connect: jest.fn().mockResolvedValue(fakeClient) };
});
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../r2', () => ({
  getPresignedUploadUrl: jest.fn().mockResolvedValue({ uploadUrl: 'https://r2.test/upload', publicUrl: 'https://r2.test/file.pdf' }),
}));

const express = require('express');
const request = require('supertest');
const pool    = require('../db');
const subsRoute = require('../routes/subcontractors');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', subsRoute);
  return app;
}

beforeEach(() => {
  pool.query.mockReset();
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Test Admin' };
});

// ───────────────────────────────────────────────────────────────────────────
// Subs directory
// ───────────────────────────────────────────────────────────────────────────

describe('POST /api/subcontractors', () => {
  test('400 on missing name', async () => {
    const res = await request(makeApp()).post('/api/subcontractors').send({});
    expect(res.status).toBe(400);
  });

  test('201 on valid create; scopes company_id from req.user', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, name: 'Acme Drywall' }] });
    const res = await request(makeApp())
      .post('/api/subcontractors')
      .send({ name: 'Acme Drywall', contact_email: 'a@b.com' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(5);
    const insertCall = pool.query.mock.calls.find(c => /INSERT INTO subcontractors/.test(c[0]));
    expect(insertCall[1][0]).toBe('co-1');  // company_id
    expect(insertCall[1][1]).toBe('Acme Drywall');
  });
});

describe('GET /api/subcontractors/:id', () => {
  test('404 when sub belongs to different company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp()).get('/api/subcontractors/42');
    expect(res.status).toBe(404);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Sub documents — upload URL gates
// ───────────────────────────────────────────────────────────────────────────

describe('GET /api/subcontractors/:id/documents/upload-url', () => {
  test('400 on disallowed content-type', async () => {
    const res = await request(makeApp())
      .get('/api/subcontractors/5/documents/upload-url')
      .query({ filename: 'shady.exe', contentType: 'application/x-msdownload' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('File type not allowed');
  });

  test('404 when sub not in caller company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp())
      .get('/api/subcontractors/5/documents/upload-url')
      .query({ filename: 'coi.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(404);
  });

  test('200 on happy path with a presigned URL', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, name: 'Acme' }] });
    const res = await request(makeApp())
      .get('/api/subcontractors/5/documents/upload-url')
      .query({ filename: 'coi.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(res.body.uploadUrl).toBe('https://r2.test/upload');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Sub PO creation
// ───────────────────────────────────────────────────────────────────────────

describe('POST /api/projects/:projectId/subcontract-pos', () => {
  test('400 on missing subcontractor_id', async () => {
    const res = await request(makeApp())
      .post('/api/projects/10/subcontract-pos')
      .send({ scope_of_work: 'install drywall', amount_cents: 4200000 });
    expect(res.status).toBe(400);
  });

  test('400 on missing scope_of_work', async () => {
    const res = await request(makeApp())
      .post('/api/projects/10/subcontract-pos')
      .send({ subcontractor_id: 5, amount_cents: 4200000 });
    expect(res.status).toBe(400);
  });

  test('400 on out-of-range retainage_pct', async () => {
    const res = await request(makeApp())
      .post('/api/projects/10/subcontract-pos')
      .send({ subcontractor_id: 5, scope_of_work: 'drywall', amount_cents: 4200000, retainage_pct: 150 });
    expect(res.status).toBe(400);
  });

  test('404 when project not in caller company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });  // project lookup
    const res = await request(makeApp())
      .post('/api/projects/10/subcontract-pos')
      .send({ subcontractor_id: 5, scope_of_work: 'drywall', amount_cents: 4200000 });
    expect(res.status).toBe(404);
  });

  test('404 when sub not in caller company', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 10, name: 'Proj' }] })  // project
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });                          // sub
    const res = await request(makeApp())
      .post('/api/projects/10/subcontract-pos')
      .send({ subcontractor_id: 5, scope_of_work: 'drywall', amount_cents: 4200000 });
    expect(res.status).toBe(404);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Sub PO lifecycle: issue / cancel / delete gates
// ───────────────────────────────────────────────────────────────────────────

describe('POST /api/subcontract-pos/:id/issue', () => {
  test('409 when PO already issued', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7, status: 'issued', po_number: 'SP-2026-0001' }] });
    const res = await request(makeApp()).post('/api/subcontract-pos/7/issue');
    expect(res.status).toBe(409);
  });
});

describe('POST /api/subcontract-pos/:id/cancel', () => {
  test('409 when PO already complete', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7, status: 'complete', po_number: 'SP-2026-0001' }] });
    const res = await request(makeApp()).post('/api/subcontract-pos/7/cancel');
    expect(res.status).toBe(409);
  });

  test('409 when PO already cancelled', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7, status: 'cancelled', po_number: 'SP-2026-0001' }] });
    const res = await request(makeApp()).post('/api/subcontract-pos/7/cancel');
    expect(res.status).toBe(409);
  });
});

describe('DELETE /api/subcontract-pos/:id', () => {
  test('409 when PO not in draft', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7, status: 'issued', po_number: 'SP-2026-0001' }] });
    const res = await request(makeApp()).delete('/api/subcontract-pos/7');
    expect(res.status).toBe(409);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Sub PO payments — auto-transition path
// ───────────────────────────────────────────────────────────────────────────

describe('POST /api/subcontract-pos/:id/payments', () => {
  test('400 on missing paid_date', async () => {
    const res = await request(makeApp())
      .post('/api/subcontract-pos/7/payments')
      .send({ amount_cents: 1000 });
    expect(res.status).toBe(400);
  });

  test('400 on negative amount', async () => {
    const res = await request(makeApp())
      .post('/api/subcontract-pos/7/payments')
      .send({ amount_cents: -50, paid_date: '2026-06-01' });
    expect(res.status).toBe(400);
  });

  test('409 when PO is still in draft (must be issued first)', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)                                                                   // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7, status: 'draft', amount_cents: 4200000, po_number: 'SP-2026-0001' }] })
      .mockResolvedValueOnce(undefined);                                                                  // ROLLBACK
    const res = await request(makeApp())
      .post('/api/subcontract-pos/7/payments')
      .send({ amount_cents: 1000, paid_date: '2026-06-01' });
    expect(res.status).toBe(409);
  });

  test('409 when PO is cancelled', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7, status: 'cancelled', amount_cents: 4200000, po_number: 'SP-2026-0001' }] })
      .mockResolvedValueOnce(undefined);
    const res = await request(makeApp())
      .post('/api/subcontract-pos/7/payments')
      .send({ amount_cents: 1000, paid_date: '2026-06-01' });
    expect(res.status).toBe(409);
  });
});
