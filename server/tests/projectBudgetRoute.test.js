/**
 * Pins the contract for Phase 2 categorized budget. The route is what
 * Phase 3 (spend rollup) and the P&L dashboard / WIP report read against.
 * Tests focus on cross-tenant scoping, the seven-bucket shape, and the
 * upsert-by-submission behaviour (categories not in the body keep their
 * stored value).
 */

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
jest.mock('../middleware/financialAccess', () => ({
  requireProjectFinancialAccess: (req, _res, next) => next(),
  requireProjectFinancialWrite: (req, _res, next) => next(),
}));

jest.mock('../db', () => {
  const queryMock = jest.fn();
  const fakeClient = { query: (...a) => queryMock(...a), release: jest.fn() };
  return { query: queryMock, connect: jest.fn().mockResolvedValue(fakeClient) };
});
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool    = require('../db');
const budgetRoute = require('../routes/projectBudget');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', budgetRoute);
  return app;
}

beforeEach(() => {
  pool.query.mockReset();
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Test Admin' };
});

// ───────────────────────────────────────────────────────────────────────────
// GET /projects/:id/budget
// ───────────────────────────────────────────────────────────────────────────

describe('GET /api/projects/:id/budget', () => {
  test('returns 404 when project not in caller company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp()).get('/api/projects/42/budget');
    expect(res.status).toBe(404);
  });

  test('returns the canonical seven-bucket shape with zeros for unset categories', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, name: 'Test Project' }] })  // assertProjectInCompany
      .mockResolvedValueOnce({                                                            // SELECT category rows
        rows: [
          { id: 1, category: 'labor',     budget_cents: 8000000, budget_alert_pct: null, notes: null },
          { id: 2, category: 'materials', budget_cents: 4500000, budget_alert_pct: 80,   notes: 'lumber heavy' },
        ],
      });

    const res = await request(makeApp()).get('/api/projects/42/budget');
    expect(res.status).toBe(200);
    expect(res.body.project_id).toBe(42);
    expect(res.body.categories).toHaveLength(7);

    // All seven money categories appear, in canonical order
    expect(res.body.categories.map(c => c.category)).toEqual(
      ['labor', 'materials', 'equipment', 'subs', 'overhead', 'contingency', 'other']
    );
    // Set rows reflect their values
    const labor = res.body.categories.find(c => c.category === 'labor');
    expect(labor.budget_cents).toBe(8000000);
    const materials = res.body.categories.find(c => c.category === 'materials');
    expect(materials.budget_alert_pct).toBe(80);
    // Unset categories come back as zero rows so the client can render the bar
    const equipment = res.body.categories.find(c => c.category === 'equipment');
    expect(equipment.budget_cents).toBe(0);
    expect(equipment.id).toBeNull();

    expect(res.body.total_cents).toBe(8000000 + 4500000);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PUT /projects/:id/budget
// ───────────────────────────────────────────────────────────────────────────

describe('PUT /api/projects/:id/budget', () => {
  test('returns 400 when categories is not an array', async () => {
    const res = await request(makeApp())
      .put('/api/projects/42/budget')
      .send({ categories: 'nope' });
    expect(res.status).toBe(400);
  });

  test('returns 400 on an unknown category', async () => {
    const res = await request(makeApp())
      .put('/api/projects/42/budget')
      .send({ categories: [{ category: 'banana', budget_cents: 1000 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown category/);
  });

  test('returns 400 on negative budget_cents', async () => {
    const res = await request(makeApp())
      .put('/api/projects/42/budget')
      .send({ categories: [{ category: 'labor', budget_cents: -100 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid budget_cents/);
  });

  test('returns 400 on out-of-range budget_alert_pct', async () => {
    const res = await request(makeApp())
      .put('/api/projects/42/budget')
      .send({ categories: [{ category: 'labor', budget_cents: 100, budget_alert_pct: 250 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/budget_alert_pct/);
  });

  test('returns 404 when project not in caller company', async () => {
    pool.query
      .mockResolvedValueOnce(undefined)                                        // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })                        // SELECT project FOR UPDATE
      .mockResolvedValueOnce(undefined);                                       // ROLLBACK

    const res = await request(makeApp())
      .put('/api/projects/42/budget')
      .send({ categories: [{ category: 'labor', budget_cents: 1000 }] });
    expect(res.status).toBe(404);
  });
});
