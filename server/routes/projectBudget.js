// Per-project budget category CRUD. Phase 2 of the project money flow:
// the seven categories run through estimate_lines, project_budget_categories,
// change_order_lines, project_expenses — same vocabulary everywhere.
// This route lets admins read and update the budgets after an estimate
// conversion seeds them.

const router = require('express').Router();
const pool   = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../auditLog');
const { MONEY_CATEGORIES } = require('../constants/projectMoneyEnums');

async function assertProjectInCompany(companyId, projectId) {
  const r = await pool.query(
    'SELECT id, name FROM projects WHERE id = $1 AND company_id = $2',
    [projectId, companyId]
  );
  return r.rows[0] || null;
}

// GET /projects/:id/budget — list category rows + the legacy total.
router.get('/projects/:id/budget', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const project = await assertProjectInCompany(companyId, req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const r = await pool.query(
      'SELECT id, category, budget_cents, budget_alert_pct, notes FROM project_budget_categories WHERE project_id = $1 ORDER BY category',
      [req.params.id]
    );
    // Make zero-rows explicit so the client can always render the seven
    // possible buckets without doing the merge itself.
    const byCat = new Map(r.rows.map(row => [row.category, row]));
    const categories = MONEY_CATEGORIES.map(category => byCat.get(category) || {
      id: null,
      category,
      budget_cents: 0,
      budget_alert_pct: null,
      notes: null,
    });
    const total_cents = categories.reduce((sum, c) => sum + parseInt(c.budget_cents, 10), 0);
    res.json({ project_id: parseInt(req.params.id, 10), categories, total_cents });
  } catch (err) {
    req.log.error({ err }, 'project budget read error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /projects/:id/budget — bulk replace the seven category rows.
router.put('/projects/:id/budget', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  if (!Array.isArray(req.body.categories)) {
    return res.status(400).json({ error: 'categories must be an array' });
  }
  // Validate first. Empty array is legal — admin can clear a budget.
  const cleaned = [];
  for (const c of req.body.categories) {
    if (!c || !MONEY_CATEGORIES.includes(c.category)) {
      return res.status(400).json({ error: `unknown category '${c?.category}'` });
    }
    const cents = typeof c.budget_cents === 'number' ? c.budget_cents : parseInt(c.budget_cents, 10);
    if (!Number.isFinite(cents) || cents < 0) {
      return res.status(400).json({ error: `invalid budget_cents for ${c.category}` });
    }
    const alertPct = c.budget_alert_pct == null ? null : parseInt(c.budget_alert_pct, 10);
    if (alertPct !== null && (!Number.isFinite(alertPct) || alertPct <= 0 || alertPct > 200)) {
      return res.status(400).json({ error: `invalid budget_alert_pct for ${c.category}` });
    }
    cleaned.push({
      category: c.category,
      budget_cents: cents,
      budget_alert_pct: alertPct,
      notes: c.notes || null,
    });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const project = await client.query(
      'SELECT id, name FROM projects WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [req.params.id, companyId]
    );
    if (project.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Project not found' });
    }
    // Upsert one row per submitted category. Categories not in the
    // submission keep their stored value (admin who patches just labor
    // doesn't clobber subs). To delete a category, pass it with
    // budget_cents = 0 explicitly — the row stays but tracks 0.
    for (const c of cleaned) {
      await client.query(
        `INSERT INTO project_budget_categories (project_id, category, budget_cents, budget_alert_pct, notes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (project_id, category) DO UPDATE SET
           budget_cents     = EXCLUDED.budget_cents,
           budget_alert_pct = EXCLUDED.budget_alert_pct,
           notes            = EXCLUDED.notes`,
        [req.params.id, c.category, c.budget_cents, c.budget_alert_pct, c.notes]
      );
    }
    // Keep projects.budget_dollars in sync with the sum during the
    // transition window so legacy reads still work.
    const totalRes = await client.query(
      'SELECT COALESCE(SUM(budget_cents), 0)::bigint AS sum FROM project_budget_categories WHERE project_id = $1',
      [req.params.id]
    );
    await client.query(
      'UPDATE projects SET budget_dollars = $1, budget_alert_pct = NULL WHERE id = $2',
      [Math.round(parseInt(totalRes.rows[0].sum, 10) / 100), req.params.id]
    );
    await client.query('COMMIT');
    await logAudit(companyId, req.user.id, req.user.full_name,
      'project.budget.updated', 'project', req.params.id, project.rows[0].name,
      { categories: cleaned.length, total_cents: parseInt(totalRes.rows[0].sum, 10) });
    // Return the canonical seven-bucket view so the client can re-render.
    const final = await pool.query(
      'SELECT id, category, budget_cents, budget_alert_pct, notes FROM project_budget_categories WHERE project_id = $1 ORDER BY category',
      [req.params.id]
    );
    const byCat = new Map(final.rows.map(row => [row.category, row]));
    const categories = MONEY_CATEGORIES.map(category => byCat.get(category) || {
      id: null, category, budget_cents: 0, budget_alert_pct: null, notes: null,
    });
    const total_cents = categories.reduce((sum, c) => sum + parseInt(c.budget_cents, 10), 0);
    res.json({ project_id: parseInt(req.params.id, 10), categories, total_cents });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'project budget update error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
