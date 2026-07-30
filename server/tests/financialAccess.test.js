jest.mock('../permissions', () => ({ hasPerm: jest.fn() }));

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { hasPerm } = require('../permissions');
const {
  requireProjectFinancialAccess,
  requireFinancialReportsAccess,
} = require('../middleware/financialAccess');

function makeApp(role = 'admin') {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 7, company_id: 'co-1', role };
    req.log = { error: jest.fn() };
    next();
  });
  app.get('/project', requireProjectFinancialAccess, (_req, res) => res.json({ ok: true }));
  app.get('/reports', requireFinancialReportsAccess, (_req, res) => res.json({ ok: true }));
  return app;
}

beforeEach(() => hasPerm.mockReset());

test('project financials reject workers even though workers normally have view_projects', async () => {
  hasPerm.mockResolvedValue(true);
  const res = await request(makeApp('worker')).get('/project');
  expect(res.status).toBe(403);
  expect(res.body.required_role).toBe('admin');
  expect(hasPerm).not.toHaveBeenCalled();
});

test('project financials allow any permission used by the Projects module', async () => {
  hasPerm
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  const res = await request(makeApp()).get('/project');
  expect(res.status).toBe(200);
  expect(hasPerm.mock.calls.map(call => call[1])).toEqual(['view_projects', 'manage_projects']);
});

test('portfolio reports deny an admin without report-module access', async () => {
  hasPerm.mockResolvedValue(false);
  const res = await request(makeApp()).get('/reports');
  expect(res.status).toBe(403);
  expect(res.body.required_any).toEqual(['view_analytics', 'manage_settings']);
});

test('portfolio reports allow the settings fallback used by the UI', async () => {
  hasPerm
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  const res = await request(makeApp()).get('/reports');
  expect(res.status).toBe(200);
});

test('financial route declarations use the matching access gate', () => {
  const reports = fs.readFileSync(path.join(__dirname, '../routes/projectReports.js'), 'utf8');
  const budget = fs.readFileSync(path.join(__dirname, '../routes/projectBudget.js'), 'utf8');
  const spend = fs.readFileSync(path.join(__dirname, '../routes/projectSpend.js'), 'utf8');

  expect(reports).toContain("router.get('/projects/:id/pnl', requireAuth, requireProjectFinancialAccess");
  expect(reports).toContain("router.get('/projects/pnl-summary', requireAuth, requireFinancialReportsAccess");
  expect(reports).toContain("router.get('/wip-report', requireAuth, requireFinancialReportsAccess");
  expect(reports).toContain("router.get('/wip-report/export', requireAuth, requireFinancialReportsAccess");
  expect(budget).toContain("router.get('/projects/:id/budget', requireAuth, requireProjectFinancialAccess");
  expect(spend).toContain("router.get('/projects/:id/spend', requireAuth, requireProjectFinancialAccess");
  expect(spend).toContain("router.get('/projects/:id/expenses', requireAuth, requireProjectFinancialAccess");
});
