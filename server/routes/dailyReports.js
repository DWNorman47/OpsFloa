const router = require('express').Router();
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { projectBelongsToCompany } = require('../utils/tenantRefs');

// Fetch a full report with all sub-tables
async function getFullReport(id, companyId) {
  const [report, manpower, equipment, materials] = await Promise.all([
    pool.query(
      `SELECT r.*, p.name as project_name, u.full_name as created_by_name
       FROM daily_reports r
       LEFT JOIN projects p ON r.project_id = p.id
       LEFT JOIN users u ON r.created_by = u.id
       WHERE r.id = $1 AND r.company_id = $2`,
      [id, companyId]
    ),
    pool.query('SELECT * FROM daily_report_manpower WHERE report_id = $1 ORDER BY id', [id]),
    pool.query('SELECT * FROM daily_report_equipment WHERE report_id = $1 ORDER BY id', [id]),
    pool.query('SELECT * FROM daily_report_materials WHERE report_id = $1 ORDER BY id', [id]),
  ]);
  if (report.rowCount === 0) return null;
  return { ...report.rows[0], manpower: manpower.rows, equipment: equipment.rows, materials: materials.rows };
}

// GET /daily-reports — list reports for company (admin: all; worker: own)
router.get('/', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  const { project_id, from, to, status } = req.query;
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  try {
    const conditions = ['r.company_id = $1'];
    const params = [companyId];
    if (!isAdmin) { params.push(req.user.id); conditions.push(`r.created_by = $${params.length}`); }
    if (project_id) { params.push(project_id); conditions.push(`r.project_id = $${params.length}`); }
    if (from) { params.push(from); conditions.push(`r.report_date >= $${params.length}`); }
    if (to) { params.push(to); conditions.push(`r.report_date <= $${params.length}`); }
    if (status) {
      if (!['draft', 'submitted', 'reviewed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
      params.push(status); conditions.push(`r.status = $${params.length}`);
    }

    const where = conditions.join(' AND ');
    const [countResult, dataResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(DISTINCT r.id) FROM daily_reports r WHERE ${where}`,
        params
      ),
      pool.query(
        `SELECT r.*, p.name as project_name, u.full_name as created_by_name,
                COUNT(m.id) as manpower_count
         FROM daily_reports r
         LEFT JOIN projects p ON r.project_id = p.id
         LEFT JOIN users u ON r.created_by = u.id
         LEFT JOIN daily_report_manpower m ON m.report_id = r.id
         WHERE ${where}
         GROUP BY r.id, p.name, u.full_name
         ORDER BY r.report_date DESC, r.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    const total = parseInt(countResult.rows[0].count);
    res.json({ items: dataResult.rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /daily-reports/suggest — auto-fill manpower from time entries for a project+date
router.get('/suggest', requireAuth, async (req, res) => {
  const { project_id, report_date } = req.query;
  if (!report_date) return res.status(400).json({ error: 'report_date required' });
  const companyId = req.user.company_id;
  try {
    const conditions = ['te.company_id = $1', 'te.work_date = $2'];
    const params = [companyId, report_date];
    if (project_id) { params.push(project_id); conditions.push(`te.project_id = $${params.length}`); }

    const result = await pool.query(
      `SELECT u.full_name, p.name as project_name,
              SUM(EXTRACT(EPOCH FROM (
                CASE WHEN te.end_time < te.start_time
                  THEN (te.end_time + INTERVAL '1 day') - te.start_time
                  ELSE te.end_time - te.start_time
                END
              )) / 3600 - (te.break_minutes::float / 60)) as total_hours,
              COUNT(*) as entry_count
       FROM time_entries te
       JOIN users u ON te.user_id = u.id
       LEFT JOIN projects p ON te.project_id = p.id
       WHERE ${conditions.join(' AND ')}
       GROUP BY u.full_name, p.name
       ORDER BY u.full_name`,
      params
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /daily-reports/:id — full report
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const report = await getFullReport(req.params.id, req.user.company_id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json(report);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /daily-reports — create
router.post('/', requireAuth, async (req, res) => {
  const { project_id, report_date, superintendent, weather_condition, weather_temp,
          work_performed, delays_issues, visitor_log, manpower = [], equipment = [], materials = [] } = req.body;
  if (!report_date) return res.status(400).json({ error: 'report_date required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(report_date) || isNaN(Date.parse(report_date))) {
    return res.status(400).json({ error: 'report_date must be a valid date (YYYY-MM-DD)' });
  }
  const tempVal = weather_temp != null && weather_temp !== '' ? parseFloat(weather_temp) : null;
  if (tempVal !== null && isNaN(tempVal)) return res.status(400).json({ error: 'weather_temp must be a number' });
  const companyId = req.user.company_id;
  const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!(await projectBelongsToCompany(client, project_id, companyId))) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Project not found' });
    }

    // The upsert below (ON CONFLICT DO UPDATE) would silently overwrite an existing report for
    // the same project+date. PATCH enforces ownership; POST must too, or a worker could clobber
    // a coworker's/admin's report through this path. (IS NOT DISTINCT FROM handles null project_id.)
    const dupe = await client.query(
      `SELECT id, created_by FROM daily_reports
       WHERE company_id = $1 AND project_id IS NOT DISTINCT FROM $2 AND report_date = $3 FOR UPDATE`,
      [companyId, project_id || null, report_date]
    );
    if (dupe.rowCount > 0 && !isAdmin && dupe.rows[0].created_by !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'A report for this project and date already exists' });
    }

    let reportId;
    if (dupe.rowCount > 0) {
      // Update the existing report by id. The ON CONFLICT below only matches when project_id
      // is non-NULL (the unique index treats NULLs as distinct), so a "No project" report would
      // otherwise insert a duplicate on every re-submit. Updating the located row covers both.
      const upd = await client.query(
        `UPDATE daily_reports SET superintendent=$1, weather_condition=$2, weather_temp=$3,
           work_performed=$4, delays_issues=$5, visitor_log=$6, updated_at=NOW()
         WHERE id=$7 RETURNING id`,
        [superintendent?.trim() || null, weather_condition?.trim() || null, tempVal,
         work_performed?.trim() || null, delays_issues?.trim() || null, visitor_log?.trim() || null, dupe.rows[0].id]
      );
      reportId = upd.rows[0].id;
    } else {
      const result = await client.query(
        `INSERT INTO daily_reports
           (company_id, project_id, report_date, superintendent, weather_condition, weather_temp,
            work_performed, delays_issues, visitor_log, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (company_id, project_id, report_date)
         DO UPDATE SET superintendent=$4, weather_condition=$5, weather_temp=$6,
           work_performed=$7, delays_issues=$8, visitor_log=$9, updated_at=NOW()
         RETURNING id`,
        [companyId, project_id || null, report_date, superintendent?.trim() || null,
         weather_condition?.trim() || null, tempVal, work_performed?.trim() || null,
         delays_issues?.trim() || null, visitor_log?.trim() || null, req.user.id]
      );
      reportId = result.rows[0].id;
    }

    // Validate sub-table row fields (trim + numeric checks)
    for (const m of manpower) {
      if (m.hours !== undefined && m.hours !== null && m.hours !== '') { m.hours = parseFloat(m.hours); if (isNaN(m.hours)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Manpower hours must be a number' }); } } else { m.hours = null; }
      if (m.trade && m.trade.length > 255) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Manpower trade too long (max 255 characters)' }); }
      if (m.notes && m.notes.length > 500) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Manpower notes too long (max 500 characters)' }); }
    }
    for (const e of equipment) {
      if (e.hours !== undefined && e.hours !== null && e.hours !== '') { e.hours = parseFloat(e.hours); if (isNaN(e.hours)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Equipment hours must be a number' }); } } else { e.hours = null; }
      if (e.name && e.name.length > 255) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Equipment name too long (max 255 characters)' }); }
    }
    for (const m of materials) {
      if (m.description && m.description.length > 500) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Material description too long (max 500 characters)' }); }
    }

    // Replace sub-tables
    await client.query('DELETE FROM daily_report_manpower WHERE report_id=$1', [reportId]);
    for (const m of manpower) {
      if (!m.trade && !m.worker_count) continue;
      await client.query(
        'INSERT INTO daily_report_manpower (report_id, trade, worker_count, hours, notes) VALUES ($1,$2,$3,$4,$5)',
        [reportId, m.trade || null, parseInt(m.worker_count) || 1, m.hours, m.notes || null]
      );
    }
    await client.query('DELETE FROM daily_report_equipment WHERE report_id=$1', [reportId]);
    for (const e of equipment) {
      if (!e.name) continue;
      await client.query(
        'INSERT INTO daily_report_equipment (report_id, name, quantity, hours) VALUES ($1,$2,$3,$4)',
        [reportId, e.name, parseInt(e.quantity) || 1, e.hours]
      );
    }
    await client.query('DELETE FROM daily_report_materials WHERE report_id=$1', [reportId]);
    for (const m of materials) {
      if (!m.description) continue;
      await client.query(
        'INSERT INTO daily_report_materials (report_id, description, quantity) VALUES ($1,$2,$3)',
        [reportId, m.description, m.quantity || null]
      );
    }

    await client.query('COMMIT');
    const full = await getFullReport(reportId, companyId);
    res.status(201).json(full);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'A report already exists for this project and date' });
    req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// PATCH /daily-reports/:id — update (same payload as POST)
router.patch('/:id', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  const { superintendent, weather_condition, weather_temp, work_performed, delays_issues,
          visitor_log, status, manpower = [], equipment = [], materials = [] } = req.body;
  // Only replace a sub-table when its array was actually sent. Otherwise a partial PATCH
  // (e.g. status-only) would DELETE every manpower/equipment/materials row for the report.
  const hasManpower  = req.body.manpower  !== undefined;
  const hasEquipment = req.body.equipment !== undefined;
  const hasMaterials = req.body.materials !== undefined;

  // Validate status value and enforce transition rules
  const VALID_STATUSES = ['draft', 'submitted', 'reviewed'];
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status value' });
  }
  const patchTempVal = weather_temp != null && weather_temp !== '' ? parseFloat(weather_temp) : undefined;
  if (patchTempVal !== undefined && isNaN(patchTempVal)) return res.status(400).json({ error: 'weather_temp must be a number' });
  if (status === 'reviewed' && !isAdmin) {
    return res.status(403).json({ error: 'Only admins can mark a report as reviewed' });
  }

  const clientUpdatedAt = req.body.updated_at || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT * FROM daily_reports WHERE id=$1 AND company_id=$2', [req.params.id, companyId]
    );
    if (existing.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Report not found' });
    }

    // Ownership check: workers may only edit their own reports
    if (!isAdmin && existing.rows[0].created_by !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You can only edit your own reports' });
    }

    // Edit-lock once reviewed — matches fieldReports. A non-admin must not rewrite the
    // work-performed / crew / weather of a report already signed off (it still shows the
    // reviewer's name over content they never saw).
    if (!isAdmin && existing.rows[0].status === 'reviewed') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Reviewed reports cannot be edited' });
    }

    if (clientUpdatedAt && new Date(existing.rows[0].updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'conflict' });
    }

    await client.query(
      `UPDATE daily_reports SET superintendent=$1, weather_condition=$2, weather_temp=$3,
         work_performed=$4, delays_issues=$5, visitor_log=$6, status=COALESCE($7, status), updated_at=NOW()
       WHERE id=$8`,
      [superintendent?.trim() ?? existing.rows[0].superintendent,
       weather_condition?.trim() ?? existing.rows[0].weather_condition,
       patchTempVal !== undefined ? patchTempVal : existing.rows[0].weather_temp,
       work_performed?.trim() ?? existing.rows[0].work_performed,
       delays_issues?.trim() ?? existing.rows[0].delays_issues,
       visitor_log?.trim() ?? existing.rows[0].visitor_log,
       status || null, req.params.id]
    );

    // Validate sub-table row fields (trim + numeric checks)
    for (const m of manpower) {
      m.trade = m.trade?.trim() || null;
      m.notes = m.notes?.trim() || null;
      if (m.hours !== undefined && m.hours !== null && m.hours !== '') { m.hours = parseFloat(m.hours); if (isNaN(m.hours)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Manpower hours must be a number' }); } } else { m.hours = null; }
      if (m.trade && m.trade.length > 255) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Manpower trade too long (max 255 characters)' }); }
      if (m.notes && m.notes.length > 500) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Manpower notes too long (max 500 characters)' }); }
    }
    for (const e of equipment) {
      e.name = e.name?.trim() || null;
      if (e.hours !== undefined && e.hours !== null && e.hours !== '') { e.hours = parseFloat(e.hours); if (isNaN(e.hours)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Equipment hours must be a number' }); } } else { e.hours = null; }
      if (e.name && e.name.length > 255) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Equipment name too long (max 255 characters)' }); }
    }
    for (const m of materials) {
      m.description = m.description?.trim() || null;
      if (m.description && m.description.length > 500) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Material description too long (max 500 characters)' }); }
    }

    if (hasManpower) {
      await client.query('DELETE FROM daily_report_manpower WHERE report_id=$1', [req.params.id]);
      for (const m of manpower) {
        if (!m.trade && !m.worker_count) continue;
        await client.query(
          'INSERT INTO daily_report_manpower (report_id, trade, worker_count, hours, notes) VALUES ($1,$2,$3,$4,$5)',
          [req.params.id, m.trade, parseInt(m.worker_count) || 1, m.hours, m.notes]
        );
      }
    }
    if (hasEquipment) {
      await client.query('DELETE FROM daily_report_equipment WHERE report_id=$1', [req.params.id]);
      for (const e of equipment) {
        if (!e.name) continue;
        await client.query(
          'INSERT INTO daily_report_equipment (report_id, name, quantity, hours) VALUES ($1,$2,$3,$4)',
          [req.params.id, e.name, parseInt(e.quantity) || 1, e.hours]
        );
      }
    }
    if (hasMaterials) {
      await client.query('DELETE FROM daily_report_materials WHERE report_id=$1', [req.params.id]);
      for (const m of materials) {
        if (!m.description) continue;
        await client.query(
          'INSERT INTO daily_report_materials (report_id, description, quantity) VALUES ($1,$2,$3)',
          [req.params.id, m.description, m.quantity || null]
        );
      }
    }

    await client.query('COMMIT');
    const full = await getFullReport(req.params.id, companyId);
    res.json(full);
  } catch (err) {
    await client.query('ROLLBACK');
    req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// PATCH /daily-reports/:id/review — admin marks a submitted report as reviewed
router.patch('/:id/review', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const reviewerName = req.body.reviewer_name || req.user.full_name || 'Admin';
  try {
    const result = await pool.query(
      `UPDATE daily_reports
       SET status = 'reviewed', reviewed_by = $1, reviewed_at = NOW()
       WHERE id = $2 AND company_id = $3 AND status = 'submitted'
       RETURNING *`,
      [reviewerName, req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Report not found or not in submitted status' });
    res.json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /daily-reports/:id
router.delete('/:id', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
    const cond = isAdmin ? 'company_id=$2' : 'company_id=$2 AND created_by=$3';
    const params = isAdmin ? [req.params.id, companyId] : [req.params.id, companyId, req.user.id];
    const result = await pool.query(`DELETE FROM daily_reports WHERE id=$1 AND ${cond} RETURNING id`, params);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Report not found' });
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
