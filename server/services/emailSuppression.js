const pool = require('../db');
const logger = require('../logger');

/**
 * The one owner of users.email_bounced_at / email_bounce_reason.
 *
 * Every read and write of that column goes through here. The read (skip this
 * recipient) and the write (this address bounced) have to agree on the matching
 * rule or the whole thing silently misfires, and they used to live in two files
 * that had no idea about each other.
 *
 * The matching rule: **by address, case-insensitively.** A bounce arrives from
 * the provider with an address, not a user id. `users.email` is UNIQUE, so an
 * address is at most one row — which is why clearing by address and clearing by
 * user id are the same operation, and why marking can't leak across companies.
 *
 * Why this matters more than it looks: a suppressed address receives NOTHING,
 * including the password reset and the invite. There is no user-visible symptom
 * — mail just stops. So a suppression that can't be lifted is an account that
 * can't be recovered. Every write path here has to have an inverse.
 */

// Skip addresses we know are dead — re-sending to them is what burns sender
// reputation with the receiving networks.
async function isSuppressed(email) {
  if (!email) return false;
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM users WHERE LOWER(email) = LOWER($1) AND email_bounced_at IS NOT NULL LIMIT 1',
      [email]
    );
    return rows.length > 0;
  } catch (err) {
    // A DB hiccup must never block mail. Err toward attempting the send: one
    // extra message to a dead address costs almost nothing, a dropped password
    // reset costs a locked-out user.
    logger.warn({ err: { message: err.message } }, 'suppression check failed — attempting send anyway');
    return false;
  }
}

// Flag an address as undeliverable. Idempotent: the `IS NULL` guard keeps the
// original bounce timestamp and reason rather than letting a later duplicate
// event overwrite the first diagnosis. Returns the user row, or null when the
// address matched nobody (a bounced client/subcontractor address is normal —
// they aren't users) or was already flagged.
async function markSuppressed(email, reason) {
  const addr = (email || '').trim().toLowerCase();
  if (!addr) return null;
  const { rows } = await pool.query(
    `UPDATE users SET email_bounced_at = NOW(), email_bounce_reason = $1
     WHERE LOWER(email) = $2 AND email_bounced_at IS NULL
     RETURNING id, company_id, email`,
    [String(reason || '').slice(0, 255), addr]
  );
  return rows[0] || null;
}

// Lift a suppression. Scoped to the company so one tenant's admin can't clear
// another's row. Returns the row, or null if that user wasn't suppressed.
async function clearSuppression(userId, companyId) {
  const { rows } = await pool.query(
    `UPDATE users SET email_bounced_at = NULL, email_bounce_reason = NULL
     WHERE id = $1 AND company_id = $2 AND email_bounced_at IS NOT NULL
     RETURNING id, email`,
    [userId, companyId]
  );
  return rows[0] || null;
}

module.exports = { isSuppressed, markSuppressed, clearSuppression };
