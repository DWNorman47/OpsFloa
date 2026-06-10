// Booking module routes — admin config (shift_types, appointment_types,
// bookable_windows) + the availability query + the book-and-assign
// endpoint with round-robin + FOR UPDATE concurrency safety. The
// public booking page (tokenized cancel/reschedule, email integration,
// cron reminders) is a follow-up; this commit ships the core data
// surface and the algorithm.

const router     = require('express').Router();
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');
const pool       = require('../db');
const logger     = require('../logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { userOrIpKey } = require('../middleware/rateLimitKey');
const { logAudit } = require('../auditLog');
const { sendEmail } = require('../email');
const { buildIcsAttachment } = require('../utils/ics');
const { escapeHtml } = require('../utils/htmlEscape');
const {
  APPOINTMENT_STATUSES,
  APPOINTMENT_BLOCKING_STATUSES,
  APPOINTMENT_LOCATION_KINDS,
  APPOINTMENT_AUDIT_ACTOR_KINDS,
  slugify,
} = require('../constants/bookingEnums');
const {
  buildCandidateSlots,
  candidatesForSlot,
  pickRoundRobinWinner,
} = require('../utils/bookingAvailability');

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// ─── Shift types ────────────────────────────────────────────────────────────

router.get('/shift-types', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const r = await pool.query(
      'SELECT * FROM shift_types WHERE company_id = $1 AND active = true ORDER BY name',
      [companyId]
    );
    res.json({ items: r.rows });
  } catch (err) {
    req.log.error({ err }, 'shift types list error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/shift-types', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const name = (req.body.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const color = req.body.color && /^#[0-9a-f]{6}$/i.test(req.body.color) ? req.body.color : null;
  try {
    const r = await pool.query(
      `INSERT INTO shift_types (company_id, name, color, description)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [companyId, name, color, req.body.description || null]
    );
    await logAudit(companyId, req.user.id, req.user.full_name,
      'shift_type.created', 'shift_type', r.rows[0].id, name, null);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'shift type name already exists' });
    req.log.error({ err }, 'shift type create error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/shift-types/:id', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const fields = [];
  const params = [];
  let idx = 1;
  if (req.body.name !== undefined) {
    const v = (req.body.name || '').toString().trim();
    if (!v) return res.status(400).json({ error: 'name cannot be empty' });
    fields.push(`name = $${idx++}`); params.push(v);
  }
  if (req.body.color !== undefined) {
    const c = req.body.color && /^#[0-9a-f]{6}$/i.test(req.body.color) ? req.body.color : null;
    fields.push(`color = $${idx++}`); params.push(c);
  }
  if (req.body.description !== undefined) {
    fields.push(`description = $${idx++}`); params.push(req.body.description || null);
  }
  if (fields.length === 0) return res.status(400).json({ error: 'no fields to update' });
  params.push(req.params.id, companyId);
  try {
    const r = await pool.query(
      `UPDATE shift_types SET ${fields.join(', ')} WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING *`,
      params
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Shift type not found' });
    res.json(r.rows[0]);
  } catch (err) {
    req.log.error({ err }, 'shift type patch error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/shift-types/:id/archive', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const r = await pool.query(
      'UPDATE shift_types SET active = false WHERE id = $1 AND company_id = $2 RETURNING id, name',
      [req.params.id, companyId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Shift type not found' });
    await logAudit(companyId, req.user.id, req.user.full_name,
      'shift_type.archived', 'shift_type', req.params.id, r.rows[0].name, null);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, 'shift type archive error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Appointment types ──────────────────────────────────────────────────────

async function assertAppointmentTypeInCompany(companyId, id) {
  const r = await pool.query(
    'SELECT * FROM appointment_types WHERE id = $1 AND company_id = $2',
    [id, companyId]
  );
  return r.rows[0] || null;
}

router.get('/appointment-types', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const r = await pool.query(
      'SELECT * FROM appointment_types WHERE company_id = $1 ORDER BY name',
      [companyId]
    );
    res.json({ items: r.rows });
  } catch (err) {
    req.log.error({ err }, 'appointment types list error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/appointment-types', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const name = (req.body.name || '').toString().trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const duration = parseInt(req.body.duration_minutes, 10);
  if (!Number.isFinite(duration) || duration < 15) {
    return res.status(400).json({ error: 'duration_minutes must be at least 15' });
  }
  const locationKind = req.body.location_kind || 'phone';
  if (!APPOINTMENT_LOCATION_KINDS.includes(locationKind)) {
    return res.status(400).json({ error: 'invalid location_kind' });
  }
  const slug = req.body.slug ? slugify(req.body.slug) : slugify(name);
  if (!slug) return res.status(400).json({ error: 'slug could not be derived from name' });
  const bufferBefore = parseInt(req.body.buffer_before_min, 10) || 0;
  const bufferAfter  = parseInt(req.body.buffer_after_min, 10) || 0;
  const advanceHrs   = parseInt(req.body.advance_notice_hrs, 10);
  const maxDays      = parseInt(req.body.max_advance_days, 10);
  const interval     = parseInt(req.body.slot_interval_min, 10);
  try {
    const r = await pool.query(
      `INSERT INTO appointment_types
        (company_id, slug, name, description, duration_minutes,
         buffer_before_min, buffer_after_min, advance_notice_hrs,
         max_advance_days, slot_interval_min, is_public, location_kind, location_detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        companyId, slug, name, req.body.description || null, duration,
        bufferBefore < 0 ? 0 : bufferBefore,
        bufferAfter  < 0 ? 0 : bufferAfter,
        Number.isFinite(advanceHrs) ? Math.max(0, advanceHrs) : 24,
        Number.isFinite(maxDays) ? Math.max(1, maxDays) : 60,
        Number.isFinite(interval) ? Math.max(15, interval) : 30,
        req.body.is_public !== false,
        locationKind,
        req.body.location_detail || null,
      ]
    );
    await logAudit(companyId, req.user.id, req.user.full_name,
      'appointment_type.created', 'appointment_type', r.rows[0].id, name, null);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'slug already exists' });
    req.log.error({ err }, 'appointment type create error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/appointment-types/:id', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const at = await assertAppointmentTypeInCompany(companyId, req.params.id);
    if (!at) return res.status(404).json({ error: 'Appointment type not found' });
    const [users, shiftTypes] = await Promise.all([
      pool.query('SELECT user_id FROM appointment_type_users WHERE appointment_type_id = $1', [at.id]),
      pool.query('SELECT shift_type_id FROM appointment_type_shift_types WHERE appointment_type_id = $1', [at.id]),
    ]);
    res.json({
      ...at,
      allowed_user_ids: users.rows.map(r => r.user_id),
      allowed_shift_type_ids: shiftTypes.rows.map(r => r.shift_type_id),
    });
  } catch (err) {
    req.log.error({ err }, 'appointment type detail error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/appointment-types/:id/users', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  if (!Array.isArray(req.body.user_ids)) return res.status(400).json({ error: 'user_ids must be an array' });
  const userIds = req.body.user_ids.map(n => parseInt(n, 10)).filter(Number.isFinite);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const at = await client.query(
      'SELECT id FROM appointment_types WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [req.params.id, companyId]
    );
    if (at.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Appointment type not found' });
    }
    // Verify all users belong to the same company.
    if (userIds.length > 0) {
      const check = await client.query(
        'SELECT COUNT(*)::int AS n FROM users WHERE id = ANY($1) AND company_id = $2',
        [userIds, companyId]
      );
      if (check.rows[0].n !== userIds.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'user_ids contains a user not in your company' });
      }
    }
    await client.query('DELETE FROM appointment_type_users WHERE appointment_type_id = $1', [req.params.id]);
    for (const uid of userIds) {
      await client.query(
        'INSERT INTO appointment_type_users (appointment_type_id, user_id) VALUES ($1, $2)',
        [req.params.id, uid]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, user_ids: userIds });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'appointment type users error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.put('/appointment-types/:id/shift-types', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  if (!Array.isArray(req.body.shift_type_ids)) {
    return res.status(400).json({ error: 'shift_type_ids must be an array' });
  }
  const shiftTypeIds = req.body.shift_type_ids.map(n => parseInt(n, 10)).filter(Number.isFinite);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const at = await client.query(
      'SELECT id FROM appointment_types WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [req.params.id, companyId]
    );
    if (at.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Appointment type not found' });
    }
    if (shiftTypeIds.length > 0) {
      const check = await client.query(
        'SELECT COUNT(*)::int AS n FROM shift_types WHERE id = ANY($1) AND company_id = $2',
        [shiftTypeIds, companyId]
      );
      if (check.rows[0].n !== shiftTypeIds.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'shift_type_ids contains a type not in your company' });
      }
    }
    await client.query('DELETE FROM appointment_type_shift_types WHERE appointment_type_id = $1', [req.params.id]);
    for (const stid of shiftTypeIds) {
      await client.query(
        'INSERT INTO appointment_type_shift_types (appointment_type_id, shift_type_id) VALUES ($1, $2)',
        [req.params.id, stid]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, shift_type_ids: shiftTypeIds });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'appointment type shift types error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ─── Per-user bookable windows + bookable flag ──────────────────────────────

router.get('/users/:id/booking', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const u = await pool.query(
      'SELECT id, full_name, bookable, bookable_role_label, timezone FROM users WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (u.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    const w = await pool.query(
      'SELECT id, weekday, start_time, end_time, active FROM bookable_windows WHERE user_id = $1 ORDER BY weekday, start_time',
      [req.params.id]
    );
    res.json({ user: u.rows[0], windows: w.rows });
  } catch (err) {
    req.log.error({ err }, 'user booking config error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/users/:id/booking', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query(
      'SELECT id FROM users WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [req.params.id, companyId]
    );
    if (u.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    // Update the user-level config first.
    const updates = [];
    const params = [];
    let idx = 1;
    if (req.body.bookable !== undefined) {
      updates.push(`bookable = $${idx++}`); params.push(!!req.body.bookable);
    }
    if (req.body.bookable_role_label !== undefined) {
      updates.push(`bookable_role_label = $${idx++}`);
      params.push(req.body.bookable_role_label ? req.body.bookable_role_label.toString().slice(0, 60) : null);
    }
    if (req.body.timezone !== undefined) {
      updates.push(`timezone = $${idx++}`); params.push(req.body.timezone || null);
    }
    if (updates.length > 0) {
      params.push(req.params.id);
      await client.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, params);
    }
    // Windows: full replacement if `windows` array provided.
    if (Array.isArray(req.body.windows)) {
      // Validate each window first.
      for (let i = 0; i < req.body.windows.length; i++) {
        const w = req.body.windows[i];
        if (!Number.isFinite(w.weekday) || w.weekday < 0 || w.weekday > 6) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `window[${i}]: weekday must be 0-6` });
        }
        if (!w.start_time || !w.end_time) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `window[${i}]: start_time and end_time required` });
        }
        if (w.start_time >= w.end_time) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `window[${i}]: end_time must be after start_time` });
        }
      }
      await client.query('DELETE FROM bookable_windows WHERE user_id = $1', [req.params.id]);
      for (const w of req.body.windows) {
        await client.query(
          `INSERT INTO bookable_windows (user_id, weekday, start_time, end_time, active)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.params.id, w.weekday, w.start_time, w.end_time, w.active !== false]
        );
      }
    }
    await client.query('COMMIT');
    await logAudit(companyId, req.user.id, req.user.full_name,
      'user.booking_config.updated', 'user', req.params.id, null, null);
    // Return the fresh config.
    const fresh = await pool.query(
      'SELECT id, full_name, bookable, bookable_role_label, timezone FROM users WHERE id = $1',
      [req.params.id]
    );
    const freshWindows = await pool.query(
      'SELECT id, weekday, start_time, end_time, active FROM bookable_windows WHERE user_id = $1 ORDER BY weekday, start_time',
      [req.params.id]
    );
    res.json({ user: fresh.rows[0], windows: freshWindows.rows });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'user booking update error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ─── Availability + booking ─────────────────────────────────────────────────

// GET /appointment-types/:id/availability?from=YYYY-MM-DD&days=14
// Returns a list of slot start instants where at least one candidate
// can take the appointment. Caller is responsible for TZ display.
router.get('/appointment-types/:id/availability', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const days = Math.min(60, Math.max(1, parseInt(req.query.days, 10) || 14));
  try {
    const at = await assertAppointmentTypeInCompany(companyId, req.params.id);
    if (!at) return res.status(404).json({ error: 'Appointment type not found' });
    if (!at.active) return res.status(409).json({ error: 'Appointment type is inactive' });

    // Load the allowed user IDs (empty list = anyone bookable in company).
    const allowedUsersRes = await pool.query(
      'SELECT user_id FROM appointment_type_users WHERE appointment_type_id = $1',
      [at.id]
    );
    const allowedUserIds = allowedUsersRes.rows.map(r => r.user_id);
    const allowedShiftTypesRes = await pool.query(
      'SELECT shift_type_id FROM appointment_type_shift_types WHERE appointment_type_id = $1',
      [at.id]
    );
    const allowedShiftTypeIds = allowedShiftTypesRes.rows.map(r => r.shift_type_id);

    // Compute the window we're checking against.
    const now = new Date();
    // Cap candidate slot enumeration to the requested `days` for cheap-and-fast checks.
    const apt = { ...at, max_advance_days: Math.min(at.max_advance_days, days) };
    const slots = buildCandidateSlots({ now, appointmentType: apt });
    if (slots.length === 0) return res.json({ slots: [] });

    // Load the candidate user pool: bookable=true + in allowed list (or all
    // bookable if list is empty).
    const usersQuery = allowedUserIds.length > 0
      ? `SELECT id, full_name, bookable, timezone FROM users WHERE company_id = $1 AND bookable = true AND id = ANY($2) ORDER BY id`
      : `SELECT id, full_name, bookable, timezone FROM users WHERE company_id = $1 AND bookable = true ORDER BY id`;
    const usersRes = await pool.query(
      usersQuery,
      allowedUserIds.length > 0 ? [companyId, allowedUserIds] : [companyId]
    );
    if (usersRes.rowCount === 0) return res.json({ slots: [] });
    const userIds = usersRes.rows.map(u => u.id);

    // Bulk-load windows / shifts / time-off / existing appointments for
    // the entire pool over the slot window.
    const horizonEnd = slots[slots.length - 1];
    const horizonStart = slots[0];
    const horizonStartWithBuffer = new Date(horizonStart.getTime() - (at.buffer_before_min + 60) * 60_000);
    const horizonEndWithBuffer   = new Date(horizonEnd.getTime() + (at.buffer_after_min + 60) * 60_000);

    const [windowsRes, shiftsRes, timeOffRes, apptsRes] = await Promise.all([
      pool.query(
        `SELECT user_id, weekday,
                EXTRACT(HOUR FROM start_time)::int * 60 + EXTRACT(MINUTE FROM start_time)::int AS start_minutes,
                EXTRACT(HOUR FROM end_time)::int   * 60 + EXTRACT(MINUTE FROM end_time)::int   AS end_minutes,
                active
           FROM bookable_windows WHERE user_id = ANY($1)`,
        [userIds]
      ),
      pool.query(
        `SELECT user_id, start_ts AS start, end_ts AS end, shift_type_id
           FROM shifts
          WHERE user_id = ANY($1)
            AND end_ts > $2 AND start_ts < $3`,
        [userIds, horizonStartWithBuffer, horizonEndWithBuffer]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT user_id,
                (start_date::timestamp AT TIME ZONE 'UTC') AS start,
                ((end_date::timestamp AT TIME ZONE 'UTC') + INTERVAL '1 day') AS end
           FROM time_off_requests
          WHERE user_id = ANY($1) AND status = 'approved'
            AND end_date >= $2::date AND start_date <= $3::date`,
        [userIds, horizonStart, horizonEnd]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT assigned_user_id AS user_id, scheduled_at AS start,
                scheduled_at + (duration_minutes || ' minutes')::interval AS end,
                status
           FROM appointments
          WHERE assigned_user_id = ANY($1)
            AND status = ANY($2)
            AND scheduled_at + (duration_minutes || ' minutes')::interval > $3
            AND scheduled_at < $4`,
        [userIds, [...APPOINTMENT_BLOCKING_STATUSES], horizonStartWithBuffer, horizonEndWithBuffer]
      ),
    ]);

    // Index by user.
    const byUser = new Map();
    for (const u of usersRes.rows) {
      byUser.set(u.id, {
        ...u,
        bookable_windows: [],
        shifts: [],
        time_off: [],
        appointments: [],
      });
    }
    for (const w of windowsRes.rows) byUser.get(w.user_id)?.bookable_windows.push(w);
    for (const sh of shiftsRes.rows) {
      byUser.get(sh.user_id)?.shifts.push({
        start: new Date(sh.start), end: new Date(sh.end), shift_type_id: sh.shift_type_id,
      });
    }
    for (const t of timeOffRes.rows) {
      byUser.get(t.user_id)?.time_off.push({ start: new Date(t.start), end: new Date(t.end) });
    }
    for (const a of apptsRes.rows) {
      byUser.get(a.user_id)?.appointments.push({
        start: new Date(a.start), end: new Date(a.end), status: a.status,
      });
    }

    // For each slot, check the candidates pool.
    const users = [...byUser.values()];
    const out = [];
    for (const slotStart of slots) {
      const cands = candidatesForSlot({
        slotStart,
        durationMinutes: at.duration_minutes,
        users,
        appointmentType: at,
        allowedShiftTypeIds,
        untypedBlocks: true,  // Default conservative for v1; setting toggle is a follow-up
      });
      if (cands.length > 0) {
        out.push(slotStart.toISOString());
      }
    }
    res.json({ slots: out });
  } catch (err) {
    req.log.error({ err }, 'availability error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /appointment-types/:id/book — picks the round-robin winner and
// inserts the appointment in a single TX with FOR UPDATE locks on the
// candidate row so concurrent bookings can't double-book.
router.post('/appointment-types/:id/book', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const {
    scheduled_at, client_name, client_email, client_phone, client_notes, project_id,
  } = req.body;
  if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at required' });
  if (!client_name || !client_email) {
    return res.status(400).json({ error: 'client_name and client_email required' });
  }
  const slotStart = new Date(scheduled_at);
  if (Number.isNaN(slotStart.getTime())) {
    return res.status(400).json({ error: 'invalid scheduled_at' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const at = await client.query(
      'SELECT * FROM appointment_types WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (at.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Appointment type not found' });
    }
    if (!at.rows[0].active) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Appointment type inactive' });
    }
    const apt = at.rows[0];
    // Reject past-slot or under-advance-notice bookings. Without this an
    // admin script could create historical appointments to skew
    // round-robin `lastCompletedAt` and pollute the audit trail.
    const earliestAllowed = new Date(Date.now() + apt.advance_notice_hrs * 3_600_000);
    if (slotStart < earliestAllowed) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `scheduled_at must be at least ${apt.advance_notice_hrs}h from now`,
      });
    }

    const allowedUsersRes = await client.query(
      'SELECT user_id FROM appointment_type_users WHERE appointment_type_id = $1',
      [apt.id]
    );
    const allowedShiftTypesRes = await client.query(
      'SELECT shift_type_id FROM appointment_type_shift_types WHERE appointment_type_id = $1',
      [apt.id]
    );
    const allowedUserIds = allowedUsersRes.rows.map(r => r.user_id);
    const allowedShiftTypeIds = allowedShiftTypesRes.rows.map(r => r.shift_type_id);

    // Load + lock the candidate users.
    const usersQuery = allowedUserIds.length > 0
      // ORDER BY id BEFORE FOR UPDATE so concurrent bookings acquire
      // row locks in a deterministic order, preventing deadlock.
      ? `SELECT id, full_name, timezone FROM users WHERE company_id = $1 AND bookable = true AND id = ANY($2) ORDER BY id FOR UPDATE`
      : `SELECT id, full_name, timezone FROM users WHERE company_id = $1 AND bookable = true ORDER BY id FOR UPDATE`;
    const usersRes = await client.query(
      usersQuery,
      allowedUserIds.length > 0 ? [companyId, allowedUserIds] : [companyId]
    );
    if (usersRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'No bookable users available' });
    }
    const userIds = usersRes.rows.map(u => u.id);
    const slotEnd = new Date(slotStart.getTime() + apt.duration_minutes * 60_000);

    // Load the freshest state of the candidates' windows / shifts / time-off / existing appts.
    const [windowsRes, shiftsRes, timeOffRes, apptsRes, lastCompletedRes] = await Promise.all([
      client.query(
        `SELECT user_id, weekday,
                EXTRACT(HOUR FROM start_time)::int * 60 + EXTRACT(MINUTE FROM start_time)::int AS start_minutes,
                EXTRACT(HOUR FROM end_time)::int   * 60 + EXTRACT(MINUTE FROM end_time)::int   AS end_minutes,
                active
           FROM bookable_windows WHERE user_id = ANY($1)`,
        [userIds]
      ),
      client.query(
        `SELECT user_id, start_ts AS start, end_ts AS end, shift_type_id
           FROM shifts
          WHERE user_id = ANY($1)
            AND end_ts > $2 AND start_ts < $3`,
        [userIds, new Date(slotStart.getTime() - (apt.buffer_before_min + 1) * 60_000),
                  new Date(slotEnd.getTime()   + (apt.buffer_after_min  + 1) * 60_000)]
      ).catch(() => ({ rows: [] })),
      client.query(
        `SELECT user_id,
                (start_date::timestamp AT TIME ZONE 'UTC') AS start,
                ((end_date::timestamp AT TIME ZONE 'UTC') + INTERVAL '1 day') AS end
           FROM time_off_requests
          WHERE user_id = ANY($1) AND status = 'approved'
            AND end_date >= $2::date AND start_date <= $3::date`,
        [userIds, slotStart, slotEnd]
      ).catch(() => ({ rows: [] })),
      client.query(
        `SELECT assigned_user_id AS user_id, scheduled_at AS start,
                scheduled_at + (duration_minutes || ' minutes')::interval AS end,
                status
           FROM appointments
          WHERE assigned_user_id = ANY($1)
            AND status = ANY($2)
            AND scheduled_at + (duration_minutes || ' minutes')::interval > $3
            AND scheduled_at < $4`,
        [
          userIds, [...APPOINTMENT_BLOCKING_STATUSES],
          new Date(slotStart.getTime() - (apt.buffer_before_min + 1) * 60_000),
          new Date(slotEnd.getTime()   + (apt.buffer_after_min  + 1) * 60_000),
        ]
      ),
      client.query(
        `SELECT assigned_user_id AS user_id, MAX(completed_at) AS last_completed_at
           FROM appointments WHERE assigned_user_id = ANY($1) AND status = 'completed'
          GROUP BY assigned_user_id`,
        [userIds]
      ),
    ]);

    const byUser = new Map();
    for (const u of usersRes.rows) {
      byUser.set(u.id, {
        ...u, bookable: true,
        bookable_windows: [], shifts: [], time_off: [], appointments: [],
        lastCompletedAt: null,
      });
    }
    for (const w of windowsRes.rows) byUser.get(w.user_id)?.bookable_windows.push(w);
    for (const sh of shiftsRes.rows) byUser.get(sh.user_id)?.shifts.push({
      start: new Date(sh.start), end: new Date(sh.end), shift_type_id: sh.shift_type_id,
    });
    for (const t of timeOffRes.rows) byUser.get(t.user_id)?.time_off.push({
      start: new Date(t.start), end: new Date(t.end),
    });
    for (const a of apptsRes.rows) byUser.get(a.user_id)?.appointments.push({
      start: new Date(a.start), end: new Date(a.end), status: a.status,
    });
    for (const lc of lastCompletedRes.rows) {
      const u = byUser.get(lc.user_id);
      if (u) u.lastCompletedAt = lc.last_completed_at ? new Date(lc.last_completed_at) : null;
    }

    const cands = candidatesForSlot({
      slotStart,
      durationMinutes: apt.duration_minutes,
      users: [...byUser.values()],
      appointmentType: apt,
      allowedShiftTypeIds,
      untypedBlocks: true,
    });
    if (cands.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Slot is no longer available' });
    }
    const winner = pickRoundRobinWinner(cands);

    // Generate the manage token and insert.
    const rawToken = crypto.randomBytes(32).toString('hex');
    const insertRes = await client.query(
      `INSERT INTO appointments
         (company_id, appointment_type_id, assigned_user_id, client_name, client_email,
          client_phone, client_notes, project_id, scheduled_at, duration_minutes,
          status, manage_token_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'booked', $11) RETURNING *`,
      [
        companyId, apt.id, winner.id,
        client_name.toString().trim(),
        client_email.toString().trim(),
        client_phone ? client_phone.toString().trim() : null,
        client_notes || null,
        project_id || null,
        slotStart,
        apt.duration_minutes,
        sha256(rawToken),
      ]
    );
    // Audit row.
    await client.query(
      `INSERT INTO appointment_audit (appointment_id, action, actor_kind, actor_user_id, actor_ip, details)
       VALUES ($1, 'booked', 'admin', $2, $3, $4)`,
      [insertRes.rows[0].id, req.user.id, req.ip, JSON.stringify({ candidates: cands.length, winner: winner.id })]
    );
    await client.query('COMMIT');
    await logAudit(companyId, req.user.id, req.user.full_name,
      'appointment.booked', 'appointment', insertRes.rows[0].id, apt.name,
      { assigned_user_id: winner.id, scheduled_at: slotStart.toISOString() });
    res.status(201).json({
      ...insertRes.rows[0],
      manage_token: rawToken,   // raw, returned only on this response
      assigned_user_name: winner.full_name,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'book appointment error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ─── Appointments management (admin) ────────────────────────────────────────

router.get('/appointments', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const { from, to, status, user_id } = req.query;
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const conditions = ['a.company_id = $1'];
  const params = [companyId];
  if (status) {
    if (!APPOINTMENT_STATUSES.includes(status)) return res.status(400).json({ error: 'invalid status' });
    params.push(status); conditions.push(`a.status = $${params.length}`);
  }
  if (from) { params.push(from); conditions.push(`a.scheduled_at >= $${params.length}`); }
  if (to)   { params.push(to);   conditions.push(`a.scheduled_at < $${params.length}`); }
  if (user_id) { params.push(user_id); conditions.push(`a.assigned_user_id = $${params.length}`); }
  const where = conditions.join(' AND ');
  try {
    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM appointments a WHERE ${where}`, params),
      pool.query(
        `SELECT a.*, t.name AS appointment_type_name, u.full_name AS assigned_user_name
           FROM appointments a
           JOIN appointment_types t ON a.appointment_type_id = t.id
           JOIN users u ON a.assigned_user_id = u.id
          WHERE ${where}
          ORDER BY a.scheduled_at ASC
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
    req.log.error({ err }, 'appointments list error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Reassign an appointment to a different bookable user. Useful when:
//  - the assignee is leaving / unavailable
//  - an admin needs to balance load manually
//  - a user is being removed from the system (appointments
//    .assigned_user_id is ON DELETE RESTRICT, so the user can't be
//    deleted until their appointments are reassigned).
//
// Doesn't recompute availability — that's deliberate. The admin is
// making an override; the new assignee may legitimately be on a shift,
// in another appointment, or outside their window, and the admin
// already knows that.
router.post('/appointments/:id/reassign', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const newUserId = parseInt(req.body.assigned_user_id, 10);
  if (!Number.isFinite(newUserId)) {
    return res.status(400).json({ error: 'assigned_user_id required' });
  }
  try {
    // Make sure the new user is in the caller's company.
    const userCheck = await pool.query(
      'SELECT id, full_name FROM users WHERE id = $1 AND company_id = $2',
      [newUserId, companyId]
    );
    if (userCheck.rowCount === 0) {
      return res.status(400).json({ error: 'assigned_user_id is not in your company' });
    }
    const r = await pool.query(
      `UPDATE appointments SET assigned_user_id = $1
        WHERE id = $2 AND company_id = $3 AND status IN ('booked','confirmed')
        RETURNING id, assigned_user_id`,
      [newUserId, req.params.id, companyId]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'Appointment not found or not reassignable' });
    }
    await pool.query(
      `INSERT INTO appointment_audit (appointment_id, action, actor_kind, actor_user_id, actor_ip, details)
       VALUES ($1, 'confirmed', 'admin', $2, $3, $4)`,
      [req.params.id, req.user.id, req.ip,
       JSON.stringify({ reassigned_to: newUserId, reason: req.body.reason || null })]
    );
    await logAudit(companyId, req.user.id, req.user.full_name,
      'appointment.reassigned', 'appointment', req.params.id, null,
      { to_user_id: newUserId, reason: req.body.reason || null });
    res.json({ success: true, assigned_user_id: newUserId, assigned_user_name: userCheck.rows[0].full_name });
  } catch (err) {
    req.log.error({ err }, 'appointment reassign error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/appointments/:id/cancel', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const r = await pool.query(
      `UPDATE appointments SET status = 'cancelled', cancelled_at = NOW(),
         cancelled_by = 'admin', cancel_reason = $1
       WHERE id = $2 AND company_id = $3 AND status IN ('booked','confirmed')
       RETURNING id`,
      [req.body.reason || null, req.params.id, companyId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Appointment not found or not cancellable' });
    await pool.query(
      `INSERT INTO appointment_audit (appointment_id, action, actor_kind, actor_user_id, actor_ip, details)
       VALUES ($1, 'cancelled', 'admin', $2, $3, $4)`,
      [req.params.id, req.user.id, req.ip, JSON.stringify({ reason: req.body.reason || null })]
    );
    await logAudit(companyId, req.user.id, req.user.full_name,
      'appointment.cancelled', 'appointment', req.params.id, null, null);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, 'appointment cancel error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Worker self-service ──────────────────────────────────────────────────
//
// A bookable user manages their own windows + role label + timezone
// without needing an admin to grant them anything special. The admin
// /users/:id/booking path remains for admin-managed config.

router.get('/me/booking', requireAuth, async (req, res) => {
  try {
    const u = await pool.query(
      'SELECT id, full_name, bookable, bookable_role_label, timezone FROM users WHERE id = $1',
      [req.user.id]
    );
    if (u.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    const w = await pool.query(
      'SELECT id, weekday, start_time, end_time, active FROM bookable_windows WHERE user_id = $1 ORDER BY weekday, start_time',
      [req.user.id]
    );
    res.json({ user: u.rows[0], windows: w.rows });
  } catch (err) {
    req.log.error({ err }, '/me booking read error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/me/booking', requireAuth, async (req, res) => {
  // Self-service is narrower than the admin path: the user CAN'T flip
  // their own `bookable` flag (an admin gates that — opting in to taking
  // bookings is a workflow decision, not a personal one). They can set
  // their role label, timezone, and weekly windows.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updates = [];
    const params = [];
    let idx = 1;
    if (req.body.bookable_role_label !== undefined) {
      updates.push(`bookable_role_label = $${idx++}`);
      params.push(req.body.bookable_role_label ? req.body.bookable_role_label.toString().slice(0, 60) : null);
    }
    if (req.body.timezone !== undefined) {
      updates.push(`timezone = $${idx++}`); params.push(req.body.timezone || null);
    }
    if (updates.length > 0) {
      params.push(req.user.id);
      await client.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, params);
    }
    if (Array.isArray(req.body.windows)) {
      for (let i = 0; i < req.body.windows.length; i++) {
        const w = req.body.windows[i];
        if (!Number.isFinite(w.weekday) || w.weekday < 0 || w.weekday > 6) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `window[${i}]: weekday must be 0-6` });
        }
        if (!w.start_time || !w.end_time) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `window[${i}]: start_time and end_time required` });
        }
        if (w.start_time >= w.end_time) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `window[${i}]: end_time must be after start_time` });
        }
      }
      await client.query('DELETE FROM bookable_windows WHERE user_id = $1', [req.user.id]);
      for (const w of req.body.windows) {
        await client.query(
          `INSERT INTO bookable_windows (user_id, weekday, start_time, end_time, active)
           VALUES ($1, $2, $3, $4, $5)`,
          [req.user.id, w.weekday, w.start_time, w.end_time, w.active !== false]
        );
      }
    }
    await client.query('COMMIT');
    await logAudit(req.user.company_id, req.user.id, req.user.full_name,
      'user.booking_config.self_updated', 'user', req.user.id, null, null);
    const fresh = await pool.query(
      'SELECT id, full_name, bookable, bookable_role_label, timezone FROM users WHERE id = $1',
      [req.user.id]
    );
    const freshWindows = await pool.query(
      'SELECT id, weekday, start_time, end_time, active FROM bookable_windows WHERE user_id = $1 ORDER BY weekday, start_time',
      [req.user.id]
    );
    res.json({ user: fresh.rows[0], windows: freshWindows.rows });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, '/me booking update error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ─── Public booking surface ─────────────────────────────────────────────────
//
// All no-auth, slug-keyed. Mirrors the admin endpoints but resolves
// the company + appointment_type via /companies.slug + appointment_types.slug
// rather than relying on req.user.company_id.
//
// Rate limited per IP because anyone with the slug can hit these endpoints
// without auth. The book endpoint is tighter than the read endpoints since
// each successful POST writes to the DB.

const publicReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: userOrIpKey,
  message: { error: 'Too many requests. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const publicBookLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 10,                    // 10 bookings/hour/IP is generous for legit traffic
  keyGenerator: userOrIpKey,
  message: { error: 'Too many booking attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const publicRouter = require('express').Router();
publicRouter.use(publicReadLimiter);

async function resolvePublicAppointmentType(companySlug, typeSlug) {
  const r = await pool.query(
    `SELECT at.*, c.name AS company_name, c.id AS resolved_company_id, c.slug AS company_slug
       FROM appointment_types at
       JOIN companies c ON at.company_id = c.id
      WHERE c.slug = $1 AND at.slug = $2 AND at.active = true AND at.is_public = true`,
    [companySlug, typeSlug]
  );
  return r.rows[0] || null;
}

// Manage routes registered FIRST because `/manage/:token` would otherwise
// be ambiguously matched by `/:companySlug/:typeSlug` (manage = company,
// :token = type). Express picks the first registered route.

publicRouter.get('/manage/:token', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT a.id, a.scheduled_at, a.duration_minutes, a.status,
              a.client_name, a.client_email,
              t.name AS appointment_type_name, t.location_kind, t.location_detail,
              u.full_name AS assigned_user_name,
              c.name AS company_name
         FROM appointments a
         JOIN appointment_types t ON a.appointment_type_id = t.id
         JOIN users u ON a.assigned_user_id = u.id
         JOIN companies c ON a.company_id = c.id
        WHERE a.manage_token_hash = $1`,
      [sha256(req.params.token)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Appointment not found' });
    res.json(r.rows[0]);
  } catch (err) {
    logger.error({ err }, 'public manage view error');
    res.status(500).json({ error: 'Server error' });
  }
});

publicRouter.post('/manage/:token/cancel', async (req, res) => {
  try {
    const tokenHash = sha256(req.params.token);
    const r = await pool.query(
      `UPDATE appointments SET status = 'cancelled', cancelled_at = NOW(),
         cancelled_by = 'client', cancel_reason = $1
       WHERE manage_token_hash = $2 AND status IN ('booked','confirmed')
       RETURNING id`,
      [req.body.reason || null, tokenHash]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Appointment not found or not cancellable' });
    await pool.query(
      `INSERT INTO appointment_audit (appointment_id, action, actor_kind, actor_ip, details)
       VALUES ($1, 'cancelled', 'client', $2, $3)`,
      [r.rows[0].id, req.ip, JSON.stringify({ reason: req.body.reason || null })]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'public cancel error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /book/:companySlug — list public appointment types for the company
publicRouter.get('/:companySlug', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT at.id, at.slug, at.name, at.description, at.duration_minutes,
              at.location_kind, at.location_detail,
              c.name AS company_name, c.slug AS company_slug
         FROM appointment_types at
         JOIN companies c ON at.company_id = c.id
        WHERE c.slug = $1 AND at.active = true AND at.is_public = true
        ORDER BY at.name`,
      [req.params.companySlug]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'No public appointment types found for this company' });
    }
    res.json({
      company_name: r.rows[0].company_name,
      company_slug: r.rows[0].company_slug,
      types: r.rows.map(row => {
        const { company_name, company_slug, ...rest } = row;
        return rest;
      }),
    });
  } catch (err) {
    logger.error({ err }, 'public booking types list error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /book/:companySlug/:typeSlug — type detail
publicRouter.get('/:companySlug/:typeSlug', async (req, res) => {
  try {
    const at = await resolvePublicAppointmentType(req.params.companySlug, req.params.typeSlug);
    if (!at) return res.status(404).json({ error: 'Not found' });
    res.json({
      slug: at.slug, name: at.name, description: at.description,
      duration_minutes: at.duration_minutes,
      location_kind: at.location_kind, location_detail: at.location_detail,
      advance_notice_hrs: at.advance_notice_hrs,
      max_advance_days: at.max_advance_days,
      slot_interval_min: at.slot_interval_min,
      company_name: at.company_name,
    });
  } catch (err) {
    logger.error({ err }, 'public type detail error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /book/:companySlug/:typeSlug/availability?days=14
publicRouter.get('/:companySlug/:typeSlug/availability', async (req, res) => {
  const days = Math.min(60, Math.max(1, parseInt(req.query.days, 10) || 14));
  try {
    const at = await resolvePublicAppointmentType(req.params.companySlug, req.params.typeSlug);
    if (!at) return res.status(404).json({ error: 'Not found' });
    const companyId = at.resolved_company_id;
    // Same logic as the admin availability endpoint, just sourced via slug.
    const allowedUsersRes = await pool.query(
      'SELECT user_id FROM appointment_type_users WHERE appointment_type_id = $1',
      [at.id]
    );
    const allowedUserIds = allowedUsersRes.rows.map(r => r.user_id);
    const allowedShiftTypesRes = await pool.query(
      'SELECT shift_type_id FROM appointment_type_shift_types WHERE appointment_type_id = $1',
      [at.id]
    );
    const allowedShiftTypeIds = allowedShiftTypesRes.rows.map(r => r.shift_type_id);

    const now = new Date();
    const apt = { ...at, max_advance_days: Math.min(at.max_advance_days, days) };
    const slots = buildCandidateSlots({ now, appointmentType: apt });
    if (slots.length === 0) return res.json({ slots: [] });

    const usersQuery = allowedUserIds.length > 0
      ? `SELECT id, full_name, timezone FROM users WHERE company_id = $1 AND bookable = true AND id = ANY($2) ORDER BY id`
      : `SELECT id, full_name, timezone FROM users WHERE company_id = $1 AND bookable = true ORDER BY id`;
    const usersRes = await pool.query(
      usersQuery,
      allowedUserIds.length > 0 ? [companyId, allowedUserIds] : [companyId]
    );
    if (usersRes.rowCount === 0) return res.json({ slots: [] });
    const userIds = usersRes.rows.map(u => u.id);

    const horizonStart = slots[0];
    const horizonEnd = slots[slots.length - 1];
    const horizonStartBuf = new Date(horizonStart.getTime() - (at.buffer_before_min + 60) * 60_000);
    const horizonEndBuf   = new Date(horizonEnd.getTime()   + (at.buffer_after_min  + 60) * 60_000);

    const [windowsRes, shiftsRes, timeOffRes, apptsRes] = await Promise.all([
      pool.query(
        `SELECT user_id, weekday,
                EXTRACT(HOUR FROM start_time)::int * 60 + EXTRACT(MINUTE FROM start_time)::int AS start_minutes,
                EXTRACT(HOUR FROM end_time)::int   * 60 + EXTRACT(MINUTE FROM end_time)::int   AS end_minutes,
                active
           FROM bookable_windows WHERE user_id = ANY($1)`,
        [userIds]
      ),
      pool.query(
        `SELECT user_id, start_ts AS start, end_ts AS end, shift_type_id
           FROM shifts WHERE user_id = ANY($1) AND end_ts > $2 AND start_ts < $3`,
        [userIds, horizonStartBuf, horizonEndBuf]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT user_id,
                (start_date::timestamp AT TIME ZONE 'UTC') AS start,
                ((end_date::timestamp AT TIME ZONE 'UTC') + INTERVAL '1 day') AS end
           FROM time_off_requests
          WHERE user_id = ANY($1) AND status = 'approved'
            AND end_date >= $2::date AND start_date <= $3::date`,
        [userIds, horizonStart, horizonEnd]
      ).catch(() => ({ rows: [] })),
      pool.query(
        `SELECT assigned_user_id AS user_id, scheduled_at AS start,
                scheduled_at + (duration_minutes || ' minutes')::interval AS end,
                status
           FROM appointments
          WHERE assigned_user_id = ANY($1) AND status = ANY($2)
            AND scheduled_at + (duration_minutes || ' minutes')::interval > $3
            AND scheduled_at < $4`,
        [userIds, [...APPOINTMENT_BLOCKING_STATUSES], horizonStartBuf, horizonEndBuf]
      ),
    ]);

    const byUser = new Map();
    for (const u of usersRes.rows) {
      byUser.set(u.id, { ...u, bookable: true, bookable_windows: [], shifts: [], time_off: [], appointments: [] });
    }
    for (const w of windowsRes.rows) byUser.get(w.user_id)?.bookable_windows.push(w);
    for (const sh of shiftsRes.rows) byUser.get(sh.user_id)?.shifts.push({
      start: new Date(sh.start), end: new Date(sh.end), shift_type_id: sh.shift_type_id,
    });
    for (const t of timeOffRes.rows) byUser.get(t.user_id)?.time_off.push({
      start: new Date(t.start), end: new Date(t.end),
    });
    for (const a of apptsRes.rows) byUser.get(a.user_id)?.appointments.push({
      start: new Date(a.start), end: new Date(a.end), status: a.status,
    });

    const users = [...byUser.values()];
    const out = [];
    for (const slotStart of slots) {
      const cands = candidatesForSlot({
        slotStart,
        durationMinutes: at.duration_minutes,
        users,
        appointmentType: at,
        allowedShiftTypeIds,
        untypedBlocks: true,
      });
      if (cands.length > 0) out.push(slotStart.toISOString());
    }
    res.json({ slots: out });
  } catch (err) {
    logger.error({ err }, 'public availability error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /book/:companySlug/:typeSlug — book an appointment publicly.
// Same atomic round-robin assignment as the admin endpoint. Tighter
// rate limit since each successful POST writes to the DB.
publicRouter.post('/:companySlug/:typeSlug', publicBookLimiter, async (req, res) => {
  const { scheduled_at, client_name, client_email, client_phone, client_notes } = req.body;
  if (!scheduled_at) return res.status(400).json({ error: 'scheduled_at required' });
  if (!client_name || !client_email) {
    return res.status(400).json({ error: 'client_name and client_email required' });
  }
  const slotStart = new Date(scheduled_at);
  if (Number.isNaN(slotStart.getTime())) {
    return res.status(400).json({ error: 'invalid scheduled_at' });
  }
  const at = await resolvePublicAppointmentType(req.params.companySlug, req.params.typeSlug);
  if (!at) return res.status(404).json({ error: 'Not found' });
  const companyId = at.resolved_company_id;
  // Past-slot / under-advance-notice rejection. Same rule as the admin
  // path; defends against scripted public POSTs creating historical
  // appointments.
  const earliestAllowed = new Date(Date.now() + at.advance_notice_hrs * 3_600_000);
  if (slotStart < earliestAllowed) {
    return res.status(400).json({
      error: `scheduled_at must be at least ${at.advance_notice_hrs}h from now`,
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const allowedUsersRes = await client.query(
      'SELECT user_id FROM appointment_type_users WHERE appointment_type_id = $1',
      [at.id]
    );
    const allowedShiftTypesRes = await client.query(
      'SELECT shift_type_id FROM appointment_type_shift_types WHERE appointment_type_id = $1',
      [at.id]
    );
    const allowedUserIds = allowedUsersRes.rows.map(r => r.user_id);
    const allowedShiftTypeIds = allowedShiftTypesRes.rows.map(r => r.shift_type_id);

    const usersQuery = allowedUserIds.length > 0
      ? `SELECT id, full_name, timezone FROM users WHERE company_id = $1 AND bookable = true AND id = ANY($2) ORDER BY id FOR UPDATE`
      : `SELECT id, full_name, timezone FROM users WHERE company_id = $1 AND bookable = true ORDER BY id FOR UPDATE`;
    const usersRes = await client.query(
      usersQuery,
      allowedUserIds.length > 0 ? [companyId, allowedUserIds] : [companyId]
    );
    if (usersRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'No bookable users available' });
    }
    const userIds = usersRes.rows.map(u => u.id);
    const slotEnd = new Date(slotStart.getTime() + at.duration_minutes * 60_000);

    const [windowsRes, shiftsRes, timeOffRes, apptsRes, lastCompletedRes] = await Promise.all([
      client.query(
        `SELECT user_id, weekday,
                EXTRACT(HOUR FROM start_time)::int * 60 + EXTRACT(MINUTE FROM start_time)::int AS start_minutes,
                EXTRACT(HOUR FROM end_time)::int   * 60 + EXTRACT(MINUTE FROM end_time)::int   AS end_minutes,
                active
           FROM bookable_windows WHERE user_id = ANY($1)`,
        [userIds]
      ),
      client.query(
        `SELECT user_id, start_ts AS start, end_ts AS end, shift_type_id
           FROM shifts WHERE user_id = ANY($1) AND end_ts > $2 AND start_ts < $3`,
        [userIds, new Date(slotStart.getTime() - (at.buffer_before_min + 1) * 60_000),
                  new Date(slotEnd.getTime()   + (at.buffer_after_min  + 1) * 60_000)]
      ).catch(() => ({ rows: [] })),
      client.query(
        `SELECT user_id,
                (start_date::timestamp AT TIME ZONE 'UTC') AS start,
                ((end_date::timestamp AT TIME ZONE 'UTC') + INTERVAL '1 day') AS end
           FROM time_off_requests
          WHERE user_id = ANY($1) AND status = 'approved'
            AND end_date >= $2::date AND start_date <= $3::date`,
        [userIds, slotStart, slotEnd]
      ).catch(() => ({ rows: [] })),
      client.query(
        `SELECT assigned_user_id AS user_id, scheduled_at AS start,
                scheduled_at + (duration_minutes || ' minutes')::interval AS end,
                status
           FROM appointments
          WHERE assigned_user_id = ANY($1) AND status = ANY($2)
            AND scheduled_at + (duration_minutes || ' minutes')::interval > $3
            AND scheduled_at < $4`,
        [userIds, [...APPOINTMENT_BLOCKING_STATUSES],
         new Date(slotStart.getTime() - (at.buffer_before_min + 1) * 60_000),
         new Date(slotEnd.getTime()   + (at.buffer_after_min  + 1) * 60_000)]
      ),
      client.query(
        `SELECT assigned_user_id AS user_id, MAX(completed_at) AS last_completed_at
           FROM appointments WHERE assigned_user_id = ANY($1) AND status = 'completed'
          GROUP BY assigned_user_id`,
        [userIds]
      ),
    ]);

    const byUser = new Map();
    for (const u of usersRes.rows) {
      byUser.set(u.id, {
        ...u, bookable: true,
        bookable_windows: [], shifts: [], time_off: [], appointments: [],
        lastCompletedAt: null,
      });
    }
    for (const w of windowsRes.rows) byUser.get(w.user_id)?.bookable_windows.push(w);
    for (const sh of shiftsRes.rows) byUser.get(sh.user_id)?.shifts.push({
      start: new Date(sh.start), end: new Date(sh.end), shift_type_id: sh.shift_type_id,
    });
    for (const t of timeOffRes.rows) byUser.get(t.user_id)?.time_off.push({
      start: new Date(t.start), end: new Date(t.end),
    });
    for (const a of apptsRes.rows) byUser.get(a.user_id)?.appointments.push({
      start: new Date(a.start), end: new Date(a.end), status: a.status,
    });
    for (const lc of lastCompletedRes.rows) {
      const u = byUser.get(lc.user_id);
      if (u) u.lastCompletedAt = lc.last_completed_at ? new Date(lc.last_completed_at) : null;
    }

    const cands = candidatesForSlot({
      slotStart,
      durationMinutes: at.duration_minutes,
      users: [...byUser.values()],
      appointmentType: at,
      allowedShiftTypeIds,
      untypedBlocks: true,
    });
    if (cands.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Slot is no longer available' });
    }
    const winner = pickRoundRobinWinner(cands);

    const rawToken = crypto.randomBytes(32).toString('hex');
    const insertRes = await client.query(
      `INSERT INTO appointments
         (company_id, appointment_type_id, assigned_user_id, client_name, client_email,
          client_phone, client_notes, scheduled_at, duration_minutes, status, manage_token_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'booked', $10) RETURNING id`,
      [
        companyId, at.id, winner.id,
        client_name.toString().trim(), client_email.toString().trim(),
        client_phone ? client_phone.toString().trim() : null,
        client_notes || null,
        slotStart, at.duration_minutes,
        sha256(rawToken),
      ]
    );
    await client.query(
      `INSERT INTO appointment_audit (appointment_id, action, actor_kind, actor_ip, details)
       VALUES ($1, 'booked', 'client', $2, $3)`,
      [insertRes.rows[0].id, req.ip,
       JSON.stringify({ candidates: cands.length, winner: winner.id, user_agent: req.headers['user-agent'] || null })]
    );
    await client.query('COMMIT');

    // Fire-and-forget confirmation emails. Errors don't fail the booking
    // — the client already got the manage_token in the response.
    sendBookingEmails({
      apt: at, appointmentId: insertRes.rows[0].id,
      slotStart, durationMinutes: at.duration_minutes,
      clientName: client_name, clientEmail: client_email,
      clientPhone: client_phone, clientNotes: client_notes,
      assignee: winner, manageToken: rawToken, companyId,
    }).catch(err => logger.error({ err }, 'booking email send failed'));

    res.status(201).json({
      appointment_id: insertRes.rows[0].id,
      manage_token: rawToken,
      assigned_user_name: winner.full_name,
      scheduled_at: slotStart.toISOString(),
      duration_minutes: at.duration_minutes,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err }, 'public book error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Send the client confirmation + the assignee notification immediately
// after a successful public book.
async function sendBookingEmails({
  apt, appointmentId, slotStart, durationMinutes,
  clientName, clientEmail, clientPhone, clientNotes,
  assignee, manageToken, companyId,
}) {
  // Look up the company name + assignee email; the public book path
  // doesn't have them on the in-scope objects.
  const companyRow = await pool.query('SELECT name, slug FROM companies WHERE id = $1', [companyId]);
  const assigneeRow = await pool.query('SELECT email FROM users WHERE id = $1', [assignee.id]);
  const companyName = companyRow.rows[0]?.name || 'the contractor';
  const assigneeEmail = assigneeRow.rows[0]?.email || null;
  const when = new Date(slotStart).toLocaleString();
  const manageUrl = `${process.env.PUBLIC_APP_URL || 'https://opsfloa.com'}/book/manage/${manageToken}`;
  const slotEndDate = new Date(new Date(slotStart).getTime() + durationMinutes * 60_000);

  // Build the .ics calendar attachment ONCE; same event goes in both
  // emails so the client and the assignee see the same UID/start/end.
  const icsAttachment = buildIcsAttachment({
    uid: `appt-${appointmentId}@opsfloa.com`,
    start: slotStart,
    end: slotEndDate,
    summary: `${apt.name} with ${companyName}`,
    description: [
      apt.description || '',
      clientNotes ? `Client notes: ${clientNotes}` : '',
      `Manage: ${manageUrl}`,
    ].filter(Boolean).join('\n\n'),
    location: apt.location_detail || apt.location_kind,
    organizer: assigneeEmail ? { name: assignee.full_name, email: assigneeEmail } : null,
    attendee: { name: clientName, email: clientEmail },
  });

  // Client confirmation. Every interpolated value runs through
  // escapeHtml so a `<script>` in client_name from the public POST can't
  // ride along into the rendered email.
  await sendEmail(
    clientEmail,
    `Booking confirmed: ${apt.name} with ${companyName}`,
    `<p>Hi ${escapeHtml(clientName)},</p>
     <p>Your <strong>${escapeHtml(apt.name)}</strong> with ${escapeHtml(assignee.full_name)} from ${escapeHtml(companyName)} is confirmed for <strong>${escapeHtml(when)}</strong> (${durationMinutes} minutes).</p>
     ${apt.location_detail ? `<p><strong>Location:</strong> ${escapeHtml(apt.location_detail)}</p>` : ''}
     <p>A calendar invite (.ics) is attached — open it to add the appointment to your calendar.</p>
     <p><strong>Manage your booking:</strong> <a href="${escapeHtml(manageUrl)}">${escapeHtml(manageUrl)}</a></p>
     <p>Save this link — it's how you'll view or cancel the appointment.</p>`,
    [icsAttachment]
  ).catch(() => {});

  // Assignee notification
  if (assigneeEmail) {
    await sendEmail(
      assigneeEmail,
      `New booking: ${apt.name} with ${clientName}`,
      `<p>Hi ${escapeHtml(assignee.full_name)},</p>
       <p>You've been assigned a <strong>${escapeHtml(apt.name)}</strong> with <strong>${escapeHtml(clientName)}</strong> on <strong>${escapeHtml(when)}</strong> (${durationMinutes} minutes).</p>
       <p>
         <strong>Client email:</strong> ${escapeHtml(clientEmail)}<br/>
         ${clientPhone ? `<strong>Client phone:</strong> ${escapeHtml(clientPhone)}<br/>` : ''}
         ${clientNotes ? `<strong>Notes:</strong> ${escapeHtml(clientNotes)}<br/>` : ''}
       </p>
       ${apt.location_detail ? `<p><strong>Location:</strong> ${escapeHtml(apt.location_detail)}</p>` : ''}
       <p>Calendar invite (.ics) attached.</p>`,
      [icsAttachment]
    ).catch(() => {});
  }
}

router.publicRouter = publicRouter;
module.exports = router;
