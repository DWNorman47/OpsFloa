/**
 * Background cron jobs — started once from index.js via startCron().
 * Uses setInterval; runs in-process alongside the Express server.
 */
const pool = require('./db');
const { sendPushToUser, sendPushToCompanyAdmins } = require('./push');
const { createInboxItemBatch } = require('./routes/inbox');

// A worker who has been clocked in this many hours without clocking out
// is almost certainly forgotten — phone died, app uninstalled, drove home
// without remembering. Alert admins so they can edit the entry.
// Threshold is intentionally generous so a long workday doesn't trigger.
const STALE_CLOCK_HOURS = 16;

function getHourInTimezone(timezone) {
  try {
    const tz = timezone || 'UTC';
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).formatToParts(new Date());
    return parseInt(parts.find(p => p.type === 'hour').value);
  } catch {
    return new Date().getUTCHours();
  }
}

function getDayOfWeekInTimezone(timezone) {
  try {
    const tz = timezone || 'UTC';
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).formatToParts(new Date());
    const day = parts.find(p => p.type === 'weekday').value;
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(day);
  } catch {
    return new Date().getDay();
  }
}

// Send push notifications to workers with shifts tomorrow.
// Runs once per hour; the reminder_sent flag prevents duplicate sends.
// Each company can configure their preferred send hour via shift_reminder_hour setting.
async function sendShiftReminders() {
  try {
    // Find distinct companies that have unremminded shifts tomorrow
    const companiesResult = await pool.query(
      `SELECT DISTINCT company_id FROM shifts
       WHERE shift_date = CURRENT_DATE + 1 AND reminder_sent = false AND cant_make_it = false`
    );

    for (const { company_id } of companiesResult.rows) {
      // Get this company's timezone and shift_reminder_hour
      const settingsResult = await pool.query(
        `SELECT key, value FROM settings WHERE company_id = $1 AND key IN ('company_timezone', 'shift_reminder_hour')`,
        [company_id]
      );
      const settingsMap = Object.fromEntries(settingsResult.rows.map(r => [r.key, r.value]));
      const timezone = settingsMap.company_timezone || 'UTC';
      const reminderHour = parseInt(settingsMap.shift_reminder_hour ?? '7');

      // Only send if the current hour in the company's timezone matches
      const nowHour = getHourInTimezone(timezone);
      if (nowHour !== reminderHour) continue;

      const result = await pool.query(
        `SELECT s.id, s.user_id, s.start_time, s.end_time, p.name as project_name
         FROM shifts s
         LEFT JOIN projects p ON s.project_id = p.id
         WHERE s.shift_date = CURRENT_DATE + 1
           AND s.company_id = $1
           AND s.reminder_sent = false
           AND s.cant_make_it = false`,
        [company_id]
      );

      if (result.rows.length === 0) continue;

      for (const shift of result.rows) {
        const timeStr = shift.start_time?.substring(0, 5) || '';
        const body = `${timeStr}${shift.project_name ? ' · ' + shift.project_name : ''}`;
        await sendPushToUser(shift.user_id, {
          title: 'Shift reminder — tomorrow',
          body,
          url: '/timeclock#schedule',
        });
      }

      const ids = result.rows.map(s => s.id);
      await pool.query(`UPDATE shifts SET reminder_sent = true WHERE id = ANY($1)`, [ids]);
      console.log(`[cron] Sent shift reminders for ${ids.length} shift(s) for company ${company_id}`);
    }
  } catch (err) {
    console.error('[cron] sendShiftReminders error:', err);
  }
}

// Track which companies have already received a sign-off reminder this Friday
// (in-memory, resets on restart — worst case workers get a second reminder)
const signoffReminderSentDates = new Map(); // company_id -> 'YYYY-MM-DD'

// Send push notifications on Fridays to workers with unsigned entries from this week.
async function sendSignoffReminders() {
  try {
    // Get distinct companies that have pending unsigned entries from the past 7 days
    const companiesResult = await pool.query(
      `SELECT DISTINCT company_id FROM time_entries
       WHERE worker_signed_at IS NULL AND status = 'pending'
         AND work_date >= CURRENT_DATE - 7`
    );

    for (const { company_id } of companiesResult.rows) {
      // Get company timezone and notification window
      const settingsResult = await pool.query(
        `SELECT key, value FROM settings WHERE company_id = $1 AND key IN ('company_timezone', 'notification_start_hour', 'notification_end_hour')`,
        [company_id]
      );
      const settingsMap = Object.fromEntries(settingsResult.rows.map(r => [r.key, r.value]));
      const timezone = settingsMap.company_timezone || 'UTC';
      const startHour = parseInt(settingsMap.notification_start_hour ?? '6');
      const endHour = parseInt(settingsMap.notification_end_hour ?? '20');

      // Only send on Fridays during work hours
      const dayOfWeek = getDayOfWeekInTimezone(timezone);
      if (dayOfWeek !== 5) continue;

      const nowHour = getHourInTimezone(timezone);
      if (nowHour < startHour || nowHour >= endHour) continue;

      // Only send once per Friday per company
      const todayStr = new Date().toISOString().substring(0, 10);
      if (signoffReminderSentDates.get(company_id) === todayStr) continue;
      signoffReminderSentDates.set(company_id, todayStr);

      // Find workers with unsigned pending entries this week
      const workersResult = await pool.query(
        `SELECT DISTINCT user_id FROM time_entries
         WHERE company_id = $1
           AND worker_signed_at IS NULL
           AND status = 'pending'
           AND work_date >= CURRENT_DATE - 7`,
        [company_id]
      );

      for (const { user_id } of workersResult.rows) {
        await sendPushToUser(user_id, {
          title: 'Sign off your timesheet',
          body: 'You have unsigned time entries this week.',
          url: '/timeclock',
        });
      }

      if (workersResult.rows.length > 0) {
        console.log(`[cron] Sent sign-off reminders to ${workersResult.rows.length} worker(s) for company ${company_id}`);
      }
    }
  } catch (err) {
    console.error('[cron] sendSignoffReminders error:', err);
  }
}

// Flip expired-trial companies from 'trial' to 'trial_expired' in the DB.
// The /me endpoint already resolves this at read time via
// effectiveSubscriptionStatus, so worker clients see the change immediately.
// This job just keeps the canonical DB state tidy so admin filters and
// SuperAdmin dashboards don't keep listing expired trials as active.
async function expireOldTrials() {
  try {
    const result = await pool.query(
      `UPDATE companies
          SET subscription_status = 'trial_expired'
        WHERE subscription_status = 'trial'
          AND trial_ends_at IS NOT NULL
          AND trial_ends_at < NOW()
        RETURNING id, name`
    );
    if (result.rowCount > 0) {
      console.log(`[cron] expireOldTrials: flipped ${result.rowCount} companies to trial_expired`);
    }
  } catch (err) {
    console.error('[cron] expireOldTrials error:', err);
  }
}

// Find any active_clock rows older than STALE_CLOCK_HOURS that haven't
// been alerted on yet, and notify the company's admins. Doesn't auto-finalize
// the entry — admins must decide the actual end time via the existing
// /admin/active-clock/:user_id PATCH or the worker has to clock out.
// stale_alert_sent_at is set per-row so a stuck row alerts at most once.
async function sweepStaleActiveClock() {
  try {
    const stale = await pool.query(
      `SELECT ac.user_id, ac.company_id, ac.clock_in_time,
              u.full_name AS worker_name, p.name AS project_name,
              EXTRACT(EPOCH FROM (NOW() - ac.clock_in_time)) / 3600 AS hours_clocked
         FROM active_clock ac
         JOIN users u ON u.id = ac.user_id
         LEFT JOIN projects p ON p.id = ac.project_id
        WHERE ac.clock_in_time < NOW() - ($1 || ' hours')::INTERVAL
          AND ac.stale_alert_sent_at IS NULL`,
      [STALE_CLOCK_HOURS]
    );

    if (stale.rowCount === 0) return;

    for (const row of stale.rows) {
      const hours = Math.round(row.hours_clocked);
      const title = `Worker still clocked in: ${row.worker_name}`;
      const body = `${row.worker_name} has been clocked in for ${hours}h${row.project_name ? ` on ${row.project_name}` : ''}. They may have forgotten to clock out — review on the Live tab.`;

      // Push to all admins; don't await per-admin so a slow push doesn't
      // block the rest of the sweep.
      sendPushToCompanyAdmins(row.company_id, { title, body, url: '/workforce#live' })
        .catch(err => console.error('[cron] sweepStaleActiveClock push:', err));

      // Inbox item too, so the alert is visible after the push notification expires.
      const adminRows = await pool.query(
        `SELECT id FROM users WHERE company_id = $1 AND role IN ('admin','super_admin') AND active = true`,
        [row.company_id]
      );
      if (adminRows.rowCount > 0) {
        createInboxItemBatch(
          adminRows.rows.map(a => a.id),
          row.company_id,
          'stale_active_clock',
          title,
          body,
          '/workforce#live'
        );
      }

      await pool.query(
        `UPDATE active_clock SET stale_alert_sent_at = NOW() WHERE user_id = $1`,
        [row.user_id]
      );
    }

    console.log(`[cron] sweepStaleActiveClock: alerted on ${stale.rowCount} stale active_clock row(s)`);
  } catch (err) {
    console.error('[cron] sweepStaleActiveClock error:', err);
  }
}

// ─── Booking reminders ──────────────────────────────────────────────────────
//
// Run every 15 minutes. Sends one client reminder 24h before the
// appointment and one assignee reminder 1h before. Dedup via a flag
// column on appointments (added inline here to avoid a separate migration
// just for this — see also reminder_sent_client / reminder_sent_assignee
// in 0114 if/when that ships). For now, dedup by checking the audit
// trail.

const { sendEmail: cronSendEmail } = require('./email');

async function sendBookingReminders() {
  try {
    const now = new Date();
    const in1hr = new Date(now.getTime() + 60 * 60 * 1000);
    const in24hr = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    // Client reminders: scheduled_at between 23h and 25h from now, no
    // prior client-reminder audit row.
    const clientWindow = await pool.query(
      `SELECT a.id, a.client_email, a.client_name, a.scheduled_at, a.duration_minutes,
              t.name AS type_name, t.location_detail, u.full_name AS assignee_name,
              c.name AS company_name
         FROM appointments a
         JOIN appointment_types t ON a.appointment_type_id = t.id
         JOIN users u ON a.assigned_user_id = u.id
         JOIN companies c ON a.company_id = c.id
        WHERE a.status IN ('booked','confirmed')
          AND a.scheduled_at BETWEEN $1 AND $2
          AND NOT EXISTS (
            SELECT 1 FROM appointment_audit aa
             WHERE aa.appointment_id = a.id
               AND aa.actor_kind = 'system'
               AND aa.details->>'reminder_kind' = 'client_24h'
          )`,
      [new Date(in24hr.getTime() - 60 * 60 * 1000), new Date(in24hr.getTime() + 60 * 60 * 1000)]
    );
    for (const a of clientWindow.rows) {
      try {
        await cronSendEmail(
          a.client_email,
          `Reminder: ${a.type_name} with ${a.company_name} tomorrow`,
          `<p>Hi ${a.client_name},</p>
           <p>This is a reminder that you have a <strong>${a.type_name}</strong> with ${a.assignee_name} from ${a.company_name} tomorrow at <strong>${new Date(a.scheduled_at).toLocaleString()}</strong> (${a.duration_minutes} minutes).</p>
           ${a.location_detail ? `<p>Location: ${a.location_detail}</p>` : ''}
           <p>If you need to cancel or reschedule, use the manage link from your booking confirmation.</p>`
        );
        await pool.query(
          `INSERT INTO appointment_audit (appointment_id, action, actor_kind, details)
           VALUES ($1, 'confirmed', 'system', $2)`,
          [a.id, JSON.stringify({ reminder_kind: 'client_24h' })]
        );
      } catch (err) { console.error('[cron] client reminder error:', err); }
    }
    // Assignee reminders: 1h before. Same logic, different recipient.
    const assigneeWindow = await pool.query(
      `SELECT a.id, a.client_name, a.client_phone, a.client_notes,
              a.scheduled_at, a.duration_minutes,
              t.name AS type_name, t.location_detail,
              u.email AS assignee_email, u.full_name AS assignee_name,
              c.name AS company_name
         FROM appointments a
         JOIN appointment_types t ON a.appointment_type_id = t.id
         JOIN users u ON a.assigned_user_id = u.id
         JOIN companies c ON a.company_id = c.id
        WHERE a.status IN ('booked','confirmed')
          AND a.scheduled_at BETWEEN $1 AND $2
          AND u.email IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM appointment_audit aa
             WHERE aa.appointment_id = a.id
               AND aa.actor_kind = 'system'
               AND aa.details->>'reminder_kind' = 'assignee_1h'
          )`,
      [new Date(in1hr.getTime() - 15 * 60 * 1000), new Date(in1hr.getTime() + 15 * 60 * 1000)]
    );
    for (const a of assigneeWindow.rows) {
      try {
        await cronSendEmail(
          a.assignee_email,
          `In 1 hour: ${a.type_name} with ${a.client_name}`,
          `<p>Hi ${a.assignee_name},</p>
           <p>You have a <strong>${a.type_name}</strong> with <strong>${a.client_name}</strong> in about an hour, at ${new Date(a.scheduled_at).toLocaleString()}.</p>
           ${a.client_phone ? `<p>Client phone: ${a.client_phone}</p>` : ''}
           ${a.client_notes ? `<p>Client notes: ${a.client_notes}</p>` : ''}
           ${a.location_detail ? `<p>Location: ${a.location_detail}</p>` : ''}`
        );
        await pool.query(
          `INSERT INTO appointment_audit (appointment_id, action, actor_kind, details)
           VALUES ($1, 'confirmed', 'system', $2)`,
          [a.id, JSON.stringify({ reminder_kind: 'assignee_1h' })]
        );
      } catch (err) { console.error('[cron] assignee reminder error:', err); }
    }
  } catch (err) {
    console.error('[cron] sendBookingReminders error:', err);
  }
}

function startCron() {
  // Run immediately on startup (catches any missed window from restart)
  sendShiftReminders();
  sendSignoffReminders();
  expireOldTrials();
  sweepStaleActiveClock();
  sendBookingReminders();
  // Then run every hour (every 15 min for bookings — finer-grained since
  // a 1h reminder needs catching within a 15-min slot).
  setInterval(sendShiftReminders, 60 * 60 * 1000);
  setInterval(sendSignoffReminders, 60 * 60 * 1000);
  setInterval(expireOldTrials, 60 * 60 * 1000);
  setInterval(sweepStaleActiveClock, 60 * 60 * 1000);
  setInterval(sendBookingReminders, 15 * 60 * 1000);
  console.log('[cron] Shift / sign-off / trial-expiry / stale-clock / booking-reminder crons started');
}

module.exports = { startCron };
