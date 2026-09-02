/**
 * GET /field-reports/photos/:photoId/download — proxies one image/video back as an
 * attachment. Auth is scoped exactly like viewing (a worker gets only their own
 * reports' media; an admin gets any in the company), the stored URL must be on our
 * own R2 bucket, and the object is streamed (not buffered) with a download filename.
 */

let mockUser;
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../push', () => ({ sendPushToCompanyAdmins: jest.fn() }));
jest.mock('../storage', () => ({ checkStorageLimit: jest.fn(), incrementStorage: jest.fn(), decrementStorage: jest.fn() }));
jest.mock('../r2', () => ({
  uploadBase64: jest.fn(), getPresignedUploadUrl: jest.fn(), deleteByUrl: jest.fn(),
  getObjectMetadataByUrl: jest.fn(), getObjectStreamByUrl: jest.fn(),
}));

const { Readable } = require('stream');
const express = require('express');
const request = require('supertest');
const pool = require('../db');
const r2 = require('../r2');
const fieldReports = require('../routes/fieldReports');

const BASE = 'https://cdn.example.test';

function makeApp() {
  const app = express();
  app.use((req, _res, next) => { req.log = { error: () => {} }; next(); });
  app.use('/api/field-reports', fieldReports);
  return app;
}

beforeAll(() => { process.env.R2_PUBLIC_URL = BASE; });
beforeEach(() => {
  pool.query.mockReset();
  r2.getObjectStreamByUrl.mockReset();
  mockUser = { id: 1, company_id: 'co-1', role: 'worker' };
});

test('worker downloads their own photo as an attachment (scoped to user_id)', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ url: `${BASE}/photos/abc.jpg`, media_type: 'photo' }] });
  r2.getObjectStreamByUrl.mockResolvedValueOnce({ body: Readable.from([Buffer.from('JPEGDATA')]), contentType: 'image/jpeg', contentLength: 8 });

  const res = await request(makeApp()).get('/api/field-reports/photos/55/download');

  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe('image/jpeg');
  expect(res.headers['content-disposition']).toMatch(/attachment; filename="field-photo-55\.jpg"/);
  expect(r2.getObjectStreamByUrl).toHaveBeenCalledWith(`${BASE}/photos/abc.jpg`);
  // Non-admin query must carry the ownership condition.
  expect(pool.query.mock.calls[0][0]).toMatch(/r\.user_id = \$3/);
});

test('non-admin gets 404 for a photo that is not theirs — never touches R2', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // scoped query finds nothing
  const res = await request(makeApp()).get('/api/field-reports/photos/999/download');
  expect(res.status).toBe(404);
  expect(r2.getObjectStreamByUrl).not.toHaveBeenCalled();
});

test('admin download is company-scoped but not user-scoped, and streams videos too', async () => {
  mockUser = { id: 2, company_id: 'co-1', role: 'admin' };
  pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ url: `${BASE}/videos/clip.mp4`, media_type: 'video' }] });
  r2.getObjectStreamByUrl.mockResolvedValueOnce({ body: Readable.from([Buffer.from('MP4')]), contentType: 'video/mp4', contentLength: 3 });

  const res = await request(makeApp()).get('/api/field-reports/photos/7/download');

  expect(res.status).toBe(200);
  expect(res.headers['content-disposition']).toMatch(/attachment; filename="field-photo-7\.mp4"/);
  expect(pool.query.mock.calls[0][0]).not.toMatch(/user_id/);
});

test('rejects a stored URL that is not on our bucket (SSRF defense-in-depth)', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ url: 'https://evil.example/photos/x.jpg', media_type: 'photo' }] });
  const res = await request(makeApp()).get('/api/field-reports/photos/8/download');
  expect(res.status).toBe(400);
  expect(r2.getObjectStreamByUrl).not.toHaveBeenCalled();
});
