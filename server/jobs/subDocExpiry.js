const cron = require('node-cron');
const pool = require('../db');
const { sendPushToCompanyAdmins } = require('../push');
const { createInboxItem } = require('../routes/inbox');
const { runJob } = require('./runJob');

// Warn this far ahead of a document lapsing. 30 days is the practical window for
// insurance — long enough to chase the sub's broker before it actually expires.
const LEAD_DAYS = 30;

// Human labels for the doc_type enum (0107). A "certificate of insurance
// expires tomorrow" reads very differently from "document expires tomorrow".
const DOC_LABEL = {
  coi: 'Certificate of insurance',
  license: 'License',
  w9: 'W-9',
  contract: 'Contract',
  other: 'Document',
};

// Daily: tell admins about subcontractor documents that are about to lapse, and
// (louder) ones that already have. Each document alerts at most once per stage
// via a claim on its own stamp, so a batch can't double-send and a crash
// mid-loop can't re-notify what already went out. Replacing a document creates a
// new row, which re-arms both stages for free.
async function checkSubDocExpiry() {
  const companies = await pool.query(
    `SELECT id FROM companies WHERE subscription_status IN ('trial', 'active')`
  );

  for (const { id: companyId } of companies.rows) {
    // subcontractor_documents has no company_id of its own — it hangs off the
    // sub, so scope through the join.
    const rows = await pool.query(
      `SELECT d.id, d.doc_type, d.name, d.expires_on, s.name AS sub_name,
              (d.expires_on < CURRENT_DATE) AS is_expired
         FROM subcontractor_documents d
         JOIN subcontractors s ON s.id = d.subcontractor_id
        WHERE s.company_id = $1
          AND s.active = true
          AND d.expires_on IS NOT NULL
          AND d.expires_on <= CURRENT_DATE + ($2 || ' days')::interval
          AND ( (d.expires_on <  CURRENT_DATE AND d.expired_alert_at  IS NULL)
             OR (d.expires_on >= CURRENT_DATE AND d.expiring_alert_at IS NULL) )
        ORDER BY d.expires_on ASC
        LIMIT 500`,
      [companyId, LEAD_DAYS]
    );
    if (rows.rowCount === 0) continue;

    const admins = await pool.query(
      `SELECT id FROM users WHERE company_id = $1 AND role IN ('admin','super_admin') AND active = true`,
      [companyId]
    );

    for (const d of rows.rows) {
      const stamp = d.is_expired ? 'expired_alert_at' : 'expiring_alert_at';
      // Claim the stage before sending — if a prior run already covered it, skip.
      const claim = await pool.query(
        `UPDATE subcontractor_documents SET ${stamp} = NOW()
          WHERE id = $1 AND ${stamp} IS NULL RETURNING id`,
        [d.id]
      );
      if (claim.rowCount === 0) continue;

      const on = d.expires_on.toISOString().slice(0, 10);
      const label = DOC_LABEL[d.doc_type] || 'Document';
      const title = d.is_expired
        ? `${label} expired — ${d.sub_name}`
        : `${label} expiring — ${d.sub_name}`;
      const body = d.is_expired
        ? `${d.sub_name}'s ${label.toLowerCase()} expired on ${on}. Get a current one before they work again.`
        : `${d.sub_name}'s ${label.toLowerCase()} expires ${on}. Ask for a renewal now.`;

      try {
        await sendPushToCompanyAdmins(companyId, { title, body, url: '/team#subs' });
        for (const a of admins.rows) {
          createInboxItem(a.id, companyId, 'sub_doc_expiring', title, body, '/team#subs');
        }
      } catch (err) {
        // One bad row shouldn't abort the batch.
        console.error('[subDocExpiry] notify failed:', err.message);
      }
    }
  }
}

function startSubDocExpiryJob() {
  cron.schedule('0 8 * * *', () => runJob('subDocExpiry', checkSubDocExpiry));
}

module.exports = { startSubDocExpiryJob, checkSubDocExpiry, LEAD_DAYS };
