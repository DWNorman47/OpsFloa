let mockCurrentUser;
jest.mock('../middleware/auth', () => ({
  requireAuth:                  (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin:                 (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePermission:            () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePerm:                  () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePlan:                  () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireProAddon:              (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireCertifiedPayrollAddon: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  hasAdminPermission:           () => true,
  requireSuperAdmin:            (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool    = require('../db');
const catalogRoute = require('../routes/catalog');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', catalogRoute);
  return app;
}

beforeEach(() => {
  pool.query.mockReset();
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Admin' };
});

describe('GET /api/catalog/items', () => {
  test('scopes to caller company and returns the rows', async () => {
    pool.query.mockResolvedValueOnce({ rows: [
      { id: 1, name: '2x4 Stud', is_stocked: true, sell_price_cents: 420 },
      { id: 2, name: 'Drywall 5/8"', is_stocked: false, sell_price_cents: 1850 },
    ] });
    const res = await request(makeApp()).get('/api/catalog/items');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    const call = pool.query.mock.calls[0];
    expect(call[1][0]).toBe('co-1');
  });

  test('tag filter is applied via ANY(catalog_tags)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await request(makeApp()).get('/api/catalog/items').query({ tag: 'drywall' });
    const call = pool.query.mock.calls[0];
    expect(call[0]).toMatch(/= ANY\(catalog_tags\)/);
    expect(call[1]).toContain('drywall');
  });
});

describe('GET /api/catalog/items/:id/estimate-line', () => {
  test('404 when item not in caller company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp()).get('/api/catalog/items/9/estimate-line');
    expect(res.status).toBe(404);
  });

  test('uses sell_price_cents directly when present', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{
      id: 9, name: '2x4', unit: 'ea', unit_cost: '3.50',
      sell_price_cents: 500, default_markup_pct: 25,
      default_estimate_category: 'materials',
    }] });
    const res = await request(makeApp()).get('/api/catalog/items/9/estimate-line');
    expect(res.status).toBe(200);
    expect(res.body.unit_cost_cents).toBe(500);
    expect(res.body.category).toBe('materials');
    expect(res.body.source_item_id).toBe(9);
  });

  test('falls back to default_markup_pct over unit_cost when no sell_price_cents', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{
      id: 9, name: 'Brick', unit: 'ea', unit_cost: '0.80',
      sell_price_cents: null, default_markup_pct: 25,  // 25% markup on $0.80 = $1.00
      default_estimate_category: null,                  // will default to 'materials'
    }] });
    const res = await request(makeApp()).get('/api/catalog/items/9/estimate-line');
    expect(res.status).toBe(200);
    expect(res.body.unit_cost_cents).toBe(100);  // round(80 * 1.25) = 100
    expect(res.body.category).toBe('materials');
  });

  test('falls back to plain unit_cost when no sell_price and no markup', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{
      id: 9, name: 'Tape', unit: 'roll', unit_cost: '4.50',
      sell_price_cents: null, default_markup_pct: null,
      default_estimate_category: 'other',
    }] });
    const res = await request(makeApp()).get('/api/catalog/items/9/estimate-line');
    expect(res.status).toBe(200);
    expect(res.body.unit_cost_cents).toBe(450);
    expect(res.body.category).toBe('other');
  });
});
