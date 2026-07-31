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

// Coerce '' / undefined to null for optional value columns.
const nn = v => (v === '' || v === undefined ? null : v);
const num = v => (v === '' || v === null || v === undefined ? null : Number(v));
const int = v => {
  if (v === '' || v === null || v === undefined) return null;
  const parsed = Number(v);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : NaN;
};

function readBody(b) {
  const status = WORK_ORDER_STATUSES.includes(b.status) ? b.status : WORK_ORDER_STATUS_DEFAULT;
  const priority = WORK_ORDER_PRIORITIES.includes(b.priority) ? b.priority : WORK_ORDER_PRIORITY_DEFAULT;
  return {
    title: String(b.title || '').trim(),
    project_id: int(b.project_id),
    client_id: int(b.client_id),
    address: nn(b.address),
    status,
    priority,
    assigned_to: int(b.assigned_to),
    scheduled_at: nn(b.scheduled_at),
    description: nn(b.description),
    amount: num(b.amount),
  };
}

function bodyError(wo) {
  if (!wo.title) return 'A title is required.';
  if ([wo.project_id, wo.client_id, wo.assigned_to].some(Number.isNaN)) return 'Invalid project, customer, or assignee.';
  if (wo.amount !== null && (!Number.isFinite(wo.amount) || wo.amount < 0)) return 'Amount must be zero or greater.';
  return '';
}

async function referenceError(companyId, wo) {
  const refs = [
    ['projects', wo.project_id, 'Project'],
    ['clients', wo.client_id, 'Customer'],
    ['users', wo.assigned_to, 'Assignee'],
  ];
  for (const [table, id, label] of refs) {
    if (id === null) continue;
    const { rowCount } = await pool.query(
      `SELECT 1 FROM ${table} WHERE id = $1 AND company_id = $2`,
      [id, companyId],
    );
    if (!rowCount) return `${label} not found.`;
  }
  return '';
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
  const invalid = bodyError(wo);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    const invalidReference = await referenceError(req.user.company_id, wo);
    if (invalidReference) return res.status(400).json({ error: invalidReference });
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
  const invalid = bodyError(wo);
  if (invalid) return res.status(400).json({ error: invalid });
  try {
    const invalidReference = await referenceError(req.user.company_id, wo);
    if (invalidReference) return res.status(400).json({ error: invalidReference });
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

// PATCH /:id/status — field update: the assigned worker (or a manager) can move
// the status and edit the notes on their own work order, without manage_projects.
router.patch('/:id/status', async (req, res) => {
  const status = WORK_ORDER_STATUSES.includes(req.body && req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'Invalid status.' });
  const note = typeof (req.body && req.body.description) === 'string' ? req.body.description : null;
  try {
    const found = await pool.query(
      'SELECT assigned_to FROM work_orders WHERE id = $1 AND company_id = $2 AND active = true',
      [req.params.id, req.user.company_id],
    );
    if (!found.rows[0]) return res.status(404).json({ error: 'Work order not found.' });
    const isAssignee = found.rows[0].assigned_to === req.user.id;
    if (!isAssignee && !(await hasPerm(req, 'manage_projects'))) {
      return res.status(403).json({ error: 'You can only update a work order assigned to you.' });
    }
    const { rows } = await pool.query(
      `UPDATE work_orders SET
         status = $1,
         description = COALESCE($4, description),
         completed_at = CASE WHEN $1 = 'completed' AND completed_at IS NULL THEN NOW()
                             WHEN $1 <> 'completed' THEN NULL ELSE completed_at END,
         updated_at = NOW()
       WHERE id = $2 AND company_id = $3 AND active = true
       RETURNING *`,
      [status, req.params.id, req.user.company_id, note],
    );
    res.json(rows[0]);
  } catch (err) {
    if (req.log && req.log.error) req.log.error({ err }, 'work order status update failed');
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
