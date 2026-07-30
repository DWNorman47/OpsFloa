const router = require('express').Router();
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendPushToUser } = require('../push');
const { projectBelongsToCompany, userBelongsToCompany } = require('../utils/tenantRefs');
const {
  PUNCHLIST_STATUSES: VALID_STATUSES,
  PUNCHLIST_PRIORITIES: VALID_PRIORITIES,
} = require('../constants/punchlistEnums');

// GET /punchlist
router.get('/', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const { project_id, status, priority, phase } = req.query;
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  try {
    const conditions = ['pi.company_id = $1'];
    const params = [companyId];

    if (project_id) { params.push(project_id); conditions.push(`pi.project_id = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`pi.status = $${params.length}`); }
    if (priority) { params.push(priority); conditions.push(`pi.priority = $${params.length}`); }
    if (phase) { params.push(phase); conditions.push(`pi.phase = $${params.length}`); }

    const where = conditions.join(' AND ');
    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(DISTINCT pi.id) FROM punchlist_items pi WHERE ${where}`, params),
      pool.query(
        `SELECT pi.*, p.name as project_name,
                creator.full_name as created_by_name,
                assignee.full_name as assigned_to_name,
                COUNT(ci.id) AS checklist_total,
                COUNT(ci.id) FILTER (WHERE ci.checked = true) AS checked_count
         FROM punchlist_items pi
         LEFT JOIN projects p ON pi.project_id = p.id
         LEFT JOIN users creator ON pi.created_by = creator.id
         LEFT JOIN users assignee ON pi.assigned_to = assignee.id
         LEFT JOIN punchlist_checklist_items ci ON ci.punchlist_id = pi.id
         WHERE ${where}
         GROUP BY pi.id, p.name, creator.full_name, assignee.full_name
         ORDER BY
           CASE pi.priority WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
           pi.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    const total = parseInt(countResult.rows[0].count);
    res.json({ items: dataResult.rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /punchlist
router.post('/', requireAuth, async (req, res) => {
  const { project_id, priority, assigned_to, phase } = req.body;
  const title = req.body.title?.trim();
  const description = req.body.description?.trim() || null;
  const location = req.body.location?.trim() || null;
  if (!title) return res.status(400).json({ error: 'title required' });
  if (title.length > 255) return res.status(400).json({ error: 'title too long (max 255 characters)' });
  if (description && description.length > 1000) return res.status(400).json({ error: 'description too long (max 1000 characters)' });
  if (location && location.length > 255) return res.status(400).json({ error: 'location too long (max 255 characters)' });
  if (priority !== undefined && !VALID_PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority value' });
  const companyId = req.user.company_id;

  try {
    if (!(await projectBelongsToCompany(pool, project_id, companyId))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!(await userBelongsToCompany(pool, assigned_to, companyId))) {
      return res.status(404).json({ error: 'Assignee not found' });
    }
    const result = await pool.query(
      `INSERT INTO punchlist_items
         (company_id, project_id, title, description, location, priority, assigned_to, created_by, phase)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [companyId, project_id || null, title, description, location,
       priority || 'normal', assigned_to || null, req.user.id, phase || null]
    );
    const id = result.rows[0].id;
    const full = await pool.query(
      `SELECT pi.*, p.name as project_name, creator.full_name as created_by_name,
              assignee.full_name as assigned_to_name
       FROM punchlist_items pi
       LEFT JOIN projects p ON pi.project_id = p.id
       LEFT JOIN users creator ON pi.created_by = creator.id
       LEFT JOIN users assignee ON pi.assigned_to = assignee.id
       WHERE pi.id = $1`,
      [id]
    );
    const item = full.rows[0];
    if (assigned_to) {
      sendPushToUser(assigned_to, {
        title: 'Punchlist item assigned',
        body: item.title,
        url: '/field#punchlist',
      });
    }
    res.status(201).json(item);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /punchlist/:id
router.patch('/:id', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const { project_id, priority, status, assigned_to, phase } = req.body;
  const title = req.body.title !== undefined ? (req.body.title?.trim() || null) : undefined;
  const description = req.body.description !== undefined ? (req.body.description?.trim() || null) : undefined;
  const location = req.body.location !== undefined ? (req.body.location?.trim() || null) : undefined;

  if (status   !== undefined && !VALID_STATUSES.includes(status))   return res.status(400).json({ error: 'Invalid status value' });
  if (priority !== undefined && !VALID_PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority value' });

  const clientUpdatedAt = req.body.updated_at || null;
  try {
    const existing = await pool.query(
      'SELECT * FROM punchlist_items WHERE id=$1 AND company_id=$2', [req.params.id, companyId]
    );
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Not found' });

    if (clientUpdatedAt && new Date(existing.rows[0].updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({ error: 'conflict' });
    }
    if (project_id !== undefined && !(await projectBelongsToCompany(pool, project_id, companyId))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (assigned_to !== undefined && !(await userBelongsToCompany(pool, assigned_to, companyId))) {
      return res.status(404).json({ error: 'Assignee not found' });
    }

    const resolvedAt = status === 'verified' && existing.rows[0].status !== 'verified'
      ? new Date() : existing.rows[0].resolved_at;

    await pool.query(
      `UPDATE punchlist_items SET
          title=COALESCE($1, title), description=COALESCE($2, description),
          location=COALESCE($3, location), priority=COALESCE($4, priority),
          status=COALESCE($5, status), assigned_to=$6,
          resolved_at=$7, updated_at=NOW(), phase=$8, project_id=$9
        WHERE id=$10`,
      [title, description, location, priority, status,
       assigned_to !== undefined ? (assigned_to || null) : existing.rows[0].assigned_to,
       resolvedAt,
       phase !== undefined ? (phase || null) : existing.rows[0].phase,
       project_id !== undefined ? (project_id || null) : existing.rows[0].project_id,
       req.params.id]
    );

    const full = await pool.query(
      `SELECT pi.*, p.name as project_name, creator.full_name as created_by_name,
              assignee.full_name as assigned_to_name
       FROM punchlist_items pi
       LEFT JOIN projects p ON pi.project_id = p.id
       LEFT JOIN users creator ON pi.created_by = creator.id
       LEFT JOIN users assignee ON pi.assigned_to = assignee.id
       WHERE pi.id = $1`,
      [req.params.id]
    );
    const updated = full.rows[0];
    // Notify newly assigned worker (only if assignment changed)
    const newAssignee = assigned_to !== undefined ? (assigned_to || null) : existing.rows[0].assigned_to;
    if (newAssignee && newAssignee !== existing.rows[0].assigned_to) {
      sendPushToUser(newAssignee, {
        title: 'Punchlist item assigned',
        body: updated.title,
        url: '/field#punchlist',
      });
    }
    res.json(updated);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /punchlist/:id/checklist
router.get('/:id/checklist', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    // Verify item belongs to company
    const item = await pool.query('SELECT id FROM punchlist_items WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (item.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    const result = await pool.query(
      'SELECT * FROM punchlist_checklist_items WHERE punchlist_id=$1 ORDER BY order_index, created_at',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /punchlist/:id/checklist
router.post('/:id/checklist', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  try {
    const item = await pool.query('SELECT id FROM punchlist_items WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (item.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    const maxOrder = await pool.query('SELECT COALESCE(MAX(order_index),0) as m FROM punchlist_checklist_items WHERE punchlist_id=$1', [req.params.id]);
    const result = await pool.query(
      'INSERT INTO punchlist_checklist_items (punchlist_id, text, order_index) VALUES ($1,$2,$3) RETURNING *',
      [req.params.id, text.trim(), parseInt(maxOrder.rows[0].m) + 1]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /punchlist/:id/checklist/:checkId
router.patch('/:id/checklist/:checkId', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const { checked, text } = req.body;
  try {
    const item = await pool.query('SELECT id FROM punchlist_items WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (item.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    const result = await pool.query(
      `UPDATE punchlist_checklist_items SET
         checked = CASE WHEN $1::boolean IS NOT NULL THEN $1 ELSE checked END,
         text = COALESCE($2, text)
       WHERE id=$3 AND punchlist_id=$4 RETURNING *`,
      [checked !== undefined ? checked : null, text?.trim() || null, req.params.checkId, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /punchlist/:id/checklist/:checkId
router.delete('/:id/checklist/:checkId', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const item = await pool.query('SELECT id FROM punchlist_items WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (item.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    const result = await pool.query(
      'DELETE FROM punchlist_checklist_items WHERE id=$1 AND punchlist_id=$2 RETURNING id',
      [req.params.checkId, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /punchlist/:id
router.delete('/:id', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  const cond = isAdmin ? 'company_id=$2' : 'company_id=$2 AND created_by=$3';
  const params = isAdmin ? [req.params.id, companyId] : [req.params.id, companyId, req.user.id];

  try {
    const result = await pool.query(
      `DELETE FROM punchlist_items WHERE id=$1 AND ${cond} RETURNING id`, params
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
