/**
 * Background cron jobs — started once from index.js via startCron().
 * Uses setInterval; runs in-process alongside the Express server.
 */
const pool = require('./db');
const { sendPushToUser, sendPushToCompanyAdmins } = require('./push');
const { createInboxItemBatch } = require('./routes/inbox');
const { rolloverStaleDemoClocks } = require('./services/demoClockRollover');
const { reconcileStaleHourLimits } = require('./utils/projectHourLimits');

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
         JOIN companies c ON c.id = ac.company_id
         JOIN users u ON u.id = ac.user_id
         LEFT JOIN projects p ON p.id = ac.project_id
        WHERE c.is_demo = false
          AND ac.clock_in_time < NOW() - ($1 || ' hours')::INTERVAL
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

async function maintainActiveClocks() {
  try {
    const rolledOver = await rolloverStaleDemoClocks();
    if (rolledOver > 0) {
      console.log(`[cron] Demo Operations: rolled over ${rolledOver} active clock(s)`);
    }
  } catch (err) {
    console.error('[cron] rolloverStaleDemoClocks error:', err);
  }

  await sweepStaleActiveClock();

  // Backstop for per-project hard hour limits. The lazy observers
  // (/clock/status, /admin/active-clocks) enforce these in real time; this
  // hourly pass just catches a shift nobody looked at. See
  // server/utils/projectHourLimits.js.
  try {
    const acted = await reconcileStaleHourLimits();
    if (acted > 0) console.log(`[cron] hour-limit backstop: reconciled ${acted} action(s)`);
  } catch (err) {
    console.error('[cron] hour-limit backstop error:', err);
  }
}

// ─── Booking reminders ──────────────────────────────────────────────────────
//
// Run every 15 minutes. Sends one client reminder 24h before the
// appointment and one assignee reminder 1h before.
//
// Dedup uses `appointments.reminder_client_24h_at` and
// `reminder_assignee_1h_at` columns (added in migration 0114) via a
// claim-then-send pattern: an UPDATE WHERE col IS NULL atomically
// stamps "I'm sending this reminder," and only rows the UPDATE
// actually changed get an email. If the process dies between claim
// and send, the next 15-min run finds the claim in place and skips —
// you lose an email, but you never spam.

const { sendEmail: cronSendEmail } = require('./email');
const { escapeHtml: cronEscape } = require('./utils/htmlEscape');

async function sendBookingReminders() {
  try {
    const now = new Date();
    const in1hr = new Date(now.getTime() + 60 * 60 * 1000);
    const in24hr = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // ── Client 24h reminders ────────────────────────────────────────────────
    // LIMIT 500 per cron tick. Without a limit, a company with 10,000
    // appointments in the 2-hour window would have one cron run try to
    // process all of them — eating the 15-min budget, blowing through
    // SendGrid rate limits, and starving every other cron job. 500/tick
    // = 2000/hr capacity, which dwarfs realistic per-company traffic
    // and any overflow gets caught on the next tick.
    const clientCandidates = await pool.query(
      `SELECT a.id FROM appointments a
        WHERE a.status IN ('booked','confirmed')
          AND a.reminder_client_24h_at IS NULL
          AND a.scheduled_at BETWEEN $1 AND $2
        ORDER BY a.scheduled_at
        LIMIT 500`,
      [new Date(in24hr.getTime() - 60 * 60 * 1000), new Date(in24hr.getTime() + 60 * 60 * 1000)]
    );
    for (const row of clientCandidates.rows) {
      // Claim the row: UPDATE only succeeds if reminder_client_24h_at is
      // still NULL. If the claim UPDATE itself throws (transient DB
      // hiccup, pool exhaustion), DON'T let it propagate to the outer
      // try — that would abort the whole batch and the surviving rows
      // would silently miss this run's reminder window. Per-row try
      // means one bad row at most loses its reminder.
      let claim;
      try {
        claim = await pool.query(
          `UPDATE appointments
              SET reminder_client_24h_at = NOW()
            WHERE id = $1 AND reminder_client_24h_at IS NULL
          RETURNING id`,
          [row.id]
        );
      } catch (claimErr) {
        console.error('[cron] client reminder claim failed:', claimErr);
        continue;
      }
      if (claim.rowCount === 0) continue;  // another worker grabbed it
      try {
        const r = await pool.query(
          `SELECT a.id, a.client_email, a.client_name, a.scheduled_at, a.duration_minutes,
                  t.name AS type_name, t.location_detail,
                  u.full_name AS assignee_name, c.name AS company_name
             FROM appointments a
             JOIN appointment_types t ON a.appointment_type_id = t.id
             JOIN users u ON a.assigned_user_id = u.id
             JOIN companies c ON a.company_id = c.id
            WHERE a.id = $1`,
          [row.id]
        );
        const a = r.rows[0];
        if (!a) continue;
        await cronSendEmail(
          a.client_email,
          `Reminder: ${a.type_name} with ${a.company_name} tomorrow`,
          `<p>Hi ${cronEscape(a.client_name)},</p>
           <p>This is a reminder that you have a <strong>${cronEscape(a.type_name)}</strong> with ${cronEscape(a.assignee_name)} from ${cronEscape(a.company_name)} tomorrow at <strong>${cronEscape(new Date(a.scheduled_at).toLocaleString())}</strong> (${a.duration_minutes} minutes).</p>
           ${a.location_detail ? `<p>Location: ${cronEscape(a.location_detail)}</p>` : ''}
           <p>If you need to cancel or reschedule, use the manage link from your booking confirmation.</p>`
        );
      } catch (err) {
        // Unwind the claim so a future retry can try again. Better to
        // double-send (rare) than to permanently swallow the reminder.
        await pool.query(
          `UPDATE appointments SET reminder_client_24h_at = NULL WHERE id = $1`,
          [row.id]
        ).catch(() => {});
        console.error('[cron] client reminder error:', err);
      }
    }

    // ── Assignee 1h reminders ───────────────────────────────────────────────
    // LIMIT 500 per tick — same cap as the client reminder loop.
    const assigneeCandidates = await pool.query(
      `SELECT a.id FROM appointments a
         JOIN users u ON a.assigned_user_id = u.id
        WHERE a.status IN ('booked','confirmed')
          AND a.reminder_assignee_1h_at IS NULL
          AND u.email IS NOT NULL
          AND a.scheduled_at BETWEEN $1 AND $2
        ORDER BY a.scheduled_at
        LIMIT 500`,
      [new Date(in1hr.getTime() - 15 * 60 * 1000), new Date(in1hr.getTime() + 15 * 60 * 1000)]
    );
    for (const row of assigneeCandidates.rows) {
      // Same per-row try-wrap as the client loop — guards against the
      // claim UPDATE itself throwing and aborting the rest of the batch.
      let claim;
      try {
        claim = await pool.query(
          `UPDATE appointments
              SET reminder_assignee_1h_at = NOW()
            WHERE id = $1 AND reminder_assignee_1h_at IS NULL
          RETURNING id`,
          [row.id]
        );
      } catch (claimErr) {
        console.error('[cron] assignee reminder claim failed:', claimErr);
        continue;
      }
      if (claim.rowCount === 0) continue;
      try {
        const r = await pool.query(
          `SELECT a.id, a.client_name, a.client_phone, a.client_notes,
                  a.scheduled_at, a.duration_minutes,
                  t.name AS type_name, t.location_detail,
                  u.email AS assignee_email, u.full_name AS assignee_name
             FROM appointments a
             JOIN appointment_types t ON a.appointment_type_id = t.id
             JOIN users u ON a.assigned_user_id = u.id
            WHERE a.id = $1`,
          [row.id]
        );
        const a = r.rows[0];
        if (!a) continue;
        await cronSendEmail(
          a.assignee_email,
          `In 1 hour: ${a.type_name} with ${a.client_name}`,
          `<p>Hi ${cronEscape(a.assignee_name)},</p>
           <p>You have a <strong>${cronEscape(a.type_name)}</strong> with <strong>${cronEscape(a.client_name)}</strong> in about an hour, at ${cronEscape(new Date(a.scheduled_at).toLocaleString())}.</p>
           ${a.client_phone ? `<p>Client phone: ${cronEscape(a.client_phone)}</p>` : ''}
           ${a.client_notes ? `<p>Client notes: ${cronEscape(a.client_notes)}</p>` : ''}
           ${a.location_detail ? `<p>Location: ${cronEscape(a.location_detail)}</p>` : ''}`
        );
      } catch (err) {
        await pool.query(
          `UPDATE appointments SET reminder_assignee_1h_at = NULL WHERE id = $1`,
          [row.id]
        ).catch(() => {});
        console.error('[cron] assignee reminder error:', err);
      }
    }
  } catch (err) {
    console.error('[cron] sendBookingReminders error:', err);
  }
}

function startCron() {
  // Only run background jobs in production. Staging and dev are test
  // environments: they don't need to email reminders, expire trials, or sweep
  // clocks — and running these jobs (esp. the 15-min booking sweep) keeps their
  // Neon compute awake around the clock for no benefit. Skipping them lets those
  // branches' DBs stay suspended except during real use.
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[cron] NODE_ENV=${process.env.NODE_ENV || 'development'} — background jobs disabled (production only)`);
    return;
  }

  // Run immediately on startup (catches any missed window from restart)
  sendShiftReminders();
  sendSignoffReminders();
  expireOldTrials();
  maintainActiveClocks();
  sendBookingReminders();
  // Then run every hour (every 15 min for bookings — finer-grained since
  // a 1h reminder needs catching within a 15-min slot).
  setInterval(sendShiftReminders, 60 * 60 * 1000);
  setInterval(sendSignoffReminders, 60 * 60 * 1000);
  setInterval(expireOldTrials, 60 * 60 * 1000);
  setInterval(maintainActiveClocks, 60 * 60 * 1000);
  setInterval(sendBookingReminders, 15 * 60 * 1000);
  console.log('[cron] Shift / sign-off / trial-expiry / stale-clock / booking-reminder crons started');
}

module.exports = { startCron };
