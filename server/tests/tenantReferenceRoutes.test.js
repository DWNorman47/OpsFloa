let mockCurrentUser;

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../push', () => ({
  sendPushToUser: jest.fn(),
  sendPushToCompanyAdmins: jest.fn(),
}));
jest.mock('../r2', () => ({
  uploadBase64: jest.fn(),
  getPresignedUploadUrl: jest.fn(),
  deleteByUrl: jest.fn(),
}));
jest.mock('../storage', () => ({
  checkStorageLimit: jest.fn(),
  incrementStorage: jest.fn(),
  decrementStorage: jest.fn(),
}));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const fieldReports = require('../routes/fieldReports');
const punchlist = require('../routes/punchlist');
const equipment = require('../routes/equipment');

function makeApp(path, route) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: jest.fn() }; next(); });
  app.use(path, route);
  return app;
}

beforeEach(() => {
  pool.query.mockReset();
  pool.connect.mockReset();
  mockCurrentUser = { id: 7, company_id: 'co-1', role: 'worker', full_name: 'Worker' };
});

test('field report creation rejects a project outside the caller company', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
  const res = await request(makeApp('/api/field-reports', fieldReports))
    .post('/api/field-reports')
    .send({ project_id: 88, title: 'Report' });
  expect(res.status).toBe(404);
  expect(res.body.error).toBe('Project not found');
  expect(pool.query).toHaveBeenCalledTimes(1);
});

test('punchlist creation rejects an assignee outside the caller company', async () => {
  pool.query
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 10 }] })
    .mockResolvedValueOnce({ rowCount: 0, rows: [] });
  const res = await request(makeApp('/api/punchlist', punchlist))
    .post('/api/punchlist')
    .send({ project_id: 10, assigned_to: 99, title: 'Fix it' });
  expect(res.status).toBe(404);
  expect(res.body.error).toBe('Assignee not found');
  expect(pool.query).toHaveBeenCalledTimes(2);
});

test('punchlist status update does not require an omitted project_id', async () => {
  const existing = {
    id: 12,
    company_id: 'co-1',
    assigned_to: null,
    project_id: 10,
    status: 'open',
    resolved_at: null,
    updated_at: new Date().toISOString(),
  };
  pool.query
    .mockResolvedValueOnce({ rowCount: 1, rows: [existing] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [] })
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ ...existing, status: 'in_progress' }] });
  const res = await request(makeApp('/api/punchlist', punchlist))
    .patch('/api/punchlist/12')
    .send({ status: 'in_progress' });
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('in_progress');
  expect(pool.query.mock.calls[1][0]).toContain('project_id=$9');
  expect(pool.query.mock.calls[1][1][8]).toBe(10);
});

test('equipment checkout rejects a holder outside the caller company before opening a transaction', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
  const res = await request(makeApp('/api/equipment', equipment))
    .post('/api/equipment/3/checkout')
    .send({ user_id: 99 });
  expect(res.status).toBe(404);
  expect(res.body.error).toBe('User not found');
  expect(pool.connect).not.toHaveBeenCalled();
});
