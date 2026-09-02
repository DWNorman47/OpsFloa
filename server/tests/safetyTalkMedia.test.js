/**
 * Safety-talk attachment media lifecycle:
 *  - POST /:id/attachments HEAD-verifies the REAL R2 object size (never the client size_bytes)
 *    and rejects a URL outside this app's own attachment folder.
 *  - DELETE /:id (the whole talk) purges every attachment's R2 object and refunds its bytes
 *    (the rows cascade away, so it must read them first).
 *  - DELETE /:id/attachments/:attId purges the R2 object and refunds bytes.
 */

process.env.R2_PUBLIC_URL = 'https://cdn.example.com';

let mockUser;
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../push', () => ({ sendPushToAllWorkers: jest.fn() }));
jest.mock('../utils/tenantRefs', () => ({ projectBelongsToCompany: jest.fn() }));
jest.mock('../storage', () => ({
  checkStorageLimit: jest.fn(() => Promise.resolve({ allowed: true })),
  incrementStorage: jest.fn(() => Promise.resolve()),
  decrementStorage: jest.fn(() => Promise.resolve()),
}));
jest.mock('../r2', () => ({
  getPresignedUploadUrl: jest.fn(),
  deleteByUrl: jest.fn(() => Promise.resolve()),
  getObjectMetadataByUrl: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const { deleteByUrl, getObjectMetadataByUrl } = require('../r2');
const { incrementStorage, decrementStorage } = require('../storage');
const safetyTalks = require('../routes/safetyTalks');

const OWN = 'https://cdn.example.com/safety-talk-attachments/abc.pdf';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: () => {} }; next(); });
  app.use('/api/safety-talks', safetyTalks);
  return app;
}

beforeEach(() => {
  pool.query.mockReset();
  deleteByUrl.mockClear();
  getObjectMetadataByUrl.mockReset();
  incrementStorage.mockClear();
  decrementStorage.mockClear();
  mockUser = { id: 1, company_id: 'co-1', full_name: 'Admin Amy', role: 'admin' };
});

test('POST attachment counts the REAL object size, ignoring client size_bytes', async () => {
  getObjectMetadataByUrl.mockResolvedValue({ contentLength: 5_000_000 });
  pool.query.mockImplementation(async (sql) => {
    if (/SELECT id FROM safety_talks/.test(sql)) return { rowCount: 1, rows: [{ id: 9 }] };
    if (/INSERT INTO safety_talk_attachments/.test(sql)) return { rows: [{ id: 3, size_bytes: 5_000_000 }] };
    return { rows: [] };
  });

  const res = await request(makeApp())
    .post('/api/safety-talks/9/attachments')
    .send({ name: 'toolbox.pdf', url: OWN, size_bytes: 0 }); // lies: says 0 bytes

  expect(res.status).toBe(201);
  expect(getObjectMetadataByUrl).toHaveBeenCalledWith(OWN);
  expect(incrementStorage).toHaveBeenCalledWith('co-1', 5_000_000); // real size, not the client 0
});

test('POST attachment rejects a URL outside the own attachment folder', async () => {
  const res = await request(makeApp())
    .post('/api/safety-talks/9/attachments')
    .send({ name: 'evil', url: 'https://cdn.example.com/submittal-docs/other-tenant.pdf', size_bytes: 100 });

  expect(res.status).toBe(400);
  expect(pool.query).not.toHaveBeenCalled();
});

test('DELETE talk purges every attachment R2 object and refunds bytes', async () => {
  pool.query.mockImplementation(async (sql) => {
    if (/FROM safety_talk_attachments a\s+JOIN safety_talks t/.test(sql)) {
      return { rows: [{ url: OWN, size_bytes: 2_000_000 }, { url: OWN.replace('abc', 'def'), size_bytes: 1_000_000 }] };
    }
    if (/DELETE FROM safety_talks/.test(sql)) return { rowCount: 1, rows: [{ id: 9 }] };
    if (/SELECT 1 FROM safety_talk_attachments WHERE url/.test(sql)) return { rowCount: 0, rows: [] }; // not referenced elsewhere
    return { rows: [] };
  });

  const res = await request(makeApp()).delete('/api/safety-talks/9');

  expect(res.status).toBe(200);
  expect(deleteByUrl).toHaveBeenCalledTimes(2);
  expect(decrementStorage).toHaveBeenCalledWith('co-1', 3_000_000);
});

test('DELETE single attachment purges R2 and refunds bytes', async () => {
  pool.query.mockImplementation(async (sql) => {
    if (/SELECT id FROM safety_talks/.test(sql)) return { rowCount: 1, rows: [{ id: 9 }] };
    if (/DELETE FROM safety_talk_attachments/.test(sql)) return { rowCount: 1, rows: [{ id: 3, url: OWN, size_bytes: 4_000_000 }] };
    if (/SELECT 1 FROM safety_talk_attachments WHERE url/.test(sql)) return { rowCount: 0, rows: [] }; // not referenced elsewhere
    return { rows: [] };
  });

  const res = await request(makeApp()).delete('/api/safety-talks/9/attachments/3');

  expect(res.status).toBe(200);
  expect(deleteByUrl).toHaveBeenCalledWith(OWN);
  expect(decrementStorage).toHaveBeenCalledWith('co-1', 4_000_000);
});
