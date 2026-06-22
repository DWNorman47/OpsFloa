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
const reportsRoute = require('../routes/projectReports');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', reportsRoute);
  return app;
}

beforeEach(() => {
  pool.query.mockReset();
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Admin' };
});

// ── P&L per-project ───────────────────────────────────────────────────────────

describe('GET /api/projects/:id/pnl', () => {
  test('404 when project not in caller company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp()).get('/api/projects/42/pnl');
    expect(res.status).toBe(404);
  });

  test('returns gross + projected profit and margins', async () => {
    // Dispatch by SQL content so the test isn't Promise.all order-sensitive.
    pool.query.mockImplementation((sql) => {
      if (/FROM projects WHERE id/.test(sql) && /AND company_id/.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 42, name: 'Test' }] });
      }
      // Contract value: accepted estimate worth $300k
      if (/FROM estimates/.test(sql) && /converted_project_id = \$1 AND status IN/.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [{ total_cents: '30000000' }] });
      }
      if (/FROM project_budget_categories/.test(sql)) {
        return Promise.resolve({ rows: [{ sum: '25000000' }] });
      }
      if (/FROM project_invoices/.test(sql)) {
        // billed $180k, collected $150k
        return Promise.resolve({ rows: [{ billed_dollars: '180000.00', collected_dollars: '150000.00' }] });
      }
      if (/FROM time_entries/.test(sql)) {
        // $68,000 labor
        return Promise.resolve({ rows: [{ dollars: '68000.00' }] });
      }
      if (/FROM project_expenses/.test(sql)) {
        // $2,000 misc
        return Promise.resolve({ rows: [{ cents: '200000' }] });
      }
      if (/FROM subcontract_po_payments p/.test(sql) && /JOIN subcontract_pos po/.test(sql)) {
        return Promise.resolve({ rows: [{ cents: '45000000' }] });  // $450k subs paid
      }
      if (/FROM subcontract_pos po/.test(sql) && /LATERAL/.test(sql)) {
        return Promise.resolve({ rows: [{ cents: '0' }] });  // no open commitments
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(makeApp()).get('/api/projects/42/pnl');
    expect(res.status).toBe(200);
    expect(res.body.project_id).toBe(42);
    expect(res.body.contract_value_cents).toBe(30000000);
    expect(res.body.revenue.billed_cents).toBe(18000000);
    expect(res.body.cost.spent_cents).toBe(6800000 + 200000 + 45000000);
    expect(res.body.gross_profit_cents).toBe(18000000 - (6800000 + 200000 + 45000000));
    // Projected: 30M − (52M + 0) = -22M
    expect(res.body.projected_profit_cents).toBe(30000000 - (6800000 + 200000 + 45000000 + 0));
  });

  test('returns null margin when no revenue / no contract value', async () => {
    pool.query.mockImplementation((sql) => {
      if (/FROM projects WHERE id/.test(sql) && /AND company_id/.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 42, name: 'Test' }] });
      }
      if (/FROM estimates/.test(sql)) return Promise.resolve({ rows: [] });
      if (/FROM project_budget_categories/.test(sql)) return Promise.resolve({ rows: [{ sum: '0' }] });
      if (/FROM project_invoices/.test(sql)) return Promise.resolve({ rows: [{ billed_dollars: '0', collected_dollars: '0' }] });
      return Promise.resolve({ rows: [{ dollars: '0', cents: '0' }] });
    });
    const res = await request(makeApp()).get('/api/projects/42/pnl');
    expect(res.status).toBe(200);
    expect(res.body.gross_margin_pct).toBeNull();
    expect(res.body.projected_margin_pct).toBeNull();
  });
});

// ── WIP report ────────────────────────────────────────────────────────────────

describe('GET /api/wip-report', () => {
  test('scopes to caller company and excludes archived by default', async () => {
    pool.query.mockImplementation((sql, params) => {
      if (/FROM projects/.test(sql) && /WHERE company_id = \$1/.test(sql)) {
        // Should include AND active = true filter by default
        expect(sql).toMatch(/AND active = true/);
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(makeApp()).get('/api/wip-report');
    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual([]);
  });

  test('computes earned revenue and over/under-billed delta', async () => {
    pool.query.mockImplementation((sql) => {
      if (/FROM projects/.test(sql) && /WHERE company_id/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 42, name: 'Cedar Apts' }] });
      }
      if (/FROM estimates/.test(sql) && /converted_project_id/.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [{ total_cents: '28500000' }] });  // $285k contract
      }
      if (/FROM project_budget_categories/.test(sql)) {
        return Promise.resolve({ rows: [{ sum: '21400000' }] });  // $214k budgeted cost
      }
      if (/FROM project_invoices/.test(sql)) {
        return Promise.resolve({ rows: [{ billed_dollars: '180000.00', collected_dollars: '180000.00' }] });
      }
      if (/FROM time_entries/.test(sql)) {
        return Promise.resolve({ rows: [{ dollars: '14200.00' }] });  // labor $14,200
      }
      if (/FROM project_expenses/.test(sql)) return Promise.resolve({ rows: [{ cents: '0' }] });
      if (/FROM subcontract_po_payments/.test(sql)) return Promise.resolve({ rows: [{ cents: '0' }] });
      if (/FROM subcontract_pos/.test(sql)) return Promise.resolve({ rows: [{ cents: '0' }] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(makeApp()).get('/api/wip-report');
    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(1);
    const row = res.body.projects[0];
    expect(row.contract_value_cents).toBe(28500000);
    expect(row.budgeted_cost_cents).toBe(21400000);
    expect(row.cost_to_date_cents).toBe(1420000);  // $14,200 in cents
    // pct_complete = 1420000 / 21400000 ≈ 6.6%
    expect(row.pct_complete).toBeCloseTo(6.6, 0);
    // earned_revenue ≈ contract * pct_complete/100 ≈ 1881000 (rounded)
    expect(row.earned_revenue_cents).toBeGreaterThan(0);
    // over/under = billed - earned (we billed $180k, earned ~$1.9k → wildly over-billed)
    expect(row.status).toBe('over_billed');
  });

  test('totals row aggregates across projects', async () => {
    let projectCallCount = 0;
    pool.query.mockImplementation((sql) => {
      if (/FROM projects/.test(sql) && /WHERE company_id/.test(sql)) {
        return Promise.resolve({ rows: [
          { id: 1, name: 'P1' },
          { id: 2, name: 'P2' },
        ] });
      }
      if (/FROM estimates/.test(sql)) {
        projectCallCount++;
        return Promise.resolve({ rowCount: 1, rows: [{ total_cents: '10000000' }] });
      }
      if (/FROM project_budget_categories/.test(sql)) return Promise.resolve({ rows: [{ sum: '8000000' }] });
      if (/FROM project_invoices/.test(sql)) return Promise.resolve({ rows: [{ billed_dollars: '50000', collected_dollars: '50000' }] });
      if (/FROM time_entries/.test(sql)) return Promise.resolve({ rows: [{ dollars: '4000' }] });
      return Promise.resolve({ rows: [{ cents: '0' }] });
    });
    const res = await request(makeApp()).get('/api/wip-report');
    expect(res.status).toBe(200);
    expect(res.body.totals.contract_value_cents).toBe(20000000);  // 2 × $100k
    expect(res.body.totals.billed_to_date_cents).toBe(10000000);  // 2 × $50k
  });
});
