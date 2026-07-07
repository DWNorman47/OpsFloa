const router = require('express').Router();
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../auditLog');
const { EQUIPMENT_KINDS, RENTAL_RATE_UNITS } = require('../constants/equipmentEnums');

// Parse + validate the shared registry/rental fields for POST and PATCH.
// Returns { error } (a 400 message) or { v } with normalized values. status is
// NOT set here — it's driven by checkout/return/maintenance, not direct edits.
function parseItemBody(body) {
  const name = body.name?.trim();
  const type = body.type?.trim() || null;
  const unit_number = body.unit_number?.trim() || null;
  const notes = body.notes?.trim() || null;
  if (!name) return { error: 'name is required' };
  if (name.length > 255) return { error: 'name too long (max 255 characters)' };
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
  const photo_url = body.photo_url?.trim() || null;
  const num = x => (x != null && x !== '' ? parseFloat(x) : null);

  return {
    v: {
      name, type, unit_number, notes, kind, serial_number, photo_url,
      maintenance_interval_hours: body.maintenance_interval_hours ? parseInt(body.maintenance_interval_hours) : null,
      purchase_date: body.purchase_date || null,
      purchase_cost: num(body.purchase_cost),
      is_rental: !!body.is_rental,
      rental_vendor,
      rental_rate: num(body.rental_rate),
      rental_rate_unit,
      rental_return_due: body.rental_return_due || null,
    },
  };
}

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
  const parsed = parseItemBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.v;
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `INSERT INTO equipment_items
         (company_id, name, type, unit_number, maintenance_interval_hours, notes,
          kind, serial_number, purchase_date, purchase_cost, photo_url,
          is_rental, rental_vendor, rental_rate, rental_rate_unit, rental_return_due)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [companyId, v.name, v.type, v.unit_number, v.maintenance_interval_hours, v.notes,
       v.kind, v.serial_number, v.purchase_date, v.purchase_cost, v.photo_url,
       v.is_rental, v.rental_vendor, v.rental_rate, v.rental_rate_unit, v.rental_return_due]
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
    // Re-arm the rental-return reminder if the due date changed.
    const curDue = cur.rows[0].rental_return_due ? new Date(cur.rows[0].rental_return_due).toISOString().slice(0, 10) : null;
    const dueChanged = curDue !== (v.rental_return_due || null);
    const result = await pool.query(
      `UPDATE equipment_items SET
         name=$1, type=$2, unit_number=$3, maintenance_interval_hours=$4, notes=$5,
         kind=$6, serial_number=$7, purchase_date=$8, purchase_cost=$9, photo_url=$10,
         is_rental=$11, rental_vendor=$12, rental_rate=$13, rental_rate_unit=$14, rental_return_due=$15,
         ${dueChanged ? 'rental_reminder_sent_at=NULL, ' : ''}updated_at=NOW()
       WHERE id=$16 AND company_id=$17 RETURNING *`,
      [v.name, v.type, v.unit_number, v.maintenance_interval_hours, v.notes,
       v.kind, v.serial_number, v.purchase_date, v.purchase_cost, v.photo_url,
       v.is_rental, v.rental_vendor, v.rental_rate, v.rental_rate_unit, v.rental_return_due,
       req.params.id, companyId]
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

    const full = await pool.query(
      `WITH inserted AS (
         INSERT INTO equipment_hours (equipment_id, company_id, project_id, log_date, hours, operator_name, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
       )
       SELECT h.*, p.name AS project_name, u.full_name AS logged_by_name
       FROM inserted h
       LEFT JOIN projects p ON h.project_id = p.id
       LEFT JOIN users u ON h.created_by = u.id`,
      [req.params.id, companyId, project_id || null, log_date, parseFloat(hours),
       operator_name, notes, req.user.id]
    );
    logAudit(companyId, req.user.id, req.user.full_name, 'equipment.hours_logged', 'equipment', req.params.id, null,
      { log_date, hours: parseFloat(hours), project_id: project_id || null });
    res.status(201).json(full.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /equipment/hours/:entryId — delete a single hours entry
router.delete('/hours/:entryId', requireAuth, async (req, res) => {
  const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  try {
    const cond = isAdmin ? 'company_id = $2' : 'company_id = $2 AND created_by = $3';
    const params = isAdmin ? [req.params.entryId, req.user.company_id] : [req.params.entryId, req.user.company_id, req.user.id];
    const result = await pool.query(`DELETE FROM equipment_hours WHERE id = $1 AND ${cond} RETURNING id`, params);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Entry not found' });
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
