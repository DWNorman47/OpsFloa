const { Resend } = require('resend');
const logger = require('./logger');
const { getStore } = require('./demoMode');
const { isSuppressed } = require('./services/emailSuppression');

// Single place that talks to the email provider. Every send path in the app
// routes through sendEmail() below so there is one transport, one from-address,
// and one set of guards (demo suppression, bounce skip, env redirect).
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Resend requires the from-domain to be verified. EMAIL_FROM may be a bare
// address ("info@opsfloa.com") or a full "Name <addr>" — normalise to include
// the OpsFloa display name when only an address is given.
const FROM_ADDRESS = process.env.EMAIL_FROM || 'info@opsfloa.com';
const FROM = FROM_ADDRESS.includes('<') ? FROM_ADDRESS : `OpsFloa <${FROM_ADDRESS}>`;
const REDIRECT_TO = process.env.EMAIL_REDIRECT_TO || 'info@opsfloa.com';

// The bounce-skip lives in services/emailSuppression.js, alongside the writes
// that set the flag — read and write have to agree on the matching rule.

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

// Callers still pass SendGrid-shaped attachments
// ({ content: base64, filename, type, disposition }); Resend wants
// { filename, content: Buffer }. Map on the way out so no call site changes.
function toResendAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined;
  return attachments.map(a => ({
    filename: a.filename,
    content: Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content), 'base64'),
  }));
}

// Low-level provider call. Returns { ok: true } or { ok: false, error }.
// Never throws — the Resend SDK returns errors in-band, and we also guard
// against network throws.
async function deliver(msg) {
  try {
    const { error } = await resend.emails.send(msg);
    if (error) {
      logger.error({ err: error, to: msg.to, subject: msg.subject }, 'email send failed');
      return { ok: false, error };
    }
    return { ok: true };
  } catch (err) {
    logger.error({ err: { message: err.message }, to: msg.to, subject: msg.subject }, 'email send threw');
    return { ok: false, error: err };
  }
}

// `attachments` (optional): SendGrid-shaped attachment array — each entry
// { content: base64String, filename, type, disposition: 'attachment' }.
// Used today by the booking flow to attach an .ics calendar invite.
//
// Returns a small status object so callers that care can react:
//   { ok: true }               — sent (or redirected/suppressed as configured)
//   { ok: false, error }       — the provider rejected the send
//   { suppressed: 'demo' }     — acting company is the demo tenant
//   { skipped: <reason> }      — nothing sent, but not a failure (no key, bounce, …)
// Only `ok === false` signals a real delivery failure.
async function sendEmail(to, subject, html, attachments) {
  if (!to) return { skipped: 'no_recipient' };

  // Demo/test tenant: never send real email. Suppress and flag the request
  // so the client can show a "would have sent" popup. Keyed on the acting
  // company via the request-scoped demo context (see demoMode.js).
  const store = getStore();
  if (store && store.isDemo) {
    store.emailSuppressed = true;
    logger.info({ to, subject }, 'email suppressed — demo company (no real send)');
    return { suppressed: 'demo' };
  }

  // Short-circuit if this recipient is already known-bad from the provider's
  // bounce webhook. Prevents re-sending to invalid addresses.
  if (await isSuppressed(to)) {
    logger.debug({ to, subject }, 'email skipped — recipient previously bounced');
    return { skipped: 'bounced' };
  }

  if (emailMode === 'suppress') {
    logger.debug({ to, subject }, 'email suppressed (dev mode)');
    return { suppressed: 'dev' };
  }

  // No key configured — treat as a soft no-op (same as the old behaviour) so
  // callers that gate on delivery don't hard-fail an unconfigured environment.
  if (!resend) {
    logger.warn({ to, subject }, 'email not sent — RESEND_API_KEY not set');
    return { skipped: 'no_api_key' };
  }

  const resendAttachments = toResendAttachments(attachments);

  if (emailMode === 'redirect') {
    const env = process.env.NODE_ENV || 'development';
    logger.debug({ to, subject, env }, 'email redirect (dev)');
    const msg = {
      from: FROM,
      to: REDIRECT_TO,
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
    if (resendAttachments) msg.attachments = resendAttachments;
    return deliver(msg);
  }

  // emailMode === 'real'
  const msg = { from: FROM, to, subject, html };
  if (resendAttachments) msg.attachments = resendAttachments;
  return deliver(msg);
}

module.exports = { sendEmail };
