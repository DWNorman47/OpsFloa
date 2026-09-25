// Incident reports are safety/OSHA records admins were already notified about — a worker
// must not be able to delete one (even their own). Only admins may delete.
let mockUser;
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToCompanyAdmins: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../routes/inbox', () => ({ createInboxItem: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const incidents = require('../routes/incidents');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: () => {} }; next(); });
  app.use('/api/incidents', incidents);
  return app;
}
beforeEach(() => { pool.query.mockReset(); });

test('worker cannot delete their own open incident', async () => {
  mockUser = { id: 7, company_id: 'co-1', role: 'worker' };
  pool.query.mockResolvedValue({ rowCount: 1, rows: [{ id: 3, user_id: 7, status: 'open' }] });
  const res = await request(makeApp()).delete('/api/incidents/3');
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('incident_delete_admin_only');
  expect(pool.query.mock.calls.some(c => /DELETE FROM incident_reports/.test(c[0]))).toBe(false);
});

test('admin can delete', async () => {
  mockUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'A' };
  pool.query
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 3, user_id: 7, status: 'open' }] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [] });
  const res = await request(makeApp()).delete('/api/incidents/3');
  expect(res.status).toBe(200);
  expect(pool.query.mock.calls.some(c => /DELETE FROM incident_reports/.test(c[0]))).toBe(true);
});
