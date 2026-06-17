const cron = require('node-cron');
const pool = require('../db');
const { sendPushToCompanyAdmins } = require('../push');
const { sendEmail } = require('../email');
const { createInboxItemBatch } = require('../routes/inbox');
const { runJob } = require('./runJob');

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function checkInactiveWorkers() {
  // Get all active companies with their inactive_days threshold and alert toggle
  const companies = await pool.query(`
      SELECT c.id, c.name,
             COALESCE(
               (SELECT value::int FROM settings WHERE company_id = c.id AND key = 'notification_inactive_days'),
               3
             ) as inactive_days,
             COALESCE(
               (SELECT value FROM settings WHERE company_id = c.id AND key = 'feature_inactive_alerts'),
               '0'
             ) as feature_inactive_alerts
      FROM companies c
      WHERE c.subscription_status IN ('trial', 'active') AND c.is_demo = false
    `);

    for (const company of companies.rows) {
      const { id: companyId, name: companyName, inactive_days, feature_inactive_alerts } = company;
      if (feature_inactive_alerts === '0') continue;

      // Workers with no entry or last entry older than threshold
      const inactive = await pool.query(`
        SELECT u.id, u.full_name, MAX(te.work_date) as last_entry_date
        FROM users u
        LEFT JOIN time_entries te ON te.user_id = u.id AND te.company_id = u.company_id
        WHERE u.company_id = $1 AND u.role = 'worker' AND u.active = true
        GROUP BY u.id, u.full_name
        HAVING MAX(te.work_date) IS NULL
            OR MAX(te.work_date) < CURRENT_DATE - ($2 || ' days')::INTERVAL
      `, [companyId, inactive_days]);

      if (inactive.rowCount === 0) continue;

      const count = inactive.rowCount;
      const names = inactive.rows.map(r => r.full_name).join(', ');

      const alertTitle = `${count} inactive worker${count !== 1 ? 's' : ''}`;
      const alertBody = `${names} ${count !== 1 ? 'have' : 'has'} no entries in ${inactive_days}+ days`;

      // Push to all company admins
      await sendPushToCompanyAdmins(companyId, {
        title: alertTitle,
        body: alertBody,
        url: '/workforce#reports',
      });

      // Inbox for all company admins
      const adminRows = await pool.query(
        `SELECT id FROM users WHERE company_id = $1 AND role IN ('admin','super_admin') AND active = true`,
        [companyId]
      );
      const adminIds = adminRows.rows.map(a => a.id);
      if (adminIds.length > 0) {
        createInboxItemBatch(adminIds, companyId, 'inactive_workers', alertTitle, alertBody, '/workforce#reports');
      }

      // Email to first admin with an email address
      const adminResult = await pool.query(
        `SELECT email, full_name FROM users
         WHERE company_id = $1 AND role = 'admin' AND active = true AND email IS NOT NULL
         LIMIT 1`,
        [companyId]
      );
      if (adminResult.rowCount > 0) {
        const admin = adminResult.rows[0];
        const rows = inactive.rows.map(r => {
          const daysSince = r.last_entry_date
            ? Math.floor((Date.now() - new Date(r.last_entry_date)) / 86400000)
            : null;
          const lastStr = daysSince === null ? 'No entries yet' : `${daysSince} day${daysSince !== 1 ? 's' : ''} ago`;
          return `<tr>
            <td style="padding:6px 12px;border-bottom:1px solid #f3f4f6">${escHtml(r.full_name)}</td>
            <td style="padding:6px 12px;border-bottom:1px solid #f3f4f6;color:#6b7280">${escHtml(lastStr)}</td>
          </tr>`;
        }).join('');

        await sendEmail(
          admin.email,
          `${count} inactive worker${count !== 1 ? 's' : ''} — ${companyName}`,
          `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">
            <h3 style="color:#d97706;margin-bottom:8px">Inactive Worker Alert</h3>
            <p style="color:#444;margin-bottom:16px">
              The following ${count === 1 ? 'worker has' : 'workers have'} not submitted any time entries in the last ${inactive_days} days:
            </p>
            <table style="width:100%;border-collapse:collapse">
              <thead>
                <tr>
                  <th style="text-align:left;padding:6px 12px;background:#f9fafb;font-size:12px;text-transform:uppercase;color:#6b7280">Worker</th>
                  <th style="text-align:left;padding:6px 12px;background:#f9fafb;font-size:12px;text-transform:uppercase;color:#6b7280">Last Entry</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
            <p style="margin-top:20px">
              <a href="${process.env.APP_URL}/workforce#reports" style="color:#1a56db;font-weight:600">View reports in OpsFloa →</a>
            </p>
          </div>`
        );
      }
    }
}

function startInactiveWorkerJob() {
  // Run at 8 AM server time every day. runJob wraps errors → logger + Sentry.
  cron.schedule('0 8 * * *', () => runJob('inactiveWorkers', checkInactiveWorkers));
}

module.exports = { startInactiveWorkerJob };
