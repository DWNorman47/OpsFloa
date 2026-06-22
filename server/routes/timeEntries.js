const router = require('express').Router();
const pool = require('../db');
const logger = require('../logger');
const { requireAuth } = require('../middleware/auth');
const { sendPushToUser, sendPushToCompanyAdmins } = require('../push');
const { createInboxItem } = require('./inbox');
const { sendEmail } = require('../email');
const { logAudit } = require('../auditLog');
const { coerceBody } = require('../middleware/coerce');
const { logFailure } = require('../failureLog');
const { SETTINGS_DEFAULTS, applySettingsRows } = require('../settingsDefaults');
const { entryInstants } = require('../utils/timeFormat');
const rateLimit = require('express-rate-limit');
const { userOrIpKey } = require('../middleware/rateLimitKey');

// Returns the company-wide feature_worker_edit_time flag (defaults to true).
async function workerEditAllowed(companyId) {
  const r = await pool.query(
    `SELECT key, value FROM settings WHERE company_id = $1 AND key = 'feature_worker_edit_time'`,
    [companyId]
  );
  return applySettingsRows(r.rows, SETTINGS_DEFAULTS).feature_worker_edit_time !== false;
}

const entryWriteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 120, // generous — manual entry is rare, but admins can bulk-add
  keyGenerator: userOrIpKey,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Get current user's entries
router.get('/', requireAuth, async (req, res) => {
  try {
    const co = await pool.query(
      'SELECT plan, subscription_status, trial_ends_at FROM companies WHERE id = $1',
      [req.user.company_id]
    );
    const { plan, subscription_status, trial_ends_at } = co.rows[0] || {};
    const trialActive = subscription_status === 'trial' && (!trial_ends_at || new Date(trial_ends_at) >= new Date());
    const isFree = plan === 'free' && !trialActive;
    const dateClause = isFree ? `AND te.work_date >= CURRENT_DATE - INTERVAL '90 days'` : '';

    const result = await pool.query(
      `SELECT te.*, p.name as project_name
       FROM time_entries te
       LEFT JOIN projects p ON te.project_id = p.id
       WHERE te.user_id = $1 ${dateClause}
       ORDER BY te.work_date DESC, te.start_time DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Submit a time entry (wage_type inherited from project)
router.post('/', requireAuth, entryWriteLimiter,
  coerceBody({ int: ['project_id', 'break_minutes'], float: ['mileage'] }),
  async (req, res) => {
  const { project_id, work_date, start_time, end_time, break_minutes, mileage, timezone, client_id } = req.body;
  const notesTrimmed = req.body.notes?.trim() || null;
  if (!project_id || !work_date || !start_time || !end_time) {
    logFailure(req, 'time_entries.create', 'missing_required_fields',
      { has_project: !!project_id, has_work_date: !!work_date, has_start: !!start_time, has_end: !!end_time });
    return res.status(400).json({ error: 'project_id, work_date, start_time, and end_time are required' });
  }
  if (notesTrimmed && notesTrimmed.length > 500) {
    logFailure(req, 'time_entries.create', 'notes_too_long', { length: notesTrimmed.length });
    return res.status(400).json({ error: 'Notes must be 500 characters or fewer' });
  }
  const companyId = req.user.company_id;
  try {
    // Free tier: block submissions dated > 90 days ago. Matches the GET
    // visibility clause at the top of this file so workers can't silently
    // submit back-dated entries they'd never be able to see or edit.
    const co = await pool.query(
      'SELECT plan, subscription_status, trial_ends_at FROM companies WHERE id = $1',
      [companyId]
    );
    const { plan, subscription_status, trial_ends_at } = co.rows[0] || {};
    const trialActive = subscription_status === 'trial' && (!trial_ends_at || new Date(trial_ends_at) >= new Date());
    const isFree = plan === 'free' && !trialActive;
    if (isFree) {
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      const workDate = new Date(work_date + 'T00:00:00');
      if (workDate < ninetyDaysAgo) {
        logFailure(req, 'time_entries.create', 'free_plan_date_limit', { work_date });
        return res.status(403).json({ error: 'Free plan is limited to entries within the last 90 days. Upgrade to submit older entries.' });
      }
    }

    const projectResult = await pool.query(
      'SELECT wage_type FROM projects WHERE id = $1 AND company_id = $2',
      [project_id, companyId]
    );
    if (projectResult.rowCount === 0) {
      logFailure(req, 'time_entries.create', 'project_not_found', { project_id });
      return res.status(400).json({ error: 'Project not found' });
    }
    const wage_type = projectResult.rows[0].wage_type;

    const bm = break_minutes ?? 0;
    if (bm < 0) {
      logFailure(req, 'time_entries.create', 'negative_break', { break_minutes: bm });
      return res.status(400).json({ error: 'break_minutes must be non-negative' });
    }
    const mileageVal = (mileage != null && mileage >= 0) ? mileage : null;
    const cid = (typeof client_id === 'string' && client_id.length <= 36) ? client_id : null;
    // Phase 2 dual-write: derive matching UTC instants from wall-clock + tz.
    const { start_ts, end_ts } = entryInstants(work_date, start_time, end_time, timezone);
    const result = await pool.query(
      `INSERT INTO time_entries (company_id, user_id, project_id, work_date, start_time, end_time, start_ts, end_ts, wage_type, notes, break_minutes, mileage, timezone, client_id, clock_source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
       RETURNING *`,
      [companyId, req.user.id, project_id, work_date, start_time, end_time, start_ts, end_ts, wage_type, notesTrimmed,
       bm, mileageVal, timezone || null, cid, 'log_entry']
    );
    if (result.rowCount === 0) {
      logFailure(req, 'time_entries.create', 'duplicate_entry', { client_id: cid });
      return res.status(409).json({ error: 'Duplicate entry' });
    }
    const entry = result.rows[0];
    logAudit(companyId, req.user.id, req.user.full_name, 'entry.submitted', 'time_entry', entry.id, null,
      { work_date, start_time, end_time, project_id });
    res.status(201).json(entry);
    // Optionally notify admins on submission
    setImmediate(async () => {
      try {
        const notifSetting = await pool.query(
          `SELECT value FROM settings WHERE company_id = $1 AND key = 'notify_entry_submitted'`,
          [companyId]
        );
        if (notifSetting.rows[0]?.value !== '1') return;
        const admins = await pool.query(
          `SELECT email FROM users WHERE company_id = $1 AND role = 'admin' AND email IS NOT NULL`,
          [companyId]
        );
        const subject = `Time entry submitted: ${req.user.full_name}`;
        const body = `<p><b>${req.user.full_name}</b> submitted a time entry for <b>${work_date}</b> (${start_time}–${end_time}).</p><p>— OpsFloa</p>`;
        for (const admin of admins.rows) sendEmail(admin.email, subject, body);
      } catch (err) { logger.error({ err }, 'Entry notification error'); }
    });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Edit an entry (own entries only, within 7 days)
router.patch('/:id', requireAuth, async (req, res) => {
  const { start_time, end_time, notes, break_minutes, mileage } = req.body;
  if (!start_time || !end_time) return res.status(400).json({ error: 'start_time and end_time required' });
  if (notes && notes.length > 500) return res.status(400).json({ error: 'Notes must be 500 characters or fewer' });
  // Allow midnight-crossing shifts (end_time < start_time is valid, e.g. 23:00–00:30)
  try {
    if (!(await workerEditAllowed(req.user.company_id))) {
      return res.status(403).json({ error: 'Editing your own time is disabled by your administrator. Ask an admin to make the change.' });
    }
    const existing = await pool.query(
      'SELECT * FROM time_entries WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Entry not found' });
    const entry = existing.rows[0];
    const entryDate = new Date(entry.work_date);
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
    if (entryDate < cutoff) return res.status(403).json({ error: 'Entries older than 7 days cannot be edited' });
    if (entry.locked) return res.status(403).json({ error: 'This entry has been approved and cannot be edited' });
    const locked = await pool.query(
      'SELECT id FROM pay_periods WHERE company_id = $1 AND period_start <= $2 AND period_end >= $2',
      [req.user.company_id, entry.work_date]
    );
    if (locked.rowCount > 0) return res.status(403).json({ error: 'This entry is in a locked pay period' });
    const bm = parseInt(break_minutes) || 0;
    if (bm < 0) return res.status(400).json({ error: 'break_minutes must be non-negative' });
    const mileageParsed = mileage != null ? parseFloat(mileage) : null;
    const mileageVal = (mileageParsed != null && !isNaN(mileageParsed) && mileageParsed >= 0) ? mileageParsed : null;
    // Phase 2 dual-write: derive new instants from the new wall-clock + the
    // entry's stored timezone (the same TZ the original write used).
    const workDateStr = new Date(entry.work_date).toISOString().substring(0, 10);
    const { start_ts, end_ts } = entryInstants(workDateStr, start_time, end_time, entry.timezone);
    const result = await pool.query(
      `UPDATE time_entries SET start_time = $1, end_time = $2, start_ts = $3, end_ts = $4,
         notes = $5, break_minutes = $6, mileage = $7,
         status = 'pending', approval_note = NULL
       WHERE id = $8 RETURNING *`,
      [start_time, end_time, start_ts, end_ts, notes?.trim() || null, bm, mileageVal, req.params.id]
    );
    logAudit(req.user.company_id, req.user.id, req.user.full_name, 'entry.edited', 'time_entry', req.params.id, null,
      { from: { start_time: entry.start_time, end_time: entry.end_time }, to: { start_time, end_time } });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /time-entries/:id/messages
router.get('/:id/messages', requireAuth, async (req, res) => {
  try {
    const entry = await pool.query('SELECT id FROM time_entries WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
    if (entry.rowCount === 0) return res.status(404).json({ error: 'Entry not found' });
    const result = await pool.query(
      `SELECT m.*, u.full_name as sender_name FROM entry_messages m
       JOIN users u ON m.sender_id = u.id
       WHERE m.time_entry_id = $1 ORDER BY m.created_at ASC`,
      [req.params.id]
    );
    // Mark unread messages as read for this user
    await pool.query(
      `UPDATE entry_messages SET read_at = NOW()
       WHERE time_entry_id = $1 AND sender_id != $2 AND read_at IS NULL`,
      [req.params.id, req.user.id]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /time-entries/:id/messages
router.post('/:id/messages', requireAuth, async (req, res) => {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Message body required' });
  if (body.length > 1000) return res.status(400).json({ error: 'Message must be 1000 characters or fewer' });
  try {
    const entry = await pool.query('SELECT id FROM time_entries WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
    if (entry.rowCount === 0) return res.status(404).json({ error: 'Entry not found' });
    const result = await pool.query(
      `INSERT INTO entry_messages (time_entry_id, company_id, sender_id, body)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, req.user.company_id, req.user.id, body.trim()]
    );
    const msg = { ...result.rows[0], sender_name: req.user.full_name };
    const entryOwner = await pool.query('SELECT user_id FROM time_entries WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
    const ownerId = entryOwner.rows[0]?.user_id;
    const isWorker = req.user.role === 'worker';
    const snippet = body.trim().substring(0, 100);
    if (isWorker) {
      // Worker commented — notify all company admins
      sendPushToCompanyAdmins(req.user.company_id, {
        title: `Comment from ${req.user.full_name}`,
        body: snippet,
        url: '/workforce#approvals',
      });
      const admins = await pool.query(
        `SELECT id FROM users WHERE company_id = $1 AND role IN ('admin','super_admin') AND active = true`,
        [req.user.company_id]
      );
      for (const a of admins.rows) {
        createInboxItem(a.id, req.user.company_id, 'comment', `Comment from ${req.user.full_name}`, snippet, '/workforce#approvals');
      }
    } else if (ownerId && ownerId !== req.user.id) {
      // Admin commented — notify the entry's worker
      sendPushToUser(ownerId, {
        title: `Comment from ${req.user.full_name}`,
        body: snippet,
        url: '/timeclock',
      });
      createInboxItem(ownerId, req.user.company_id, 'comment', `Comment from ${req.user.full_name}`, snippet, '/timeclock');
    }
    res.status(201).json(msg);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET unread message count for current user
router.get('/messages/unread-count', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) FROM entry_messages m
       JOIN time_entries te ON m.time_entry_id = te.id
       WHERE te.company_id = $1 AND m.sender_id != $2 AND m.read_at IS NULL
         AND (te.user_id = $2 OR $3 = 'admin' OR $3 = 'super_admin')`,
      [req.user.company_id, req.user.id, req.user.role]
    );
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// Delete an entry (own entries only)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const existing = await pool.query('SELECT work_date, locked FROM time_entries WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Entry not found' });
    if (existing.rows[0].locked) return res.status(403).json({ error: 'Approved entries cannot be deleted' });
    const locked = await pool.query(
      'SELECT id FROM pay_periods WHERE company_id = $1 AND period_start <= $2 AND period_end >= $2',
      [req.user.company_id, existing.rows[0].work_date]
    );
    if (locked.rowCount > 0) return res.status(403).json({ error: 'This entry is in a locked pay period' });
    const result = await pool.query(
      'DELETE FROM time_entries WHERE id = $1 AND user_id = $2 RETURNING id, work_date',
      [req.params.id, req.user.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Entry not found' });
    logAudit(req.user.company_id, req.user.id, req.user.full_name, 'entry.deleted', 'time_entry', req.params.id, null,
      { work_date: result.rows[0].work_date });
    res.json({ deleted: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

const { hoursWorked, computeOT } = require('../utils/payCalculations');
const { weekRange } = require('../utils/weekBounds');

// GET /time-entries/pay-stubs — worker's pay periods with aggregated hours
router.get('/pay-stubs', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const companyId = req.user.company_id;
  try {
    const [periods, settingsRows, workerRow] = await Promise.all([
      pool.query('SELECT * FROM pay_periods WHERE company_id = $1 ORDER BY period_start DESC', [companyId]),
      pool.query('SELECT key, value FROM settings WHERE company_id = $1', [companyId]),
      pool.query('SELECT overtime_rule, hourly_rate, rate_type, guaranteed_weekly_hours FROM users WHERE id = $1', [userId]),
    ]);
    const s = { overtime_threshold: 8, default_hourly_rate: 0 };
    settingsRows.rows.forEach(r => {
      if (r.key === 'overtime_threshold') s.overtime_threshold = parseFloat(r.value);
      if (r.key === 'default_hourly_rate') s.default_hourly_rate = parseFloat(r.value);
    });
    const workerData = workerRow.rows[0] || {};
    const workerOTRule = workerData.overtime_rule || 'daily';
    const guaranteedWeeklyHours = workerData.guaranteed_weekly_hours ? parseFloat(workerData.guaranteed_weekly_hours) : null;

    const result = [];
    if (periods.rows.length > 0) {
      const minDate = periods.rows[periods.rows.length - 1].period_start;
      const maxDate = periods.rows[0].period_end;
      const allEntries = await pool.query(
        `SELECT te.*, p.name as project_name,
                to_char(te.work_date, 'YYYY-MM-DD') as work_date_str
         FROM time_entries te LEFT JOIN projects p ON te.project_id = p.id
         WHERE te.user_id = $1 AND te.status = 'approved' AND te.work_date >= $2 AND te.work_date <= $3
         ORDER BY te.work_date, te.start_time`,
        [userId, minDate, maxDate]
      );

      for (const period of periods.rows) {
        const ps = period.period_start.toString().substring(0, 10);
        const pe = period.period_end.toString().substring(0, 10);
        const entries = allEntries.rows.filter(e => e.work_date_str >= ps && e.work_date_str <= pe);
        if (entries.length === 0) continue;

        const { regularHours, overtimeHours } = computeOT(entries, workerOTRule, s.overtime_threshold, s.week_start);
        let prevailingHours = 0, totalMileage = 0;
        for (const e of entries) {
          if (e.wage_type === 'prevailing') {
            prevailingHours += hoursWorked(e.start_time, e.end_time) - (e.break_minutes || 0) / 60;
          }
          if (e.mileage) totalMileage += parseFloat(e.mileage);
        }

        const totalHours = regularHours + overtimeHours + prevailingHours;
        // Guarantee shortfall: scale by how many weeks are in this pay period
        let guaranteeShortfall = 0, guaranteeMinHours = 0;
        if (guaranteedWeeklyHours) {
          const ps = new Date(String(period.period_start).substring(0, 10) + 'T00:00:00');
          const pe = new Date(String(period.period_end).substring(0, 10) + 'T00:00:00');
          const days = Math.round((pe - ps) / (1000 * 60 * 60 * 24)) + 1;
          const weeks = Math.max(1, Math.round(days / 7));
          guaranteeMinHours = +(guaranteedWeeklyHours * weeks).toFixed(2);
          guaranteeShortfall = +Math.max(0, guaranteeMinHours - totalHours).toFixed(2);
        }
        result.push({
          id: period.id,
          period_start: period.period_start,
          period_end: period.period_end,
          label: period.label,
          entries,
          summary: {
            regular_hours: +regularHours.toFixed(2),
            overtime_hours: +overtimeHours.toFixed(2),
            prevailing_hours: +prevailingHours.toFixed(2),
            total_mileage: +totalMileage.toFixed(1),
            guarantee_shortfall_hours: guaranteeShortfall,
            guarantee_min_hours: guaranteeMinHours,
            guaranteed_weekly_hours: guaranteedWeeklyHours,
          },
        });
      }
    }
    res.json(result);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /time-entries/sign-off — worker signs off on their entries for a date range
router.post('/sign-off', requireAuth, async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  try {
    const result = await pool.query(
      `UPDATE time_entries SET worker_signed_at = NOW()
       WHERE user_id = $1 AND work_date >= $2 AND work_date <= $3
         AND status = 'pending' AND worker_signed_at IS NULL
       RETURNING id`,
      [req.user.id, from, to]
    );
    // Notify admin that worker signed off
    const admin = await pool.query(
      `SELECT u.id FROM users u WHERE u.company_id = $1 AND u.role = 'admin' AND u.active = true LIMIT 1`,
      [req.user.company_id]
    );
    if (admin.rowCount > 0) {
      const adminId = admin.rows[0].id;
      const signTitle = `${req.user.full_name} signed their timesheet`;
      const signBody = `${result.rowCount} entr${result.rowCount === 1 ? 'y' : 'ies'} ready for review`;
      sendPushToUser(adminId, { title: signTitle, body: signBody, url: '/workforce#approvals' });
      createInboxItem(adminId, req.user.company_id, 'signoff', signTitle, signBody, '/workforce#approvals');
    }
    res.json({ signed: result.rowCount });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /time-entries/copy-last-week
// Copies last week's entries to the same weekday this week (respecting the
// company's week_start setting). Skips days that already have entries.
router.post('/copy-last-week', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const wsRow = await pool.query("SELECT value FROM settings WHERE company_id = $1 AND key = 'week_start'", [companyId]);
    const ws = parseInt(wsRow.rows[0]?.value ?? '1', 10);
    const thisWk = weekRange(ws, 0);
    const lastWk = weekRange(ws, -1);

    const lastWeek = await pool.query(
      `SELECT start_time, end_time, break_minutes, project_id, notes, wage_type, work_date, timezone
       FROM time_entries
       WHERE user_id=$1 AND company_id=$2 AND work_date BETWEEN $3 AND $4
       ORDER BY work_date`,
      [req.user.id, companyId, lastWk.from, lastWk.to]
    );
    if (lastWeek.rowCount === 0) return res.json({ created: 0, skipped: 0, entries: [] });

    const existing = await pool.query(
      `SELECT DISTINCT work_date FROM time_entries
       WHERE user_id=$1 AND company_id=$2 AND work_date BETWEEN $3 AND $4`,
      [req.user.id, companyId, thisWk.from, thisWk.to]
    );
    const existingDates = new Set(existing.rows.map(r => r.work_date?.toString().substring(0, 10)));

    const created = [];
    const toISO = d => d.toLocaleDateString('en-CA');
    for (const e of lastWeek.rows) {
      const lastDate = new Date(e.work_date.toString().substring(0, 10) + 'T00:00:00');
      const thisDate = new Date(lastDate);
      thisDate.setDate(lastDate.getDate() + 7);
      const thisDateStr = toISO(thisDate);
      if (existingDates.has(thisDateStr)) continue;
      // Phase 2 dual-write: copy the source row's timezone for the new
      // wall-clock + derive matching instants.
      const { start_ts, end_ts } = entryInstants(thisDateStr, e.start_time, e.end_time, e.timezone);
      const result = await pool.query(
        `INSERT INTO time_entries (user_id, company_id, work_date, start_time, end_time, start_ts, end_ts, break_minutes, project_id, notes, wage_type, status, timezone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'submitted',$12) RETURNING *`,
        [req.user.id, companyId, thisDateStr, e.start_time, e.end_time, start_ts, end_ts,
         e.break_minutes || 0, e.project_id || null, e.notes || null, e.wage_type || 'regular', e.timezone || null]
      );
      created.push(result.rows[0]);
      existingDates.add(thisDateStr);
    }
    res.json({ created: created.length, skipped: lastWeek.rowCount - created.length, entries: created });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
