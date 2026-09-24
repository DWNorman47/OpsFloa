// Items: create persists status (draft|submitted); a worker can't overwrite/delete a
// reviewed report; PATCH's updated_at conflict check is atomic (in the UPDATE WHERE).
let mockCurrentUser;

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const dailyReports = require('../routes/dailyReports');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: jest.fn() }; next(); });
  app.use('/api/daily-reports', dailyReports);
  return app;
}

function fullReportReads() {
  pool.query
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5 }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });
}

beforeEach(() => {
  pool.query.mockReset();
  pool.connect.mockReset();
  mockCurrentUser = { id: 7, company_id: 'co-1', role: 'worker' };
});

function postClient(dupeRows = []) {
  return {
    query: jest.fn(async (sql) => {
      if (/INSERT INTO daily_reports/.test(sql)) return { rowCount: 1, rows: [{ id: 5 }] };
      if (/SELECT .* FROM daily_reports/s.test(sql)) return { rowCount: dupeRows.length, rows: dupeRows };
      if (/FROM projects/.test(sql)) return { rowCount: 1, rows: [{ ok: 1 }] };
      return { rowCount: 0, rows: [] };
    }),
    release: jest.fn(),
  };
}

test('POST writes the submitted status from the body', async () => {
  const client = postClient();
  pool.connect.mockResolvedValueOnce(client);
  fullReportReads();
  const res = await request(makeApp()).post('/api/daily-reports')
    .send({ project_id: 200, report_date: '2026-07-30', status: 'submitted' });
  expect(res.status).toBe(201);
  const call = client.query.mock.calls.find(c => /INSERT INTO daily_reports/.test(c[0]));
  expect(call[0]).toMatch(/status/);
  expect(call[1]).toContain('submitted');
});

test('POST defaults status to draft and rejects reviewed from the body', async () => {
  const client = postClient();
  pool.connect.mockResolvedValueOnce(client);
  fullReportReads();
  const res = await request(makeApp()).post('/api/daily-reports')
    .send({ project_id: 200, report_date: '2026-07-30' });
  expect(res.status).toBe(201);
  const call = client.query.mock.calls.find(c => /INSERT INTO daily_reports/.test(c[0]));
  expect(call[1]).toContain('draft');

  const res2 = await request(makeApp()).post('/api/daily-reports')
    .send({ project_id: 200, report_date: '2026-07-30', status: 'reviewed' });
  expect(res2.status).toBe(400);
});

test('POST upsert refuses to overwrite a reviewed report for non-admins (atomic WHERE)', async () => {
  const client = postClient([{ created_by: 7, status: 'reviewed' }]);
  pool.connect.mockResolvedValueOnce(client);
  const res = await request(makeApp()).post('/api/daily-reports')
    .send({ project_id: 200, report_date: '2026-07-30', status: 'submitted' });
  expect(res.status).toBe(403);
  expect(client.query.mock.calls.some(c => /INSERT INTO daily_reports/.test(c[0]))).toBe(false);
});

test('POST upsert WHERE guards reviewed status', async () => {
  const client = postClient();
  pool.connect.mockResolvedValueOnce(client);
  fullReportReads();
  await request(makeApp()).post('/api/daily-reports')
    .send({ project_id: 200, report_date: '2026-07-30', status: 'submitted' });
  const sql = client.query.mock.calls.find(c => /INSERT INTO daily_reports/.test(c[0]))[0];
  expect(sql).toMatch(/daily_reports\.status <> 'reviewed' OR \$11 = true/);
});

test('DELETE blocks a non-admin from deleting a reviewed report', async () => {
  pool.query
    .mockResolvedValueOnce({ rowCount: 0, rows: [] })                        // guarded DELETE
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: 'reviewed' }] }); // probe
  const res = await request(makeApp()).delete('/api/daily-reports/5');
  expect(res.status).toBe(403);
  expect(pool.query.mock.calls[0][0]).toMatch(/status <> 'reviewed'/);
});

test('DELETE by admin is not status-gated', async () => {
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin' };
  pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5 }] });
  const res = await request(makeApp()).delete('/api/daily-reports/5');
  expect(res.status).toBe(200);
  expect(pool.query.mock.calls[0][0]).not.toMatch(/reviewed/);
});

test('PATCH updated_at conflict is checked inside the UPDATE WHERE → 409 when 0 rows', async () => {
  const client = {
    query: jest.fn()
      .mockResolvedValueOnce({})                                                         // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, created_by: 7, status: 'draft', updated_at: '2026-07-30T00:00:00.000Z' }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })                                  // UPDATE lost the race
      .mockResolvedValueOnce({}),                                                        // ROLLBACK
    release: jest.fn(),
  };
  pool.connect.mockResolvedValueOnce(client);
  const res = await request(makeApp()).patch('/api/daily-reports/5')
    .send({ work_performed: 'x', updated_at: '2026-07-30T00:00:00.000Z' });
  expect(res.status).toBe(409);
  const upd = client.query.mock.calls.find(c => /UPDATE daily_reports/.test(c[0]));
  expect(upd[0]).toMatch(/updated_at/);
  expect(upd[0]).toMatch(/date_trunc\('milliseconds', updated_at\)/);
  expect(client.query.mock.calls.map(c => c[0])).toContain('ROLLBACK');
});
