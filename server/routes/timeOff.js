const router = require('express').Router();
const pool = require('../db');
const logger = require('../logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { sendEmail } = require('../email');
const { escapeHtml } = require('../utils/htmlEscape');
const { sendPushToUser, sendPushToCompanyAdmins } = require('../push');
const { createInboxItem, createInboxItemBatch } = require('./inbox');
const { logAudit } = require('../auditLog');

const VALID_TYPES = ['vacation', 'sick', 'personal', 'other'];

// POST /time-off — worker submits a request
router.post('/', requireAuth, async (req, res) => {
  const { type, start_date, end_date, note } = req.body;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date are required' });
  if (end_date < start_date) return res.status(400).json({ error: 'end_date must be on or after start_date' });
  if (type && !VALID_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid type' });
  const noteTrimmed = note?.trim() || null;
  if (noteTrimmed && noteTrimmed.length > 500) return res.status(400).json({ error: 'Note must be 500 characters or fewer' });
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `INSERT INTO time_off_requests (company_id, user_id, type, start_date, end_date, note)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [companyId, req.user.id, type || 'vacation', start_date, end_date, noteTrimmed]
    );
    logAudit(companyId, req.user.id, req.user.full_name, 'timeoff.submitted', 'time_off_request', result.rows[0].id, null,
      { type: type || 'vacation', start_date, end_date });
    // Notify admins
    setImmediate(async () => {
      try {
        const setting = await pool.query(
          `SELECT value FROM settings WHERE company_id = $1 AND key = 'notify_timeoff_requests'`,
          [companyId]
        );
        if (setting.rows[0]?.value === '0') return;
        const typeLabel = { vacation: 'Vacation', sick: 'Sick', personal: 'Personal', other: 'Other' }[type || 'vacation'];
        const admins = await pool.query(
          `SELECT id, email FROM users WHERE company_id = $1 AND role = 'admin' AND active = true`,
          [companyId]
        );
        const subject = `Time off request: ${req.user.full_name}`;
        const emailBody = `<p><b>${escapeHtml(req.user.full_name)}</b> submitted a time off request.</p>
          <p><b>Type:</b> ${escapeHtml(typeLabel)}<br/>
          <b>Dates:</b> ${start_date} – ${end_date}${note ? `<br/><b>Note:</b> ${escapeHtml(note)}` : ''}</p>
          <p>Log in to OpsFloa to approve or deny.</p>`;
        for (const admin of admins.rows) if (admin.email) sendEmail(admin.email, subject, emailBody);
        createInboxItemBatch(admins.rows.map(a => a.id), companyId, 'timeoff_request',
          `Time off request: ${req.user.full_name}`,
          `${typeLabel} · ${start_date} – ${end_date}`,
          '/workforce#timeoff');
      } catch (err) { logger.error({ err }, 'Time off request notification error'); }
    });
    res.status(201).json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /time-off/mine — worker's own requests
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, COALESCE(u.full_name, '') AS reviewer_name
       FROM time_off_requests r
       LEFT JOIN users u ON r.reviewed_by = u.id
       WHERE r.user_id = $1 AND r.company_id = $2
       ORDER BY r.created_at DESC LIMIT 50`,
      [req.user.id, req.user.company_id]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /time-off — admin: all requests, optionally filtered by status
router.get('/', requireAdmin, async (req, res) => {
  const { status } = req.query;
  const params = [req.user.company_id];
  const conditions = ['r.company_id = $1'];
  if (status) { params.push(status); conditions.push(`r.status = $${params.length}`); }
  try {
    const result = await pool.query(
      `SELECT r.*, COALESCE(u.invoice_name, u.full_name) AS worker_name, u.email AS worker_email,
              COALESCE(rv.full_name, '') AS reviewer_name
       FROM time_off_requests r
       JOIN users u ON r.user_id = u.id
       LEFT JOIN users rv ON r.reviewed_by = rv.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY r.status = 'pending' DESC, r.start_date ASC
       LIMIT 500`,
      params
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /time-off/:id/approve
router.patch('/:id/approve', requireAdmin, async (req, res) => {
  const review_note = req.body.review_note?.trim() || null;
  if (review_note && review_note.length > 500) return res.status(400).json({ error: 'Review note must be 500 characters or fewer' });
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `UPDATE time_off_requests SET status = 'approved', reviewed_by = $1, review_note = $2, reviewed_at = NOW()
       WHERE id = $3 AND company_id = $4 AND status = 'pending' RETURNING *`,
      [req.user.id, review_note || null, req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Request not found or already reviewed' });
    const row = result.rows[0];
    const startStr = row.start_date?.toString().substring(0, 10);
    const endStr = row.end_date?.toString().substring(0, 10);
    logAudit(companyId, req.user.id, req.user.full_name, 'timeoff.approved', 'time_off_request', row.id, null,
      { worker_user_id: row.user_id, start_date: startStr, end_date: endStr });

    setImmediate(async () => {
      try {
        const worker = await pool.query('SELECT email, full_name FROM users WHERE id = $1', [row.user_id]);
        if (worker.rows[0]?.email) {
          sendEmail(worker.rows[0].email, 'Time off approved ✓',
            `<p>Hi ${worker.rows[0].full_name},</p><p>Your time off request (<b>${startStr}</b> – <b>${endStr}</b>) has been <b style="color:#059669">approved</b>.</p>${review_note ? `<p>Note: ${review_note}</p>` : ''}<p>— OpsFloa</p>`);
        }
        sendPushToUser(row.user_id, {
          title: 'Time off approved ✓',
          body: `${startStr} – ${endStr}${review_note ? ': ' + review_note : ''}`,
          url: '/timeclock#timeoff',
        });
        createInboxItem(row.user_id, companyId, 'timeoff_approved', 'Time off approved ✓',
          `${startStr} – ${endStr}${review_note ? ' · ' + review_note : ''}`, '/timeclock#timeoff');

        // Flag any scheduled shifts during the approved time-off period
        const conflictResult = await pool.query(
          `UPDATE shifts SET cant_make_it = true, cant_make_it_note = 'Time off approved'
           WHERE user_id = $1 AND company_id = $2
             AND shift_date >= $3::date AND shift_date <= $4::date
             AND cant_make_it = false
           RETURNING id, shift_date, start_time, end_time`,
          [row.user_id, companyId, startStr, endStr]
        );

        if (conflictResult.rowCount > 0) {
          // Notify admins of the conflicts
          const workerName = worker.rows[0]?.full_name || 'Worker';
          sendPushToCompanyAdmins(companyId, {
            title: `${workerName} has ${conflictResult.rowCount} shift${conflictResult.rowCount !== 1 ? 's' : ''} during approved time off`,
            body: `${startStr} – ${endStr} · Review schedule`,
            url: '/timeclock#manage',
          });
        }
      } catch (err) { logger.error({ err }, 'Time off approval notification error'); }
    });
    res.json(row);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /time-off/:id/deny
router.patch('/:id/deny', requireAdmin, async (req, res) => {
  const review_note = req.body.review_note?.trim() || null;
  if (review_note && review_note.length > 500) return res.status(400).json({ error: 'Review note must be 500 characters or fewer' });
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `UPDATE time_off_requests SET status = 'denied', reviewed_by = $1, review_note = $2, reviewed_at = NOW()
       WHERE id = $3 AND company_id = $4 AND status = 'pending' RETURNING *`,
      [req.user.id, review_note || null, req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Request not found or already reviewed' });
    const row = result.rows[0];
    const denyStartStr = row.start_date?.toString().substring(0, 10);
    const denyEndStr = row.end_date?.toString().substring(0, 10);
    logAudit(companyId, req.user.id, req.user.full_name, 'timeoff.denied', 'time_off_request', row.id, null,
      { worker_user_id: row.user_id, start_date: denyStartStr, end_date: denyEndStr, review_note });
    setImmediate(async () => {
      try {
        const worker = await pool.query('SELECT email, full_name FROM users WHERE id = $1', [row.user_id]);
        if (worker.rows[0]?.email) {
          sendEmail(worker.rows[0].email, 'Time off request denied',
            `<p>Hi ${worker.rows[0].full_name},</p><p>Your time off request (<b>${denyStartStr}</b> – <b>${denyEndStr}</b>) was <b style="color:#ef4444">denied</b>.${review_note ? ` Reason: ${review_note}` : ''}</p><p>— OpsFloa</p>`);
        }
        sendPushToUser(row.user_id, {
          title: 'Time off request denied',
          body: `${denyStartStr} – ${denyEndStr}${review_note ? ': ' + review_note : ''}`,
          url: '/timeclock#timeoff',
        });
        createInboxItem(row.user_id, companyId, 'timeoff_denied', 'Time off request denied',
          `${denyStartStr} – ${denyEndStr}${review_note ? ' · ' + review_note : ''}`, '/timeclock#timeoff');
      } catch (err) { logger.error({ err }, 'Time off denial notification error'); }
    });
    res.json(row);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /time-off/balance — worker's PTO balance for the current year
router.get('/balance', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const [settingResult, usedResult] = await Promise.all([
      pool.query(`SELECT value FROM settings WHERE company_id = $1 AND key = 'pto_annual_days'`, [companyId]),
      pool.query(
        `SELECT COALESCE(SUM(end_date - start_date + 1), 0) AS used_days
         FROM time_off_requests
         WHERE user_id = $1 AND company_id = $2
           AND status = 'approved'
           AND EXTRACT(YEAR FROM start_date) = EXTRACT(YEAR FROM CURRENT_DATE)`,
        [req.user.id, companyId]
      ),
    ]);
    const annualDays = parseFloat(settingResult.rows[0]?.value ?? 0);
    const usedDays = parseInt(usedResult.rows[0]?.used_days ?? 0);
    res.json({ annual_days: annualDays, used_days: usedDays, remaining_days: Math.max(0, annualDays - usedDays) });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /time-off/:id — worker cancels a pending request
router.delete('/:id', requireAuth, async (req, res) => {
  const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  const ownerCond = isAdmin ? '' : 'AND user_id = $3';
  const params = isAdmin
    ? [req.params.id, req.user.company_id]
    : [req.params.id, req.user.company_id, req.user.id];
  try {
    const result = await pool.query(
      `DELETE FROM time_off_requests WHERE id = $1 AND company_id = $2 AND status = 'pending' ${ownerCond} RETURNING id`,
      params
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Request not found or already reviewed' });
    logAudit(req.user.company_id, req.user.id, req.user.full_name, 'timeoff.cancelled', 'time_off_request', req.params.id, null, null);
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
