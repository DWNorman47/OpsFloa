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

beforeEach(() => {
  pool.query.mockReset();
  pool.connect.mockReset();
  mockCurrentUser = { id: 7, company_id: 'co-1', role: 'worker' };
});

test('rolls back before releasing the client when an update target is missing', async () => {
  const client = {
    query: jest.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({}),
    release: jest.fn(),
  };
  pool.connect.mockResolvedValueOnce(client);

  const res = await request(makeApp())
    .patch('/api/daily-reports/999')
    .send({ work_performed: 'nothing' });

  expect(res.status).toBe(404);
  expect(client.query.mock.calls.map(call => call[0])).toEqual([
    'BEGIN',
    'SELECT * FROM daily_reports WHERE id=$1 AND company_id=$2',
    'ROLLBACK',
  ]);
  expect(client.release).toHaveBeenCalledTimes(1);
});

test('POST refuses to overwrite a coworker\'s existing report for the same project+date', async () => {
  // Worker 7 posts for a project+date already owned by worker 99 — the upsert would
  // silently clobber it, so the ownership guard must 403 before any INSERT.
  const client = {
    query: jest.fn()
      .mockResolvedValueOnce({})                                          // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ ok: 1 }] })          // projectBelongsToCompany
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ created_by: 99 }] }) // dupe owned by someone else
      .mockResolvedValueOnce({}),                                         // ROLLBACK
    release: jest.fn(),
  };
  pool.connect.mockResolvedValueOnce(client);

  const res = await request(makeApp())
    .post('/api/daily-reports')
    .send({ project_id: 200, report_date: '2026-07-30' });

  expect(res.status).toBe(403);
  const stmts = client.query.mock.calls.map(c => c[0]);
  expect(stmts).toContain('ROLLBACK');
  expect(stmts.some(s => /INSERT INTO daily_reports/.test(s))).toBe(false);
  expect(client.release).toHaveBeenCalledTimes(1);
});

test('PATCH without sub-table arrays leaves manpower/equipment/materials untouched', async () => {
  // A status-only PATCH must not DELETE the report's sub-tables (the old code deleted
  // unconditionally, wiping them whenever the arrays were omitted).
  mockCurrentUser = { id: 7, company_id: 'co-1', role: 'admin' };
  const client = {
    query: jest.fn()
      .mockResolvedValueOnce({})                                                             // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, created_by: 7, updated_at: '2026-07-30T00:00:00Z' }] }) // SELECT existing
      .mockResolvedValueOnce({})                                                             // UPDATE daily_reports
      .mockResolvedValueOnce({}),                                                            // COMMIT
    release: jest.fn(),
  };
  pool.connect.mockResolvedValueOnce(client);
  // getFullReport reads back via the pool (report + 3 sub-tables).
  pool.query
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5 }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });

  const res = await request(makeApp())
    .patch('/api/daily-reports/5')
    .send({ status: 'reviewed' });

  expect(res.status).toBe(200);
  const stmts = client.query.mock.calls.map(c => c[0]);
  expect(stmts.some(s => /DELETE FROM daily_report_manpower/.test(s))).toBe(false);
  expect(stmts.some(s => /DELETE FROM daily_report_equipment/.test(s))).toBe(false);
  expect(stmts.some(s => /DELETE FROM daily_report_materials/.test(s))).toBe(false);
});
