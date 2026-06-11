// P&L dashboard + WIP report — read-only aggregations on top of the
// estimates / budget / spend / invoices that are already in the DB.
// Math is small enough to keep in this file alongside the routes.

const router = require('express').Router();
const pool   = require('../db');
const { requireAuth } = require('../middleware/auth');
const { csvCell } = require('../utils/csv');

// ── Shared helpers ────────────────────────────────────────────────────────────

async function assertProjectInCompany(companyId, projectId) {
  const r = await pool.query(
    'SELECT id, name FROM projects WHERE id = $1 AND company_id = $2',
    [projectId, companyId]
  );
  return r.rows[0] || null;
}

// Sum invoice money for a project — returns cents.
// billed = SUM(amount) over any invoice (sent → has a number); we DON'T
//   exclude unknown because in QBO-synced flows unknown means "we don't
//   know yet" not "not sent"
// collected = SUM(amount - balance) — what actually came in
async function invoiceTotals(projectId) {
  try {
    const r = await pool.query(
      `SELECT
         COALESCE(SUM(amount), 0)            AS billed_dollars,
         COALESCE(SUM(amount - COALESCE(balance, 0)), 0) AS collected_dollars
       FROM project_invoices
       WHERE project_id = $1`,
      [projectId]
    );
    return {
      billed_cents:    Math.round(parseFloat(r.rows[0].billed_dollars) * 100),
      collected_cents: Math.round(parseFloat(r.rows[0].collected_dollars) * 100),
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
async function spendTotals(projectId) {
  let labor = 0;
  let materials = 0;
  let subsSpent = 0;
  let subsCommitted = 0;
  let manualExpenses = 0;
  // Labor
  try {
    const r = await pool.query(
      `SELECT COALESCE(SUM(
         GREATEST(0,
           (EXTRACT(EPOCH FROM (te.end_time - te.start_time)) / 3600.0)
           - COALESCE(te.break_minutes, 0) / 60.0
         ) * COALESCE(u.hourly_rate, 0)
       ), 0) AS dollars
         FROM time_entries te
         JOIN users u ON te.user_id = u.id
        WHERE te.project_id = $1
          AND te.status != 'rejected'
          AND te.start_time IS NOT NULL
          AND te.end_time IS NOT NULL`,
      [projectId]
    );
    labor = Math.round(parseFloat(r.rows[0].dollars) * 100);
  } catch { /* time_entries shape may differ */ }
  // Manual expenses
  try {
    const r = await pool.query(
      `SELECT COALESCE(SUM(amount_cents + tax_cents), 0)::bigint AS cents
         FROM project_expenses WHERE project_id = $1`,
      [projectId]
    );
    manualExpenses = parseInt(r.rows[0].cents, 10);
  } catch { /* table may not exist */ }
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
    spent_cents:     labor + manualExpenses + materials + subsSpent,
    committed_cents: subsCommitted,
    by_source: { labor, materials, subs_spent: subsSpent, subs_committed: subsCommitted, manual_expenses: manualExpenses },
  };
}

// Standard divide-with-null-guard: pct or null if denominator is zero.
function pctOrNull(num, den, decimals = 1) {
  if (!den) return null;
  return Math.round((num / den) * Math.pow(10, decimals + 2)) / Math.pow(10, decimals);
}

// ── P&L: per-project ──────────────────────────────────────────────────────────

router.get('/projects/:id/pnl', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const project = await assertProjectInCompany(companyId, req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const [contractValue, spend, invoices] = await Promise.all([
      contractValueCents(req.params.id),
      spendTotals(req.params.id),
      invoiceTotals(req.params.id),
    ]);

    // gross_profit = revenue billed − cost spent  (lagging actual)
    // projected_profit = contract value − (spent + committed)  (leading indicator)
    const gross_profit_cents     = invoices.billed_cents - spend.spent_cents;
    const projected_profit_cents = contractValue - (spend.spent_cents + spend.committed_cents);
    const gross_margin_pct       = pctOrNull(gross_profit_cents, invoices.billed_cents);
    const projected_margin_pct   = pctOrNull(projected_profit_cents, contractValue);

    res.json({
      project_id: parseInt(req.params.id, 10),
      project_name: project.name,
      contract_value_cents: contractValue,
      revenue: invoices,
      cost: spend,
      gross_profit_cents,
      gross_margin_pct,
      projected_profit_cents,
      projected_margin_pct,
    });
  } catch (err) {
    req.log.error({ err }, 'project pnl error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── P&L: portfolio summary ────────────────────────────────────────────────────

router.get('/projects/pnl-summary', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const projRes = await pool.query(
      'SELECT id, name FROM projects WHERE company_id = $1 AND active = true ORDER BY name',
      [companyId]
    );
    // For each project, run the same lookups. Sequential keeps the SQL
    // load reasonable (portfolio is dozens of projects max for most companies).
    const rows = [];
    for (const p of projRes.rows) {
      const [contractValue, spend, invoices] = await Promise.all([
        contractValueCents(p.id),
        spendTotals(p.id),
        invoiceTotals(p.id),
      ]);
      const gross_profit_cents     = invoices.billed_cents - spend.spent_cents;
      const projected_profit_cents = contractValue - (spend.spent_cents + spend.committed_cents);
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

router.get('/wip-report', requireAuth, async (req, res) => {
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
    const rows = [];
    let totalContract = 0, totalCost = 0, totalEarned = 0, totalBilled = 0;
    for (const p of projRes.rows) {
      const [contractValue, spend, invoices, budgetSum] = await Promise.all([
        contractValueCents(p.id),
        spendTotals(p.id),
        invoiceTotals(p.id),
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
router.get('/wip-report/export', requireAuth, async (req, res) => {
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
    const dollars = c => (c / 100).toFixed(2);
    const escape = csvCell; // RFC-4180 quoting + spreadsheet formula-injection guard
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="wip-report-${new Date().toISOString().slice(0,10)}.csv"`);
    res.write(headers.join(',') + '\n');
    for (const p of projRes.rows) {
      const [contractValue, spend, invoices, budgetSum] = await Promise.all([
        contractValueCents(p.id), spendTotals(p.id), invoiceTotals(p.id),
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
