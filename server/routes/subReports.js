const router = require('express').Router();
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { projectBelongsToCompany } = require('../utils/tenantRefs');

// GET /sub-reports
router.get('/', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const { project_id, from, to, sub_company } = req.query;
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  const conditions = ['s.company_id = $1'];
  const params = [companyId];

  if (project_id) { params.push(project_id); conditions.push(`s.project_id = $${params.length}`); }
  if (from) { params.push(from); conditions.push(`s.report_date >= $${params.length}`); }
  if (to) { params.push(to); conditions.push(`s.report_date <= $${params.length}`); }
  if (sub_company) { params.push(`%${sub_company}%`); conditions.push(`s.sub_company ILIKE $${params.length}`); }

  const where = conditions.join(' AND ');
  try {
    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM sub_reports s WHERE ${where}`, params),
      pool.query(
        `SELECT s.*, p.name as project_name, u.full_name as created_by_name
         FROM sub_reports s
         LEFT JOIN projects p ON s.project_id = p.id
         LEFT JOIN users u ON s.created_by = u.id
         WHERE ${where}
         ORDER BY s.report_date DESC, s.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    const total = parseInt(countResult.rows[0].count);
    res.json({ items: dataResult.rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /sub-reports
router.post('/', requireAdmin, async (req, res) => {
  const { project_id, report_date, headcount } = req.body;
  const sub_company = req.body.sub_company?.trim() || null;
  const foreman_name = req.body.foreman_name?.trim() || null;
  const work_performed = req.body.work_performed?.trim() || null;
  const notes = req.body.notes?.trim() || null;
  if (!report_date || !sub_company) {
    return res.status(400).json({ error: 'report_date and sub_company are required' });
  }
  if (sub_company.length > 255) return res.status(400).json({ error: 'sub_company too long (max 255 characters)' });
  if (foreman_name && foreman_name.length > 255) return res.status(400).json({ error: 'foreman_name too long (max 255 characters)' });
  if (work_performed && work_performed.length > 2000) return res.status(400).json({ error: 'work_performed too long (max 2000 characters)' });
  if (notes && notes.length > 1000) return res.status(400).json({ error: 'notes too long (max 1000 characters)' });
  const headcountVal = headcount != null && headcount !== '' ? parseInt(headcount) : null;
  if (headcountVal !== null && (isNaN(headcountVal) || headcountVal < 0)) return res.status(400).json({ error: 'headcount must be a non-negative integer' });
  const companyId = req.user.company_id;
  if (project_id != null && project_id !== '' && !(await projectBelongsToCompany(pool, project_id, companyId))) {
    return res.status(400).json({ error: 'Invalid project' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO sub_reports
         (company_id, project_id, report_date, sub_company, foreman_name, headcount, work_performed, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [companyId, project_id || null, report_date, sub_company,
       foreman_name || null, headcountVal,
       work_performed || null, notes || null, req.user.id]
    );
    const full = await pool.query(
      `SELECT s.*, p.name as project_name, u.full_name as created_by_name
       FROM sub_reports s
       LEFT JOIN projects p ON s.project_id = p.id
       LEFT JOIN users u ON s.created_by = u.id
       WHERE s.id = $1`,
      [result.rows[0].id]
    );
    res.status(201).json(full.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /sub-reports/:id
router.patch('/:id', requireAdmin, async (req, res) => {
  const { project_id, report_date, headcount } = req.body;
  const sub_company = req.body.sub_company?.trim() || null;
  const foreman_name = req.body.foreman_name !== undefined ? (req.body.foreman_name?.trim() || null) : undefined;
  const work_performed = req.body.work_performed !== undefined ? (req.body.work_performed?.trim() || null) : undefined;
  const notes = req.body.notes !== undefined ? (req.body.notes?.trim() || null) : undefined;
  if (!report_date || !sub_company) {
    return res.status(400).json({ error: 'report_date and sub_company are required' });
  }
  if (sub_company.length > 255) return res.status(400).json({ error: 'sub_company too long (max 255 characters)' });
  if (foreman_name && foreman_name.length > 255) return res.status(400).json({ error: 'foreman_name too long (max 255 characters)' });
  if (work_performed && work_performed.length > 2000) return res.status(400).json({ error: 'work_performed too long (max 2000 characters)' });
  if (notes && notes.length > 1000) return res.status(400).json({ error: 'notes too long (max 1000 characters)' });
  const headcountVal = headcount != null && headcount !== '' ? parseInt(headcount) : null;
  if (headcountVal !== null && (isNaN(headcountVal) || headcountVal < 0)) return res.status(400).json({ error: 'headcount must be a non-negative integer' });
  const companyId = req.user.company_id;
  if (project_id != null && project_id !== '' && !(await projectBelongsToCompany(pool, project_id, companyId))) {
    return res.status(400).json({ error: 'Invalid project' });
  }
  try {
    const result = await pool.query(
      `UPDATE sub_reports SET project_id=$1, report_date=$2, sub_company=$3, foreman_name=$4,
         headcount=$5, work_performed=$6, notes=$7
       WHERE id=$8 AND company_id=$9 RETURNING *`,
      [project_id || null, report_date, sub_company,
       foreman_name !== undefined ? foreman_name : null, headcountVal,
       work_performed !== undefined ? work_performed : null, notes !== undefined ? notes : null, req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Report not found' });
    const full = await pool.query(
      `SELECT s.*, p.name as project_name, u.full_name as created_by_name
       FROM sub_reports s
       LEFT JOIN projects p ON s.project_id = p.id
       LEFT JOIN users u ON s.created_by = u.id
       WHERE s.id = $1`,
      [req.params.id]
    );
    res.json(full.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /sub-reports/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM sub_reports WHERE id=$1 AND company_id=$2 RETURNING id',
      [req.params.id, req.user.company_id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Report not found' });
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
