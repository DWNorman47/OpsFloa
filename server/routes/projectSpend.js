// Phase 3 of project money flow: aggregate spend per project, broken
// down by the same seven MONEY_CATEGORIES the budget uses. Today this
// reads:
//   - labor: time_entries × users.hourly_rate rollup (existing data)
//   - other / equipment / overhead: project_expenses
// As later modules land, the materials and subs sources hook in here:
//   - materials: SUM inventory_po line costs received against the project
//   - subs:      SUM subcontract_po_payments amounts paid
// Each source guards its own "table exists" check so this query keeps
// returning sensible data through partial migrations.

const router = require('express').Router();
const pool   = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireProjectFinancialAccess, requireProjectFinancialWrite } = require('../middleware/financialAccess');
const { logAudit } = require('../auditLog');
const { MONEY_CATEGORIES, PROJECT_EXPENSE_STATUSES, PROJECT_EXPENSE_STATUS_DEFAULT } = require('../constants/projectMoneyEnums');
const { loadSettings, laborCostCents, LABOR_ENTRY_COLUMNS } = require('../utils/paidHours');
const { equipmentUsageCents, manualExpensesByStatus, materialsCents, projectFrozen } = require('../utils/projectCost');

const FROZEN_MSG = 'This job is closed — reopen its close-out to change costs.';

async function assertProjectInCompany(companyId, projectId) {
  const r = await pool.query(
    'SELECT id, name FROM projects WHERE id = $1 AND company_id = $2',
    [projectId, companyId]
  );
  return r.rows[0] || null;
}

// Has a table been created in this DB? Used to short-circuit reads
// against modules whose migrations haven't run yet on this environment.
async function tableExists(name) {
  try {
    const r = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1",
      [name]
    );
    return r.rowCount > 0;
  } catch {
    return false;
  }
}

// Compute labor spent in cents for a project. Approved + pending entries both
// count toward spend (pending is a real labor liability even if it hasn't
// cleared payroll). Rejected entries don't count.
//
// This used to be a single SUM in SQL, and it was wrong twice over: it billed
// flat hours × rate with **no overtime at all** and no hours-rules policy, and
// its `end_time - start_time` had no midnight-crossing CASE, so an overnight
// shift produced a negative interval that `GREATEST(0, …)` clamped to zero —
// overnight labor silently cost nothing. Both are fixed by doing the sum in JS
// through the one pay pipeline.
async function laborSpent(projectId, settings) {
  const r = await pool.query(
    `SELECT ${LABOR_ENTRY_COLUMNS}
       FROM time_entries te
       JOIN users u ON te.user_id = u.id
      WHERE te.project_id = $1
        AND te.status != 'rejected'
        AND te.start_time IS NOT NULL
        AND te.end_time IS NOT NULL`,
    [projectId]
  );
  return laborCostCents(r.rows, settings, { includeBurden: true });
}

// Stub for the forthcoming sub PO + payment integration.
async function subsSpentAndCommitted(projectId) {
  if (!(await tableExists('subcontract_pos'))) return { spent: 0, committed: 0 };
  // Defensive: handle absence of the payments table too (sub POs may be
  // shipped in stages).
  const hasPayments = await tableExists('subcontract_po_payments');
  const spentRes = hasPayments ? await pool.query(
    `SELECT COALESCE(SUM(p.amount_cents), 0)::bigint AS cents
       FROM subcontract_po_payments p
       JOIN subcontract_pos po ON p.po_id = po.id
      WHERE po.project_id = $1`,
    [projectId]
  ) : { rows: [{ cents: 0 }] };
  const committedRes = await pool.query(
    `SELECT COALESCE(SUM(po.amount_cents - COALESCE(paid.cents, 0)), 0)::bigint AS cents
       FROM subcontract_pos po
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(amount_cents), 0)::bigint AS cents
           FROM subcontract_po_payments
          WHERE po_id = po.id
       ) paid ON true
      WHERE po.project_id = $1
        AND po.status IN ('issued', 'partial')`,
    [projectId]
  ).catch(() => ({ rows: [{ cents: 0 }] }));
  return {
    spent: parseInt(spentRes.rows[0].cents, 10),
    committed: parseInt(committedRes.rows[0].cents, 10),
  };
}

// GET /projects/:id/spend — current spend snapshot.
router.get('/projects/:id/spend', requireAuth, requireProjectFinancialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const project = await assertProjectInCompany(companyId, req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const settings = await loadSettings(companyId);
    const [labor, expenses, subs, mats, equipUsage, budgetRes] = await Promise.all([
      laborSpent(req.params.id, settings),
      manualExpensesByStatus(req.params.id),
      subsSpentAndCommitted(req.params.id),
      materialsCents(req.params.id, settings.materials_cost_basis),
      equipmentUsageCents(req.params.id),
      pool.query(
        'SELECT category, budget_cents, budget_alert_pct FROM project_budget_categories WHERE project_id = $1',
        [req.params.id]
      ),
    ]);

    const budgetByCat = new Map(budgetRes.rows.map(r => [
      r.category,
      { budget: parseInt(r.budget_cents, 10), alert_pct: r.budget_alert_pct },
    ]));

    // Compose per-category breakdown. Actual expenses → spent; planned
    // expenses → committed (a forecast, like an issued-but-unpaid PO).
    const eSpent = expenses.spent;
    const eCommitted = expenses.committed;
    const categories = MONEY_CATEGORIES.map(category => {
      let spent = eSpent.get(category) || 0;
      let committed = eCommitted.get(category) || 0;
      if (category === 'labor') {
        // project_expenses tagged 'labor' (e.g. paid subcontract labor not
        // running through the sub PO module) already counted above.
        spent += labor;
      } else if (category === 'materials') {
        spent += mats.spent;
        committed += mats.committed;
      } else if (category === 'subs') {
        spent += subs.spent;
        committed += subs.committed;
      } else if (category === 'equipment') {
        // + computed usage (logged hours × hourly operating rate).
        spent += equipUsage;
      }
      const budgetEntry = budgetByCat.get(category) || { budget: 0, alert_pct: null };
      const total_used = spent + committed;
      return {
        category,
        spent_cents:        spent,
        committed_cents:    committed,
        total_used_cents:   total_used,
        budget_cents:       budgetEntry.budget,
        budget_alert_pct:   budgetEntry.alert_pct,
      };
    });

    const totals = categories.reduce(
      (acc, c) => ({
        spent:     acc.spent + c.spent_cents,
        committed: acc.committed + c.committed_cents,
        budget:    acc.budget + c.budget_cents,
      }),
      { spent: 0, committed: 0, budget: 0 }
    );

    res.json({
      project_id: parseInt(req.params.id, 10),
      categories,
      totals: {
        spent_cents:      totals.spent,
        committed_cents:  totals.committed,
        total_used_cents: totals.spent + totals.committed,
        budget_cents:     totals.budget,
        // Percent of budget used, capped at 999 to keep the UI sane
        // when a project blows way past budget.
        pct_used: totals.budget > 0
          ? Math.min(999, Math.round(((totals.spent + totals.committed) / totals.budget) * 100))
          : null,
      },
    });
  } catch (err) {
    req.log.error({ err }, 'project spend rollup error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Project expenses CRUD (the "manual cost not from another source" bucket)

router.get('/projects/:id/expenses', requireAuth, requireProjectFinancialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const project = await assertProjectInCompany(companyId, req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const r = await pool.query(
      'SELECT * FROM project_expenses WHERE project_id = $1 ORDER BY paid_date DESC NULLS LAST, created_at DESC',
      [req.params.id]
    );
    res.json({ items: r.rows });
  } catch (err) {
    req.log.error({ err }, 'project expenses list error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/projects/:id/expenses', requireAuth, requireProjectFinancialWrite, async (req, res) => {
  const companyId = req.user.company_id;
  const { description, vendor, paid_date, receipt_url, notes } = req.body;
  const category = req.body.category;
  const status = req.body.status || PROJECT_EXPENSE_STATUS_DEFAULT;
  const equipment_id = req.body.equipment_id != null && req.body.equipment_id !== ''
    ? parseInt(req.body.equipment_id, 10) : null;
  const amount_cents = typeof req.body.amount_cents === 'number'
    ? req.body.amount_cents
    : parseInt(req.body.amount_cents, 10);
  const tax_pct = typeof req.body.tax_pct === 'number'
    ? req.body.tax_pct
    : parseFloat(req.body.tax_pct || 0);
  if (!description || !description.trim()) {
    return res.status(400).json({ error: 'description is required' });
  }
  if (!MONEY_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'invalid category' });
  }
  if (!PROJECT_EXPENSE_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  if (!Number.isFinite(amount_cents) || amount_cents < 0) {
    return res.status(400).json({ error: 'invalid amount_cents' });
  }
  if (!Number.isFinite(tax_pct) || tax_pct < 0 || tax_pct > 100) {
    return res.status(400).json({ error: 'invalid tax_pct' });
  }
  if (equipment_id != null && !Number.isFinite(equipment_id)) {
    return res.status(400).json({ error: 'invalid equipment_id' });
  }
  try {
    const project = await assertProjectInCompany(companyId, req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (await projectFrozen(req.params.id)) return res.status(409).json({ error: FROZEN_MSG, code: 'project_frozen' });
    if (equipment_id != null) {
      const eq = await pool.query('SELECT id FROM equipment_items WHERE id = $1 AND company_id = $2', [equipment_id, companyId]);
      if (eq.rowCount === 0) return res.status(400).json({ error: 'equipment not found' });
    }
    const tax_cents = Math.round(amount_cents * (tax_pct / 100));
    const r = await pool.query(
      `INSERT INTO project_expenses
         (company_id, project_id, category, description, amount_cents, tax_pct, tax_cents,
          vendor, paid_date, receipt_url, notes, created_by, status, equipment_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [companyId, req.params.id, category, description.trim(), amount_cents, tax_pct, tax_cents,
       vendor || null, paid_date || null, receipt_url || null, notes || null, req.user.id, status, equipment_id]
    );
    await logAudit(companyId, req.user.id, req.user.full_name,
      'project_expense.created', 'project_expense', r.rows[0].id, description,
      { project_id: req.params.id, category, amount_cents, tax_cents });
    res.status(201).json(r.rows[0]);
  } catch (err) {
    req.log.error({ err }, 'project expense create error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH an expense — edit fields and/or flip a planned forecast to actual.
// Partial: only the keys in the body change. Converting to 'actual' with no
// paid_date supplied stamps today, so the cost moves committed → spent.
router.patch('/projects/:projectId/expenses/:id', requireAuth, requireProjectFinancialWrite, async (req, res) => {
  const companyId = req.user.company_id;
  if (await projectFrozen(req.params.projectId)) return res.status(409).json({ error: FROZEN_MSG, code: 'project_frozen' });
  const b = req.body;
  const sets = [];
  const params = [];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  if (b.category !== undefined) {
    if (!MONEY_CATEGORIES.includes(b.category)) return res.status(400).json({ error: 'invalid category' });
    add('category', b.category);
  }
  if (b.status !== undefined) {
    if (!PROJECT_EXPENSE_STATUSES.includes(b.status)) return res.status(400).json({ error: 'invalid status' });
    add('status', b.status);
    // Converting a forecast to actual stamps a paid date if none is on file.
    if (b.status === 'actual' && b.paid_date === undefined) add('paid_date', new Date().toISOString().slice(0, 10));
  }
  if (b.description !== undefined) {
    if (!b.description || !b.description.trim()) return res.status(400).json({ error: 'description is required' });
    add('description', b.description.trim());
  }
  if (b.vendor !== undefined) add('vendor', b.vendor || null);
  if (b.paid_date !== undefined) add('paid_date', b.paid_date || null);
  if (b.notes !== undefined) add('notes', b.notes || null);

  // amount / tax: recompute tax_cents whenever either is supplied.
  const amountGiven = b.amount_cents !== undefined;
  const taxGiven = b.tax_pct !== undefined;
  if (amountGiven || taxGiven) {
    try {
      const cur = await pool.query(
        'SELECT amount_cents, tax_pct FROM project_expenses WHERE id = $1 AND project_id = $2 AND company_id = $3',
        [req.params.id, req.params.projectId, companyId]
      );
      if (cur.rowCount === 0) return res.status(404).json({ error: 'Expense not found' });
      const amount_cents = amountGiven ? parseInt(b.amount_cents, 10) : parseInt(cur.rows[0].amount_cents, 10);
      const tax_pct = taxGiven ? parseFloat(b.tax_pct) : parseFloat(cur.rows[0].tax_pct);
      if (!Number.isFinite(amount_cents) || amount_cents < 0) return res.status(400).json({ error: 'invalid amount_cents' });
      if (!Number.isFinite(tax_pct) || tax_pct < 0 || tax_pct > 100) return res.status(400).json({ error: 'invalid tax_pct' });
      add('amount_cents', amount_cents);
      add('tax_pct', tax_pct);
      add('tax_cents', Math.round(amount_cents * (tax_pct / 100)));
    } catch (err) {
      req.log.error({ err }, 'project expense patch (amount) error');
      return res.status(500).json({ error: 'Server error' });
    }
  }

  if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id);         const idIdx = params.length;
  params.push(req.params.projectId);  const pIdx = params.length;
  params.push(companyId);             const cIdx = params.length;
  try {
    const r = await pool.query(
      `UPDATE project_expenses SET ${sets.join(', ')}
        WHERE id = $${idIdx} AND project_id = $${pIdx} AND company_id = $${cIdx}
        RETURNING *`,
      params
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Expense not found' });
    await logAudit(companyId, req.user.id, req.user.full_name,
      'project_expense.updated', 'project_expense', req.params.id, r.rows[0].description,
      { project_id: req.params.projectId, status: r.rows[0].status });
    res.json(r.rows[0]);
  } catch (err) {
    req.log.error({ err }, 'project expense patch error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/projects/:projectId/expenses/:id', requireAuth, requireProjectFinancialWrite, async (req, res) => {
  const companyId = req.user.company_id;
  if (await projectFrozen(req.params.projectId)) return res.status(409).json({ error: FROZEN_MSG, code: 'project_frozen' });
  try {
    const r = await pool.query(
      `DELETE FROM project_expenses
        WHERE id = $1 AND project_id = $2 AND company_id = $3
        RETURNING id, description, category, amount_cents`,
      [req.params.id, req.params.projectId, companyId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Expense not found' });
    await logAudit(companyId, req.user.id, req.user.full_name,
      'project_expense.deleted', 'project_expense', req.params.id, r.rows[0].description,
      { project_id: req.params.projectId, category: r.rows[0].category, amount_cents: r.rows[0].amount_cents });
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, 'project expense delete error');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
