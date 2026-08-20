const router = require('express').Router();
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../auditLog');
const { EQUIPMENT_KINDS, RENTAL_RATE_UNITS, EQUIPMENT_RATE_UNITS, EQUIPMENT_MAINTENANCE_KINDS } = require('../constants/equipmentEnums');
const { requireCommercialAccess } = require('../middleware/commercialAccess');
const { uploadBase64 } = require('../r2');
const { projectBelongsToCompany, userBelongsToCompany } = require('../utils/tenantRefs');
const { projectFrozen } = require('../utils/projectCost');

// Upload an optional base64 condition photo (data URL) to R2, returning its URL
// (or null). Done before opening a transaction so the DB connection isn't held
// during the network upload.
async function uploadPhoto(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const { url } = await uploadBase64(dataUrl, 'equipment');
  return url;
}

// Parse + validate the shared registry/rental fields for POST and PATCH.
// Returns { error } (a 400 message) or { v } with normalized values. status is
// NOT set here — it's driven by checkout/return/maintenance, not direct edits.
// Non-negative money/number from a form value: '' / null → null; garbage → error.
function money(x) {
  if (x == null || x === '') return { value: null };
  const n = parseFloat(x);
  if (!Number.isFinite(n) || n < 0) return { error: true };
  return { value: n };
}

function parseItemBody(body, { create = false } = {}) {
  const name = body.name?.trim();
  const type = body.type?.trim() || null;
  const unit_number = body.unit_number?.trim() || null;
  const notes = body.notes?.trim() || null;
  // name is required on create; on PATCH it's only validated when supplied
  // (callers send the full body, but a partial PATCH must not demand it).
  if ((create || body.name !== undefined) && !name) return { error: 'name is required' };
  if (name && name.length > 255) return { error: 'name too long (max 255 characters)' };
  if (type && type.length > 100) return { error: 'type too long (max 100 characters)' };
  if (unit_number && unit_number.length > 100) return { error: 'unit_number too long (max 100 characters)' };
  if (notes && notes.length > 1000) return { error: 'notes too long (max 1000 characters)' };

  const kind = body.kind?.trim() || null;
  if (kind && !EQUIPMENT_KINDS.includes(kind)) return { error: 'invalid kind' };
  const serial_number = body.serial_number?.trim() || null;
  if (serial_number && serial_number.length > 120) return { error: 'serial_number too long (max 120 characters)' };
  const rental_vendor = body.rental_vendor?.trim() || null;
  if (rental_vendor && rental_vendor.length > 255) return { error: 'rental_vendor too long (max 255 characters)' };

  const rental_rate_unit = body.rental_rate_unit?.trim() || null;
  if (rental_rate_unit && !RENTAL_RATE_UNITS.includes(rental_rate_unit)) return { error: 'invalid rental_rate_unit' };
  const rent_out_unit = body.rent_out_unit?.trim() || null;
  if (rent_out_unit && !EQUIPMENT_RATE_UNITS.includes(rent_out_unit)) return { error: 'invalid rent_out_unit' };
  const operating_unit = body.operating_unit?.trim() || null;
  if (operating_unit && !EQUIPMENT_RATE_UNITS.includes(operating_unit)) return { error: 'invalid operating_unit' };
  const photo_url = body.photo_url?.trim() || null;

  const rates = {};
  for (const key of ['purchase_cost', 'rental_rate', 'rent_out_rate', 'mobilization_cost', 'operating_rate']) {
    const r = money(body[key]);
    if (r.error) return { error: `${key} must be a non-negative number` };
    rates[key] = r.value;
  }

  return {
    v: {
      name, type, unit_number, notes, kind, serial_number, photo_url,
      maintenance_interval_hours: body.maintenance_interval_hours ? parseInt(body.maintenance_interval_hours) : null,
      purchase_date: body.purchase_date || null,
      purchase_cost: rates.purchase_cost,
      is_rental: !!body.is_rental,
      rental_vendor,
      rental_rate: rates.rental_rate,
      rental_rate_unit,
      rental_return_due: body.rental_return_due || null,
      rent_out_rate: rates.rent_out_rate,
      rent_out_unit,
      mobilization_cost: rates.mobilization_cost,
      operating_rate: rates.operating_rate,
      operating_unit,
    },
  };
}

// Columns a PATCH may touch, in the order used for the dynamic SET. A PATCH
// updates ONLY the keys actually present in the request body — so editing an
// asset's name from the registry form no longer wipes its rental/cost fields.
const PATCH_COLS = [
  'name', 'type', 'unit_number', 'maintenance_interval_hours', 'notes', 'kind',
  'serial_number', 'purchase_date', 'purchase_cost', 'photo_url', 'is_rental',
  'rental_vendor', 'rental_rate', 'rental_rate_unit', 'rental_return_due',
  'rent_out_rate', 'rent_out_unit', 'mobilization_cost', 'operating_rate', 'operating_unit',
];

// GET /equipment — list all active equipment items with total hours
router.get('/', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `SELECT e.*,
              COALESCE(SUM(h.hours), 0)::DECIMAL(10,2) AS total_hours,
              COUNT(h.id) AS log_count,
              MAX(h.log_date) AS last_logged
       FROM equipment_items e
       LEFT JOIN equipment_hours h ON h.equipment_id = e.id
       WHERE e.company_id = $1 AND e.active = true
       GROUP BY e.id
       ORDER BY e.name ASC
       LIMIT 500`,
      [companyId]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /equipment — create equipment item (admin)
router.post('/', requireAdmin, async (req, res) => {
  const parsed = parseItemBody(req.body, { create: true });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.v;
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `INSERT INTO equipment_items
         (company_id, name, type, unit_number, maintenance_interval_hours, notes,
          kind, serial_number, purchase_date, purchase_cost, photo_url,
          is_rental, rental_vendor, rental_rate, rental_rate_unit, rental_return_due,
          rent_out_rate, rent_out_unit, mobilization_cost, operating_rate, operating_unit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
      [companyId, v.name, v.type, v.unit_number, v.maintenance_interval_hours, v.notes,
       v.kind, v.serial_number, v.purchase_date, v.purchase_cost, v.photo_url,
       v.is_rental, v.rental_vendor, v.rental_rate, v.rental_rate_unit, v.rental_return_due,
       v.rent_out_rate, v.rent_out_unit, v.mobilization_cost, v.operating_rate, v.operating_unit]
    );
    logAudit(companyId, req.user.id, req.user.full_name, 'equipment.created', 'equipment', result.rows[0].id, v.name,
      { type: v.type, unit_number: v.unit_number });
    res.status(201).json({ ...result.rows[0], total_hours: 0, log_count: 0, last_logged: null });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /equipment/:id — update item (admin)
router.patch('/:id', requireAdmin, async (req, res) => {
  const parsed = parseItemBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.v;
  const clientUpdatedAt = req.body.updated_at || null;
  const companyId = req.user.company_id;
  try {
    const cur = await pool.query(
      'SELECT updated_at, rental_return_due FROM equipment_items WHERE id=$1 AND company_id=$2',
      [req.params.id, companyId]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Equipment not found' });
    if (clientUpdatedAt && new Date(cur.rows[0].updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({ error: 'conflict' });
    }
    // Partial update: touch only the columns the request actually sent.
    const provided = PATCH_COLS.filter(col => Object.prototype.hasOwnProperty.call(req.body, col));
    if (provided.length === 0) return res.status(400).json({ error: 'No fields to update' });
    const params = [];
    const sets = provided.map(col => { params.push(v[col]); return `${col}=$${params.length}`; });
    // Re-arm the rental-return reminder if the due date was sent and changed.
    if (provided.includes('rental_return_due')) {
      const curDue = cur.rows[0].rental_return_due ? new Date(cur.rows[0].rental_return_due).toISOString().slice(0, 10) : null;
      if (curDue !== (v.rental_return_due || null)) sets.push('rental_reminder_sent_at=NULL');
    }
    sets.push('updated_at=NOW()');
    params.push(req.params.id); const idIdx = params.length;
    params.push(companyId);     const coIdx = params.length;
    const result = await pool.query(
      `UPDATE equipment_items SET ${sets.join(', ')}
        WHERE id=$${idIdx} AND company_id=$${coIdx} RETURNING *`,
      params
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Equipment not found' });
    logAudit(companyId, req.user.id, req.user.full_name, 'equipment.edited', 'equipment', req.params.id, v.name, null);
    res.json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /equipment/:id — soft-delete (admin)
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE equipment_items SET active = false WHERE id = $1 AND company_id = $2 RETURNING id',
      [req.params.id, req.user.company_id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Equipment not found' });
    logAudit(req.user.company_id, req.user.id, req.user.full_name, 'equipment.archived', 'equipment', req.params.id, null, null);
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /equipment/:id/estimate-lines — resolve a machine's rates into estimate
// line shapes so it can be dropped onto an estimate. Returns the mobilization
// (round-trip) charge and the operating (on-job) rate as separate lines; if
// neither is set, the rent-out rate; and always at least one line to fill in.
// Money on the asset is DECIMAL dollars → converted to integer cents here.
// `part` lets the client localize the description (`${name} — <label>`).
router.get('/:id/estimate-lines', requireAuth, requireCommercialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const r = await pool.query(
      `SELECT id, name, mobilization_cost, operating_rate, operating_unit,
              rent_out_rate, rent_out_unit
         FROM equipment_items WHERE id = $1 AND company_id = $2 AND active = true`,
      [req.params.id, companyId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Equipment not found' });
    const a = r.rows[0];
    const cents = dollars => Math.round(parseFloat(dollars) * 100);
    const lines = [];
    if (a.mobilization_cost != null && parseFloat(a.mobilization_cost) > 0) {
      lines.push({ part: 'mobilization', category: 'equipment', qty: 1, unit: 'trip', unit_cost_cents: cents(a.mobilization_cost) });
    }
    if (a.operating_rate != null && parseFloat(a.operating_rate) > 0) {
      lines.push({ part: 'operating', category: 'equipment', qty: 1, unit: a.operating_unit || 'hour', unit_cost_cents: cents(a.operating_rate) });
    }
    if (lines.length === 0 && a.rent_out_rate != null && parseFloat(a.rent_out_rate) > 0) {
      lines.push({ part: 'rental', category: 'equipment', qty: 1, unit: a.rent_out_unit || 'day', unit_cost_cents: cents(a.rent_out_rate) });
    }
    if (lines.length === 0) {
      lines.push({ part: 'base', category: 'equipment', qty: 1, unit: 'day', unit_cost_cents: 0 });
    }
    res.json({ asset_id: a.id, name: a.name, lines });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /equipment/:id/hours — hours log for one item
router.get('/:id/hours', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const { from, to, limit = 50 } = req.query;
  const conditions = ['h.company_id = $1', 'h.equipment_id = $2'];
  const params = [companyId, req.params.id];
  if (from) { params.push(from); conditions.push(`h.log_date >= $${params.length}`); }
  if (to) { params.push(to); conditions.push(`h.log_date <= $${params.length}`); }
  try {
    const result = await pool.query(
      `SELECT h.*, p.name AS project_name, u.full_name AS logged_by_name
       FROM equipment_hours h
       LEFT JOIN projects p ON h.project_id = p.id
       LEFT JOIN users u ON h.created_by = u.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY h.log_date DESC, h.created_at DESC
       LIMIT $${params.length + 1}`,
      [...params, parseInt(limit)]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /equipment/:id/hours — log hours for an item
router.post('/:id/hours', requireAuth, async (req, res) => {
  const { log_date, hours, project_id } = req.body;
  const operator_name = req.body.operator_name?.trim() || null;
  const notes = req.body.notes?.trim() || null;
  if (!log_date || !hours) return res.status(400).json({ error: 'log_date and hours are required' });
  // Bound hours: raw parseFloat let a negative slip through (`!(-100)` is false), and
  // operating_rate × hours feeds project cost — so −100h at $50/h booked a −$5,000 credit
  // that erased other real equipment cost. A day has 24 hours, so cap there.
  const hrs = parseFloat(hours);
  if (!Number.isFinite(hrs) || hrs <= 0 || hrs > 24) return res.status(400).json({ error: 'hours must be a number between 0 and 24' });
  if (operator_name && operator_name.length > 255) return res.status(400).json({ error: 'operator_name too long (max 255 characters)' });
  if (notes && notes.length > 1000) return res.status(400).json({ error: 'notes too long (max 1000 characters)' });
  const companyId = req.user.company_id;
  // Verify item belongs to this company
  try {
    const item = await pool.query(
      'SELECT id FROM equipment_items WHERE id = $1 AND company_id = $2 AND active = true',
      [req.params.id, companyId]
    );
    if (item.rowCount === 0) return res.status(404).json({ error: 'Equipment not found' });
    if (!(await projectBelongsToCompany(pool, project_id, companyId))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    // Equipment hours are a project COST (via equipmentUsageCents) — don't let them land
    // on a closed/final project, matching the guard on every other cost mutation.
    if (project_id != null && await projectFrozen(project_id)) {
      return res.status(409).json({ error: 'This project is closed and can no longer accept cost changes.', code: 'project_frozen' });
    }

    const full = await pool.query(
      `WITH inserted AS (
         INSERT INTO equipment_hours (equipment_id, company_id, project_id, log_date, hours, operator_name, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
       )
       SELECT h.*, p.name AS project_name, u.full_name AS logged_by_name
       FROM inserted h
       LEFT JOIN projects p ON h.project_id = p.id
       LEFT JOIN users u ON h.created_by = u.id`,
      [req.params.id, companyId, project_id || null, log_date, hrs,
       operator_name, notes, req.user.id]
    );
    logAudit(companyId, req.user.id, req.user.full_name, 'equipment.hours_logged', 'equipment', req.params.id, null,
      { log_date, hours: hrs, project_id: project_id || null });
    res.status(201).json(full.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /equipment/hours/:entryId — delete a single hours entry
router.delete('/hours/:entryId', requireAuth, async (req, res) => {
  const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  try {
    const cond = isAdmin ? 'company_id = $2' : 'company_id = $2 AND created_by = $3';
    const params = isAdmin ? [req.params.entryId, req.user.company_id] : [req.params.entryId, req.user.company_id, req.user.id];
    // Deleting hours lowers a project's equipment cost — block it on a closed project.
    const found = await pool.query(`SELECT project_id FROM equipment_hours WHERE id = $1 AND ${cond}`, params);
    if (found.rowCount === 0) return res.status(404).json({ error: 'Entry not found' });
    if (found.rows[0].project_id != null && await projectFrozen(found.rows[0].project_id)) {
      return res.status(409).json({ error: 'This project is closed and can no longer accept cost changes.', code: 'project_frozen' });
    }
    const result = await pool.query(`DELETE FROM equipment_hours WHERE id = $1 AND ${cond} RETURNING id`, params);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Entry not found' });
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// ── Custody: check-out / return ──────────────────────────────────────────────

// GET /equipment/checkouts — open checkouts (who has what out) for the company.
router.get('/checkouts', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `SELECT c.*, e.name AS asset_name, e.unit_number, e.kind,
              u.full_name AS holder_name, p.name AS project_name
       FROM equipment_checkouts c
       JOIN equipment_items e ON e.id = c.asset_id
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN projects p ON p.id = c.project_id
       WHERE c.company_id = $1 AND c.returned_at IS NULL
       ORDER BY c.due_at ASC NULLS LAST, c.checked_out_at DESC
       LIMIT 500`,
      [companyId]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /equipment/:id/checkouts — custody history for one asset.
router.get('/:id/checkouts', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `SELECT c.*, u.full_name AS holder_name, p.name AS project_name, b.full_name AS checked_out_by_name
       FROM equipment_checkouts c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN projects p ON p.id = c.project_id
       LEFT JOIN users b ON b.id = c.checked_out_by
       WHERE c.company_id = $1 AND c.asset_id = $2
       ORDER BY c.checked_out_at DESC
       LIMIT 200`,
      [companyId, req.params.id]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /equipment/:id/checkout — assign an available asset to a worker/project.
// Field self-service (requireAuth). The partial unique index on the checkouts
// table (one open row per asset) is the authoritative race backstop.
router.post('/:id/checkout', requireAuth, async (req, res) => {
  const { user_id, project_id, due_at } = req.body;
  const notes = req.body.notes?.trim() || null;
  const companyId = req.user.company_id;
  try {
    if (!(await userBelongsToCompany(pool, user_id, companyId))) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!(await projectBelongsToCompany(pool, project_id, companyId))) {
      return res.status(404).json({ error: 'Project not found' });
    }
  } catch (err) {
    req.log.error({ err }, 'route error');
    return res.status(500).json({ error: 'Server error' });
  }
  let checkout_photo_url = req.body.checkout_photo_url?.trim() || null;
  try { checkout_photo_url = (await uploadPhoto(req.body.checkout_photo)) || checkout_photo_url; }
  catch (err) { req.log.error({ err }, 'photo upload'); return res.status(400).json({ error: 'Photo upload failed' }); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const asset = await client.query(
      "SELECT status FROM equipment_items WHERE id=$1 AND company_id=$2 AND active=true",
      [req.params.id, companyId]
    );
    if (asset.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Equipment not found' }); }
    if (asset.rows[0].status !== 'available') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Not available' }); }
    const co = await client.query(
      `INSERT INTO equipment_checkouts
         (asset_id, company_id, user_id, project_id, checked_out_by, due_at, checkout_photo_url, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, companyId, user_id || null, project_id || null, req.user.id, due_at || null, checkout_photo_url, notes]
    );
    await client.query("UPDATE equipment_items SET status='checked_out', updated_at=NOW() WHERE id=$1 AND company_id=$2",
      [req.params.id, companyId]);
    await client.query('COMMIT');
    logAudit(companyId, req.user.id, req.user.full_name, 'equipment.checked_out', 'equipment', req.params.id, null,
      { user_id: user_id || null, project_id: project_id || null });
    res.status(201).json(co.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'already checked out' });
    req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// POST /equipment/:id/return — close the open checkout and free the asset.
router.post('/:id/return', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  let return_photo_url = req.body.return_photo_url?.trim() || null;
  try { return_photo_url = (await uploadPhoto(req.body.return_photo)) || return_photo_url; }
  catch (err) { req.log.error({ err }, 'photo upload'); return res.status(400).json({ error: 'Photo upload failed' }); }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const co = await client.query(
      `UPDATE equipment_checkouts SET returned_at=NOW(), return_photo_url=COALESCE($3, return_photo_url)
       WHERE asset_id=$1 AND company_id=$2 AND returned_at IS NULL RETURNING *`,
      [req.params.id, companyId, return_photo_url]
    );
    if (co.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No open checkout' }); }
    await client.query("UPDATE equipment_items SET status='available', updated_at=NOW() WHERE id=$1 AND company_id=$2",
      [req.params.id, companyId]);
    await client.query('COMMIT');
    logAudit(companyId, req.user.id, req.user.full_name, 'equipment.returned', 'equipment', req.params.id, null, null);
    res.json(co.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// ── Maintenance service records (distinct from the usage-hours log) ──────────

// GET /equipment/:id/maintenance — service records for one asset.
router.get('/:id/maintenance', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `SELECT m.*, u.full_name AS logged_by_name
       FROM equipment_maintenance_logs m
       LEFT JOIN users u ON u.id = m.created_by
       WHERE m.company_id = $1 AND m.asset_id = $2
       ORDER BY m.log_date DESC, m.created_at DESC
       LIMIT 200`,
      [companyId, req.params.id]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /equipment/:id/maintenance — add a service record (admin).
router.post('/:id/maintenance', requireAdmin, async (req, res) => {
  const { log_date, kind, cost } = req.body;
  const notes = req.body.notes?.trim() || null;
  const performed_by = req.body.performed_by?.trim() || null;
  if (!log_date) return res.status(400).json({ error: 'log_date is required' });
  if (kind && !EQUIPMENT_MAINTENANCE_KINDS.includes(kind)) return res.status(400).json({ error: 'invalid kind' });
  if (performed_by && performed_by.length > 255) return res.status(400).json({ error: 'performed_by too long (max 255 characters)' });
  if (notes && notes.length > 1000) return res.status(400).json({ error: 'notes too long (max 1000 characters)' });
  const companyId = req.user.company_id;
  try {
    const item = await pool.query('SELECT id FROM equipment_items WHERE id=$1 AND company_id=$2 AND active=true', [req.params.id, companyId]);
    if (item.rowCount === 0) return res.status(404).json({ error: 'Equipment not found' });
    const full = await pool.query(
      `WITH inserted AS (
         INSERT INTO equipment_maintenance_logs (asset_id, company_id, log_date, kind, notes, cost, performed_by, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
       )
       SELECT m.*, u.full_name AS logged_by_name FROM inserted m LEFT JOIN users u ON u.id = m.created_by`,
      [req.params.id, companyId, log_date, kind || 'service', notes,
       cost != null && cost !== '' ? parseFloat(cost) : null, performed_by, req.user.id]
    );
    logAudit(companyId, req.user.id, req.user.full_name, 'equipment.maintenance_logged', 'equipment', req.params.id, null,
      { log_date, kind: kind || 'service' });
    res.status(201).json(full.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /equipment/maintenance/:entryId — delete a service record (admin or owner).
router.delete('/maintenance/:entryId', requireAuth, async (req, res) => {
  const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  try {
    const cond = isAdmin ? 'company_id = $2' : 'company_id = $2 AND created_by = $3';
    const params = isAdmin ? [req.params.entryId, req.user.company_id] : [req.params.entryId, req.user.company_id, req.user.id];
    const result = await pool.query(`DELETE FROM equipment_maintenance_logs WHERE id = $1 AND ${cond} RETURNING id`, params);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Entry not found' });
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
