/**
 * Phase 3 spend rollup contract tests. The rollup is what the P&L
 * dashboard and WIP report ultimately read from, and it has to keep
 * returning sensible data through partial deployments (e.g. sub PO
 * tables exist on one env but not the other) — that's what the
 * tableExists guards in projectSpend.js are about. These tests pin the
 * shape rather than the underlying SQL.
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

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool    = require('../db');
const spendRoute = require('../routes/projectSpend');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', spendRoute);
  return app;
}

beforeEach(() => {
  pool.query.mockReset();
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Test Admin' };
});

// ───────────────────────────────────────────────────────────────────────────
// GET /projects/:id/spend
// ───────────────────────────────────────────────────────────────────────────

describe('GET /api/projects/:id/spend', () => {
  test('returns 404 when project not in caller company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp()).get('/api/projects/42/spend');
    expect(res.status).toBe(404);
  });

  test('returns the seven-bucket shape with totals (assertion-by-content, not call order)', async () => {
    // Promise.all in the route fires queries concurrently — the order
    // they pull from a sequential mockResolvedValueOnce queue depends
    // on V8 scheduling. Dispatch responses by inspecting the SQL text
    // so the test is robust to interleaving.
    pool.query.mockImplementation((sql) => {
      if (/FROM projects WHERE id/i.test(sql) && /AND company_id/i.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 42, name: 'Test Project' }] });
      }
      if (/FROM settings/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/FROM time_entries/i.test(sql)) {
        // 8h @ $750 = $6,000, ot_rule 'none' so the total is a clean
        // hours × rate and this test stays about the rollup.
        return Promise.resolve({ rows: [{ user_id: 1, work_date: '2026-04-01', start_time: '08:00:00', end_time: '16:00:00', break_minutes: 0, wage_type: 'regular', overtime_hours_override: null, rate: '750', ot_rule: 'none' }] });
      }
      if (/information_schema\.tables/i.test(sql)) {
        // Only project_expenses exists in this test scenario.
        const tbl = (sql.match(/table_name = \$1/i) ? null : null);
        // We can't see the param here without callargs; use a heuristic:
        // tableExists for project_expenses is called first via the rollup
        // path; rather than guess, treat any tables check as present and
        // let the unmatched-content path below catch other cases.
        return Promise.resolve({ rowCount: 1, rows: [{ '?column?': 1 }] });
      }
      if (/information_schema\.columns/i.test(sql)) {
        // purchase_orders.project_id column doesn't exist yet
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      if (/FROM project_expenses/i.test(sql) && /GROUP BY category/i.test(sql)) {
        return Promise.resolve({
          rows: [
            { category: 'equipment', cents: '25000' },
            { category: 'other',     cents: '40000' },
          ],
        });
      }
      if (/FROM subcontract_po_payments/i.test(sql)) {
        return Promise.resolve({ rows: [{ cents: '0' }] });
      }
      if (/FROM subcontract_pos/i.test(sql)) {
        return Promise.resolve({ rows: [{ cents: '0' }] });
      }
      if (/FROM purchase_orders/i.test(sql) || /information_schema/i.test(sql)) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      if (/FROM project_budget_categories/i.test(sql)) {
        return Promise.resolve({
          rows: [
            { category: 'labor',     budget_cents: '1000000', budget_alert_pct: 90 },
            { category: 'equipment', budget_cents: '50000',   budget_alert_pct: null },
            { category: 'other',     budget_cents: '100000',  budget_alert_pct: null },
          ],
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(makeApp()).get('/api/projects/42/spend');
    expect(res.status).toBe(200);
    expect(res.body.project_id).toBe(42);
    expect(res.body.categories).toHaveLength(7);

    const byCat = Object.fromEntries(res.body.categories.map(c => [c.category, c]));
    expect(byCat.labor.spent_cents).toBe(600000);
    expect(byCat.labor.budget_cents).toBe(1000000);
    expect(byCat.equipment.spent_cents).toBe(25000);
    expect(byCat.equipment.budget_cents).toBe(50000);
    expect(byCat.other.spent_cents).toBe(40000);
    expect(byCat.subs.spent_cents).toBe(0);
    expect(byCat.subs.committed_cents).toBe(0);

    expect(res.body.totals.spent_cents).toBe(600000 + 25000 + 40000);
    expect(res.body.totals.committed_cents).toBe(0);
    expect(res.body.totals.budget_cents).toBe(1000000 + 50000 + 100000);
    // 665000 / 1150000 = 57.83 → rounds to 58
    expect(res.body.totals.pct_used).toBe(58);
  });

  test('adds equipment usage (hours × hourly operating rate) to the equipment category', async () => {
    pool.query.mockImplementation((sql) => {
      if (/FROM projects WHERE id/i.test(sql) && /AND company_id/i.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 42, name: 'P' }] });
      }
      if (/FROM settings/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/FROM time_entries/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/information_schema\.tables/i.test(sql)) return Promise.resolve({ rowCount: 1, rows: [{ '?column?': 1 }] });
      if (/information_schema\.columns/i.test(sql)) return Promise.resolve({ rowCount: 0, rows: [] });
      if (/FROM equipment_hours/i.test(sql)) return Promise.resolve({ rows: [{ dollars: '480.00' }] });  // 4h × $120
      if (/FROM project_expenses/i.test(sql) && /GROUP BY category/i.test(sql)) {
        return Promise.resolve({ rows: [{ category: 'equipment', cents: '25000' }] });
      }
      if (/FROM subcontract/i.test(sql)) return Promise.resolve({ rows: [{ cents: '0' }] });
      if (/FROM project_budget_categories/i.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(makeApp()).get('/api/projects/42/spend');
    expect(res.status).toBe(200);
    const byCat = Object.fromEntries(res.body.categories.map(c => [c.category, c]));
    // 25000 manual equipment expense + 48000 usage (4h × $120/hr)
    expect(byCat.equipment.spent_cents).toBe(73000);
  });

  test('planned expenses land in the committed bucket, not spent', async () => {
    pool.query.mockImplementation((sql) => {
      if (/FROM projects WHERE id/i.test(sql) && /AND company_id/i.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 42, name: 'P' }] });
      }
      if (/FROM settings/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/FROM time_entries/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/information_schema/i.test(sql)) return Promise.resolve({ rowCount: 0, rows: [] });
      if (/FROM project_expenses/i.test(sql) && /GROUP BY category/i.test(sql)) {
        return Promise.resolve({ rows: [
          { category: 'equipment', status: 'planned', cents: '30000' },  // forecast → committed
          { category: 'equipment', status: 'actual',  cents: '5000' },   // incurred → spent
        ] });
      }
      if (/FROM project_budget_categories/i.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(makeApp()).get('/api/projects/42/spend');
    expect(res.status).toBe(200);
    const eq = res.body.categories.find(c => c.category === 'equipment');
    expect(eq.spent_cents).toBe(5000);
    expect(eq.committed_cents).toBe(30000);
    expect(res.body.totals.committed_cents).toBe(30000);
  });

  test('materials: issued inventory is spent, open POs are committed', async () => {
    pool.query.mockImplementation((sql) => {
      if (/FROM projects WHERE id/i.test(sql) && /AND company_id/i.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 42, name: 'P' }] });
      }
      if (/FROM settings/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/FROM time_entries/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/information_schema/i.test(sql)) return Promise.resolve({ rowCount: 1, rows: [{ '?column?': 1 }] });
      if (/FROM inventory_transactions/i.test(sql)) return Promise.resolve({ rows: [{ dollars: '1200.00' }] });  // issued
      if (/FROM purchase_order_lines/i.test(sql)) return Promise.resolve({ rows: [{ dollars: '800.00' }] });     // open PO
      if (/FROM project_expenses/i.test(sql) && /GROUP BY category/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/FROM subcontract/i.test(sql)) return Promise.resolve({ rows: [{ cents: '0' }] });
      if (/FROM equipment_hours/i.test(sql)) return Promise.resolve({ rows: [{ dollars: '0' }] });
      if (/FROM project_budget_categories/i.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    const res = await request(makeApp()).get('/api/projects/42/spend');
    expect(res.status).toBe(200);
    const mat = res.body.categories.find(c => c.category === 'materials');
    expect(mat.spent_cents).toBe(120000);       // 1200 issued
    expect(mat.committed_cents).toBe(80000);     // 800 open PO
  });

  test('returns null pct_used when no budget is set', async () => {
    pool.query.mockImplementation((sql) => {
      if (/FROM projects WHERE id/i.test(sql) && /AND company_id/i.test(sql)) {
        return Promise.resolve({ rowCount: 1, rows: [{ id: 42, name: 'Test' }] });
      }
      if (/FROM time_entries/i.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      // Pretend none of the optional tables exist.
      if (/information_schema/i.test(sql)) {
        return Promise.resolve({ rowCount: 0, rows: [] });
      }
      // No budgets configured.
      if (/FROM project_budget_categories/i.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(makeApp()).get('/api/projects/42/spend');
    expect(res.status).toBe(200);
    expect(res.body.totals.budget_cents).toBe(0);
    expect(res.body.totals.pct_used).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /projects/:id/expenses
// ───────────────────────────────────────────────────────────────────────────

describe('POST /api/projects/:projectId/expenses', () => {
  test('rejects 400 on missing description', async () => {
    const res = await request(makeApp())
      .post('/api/projects/42/expenses')
      .send({ category: 'equipment', amount_cents: 1000 });
    expect(res.status).toBe(400);
  });

  test('rejects 400 on unknown category', async () => {
    const res = await request(makeApp())
      .post('/api/projects/42/expenses')
      .send({ category: 'banana', amount_cents: 1000, description: 'd' });
    expect(res.status).toBe(400);
  });

  test('rejects 400 on negative amount_cents', async () => {
    const res = await request(makeApp())
      .post('/api/projects/42/expenses')
      .send({ category: 'equipment', amount_cents: -50, description: 'd' });
    expect(res.status).toBe(400);
  });

  test('rejects 400 on tax_pct out of [0, 100]', async () => {
    const res = await request(makeApp())
      .post('/api/projects/42/expenses')
      .send({ category: 'equipment', amount_cents: 100, tax_pct: 150, description: 'd' });
    expect(res.status).toBe(400);
  });

  test('rejects 404 when project not in caller company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp())
      .post('/api/projects/42/expenses')
      .send({ category: 'equipment', amount_cents: 1000, description: 'd' });
    expect(res.status).toBe(404);
  });

  test('rejects an invalid status', async () => {
    const res = await request(makeApp())
      .post('/api/projects/42/expenses')
      .send({ category: 'equipment', amount_cents: 1000, description: 'd', status: 'maybe' });
    expect(res.status).toBe(400);
  });

  test('stores a planned rental linked to an equipment asset', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, name: 'Test' }] })   // project
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] })                   // equipment check
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 9, status: 'planned', equipment_id: 7 }] });  // insert
    const res = await request(makeApp())
      .post('/api/projects/42/expenses')
      .send({ category: 'equipment', amount_cents: 80000, description: 'Excavator — 2 wk', status: 'planned', equipment_id: 7 });
    expect(res.status).toBe(201);
    const insertCall = pool.query.mock.calls.find(c => /INSERT INTO project_expenses/.test(c[0]));
    expect(insertCall[1]).toEqual(expect.arrayContaining(['planned', 7]));
  });

  test('rejects a planned rental whose equipment is not in the company', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, name: 'Test' }] })   // project
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });                          // equipment check → miss
    const res = await request(makeApp())
      .post('/api/projects/42/expenses')
      .send({ category: 'equipment', amount_cents: 80000, description: 'X', equipment_id: 99 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/equipment/);
  });

  test('computes tax_cents and stores the row', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42, name: 'Test' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7, description: 'Crane rental', category: 'equipment', amount_cents: 10000, tax_cents: 800 }] });

    const res = await request(makeApp())
      .post('/api/projects/42/expenses')
      .send({ category: 'equipment', amount_cents: 10000, tax_pct: 8, description: 'Crane rental' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(7);

    const insertCall = pool.query.mock.calls.find(c => /INSERT INTO project_expenses/.test(c[0]));
    expect(insertCall).toBeDefined();
    // tax_cents should be ROUND(10000 * 0.08) = 800
    expect(insertCall[1][6]).toBe(800);
  });
});

describe('PATCH /api/projects/:projectId/expenses/:id', () => {
  test('flips a planned forecast to actual and stamps a paid date', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 9, status: 'actual' }] });
    const res = await request(makeApp())
      .patch('/api/projects/42/expenses/9')
      .send({ status: 'actual' });
    expect(res.status).toBe(200);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/status = \$1/);
    expect(sql).toMatch(/paid_date = \$2/);  // auto-stamped on convert
  });

  test('recomputes tax_cents when the amount changes', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ amount_cents: '10000', tax_pct: '8' }] })  // current
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 9 }] });                                // update
    const res = await request(makeApp())
      .patch('/api/projects/42/expenses/9')
      .send({ amount_cents: 20000 });
    expect(res.status).toBe(200);
    const updateCall = pool.query.mock.calls[1];
    // tax_cents = round(20000 * 0.08) = 1600
    expect(updateCall[1]).toContain(1600);
  });

  test('400 when no fields are provided', async () => {
    const res = await request(makeApp()).patch('/api/projects/42/expenses/9').send({});
    expect(res.status).toBe(400);
  });
});
