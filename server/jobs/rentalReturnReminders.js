const cron = require('node-cron');
const pool = require('../db');
const { sendPushToCompanyAdmins, sendPushToUser } = require('../push');
const { createInboxItem } = require('../routes/inbox');
const { runJob } = require('./runJob');

// Remind this many days before a rental's return is due (and every day it stays
// overdue, until it's reminded once — see the claim below).
const LEAD_DAYS = 2;

// Daily: notify admins (and the current holder) about rentals due back soon or
// overdue. Each asset is reminded once via a claim on rental_reminder_sent_at;
// editing the due date on PATCH clears the stamp and re-arms the reminder.
async function checkRentalReturns() {
  const companies = await pool.query(
    `SELECT id FROM companies WHERE subscription_status IN ('trial', 'active')`
  );

  for (const { id: companyId } of companies.rows) {
    const due = await pool.query(
      `SELECT id, name, unit_number, rental_vendor, rental_return_due
       FROM equipment_items
       WHERE company_id = $1 AND active = true AND is_rental = true
         AND rental_return_due IS NOT NULL
         AND rental_return_due <= CURRENT_DATE + ($2 || ' days')::interval
         AND rental_reminder_sent_at IS NULL
       ORDER BY rental_return_due ASC
       LIMIT 500`,
      [companyId, LEAD_DAYS]
    );
    if (due.rowCount === 0) continue;

    const adminRows = await pool.query(
      `SELECT id FROM users WHERE company_id = $1 AND role IN ('admin','super_admin') AND active = true`,
      [companyId]
    );

    for (const r of due.rows) {
      // Claim once — if a prior run already sent this reminder, skip.
      const claim = await pool.query(
        `UPDATE equipment_items SET rental_reminder_sent_at = NOW()
         WHERE id = $1 AND rental_reminder_sent_at IS NULL RETURNING id`,
        [r.id]
      );
      if (claim.rowCount === 0) continue;

      const dueStr = r.rental_return_due.toISOString().slice(0, 10);
      const overdue = dueStr < new Date().toISOString().slice(0, 10);
      const title = overdue ? 'Rental overdue for return' : 'Rental return coming up';
      const body = `${r.name}${r.unit_number ? ` (${r.unit_number})` : ''}` +
        `${r.rental_vendor ? ` from ${r.rental_vendor}` : ''} is due back ${dueStr}.`;

      try {
        await sendPushToCompanyAdmins(companyId, { title, body, url: '/inventory#eq-rentals' });
        // Nudge whoever currently has it out, if anyone.
        const holder = await pool.query(
          `SELECT user_id FROM equipment_checkouts
           WHERE asset_id = $1 AND returned_at IS NULL AND user_id IS NOT NULL LIMIT 1`,
          [r.id]
        );
        if (holder.rowCount) await sendPushToUser(holder.rows[0].user_id, { title, body, url: '/inventory#eq-rentals' });
        for (const a of adminRows.rows) {
          createInboxItem(a.id, companyId, 'equipment_rental_due', title, body, '/inventory#eq-rentals');
        }
      } catch (err) {
        // One bad row shouldn't abort the batch.
        console.error('[rentalReturnReminders] notify failed:', err.message);
      }
    }
  }
}

function startRentalReturnRemindersJob() {
  cron.schedule('0 8 * * *', () => runJob('rentalReturnReminders', checkRentalReturns));
}

module.exports = { startRentalReturnRemindersJob };
