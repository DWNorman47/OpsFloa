const { Resend } = require('resend');
const logger = require('./logger');
const { getStore } = require('./demoMode');
const { isSuppressed } = require('./services/emailSuppression');
const { escapeHtml } = require('./utils/htmlEscape');

// Single place that talks to the email provider. Every send path in the app
// routes through sendEmail() below so there is one transport, one from-address,
// and one set of guards (demo suppression, bounce skip, env redirect).
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Resend requires the from-domain to be verified. EMAIL_FROM may be a bare
// address ("info@opsfloa.com") or a full "Name <addr>" — normalise to include
// the OpsFloa display name when only an address is given.
const FROM_ADDRESS = process.env.EMAIL_FROM || 'info@opsfloa.com';
const FROM = FROM_ADDRESS.includes('<') ? FROM_ADDRESS : `OpsFloa <${FROM_ADDRESS}>`;
// The bare address, used when a caller overrides only the display name (the
// address must stay on the verified sending domain — only the name changes).
const FROM_BARE = FROM_ADDRESS.includes('<') ? (FROM_ADDRESS.match(/<([^>]+)>/)?.[1] || FROM_ADDRESS) : FROM_ADDRESS;

// Build the From header, optionally overriding just the display name (quoted so
// commas/specials in a company name can't malform the header). Address unchanged.
// A caller-supplied name is a TENANT's company name on a client-facing email
// (invoice, estimate, …), so it is always shown as "<Company> via OpsFloa":
// the recipient sees who sent it and that it came through OpsFloa, and a tenant
// can't make the mail read as if it came straight from some other brand.
const VIA_SUFFIX = ' via OpsFloa';
function fromHeader(fromName) {
  if (!fromName) return FROM;
  const safe = String(fromName)
    .replace(/["\\<>]/g, '')
    .replace(/\s+/g, ' ') // incl. CR/LF — never a header break
    .trim()
    .replace(/\s+via\s+opsfloa$/i, '') // don't double the suffix
    .slice(0, 80)
    .trim();
  return safe ? `"${safe}${VIA_SUFFIX}" <${FROM_BARE}>` : FROM;
}

// Phishing-abuse limit: a company still in its free TRIAL may send at most this
// many client-facing emails (sendEmail opts.clientCompanyId) per UTC day. Paying
// companies are not limited — including a company that already subscribed but is
// still inside Stripe's trial window (Stripe 'trialing' maps to our 'trial'; it
// has a stripe_subscription_id, i.e. a card on file). Counted on companies.client_email_count /
// client_email_count_day (migration 0215; the counter resets on a new UTC day).
function trialClientEmailDailyCap() {
  const n = parseInt(process.env.TRIAL_CLIENT_EMAIL_DAILY_CAP, 10);
  return Number.isFinite(n) && n >= 0 ? n : 50;
}

// Count this send against the company's daily trial allowance. Returns true when
// the cap is exceeded (→ don't send). One statement: the counter only moves for
// a no-card company whose status is 'trial', so a paying company costs one no-op UPDATE.
// Fails OPEN (logs) on a DB error — an outage of this counter must not block
// every invoice email.
async function trialClientEmailCapExceeded(companyId) {
  if (companyId == null) return false;
  try {
    const pool = require('./db');
    const r = await pool.query(
      `UPDATE companies
          SET client_email_count_day = CURRENT_DATE,
              client_email_count = CASE WHEN client_email_count_day = CURRENT_DATE
                                        THEN COALESCE(client_email_count, 0) + 1 ELSE 1 END
        WHERE id = $1 AND subscription_status = 'trial' AND stripe_subscription_id IS NULL
        RETURNING client_email_count AS sent`,
      [companyId]
    );
    if (!r.rows || !r.rows.length) return false; // not a trial company
    return Number(r.rows[0].sent) > trialClientEmailDailyCap();
  } catch (err) {
    logger.warn({ err: { message: err.message, code: err.code }, companyId }, 'trial client-email cap check failed — allowing send');
    return false;
  }
}
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

// DB-level override (system_flags.email_mode, migration 0221). The stage sync
// workflow sets it to 'suppress' after restoring a scrubbed prod copy, so a stage
// server never emails real people even though it runs NODE_ENV=production. The
// flag can only make sending SAFER: 'suppress' always wins, 'redirect' downgrades
// 'real', and 'real' (or no row — prod) leaves the env mode alone. Cached for a
// minute; a missing table / DB error reads as "no flag" (fail-open, so a DB
// hiccup can't block production email).
const DB_FLAG_TTL_MS = 60 * 1000;
let dbFlagCache = { value: null, at: -Infinity };
async function dbEmailMode(now = Date.now()) {
  if (now - dbFlagCache.at < DB_FLAG_TTL_MS) return dbFlagCache.value;
  let value = null;
  try {
    const pool = require('./db');
    const r = await pool.query("SELECT value FROM system_flags WHERE key = 'email_mode'");
    const v = r && r.rows && r.rows[0] && r.rows[0].value;
    value = ['real', 'redirect', 'suppress'].includes(v) ? v : null;
  } catch (err) {
    if (err && err.code !== '42P01') logger.warn({ err: { message: err.message, code: err.code } }, 'system_flags read failed — using env email mode');
  }
  dbFlagCache = { value, at: now };
  return value;
}
function _resetDbEmailModeCache() { dbFlagCache = { value: null, at: -Infinity }; }
// Tests: pin the flag (no DB read for the next minute).
function _setDbEmailModeForTest(value) { dbFlagCache = { value, at: Date.now() }; }
function effectiveEmailMode(flag) {
  if (flag === 'suppress') return 'suppress';
  if (flag === 'redirect' && emailMode === 'real') return 'redirect';
  return emailMode;
}

// RFC 2606 reserved TLD — scrubbed stage copies rewrite every address to
// ...@example.invalid. Never hand one to the provider (it would only bounce and
// hurt the sending domain's reputation).
function isReservedRecipient(to) {
  return typeof to === 'string' && /.invalid>?s*$/i.test(to.trim());
}

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
// `opts` (optional): { fromName, replyTo, clientCompanyId } — override the From
// display name (shown as "<name> via OpsFloa"; the address stays on the verified
// domain) and set a Reply-To so replies reach the sender (e.g. an invoice email
// shows the contractor's name and replies go to them, not OpsFloa).
// clientCompanyId marks a CLIENT-FACING send by that company: while the company
// is in trial it counts against the daily cap and, past it, returns
// { skipped: 'trial_daily_cap' }. Existing callers pass nothing and are unaffected.
async function sendEmail(to, subject, html, attachments, opts = {}) {
  if (!to) return { skipped: 'no_recipient' };
  // Header hygiene: a CR/LF in a subject built from user data (company / project
  // / person names) must never reach the provider as a header break.
  subject = String(subject == null ? '' : subject).replace(/[\r\n]+/g, ' ');

  // Demo/test tenant: never send real email. Suppress and flag the request
  // so the client can show a "would have sent" popup. Keyed on the acting
  // company via the request-scoped demo context (see demoMode.js).
  const store = getStore();
  if (store && store.isDemo) {
    store.emailSuppressed = true;
    logger.info({ to, subject }, 'email suppressed — demo company (no real send)');
    return { suppressed: 'demo' };
  }

  if (isReservedRecipient(to)) {
    logger.debug({ to, subject }, 'email skipped — reserved .invalid recipient');
    return { skipped: 'reserved_recipient' };
  }

  const mode = effectiveEmailMode(await dbEmailMode());
  if (mode === 'suppress') {
    logger.debug({ to, subject }, 'email suppressed (email mode)');
    return { suppressed: 'dev' };
  }

  // Short-circuit if this recipient is already known-bad from the provider's
  // bounce webhook. Prevents re-sending to invalid addresses.
  if (await isSuppressed(to)) {
    logger.debug({ to, subject }, 'email skipped — recipient previously bounced');
    return { skipped: 'bounced' };
  }

  if (opts.clientCompanyId != null && await trialClientEmailCapExceeded(opts.clientCompanyId)) {
    logger.warn({ to, companyId: opts.clientCompanyId }, 'client email skipped — trial daily cap reached');
    return { skipped: 'trial_daily_cap' };
  }

  // No key configured — treat as a soft no-op (same as the old behaviour) so
  // callers that gate on delivery don't hard-fail an unconfigured environment.
  if (!resend) {
    logger.warn({ to, subject }, 'email not sent — RESEND_API_KEY not set');
    return { skipped: 'no_api_key' };
  }

  const resendAttachments = toResendAttachments(attachments);
  const from = fromHeader(opts.fromName);
  const replyTo = opts.replyTo || undefined;

  if (mode === 'redirect') {
    const env = process.env.NODE_ENV || 'development';
    logger.debug({ to, subject, env }, 'email redirect (dev)');
    const msg = {
      from,
      to: REDIRECT_TO,
      subject: `[${env.toUpperCase()} → ${to}] ${subject}`,
      html: `
        <div style="background:#fef3c7;border:2px solid #f59e0b;border-radius:8px;padding:16px 20px;margin-bottom:24px;font-family:system-ui,sans-serif">
          <strong style="color:#92400e">Non-production email intercept</strong><br>
          <span style="color:#78350f;font-size:13px">
            Environment: <strong>${escapeHtml(env)}</strong><br>
            Would have sent to: <strong>${escapeHtml(to)}</strong><br>
            Subject: <strong>${escapeHtml(subject)}</strong>
          </span>
        </div>
        ${html}`,
    };
    if (resendAttachments) msg.attachments = resendAttachments;
    if (replyTo) msg.replyTo = replyTo;
    return deliver(msg);
  }

  // emailMode === 'real'
  const msg = { from, to, subject, html };
  if (resendAttachments) msg.attachments = resendAttachments;
  if (replyTo) msg.replyTo = replyTo;
  return deliver(msg);
}

module.exports = { sendEmail, fromHeader, trialClientEmailCapExceeded, trialClientEmailDailyCap, dbEmailMode, _resetDbEmailModeCache, _setDbEmailModeForTest };
