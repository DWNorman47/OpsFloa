/**
 * GET /daily-reports/suggest — manpower auto-fill from time entries.
 * Admins see every co-worker's hours. A worker (any worker may write a daily report) only sees
 * the crew's hours for a project they themselves logged time on that day; otherwise just their
 * own hours — never a company-wide "who worked how long" listing.
 */

let mockUser;
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const dailyReports = require('../routes/dailyReports');

function makeApp() {
  const app = express();
  app.use((req, _res, next) => { req.log = { error: () => {} }; next(); });
  app.use('/api/daily-reports', dailyReports);
  return app;
}

function mockDb({ onCrew }) {
  pool.query.mockImplementation(async (sql) => {
    if (/SELECT 1 FROM time_entries/.test(sql)) return { rowCount: onCrew ? 1 : 0, rows: onCrew ? [{}] : [] };
    if (/SUM\(EXTRACT/.test(sql)) return { rowCount: 1, rows: [{ full_name: 'X', total_hours: 8 }] };
    return { rowCount: 0, rows: [] };
  });
}
const suggestCall = () => pool.query.mock.calls.find(c => /SUM\(EXTRACT/.test(c[0]));

beforeEach(() => {
  pool.query.mockReset();
  mockUser = { id: 7, company_id: 'co-1', role: 'worker' };
});

test('admin: company-wide, no user filter', async () => {
  mockUser = { id: 1, company_id: 'co-1', role: 'admin' };
  mockDb({ onCrew: false });
  const res = await request(makeApp()).get('/api/daily-reports/suggest').query({ report_date: '2026-09-20' });
  expect(res.status).toBe(200);
  expect(suggestCall()[0]).not.toMatch(/te\.user_id = \$/);
  expect(suggestCall()[1]).toEqual(['co-1', '2026-09-20']);
});

test('worker without a project only gets their own hours', async () => {
  mockDb({ onCrew: false });
  await request(makeApp()).get('/api/daily-reports/suggest').query({ report_date: '2026-09-20' });
  expect(suggestCall()[0]).toMatch(/te\.user_id = \$3/);
  expect(suggestCall()[1]).toEqual(['co-1', '2026-09-20', 7]);
});

test('worker who was on the project that day gets the crew hours', async () => {
  mockDb({ onCrew: true });
  await request(makeApp()).get('/api/daily-reports/suggest').query({ report_date: '2026-09-20', project_id: '3' });
  expect(suggestCall()[0]).not.toMatch(/te\.user_id = \$/);
  expect(suggestCall()[1]).toEqual(['co-1', '2026-09-20', '3']);
});

test('worker asking about a project they were not on gets only their own row', async () => {
  mockDb({ onCrew: false });
  await request(makeApp()).get('/api/daily-reports/suggest').query({ report_date: '2026-09-20', project_id: '3' });
  expect(suggestCall()[0]).toMatch(/te\.user_id = \$4/);
  expect(suggestCall()[1]).toEqual(['co-1', '2026-09-20', '3', 7]);
});

test('invalid report_date → 400', async () => {
  const res = await request(makeApp()).get('/api/daily-reports/suggest').query({ report_date: 'yesterday' });
  expect(res.status).toBe(400);
});
