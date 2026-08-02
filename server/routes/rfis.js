const router = require('express').Router();
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { projectBelongsToCompany } = require('../utils/tenantRefs');

const FULL_SELECT = `
  SELECT r.*, p.name AS project_name, u.full_name AS created_by_name
  FROM rfis r
  LEFT JOIN projects p ON r.project_id = p.id
  LEFT JOIN users u ON r.created_by = u.id`;

// GET /rfis
router.get('/', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const { project_id, status, from, to } = req.query;
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const conditions = ['r.company_id = $1'];
  const params = [companyId];
  if (project_id) { params.push(project_id); conditions.push(`r.project_id = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`r.status = $${params.length}`); }
  if (from) { params.push(from); conditions.push(`r.date_submitted >= $${params.length}`); }
  if (to) { params.push(to); conditions.push(`r.date_submitted <= $${params.length}`); }
  const where = conditions.join(' AND ');
  try {
    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM rfis r WHERE ${where}`, params),
      pool.query(
        `${FULL_SELECT} WHERE ${where} ORDER BY r.rfi_number DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    const total = parseInt(countResult.rows[0].count);
    res.json({ items: dataResult.rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /rfis — create with auto-number
router.post('/', requireAdmin, async (req, res) => {
  const { project_id, date_submitted, date_due } = req.body;
  const subject = req.body.subject?.trim();
  const description = req.body.description?.trim() || null;
  const directed_to = req.body.directed_to?.trim() || null;
  const submitted_by = req.body.submitted_by?.trim() || null;
  if (!subject || !date_submitted) {
    return res.status(400).json({ error: 'subject and date_submitted are required' });
  }
  if (subject.length > 255) return res.status(400).json({ error: 'subject too long (max 255 characters)' });
  if (directed_to && directed_to.length > 255) return res.status(400).json({ error: 'directed_to too long (max 255 characters)' });
  if (submitted_by && submitted_by.length > 255) return res.status(400).json({ error: 'submitted_by too long (max 255 characters)' });
  if (description && description.length > 2000) return res.status(400).json({ error: 'description too long (max 2000 characters)' });
  const companyId = req.user.company_id;
  // A supplied project must belong to this company — else a foreign project_id is stored and
  // its name leaked back via the projects JOIN on read.
  if (project_id != null && project_id !== '' && !(await projectBelongsToCompany(pool, project_id, companyId))) {
    return res.status(400).json({ error: 'Invalid project' });
  }
  try {
    // Auto-number atomically: subquery inside INSERT so concurrent requests can't
    // both read the same MAX and produce duplicate rfi_number values.
    const result = await pool.query(
      `INSERT INTO rfis (company_id, project_id, rfi_number, subject, description, directed_to,
         submitted_by, date_submitted, date_due, created_by)
       VALUES ($1,$2,(SELECT COALESCE(MAX(rfi_number),0)+1 FROM rfis WHERE company_id=$1),$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [companyId, project_id || null, subject, description,
       directed_to, submitted_by, date_submitted,
       date_due || null, req.user.id]
    );
    const full = await pool.query(`${FULL_SELECT} WHERE r.id = $1`, [result.rows[0].id]);
    res.status(201).json(full.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /rfis/:id — update (edit fields or add response)
router.patch('/:id', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const { project_id, date_submitted, date_due, status } = req.body;
  const subject = req.body.subject !== undefined ? (req.body.subject?.trim() || null) : undefined;
  const description = req.body.description !== undefined ? (req.body.description?.trim() || null) : undefined;
  const directed_to = req.body.directed_to !== undefined ? (req.body.directed_to?.trim() || null) : undefined;
  const submitted_by = req.body.submitted_by !== undefined ? (req.body.submitted_by?.trim() || null) : undefined;
  const response = req.body.response !== undefined ? (req.body.response?.trim() || null) : undefined;
  const VALID_STATUSES = ['open', 'answered', 'closed'];
  if (status !== undefined && !VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status value' });
  if (subject !== undefined && subject && subject.length > 255) return res.status(400).json({ error: 'subject too long (max 255 characters)' });
  if (directed_to !== undefined && directed_to && directed_to.length > 255) return res.status(400).json({ error: 'directed_to too long (max 255 characters)' });
  if (submitted_by !== undefined && submitted_by && submitted_by.length > 255) return res.status(400).json({ error: 'submitted_by too long (max 255 characters)' });
  if (description !== undefined && description && description.length > 2000) return res.status(400).json({ error: 'description too long (max 2000 characters)' });
  if (response !== undefined && response && response.length > 2000) return res.status(400).json({ error: 'response too long (max 2000 characters)' });
  const { updated_at: clientUpdatedAt } = req.body;
  try {
    const existing = await pool.query('SELECT * FROM rfis WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'RFI not found' });
    const r = existing.rows[0];

    if (project_id != null && project_id !== '' && !(await projectBelongsToCompany(pool, project_id, companyId))) {
      return res.status(400).json({ error: 'Invalid project' });
    }

    if (clientUpdatedAt && new Date(r.updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({ error: 'conflict' });
    }

    // Auto-set status to 'answered' when response is added
    let newStatus = status ?? r.status;
    if (response && r.status === 'open') newStatus = 'answered';

    const result = await pool.query(
      `UPDATE rfis SET project_id=$1, subject=$2, description=$3, directed_to=$4, submitted_by=$5,
         date_submitted=$6, date_due=$7, response=$8, status=$9, updated_at=NOW()
       WHERE id=$10 AND company_id=$11 RETURNING *`,
      [project_id ?? r.project_id, subject ?? r.subject, description ?? r.description,
       directed_to ?? r.directed_to, submitted_by ?? r.submitted_by,
       date_submitted ?? r.date_submitted, date_due ?? r.date_due,
       response ?? r.response, newStatus, req.params.id, companyId]
    );
    const full = await pool.query(`${FULL_SELECT} WHERE r.id = $1`, [req.params.id]);
    res.json(full.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /rfis/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM rfis WHERE id=$1 AND company_id=$2 RETURNING id',
      [req.params.id, req.user.company_id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'RFI not found' });
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
