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
jest.mock('../r2', () => ({
  getPresignedUploadUrl: jest.fn().mockResolvedValue({ uploadUrl: 'https://r2.test/upload', publicUrl: 'https://r2.test/file.pdf' }),
}));

const express = require('express');
const request = require('supertest');
const pool    = require('../db');
const route   = require('../routes/submittals');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', route);
  return app;
}

beforeEach(() => {
  pool.query.mockReset();
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Admin' };
});

describe('GET /api/submittals', () => {
  test('400 on unknown status', async () => {
    const res = await request(makeApp()).get('/api/submittals').query({ status: 'banana' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/projects/:projectId/submittals', () => {
  test('400 on missing title', async () => {
    const res = await request(makeApp())
      .post('/api/projects/10/submittals')
      .send({ submittal_number: 'SUB-A-001' });
    expect(res.status).toBe(400);
  });
  test('400 on missing submittal_number', async () => {
    const res = await request(makeApp())
      .post('/api/projects/10/submittals')
      .send({ title: 'Insulation' });
    expect(res.status).toBe(400);
  });
  test('404 when project not in caller company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp())
      .post('/api/projects/10/submittals')
      .send({ title: 'Insulation', submittal_number: 'SUB-A-001' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/submittals/:id/send-internal', () => {
  test('409 if not in draft', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7, status: 'sent_to_reviewer', submittal_number: 'SUB-A-001' }] });
    const res = await request(makeApp()).post('/api/submittals/7/send-internal');
    expect(res.status).toBe(409);
  });
});

describe('POST /api/submittals/:id/send-reviewer', () => {
  test('409 if not in pending_internal', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7, status: 'draft', submittal_number: 'SUB-A-001' }] });
    const res = await request(makeApp()).post('/api/submittals/7/send-reviewer');
    expect(res.status).toBe(409);
  });
});

describe('POST /api/submittals/:id/stamp', () => {
  test('400 on invalid stamp', async () => {
    const res = await request(makeApp())
      .post('/api/submittals/7/stamp')
      .send({ stamp: 'great_job' });
    expect(res.status).toBe(400);
  });

  test('409 when not in sent_to_reviewer', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7, status: 'draft', submittal_number: 'SUB-A-001' }] });
    const res = await request(makeApp())
      .post('/api/submittals/7/stamp')
      .send({ stamp: 'approved' });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/submittals/:id/revise', () => {
  test('409 when not in revise_resubmit/rejected', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7, status: 'approved', submittal_number: 'SUB-A-001' }] })
      .mockResolvedValueOnce(undefined);
    const res = await request(makeApp()).post('/api/submittals/7/revise');
    expect(res.status).toBe(409);
  });
});

describe('GET /api/submittals/:id/documents/upload-url', () => {
  test('400 on disallowed content-type', async () => {
    const res = await request(makeApp())
      .get('/api/submittals/7/documents/upload-url')
      .query({ filename: 'shady.exe', contentType: 'application/x-msdownload' });
    expect(res.status).toBe(400);
  });

  test('404 when submittal not in caller company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp())
      .get('/api/submittals/7/documents/upload-url')
      .query({ filename: 'spec.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/submittals/:id/documents', () => {
  test('400 on invalid kind', async () => {
    const res = await request(makeApp())
      .post('/api/submittals/7/documents')
      .send({ kind: 'banana', name: 'spec.pdf', url: 'https://r2.test/spec.pdf' });
    expect(res.status).toBe(400);
  });
});
