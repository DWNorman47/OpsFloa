// P&L dashboard + WIP report — read-only aggregations on top of the
// estimates / budget / spend / invoices that are already in the DB.
// Math is small enough to keep in this file alongside the routes.

const router = require('express').Router();
const pool   = require('../db');
const { requireAuth } = require('../middleware/auth');
const {
  requireProjectFinancialAccess,
  requireFinancialReportsAccess,
} = require('../middleware/financialAccess');
const { csvCell } = require('../utils/csv');
const { loadSettings, laborCostCents, LABOR_ENTRY_COLUMNS } = require('../utils/paidHours');
const { equipmentUsageCents, manualExpensesByStatus, materialsCents, sumMap } = require('../utils/projectCost');

// ── Shared helpers ────────────────────────────────────────────────────────────

async function assertProjectInCompany(companyId, projectId) {
  const r = await pool.query(
    'SELECT id, name FROM projects WHERE id = $1 AND company_id = $2',
    [projectId, companyId]
  );
  return r.rows[0] || null;
}

// Sum invoice money for a project — returns cents, from the native `invoices`
// table (QBO-synced rows live here too since the unification; project_invoices
// is retired). Void invoices are excluded from both figures.
// billed    = SUM(total_cents) over non-void invoices
// collected = SUM(invoice_payments.amount_cents) for those invoices
async function invoiceTotals(projectId, companyId) {
  try {
    const r = await pool.query(
      `SELECT
         COALESCE(SUM(i.total_cents), 0) AS billed_cents,
         COALESCE((
           SELECT SUM(p.amount_cents)
             FROM invoice_payments p
             JOIN invoices i2 ON i2.id = p.invoice_id
            WHERE i2.project_id = $1 AND i2.company_id = $2 AND i2.status <> 'void'
         ), 0) AS collected_cents
       FROM invoices i
      WHERE i.project_id = $1 AND i.company_id = $2 AND i.status <> 'void'`,
      [projectId, companyId]
    );
    return {
      billed_cents:    parseInt(r.rows[0].billed_cents, 10) || 0,
      collected_cents: parseInt(r.rows[0].collected_cents, 10) || 0,
    };
  } catch {
    return { billed_cents: 0, collected_cents: 0 };
  }
}

// Latest accepted estimate's total for a project (the contract value
// baseline). Change orders bump this once that module lands.
async function contractValueCents(projectId) {
  try {
    const r = await pool.query(
      `SELECT total_cents
         FROM estimates
        WHERE converted_project_id = $1 AND status IN ('accepted')
        ORDER BY responded_at DESC NULLS LAST
        LIMIT 1`,
      [projectId]
    );
    if (r.rowCount > 0) return parseInt(r.rows[0].total_cents, 10);
  } catch { /* table may not exist */ }
  // Fallback: budget total (sum of category budgets). Still meaningful
  // if no estimate flow was used to create the project.
  try {
    const r = await pool.query(
      `SELECT COALESCE(SUM(budget_cents), 0)::bigint AS sum
         FROM project_budget_categories WHERE project_id = $1`,
      [projectId]
    );
    return parseInt(r.rows[0].sum, 10);
  } catch {
    return 0;
  }
}

// Spend / committed roll-up — same logic as routes/projectSpend.js but
// collapsed to a single number (no category split). Reused by both
// P&L and WIP.
async function spendTotals(projectId, settings) {
  let labor = 0;
  let materials = 0;            // issued-to-project inventory cost (spent)
  let materialsCommitted = 0;   // unreceived open-PO value for the project
  let subsSpent = 0;
  let subsCommitted = 0;
  let manualExpenses = 0;       // actual expenses (spent)
  let manualCommitted = 0;      // planned expenses (committed forecast)
  let equipUsage = 0;           // logged hours × hourly operating rate
  // Labor — same pipeline as project spend, so the WIP report and the spend
  // snapshot can't disagree about one project's labor. This was a duplicate of
  // that query, carrying the same two bugs (no overtime, and overnight shifts
  // silently costing $0).
  try {
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
    labor = laborCostCents(r.rows, settings, { includeBurden: true });
  } catch { /* time_entries shape may differ */ }
  // Manual expenses, split actual (spent) vs planned (committed forecast).
  try {
    const { spent, committed } = await manualExpensesByStatus(projectId);
    manualExpenses = sumMap(spent);
    manualCommitted = sumMap(committed);
  } catch { /* table may not exist */ }
  // Equipment usage (logged hours × hourly operating rate) — same source as the
  // per-category spend snapshot, so P&L/WIP and the spend tab agree.
  equipUsage = await equipmentUsageCents(projectId);
  // Materials: spent (issued or received per company basis) + open-PO committed.
  const mat = await materialsCents(projectId, settings.materials_cost_basis);
  materials = mat.spent;
  materialsCommitted = mat.committed;
  // Sub spent + committed
  try {
    const paidR = await pool.query(
      `SELECT COALESCE(SUM(p.amount_cents), 0)::bigint AS cents
         FROM subcontract_po_payments p
         JOIN subcontract_pos po ON p.po_id = po.id
        WHERE po.project_id = $1`,
      [projectId]
    );
    subsSpent = parseInt(paidR.rows[0].cents, 10);
  } catch { /* tables may not exist */ }
  try {
    const cR = await pool.query(
      `SELECT COALESCE(SUM(po.amount_cents - COALESCE(paid.cents, 0)), 0)::bigint AS cents
         FROM subcontract_pos po
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(amount_cents), 0)::bigint AS cents
             FROM subcontract_po_payments WHERE po_id = po.id
         ) paid ON true
        WHERE po.project_id = $1 AND po.status IN ('issued', 'partial')`,
      [projectId]
    );
    subsCommitted = parseInt(cR.rows[0].cents, 10);
  } catch { /* tables may not exist */ }
  return {
    spent_cents:     labor + manualExpenses + materials + subsSpent + equipUsage,
    committed_cents: subsCommitted + manualCommitted + materialsCommitted,
    by_source: {
      labor, materials, materials_committed: materialsCommitted,
      subs_spent: subsSpent, subs_committed: subsCommitted,
      manual_expenses: manualExpenses, manual_committed: manualCommitted, equipment_usage: equipUsage,
    },
  };
}

// Standard divide-with-null-guard: pct or null if denominator is zero.
function pctOrNull(num, den, decimals = 1) {
  if (!den) return null;
  return Math.round((num / den) * Math.pow(10, decimals + 2)) / Math.pow(10, decimals);
}

// ── P&L: per-project ──────────────────────────────────────────────────────────

// Assemble the full per-project P&L object. Shared by the live /pnl endpoint and
// the close-out snapshot, so the "final" locked number is computed identically
// to the live one.
async function budgetTotalCents(projectId) {
  try {
    const r = await pool.query(
      'SELECT COALESCE(SUM(budget_cents), 0)::bigint AS sum FROM project_budget_categories WHERE project_id = $1',
      [projectId]
    );
    return parseInt(r.rows[0].sum, 10);
  } catch { return 0; }
}

async function computeProjectPnl(projectId, companyId, settings) {
  const [contractValue, spend, invoices, budgetTotal] = await Promise.all([
    contractValueCents(projectId),
    spendTotals(projectId, settings),
    invoiceTotals(projectId, companyId),
    budgetTotalCents(projectId),
  ]);
  // gross_profit = revenue billed − cost spent  (lagging actual).
  // projected_profit = contract − estimate-at-completion cost. EAC is the cost
  // you still expect to incur, not just what's landed: max(spent+committed,
  // budget). So early on (spent≈0) projected ≈ contract − budget ≈ bid margin
  // and converges to actual as costs post — instead of starting near 100%.
  const committedCost = spend.spent_cents + spend.committed_cents;
  const forecastCost = Math.max(committedCost, budgetTotal || 0);
  const gross_profit_cents     = invoices.billed_cents - spend.spent_cents;
  const projected_profit_cents = contractValue - forecastCost;
  return {
    contract_value_cents: contractValue,
    revenue: invoices,
    cost: spend,
    budget_cost_cents: budgetTotal,
    forecast_cost_cents: forecastCost,
    gross_profit_cents,
    gross_margin_pct:       pctOrNull(gross_profit_cents, invoices.billed_cents),
    projected_profit_cents,
    projected_margin_pct:   pctOrNull(projected_profit_cents, contractValue),
  };
}

router.get('/projects/:id/pnl', requireAuth, requireProjectFinancialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const project = await assertProjectInCompany(companyId, req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const settings = await loadSettings(companyId);
    const pnl = await computeProjectPnl(req.params.id, companyId, settings);

    // If the job's close-out has frozen a final snapshot, hand it back too so
    // the UI can show the locked number alongside the (still-live) figures.
    let locked = null;
    try {
      const lr = await pool.query(
        'SELECT final_financials, financials_snapshot_at FROM project_closeouts WHERE project_id = $1',
        [req.params.id]
      );
      if (lr.rows[0]?.final_financials) {
        locked = { ...lr.rows[0].final_financials, snapshot_at: lr.rows[0].financials_snapshot_at };
      }
    } catch { /* closeout table/columns may not exist yet */ }

    res.json({
      project_id: parseInt(req.params.id, 10),
      project_name: project.name,
      ...pnl,
      locked,
    });
  } catch (err) {
    req.log.error({ err }, 'project pnl error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── P&L: portfolio summary ────────────────────────────────────────────────────

router.get('/projects/pnl-summary', requireAuth, requireFinancialReportsAccess, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const projRes = await pool.query(
      'SELECT id, name FROM projects WHERE company_id = $1 AND active = true ORDER BY name',
      [companyId]
    );
    // For each project, run the same lookups. Sequential keeps the SQL
    // load reasonable (portfolio is dozens of projects max for most companies).
    const settings = await loadSettings(companyId);
    const rows = [];
    for (const p of projRes.rows) {
      const [contractValue, spend, invoices, budgetTotal] = await Promise.all([
        contractValueCents(p.id),
        spendTotals(p.id, settings),
        invoiceTotals(p.id, companyId),
        budgetTotalCents(p.id),
      ]);
      const gross_profit_cents     = invoices.billed_cents - spend.spent_cents;
      // EAC forecast: max(spent+committed, budget) — same as the per-project P&L.
      const projected_profit_cents = contractValue - Math.max(spend.spent_cents + spend.committed_cents, budgetTotal || 0);
      rows.push({
        project_id:             p.id,
        name:                   p.name,
        contract_value_cents:   contractValue,
        revenue_billed_cents:   invoices.billed_cents,
        cost_spent_cents:       spend.spent_cents,
        cost_committed_cents:   spend.committed_cents,
        gross_profit_cents,
        projected_profit_cents,
        gross_margin_pct:       pctOrNull(gross_profit_cents,     invoices.billed_cents),
        projected_margin_pct:   pctOrNull(projected_profit_cents, contractValue),
      });
    }
    res.json({ projects: rows });
  } catch (err) {
    req.log.error({ err }, 'portfolio pnl error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── WIP report ────────────────────────────────────────────────────────────────

router.get('/wip-report', requireAuth, requireFinancialReportsAccess, async (req, res) => {
  const companyId = req.user.company_id;
  const include = (req.query.include || 'active').toString();
  // as_of is accepted as a YYYY-MM-DD string but in this minimal v1 we
  // ignore it for the rollup — every spend/invoice query already reads
  // current state. Historical snapshots are a follow-up.
  const whereActive = include === 'all' ? '' :
                      include === 'archived' ? 'AND active = false' :
                      'AND active = true';
  try {
    const projRes = await pool.query(
      `SELECT id, name FROM projects WHERE company_id = $1 ${whereActive} ORDER BY name`,
      [companyId]
    );
    const settings = await loadSettings(companyId);
    const rows = [];
    let totalContract = 0, totalCost = 0, totalEarned = 0, totalBilled = 0;
    for (const p of projRes.rows) {
      const [contractValue, spend, invoices, budgetSum] = await Promise.all([
        contractValueCents(p.id),
        spendTotals(p.id, settings),
        invoiceTotals(p.id, companyId),
        (async () => {
          try {
            const r = await pool.query(
              'SELECT COALESCE(SUM(budget_cents),0)::bigint AS sum FROM project_budget_categories WHERE project_id = $1',
              [p.id]
            );
            return parseInt(r.rows[0].sum, 10);
          } catch { return 0; }
        })(),
      ]);
      // Cost-to-cost % complete. Use budget as the denominator (matches
      // the "estimated total cost" the cost-to-cost convention expects).
      // Fall back to contract value if no budget set.
      const denom = budgetSum > 0 ? budgetSum : contractValue;
      const pctComplete = denom > 0
        ? Math.min(100, Math.round((spend.spent_cents / denom) * 100 * 10) / 10)
        : null;
      const earnedRevenue = pctComplete == null ? 0 : Math.round(contractValue * (pctComplete / 100));
      const overUnder = invoices.billed_cents - earnedRevenue;
      const status = overUnder == null ? null :
                     Math.abs(overUnder) <= earnedRevenue * 0.05 ? 'on_target' :
                     overUnder > 0 ? 'over_billed' : 'under_billed';
      rows.push({
        project_id:              p.id,
        name:                    p.name,
        contract_value_cents:    contractValue,
        budgeted_cost_cents:     budgetSum,
        cost_to_date_cents:      spend.spent_cents,
        pct_complete:            pctComplete,
        earned_revenue_cents:    earnedRevenue,
        billed_to_date_cents:    invoices.billed_cents,
        over_under_billed_cents: overUnder,
        status,
      });
      totalContract += contractValue;
      totalCost     += spend.spent_cents;
      totalEarned   += earnedRevenue;
      totalBilled   += invoices.billed_cents;
    }
    res.json({
      as_of: req.query.as_of || new Date().toISOString().slice(0, 10),
      projects: rows,
      totals: {
        contract_value_cents:    totalContract,
        cost_to_date_cents:      totalCost,
        earned_revenue_cents:    totalEarned,
        billed_to_date_cents:    totalBilled,
        over_under_billed_cents: totalBilled - totalEarned,
      },
    });
  } catch (err) {
    req.log.error({ err }, 'wip report error');
    res.status(500).json({ error: 'Server error' });
  }
});

// CSV export — minimal, no XLSX dep. Same shape as the JSON.
router.get('/wip-report/export', requireAuth, requireFinancialReportsAccess, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const projRes = await pool.query(
      `SELECT id, name FROM projects WHERE company_id = $1 AND active = true ORDER BY name`,
      [companyId]
    );
    const headers = [
      'Project', 'Contract Value', 'Budgeted Cost', 'Cost to Date',
      '% Complete', 'Earned Revenue', 'Billed to Date', 'Over/Under Billed',
    ];
    const csvSettings = await loadSettings(companyId);
    const dollars = c => (c / 100).toFixed(2);
    const escape = csvCell; // RFC-4180 quoting + spreadsheet formula-injection guard
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="wip-report-${new Date().toISOString().slice(0,10)}.csv"`);
    res.write(headers.join(',') + '\n');
    for (const p of projRes.rows) {
      const [contractValue, spend, invoices, budgetSum] = await Promise.all([
        contractValueCents(p.id), spendTotals(p.id, csvSettings), invoiceTotals(p.id, companyId),
        (async () => {
          try {
            const r = await pool.query(
              'SELECT COALESCE(SUM(budget_cents),0)::bigint AS sum FROM project_budget_categories WHERE project_id = $1',
              [p.id]
            );
            return parseInt(r.rows[0].sum, 10);
          } catch { return 0; }
        })(),
      ]);
      // Match the JSON path exactly: cap at 100, round to 1 decimal.
      // Previously the CSV used an uncapped float-then-toFixed(1) so a
      // 138% blown budget would CSV as "138.4" while the JSON capped to
      // "100.0" — confusing for anyone reconciling the two.
      const denom = budgetSum > 0 ? budgetSum : contractValue;
      const pctComplete = denom > 0
        ? Math.min(100, Math.round((spend.spent_cents / denom) * 100 * 10) / 10)
        : 0;
      const earnedRevenue = Math.round(contractValue * (pctComplete / 100));
      const overUnder = invoices.billed_cents - earnedRevenue;
      res.write([
        escape(p.name),
        dollars(contractValue),
        dollars(budgetSum),
        dollars(spend.spent_cents),
        pctComplete.toFixed(1),
        dollars(earnedRevenue),
        dollars(invoices.billed_cents),
        dollars(overUnder),
      ].join(',') + '\n');
    }
    res.end();
  } catch (err) {
    req.log.error({ err }, 'wip csv export error');
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.computeProjectPnl = computeProjectPnl;
