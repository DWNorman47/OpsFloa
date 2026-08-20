/**
 * Field-report idempotency: a POST carrying a client_request_id that already produced a report
 * (an offline-queued replay) returns the EXISTING report — it must not INSERT a second one or
 * re-upload photos / double-count storage.
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
jest.mock('../r2', () => ({ uploadBase64: jest.fn(), getPresignedUploadUrl: jest.fn(), deleteByUrl: jest.fn(), getObjectMetadataByUrl: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const fieldReports = require('../routes/fieldReports');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: () => {} }; next(); });
  app.use('/api/field-reports', fieldReports);
  return app;
}

beforeEach(() => {
  pool.query.mockReset();
  mockUser = { id: 1, company_id: 'co-1', full_name: 'Field Bob', role: 'worker' };
});

test('replayed client_request_id returns the existing report, no second INSERT', async () => {
  const EXISTING = { id: 42, company_id: 'co-1', title: 'Framing', photos: [] };
  pool.query.mockImplementation(async (sql) => {
    if (/SELECT 1 FROM projects/.test(sql)) return { rowCount: 1, rows: [{ '?column?': 1 }] };            // project belongs
    if (/SELECT id FROM field_reports WHERE company_id = \$1 AND client_request_id/.test(sql)) return { rowCount: 1, rows: [{ id: 42 }] }; // dedup hit
    if (/FROM field_reports r\s+JOIN users u/.test(sql)) return { rows: [EXISTING] };                      // loadFullReport
    if (/INSERT INTO field_reports/.test(sql)) throw new Error('should not INSERT on a dedup replay');
    return { rows: [] };
  });

  const res = await request(makeApp())
    .post('/api/field-reports')
    .send({ project_id: 7, notes: 'Framing', report_date: '2026-08-20', client_request_id: 'req-abc' });

  expect(res.status).toBe(200);
  expect(res.body.id).toBe(42);
  // The INSERT branch throws if reached — reaching here proves it didn't run.
  expect(pool.query.mock.calls.some(c => /INSERT INTO field_reports/.test(c[0]))).toBe(false);
});
