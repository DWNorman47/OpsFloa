const router = require('express').Router();
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

function uuidOrNull(value) {
  if (!value) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value))
    ? value
    : null;
}

// ── Templates ─────────────────────────────────────────────────────────────────

// GET /inspections/templates
router.get('/templates', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM inspection_templates WHERE company_id = $1 ORDER BY created_at DESC',
      [req.user.company_id]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /inspections/templates
router.post('/templates', requireAdmin, async (req, res) => {
  const { name, description, items } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const result = await pool.query(
      `INSERT INTO inspection_templates (company_id, name, description, items, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.company_id, name.trim(), description || null, JSON.stringify(items || []), req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /inspections/templates/:id
router.patch('/templates/:id', requireAdmin, async (req, res) => {
  const { name, description, items } = req.body;
  try {
    const existing = await pool.query(
      'SELECT * FROM inspection_templates WHERE id=$1 AND company_id=$2',
      [req.params.id, req.user.company_id]
    );
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Template not found' });
    const t = existing.rows[0];
    const result = await pool.query(
      `UPDATE inspection_templates SET name=$1, description=$2, items=$3, updated_at=NOW()
       WHERE id=$4 AND company_id=$5 RETURNING *`,
      [name?.trim() ?? t.name, description ?? t.description, JSON.stringify(items ?? t.items),
       req.params.id, req.user.company_id]
    );
    res.json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /inspections/templates/:id
router.delete('/templates/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM inspection_templates WHERE id=$1 AND company_id=$2 RETURNING id',
      [req.params.id, req.user.company_id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Template not found' });
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// ── Inspections ───────────────────────────────────────────────────────────────

// GET /inspections
router.get('/', requireAuth, async (req, res) => {
  const { project_id, status, from, to, template_id } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const conditions = ['i.company_id = $1'];
  const params = [req.user.company_id];
  if (project_id) { params.push(project_id); conditions.push(`i.project_id::text = $${params.length}::text`); }
  if (status) {
    if (!['pass', 'fail', 'pending'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    params.push(status); conditions.push(`i.status = $${params.length}`);
  }
  if (template_id) { params.push(template_id); conditions.push(`i.template_id = $${params.length}`); }
  if (from) { params.push(from); conditions.push(`i.inspected_at >= $${params.length}`); }
  if (to) { params.push(to); conditions.push(`i.inspected_at <= $${params.length}`); }
  const where = conditions.join(' AND ');
  try {
    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM inspections i WHERE ${where}`, params),
      pool.query(
        `SELECT i.*, p.name AS project_name, u.full_name AS created_by_name
         FROM inspections i
         LEFT JOIN projects p ON i.project_id::text = p.id::text
         LEFT JOIN users u ON i.created_by::text = u.id::text
         WHERE ${where} ORDER BY i.inspected_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    const total = parseInt(countResult.rows[0].count);
    res.json({ items: dataResult.rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /inspections
router.post('/', requireAdmin, async (req, res) => {
  const VALID_STATUSES = ['pass', 'fail', 'pending'];
  const { template_id, project_id, results, status, inspected_at } = req.body;
  const name = req.body.name?.trim();
  const inspector = req.body.inspector?.trim() || null;
  const location = req.body.location?.trim() || null;
  const notes = req.body.notes?.trim() || null;
  if (!name || !inspected_at) {
    return res.status(400).json({ error: 'name and inspected_at are required' });
  }
  if (name.length > 255) return res.status(400).json({ error: 'name too long (max 255 characters)' });
  if (inspector && inspector.length > 255) return res.status(400).json({ error: 'inspector too long (max 255 characters)' });
  if (location && location.length > 255) return res.status(400).json({ error: 'location too long (max 255 characters)' });
  if (notes && notes.length > 1000) return res.status(400).json({ error: 'notes too long (max 1000 characters)' });
  if (status && !VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'status must be pass, fail, or pending' });
  try {
    // template_id is a live FK to the company's inspection_templates — verify ownership so
    // a foreign template id can't be attached (and its structure rendered) on this inspection.
    if (template_id != null) {
      const tpl = await pool.query('SELECT id FROM inspection_templates WHERE id = $1 AND company_id = $2', [template_id, req.user.company_id]);
      if (tpl.rowCount === 0) return res.status(400).json({ error: 'Template not found' });
    }
    const result = await pool.query(
      `INSERT INTO inspections (company_id, template_id, project_id, name, inspector, location,
         notes, results, status, inspected_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.user.company_id, template_id || null, uuidOrNull(project_id), name,
       inspector, location, notes,
       JSON.stringify(results || {}), status || 'pass', inspected_at, uuidOrNull(req.user.id)]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /inspections/:id
router.patch('/:id', requireAdmin, async (req, res) => {
  const VALID_STATUSES = ['pass', 'fail', 'pending'];
  const { project_id, results, status, inspected_at } = req.body;
  const name = req.body.name !== undefined ? (req.body.name?.trim() || null) : undefined;
  const inspector = req.body.inspector !== undefined ? (req.body.inspector?.trim() || null) : undefined;
  const location = req.body.location !== undefined ? (req.body.location?.trim() || null) : undefined;
  const notes = req.body.notes !== undefined ? (req.body.notes?.trim() || null) : undefined;
  if (name !== undefined && name && name.length > 255) return res.status(400).json({ error: 'name too long (max 255 characters)' });
  if (inspector !== undefined && inspector && inspector.length > 255) return res.status(400).json({ error: 'inspector too long (max 255 characters)' });
  if (location !== undefined && location && location.length > 255) return res.status(400).json({ error: 'location too long (max 255 characters)' });
  if (notes !== undefined && notes && notes.length > 1000) return res.status(400).json({ error: 'notes too long (max 1000 characters)' });
  if (status !== undefined && !VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'status must be pass, fail, or pending' });
  try {
    const existing = await pool.query(
      'SELECT * FROM inspections WHERE id=$1 AND company_id=$2',
      [req.params.id, req.user.company_id]
    );
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Inspection not found' });
    const ins = existing.rows[0];
    const result = await pool.query(
      `UPDATE inspections SET project_id=$1, name=$2, inspector=$3, location=$4,
         notes=$5, results=$6, status=$7, inspected_at=$8, updated_at=NOW()
       WHERE id=$9 AND company_id=$10 RETURNING *`,
      [project_id !== undefined ? uuidOrNull(project_id) : ins.project_id, name ?? ins.name, inspector ?? ins.inspector,
       location ?? ins.location, notes ?? ins.notes,
       JSON.stringify(results ?? ins.results), status ?? ins.status,
       inspected_at ?? ins.inspected_at, req.params.id, req.user.company_id]
    );
    res.json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /inspections/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM inspections WHERE id=$1 AND company_id=$2 RETURNING id',
      [req.params.id, req.user.company_id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Inspection not found' });
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
