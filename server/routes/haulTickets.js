const router = require('express').Router();
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requirePerm } = require('../permissions');
const { logAudit } = require('../auditLog');
const { HAUL_UNITS, HAUL_DIRECTIONS } = require('../constants/haulEnums');

const isAdminRole = u => u.role === 'admin' || u.role === 'super_admin';

const FULL_SELECT =
  `SELECT h.*, p.name AS project_name, u.full_name AS created_by_name
     FROM haul_tickets h
     LEFT JOIN projects p ON h.project_id = p.id
     LEFT JOIN users u ON h.created_by = u.id`;

// Validate + normalise a ticket payload. Returns { errors:[], v:{...} }.
function readTicket(body) {
  const errors = [];
  const ticket_date = (body.ticket_date || '').toString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ticket_date) || isNaN(Date.parse(ticket_date))) {
    errors.push('ticket_date must be a valid date (YYYY-MM-DD)');
  }
  const unit = (body.unit || 'CY').toString();
  if (!HAUL_UNITS.includes(unit)) errors.push(`unit must be one of ${HAUL_UNITS.join(', ')}`);
  const direction = (body.direction || 'export').toString();
  if (!HAUL_DIRECTIONS.includes(direction)) errors.push(`direction must be one of ${HAUL_DIRECTIONS.join(', ')}`);
  const qty = (body.qty === '' || body.qty == null) ? 0 : parseFloat(body.qty);
  if (isNaN(qty) || qty < 0) errors.push('qty must be a non-negative number');
  const trimTo = (s, n) => (s ? s.toString().trim().slice(0, n) || null : null);
  return {
    errors,
    v: {
      project_id:  body.project_id || null,
      ticket_date,
      ticket_no:   trimTo(body.ticket_no, 100),
      hauler:      trimTo(body.hauler, 255),
      material:    trimTo(body.material, 255),
      qty:         isNaN(qty) ? 0 : qty,
      unit,
      direction,
      notes:       trimTo(body.notes, 1000),
    },
  };
}

// Confirm a project_id (if given) belongs to the caller's company. Returns
// true if OK (or none given), false if it points elsewhere / doesn't exist.
async function projectOk(projectId, companyId) {
  if (!projectId) return true;
  const { rowCount } = await pool.query(
    'SELECT id FROM projects WHERE id = $1 AND company_id = $2', [projectId, companyId]);
  return rowCount > 0;
}

// GET / — company haul tickets. Worker sees own; admin sees all.
// Filters: ?project_id, ?from, ?to (ticket_date range).
router.get('/', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const { project_id, from, to } = req.query;
  try {
    const conditions = ['h.company_id = $1'];
    const params = [companyId];
    if (!isAdminRole(req.user)) { params.push(req.user.id); conditions.push(`h.created_by = $${params.length}`); }
    if (project_id) { params.push(project_id); conditions.push(`h.project_id = $${params.length}`); }
    if (from) { params.push(from); conditions.push(`h.ticket_date >= $${params.length}`); }
    if (to) { params.push(to); conditions.push(`h.ticket_date <= $${params.length}`); }
    const { rows } = await pool.query(
      `${FULL_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY h.ticket_date DESC, h.id DESC`,
      params
    );
    res.json({ items: rows });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST / — create a haul ticket
router.post('/', requireAuth, requirePerm('manage_haul_tickets'), async (req, res) => {
  const companyId = req.user.company_id;
  const { errors, v } = readTicket(req.body);
  if (errors.length) return res.status(400).json({ error: errors[0] });
  try {
    if (!(await projectOk(v.project_id, companyId))) return res.status(400).json({ error: 'Invalid project' });
    const { rows } = await pool.query(
      `INSERT INTO haul_tickets
         (company_id, project_id, ticket_date, ticket_no, hauler, material, qty, unit, direction, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [companyId, v.project_id, v.ticket_date, v.ticket_no, v.hauler, v.material, v.qty, v.unit, v.direction, v.notes, req.user.id]
    );
    const id = rows[0].id;
    logAudit(companyId, req.user.id, req.user.full_name, 'haul_ticket.created', 'haul_ticket', id,
      v.ticket_no || `${v.qty} ${v.unit}`, { project_id: v.project_id, direction: v.direction });
    const full = await pool.query(`${FULL_SELECT} WHERE h.id = $1`, [id]);
    res.status(201).json(full.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /:id — edit. Worker may only edit their own; admin any.
router.patch('/:id', requireAuth, requirePerm('manage_haul_tickets'), async (req, res) => {
  const companyId = req.user.company_id;
  const { errors, v } = readTicket(req.body);
  if (errors.length) return res.status(400).json({ error: errors[0] });
  try {
    const existing = await pool.query('SELECT created_by FROM haul_tickets WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Ticket not found' });
    if (!isAdminRole(req.user) && existing.rows[0].created_by !== req.user.id) {
      return res.status(403).json({ error: 'You can only edit your own tickets' });
    }
    if (!(await projectOk(v.project_id, companyId))) return res.status(400).json({ error: 'Invalid project' });
    await pool.query(
      `UPDATE haul_tickets SET project_id=$1, ticket_date=$2, ticket_no=$3, hauler=$4, material=$5,
         qty=$6, unit=$7, direction=$8, notes=$9, updated_at=now()
       WHERE id=$10 AND company_id=$11`,
      [v.project_id, v.ticket_date, v.ticket_no, v.hauler, v.material, v.qty, v.unit, v.direction, v.notes, req.params.id, companyId]
    );
    logAudit(companyId, req.user.id, req.user.full_name, 'haul_ticket.edited', 'haul_ticket', req.params.id,
      v.ticket_no || `${v.qty} ${v.unit}`, null);
    const full = await pool.query(`${FULL_SELECT} WHERE h.id = $1`, [req.params.id]);
    res.json(full.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /:id — worker may only delete their own; admin any.
router.delete('/:id', requireAuth, requirePerm('manage_haul_tickets'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const isAdmin = isAdminRole(req.user);
    const cond = isAdmin ? 'company_id=$2' : 'company_id=$2 AND created_by=$3';
    const params = isAdmin ? [req.params.id, companyId] : [req.params.id, companyId, req.user.id];
    const result = await pool.query(`DELETE FROM haul_tickets WHERE id=$1 AND ${cond} RETURNING id, ticket_no`, params);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Ticket not found' });
    logAudit(companyId, req.user.id, req.user.full_name, 'haul_ticket.deleted', 'haul_ticket', req.params.id,
      result.rows[0].ticket_no || null, null);
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
