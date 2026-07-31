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

const express = require('express');
const request = require('supertest');
const pool    = require('../db');
const route   = require('../routes/lienWaivers');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', route);
  app.use('/api/public/lien-waivers', route.publicRouter);
  return app;
}

beforeEach(() => {
  pool.query.mockReset();
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Admin' };
});

describe('GET /api/lien-waivers', () => {
  test('400 on invalid direction', async () => {
    const res = await request(makeApp()).get('/api/lien-waivers').query({ direction: 'sideways' });
    expect(res.status).toBe(400);
  });
  test('400 on invalid status', async () => {
    const res = await request(makeApp()).get('/api/lien-waivers').query({ status: 'banana' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/projects/:projectId/lien-waivers', () => {
  test('400 on invalid direction', async () => {
    const res = await request(makeApp())
      .post('/api/projects/10/lien-waivers')
      .send({ direction: 'sideways', waiver_type: 'conditional_progress', amount_cents: 1000, through_date: '2026-05-01', signer_name: 'Jane', signer_company: 'Co' });
    expect(res.status).toBe(400);
  });

  test('400 on invalid waiver_type', async () => {
    const res = await request(makeApp())
      .post('/api/projects/10/lien-waivers')
      .send({ direction: 'from_us', waiver_type: 'banana', amount_cents: 1000, through_date: '2026-05-01', signer_name: 'Jane', signer_company: 'Co' });
    expect(res.status).toBe(400);
  });

  test('400 on missing through_date', async () => {
    const res = await request(makeApp())
      .post('/api/projects/10/lien-waivers')
      .send({ direction: 'from_us', waiver_type: 'conditional_progress', amount_cents: 1000, signer_name: 'Jane', signer_company: 'Co' });
    expect(res.status).toBe(400);
  });

  test('400 on from_sub without subcontractor_id', async () => {
    const res = await request(makeApp())
      .post('/api/projects/10/lien-waivers')
      .send({ direction: 'from_sub', waiver_type: 'conditional_progress', amount_cents: 1000, through_date: '2026-05-01', signer_name: 'Jane', signer_company: 'Co' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/subcontractor_id/);
  });

  test('404 when project not in caller company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp())
      .post('/api/projects/10/lien-waivers')
      .send({
        direction: 'from_us', waiver_type: 'conditional_progress',
        amount_cents: 1000, through_date: '2026-05-01',
        signer_name: 'Jane', signer_company: 'Co',
      });
    expect(res.status).toBe(404);
  });

  test('400 when a linked PO belongs to another project', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 10, name: 'Project A' }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 22, project_id: 11, subcontractor_id: 7 }],
      });
    const res = await request(makeApp())
      .post('/api/projects/10/lien-waivers')
      .send({
        direction: 'from_sub',
        waiver_type: 'conditional_progress',
        amount_cents: 1000,
        through_date: '2026-07-01',
        signer_name: 'Jane',
        signer_company: 'Co',
        subcontractor_id: 7,
        subcontract_po_id: 22,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid subcontract_po_id');
  });

  test('400 when a linked invoice belongs to another project', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 10, name: 'Project A' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ project_id: 11 }] });
    const res = await request(makeApp())
      .post('/api/projects/10/lien-waivers')
      .send({
        direction: 'from_us',
        waiver_type: 'conditional_progress',
        amount_cents: 1000,
        through_date: '2026-07-01',
        signer_name: 'Jane',
        signer_company: 'Co',
        invoice_id: 55,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid invoice_id');
  });

  test('allows a null-project (from-scratch) invoice to be linked to any project waiver', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 10, name: 'Project A' }] }) // project lookup
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ project_id: null }] })          // invoice: no project
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 99 }] });                   // INSERT RETURNING
    const res = await request(makeApp())
      .post('/api/projects/10/lien-waivers')
      .send({
        direction: 'from_us',
        waiver_type: 'conditional_progress',
        amount_cents: 1000,
        through_date: '2026-07-01',
        signer_name: 'Jane',
        signer_company: 'Co',
        invoice_id: 55,
      });
    expect(res.status).toBe(201);
  });
});

describe('PATCH /api/lien-waivers/:id', () => {
  test('409 when not draft', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, status: 'sent', direction: 'from_us' }] });
    const res = await request(makeApp())
      .patch('/api/lien-waivers/5')
      .send({ amount_cents: 1000 });
    expect(res.status).toBe(409);
  });

  test('400 on an impossible through date instead of surfacing a database error', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 5, status: 'draft', direction: 'from_us' }],
    });
    const res = await request(makeApp())
      .patch('/api/lien-waivers/5')
      .send({ through_date: '2026-02-30' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid YYYY-MM-DD/);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/lien-waivers/:id/send', () => {
  test('409 when not draft', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, status: 'sent' }] });
    const res = await request(makeApp()).post('/api/lien-waivers/5/send');
    expect(res.status).toBe(409);
  });
});

describe('POST /api/lien-waivers/:id/sign-internal', () => {
  test('400 on invalid signature_method', async () => {
    const res = await request(makeApp())
      .post('/api/lien-waivers/5/sign-internal')
      .send({ signature_method: 'fingerprint' });
    expect(res.status).toBe(400);
  });

  test('409 when not direction=from_us', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, status: 'draft', direction: 'from_sub' }] });
    const res = await request(makeApp())
      .post('/api/lien-waivers/5/sign-internal')
      .send({ signature_method: 'typed' });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/lien-waivers/:id/convert-unconditional', () => {
  test('409 when already unconditional', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, waiver_type: 'unconditional_progress' }] });
    const res = await request(makeApp()).post('/api/lien-waivers/5/convert-unconditional');
    expect(res.status).toBe(409);
  });
});

describe('POST /api/public/lien-waivers/sign/:token', () => {
  test('400 on missing typed_name', async () => {
    const res = await request(makeApp())
      .post('/api/public/lien-waivers/sign/tok')
      .send({ signature_method: 'typed' });
    expect(res.status).toBe(400);
  });

  test('400 on invalid signature_method', async () => {
    const res = await request(makeApp())
      .post('/api/public/lien-waivers/sign/tok')
      .send({ typed_name: 'Jane', signature_method: 'fingerprint' });
    expect(res.status).toBe(400);
  });

  test('404 when token does not match', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce(undefined);
    const res = await request(makeApp())
      .post('/api/public/lien-waivers/sign/tok')
      .send({ typed_name: 'Jane', signature_method: 'typed' });
    expect(res.status).toBe(404);
  });
});
