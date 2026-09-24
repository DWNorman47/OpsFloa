/**
 * GET /api/projects (also mounted as /api/work) — the job list every user loads to clock in.
 * Budget / prevailing-rate / QuickBooks mapping columns are only returned to callers who could
 * read them through GET /projects/:id/budget (admin role + a Projects-module permission).
 */

let mockUser;
let mockPerms;
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockUser; next(); },
}));
jest.mock('../permissions', () => ({ hasPerm: jest.fn(async (_req, key) => mockPerms.has(key)) }));
jest.mock('../db', () => ({ query: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const projects = require('../routes/projects');

function makeApp() {
  const app = express();
  app.use((req, _res, next) => { req.log = { error: jest.fn() }; next(); });
  app.use('/api/projects', projects);
  return app;
}

const ROW = {
  id: 3, name: 'Main St', wage_type: 'prevailing', active: true, geo_lat: 1, geo_lng: 2, geo_radius_ft: 300,
  budget_dollars: '50000.00', budget_hours: '400.00', budget_alert_pct: 80,
  prevailing_wage_rate: '52.10', qbo_class_id: 'CL-1', qbo_customer_id: 'CU-9',
};
const MONEY = ['budget_dollars', 'budget_hours', 'budget_alert_pct', 'prevailing_wage_rate', 'qbo_class_id', 'qbo_customer_id'];

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: [ROW] });
  mockPerms = new Set();
});

test('worker gets the job list without financial / accounting fields', async () => {
  mockUser = { id: 7, company_id: 'co-1', role: 'worker' };
  mockPerms = new Set(['view_projects']); // workers normally hold view_projects — still no money
  const res = await request(makeApp()).get('/api/projects');
  expect(res.status).toBe(200);
  expect(res.body[0]).toMatchObject({ id: 3, name: 'Main St', wage_type: 'prevailing', geo_radius_ft: 300 });
  for (const f of MONEY) expect(res.body[0]).not.toHaveProperty(f);
});

test('admin lacking every Projects permission also gets the stripped row', async () => {
  mockUser = { id: 1, company_id: 'co-1', role: 'admin' };
  const res = await request(makeApp()).get('/api/projects');
  for (const f of MONEY) expect(res.body[0]).not.toHaveProperty(f);
});

test('admin with a Projects permission gets the full row', async () => {
  mockUser = { id: 1, company_id: 'co-1', role: 'admin' };
  mockPerms = new Set(['manage_projects']);
  const res = await request(makeApp()).get('/api/projects');
  expect(res.body[0]).toEqual(ROW);
});
