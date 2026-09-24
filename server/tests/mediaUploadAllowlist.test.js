/**
 * Presigned uploads land on the PUBLIC R2 origin with the Content-Type we sign, so:
 *  - field-report /upload-url and safety-talk /attachment-upload-url only accept allow-listed
 *    types (no text/html, image/svg+xml …) and put a company segment in NEW keys;
 *  - inline base64 field-report media must be an image/video data URL;
 *  - the "is this our media url" checks parse the key strictly (no '..' / '%2e%2e' escapes)
 *    and tie company-scoped keys to the caller's company, while legacy flat keys stay valid.
 */

process.env.R2_PUBLIC_URL = 'https://cdn.example.com';
const BASE = process.env.R2_PUBLIC_URL;

let mockUser;
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../push', () => ({ sendPushToCompanyAdmins: jest.fn(), sendPushToAllWorkers: jest.fn() }));
jest.mock('../storage', () => ({
  checkStorageLimit: jest.fn(async () => ({ allowed: true })),
  incrementStorage: jest.fn(async () => {}),
  decrementStorage: jest.fn(async () => {}),
}));
jest.mock('../r2', () => ({
  uploadBase64: jest.fn(async (_d, folder) => ({ url: `${process.env.R2_PUBLIC_URL}/${folder}/new.jpg`, sizeBytes: 10 })),
  getPresignedUploadUrl: jest.fn(async (folder, ext) => ({ uploadUrl: 'https://r2.test/put', publicUrl: `${process.env.R2_PUBLIC_URL}/${folder}/u.${ext}`, key: `${folder}/u.${ext}` })),
  deleteByUrl: jest.fn(async () => {}),
  getObjectMetadataByUrl: jest.fn(async () => ({ contentLength: 100 })),
  getObjectStreamByUrl: jest.fn(),
  safeKeyFromPublicUrl: jest.requireActual('../r2').safeKeyFromPublicUrl,
  keyBelongsTo: jest.requireActual('../r2').keyBelongsTo,
}));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const r2 = require('../r2');
const fieldReports = require('../routes/fieldReports');
const safetyTalks = require('../routes/safetyTalks');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, _res, next) => { req.log = { error: () => {} }; next(); });
  app.use('/api/field-reports', fieldReports);
  app.use('/api/safety-talks', safetyTalks);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
  mockUser = { id: 7, company_id: 'co-1', full_name: 'Worker Seven', role: 'worker' };
});

describe('GET /field-reports/upload-url', () => {
  test.each(['text/html', 'image/svg+xml', 'application/xhtml+xml', 'application/javascript'])(
    'rejects %s', async (contentType) => {
      const res = await request(makeApp()).get('/api/field-reports/upload-url').query({ contentType });
      expect(res.status).toBe(400);
      expect(r2.getPresignedUploadUrl).not.toHaveBeenCalled();
    });

  test('accepts a video type and keys it under videos/<company>/', async () => {
    const res = await request(makeApp()).get('/api/field-reports/upload-url').query({ contentType: 'video/quicktime' });
    expect(res.status).toBe(200);
    expect(r2.getPresignedUploadUrl).toHaveBeenCalledWith('videos/co-1', 'mov', 'video/quicktime');
  });
});

describe('POST /field-reports media urls', () => {
  const post = (photos) => request(makeApp()).post('/api/field-reports').send({ photos, notes: 'x' });
  function mockCreate() {
    pool.query.mockImplementation(async (sql) => {
      if (/INSERT INTO field_reports/.test(sql)) return { rowCount: 1, rows: [{ id: 40 }] };
      if (/INSERT INTO field_report_photos/.test(sql)) return { rowCount: 1, rows: [{ id: 1 }] };
      if (/FROM field_reports r/.test(sql)) return { rowCount: 1, rows: [{ id: 40, photos: [] }] };
      return { rowCount: 0, rows: [] };
    });
  }
  const photoInserts = () => pool.query.mock.calls.filter(c => /INSERT INTO field_report_photos/.test(c[0]));

  test('inline base64 HTML is refused before anything is stored', async () => {
    mockCreate();
    const res = await post([{ url: 'data:text/html;base64,PHNjcmlwdD4=' }]);
    expect(res.status).toBe(400);
    expect(r2.uploadBase64).not.toHaveBeenCalled();
    expect(pool.query.mock.calls.some(c => /INSERT INTO field_reports/.test(c[0]))).toBe(false);
  });

  test('inline base64 image uploads under photos/<company>/', async () => {
    mockCreate();
    const res = await post([{ url: 'data:image/jpeg;base64,/9j/AAAA' }]);
    expect(res.status).toBe(201);
    expect(r2.uploadBase64).toHaveBeenCalledWith('data:image/jpeg;base64,/9j/AAAA', 'photos/co-1');
  });

  test.each([
    `${BASE}/photos/../subs/co-2/5/coi.pdf`,
    `${BASE}/photos/%2e%2e/subs/co-2/coi.pdf`,
    `${BASE}/videos/co-2/abc.mp4`, // another company's scoped key
    `${BASE}/subs/co-1/5/coi.pdf`,
    'https://evil.example.com/photos/a.jpg',
  ])('rejects a pass-through url that is not our own media: %s', async (url) => {
    mockCreate();
    const res = await post([{ url }]);
    expect(res.status).toBe(500); // existing contract: the report is rolled back
    expect(photoInserts()).toHaveLength(0);
    expect(pool.query.mock.calls.some(c => /DELETE FROM field_reports WHERE id/.test(c[0]))).toBe(true);
  });

  test.each([`${BASE}/videos/co-1/abc.mp4`, `${BASE}/videos/legacy.mp4`])('accepts own / legacy media url %s', async (url) => {
    mockCreate();
    const res = await post([{ url, media_type: 'video' }]);
    expect(res.status).toBe(201);
    expect(photoInserts()).toHaveLength(1);
  });
});

describe('safety-talk attachments', () => {
  beforeEach(() => { mockUser = { id: 1, company_id: 'co-1', full_name: 'Admin Amy', role: 'admin' }; });

  test.each(['text/html', 'image/svg+xml', 'application/x-msdownload'])('upload-url rejects %s', async (type) => {
    const res = await request(makeApp()).get('/api/safety-talks/attachment-upload-url').query({ ext: 'html', type });
    expect(res.status).toBe(400);
    expect(r2.getPresignedUploadUrl).not.toHaveBeenCalled();
  });

  test('upload-url accepts a PDF, sanitizes ext and keys it under the company', async () => {
    const res = await request(makeApp()).get('/api/safety-talks/attachment-upload-url').query({ ext: 'p/d..f', type: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(r2.getPresignedUploadUrl).toHaveBeenCalledWith('safety-talk-attachments/co-1', 'pdf', 'application/pdf');
  });

  test.each([
    `${BASE}/safety-talk-attachments/../takeoffs/co-2/plan.pdf`,
    `${BASE}/safety-talk-attachments/%2e%2e/takeoffs/plan.pdf`,
    `${BASE}/safety-talk-attachments/co-2/x.pdf`,
  ])('POST attachment rejects %s', async (url) => {
    const res = await request(makeApp()).post('/api/safety-talks/9/attachments').send({ name: 'x.pdf', url });
    expect(res.status).toBe(400);
  });

  test('POST attachment accepts the caller company key', async () => {
    pool.query.mockImplementation(async (sql) => {
      if (/SELECT id FROM safety_talks/.test(sql)) return { rowCount: 1, rows: [{ id: 9 }] };
      if (/INSERT INTO safety_talk_attachments/.test(sql)) return { rowCount: 1, rows: [{ id: 3 }] };
      return { rowCount: 0, rows: [] };
    });
    const res = await request(makeApp()).post('/api/safety-talks/9/attachments')
      .send({ name: 'x.pdf', url: `${BASE}/safety-talk-attachments/co-1/x.pdf` });
    expect(res.status).toBe(201);
  });
});
