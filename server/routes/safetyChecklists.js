const router = require('express').Router();
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { projectBelongsToCompany } = require('../utils/tenantRefs');

// ── Templates ──────────────────────────────────────────────────────────────────

// GET /safety-checklists/templates
router.get('/templates', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM safety_checklist_templates WHERE company_id=$1 ORDER BY name',
      [req.user.company_id]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /safety-checklists/templates
router.post('/templates', requireAdmin, async (req, res) => {
  const { name, description, items } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  try {
    const result = await pool.query(
      `INSERT INTO safety_checklist_templates (company_id, name, description, items, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.company_id, name.trim(), description?.trim() || null, JSON.stringify(items || []), req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /safety-checklists/templates/:id
router.patch('/templates/:id', requireAdmin, async (req, res) => {
  const { name, description, items } = req.body;
  try {
    const existing = await pool.query(
      'SELECT * FROM safety_checklist_templates WHERE id=$1 AND company_id=$2',
      [req.params.id, req.user.company_id]
    );
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    const t = existing.rows[0];
    const result = await pool.query(
      `UPDATE safety_checklist_templates SET
         name=$1, description=$2, items=$3, updated_at=NOW()
       WHERE id=$4 AND company_id=$5 RETURNING *`,
      [name?.trim() ?? t.name, description !== undefined ? (description?.trim() || null) : t.description,
       JSON.stringify(items ?? t.items), req.params.id, req.user.company_id]
    );
    res.json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /safety-checklists/templates/:id
router.delete('/templates/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM safety_checklist_templates WHERE id=$1 AND company_id=$2 RETURNING id',
      [req.params.id, req.user.company_id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// ── Submissions ────────────────────────────────────────────────────────────────

// GET /safety-checklists
router.get('/', requireAuth, async (req, res) => {
  const { project_id, from, to, template_id } = req.query;
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const conditions = ['s.company_id = $1'];
  const params = [req.user.company_id];
  if (project_id) { params.push(project_id); conditions.push(`s.project_id = $${params.length}`); }
  if (template_id) { params.push(template_id); conditions.push(`s.template_id = $${params.length}`); }
  if (from) { params.push(from); conditions.push(`s.check_date >= $${params.length}`); }
  if (to) { params.push(to); conditions.push(`s.check_date <= $${params.length}`); }
  const where = conditions.join(' AND ');
  try {
    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM safety_checklist_submissions s WHERE ${where}`, params),
      pool.query(
        `SELECT s.*, p.name AS project_name
         FROM safety_checklist_submissions s
         LEFT JOIN projects p ON s.project_id = p.id
         WHERE ${where}
         ORDER BY s.check_date DESC, s.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    const total = parseInt(countResult.rows[0].count);
    res.json({ items: dataResult.rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /safety-checklists
router.post('/', requireAuth, async (req, res) => {
  const { template_id, project_id, check_date, answers, notes } = req.body;
  if (!template_id) return res.status(400).json({ error: 'template_id required' });
  if (!check_date) return res.status(400).json({ error: 'check_date required' });
  try {
    const tmpl = await pool.query(
      'SELECT name FROM safety_checklist_templates WHERE id=$1 AND company_id=$2',
      [template_id, req.user.company_id]
    );
    if (tmpl.rowCount === 0) return res.status(404).json({ error: 'Template not found' });
    // A supplied project must belong to this company — else a foreign project_id is stored and
    // its name leaked back via the projects JOIN below.
    if (project_id != null && project_id !== '' && !(await projectBelongsToCompany(pool, project_id, req.user.company_id))) {
      return res.status(400).json({ error: 'Invalid project' });
    }
    const result = await pool.query(
      `INSERT INTO safety_checklist_submissions
         (company_id, template_id, template_name, project_id, submitted_by, submitted_by_name, check_date, answers, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.user.company_id, template_id, tmpl.rows[0].name,
       project_id || null, req.user.id, req.user.full_name,
       check_date, JSON.stringify(answers || {}), notes?.trim() || null]
    );
    const full = await pool.query(
      `SELECT s.*, p.name AS project_name FROM safety_checklist_submissions s
       LEFT JOIN projects p ON s.project_id = p.id WHERE s.id=$1`,
      [result.rows[0].id]
    );
    res.status(201).json(full.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /safety-checklists/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM safety_checklist_submissions WHERE id=$1 AND company_id=$2 RETURNING id',
      [req.params.id, req.user.company_id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
