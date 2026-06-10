const sgMail = require('@sendgrid/mail');
const pool = require('./db');
const logger = require('./logger');

if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const FROM = process.env.EMAIL_FROM || 'info@opsfloa.com';
const REDIRECT_TO = process.env.EMAIL_REDIRECT_TO || 'info@opsfloa.com';

// Skip addresses we know bounce — avoids burning SendGrid reputation on
// a recipient who's already hard-bounced. Returns true if the email is flagged.
async function isBounced(email) {
  if (!email) return false;
  try {
    const { rows } = await pool.query(
      'SELECT email_bounced_at FROM users WHERE LOWER(email) = LOWER($1) AND email_bounced_at IS NOT NULL LIMIT 1',
      [email]
    );
    return rows.length > 0;
  } catch {
    return false; // DB hiccup — err on the side of attempting send
  }
}

// EMAIL_MODE controls non-production behaviour:
//   real     — send to the real recipient (used in production automatically)
//   redirect — send to REDIRECT_TO with the original recipient noted in the subject (default for non-prod)
//   suppress — log but do not send; callers behave as if the email succeeded
//
// In production (NODE_ENV=production) EMAIL_MODE is always treated as "real"
// regardless of what is set, so there is no risk of accidentally suppressing
// production email by leaving a staging env var in place.
const isProd = process.env.NODE_ENV === 'production';
const emailMode = isProd ? 'real' : (process.env.EMAIL_MODE || 'redirect');

// `attachments` (optional): SendGrid-shaped attachment array — each entry
// { content: base64String, filename, type, disposition: 'attachment' }.
// Used today by the booking flow to attach an .ics calendar invite to
// confirmation emails so clients can drop the appointment into their
// own calendar.
async function sendEmail(to, subject, html, attachments) {
  if (!to) return;

  // Short-circuit if this recipient is already known-bad from SendGrid's
  // event webhook. Prevents re-sending to invalid addresses.
  if (await isBounced(to)) {
    logger.debug({ to, subject }, 'email skipped — recipient previously bounced');
    return;
  }

  if (emailMode === 'suppress') {
    logger.debug({ to, subject }, 'email suppressed (dev mode)');
    return;
  }

  if (emailMode === 'redirect') {
    const env = process.env.NODE_ENV || 'development';
    logger.debug({ to, subject, env }, 'email redirect (dev)');
    if (!process.env.SENDGRID_API_KEY) return;
    try {
      const msg = {
        to: REDIRECT_TO,
        from: FROM,
        subject: `[${env.toUpperCase()} → ${to}] ${subject}`,
        html: `
          <div style="background:#fef3c7;border:2px solid #f59e0b;border-radius:8px;padding:16px 20px;margin-bottom:24px;font-family:system-ui,sans-serif">
            <strong style="color:#92400e">Non-production email intercept</strong><br>
            <span style="color:#78350f;font-size:13px">
              Environment: <strong>${env}</strong><br>
              Would have sent to: <strong>${to}</strong><br>
              Subject: <strong>${subject}</strong>
            </span>
          </div>
          ${html}`,
      };
      if (Array.isArray(attachments) && attachments.length > 0) msg.attachments = attachments;
      await sgMail.send(msg);
    } catch (err) {
      logger.error({ err: { message: err.message, body: err?.response?.body } }, 'email redirect failed');
    }
    return;
  }

  // emailMode === 'real'
  if (!process.env.SENDGRID_API_KEY) return;
  try {
    const msg = { to, from: FROM, subject, html };
    if (Array.isArray(attachments) && attachments.length > 0) msg.attachments = attachments;
    await sgMail.send(msg);
  } catch (err) {
    logger.error({ err: { message: err.message, body: err?.response?.body }, to, subject }, 'email send failed');
  }
}

module.exports = { sendEmail };
