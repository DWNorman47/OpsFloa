jest.mock('../permissions', () => ({ hasPerm: jest.fn() }));

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { hasPerm } = require('../permissions');
const { requireCommercialAccess } = require('../middleware/commercialAccess');

function makeApp(role = 'admin') {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 7, company_id: 'co-1', role };
    req.log = { error: jest.fn() };
    next();
  });
  app.get('/sales', requireCommercialAccess, (_req, res) => res.json({ ok: true }));
  return app;
}

beforeEach(() => hasPerm.mockReset());

test('denies an admin without either sales-tab permission', async () => {
  hasPerm.mockResolvedValue(false);
  const res = await request(makeApp()).get('/sales');
  expect(res.status).toBe(403);
  expect(res.body.required_any).toEqual(['manage_projects', 'manage_settings']);
  expect(hasPerm.mock.calls.map(call => call[1])).toEqual(['manage_projects', 'manage_settings']);
});

test('denies a worker even when a custom role grants a commercial permission', async () => {
  hasPerm.mockResolvedValue(true);
  const res = await request(makeApp('worker')).get('/sales');
  expect(res.status).toBe(403);
  expect(res.body.required_role).toBe('admin');
  expect(hasPerm).not.toHaveBeenCalled();
});

test('allows manage_projects without evaluating the fallback permission', async () => {
  hasPerm.mockResolvedValueOnce(true);
  const res = await request(makeApp()).get('/sales');
  expect(res.status).toBe(200);
  expect(hasPerm).toHaveBeenCalledTimes(1);
});

test('allows manage_settings as the existing UI fallback', async () => {
  hasPerm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const res = await request(makeApp()).get('/sales');
  expect(res.status).toBe(200);
});

test('commercial route declarations apply auth and commercial access to private reads', () => {
  const files = {
    estimates: fs.readFileSync(path.join(__dirname, '../routes/estimates.js'), 'utf8'),
    invoices: fs.readFileSync(path.join(__dirname, '../routes/invoices.js'), 'utf8'),
    changeOrders: fs.readFileSync(path.join(__dirname, '../routes/changeOrders.js'), 'utf8'),
    subcontractors: fs.readFileSync(path.join(__dirname, '../routes/subcontractors.js'), 'utf8'),
  };
  expect(files.estimates).toContain("router.get('/', requireAuth, requireCommercialAccess");
  expect(files.estimates).toContain("router.get('/:id', requireAuth, requireCommercialAccess");
  expect(files.estimates).toContain("router.get('/:id/plan-pdf', requireAuth, requireCommercialAccess");
  expect(files.invoices).toContain("router.get('/', requireAuth, requireCommercialAccess");
  expect(files.invoices).toContain("router.get('/:id', requireAuth, requireCommercialAccess");
  expect(files.changeOrders).toContain("router.get('/change-orders', requireAuth, requireCommercialAccess");
  expect(files.changeOrders).toContain("router.get('/change-orders/:id', requireAuth, requireCommercialAccess");
  expect(files.subcontractors).toContain("router.get('/subcontract-pos/:id/payments', requireAuth, requireCommercialAccess");
});
