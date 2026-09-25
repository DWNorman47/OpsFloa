const router = require('express').Router();
const pool = require('../db');
const logger = require('../logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
// Straight from the permission module (not the middleware/auth re-export) so a
// route test that stubs middleware/auth keeps the real resolver.
const { requirePerm } = require('../permissions');
const { sendEmail } = require('../email');
const { escapeHtml } = require('../utils/htmlEscape');
const { sendPushToUser, sendPushToCompanyAdmins } = require('../push');
const { createInboxItem, createInboxItemBatch } = require('./inbox');
const { logAudit } = require('../auditLog');
const { ymd, weekdayOf, workDaysFromSettings } = require('../utils/hoursRules');
const { workerAccessIds, workerInScope, DENY_WORKER } = require('../utils/workerScope');

const { TIME_OFF_TYPES } = require('../constants/timeOffEnums');
const VALID_TYPES = TIME_OFF_TYPES;
// Reviewing leave is part of time approval — there's no separate time-off key in
// the permission catalog, so approve/deny/revoke/list use approve_entries.
const TIMEOFF_APPROVE_PERM = 'approve_entries';
// Pending and approved requests block the same days; denied / revoked don't.
const ACTIVE_STATUSES_SQL = `('pending', 'approved')`;

// A real calendar date 'YYYY-MM-DD' (rejects 2026-02-30, '2026-9-1', junk) → 400
// instead of a Postgres cast error (500).
function isYmd(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function eachYmd(from, to) {
  const out = [];
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  let d = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  for (let i = 0; d <= end && i < 3700; i++, d += 86400000) out.push(new Date(d).toISOString().substring(0, 10));
  return out;
}

/**
 * Leave DAYS a set of requests uses inside [from, to]: a full-day request counts
 * the company WORKING days it covers (weekends/days off aren't charged against the
 * allowance); a partial (hours on a single day) counts hours / dayHours when its
 * day is in range. Requests are counted by overlap, not by start date, so one that
 * starts in December still charges its January days to January.
 */
function countLeaveDays(requests, { workDays, dayHours, from, to }) {
  let days = 0;
  for (const r of requests || []) {
    const s = ymd(r.start_date), e = ymd(r.end_date);
    if (!s || !e) continue;
    const partial = r.hours != null && r.hours !== '' && s === e;
    if (partial) {
      if (s >= from && s <= to) days += (parseFloat(r.hours) || 0) / dayHours;
      continue;
    }
    const lo = s < from ? from : s, hi = e > to ? to : e;
    if (lo > hi) continue;
    for (const dk of eachYmd(lo, hi)) if (workDays.has(weekdayOf(dk))) days += 1;
  }
  return Math.round(days * 100) / 100;
}

const settingOf = (rows, key) => rows.find(r => r.key === key)?.value;
async function loadLeaveSettings(companyId) {
  const { rows } = await pool.query(
    `SELECT key, value FROM settings WHERE company_id = $1 AND key IN ('pto_annual_days', 'regular_shift_hours', 'hours_rules')`,
    [companyId]
  );
  const annualDays = parseFloat(settingOf(rows, 'pto_annual_days') ?? 0) || 0;
  const rsh = parseFloat(settingOf(rows, 'regular_shift_hours'));
  const dayHours = rsh > 0 ? rsh : 8;
  const workDays = workDaysFromSettings({ hours_rules: settingOf(rows, 'hours_rules') });
  return { annualDays, dayHours, workDays };
}

async function approvedVacationOverlapping(companyId, userId, from, to, excludeId = null) {
  const params = [userId, companyId, from, to];
  let excl = '';
  if (excludeId != null) { params.push(excludeId); excl = `AND id <> $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT id, start_date, end_date, hours FROM time_off_requests
      WHERE user_id = $1 AND company_id = $2 AND status = 'approved' AND type = 'vacation'
        AND start_date <= $4::date AND end_date >= $3::date ${excl}`,
    params
  );
  return rows;
}

// Other requests of the same worker overlapping [start, end] in the given statuses.
async function overlappingRequests(companyId, userId, start, end, { excludeId = null, statuses = ACTIVE_STATUSES_SQL } = {}) {
  const params = [companyId, userId, start, end];
  let excl = '';
  if (excludeId != null) { params.push(excludeId); excl = `AND id <> $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT id, type, status, start_date, end_date, hours FROM time_off_requests
      WHERE company_id = $1 AND user_id = $2 AND status IN ${statuses}
        AND start_date <= $4::date AND end_date >= $3::date ${excl}
      ORDER BY start_date LIMIT 10`,
    params
  );
  return rows.map(r => ({ ...r, start_date: ymd(r.start_date), end_date: ymd(r.end_date) }));
}

const isConfirm = v => v === true || v === 'true' || v === 1 || v === '1';

// POST /time-off — worker submits a request
router.post('/', requireAuth, async (req, res) => {
  const { type, start_date, end_date, note, hours } = req.body;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date are required' });
  if (!isYmd(start_date) || !isYmd(end_date)) return res.status(400).json({ error: 'Dates must be valid YYYY-MM-DD dates' });
  if (end_date < start_date) return res.status(400).json({ error: 'end_date must be on or after start_date' });
  if (type && !VALID_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid type' });
  const noteTrimmed = note?.trim() || null;
  if (noteTrimmed && noteTrimmed.length > 500) return res.status(400).json({ error: 'Note must be 500 characters or fewer' });
  // Optional partial hours: pay exactly this many hours instead of a full day.
  // Only sensible for a single-day request; NULL means a full (schedule-valued) day.
  let hoursVal = null;
  if (hours !== undefined && hours !== null && hours !== '') {
    hoursVal = parseFloat(hours);
    if (!Number.isFinite(hoursVal) || hoursVal <= 0 || hoursVal > 24) return res.status(400).json({ error: 'Hours must be between 0 and 24' });
    if (start_date !== end_date) return res.status(400).json({ error: 'Partial hours apply to a single-day request only' });
  }
  const companyId = req.user.company_id;
  try {
    // One statement: insert only when no pending/approved request of this worker
    // overlaps the dates (leave on one day must not stack — sick + vacation, or a
    // partial on top of a full day).
    const result = await pool.query(
      `INSERT INTO time_off_requests (company_id, user_id, type, start_date, end_date, note, hours)
       SELECT $1::uuid, $2::int, $3::varchar, $4::date, $5::date, $6::text, $7::numeric
       WHERE NOT EXISTS (
         SELECT 1 FROM time_off_requests o
          WHERE o.company_id = $1::uuid AND o.user_id = $2::int AND o.status IN ${ACTIVE_STATUSES_SQL}
            AND o.start_date <= $5::date AND o.end_date >= $4::date)
       RETURNING *`,
      [companyId, req.user.id, type || 'vacation', start_date, end_date, noteTrimmed, hoursVal]
    );
    if (result.rowCount === 0) {
      const conflicts = await overlappingRequests(companyId, req.user.id, start_date, end_date);
      return res.status(409).json({ error: 'You already have a time off request on these dates', code: 'overlap', conflicts });
    }
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
          <b>Dates:</b> ${escapeHtml(start_date)} – ${escapeHtml(end_date)}${note ? `<br/><b>Note:</b> ${escapeHtml(note)}` : ''}</p>
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

// GET /time-off — admin: all requests, optionally filtered by status. A partial
// admin (worker_access_ids) sees only their workers' requests.
router.get('/', requireAdmin, requirePerm(TIMEOFF_APPROVE_PERM), async (req, res) => {
  const { status } = req.query;
  const params = [req.user.company_id];
  const conditions = ['r.company_id = $1'];
  if (status) { params.push(status); conditions.push(`r.status = $${params.length}`); }
  const accessIds = workerAccessIds(req);
  if (accessIds) { params.push(accessIds); conditions.push(`r.user_id = ANY($${params.length}::int[])`); }
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

// Load one request for an admin action: 404 when missing, 403 when the worker is
// outside a partial admin's scope. Returns the row, or null after responding.
async function loadForReview(req, res) {
  if (!/^\d{1,10}$/.test(String(req.params.id))) { res.status(404).json({ error: 'Request not found or already reviewed' }); return null; }
  const { rows } = await pool.query(
    'SELECT * FROM time_off_requests WHERE id = $1 AND company_id = $2',
    [req.params.id, req.user.company_id]
  );
  const row = rows[0];
  if (!row) { res.status(404).json({ error: 'Request not found or already reviewed' }); return null; }
  if (!workerInScope(req, row.user_id)) { res.status(403).json(DENY_WORKER); return null; }
  return row;
}

// PATCH /time-off/:id/approve
//   409 code 'overlap'            — another APPROVED request covers some of these days
//   409 code 'exceeds_allowance'  — vacation would exceed pto_annual_days (resend with
//                                   { confirm: true } to approve anyway)
router.patch('/:id/approve', requireAdmin, requirePerm(TIMEOFF_APPROVE_PERM), async (req, res) => {
  const review_note = req.body.review_note?.trim() || null;
  if (review_note && review_note.length > 500) return res.status(400).json({ error: 'Review note must be 500 characters or fewer' });
  const companyId = req.user.company_id;
  const confirm = isConfirm(req.body.confirm);
  try {
    const current = await loadForReview(req, res);
    if (!current) return;
    if (current.status !== 'pending') return res.status(404).json({ error: 'Request not found or already reviewed' });
    const curStart = ymd(current.start_date), curEnd = ymd(current.end_date);

    const conflicts = await overlappingRequests(companyId, current.user_id, curStart, curEnd, { excludeId: current.id, statuses: `('approved')` });
    if (conflicts.length) {
      return res.status(409).json({ error: 'This worker already has approved time off on these dates', code: 'overlap', conflicts });
    }

    // Annual allowance (vacation only). Checked per calendar year the request touches.
    let allowanceOverride = null;
    if (current.type === 'vacation') {
      const ls = await loadLeaveSettings(companyId);
      if (ls.annualDays > 0) {
        const y0 = Number(curStart.slice(0, 4)), y1 = Number(curEnd.slice(0, 4));
        for (let y = y0; y <= y1; y++) {
          const from = `${y}-01-01`, to = `${y}-12-31`;
          const others = await approvedVacationOverlapping(companyId, current.user_id, from, to, current.id);
          const used = countLeaveDays(others, { ...ls, from, to });
          const requestDays = countLeaveDays([current], { ...ls, from, to });
          if (requestDays > 0 && used + requestDays > ls.annualDays + 1e-9) {
            const details = {
              year: y, annual_days: ls.annualDays, used_days: used, request_days: requestDays,
              remaining_days: Math.max(0, Math.round((ls.annualDays - used) * 100) / 100),
            };
            if (!confirm) {
              return res.status(409).json({ error: 'Approving this exceeds the annual time off allowance', code: 'exceeds_allowance', ...details });
            }
            allowanceOverride = details;
          }
        }
      }
    }

    // Re-check status + overlap inside the UPDATE so a concurrent approval can't slip in.
    const result = await pool.query(
      `UPDATE time_off_requests r SET status = 'approved', reviewed_by = $1, review_note = $2, reviewed_at = NOW()
       WHERE r.id = $3 AND r.company_id = $4 AND r.status = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM time_off_requests o
            WHERE o.company_id = r.company_id AND o.user_id = r.user_id AND o.id <> r.id
              AND o.status = 'approved' AND o.start_date <= r.end_date AND o.end_date >= r.start_date)
       RETURNING *`,
      [req.user.id, review_note || null, req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(409).json({ error: 'Request was changed by someone else — reload and try again', code: 'conflict' });
    const row = result.rows[0];
    // pg returns DATE as a local-midnight Date; ymd() → 'YYYY-MM-DD'. A bare
    // .toString().slice gave "Wed Aug 19" — garbled in the email/push/inbox AND a
    // cast error when bound to $3::date below, so shift-conflict flagging never ran.
    const startStr = ymd(row.start_date);
    const endStr = ymd(row.end_date);
    logAudit(companyId, req.user.id, req.user.full_name, 'timeoff.approved', 'time_off_request', row.id, null,
      { worker_user_id: row.user_id, start_date: startStr, end_date: endStr, ...(allowanceOverride ? { allowance_override: allowanceOverride } : {}) });

    setImmediate(async () => {
      try {
        const worker = await pool.query('SELECT email, full_name FROM users WHERE id = $1', [row.user_id]);
        if (worker.rows[0]?.email) {
          sendEmail(worker.rows[0].email, 'Time off approved ✓',
            `<p>Hi ${escapeHtml(worker.rows[0].full_name || '')},</p><p>Your time off request (<b>${escapeHtml(startStr)}</b> – <b>${escapeHtml(endStr)}</b>) has been <b style="color:#059669">approved</b>.</p>${review_note ? `<p>Note: ${escapeHtml(review_note)}</p>` : ''}<p>— OpsFloa</p>`);
        }
        sendPushToUser(row.user_id, {
          title: 'Time off approved ✓',
          body: `${startStr} – ${endStr}${review_note ? ': ' + review_note : ''}`,
          url: '/timeclock#timeoff',
        });
        createInboxItem(row.user_id, companyId, 'timeoff_approved', 'Time off approved ✓',
          `${startStr} – ${endStr}${review_note ? ' · ' + review_note : ''}`, '/timeclock#timeoff');

        // Flag any scheduled shifts during the approved time-off period. The note is
        // the marker a later revoke uses to undo exactly these flags.
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
router.patch('/:id/deny', requireAdmin, requirePerm(TIMEOFF_APPROVE_PERM), async (req, res) => {
  const review_note = req.body.review_note?.trim() || null;
  if (review_note && review_note.length > 500) return res.status(400).json({ error: 'Review note must be 500 characters or fewer' });
  const companyId = req.user.company_id;
  try {
    const current = await loadForReview(req, res);
    if (!current) return;
    const result = await pool.query(
      `UPDATE time_off_requests SET status = 'denied', reviewed_by = $1, review_note = $2, reviewed_at = NOW()
       WHERE id = $3 AND company_id = $4 AND status = 'pending' RETURNING *`,
      [req.user.id, review_note || null, req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Request not found or already reviewed' });
    const row = result.rows[0];
    const denyStartStr = ymd(row.start_date);
    const denyEndStr = ymd(row.end_date);
    logAudit(companyId, req.user.id, req.user.full_name, 'timeoff.denied', 'time_off_request', row.id, null,
      { worker_user_id: row.user_id, start_date: denyStartStr, end_date: denyEndStr, review_note });
    setImmediate(async () => {
      try {
        const worker = await pool.query('SELECT email, full_name FROM users WHERE id = $1', [row.user_id]);
        if (worker.rows[0]?.email) {
          sendEmail(worker.rows[0].email, 'Time off request denied',
            `<p>Hi ${escapeHtml(worker.rows[0].full_name || '')},</p><p>Your time off request (<b>${escapeHtml(denyStartStr)}</b> – <b>${escapeHtml(denyEndStr)}</b>) was <b style="color:#ef4444">denied</b>.${review_note ? ` Reason: ${escapeHtml(review_note)}` : ''}</p><p>— OpsFloa</p>`);
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

// PATCH /time-off/:id/revoke — admin undoes an APPROVED request (approved → revoked).
// Requires a reason; audit-logged; un-flags the shifts the approval marked
// "can't make it" (only those it marked, and not days another approved request
// still covers). Refused (409 period_locked) when the leave falls in a locked pay
// period — unlock the period first.
router.patch('/:id/revoke', requireAdmin, requirePerm(TIMEOFF_APPROVE_PERM), async (req, res) => {
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason) return res.status(400).json({ error: 'A reason is required to revoke approved time off' });
  if (reason.length > 500) return res.status(400).json({ error: 'Reason must be 500 characters or fewer' });
  const companyId = req.user.company_id;
  try {
    const current = await loadForReview(req, res);
    if (!current) return;
    if (current.status !== 'approved') return res.status(409).json({ error: 'Only approved time off can be revoked', code: 'not_approved' });
    const startStr = ymd(current.start_date), endStr = ymd(current.end_date);

    const locked = await pool.query(
      `SELECT period_start, period_end FROM pay_periods
        WHERE company_id = $1 AND period_start <= $3::date AND period_end >= $2::date LIMIT 1`,
      [companyId, startStr, endStr]
    );
    if (locked.rows.length) {
      return res.status(409).json({ error: 'This time off is in a locked pay period — unlock it first', code: 'period_locked' });
    }

    const result = await pool.query(
      `UPDATE time_off_requests
          SET status = 'revoked', revoked_by = $1, revoked_at = NOW(), revoke_reason = $2
        WHERE id = $3 AND company_id = $4 AND status = 'approved' RETURNING *`,
      [req.user.id, reason, req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(409).json({ error: 'Request was changed by someone else — reload and try again', code: 'conflict' });
    const row = result.rows[0];

    const restored = await pool.query(
      `UPDATE shifts s SET cant_make_it = false, cant_make_it_note = NULL
        WHERE s.user_id = $1 AND s.company_id = $2
          AND s.shift_date >= $3::date AND s.shift_date <= $4::date
          AND s.cant_make_it = true AND s.cant_make_it_note = 'Time off approved'
          AND NOT EXISTS (
            SELECT 1 FROM time_off_requests o
             WHERE o.company_id = $2 AND o.user_id = $1 AND o.status = 'approved' AND o.id <> $5
               AND s.shift_date BETWEEN o.start_date AND o.end_date)
        RETURNING id`,
      [row.user_id, companyId, startStr, endStr, row.id]
    );

    logAudit(companyId, req.user.id, req.user.full_name, 'timeoff.revoked', 'time_off_request', row.id, null,
      { worker_user_id: row.user_id, start_date: startStr, end_date: endStr, reason, shifts_restored: restored.rowCount });

    setImmediate(async () => {
      try {
        sendPushToUser(row.user_id, {
          title: 'Approved time off revoked',
          body: `${startStr} – ${endStr}: ${reason}`,
          url: '/timeclock#timeoff',
        });
        createInboxItem(row.user_id, companyId, 'timeoff_denied', 'Approved time off revoked',
          `${startStr} – ${endStr} · ${reason}`, '/timeclock#timeoff');
      } catch (err) { logger.error({ err }, 'Time off revoke notification error'); }
    });
    res.json({ ...row, shifts_restored: restored.rowCount });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /time-off/balance — worker's PTO (vacation) balance for the current year.
// Counts APPROVED VACATION only (sick/personal/other don't draw on pto_annual_days),
// only company WORKING days, and every request OVERLAPPING the year (a Dec→Jan
// request charges its January days to January). A partial day counts as
// hours / regular_shift_hours.
router.get('/balance', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  let year = new Date().getFullYear();
  if (req.query.year != null) {
    const y = Number(req.query.year);
    if (!Number.isInteger(y) || y < 1900 || y > 3000) return res.status(400).json({ error: 'Invalid year' });
    year = y;
  }
  const from = `${year}-01-01`, to = `${year}-12-31`;
  try {
    const [ls, reqs] = await Promise.all([
      loadLeaveSettings(companyId),
      approvedVacationOverlapping(companyId, req.user.id, from, to),
    ]);
    const usedDays = countLeaveDays(reqs, { ...ls, from, to });
    const round2 = v => Math.round(v * 100) / 100;
    res.json({ annual_days: ls.annualDays, used_days: usedDays, remaining_days: round2(Math.max(0, ls.annualDays - usedDays)) });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /time-off/:id — worker cancels a pending request (an admin may cancel any
// pending request of a worker in their scope).
router.delete('/:id', requireAuth, async (req, res) => {
  const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  const params = [req.params.id, req.user.company_id];
  let ownerCond = '';
  if (!isAdmin) { params.push(req.user.id); ownerCond = `AND user_id = $${params.length}`; }
  else {
    const accessIds = workerAccessIds(req);
    if (accessIds) { params.push(accessIds); ownerCond = `AND user_id = ANY($${params.length}::int[])`; }
  }
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
module.exports.countLeaveDays = countLeaveDays;
module.exports.isYmd = isYmd;
