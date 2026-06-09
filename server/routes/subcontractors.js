// Subcontractors directory + Sub POs + Sub PO payments. The 'subs'
// bucket in the project spend rollup reads from these tables.

const router = require('express').Router();
const pool   = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../auditLog');
const {
  SUBCONTRACTOR_DOC_TYPES,
  SUBCONTRACT_PO_STATUSES,
  nextStatusAfterPayment,
} = require('../constants/subcontractEnums');
const { getPresignedUploadUrl } = require('../r2');

async function assertSubInCompany(companyId, subId) {
  const r = await pool.query(
    'SELECT id, name FROM subcontractors WHERE id = $1 AND company_id = $2',
    [subId, companyId]
  );
  return r.rows[0] || null;
}

async function assertProjectInCompany(companyId, projectId) {
  const r = await pool.query(
    'SELECT id, name FROM projects WHERE id = $1 AND company_id = $2',
    [projectId, companyId]
  );
  return r.rows[0] || null;
}

async function assertPoInCompany(companyId, poId) {
  const r = await pool.query(
    `SELECT po.*, sub.name AS sub_name, p.name AS project_name
       FROM subcontract_pos po
       LEFT JOIN subcontractors sub ON po.subcontractor_id = sub.id
       LEFT JOIN projects p ON po.project_id = p.id
      WHERE po.id = $1 AND po.company_id = $2`,
    [poId, companyId]
  );
  return r.rows[0] || null;
}

// ── Subcontractors directory ─────────────────────────────────────────────────

router.get('/subcontractors', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const { archived, scope_specialty, q } = req.query;
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const conditions = ['company_id = $1'];
  const params = [companyId];
  if (archived === 'true') { conditions.push('archived = true'); }
  else if (archived === 'false' || archived === undefined) { conditions.push('archived = false'); }
  if (scope_specialty) {
    params.push(scope_specialty);
    conditions.push(`scope_specialty = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(name ILIKE $${params.length} OR contact_name ILIKE $${params.length} OR scope_specialty ILIKE $${params.length})`);
  }
  const where = conditions.join(' AND ');
  try {
    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM subcontractors WHERE ${where}`, params),
      pool.query(
        `SELECT * FROM subcontractors WHERE ${where}
          ORDER BY name ASC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    const total = parseInt(countRes.rows[0].count, 10);
    res.json({ items: dataRes.rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    req.log.error({ err }, 'subs list error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/subcontractors', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const name = (req.body.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (name.length > 255) return res.status(400).json({ error: 'name too long' });
  try {
    const r = await pool.query(
      `INSERT INTO subcontractors
        (company_id, name, contact_name, contact_email, contact_phone, license_number, scope_specialty, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        companyId, name,
        req.body.contact_name?.toString().trim() || null,
        req.body.contact_email?.toString().trim() || null,
        req.body.contact_phone?.toString().trim() || null,
        req.body.license_number?.toString().trim() || null,
        req.body.scope_specialty?.toString().trim() || null,
        req.body.notes || null,
        req.user.id,
      ]
    );
    await logAudit(companyId, req.user.id, req.user.full_name,
      'subcontractor.created', 'subcontractor', r.rows[0].id, name, null);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    req.log.error({ err }, 'sub create error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/subcontractors/:id', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const sub = await assertSubInCompany(companyId, req.params.id);
    if (!sub) return res.status(404).json({ error: 'Subcontractor not found' });
    const [details, docs, openPosRes] = await Promise.all([
      pool.query('SELECT * FROM subcontractors WHERE id = $1', [req.params.id]),
      pool.query('SELECT * FROM subcontractor_documents WHERE subcontractor_id = $1 ORDER BY uploaded_at DESC', [req.params.id]),
      pool.query(
        `SELECT id, po_number, project_id, status, amount_cents, scope_of_work, created_at
           FROM subcontract_pos WHERE subcontractor_id = $1 AND status IN ('draft','issued','partial')`,
        [req.params.id]
      ),
    ]);
    res.json({ ...details.rows[0], documents: docs.rows, open_pos: openPosRes.rows });
  } catch (err) {
    req.log.error({ err }, 'sub detail error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/subcontractors/:id', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const sub = await assertSubInCompany(companyId, req.params.id);
    if (!sub) return res.status(404).json({ error: 'Subcontractor not found' });
    const fields = [];
    const params = [];
    let idx = 1;
    for (const k of ['name', 'contact_name', 'contact_email', 'contact_phone', 'license_number', 'scope_specialty', 'notes']) {
      if (req.body[k] !== undefined) {
        const v = req.body[k] == null ? null : req.body[k].toString().trim() || null;
        if (k === 'name' && !v) return res.status(400).json({ error: 'name cannot be empty' });
        fields.push(`${k} = $${idx++}`);
        params.push(v);
      }
    }
    if (fields.length === 0) return res.json(sub);
    params.push(req.params.id);
    const r = await pool.query(
      `UPDATE subcontractors SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    await logAudit(companyId, req.user.id, req.user.full_name,
      'subcontractor.updated', 'subcontractor', req.params.id, r.rows[0].name, null);
    res.json(r.rows[0]);
  } catch (err) {
    req.log.error({ err }, 'sub patch error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/subcontractors/:id/archive', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const sub = await assertSubInCompany(companyId, req.params.id);
    if (!sub) return res.status(404).json({ error: 'Subcontractor not found' });
    await pool.query('UPDATE subcontractors SET archived = true WHERE id = $1', [req.params.id]);
    await logAudit(companyId, req.user.id, req.user.full_name,
      'subcontractor.archived', 'subcontractor', req.params.id, sub.name, null);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, 'sub archive error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Sub documents ────────────────────────────────────────────────────────────

router.post('/subcontractors/:id/documents', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const { doc_type, name, url, size_bytes, expires_on } = req.body;
  if (!doc_type || !SUBCONTRACTOR_DOC_TYPES.includes(doc_type)) {
    return res.status(400).json({ error: 'invalid doc_type' });
  }
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  try {
    const sub = await assertSubInCompany(companyId, req.params.id);
    if (!sub) return res.status(404).json({ error: 'Subcontractor not found' });
    const r = await pool.query(
      `INSERT INTO subcontractor_documents
         (subcontractor_id, doc_type, name, url, size_bytes, expires_on, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.params.id, doc_type, name, url, size_bytes || null, expires_on || null, req.user.id]
    );
    await logAudit(companyId, req.user.id, req.user.full_name,
      'subcontractor_doc.created', 'subcontractor_document', r.rows[0].id, name,
      { sub_id: req.params.id, doc_type });
    res.status(201).json(r.rows[0]);
  } catch (err) {
    req.log.error({ err }, 'sub doc create error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/subcontractors/:subId/documents/:docId', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const sub = await assertSubInCompany(companyId, req.params.subId);
    if (!sub) return res.status(404).json({ error: 'Subcontractor not found' });
    const r = await pool.query(
      'DELETE FROM subcontractor_documents WHERE id = $1 AND subcontractor_id = $2 RETURNING name',
      [req.params.docId, req.params.subId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Document not found' });
    await logAudit(companyId, req.user.id, req.user.full_name,
      'subcontractor_doc.deleted', 'subcontractor_document', req.params.docId, r.rows[0].name, null);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, 'sub doc delete error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/subcontractors/:id/documents/upload-url', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const { filename, contentType } = req.query;
  if (!filename || !contentType) return res.status(400).json({ error: 'filename and contentType required' });
  const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(contentType)) return res.status(400).json({ error: 'File type not allowed' });
  try {
    const sub = await assertSubInCompany(companyId, req.params.id);
    if (!sub) return res.status(404).json({ error: 'Subcontractor not found' });
    const { uploadUrl, publicUrl } = await getPresignedUploadUrl({
      key: `subs/${companyId}/${req.params.id}/${Date.now()}-${filename}`,
      contentType,
    });
    res.json({ uploadUrl, publicUrl });
  } catch (err) {
    req.log.error({ err }, 'sub doc presign error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Sub POs ──────────────────────────────────────────────────────────────────

router.get('/subcontract-pos', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const { status, subcontractor_id, project_id, q } = req.query;
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const conditions = ['po.company_id = $1'];
  const params = [companyId];
  if (status) {
    if (!SUBCONTRACT_PO_STATUSES.includes(status)) return res.status(400).json({ error: 'invalid status' });
    params.push(status);
    conditions.push(`po.status = $${params.length}`);
  }
  if (subcontractor_id) { params.push(subcontractor_id); conditions.push(`po.subcontractor_id = $${params.length}`); }
  if (project_id) { params.push(project_id); conditions.push(`po.project_id = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(po.po_number ILIKE $${params.length} OR po.scope_of_work ILIKE $${params.length})`);
  }
  const where = conditions.join(' AND ');
  try {
    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM subcontract_pos po WHERE ${where}`, params),
      pool.query(
        `SELECT po.*, sub.name AS sub_name, p.name AS project_name,
                COALESCE((SELECT SUM(amount_cents) FROM subcontract_po_payments WHERE po_id = po.id), 0)::bigint AS paid_cents
           FROM subcontract_pos po
           LEFT JOIN subcontractors sub ON po.subcontractor_id = sub.id
           LEFT JOIN projects p ON po.project_id = p.id
          WHERE ${where}
          ORDER BY po.created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    const total = parseInt(countRes.rows[0].count, 10);
    res.json({ items: dataRes.rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    req.log.error({ err }, 'sub PO list error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/projects/:projectId/subcontract-pos', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const { subcontractor_id, scope_of_work, retainage_pct, notes } = req.body;
  const amount_cents = typeof req.body.amount_cents === 'number'
    ? req.body.amount_cents
    : parseInt(req.body.amount_cents, 10);
  if (!subcontractor_id) return res.status(400).json({ error: 'subcontractor_id required' });
  if (!scope_of_work || !scope_of_work.toString().trim()) return res.status(400).json({ error: 'scope_of_work required' });
  if (!Number.isFinite(amount_cents) || amount_cents < 0) return res.status(400).json({ error: 'invalid amount_cents' });
  const retainPct = retainage_pct === undefined || retainage_pct === null ? 0 : parseFloat(retainage_pct);
  if (!Number.isFinite(retainPct) || retainPct < 0 || retainPct > 100) return res.status(400).json({ error: 'invalid retainage_pct' });
  try {
    const project = await assertProjectInCompany(companyId, req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const sub = await assertSubInCompany(companyId, subcontractor_id);
    if (!sub) return res.status(404).json({ error: 'Subcontractor not found' });
    const r = await pool.query(
      `INSERT INTO subcontract_pos
        (company_id, po_number, project_id, subcontractor_id, status, amount_cents,
         scope_of_work, retainage_pct, notes, created_by)
       VALUES
        ($1,
         (SELECT 'SP-' ||
                 EXTRACT(YEAR FROM CURRENT_DATE)::int ||
                 '-' ||
                 LPAD((COALESCE(MAX(
                   CASE WHEN po_number ~ '^SP-' || EXTRACT(YEAR FROM CURRENT_DATE)::int || '-[0-9]+$'
                        THEN SUBSTRING(po_number FROM '[0-9]+$')::int
                        ELSE 0 END
                 ), 0) + 1)::text, 4, '0')
          FROM subcontract_pos WHERE company_id = $1),
         $2, $3, 'draft', $4, $5, $6, $7, $8)
       RETURNING *`,
      [companyId, req.params.projectId, subcontractor_id, amount_cents,
       scope_of_work.toString().trim(), retainPct, notes || null, req.user.id]
    );
    await logAudit(companyId, req.user.id, req.user.full_name,
      'subcontract_po.created', 'subcontract_po', r.rows[0].id, r.rows[0].po_number,
      { project_id: req.params.projectId, subcontractor_id, amount_cents });
    res.status(201).json(r.rows[0]);
  } catch (err) {
    req.log.error({ err }, 'sub PO create error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/subcontract-pos/:id', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const po = await assertPoInCompany(companyId, req.params.id);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    const paymentsRes = await pool.query(
      'SELECT * FROM subcontract_po_payments WHERE po_id = $1 ORDER BY paid_date DESC, id DESC',
      [req.params.id]
    );
    const paidCents = paymentsRes.rows.reduce((sum, p) => sum + parseInt(p.amount_cents, 10), 0);
    res.json({ ...po, payments: paymentsRes.rows, paid_cents: paidCents, remaining_cents: parseInt(po.amount_cents, 10) - paidCents });
  } catch (err) {
    req.log.error({ err }, 'sub PO detail error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/subcontract-pos/:id', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const po = await assertPoInCompany(companyId, req.params.id);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (po.status !== 'draft') return res.status(409).json({ error: 'Can only edit draft POs' });
    const fields = [];
    const params = [];
    let idx = 1;
    if (req.body.amount_cents !== undefined) {
      const v = typeof req.body.amount_cents === 'number' ? req.body.amount_cents : parseInt(req.body.amount_cents, 10);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'invalid amount_cents' });
      fields.push(`amount_cents = $${idx++}`); params.push(v);
    }
    if (req.body.scope_of_work !== undefined) {
      const v = (req.body.scope_of_work || '').toString().trim();
      if (!v) return res.status(400).json({ error: 'scope_of_work cannot be empty' });
      fields.push(`scope_of_work = $${idx++}`); params.push(v);
    }
    if (req.body.retainage_pct !== undefined) {
      const v = parseFloat(req.body.retainage_pct);
      if (!Number.isFinite(v) || v < 0 || v > 100) return res.status(400).json({ error: 'invalid retainage_pct' });
      fields.push(`retainage_pct = $${idx++}`); params.push(v);
    }
    if (req.body.notes !== undefined) { fields.push(`notes = $${idx++}`); params.push(req.body.notes || null); }
    if (fields.length === 0) return res.json(po);
    params.push(req.params.id);
    const r = await pool.query(
      `UPDATE subcontract_pos SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    await logAudit(companyId, req.user.id, req.user.full_name,
      'subcontract_po.updated', 'subcontract_po', req.params.id, po.po_number, null);
    res.json(r.rows[0]);
  } catch (err) {
    req.log.error({ err }, 'sub PO patch error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/subcontract-pos/:id/issue', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const po = await assertPoInCompany(companyId, req.params.id);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (po.status !== 'draft') return res.status(409).json({ error: 'Can only issue a draft PO' });
    await pool.query(
      `UPDATE subcontract_pos SET status='issued', issued_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    await logAudit(companyId, req.user.id, req.user.full_name,
      'subcontract_po.issued', 'subcontract_po', req.params.id, po.po_number, null);
    const fresh = await assertPoInCompany(companyId, req.params.id);
    res.json(fresh);
  } catch (err) {
    req.log.error({ err }, 'sub PO issue error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/subcontract-pos/:id/cancel', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const po = await assertPoInCompany(companyId, req.params.id);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (po.status === 'complete' || po.status === 'cancelled') {
      return res.status(409).json({ error: `Cannot cancel a ${po.status} PO` });
    }
    await pool.query(
      `UPDATE subcontract_pos SET status='cancelled', cancelled_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    await logAudit(companyId, req.user.id, req.user.full_name,
      'subcontract_po.cancelled', 'subcontract_po', req.params.id, po.po_number,
      { reason: req.body.reason || null });
    const fresh = await assertPoInCompany(companyId, req.params.id);
    res.json(fresh);
  } catch (err) {
    req.log.error({ err }, 'sub PO cancel error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/subcontract-pos/:id', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const po = await assertPoInCompany(companyId, req.params.id);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    if (po.status !== 'draft') return res.status(409).json({ error: 'Can only delete a draft PO' });
    const payCount = await pool.query('SELECT COUNT(*)::int AS c FROM subcontract_po_payments WHERE po_id = $1', [req.params.id]);
    if (payCount.rows[0].c > 0) return res.status(409).json({ error: 'PO has payments; cannot delete' });
    await pool.query('DELETE FROM subcontract_pos WHERE id = $1', [req.params.id]);
    await logAudit(companyId, req.user.id, req.user.full_name,
      'subcontract_po.deleted', 'subcontract_po', req.params.id, po.po_number, null);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, 'sub PO delete error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Sub PO payments ──────────────────────────────────────────────────────────

router.get('/subcontract-pos/:id/payments', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const po = await assertPoInCompany(companyId, req.params.id);
    if (!po) return res.status(404).json({ error: 'PO not found' });
    const r = await pool.query(
      'SELECT * FROM subcontract_po_payments WHERE po_id = $1 ORDER BY paid_date DESC, id DESC',
      [req.params.id]
    );
    res.json({ items: r.rows });
  } catch (err) {
    req.log.error({ err }, 'sub PO payments list error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/subcontract-pos/:id/payments', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const { paid_date, invoice_ref, notes } = req.body;
  const amount_cents = typeof req.body.amount_cents === 'number'
    ? req.body.amount_cents
    : parseInt(req.body.amount_cents, 10);
  if (!paid_date) return res.status(400).json({ error: 'paid_date required' });
  if (!Number.isFinite(amount_cents) || amount_cents < 0) return res.status(400).json({ error: 'invalid amount_cents' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the PO row so the auto-transition is atomic against concurrent payments.
    const poRes = await client.query(
      `SELECT po.*, sub.name AS sub_name, p.name AS project_name
         FROM subcontract_pos po
         LEFT JOIN subcontractors sub ON po.subcontractor_id = sub.id
         LEFT JOIN projects p ON po.project_id = p.id
        WHERE po.id = $1 AND po.company_id = $2 FOR UPDATE OF po`,
      [req.params.id, companyId]
    );
    if (poRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'PO not found' });
    }
    const po = poRes.rows[0];
    if (po.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Cannot pay a cancelled PO' });
    }
    if (po.status === 'draft') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Issue the PO before recording payment' });
    }
    const insertRes = await client.query(
      `INSERT INTO subcontract_po_payments (po_id, amount_cents, paid_date, invoice_ref, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.id, amount_cents, paid_date, invoice_ref || null, notes || null, req.user.id]
    );
    // Recompute paid total and auto-transition.
    const sumRes = await client.query(
      'SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total FROM subcontract_po_payments WHERE po_id = $1',
      [req.params.id]
    );
    const paidCentsAfter = parseInt(sumRes.rows[0].total, 10);
    const newStatus = nextStatusAfterPayment({
      currentStatus: po.status,
      paidCentsAfter,
      amountCents: parseInt(po.amount_cents, 10),
    });
    if (newStatus !== po.status) {
      await client.query(
        `UPDATE subcontract_pos SET status = $1, completed_at = CASE WHEN $1 = 'complete' THEN NOW() ELSE completed_at END WHERE id = $2`,
        [newStatus, req.params.id]
      );
    }
    await client.query('COMMIT');
    await logAudit(companyId, req.user.id, req.user.full_name,
      'subcontract_po_payment.created', 'subcontract_po_payment', insertRes.rows[0].id, po.po_number,
      { po_id: req.params.id, amount_cents, status_after: newStatus });
    const fresh = await assertPoInCompany(companyId, req.params.id);
    res.status(201).json({ payment: insertRes.rows[0], po: fresh, paid_cents: paidCentsAfter });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'sub PO payment create error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.delete('/subcontract-pos/:poId/payments/:paymentId', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const poRes = await client.query(
      'SELECT * FROM subcontract_pos WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [req.params.poId, companyId]
    );
    if (poRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'PO not found' });
    }
    const po = poRes.rows[0];
    const delRes = await client.query(
      'DELETE FROM subcontract_po_payments WHERE id = $1 AND po_id = $2 RETURNING amount_cents',
      [req.params.paymentId, req.params.poId]
    );
    if (delRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Payment not found' });
    }
    // Recompute status. A deletion may roll a 'complete' or 'partial' PO
    // back to 'partial' / 'issued'.
    const sumRes = await client.query(
      'SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total FROM subcontract_po_payments WHERE po_id = $1',
      [req.params.poId]
    );
    const paidCentsAfter = parseInt(sumRes.rows[0].total, 10);
    let newStatus = po.status;
    if (po.status === 'complete' || po.status === 'partial') {
      // Reverse-derive from the new total. If 0 payments → issued.
      // If <amount → partial. If >= amount (rare; deletion can't push it
      // past the original total) → keep complete.
      if (paidCentsAfter === 0) newStatus = 'issued';
      else if (paidCentsAfter < parseInt(po.amount_cents, 10)) newStatus = 'partial';
    }
    if (newStatus !== po.status) {
      await client.query(
        `UPDATE subcontract_pos SET status = $1, completed_at = CASE WHEN $1 != 'complete' THEN NULL ELSE completed_at END WHERE id = $2`,
        [newStatus, req.params.poId]
      );
    }
    await client.query('COMMIT');
    await logAudit(companyId, req.user.id, req.user.full_name,
      'subcontract_po_payment.deleted', 'subcontract_po_payment', req.params.paymentId, po.po_number,
      { po_id: req.params.poId, amount_cents: delRes.rows[0].amount_cents, status_after: newStatus });
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'sub PO payment delete error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
