const router = require('express').Router();
const pool = require('../db');
const logger = require('../logger');
const { requireAuth } = require('../middleware/auth');
const { hasPerm } = require('../permissions');

// Money / accounting columns on a project row. Only callers who could read the same numbers
// through GET /projects/:id/budget (admin role + a Projects-module permission — mirrors
// requireProjectFinancialAccess in middleware/financialAccess.js) get them here; everyone
// else (workers picking a job to clock into) gets the row without them.
const FINANCIAL_PROJECT_FIELDS = [
  'budget_dollars', 'budget_hours', 'budget_alert_pct', 'prevailing_wage_rate',
  'qbo_class_id', 'qbo_customer_id',
];
const FINANCIAL_PERMS = ['view_projects', 'manage_projects', 'manage_project_visibility'];

async function canSeeProjectFinancials(req) {
  const role = req.user?.role;
  if (role !== 'admin' && role !== 'super_admin') return false;
  for (const key of FINANCIAL_PERMS) {
    if (await hasPerm(req, key)) return true;
  }
  return false;
}

function stripFinancials(row) {
  const out = { ...row };
  for (const f of FINANCIAL_PROJECT_FIELDS) delete out[f];
  return out;
}

router.get('/', requireAuth, async (req, res) => {
  try {
    // Per-project visibility:
    //   visible_to_user_ids IS NULL or empty → visible to everyone (default)
    //   non-empty array                     → only those user IDs
    // Admins and super_admins bypass the restriction (they see every project).
    const bypass = req.user.role === 'admin' || req.user.role === 'super_admin';
    const visibilityClause = bypass
      ? ''
      : ` AND (visible_to_user_ids IS NULL
               OR COALESCE(array_length(visible_to_user_ids, 1), 0) = 0
               OR $2 = ANY(visible_to_user_ids))`;
    const params = bypass ? [req.user.company_id] : [req.user.company_id, req.user.id];
    const result = await pool.query(
      `SELECT * FROM projects
        WHERE active = true AND company_id = $1
          AND priority <> 'hidden'
          ${visibilityClause}
        ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'low' THEN 2 ELSE 1 END, name LIMIT 500`,
      params
    );
    const full = await canSeeProjectFinancials(req);
    res.json(full ? result.rows : result.rows.map(stripFinancials));
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
