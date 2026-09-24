// Completion dates stamped by a closeout transition use the COMPANY-local date, not UTC
// (an evening transition in the US would otherwise record tomorrow's date).
let mockCurrentUser;
jest.mock('../middleware/auth', () => ({
  requireAuth:  (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));
jest.mock('../db', () => {
  const q = jest.fn();
  return { query: q, connect: jest.fn().mockResolvedValue({ query: (...a) => q(...a), release: jest.fn() }) };
});
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/rateHistoryStore', () => ({ companyToday: jest.fn(async () => '2026-09-23') }));

const express = require('express');
const request = require('supertest');
const pool    = require('../db');
const { companyToday } = require('../utils/rateHistoryStore');
const route   = require('../routes/closeout');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: () => {} }; next(); });
  app.use('/api', route);
  return app;
}
beforeEach(() => {
  pool.query.mockReset();
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Admin' };
});

test('substantially_complete stamps the company-local date', async () => {
  pool.query
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, name: 'Test' }] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 99, project_id: 42, status: 'in_progress', substantial_completion_date: null, final_completion_date: null }] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ category: 'final_inspection', status: 'done', auto_source: null }] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 99, status: 'substantially_complete' }] });
  const res = await request(makeApp()).post('/api/projects/42/closeout/transition').send({ to_status: 'substantially_complete' });
  expect(res.status).toBe(200);
  expect(companyToday).toHaveBeenCalledWith('co-1');
  const upd = pool.query.mock.calls.find(c => /UPDATE project_closeouts/.test(c[0]));
  expect(upd[1][1]).toBe('2026-09-23');
});
