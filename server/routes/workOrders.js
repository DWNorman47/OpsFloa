/**
 * Work orders (Work module) — the dispatch/service atom beside Projects.
 *
 * Base functionality (not plan-gated), company-scoped. Mounted in index.js with
 * requireAuth, so req.user is set on every route. A work order optionally links
 * to a project (project_id) for warranty/T&M work; standalone = a service call.
 */

const router = require('express').Router();
const pool = require('../db');
const { hasPerm, requirePerm } = require('../permissions');
const {
  WORK_ORDER_STATUSES, WORK_ORDER_STATUS_DEFAULT,
  WORK_ORDER_PRIORITIES, WORK_ORDER_PRIORITY_DEFAULT,
} = require('../constants/workOrderEnums');

// Coerce '' / undefined to null for optional FK / value columns.
const nn = v => (v === '' || v === undefined ? null : v);
const num = v => (v === '' || v === null || v === undefined ? null : Number(v));

function readBody(b) {
  const status = WORK_ORDER_STATUSES.includes(b.status) ? b.status : WORK_ORDER_STATUS_DEFAULT;
  const priority = WORK_ORDER_PRIORITIES.includes(b.priority) ? b.priority : WORK_ORDER_PRIORITY_DEFAULT;
  return {
    title: String(b.title || '').trim(),
    project_id: nn(b.project_id),
    client_id: nn(b.client_id),
    address: nn(b.address),
    status,
    priority,
    assigned_to: nn(b.assigned_to),
    scheduled_at: nn(b.scheduled_at),
    description: nn(b.description),
    amount: num(b.amount),
  };
}

// GET /  — list (optional ?status= & ?project_id= filters)
router.get('/', async (req, res) => {
  try {
    const params = [req.user.company_id];
    let where = 'company_id = $1 AND active = true';
    // Managers (view_projects) see all; a field worker sees only their assigned jobs.
    if (!(await hasPerm(req, 'view_projects'))) {
      params.push(req.user.id);
      where += ` AND assigned_to = $${params.length}`;
    }
    if (req.query.status && WORK_ORDER_STATUSES.includes(req.query.status)) {
      params.push(req.query.status);
      where += ` AND status = $${params.length}`;
    }
    if (req.query.project_id) {
      params.push(parseInt(req.query.project_id, 10));
      where += ` AND project_id = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT * FROM work_orders WHERE ${where}
       ORDER BY (status IN ('completed','canceled')) ASC, COALESCE(scheduled_at, created_at) DESC`,
      params,
    );
    res.json(rows);
  } catch (err) {
    if (req.log && req.log.error) req.log.error({ err }, 'list work orders failed');
    res.status(500).json({ error: 'Could not load work orders.' });
  }
});

// GET /:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM work_orders WHERE id = $1 AND company_id = $2 AND active = true',
      [req.params.id, req.user.company_id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Work order not found.' });
    // Workers can only open a work order assigned to them (404 hides the rest).
    if (rows[0].assigned_to !== req.user.id && !(await hasPerm(req, 'view_projects'))) {
      return res.status(404).json({ error: 'Work order not found.' });
    }
    res.json(rows[0]);
  } catch (err) {
    if (req.log && req.log.error) req.log.error({ err }, 'get work order failed');
    res.status(500).json({ error: 'Could not load the work order.' });
  }
});

// POST /  — create (managers/dispatchers)
router.post('/', requirePerm('manage_projects'), async (req, res) => {
  const wo = readBody(req.body || {});
  if (!wo.title) return res.status(400).json({ error: 'A title is required.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO work_orders
         (company_id, project_id, client_id, title, address, status, priority,
          assigned_to, scheduled_at, description, amount, created_by,
          completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
          CASE WHEN $6 = 'completed' THEN NOW() ELSE NULL END)
       RETURNING *`,
      [req.user.company_id, wo.project_id, wo.client_id, wo.title, wo.address, wo.status,
        wo.priority, wo.assigned_to, wo.scheduled_at, wo.description, wo.amount, req.user.id],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (req.log && req.log.error) req.log.error({ err }, 'create work order failed');
    res.status(500).json({ error: 'Could not create the work order.' });
  }
});

// PATCH /:id  — update (managers/dispatchers)
router.patch('/:id', requirePerm('manage_projects'), async (req, res) => {
  const wo = readBody(req.body || {});
  if (!wo.title) return res.status(400).json({ error: 'A title is required.' });
  try {
    const { rows } = await pool.query(
      `UPDATE work_orders SET
         project_id=$1, client_id=$2, title=$3, address=$4, status=$5, priority=$6,
         assigned_to=$7, scheduled_at=$8, description=$9, amount=$10,
         completed_at = CASE WHEN $5 = 'completed' AND completed_at IS NULL THEN NOW()
                             WHEN $5 <> 'completed' THEN NULL ELSE completed_at END,
         updated_at = NOW()
       WHERE id=$11 AND company_id=$12 AND active = true
       RETURNING *`,
      [wo.project_id, wo.client_id, wo.title, wo.address, wo.status, wo.priority,
        wo.assigned_to, wo.scheduled_at, wo.description, wo.amount,
        req.params.id, req.user.company_id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Work order not found.' });
    res.json(rows[0]);
  } catch (err) {
    if (req.log && req.log.error) req.log.error({ err }, 'update work order failed');
    res.status(500).json({ error: 'Could not update the work order.' });
  }
});

// DELETE /:id  — soft delete (managers/dispatchers)
router.delete('/:id', requirePerm('manage_projects'), async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'UPDATE work_orders SET active = false, updated_at = NOW() WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id],
    );
    if (!rowCount) return res.status(404).json({ error: 'Work order not found.' });
    res.json({ ok: true });
  } catch (err) {
    if (req.log && req.log.error) req.log.error({ err }, 'delete work order failed');
    res.status(500).json({ error: 'Could not delete the work order.' });
  }
});

module.exports = router;
