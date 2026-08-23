const router = require('express').Router();
const pool   = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../auditLog');
const { getPresignedUploadUrl } = require('../r2');
const {
  SUBMITTAL_STATUSES,
  SUBMITTAL_STAMPS,
  SUBMITTAL_DOC_KINDS,
} = require('../constants/submittalEnums');

async function assertProjectInCompany(companyId, projectId) {
  const r = await pool.query(
    'SELECT id, name FROM projects WHERE id = $1 AND company_id = $2',
    [projectId, companyId]
  );
  return r.rows[0] || null;
}

async function assertSubmittalInCompany(companyId, submittalId) {
  const r = await pool.query(
    `SELECT s.*, p.name AS project_name
       FROM submittals s
       JOIN projects p ON s.project_id = p.id
      WHERE s.id = $1 AND s.company_id = $2`,
    [submittalId, companyId]
  );
  return r.rows[0] || null;
}

async function validateResponsibleParties(companyId, userId, subId) {
  if (userId) {
    const user = await pool.query(
      'SELECT 1 FROM users WHERE id = $1 AND company_id = $2',
      [userId, companyId]
    );
    if (user.rowCount === 0) return 'invalid responsible_user_id';
  }
  if (subId) {
    const sub = await pool.query(
      'SELECT 1 FROM subcontractors WHERE id = $1 AND company_id = $2',
      [subId, companyId]
    );
    if (sub.rowCount === 0) return 'invalid responsible_sub_id';
  }
  return null;
}

async function recordAudit({ submittalId, action, actorUserId, details }) {
  try {
    await pool.query(
      `INSERT INTO submittal_audit (submittal_id, action, actor_user_id, details)
       VALUES ($1, $2, $3, $4)`,
      [submittalId, action, actorUserId || null, details ? JSON.stringify(details) : null]
    );
  } catch { /* audit must not break the primary action */ }
}

// ── List ──────────────────────────────────────────────────────────────────────

router.get('/submittals', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const { project_id, status, spec_section, q } = req.query;
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const conditions = ['s.company_id = $1'];
  const params = [companyId];
  if (project_id) { params.push(project_id); conditions.push(`s.project_id = $${params.length}`); }
  if (status) {
    if (!SUBMITTAL_STATUSES.includes(status)) return res.status(400).json({ error: 'invalid status' });
    params.push(status);
    conditions.push(`s.status = $${params.length}`);
  }
  if (spec_section) { params.push(spec_section); conditions.push(`s.spec_section = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(s.title ILIKE $${params.length} OR s.submittal_number ILIKE $${params.length} OR s.description ILIKE $${params.length})`);
  }
  const where = conditions.join(' AND ');
  try {
    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM submittals s WHERE ${where}`, params),
      pool.query(
        `SELECT s.*, p.name AS project_name, u.full_name AS responsible_user_name,
                sub.name AS responsible_sub_name
           FROM submittals s
           JOIN projects p ON s.project_id = p.id
           LEFT JOIN users u ON s.responsible_user_id = u.id
           LEFT JOIN subcontractors sub ON s.responsible_sub_id = sub.id
          WHERE ${where}
          ORDER BY s.required_by ASC NULLS LAST, s.created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    res.json({
      items: dataRes.rows,
      total: parseInt(countRes.rows[0].count, 10),
      page,
      pages: Math.ceil(parseInt(countRes.rows[0].count, 10) / limit),
    });
  } catch (err) {
    req.log.error({ err }, 'submittals list error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/submittals/overdue', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const withinDays = Math.min(120, Math.max(1, parseInt(req.query.within_days) || 14));
  try {
    const r = await pool.query(
      `SELECT s.*, p.name AS project_name
         FROM submittals s JOIN projects p ON s.project_id = p.id
        WHERE s.company_id = $1
          AND s.required_by IS NOT NULL
          AND s.required_by < (CURRENT_DATE + $2::int)
          AND s.status NOT IN ('approved','approved_as_noted','closed','void')
        ORDER BY s.required_by ASC`,
      [companyId, withinDays]
    );
    res.json({ items: r.rows });
  } catch (err) {
    req.log.error({ err }, 'overdue submittals error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Create + read + update ────────────────────────────────────────────────────

router.post('/projects/:projectId/submittals', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const title = (req.body.title || '').toString().trim();
  if (!title) return res.status(400).json({ error: 'title is required' });
  const submittalNumber = (req.body.submittal_number || '').toString().trim();
  if (!submittalNumber) return res.status(400).json({ error: 'submittal_number is required' });
  try {
    const project = await assertProjectInCompany(companyId, req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const responsibleError = await validateResponsibleParties(
      companyId,
      req.body.responsible_user_id,
      req.body.responsible_sub_id
    );
    if (responsibleError) return res.status(400).json({ error: responsibleError });
    const r = await pool.query(
      `INSERT INTO submittals
         (company_id, project_id, submittal_number, spec_section, title, description,
          responsible_user_id, responsible_sub_id, reviewer_name, reviewer_email, reviewer_org,
          required_by, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        companyId, req.params.projectId, submittalNumber,
        req.body.spec_section?.toString().trim() || null,
        title,
        req.body.description || null,
        req.body.responsible_user_id || null,
        req.body.responsible_sub_id || null,
        req.body.reviewer_name?.toString().trim() || null,
        req.body.reviewer_email?.toString().trim() || null,
        req.body.reviewer_org?.toString().trim() || null,
        req.body.required_by || null,
        req.body.notes || null,
        req.user.id,
      ]
    );
    await recordAudit({ submittalId: r.rows[0].id, action: 'created', actorUserId: req.user.id });
    await logAudit(companyId, req.user.id, req.user.full_name,
      'submittal.created', 'submittal', r.rows[0].id, submittalNumber,
      { project_id: req.params.projectId });
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Submittal number + revision already exists for this project' });
    req.log.error({ err }, 'submittal create error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/submittals/:id', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const s = await assertSubmittalInCompany(companyId, req.params.id);
    if (!s) return res.status(404).json({ error: 'Submittal not found' });
    const [docs, audit] = await Promise.all([
      pool.query('SELECT * FROM submittal_documents WHERE submittal_id = $1 ORDER BY uploaded_at DESC', [req.params.id]),
      pool.query('SELECT * FROM submittal_audit WHERE submittal_id = $1 ORDER BY created_at', [req.params.id]),
    ]);
    res.json({ ...s, documents: docs.rows, audit: audit.rows });
  } catch (err) {
    req.log.error({ err }, 'submittal detail error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/submittals/:id', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const s = await assertSubmittalInCompany(companyId, req.params.id);
    if (!s) return res.status(404).json({ error: 'Submittal not found' });
    if (!['draft', 'pending_internal'].includes(s.status)) {
      return res.status(409).json({ error: `Cannot edit a submittal in '${s.status}' status` });
    }
    const responsibleError = await validateResponsibleParties(
      companyId,
      req.body.responsible_user_id,
      req.body.responsible_sub_id
    );
    if (responsibleError) return res.status(400).json({ error: responsibleError });
    const fields = [];
    const params = [];
    let idx = 1;
    for (const k of ['title', 'description', 'spec_section', 'reviewer_name', 'reviewer_email', 'reviewer_org', 'notes']) {
      if (req.body[k] !== undefined) {
        const v = req.body[k] == null ? null : req.body[k].toString().trim() || null;
        if (k === 'title' && !v) return res.status(400).json({ error: 'title cannot be empty' });
        fields.push(`${k} = $${idx++}`); params.push(v);
      }
    }
    for (const k of ['responsible_user_id', 'responsible_sub_id']) {
      if (req.body[k] !== undefined) { fields.push(`${k} = $${idx++}`); params.push(req.body[k] || null); }
    }
    if (req.body.required_by !== undefined) { fields.push(`required_by = $${idx++}`); params.push(req.body.required_by || null); }
    if (fields.length === 0) return res.json(s);
    params.push(req.params.id);
    const r = await pool.query(
      `UPDATE submittals SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    await logAudit(companyId, req.user.id, req.user.full_name,
      'submittal.updated', 'submittal', req.params.id, r.rows[0].submittal_number, null);
    res.json(r.rows[0]);
  } catch (err) {
    req.log.error({ err }, 'submittal patch error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Lifecycle transitions ─────────────────────────────────────────────────────

async function transitionStatus(req, res, fromStatuses, toStatus, action, columnUpdates = '') {
  const companyId = req.user.company_id;
  try {
    const s = await assertSubmittalInCompany(companyId, req.params.id);
    if (!s) return res.status(404).json({ error: 'Submittal not found' });
    if (!fromStatuses.includes(s.status)) {
      return res.status(409).json({ error: `Cannot transition from '${s.status}' to '${toStatus}'` });
    }
    // Re-check the from-status IN the UPDATE (not just the JS read above) so two concurrent
    // transitions can't both apply — the loser matches 0 rows.
    const r = await pool.query(
      `UPDATE submittals SET status = $1 ${columnUpdates} WHERE id = $2 AND status = ANY($3) RETURNING *`,
      [toStatus, req.params.id, fromStatuses]
    );
    if (r.rowCount === 0) return res.status(409).json({ error: `Cannot transition to '${toStatus}' — status changed` });
    await recordAudit({ submittalId: req.params.id, action, actorUserId: req.user.id });
    await logAudit(companyId, req.user.id, req.user.full_name,
      `submittal.${action}`, 'submittal', req.params.id, s.submittal_number, null);
    res.json(r.rows[0]);
  } catch (err) {
    req.log.error({ err }, `submittal ${action} error`);
    res.status(500).json({ error: 'Server error' });
  }
}

router.post('/submittals/:id/send-internal', requireAdmin, (req, res) =>
  transitionStatus(req, res, ['draft'], 'pending_internal', 'sent_internal'));

router.post('/submittals/:id/send-reviewer', requireAdmin, (req, res) =>
  transitionStatus(req, res, ['pending_internal'], 'sent_to_reviewer', 'sent_reviewer',
    ', sent_to_reviewer_at = NOW()'));

router.post('/submittals/:id/close', requireAdmin, (req, res) =>
  transitionStatus(req, res, ['approved', 'approved_as_noted'], 'closed', 'closed'));

router.post('/submittals/:id/void', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const s = await assertSubmittalInCompany(companyId, req.params.id);
    if (!s) return res.status(404).json({ error: 'Submittal not found' });
    if (s.status === 'void') return res.status(409).json({ error: 'Already void' });
    const r = await pool.query(
      `UPDATE submittals SET status = 'void' WHERE id = $1 AND status <> 'void' RETURNING *`,
      [req.params.id]
    );
    if (r.rowCount === 0) return res.status(409).json({ error: 'Already void' });
    await recordAudit({ submittalId: req.params.id, action: 'voided', actorUserId: req.user.id });
    res.json(r.rows[0]);
  } catch (err) {
    req.log.error({ err }, 'submittal void error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Reviewer stamp — captures the stamp + response_notes + transitions
// status. The stamp comes back via paper or email; admin records it.
router.post('/submittals/:id/stamp', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const { stamp, response_notes } = req.body;
  if (!SUBMITTAL_STAMPS.includes(stamp)) {
    return res.status(400).json({ error: 'invalid stamp' });
  }
  try {
    const s = await assertSubmittalInCompany(companyId, req.params.id);
    if (!s) return res.status(404).json({ error: 'Submittal not found' });
    if (s.status !== 'sent_to_reviewer') {
      return res.status(409).json({ error: `Cannot stamp from '${s.status}'` });
    }
    // Only prepend the "Review notes:" prefix if we actually have notes
    // to record; otherwise an empty stamp would write "Review notes: "
    // (trailing-colon, no content) into the column.
    const trimmedNotes = response_notes ? response_notes.toString().trim() : '';
    const r = await pool.query(
      `UPDATE submittals SET
         status = $1,
         reviewer_stamp = $1,
         reviewer_responded_at = NOW(),
         notes = CASE
           WHEN $2 IS NULL OR $2 = '' THEN notes
           WHEN notes IS NULL OR notes = '' THEN 'Review notes: ' || $2
           ELSE notes || E'\n\nReview notes: ' || $2
         END
       WHERE id = $3 AND status = 'sent_to_reviewer' RETURNING *`,
      [stamp, trimmedNotes || null, req.params.id]
    );
    if (r.rowCount === 0) return res.status(409).json({ error: 'Submittal is no longer awaiting a stamp' });
    await recordAudit({
      submittalId: req.params.id,
      action: 'stamp_received',
      actorUserId: req.user.id,
      details: { stamp, response_notes: response_notes || null },
    });
    await logAudit(companyId, req.user.id, req.user.full_name,
      'submittal.stamped', 'submittal', req.params.id, s.submittal_number,
      { stamp });
    res.json(r.rows[0]);
  } catch (err) {
    req.log.error({ err }, 'submittal stamp error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Revise — only valid from a revise_resubmit / rejected stamp.
// Creates a new submittal row with revision+1 and superseded_by_id on
// the old row pointing at the new one (chained the OTHER direction
// would mean old rows reference newer rows; using superseded_by lets
// you walk from old → new).
router.post('/submittals/:id/revise', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const oldRes = await client.query(
      `SELECT * FROM submittals WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [req.params.id, companyId]
    );
    if (oldRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Submittal not found' }); }
    const old = oldRes.rows[0];
    if (!['revise_resubmit', 'rejected'].includes(old.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Cannot revise from '${old.status}'` });
    }
    const newRes = await client.query(
      `INSERT INTO submittals
        (company_id, project_id, submittal_number, spec_section, title, description,
         responsible_user_id, responsible_sub_id, reviewer_name, reviewer_email, reviewer_org,
         required_by, revision, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [companyId, old.project_id, old.submittal_number, old.spec_section, old.title, old.description,
       old.responsible_user_id, old.responsible_sub_id, old.reviewer_name, old.reviewer_email, old.reviewer_org,
       old.required_by, old.revision + 1, req.user.id]
    );
    await client.query(
      `UPDATE submittals SET superseded_by_id = $1 WHERE id = $2`,
      [newRes.rows[0].id, req.params.id]
    );
    await client.query('COMMIT');
    await recordAudit({
      submittalId: req.params.id, action: 'revised', actorUserId: req.user.id,
      details: { new_submittal_id: newRes.rows[0].id, new_revision: newRes.rows[0].revision },
    });
    res.status(201).json(newRes.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'submittal revise error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── Documents ─────────────────────────────────────────────────────────────────

router.get('/submittals/:id/documents/upload-url', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const { filename, contentType } = req.query;
  if (!filename || !contentType) return res.status(400).json({ error: 'filename and contentType required' });
  const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
  if (!allowed.includes(contentType)) return res.status(400).json({ error: 'File type not allowed' });
  try {
    const s = await assertSubmittalInCompany(companyId, req.params.id);
    if (!s) return res.status(404).json({ error: 'Submittal not found' });
    // Only a sanitized extension comes from the user filename; the key is a
    // UUID under the company-scoped folder, so no path traversal is possible.
    const ext = (String(filename).split('.').pop() || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase() || 'bin';
    const { uploadUrl, publicUrl } = await getPresignedUploadUrl(
      `submittals/${companyId}/${req.params.id}`, ext, contentType
    );
    res.json({ uploadUrl, publicUrl });
  } catch (err) {
    req.log.error({ err }, 'submittal upload-url error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/submittals/:id/documents', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const { kind, name, url, size_bytes } = req.body;
  if (!SUBMITTAL_DOC_KINDS.includes(kind)) return res.status(400).json({ error: 'invalid kind' });
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  try {
    const s = await assertSubmittalInCompany(companyId, req.params.id);
    if (!s) return res.status(404).json({ error: 'Submittal not found' });
    const r = await pool.query(
      `INSERT INTO submittal_documents (submittal_id, kind, name, url, size_bytes, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.id, kind, name, url, size_bytes || null, req.user.id]
    );
    await recordAudit({
      submittalId: req.params.id, action: 'document_added', actorUserId: req.user.id,
      details: { kind, name },
    });
    res.status(201).json(r.rows[0]);
  } catch (err) {
    req.log.error({ err }, 'submittal doc create error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/submittals/:subId/documents/:docId', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const s = await assertSubmittalInCompany(companyId, req.params.subId);
    if (!s) return res.status(404).json({ error: 'Submittal not found' });
    const r = await pool.query(
      'DELETE FROM submittal_documents WHERE id = $1 AND submittal_id = $2 RETURNING name',
      [req.params.docId, req.params.subId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Document not found' });
    await recordAudit({
      submittalId: req.params.subId, action: 'document_removed', actorUserId: req.user.id,
      details: { name: r.rows[0].name },
    });
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, 'submittal doc delete error');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
