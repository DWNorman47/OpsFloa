const express = require('express');
const { Resend } = require('resend');
const logger = require('../logger');
const { markSuppressed } = require('../services/emailSuppression');

const router = express.Router();

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

/**
 * POST /api/resend-events
 *
 * Resend's event webhook — the thing that tells us an address is dead.
 *
 * Configure in the Resend dashboard (Webhooks → Add Webhook):
 *   Endpoint: https://<server>/api/resend-events
 *   Events:   email.bounced, email.complained
 * Then copy the signing secret (whsec_…) into RESEND_WEBHOOK_SECRET.
 *
 * Until that is done this route 503s and nothing is suppressed — which is the
 * state the app was in for the whole gap between the SendGrid migration and
 * this route existing.
 *
 * Signed with the Standard Webhooks scheme; `resend.webhooks.verify()` checks
 * the HMAC and the timestamp (replay window) and throws on anything wrong. That
 * needs the EXACT bytes Resend signed, so this route is mounted with
 * express.raw() in index.js — re-serialising a parsed body changes whitespace
 * and key order and the signature stops matching.
 */

// Resend classifies bounces. Only a Permanent one means the mailbox is actually
// gone. Transient is a full inbox or greylisting and resolves by itself, and
// Undetermined is exactly what it says — suppressing on either would silence a
// real person because their mail server had a bad afternoon, and (before the
// clear paths added alongside this) would have done so forever.
function isPermanentBounce(bounce) {
  return String(bounce?.type || '').toLowerCase() === 'permanent';
}

router.post('/', async (req, res) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret || !resend) {
    logger.warn('resend-events received but RESEND_WEBHOOK_SECRET / RESEND_API_KEY is not set');
    return res.status(503).json({ error: 'Webhook not configured' });
  }

  // The SDK's `headers` option is its own little {id,timestamp,signature}
  // interface — NOT the global fetch Headers, despite the type name. Resend
  // sends these as svix-*; the Standard Webhooks names are accepted as a
  // fallback in case that ever flips.
  const h = req.headers;
  let event;
  try {
    event = resend.webhooks.verify({
      payload: Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || ''),
      headers: {
        id:        h['svix-id']        || h['webhook-id'],
        timestamp: h['svix-timestamp'] || h['webhook-timestamp'],
        signature: h['svix-signature'] || h['webhook-signature'],
      },
      webhookSecret: secret,
    });
  } catch (err) {
    // Covers a forged signature, a missing header, and a replayed old event.
    logger.warn({ err: { message: err.message } }, 'resend webhook signature rejected');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const type = event?.type;
  const data = event?.data || {};

  // Only the two events that mean "stop sending here".
  //   email.bounced    — the receiving server rejected it
  //   email.complained — the recipient hit "this is spam"; keep mailing them
  //                      and the whole sending domain suffers
  if (type !== 'email.bounced' && type !== 'email.complained') {
    return res.status(200).json({ ignored: type });
  }

  if (type === 'email.bounced' && !isPermanentBounce(data.bounce)) {
    logger.info(
      { emailId: data.email_id, bounceType: data.bounce?.type, subType: data.bounce?.subType },
      'resend bounce ignored — not permanent'
    );
    return res.status(200).json({ ignored: 'transient_bounce' });
  }

  const reason = type === 'email.complained'
    ? 'complained: recipient marked as spam'
    : `bounce (${data.bounce?.type}/${data.bounce?.subType}): ${data.bounce?.message || ''}`;

  // `to` is an array — a bounce for a multi-recipient send reports every
  // address on it, and treating it as a string would flag nobody.
  const recipients = Array.isArray(data.to) ? data.to : [data.to].filter(Boolean);
  let marked = 0;

  for (const addr of recipients) {
    try {
      const user = await markSuppressed(addr, reason);
      if (user) {
        marked++;
        logger.info({ userId: user.id, companyId: user.company_id, type }, 'user email suppressed');
      }
      // No match is normal and not an error: clients, subcontractors and
      // public estimate recipients get mail without being users.
    } catch (err) {
      logger.error({ err, type }, 'failed to record resend suppression event');
    }
  }

  // 200 even if individual rows failed — a non-2xx makes Resend retry the whole
  // batch, and the per-address errors are logged above.
  res.status(200).json({ received: recipients.length, marked });
});

module.exports = router;
