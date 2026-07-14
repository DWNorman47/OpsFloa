const cron = require('node-cron');
const pool = require('../db');
const { sendPushToUser, sendPushToCompanyAdmins } = require('../push');
const { createInboxItem } = require('../routes/inbox');
const { runJob } = require('./runJob');

// Remind the estimate's owner (and admins) when a bid is due within ~24h — once.
// Claim-then-send via bid_reminder_sent_at so each bid is flagged exactly once
// per due date; the stamp is cleared when bid_due_at changes (routes/estimates.js),
// which re-arms it. The 7-day floor skips ancient/forgotten past-due bids.
async function checkBidDue() {
  const due = await pool.query(`
    UPDATE estimates
       SET bid_reminder_sent_at = NOW()
     WHERE bid_due_at IS NOT NULL
       AND bid_reminder_sent_at IS NULL
       AND status IN ('draft', 'sent')
       AND bid_due_at <= NOW() + INTERVAL '24 hours'
       AND bid_due_at >= NOW() - INTERVAL '7 days'
     RETURNING id, company_id, estimate_number, project_name, bid_due_at, created_by
  `);
  for (const e of due.rows) {
    const label = e.project_name || e.estimate_number;
    const when = new Date(e.bid_due_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const overdue = new Date(e.bid_due_at).getTime() < Date.now();
    const title = overdue ? `Bid overdue: ${label}` : `Bid due soon: ${label}`;
    const body = `${e.estimate_number} ${overdue ? 'was due' : 'is due'} ${when}`;
    const url = '/work#estimates';
    // durable inbox item + best-effort push, each independent so one failure
    // doesn't drop the rest of the batch (the bid is already claimed)
    if (e.created_by) {
      createInboxItem(e.created_by, e.company_id, 'bid_due', title, body, url).catch(() => {});
      sendPushToUser(e.created_by, { title, body, url }).catch(() => {});
    }
    sendPushToCompanyAdmins(e.company_id, { title, body, url }).catch(() => {});
  }
}

function startBidDueReminderJob() {
  // hourly — a bid entering the 24h window gets one reminder that same hour
  cron.schedule('0 * * * *', () => runJob('bidDueReminders', checkBidDue));
}

module.exports = { startBidDueReminderJob, checkBidDue };
