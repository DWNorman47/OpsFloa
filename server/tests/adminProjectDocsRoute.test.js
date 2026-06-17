/**
 * Cross-company scoping for the project-documents endpoints. The
 * previous implementation accepted any `project_id` in the URL without
 * verifying it belonged to the caller's company — sequential int IDs
 * meant an admin could mint upload URLs and attach document rows
 * against another tenant's projects. Commit aeeb9e9 added
 * assertProjectInCompany() as the gate. These tests pin that gate
 * in place.
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

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToAllWorkers: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../services/qbo', () => ({}));
jest.mock('../routes/inbox', () => ({
  createInboxItem: jest.fn(), createInboxItemBatch: jest.fn(),
}));
jest.mock('@sendgrid/mail', () => ({ setApiKey: jest.fn(), send: jest.fn() }));
jest.mock('../r2', () => ({
  getPresignedUploadUrl: jest.fn().mockResolvedValue({ uploadUrl: 'https://r2.test/upload', publicUrl: 'https://r2.test/file.pdf' }),
}));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const adminRoute = require('../routes/admin');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/admin', adminRoute);
  return app;
}

function setUser({ id = 1, company_id = 'co-1', role = 'admin' } = {}) {
  mockCurrentUser = { id, company_id, role, full_name: 'Test Admin' };
}

// ───────────────────────────────────────────────────────────────────────────
// POST /admin/projects/:id/documents
// ───────────────────────────────────────────────────────────────────────────

describe('POST /admin/projects/:id/documents — cross-company scope', () => {
  beforeEach(() => {
    pool.query.mockReset();
    setUser();
  });

  test('rejects with 404 when project belongs to a different company', async () => {
    // assertProjectInCompany SELECT returns no rows — the project_id
    // exists but isn't in the caller's company.
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(makeApp())
      .post('/api/admin/projects/42/documents')
      .send({ name: 'spec.pdf', url: 'https://r2.test/spec.pdf', size_bytes: 1024 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Project not found');
    // INSERT must NOT have run
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  test('inserts when project belongs to caller', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ 1: 1 }] })  // assertProjectInCompany hit
      .mockResolvedValueOnce({ rows: [{ id: 7, name: 'spec.pdf', url: 'https://r2.test/spec.pdf' }] }); // INSERT RETURNING

    const res = await request(makeApp())
      .post('/api/admin/projects/42/documents')
      .send({ name: 'spec.pdf', url: 'https://r2.test/spec.pdf', size_bytes: 1024 });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(7);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  test('rejects with 400 when name or url missing', async () => {
    const res = await request(makeApp())
      .post('/api/admin/projects/42/documents')
      .send({ name: 'spec.pdf' });

    expect(res.status).toBe(400);
    // Validation runs BEFORE the project-scope SELECT
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /admin/projects/:id/documents/upload-url
// ───────────────────────────────────────────────────────────────────────────

describe('GET /admin/projects/:id/documents/upload-url — cross-company scope', () => {
  beforeEach(() => {
    pool.query.mockReset();
    setUser();
  });

  test('rejects with 404 when project belongs to a different company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const res = await request(makeApp())
      .get('/api/admin/projects/42/documents/upload-url')
      .query({ filename: 'spec.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Project not found');
  });

  test('mints an upload URL when project belongs to caller', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ 1: 1 }] });

    const res = await request(makeApp())
      .get('/api/admin/projects/42/documents/upload-url')
      .query({ filename: 'spec.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);
    expect(res.body.uploadUrl).toBe('https://r2.test/upload');
    expect(res.body.publicUrl).toBe('https://r2.test/file.pdf');
  });

  test('rejects with 400 on disallowed content-type', async () => {
    const res = await request(makeApp())
      .get('/api/admin/projects/42/documents/upload-url')
      .query({ filename: 'evil.exe', contentType: 'application/x-msdownload' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('File type not allowed');
    // Type check runs BEFORE the project SELECT
    expect(pool.query).not.toHaveBeenCalled();
  });
});
