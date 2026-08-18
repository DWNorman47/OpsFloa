const router = require('express').Router();
const pool = require('../db');
const logger = require('../logger');
const { requireAuth } = require('../middleware/auth');

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
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
