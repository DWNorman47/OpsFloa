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
const { requireProjectFinancialAccess } = require('../middleware/financialAccess');
const { logAudit } = require('../auditLog');
const { MONEY_CATEGORIES } = require('../constants/projectMoneyEnums');
const { loadSettings, laborCostCents, LABOR_ENTRY_COLUMNS } = require('../utils/paidHours');

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
  return laborCostCents(r.rows, settings);
}

// Sum project_expenses by category. Returns a Map.
async function expensesByCategory(projectId) {
  if (!(await tableExists('project_expenses'))) return new Map();
  const r = await pool.query(
    `SELECT category, COALESCE(SUM(amount_cents + tax_cents), 0)::bigint AS cents
       FROM project_expenses
      WHERE project_id = $1
      GROUP BY category`,
    [projectId]
  );
  return new Map(r.rows.map(row => [row.category, parseInt(row.cents, 10)]));
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

// Stub for the forthcoming inventory-PO-to-project linkage.
async function materialsSpentAndCommitted(projectId) {
  if (!(await tableExists('purchase_orders'))) return { spent: 0, committed: 0 };
  // Skip until inventory POs gain a project_id column (sketched but not
  // yet shipped). For now, no contribution.
  try {
    const colCheck = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'purchase_orders' AND column_name = 'project_id' LIMIT 1`
    );
    if (colCheck.rowCount === 0) return { spent: 0, committed: 0 };
    // Materials spent = the lines that have been received against this
    // project's POs, valued at the unit_cost on the line.
    // Materials committed = lines on POs in status='submitted' or 'partial'
    // that haven't been fully received.
    return { spent: 0, committed: 0 };  // Placeholder — full impl ships with inventory PO project linkage.
  } catch {
    return { spent: 0, committed: 0 };
  }
}

// GET /projects/:id/spend — current spend snapshot.
router.get('/projects/:id/spend', requireAuth, requireProjectFinancialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const project = await assertProjectInCompany(companyId, req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const settings = await loadSettings(companyId);
    const [labor, expenses, subs, mats, budgetRes] = await Promise.all([
      laborSpent(req.params.id, settings),
      expensesByCategory(req.params.id),
      subsSpentAndCommitted(req.params.id),
      materialsSpentAndCommitted(req.params.id),
      pool.query(
        'SELECT category, budget_cents, budget_alert_pct FROM project_budget_categories WHERE project_id = $1',
        [req.params.id]
      ),
    ]);

    const budgetByCat = new Map(budgetRes.rows.map(r => [
      r.category,
      { budget: parseInt(r.budget_cents, 10), alert_pct: r.budget_alert_pct },
    ]));

    // Compose per-category breakdown.
    const categories = MONEY_CATEGORIES.map(category => {
      let spent = 0;
      let committed = 0;
      if (category === 'labor') {
        spent = labor;
        // project_expenses tagged 'labor' (e.g. paid subcontract labor
        // not running through the sub PO module) add to this bucket too.
        spent += expenses.get('labor') || 0;
      } else if (category === 'materials') {
        spent = (expenses.get('materials') || 0) + mats.spent;
        committed = mats.committed;
      } else if (category === 'subs') {
        spent = (expenses.get('subs') || 0) + subs.spent;
        committed = subs.committed;
      } else {
        spent = expenses.get(category) || 0;
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

router.post('/projects/:id/expenses', requireAuth, requireProjectFinancialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  const { description, vendor, paid_date, receipt_url, notes } = req.body;
  const category = req.body.category;
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
  if (!Number.isFinite(amount_cents) || amount_cents < 0) {
    return res.status(400).json({ error: 'invalid amount_cents' });
  }
  if (!Number.isFinite(tax_pct) || tax_pct < 0 || tax_pct > 100) {
    return res.status(400).json({ error: 'invalid tax_pct' });
  }
  try {
    const project = await assertProjectInCompany(companyId, req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const tax_cents = Math.round(amount_cents * (tax_pct / 100));
    const r = await pool.query(
      `INSERT INTO project_expenses
         (company_id, project_id, category, description, amount_cents, tax_pct, tax_cents,
          vendor, paid_date, receipt_url, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [companyId, req.params.id, category, description.trim(), amount_cents, tax_pct, tax_cents,
       vendor || null, paid_date || null, receipt_url || null, notes || null, req.user.id]
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

router.delete('/projects/:projectId/expenses/:id', requireAuth, requireProjectFinancialAccess, async (req, res) => {
  const companyId = req.user.company_id;
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
