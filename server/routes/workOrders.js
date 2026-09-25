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
// Partial: only the fields present in the body are written, so a manager editing the
// priority doesn't rewrite the status a tech just set. Optimistic concurrency: when the
// client sends the row's updated_at, the UPDATE only applies if it still matches (checked
// in the WHERE, atomically) — otherwise 409 with the fresh row so the UI can reload it.
const PATCH_FIELDS = ['project_id', 'client_id', 'title', 'address', 'status', 'priority',
  'assigned_to', 'scheduled_at', 'description', 'amount'];
router.patch('/:id', requirePerm('manage_projects'), async (req, res) => {
  const body = req.body || {};
  const sent = PATCH_FIELDS.filter(k => Object.prototype.hasOwnProperty.call(body, k));
  if (sent.length === 0) return res.status(400).json({ error: 'Nothing to update.' });
  if (sent.includes('status') && !WORK_ORDER_STATUSES.includes(body.status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  if (sent.includes('priority') && !WORK_ORDER_PRIORITIES.includes(body.priority)) {
    return res.status(400).json({ error: 'Invalid priority.' });
  }
  const parsed = readBody(body);
  // bodyError validates a whole body; neutralize unsent fields so only the sent ones can
  // fail (title is only required when it is being changed).
  const check = { ...parsed, title: sent.includes('title') ? parsed.title : 'x' };
  for (const k of ['project_id', 'client_id', 'assigned_to', 'amount']) if (!sent.includes(k)) check[k] = null;
  const invalid = bodyError(check);
  if (invalid) return res.status(400).json({ error: invalid });
  if (sent.includes('scheduled_at') && parsed.scheduled_at !== null && isNaN(new Date(parsed.scheduled_at).getTime())) {
    return res.status(400).json({ error: 'Invalid scheduled time.' });
  }
  const expected = body.updated_at || null;
  if (expected && isNaN(new Date(expected).getTime())) return res.status(400).json({ error: 'Invalid updated_at.' });
  try {
    const refCheck = { project_id: null, client_id: null, assigned_to: null };
    for (const k of Object.keys(refCheck)) if (sent.includes(k)) refCheck[k] = parsed[k];
    const invalidReference = await referenceError(req.user.company_id, refCheck);
    if (invalidReference) return res.status(400).json({ error: invalidReference });

    const params = [];
    const sets = [];
    let statusParam = 0;
    for (const k of sent) {
      params.push(parsed[k]);
      sets.push(`${k}=$${params.length}`);
      if (k === 'status') statusParam = params.length;
    }
    if (statusParam) {
      sets.push(`completed_at = CASE WHEN $${statusParam} = 'completed' AND completed_at IS NULL THEN NOW()
                             WHEN $${statusParam} <> 'completed' THEN NULL ELSE completed_at END`);
    }
    params.push(req.params.id, req.user.company_id, expected);
    const n = params.length;
    const result = await pool.query(
      `UPDATE work_orders SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id=$${n - 2} AND company_id=$${n - 1} AND active = true
         AND ($${n}::timestamptz IS NULL OR date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $${n}::timestamptz))
       RETURNING *`,
      params,
    );
    if (!result.rows[0]) {
      const fresh = await pool.query(
        'SELECT * FROM work_orders WHERE id = $1 AND company_id = $2 AND active = true',
        [req.params.id, req.user.company_id],
      );
      if (!fresh.rows[0]) return res.status(404).json({ error: 'Work order not found.' });
      return res.status(409).json({
        error: 'This work order was changed by someone else. The latest version has been loaded.',
        code: 'work_order_conflict',
        current: fresh.rows[0],
      });
    }
    res.json(result.rows[0]);
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
