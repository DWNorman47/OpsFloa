const router = require('express').Router();
const pool = require('../db');
const rateLimit = require('express-rate-limit');
const { userOrIpKey } = require('../middleware/rateLimitKey');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { sendPushToUser, sendPushToCompanyAdmins } = require('../push');
const { createInboxItem, createInboxItemBatch } = require('./inbox');
const { logAudit } = require('../auditLog');
const { weekRange } = require('../utils/weekBounds');

// node-pg returns a DATE column as a Date at local midnight — interpolating it raw yields
// "Thu Jul 30 2026 00:00:00 GMT…" and .toString().substring(0,10) yields "Thu Jul 30" (no
// year). Format to YYYY-MM-DD from the local parts (round-trips since the Date was built at
// local midnight from those parts). Passes strings through unchanged.
function fmtShiftDate(d) {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Cap shift writes per user. Admins legitimately create shifts in bursts
// (weekly scheduling), so the ceiling is higher than chat but still prevents
// runaway scripts or a compromised account from flooding the table.
const shiftWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: userOrIpKey,
  message: { error: 'Too many shift writes. Please wait a moment and try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /admin/shifts?from=&to= — all company shifts in range
router.get('/admin', requireAdmin, async (req, res) => {
  const { from, to } = req.query;
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `SELECT s.*, u.full_name as worker_name, p.name as project_name
       FROM shifts s
       JOIN users u ON s.user_id = u.id
       LEFT JOIN projects p ON s.project_id = p.id
       WHERE s.company_id = $1
         AND ($2::date IS NULL OR s.shift_date >= $2::date)
         AND ($3::date IS NULL OR s.shift_date <= $3::date)
       ORDER BY s.shift_date ASC, s.start_time ASC
       LIMIT 200`,
      [companyId, from || null, to || null]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /admin/shifts — create a shift
router.post('/admin', requireAdmin, shiftWriteLimiter, async (req, res) => {
  const { user_id, project_id, shift_date, start_time, end_time, recurrence_group_id } = req.body;
  const notes = req.body.notes?.trim() || null;
  if (!user_id || !shift_date || !start_time || !end_time) {
    return res.status(400).json({ error: 'user_id, shift_date, start_time, end_time required' });
  }
  if (notes && notes.length > 500) return res.status(400).json({ error: 'notes too long (max 500 characters)' });
  const companyId = req.user.company_id;
  try {
    const workerCheck = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND company_id = $2 AND active = true',
      [user_id, companyId]
    );
    if (workerCheck.rowCount === 0) return res.status(400).json({ error: 'Worker not found' });
    const full = await pool.query(
      `WITH inserted AS (
         INSERT INTO shifts (company_id, user_id, project_id, shift_date, start_time, end_time, notes, recurrence_group_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
       )
       SELECT s.*, u.full_name as worker_name, p.name as project_name
       FROM inserted s
       JOIN users u ON s.user_id = u.id
       LEFT JOIN projects p ON s.project_id = p.id`,
      [companyId, user_id, project_id || null, shift_date, start_time, end_time, notes, recurrence_group_id || null]
    );
    const shift = full.rows[0];
    logAudit(companyId, req.user.id, req.user.full_name, 'shift.created', 'shift', shift.id, shift.worker_name,
      { user_id, shift_date, start_time, end_time, project_id: project_id || null });
    const shiftBody = `${fmtShiftDate(shift.shift_date)} · ${shift.start_time.substring(0, 5)}–${shift.end_time.substring(0, 5)}${shift.project_name ? ' · ' + shift.project_name : ''}`;
    sendPushToUser(user_id, { title: 'New shift assigned', body: shiftBody, url: '/timeclock' });
    createInboxItem(user_id, companyId, 'shift_assigned', 'New shift assigned', shiftBody, '/timeclock#schedule');
    res.status(201).json(shift);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /admin/shifts/:id — edit a shift
router.patch('/admin/:id', requireAdmin, shiftWriteLimiter, async (req, res) => {
  const { project_id, shift_date, start_time, end_time } = req.body;
  const notes = req.body.notes?.trim() || null;
  if (!shift_date || !start_time || !end_time) {
    return res.status(400).json({ error: 'shift_date, start_time, end_time required' });
  }
  if (notes && notes.length > 500) return res.status(400).json({ error: 'notes too long (max 500 characters)' });
  const clientUpdatedAt = req.body.updated_at || null;
  const companyId = req.user.company_id;
  try {
    if (clientUpdatedAt) {
      const cur = await pool.query('SELECT updated_at FROM shifts WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
      if (!cur.rows.length) return res.status(404).json({ error: 'Shift not found' });
      if (new Date(cur.rows[0].updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
        return res.status(409).json({ error: 'conflict' });
      }
    }
    const result = await pool.query(
      `UPDATE shifts SET project_id = $1, shift_date = $2, start_time = $3, end_time = $4, notes = $5, updated_at = NOW()
       WHERE id = $6 AND company_id = $7 RETURNING *`,
      [project_id || null, shift_date, start_time, end_time, notes, req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Shift not found' });
    const full = await pool.query(
      `SELECT s.*, u.full_name as worker_name, p.name as project_name
       FROM shifts s JOIN users u ON s.user_id = u.id LEFT JOIN projects p ON s.project_id = p.id
       WHERE s.id = $1`, [req.params.id]
    );
    const shift = full.rows[0];
    logAudit(companyId, req.user.id, req.user.full_name, 'shift.edited', 'shift', shift.id, shift.worker_name,
      { shift_date, start_time, end_time, project_id: project_id || null });
    const updBody = `${fmtShiftDate(shift.shift_date)} · ${start_time.substring(0,5)}–${end_time.substring(0,5)}`;
    sendPushToUser(shift.user_id, { title: 'Shift updated', body: updBody, url: '/timeclock' });
    createInboxItem(shift.user_id, req.user.company_id, 'shift_updated', 'Shift updated', updBody, '/timeclock#schedule');
    res.json(shift);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /admin/shifts/:id
router.delete('/admin/:id', requireAdmin, shiftWriteLimiter, async (req, res) => {
  try {
    const full = await pool.query(
      `SELECT s.*, u.full_name as worker_name, p.name as project_name
       FROM shifts s JOIN users u ON s.user_id = u.id LEFT JOIN projects p ON s.project_id = p.id
       WHERE s.id = $1 AND s.company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (full.rowCount === 0) return res.status(404).json({ error: 'Shift not found' });
    const shift = full.rows[0];
    await pool.query('DELETE FROM shifts WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
    logAudit(req.user.company_id, req.user.id, req.user.full_name, 'shift.deleted', 'shift', req.params.id, shift.worker_name,
      { shift_date: shift.shift_date, user_id: shift.user_id });
    const cancelBody = `${fmtShiftDate(shift.shift_date)} · ${shift.start_time.substring(0, 5)}–${shift.end_time.substring(0, 5)}${shift.project_name ? ' · ' + shift.project_name : ''}`;
    sendPushToUser(shift.user_id, { title: 'Shift cancelled', body: cancelBody, url: '/timeclock' });
    createInboxItem(shift.user_id, req.user.company_id, 'shift_cancelled', 'Shift cancelled', cancelBody, '/timeclock#schedule');
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /shifts/:id/cant-make-it — worker flags they can't attend
router.patch('/:id/cant-make-it', requireAuth, shiftWriteLimiter, async (req, res) => {
  const { cant_make_it, note } = req.body;
  try {
    const result = await pool.query(
      `UPDATE shifts SET cant_make_it = $1, cant_make_it_note = $2
       WHERE id = $3 AND user_id = $4
       RETURNING *`,
      [!!cant_make_it, note?.trim() || null, req.params.id, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Shift not found' });
    const shift = result.rows[0];
    if (cant_make_it) {
      const dateStr = fmtShiftDate(shift.shift_date);
      const timeStr = shift.start_time?.substring(0, 5) || '';
      const cantBody = `${req.user.full_name} can't make their shift on ${dateStr} · ${timeStr}`;
      sendPushToCompanyAdmins(req.user.company_id, {
        title: `${req.user.full_name} can't make their shift`,
        body: `${dateStr} · ${timeStr}`,
        url: '/workforce#manage',
      });
      const adminIds = await pool.query(
        `SELECT id FROM users WHERE company_id = $1 AND role = 'admin' AND active = true`,
        [req.user.company_id]
      );
      createInboxItemBatch(adminIds.rows.map(a => a.id), req.user.company_id, 'shift_cantmake',
        'Worker unavailable for shift', cantBody, '/workforce#manage');
    }
    res.json(shift);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /admin/shifts/series/:groupId — cancel all future shifts in a recurrence group
router.delete('/admin/series/:groupId', requireAdmin, shiftWriteLimiter, async (req, res) => {
  const companyId = req.user.company_id;
  const { groupId } = req.params;
  try {
    // Only delete today-and-future shifts so past records are preserved
    const result = await pool.query(
      `DELETE FROM shifts
       WHERE recurrence_group_id = $1 AND company_id = $2 AND shift_date >= CURRENT_DATE
       RETURNING id, user_id, shift_date, start_time, end_time`,
      [groupId, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'No upcoming shifts found in this series' });
    logAudit(companyId, req.user.id, req.user.full_name, 'shift.series_deleted', 'shift', groupId, null,
      { deleted_count: result.rowCount });
    // Notify each affected worker once
    const notified = new Set();
    for (const shift of result.rows) {
      if (notified.has(shift.user_id)) continue;
      notified.add(shift.user_id);
      sendPushToUser(shift.user_id, { title: 'Recurring shifts cancelled', body: 'A series of your scheduled shifts has been cancelled.', url: '/timeclock' });
      createInboxItemBatch([shift.user_id], companyId, 'shift_cancelled', 'Recurring shifts cancelled',
        'A series of your scheduled shifts has been cancelled.', '/timeclock#schedule');
    }
    res.json({ deleted: result.rowCount });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /shifts/mine — worker's upcoming shifts
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const co = await pool.query(
      'SELECT plan, subscription_status, trial_ends_at FROM companies WHERE id = $1',
      [req.user.company_id]
    );
    const { plan, subscription_status, trial_ends_at } = co.rows[0] || {};
    const trialActive = subscription_status === 'trial' && (!trial_ends_at || new Date(trial_ends_at) >= new Date());
    const isFree = plan === 'free' && !trialActive;
    // Free plan: current week only. Starter+: any future shift.
    let params = [req.user.id];
    let dateClause = `AND s.shift_date >= CURRENT_DATE`;
    if (isFree) {
      const wsRow = await pool.query("SELECT value FROM settings WHERE company_id = $1 AND key = 'week_start'", [req.user.company_id]);
      const ws = parseInt(wsRow.rows[0]?.value ?? '1', 10);
      const weekStartDate = weekRange(ws, 0).from;
      params.push(weekStartDate);
      dateClause = `AND s.shift_date >= $${params.length}::date AND s.shift_date < ($${params.length}::date + INTERVAL '7 days')`;
    }

    const result = await pool.query(
      `SELECT s.*, p.name as project_name
       FROM shifts s LEFT JOIN projects p ON s.project_id = p.id
       WHERE s.user_id = $1 ${dateClause}
       ORDER BY s.shift_date ASC, s.start_time ASC
       LIMIT 14`,
      params
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
