const router = require('express').Router();
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { projectBelongsToCompany } = require('../utils/tenantRefs');
const { sendPushToCompanyAdmins } = require('../push');
const { logAudit } = require('../auditLog');
const {
  INCIDENT_TYPES: VALID_INCIDENT_TYPES,
  INCIDENT_STATUSES: VALID_INCIDENT_STATUSES,
} = require('../constants/incidentEnums');

const INCIDENT_COLS = `
  i.*, u.full_name AS reporter_name, p.name AS project_name`;

const BASE_QUERY = `
  SELECT ${INCIDENT_COLS}
  FROM incident_reports i
  JOIN users u ON i.user_id = u.id
  LEFT JOIN projects p ON i.project_id = p.id`;

// GET /incidents — worker sees own; admin sees all company incidents
router.get('/', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  const { project_id, worker_id, type, status, from, to } = req.query;
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  const conditions = ['i.company_id = $1'];
  const params = [companyId];

  if (!isAdmin) {
    params.push(req.user.id);
    conditions.push(`i.user_id = $${params.length}`);
  } else if (worker_id) {
    params.push(worker_id);
    conditions.push(`i.user_id = $${params.length}`);
  }
  if (project_id) { params.push(project_id); conditions.push(`i.project_id = $${params.length}`); }
  if (type) {
    if (!VALID_INCIDENT_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid type' });
    params.push(type); conditions.push(`i.type = $${params.length}`);
  }
  if (status) {
    if (!VALID_INCIDENT_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    params.push(status); conditions.push(`i.status = $${params.length}`);
  }
  if (from) { params.push(from); conditions.push(`i.incident_date >= $${params.length}`); }
  if (to) { params.push(to); conditions.push(`i.incident_date <= $${params.length}`); }

  const where = conditions.join(' AND ');
  try {
    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM incident_reports i WHERE ${where}`, params),
      pool.query(
        `${BASE_QUERY} WHERE ${where} ORDER BY i.incident_date DESC, i.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    const total = parseInt(countResult.rows[0].count);
    res.json({ items: dataResult.rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /incidents — submit a new incident report
router.post('/', requireAuth, async (req, res) => {
  const { incident_date, incident_time, type, project_id, treatment, work_stopped } = req.body;
  const description        = req.body.description?.trim() || null;
  const injured_name       = req.body.injured_name?.trim() || null;
  const body_part          = req.body.body_part?.trim() || null;
  const witnesses          = req.body.witnesses?.trim() || null;
  const corrective_action  = req.body.corrective_action?.trim() || null;

  if (!incident_date || !type || !description) {
    return res.status(400).json({ error: 'incident_date, type, and description are required' });
  }
  if (!VALID_INCIDENT_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid type' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(incident_date) || isNaN(Date.parse(incident_date))) {
    return res.status(400).json({ error: 'incident_date must be a valid date (YYYY-MM-DD)' });
  }
  if (description.length > 2000) return res.status(400).json({ error: 'description too long (max 2000 characters)' });
  if (injured_name && injured_name.length > 255) return res.status(400).json({ error: 'injured_name too long (max 255 characters)' });
  if (witnesses && witnesses.length > 500) return res.status(400).json({ error: 'witnesses too long (max 500 characters)' });
  if (corrective_action && corrective_action.length > 2000) return res.status(400).json({ error: 'corrective_action too long (max 2000 characters)' });

  const companyId = req.user.company_id;
  // A supplied project must belong to this company — else a foreign project_id is stored and
  // its name leaked back via the projects JOIN in the response.
  if (project_id != null && project_id !== '' && !(await projectBelongsToCompany(pool, project_id, companyId))) {
    return res.status(400).json({ error: 'Invalid project' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO incident_reports
         (company_id, user_id, project_id, incident_date, incident_time, type,
          injured_name, body_part, treatment, work_stopped, description, witnesses, corrective_action)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        companyId, req.user.id, project_id || null,
        incident_date, incident_time || null, type,
        injured_name, body_part, treatment || null,
        work_stopped || false, description,
        witnesses, corrective_action,
      ]
    );
    const report = result.rows[0];

    const full = await pool.query(
      `${BASE_QUERY} WHERE i.id = $1`,
      [report.id]
    );

    logAudit(companyId, req.user.id, req.user.full_name, 'incident.submitted', 'incident_report', report.id, null,
      { type, incident_date, project_id: project_id || null, injured_name: injured_name || null });

    sendPushToCompanyAdmins(companyId, {
      title: `Incident report from ${req.user.full_name}`,
      body: `${type.replace('-', ' ')} — ${incident_date}`,
      url: '/field#incident',
    });

    res.status(201).json(full.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /incidents/:id/close — admin closes an incident
router.patch('/:id/close', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE incident_reports SET status = 'closed' WHERE id = $1 AND company_id = $2 RETURNING *`,
      [req.params.id, req.user.company_id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Incident not found' });
    logAudit(req.user.company_id, req.user.id, req.user.full_name, 'incident.closed', 'incident_report', req.params.id, null, null);
    res.json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /incidents/:id
router.delete('/:id', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  try {
    const existing = await pool.query(
      'SELECT * FROM incident_reports WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Incident not found' });
    const report = existing.rows[0];
    if (!isAdmin && report.user_id !== req.user.id) return res.status(403).json({ error: 'Not your report' });
    if (!isAdmin && report.status === 'closed') return res.status(403).json({ error: 'Closed incidents cannot be deleted' });

    await pool.query('DELETE FROM incident_reports WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    logAudit(companyId, req.user.id, req.user.full_name, 'incident.deleted', 'incident_report', req.params.id, null,
      { type: report.type, incident_date: report.incident_date });
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
