const router  = require('express').Router();
const crypto  = require('crypto');
const pool    = require('../db');
const logger  = require('../logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../auditLog');
const {
  LIEN_WAIVER_DIRECTIONS,
  LIEN_WAIVER_TYPES,
  LIEN_WAIVER_STATUSES,
  LIEN_WAIVER_SIGNATURE_METHODS,
  unconditionalFor,
} = require('../constants/lienWaiverEnums');

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

async function assertProjectInCompany(companyId, projectId) {
  const r = await pool.query(
    'SELECT id, name FROM projects WHERE id = $1 AND company_id = $2',
    [projectId, companyId]
  );
  return r.rows[0] || null;
}

async function assertWaiverInCompany(companyId, waiverId) {
  const r = await pool.query(
    `SELECT lw.*, p.name AS project_name
       FROM lien_waivers lw
       JOIN projects p ON lw.project_id = p.id
      WHERE lw.id = $1 AND lw.company_id = $2`,
    [waiverId, companyId]
  );
  return r.rows[0] || null;
}

// ── List ─────────────────────────────────────────────────────────────────────

router.get('/lien-waivers', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const { project_id, direction, status, waiver_type } = req.query;
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const conditions = ['lw.company_id = $1'];
  const params = [companyId];
  if (project_id) { params.push(project_id); conditions.push(`lw.project_id = $${params.length}`); }
  if (direction) {
    if (!LIEN_WAIVER_DIRECTIONS.includes(direction)) return res.status(400).json({ error: 'invalid direction' });
    params.push(direction); conditions.push(`lw.direction = $${params.length}`);
  }
  if (status) {
    if (!LIEN_WAIVER_STATUSES.includes(status)) return res.status(400).json({ error: 'invalid status' });
    params.push(status); conditions.push(`lw.status = $${params.length}`);
  }
  if (waiver_type) {
    if (!LIEN_WAIVER_TYPES.includes(waiver_type)) return res.status(400).json({ error: 'invalid waiver_type' });
    params.push(waiver_type); conditions.push(`lw.waiver_type = $${params.length}`);
  }
  const where = conditions.join(' AND ');
  try {
    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM lien_waivers lw WHERE ${where}`, params),
      pool.query(
        `SELECT lw.*, p.name AS project_name, sub.name AS subcontractor_name
           FROM lien_waivers lw
           JOIN projects p ON lw.project_id = p.id
           LEFT JOIN subcontractors sub ON lw.subcontractor_id = sub.id
          WHERE ${where}
          ORDER BY lw.created_at DESC
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
    req.log.error({ err }, 'lien waivers list error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/lien-waivers/outstanding', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    // Outstanding = sub-PO payments that require a waiver but haven't received one.
    const r = await pool.query(
      `SELECT p.id AS payment_id, p.amount_cents, p.paid_date,
              po.id AS po_id, po.po_number, po.project_id, sub.name AS subcontractor_name,
              pr.name AS project_name
         FROM subcontract_po_payments p
         JOIN subcontract_pos po ON p.po_id = po.id
         JOIN projects pr ON po.project_id = pr.id
         LEFT JOIN subcontractors sub ON po.subcontractor_id = sub.id
        WHERE po.company_id = $1
          AND p.waiver_required = true AND p.waiver_received = false
        ORDER BY p.paid_date DESC`,
      [companyId]
    );
    res.json({ items: r.rows });
  } catch (err) {
    req.log.error({ err }, 'outstanding waivers error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Create ───────────────────────────────────────────────────────────────────

router.post('/projects/:projectId/lien-waivers', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const {
    direction, subcontract_po_id, sub_payment_id, subcontractor_id, invoice_id,
    waiver_type, through_date, state, signer_name, signer_title, signer_company, notes,
  } = req.body;
  const amount_cents = typeof req.body.amount_cents === 'number'
    ? req.body.amount_cents : parseInt(req.body.amount_cents, 10);
  if (!LIEN_WAIVER_DIRECTIONS.includes(direction)) return res.status(400).json({ error: 'invalid direction' });
  if (!LIEN_WAIVER_TYPES.includes(waiver_type))    return res.status(400).json({ error: 'invalid waiver_type' });
  if (!Number.isFinite(amount_cents) || amount_cents < 0) return res.status(400).json({ error: 'invalid amount_cents' });
  if (!through_date)   return res.status(400).json({ error: 'through_date required' });
  // Bound through_date: progress waivers can be forward-dated up to 30
  // days (a conditional waiver "upon receipt of next month's draw" is
  // legitimate); refusal of dates beyond that prevents accidental
  // "release all future claims through 2099" signatures. Past dates
  // are bounded at 5 years back as a sanity floor.
  const throughDateObj = new Date(`${through_date}T00:00:00Z`);
  if (Number.isNaN(throughDateObj.getTime())) {
    return res.status(400).json({ error: 'through_date must be a valid YYYY-MM-DD date' });
  }
  const earliestThrough = new Date();
  earliestThrough.setUTCFullYear(earliestThrough.getUTCFullYear() - 5);
  const latestThrough = new Date();
  latestThrough.setUTCDate(latestThrough.getUTCDate() + 30);
  if (throughDateObj < earliestThrough) {
    return res.status(400).json({ error: 'through_date is more than 5 years in the past' });
  }
  if (throughDateObj > latestThrough) {
    return res.status(400).json({ error: 'through_date is more than 30 days in the future' });
  }
  if (!signer_name || !signer_name.toString().trim())     return res.status(400).json({ error: 'signer_name required' });
  if (!signer_company || !signer_company.toString().trim()) return res.status(400).json({ error: 'signer_company required' });
  if (direction === 'from_sub' && !subcontractor_id) return res.status(400).json({ error: 'subcontractor_id required for from_sub direction' });
  try {
    const project = await assertProjectInCompany(companyId, req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const r = await pool.query(
      `INSERT INTO lien_waivers
         (company_id, project_id, direction, subcontract_po_id, sub_payment_id, subcontractor_id,
          invoice_id, waiver_type, amount_cents, through_date, state,
          signer_name, signer_title, signer_company, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        companyId, req.params.projectId, direction,
        subcontract_po_id || null, sub_payment_id || null, subcontractor_id || null,
        invoice_id || null, waiver_type, amount_cents, through_date,
        state ? state.toString().slice(0, 2).toUpperCase() : null,
        signer_name.toString().trim(),
        signer_title ? signer_title.toString().trim() : null,
        signer_company.toString().trim(),
        notes || null, req.user.id,
      ]
    );
    await logAudit(companyId, req.user.id, req.user.full_name,
      'lien_waiver.created', 'lien_waiver', r.rows[0].id,
      `${direction} / ${waiver_type}`, { project_id: req.params.projectId, amount_cents });
    res.status(201).json(r.rows[0]);
  } catch (err) {
    req.log.error({ err }, 'lien waiver create error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/lien-waivers/:id', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const lw = await assertWaiverInCompany(companyId, req.params.id);
    if (!lw) return res.status(404).json({ error: 'Lien waiver not found' });
    const docs = await pool.query(
      'SELECT * FROM lien_waiver_documents WHERE waiver_id = $1 ORDER BY uploaded_at DESC',
      [req.params.id]
    );
    res.json({ ...lw, documents: docs.rows });
  } catch (err) {
    req.log.error({ err }, 'lien waiver detail error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/lien-waivers/:id', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const lw = await assertWaiverInCompany(companyId, req.params.id);
    if (!lw) return res.status(404).json({ error: 'Lien waiver not found' });
    if (lw.status !== 'draft') return res.status(409).json({ error: `Can only edit a draft (current: ${lw.status})` });
    const fields = [];
    const params = [];
    let idx = 1;
    if (req.body.amount_cents !== undefined) {
      const v = typeof req.body.amount_cents === 'number' ? req.body.amount_cents : parseInt(req.body.amount_cents, 10);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'invalid amount_cents' });
      fields.push(`amount_cents = $${idx++}`); params.push(v);
    }
    if (req.body.through_date !== undefined) { fields.push(`through_date = $${idx++}`); params.push(req.body.through_date); }
    if (req.body.signer_name !== undefined) {
      const v = (req.body.signer_name || '').toString().trim();
      if (!v) return res.status(400).json({ error: 'signer_name cannot be empty' });
      fields.push(`signer_name = $${idx++}`); params.push(v);
    }
    if (req.body.signer_title !== undefined) { fields.push(`signer_title = $${idx++}`); params.push(req.body.signer_title ? req.body.signer_title.toString().trim() : null); }
    if (req.body.signer_company !== undefined) {
      const v = (req.body.signer_company || '').toString().trim();
      if (!v) return res.status(400).json({ error: 'signer_company cannot be empty' });
      fields.push(`signer_company = $${idx++}`); params.push(v);
    }
    if (req.body.notes !== undefined) { fields.push(`notes = $${idx++}`); params.push(req.body.notes || null); }
    if (fields.length === 0) return res.json(lw);
    params.push(req.params.id);
    const r = await pool.query(
      `UPDATE lien_waivers SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    res.json(r.rows[0]);
  } catch (err) {
    req.log.error({ err }, 'lien waiver patch error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

router.post('/lien-waivers/:id/send', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const lw = await assertWaiverInCompany(companyId, req.params.id);
    if (!lw) return res.status(404).json({ error: 'Lien waiver not found' });
    if (lw.status !== 'draft') return res.status(409).json({ error: `Cannot send from '${lw.status}'` });
    const rawToken = crypto.randomBytes(32).toString('hex');
    const r = await pool.query(
      `UPDATE lien_waivers SET status='sent', sign_token_hash=$1, send_email_status='pending' WHERE id=$2 RETURNING *`,
      [sha256(rawToken), req.params.id]
    );
    await logAudit(companyId, req.user.id, req.user.full_name,
      'lien_waiver.sent', 'lien_waiver', req.params.id, null, null);
    res.json({ ...r.rows[0], sign_token: rawToken });
  } catch (err) {
    req.log.error({ err }, 'lien waiver send error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/lien-waivers/:id/sign-internal', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const signature_method = req.body.signature_method;
  if (signature_method && !LIEN_WAIVER_SIGNATURE_METHODS.includes(signature_method)) {
    return res.status(400).json({ error: 'invalid signature_method' });
  }
  try {
    const lw = await assertWaiverInCompany(companyId, req.params.id);
    if (!lw) return res.status(404).json({ error: 'Lien waiver not found' });
    if (lw.direction !== 'from_us') return res.status(409).json({ error: 'sign-internal is for from_us waivers' });
    if (!['draft', 'sent'].includes(lw.status)) {
      return res.status(409).json({ error: `Cannot sign from '${lw.status}'` });
    }
    const r = await pool.query(
      `UPDATE lien_waivers SET status='signed', signed_at=NOW(), signed_ip=$1,
         signature_method=COALESCE($2, signature_method),
         signature_data=COALESCE($3, signature_data)
       WHERE id=$4 RETURNING *`,
      [req.ip, signature_method || null, req.body.signature_data || null, req.params.id]
    );
    await logAudit(companyId, req.user.id, req.user.full_name,
      'lien_waiver.signed_internal', 'lien_waiver', req.params.id, null, null);
    res.json(r.rows[0]);
  } catch (err) {
    req.log.error({ err }, 'lien waiver sign-internal error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/lien-waivers/:id/mark-signed', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lwRes = await client.query(
      'SELECT * FROM lien_waivers WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [req.params.id, companyId]
    );
    if (lwRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Lien waiver not found' }); }
    const lw = lwRes.rows[0];
    if (!['sent', 'draft'].includes(lw.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Cannot mark signed from '${lw.status}'` });
    }
    await client.query(
      `UPDATE lien_waivers SET status='received', signed_at=COALESCE(signed_at, NOW()) WHERE id=$1`,
      [req.params.id]
    );
    // Flip the matching sub_payment's waiver_received flag so the
    // closeout auto-status query sees the change.
    if (lw.sub_payment_id) {
      await client.query(
        `UPDATE subcontract_po_payments SET waiver_received = true WHERE id = $1`,
        [lw.sub_payment_id]
      );
    }
    await client.query('COMMIT');
    await logAudit(companyId, req.user.id, req.user.full_name,
      'lien_waiver.received', 'lien_waiver', req.params.id, null,
      { sub_payment_id: lw.sub_payment_id });
    const fresh = await assertWaiverInCompany(companyId, req.params.id);
    res.json(fresh);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'lien waiver mark-signed error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.post('/lien-waivers/:id/convert-unconditional', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const lw = await assertWaiverInCompany(companyId, req.params.id);
    if (!lw) return res.status(404).json({ error: 'Lien waiver not found' });
    const toType = unconditionalFor(lw.waiver_type);
    if (!toType) return res.status(409).json({ error: `Cannot convert ${lw.waiver_type} to unconditional` });
    const r = await pool.query(
      `INSERT INTO lien_waivers
         (company_id, project_id, direction, subcontract_po_id, sub_payment_id, subcontractor_id,
          invoice_id, waiver_type, amount_cents, through_date, state,
          signer_name, signer_title, signer_company, status, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft',$15,$16) RETURNING *`,
      [
        companyId, lw.project_id, lw.direction, lw.subcontract_po_id, lw.sub_payment_id,
        lw.subcontractor_id, lw.invoice_id, toType, lw.amount_cents, lw.through_date, lw.state,
        lw.signer_name, lw.signer_title, lw.signer_company,
        `Converted from conditional waiver #${lw.id}`, req.user.id,
      ]
    );
    await logAudit(companyId, req.user.id, req.user.full_name,
      'lien_waiver.converted_unconditional', 'lien_waiver', r.rows[0].id, null,
      { from_id: lw.id, to_type: toType });
    res.status(201).json(r.rows[0]);
  } catch (err) {
    req.log.error({ err }, 'lien waiver convert error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/lien-waivers/:id/void', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const lw = await assertWaiverInCompany(companyId, req.params.id);
    if (!lw) return res.status(404).json({ error: 'Lien waiver not found' });
    if (lw.status === 'void') return res.status(409).json({ error: 'Already void' });
    await pool.query(
      `UPDATE lien_waivers SET status='void' WHERE id=$1`,
      [req.params.id]
    );
    await logAudit(companyId, req.user.id, req.user.full_name,
      'lien_waiver.voided', 'lien_waiver', req.params.id, null, null);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, 'lien waiver void error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Public signing page ─────────────────────────────────────────────────────

const publicRouter = require('express').Router();

publicRouter.get('/sign/:token', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT lw.id, lw.direction, lw.waiver_type, lw.amount_cents, lw.through_date,
              lw.state, lw.signer_name, lw.signer_title, lw.signer_company, lw.status,
              p.name AS project_name
         FROM lien_waivers lw
         JOIN projects p ON lw.project_id = p.id
        WHERE lw.sign_token_hash = $1`,
      [sha256(req.params.token)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) {
    logger.error({ err }, 'public lien waiver view error');
    res.status(500).json({ error: 'Server error' });
  }
});

publicRouter.post('/sign/:token', async (req, res) => {
  const signerName = (req.body.typed_name || '').toString().trim();
  const signatureMethod = req.body.signature_method;
  if (!signerName) return res.status(400).json({ error: 'typed_name required' });
  if (!LIEN_WAIVER_SIGNATURE_METHODS.includes(signatureMethod)) {
    return res.status(400).json({ error: 'invalid signature_method' });
  }
  const tokenHash = sha256(req.params.token);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lwRes = await client.query(
      `SELECT * FROM lien_waivers WHERE sign_token_hash = $1 FOR UPDATE`,
      [tokenHash]
    );
    if (lwRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const lw = lwRes.rows[0];
    if (lw.status !== 'sent') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Cannot sign from '${lw.status}'` });
    }
    await client.query(
      `UPDATE lien_waivers SET
         status='signed', signed_at=NOW(), signed_ip=$1,
         signer_name=$2, signature_method=$3, signature_data=$4
       WHERE id=$5`,
      [req.ip, signerName, signatureMethod, req.body.signature_data || null, lw.id]
    );
    // For from_sub waivers, also flip the matching payment's flag.
    if (lw.direction === 'from_sub' && lw.sub_payment_id) {
      await client.query(
        `UPDATE subcontract_po_payments SET waiver_received = true WHERE id = $1`,
        [lw.sub_payment_id]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err }, 'public lien waiver sign error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.publicRouter = publicRouter;
module.exports = router;
