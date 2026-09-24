const cron = require('node-cron');
const pool = require('../db');
const logger = require('../logger');
const { sendEmail } = require('../email');
const { escapeHtml } = require('../utils/htmlEscape');
const { getAppUrl } = require('../utils/appUrl');
const { createInboxItem } = require('../routes/inbox');
const { runJob } = require('./runJob');

async function expireTrials() {
  // Find companies whose trial has ended and haven't yet been marked expired
  const expired = await pool.query(`
      UPDATE companies
      SET subscription_status = 'trial_expired'
      WHERE subscription_status = 'trial'
        AND trial_ends_at IS NOT NULL
        AND trial_ends_at < NOW()
      RETURNING id, name
    `);

    if (expired.rowCount === 0) return;

    for (const company of expired.rows) {
      const { id: companyId, name: companyName } = company;

      // Get all admins for this company
      const admins = await pool.query(
        `SELECT id, email, full_name FROM users
         WHERE company_id = $1 AND role IN ('admin', 'super_admin') AND active = true`,
        [companyId]
      );

      for (const admin of admins.rows) {
        // In-app notification
        createInboxItem(
          admin.id, companyId,
          'trial_expired',
          'Your free trial has ended',
          'Subscribe to keep your data and continue using OpsFloa.',
          '/administration#billing'
        );

        // Email
        if (admin.email) {
          sendEmail(
            admin.email,
            `Your OpsFloa trial has ended — ${String(companyName || '').replace(/[\r\n]+/g, ' ')}`,
            `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">
              <h2 style="color:#111827;margin-bottom:8px">Your free trial has ended</h2>
              <p style="color:#444;margin-bottom:16px">
                Hi ${escapeHtml(admin.full_name || '')}, your 14-day trial of OpsFloa for <strong>${escapeHtml(companyName || '')}</strong> has expired.
              </p>
              <p style="color:#444;margin-bottom:24px">
                Your data is safe — subscribe now to restore access. All your workers, projects, and time entries are waiting for you.
              </p>
              <a href="${getAppUrl()}/administration#billing"
                style="display:inline-block;background:#1a56db;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:15px">
                Choose a plan →
              </a>
              <p style="color:#9ca3af;font-size:12px;margin-top:24px">
                Questions? Reply to this email and we'll help you get set up.
              </p>
            </div>`
          );
        }
      }

      logger.info({ companyId, companyName }, 'trial expired');
    }
}

function startExpireTrialsJob() {
  // Check every hour — trials expire within 60 minutes of their end time
  cron.schedule('0 * * * *', () => runJob('expireTrials', expireTrials));
  // Also run immediately on startup to catch any that expired while server was down
  runJob('expireTrials', expireTrials);
}

module.exports = { startExpireTrialsJob, expireTrials };
