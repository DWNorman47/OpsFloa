const router = require('express').Router();
const bcrypt = require('bcryptjs');
const logger = require('../logger');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const { sendEmail } = require('../email');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { userOrIpKey } = require('../middleware/rateLimitKey');
const pool = require('../db');
const { recordInitialRate } = require('../utils/rateHistoryStore');
const { requireAuth, COMPANY_INACTIVE } = require('../middleware/auth');
const { seedBuiltinRoles, getUserPermissions } = require('../permissions');
const { effectiveSubscriptionStatus } = require('../utils/subscription');
const { escapeHtml } = require('../utils/htmlEscape');
const { getAppUrl } = require('../utils/appUrl');
const { encrypt: encryptSecret, decrypt: decryptSecret, mfaEncryptionAvailable } = require('../utils/secretBox');
const { LEGAL_VERSION } = require('../constants/legal');

// Hash a token for safe storage — raw token goes in the email, hash goes in the DB
const sha256 = str => crypto.createHash('sha256').update(str).digest('hex');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = email => EMAIL_RE.test(String(email).trim());

// A throwaway (but structurally valid) cost-10 bcrypt hash used to equalize
// login timing: when the company or username doesn't exist we still spend a
// comparable amount of CPU on a bcrypt.compare so response time can't be
// used to enumerate valid accounts. Hardcoded (not hashSync at load) so the
// cost stays fixed and module load has no side effects.
const DUMMY_PASSWORD_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15,
  keyGenerator: userOrIpKey,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyGenerator: userOrIpKey,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Second-factor brute force: besides the per-IP loginLimiter, bucket /mfa/confirm
// by the USER the challenge token was issued to, so rotating IPs doesn't buy an
// attacker (who already has the password) more guesses at the 6-digit code. The
// token is VERIFIED (same secret as the route) before its id picks the bucket —
// with a bare jwt.decode anyone could forge {id: victim} and exhaust the
// victim's bucket, locking them out of MFA login. Invalid token → IP bucket.
const mfaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => {
    try {
      const d = jwt.verify(req.body && req.body.mfa_token, process.env.JWT_SECRET);
      if (d && d.mfa_pending && d.id != null) return `mfa:${d.id}`;
    } catch { /* forged / expired / missing → fall through to IP */ }
    return userOrIpKey(req);
  },
  message: { error: 'Too many attempts. Please sign in again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Per-user second-factor lock: this many consecutive wrong TOTP codes locks the
// second factor for MFA_LOCK_MINUTES (users.mfa_failed_attempts / mfa_locked_until,
// migration 0212). Reset by a correct code, and — so one lockout doesn't turn
// every later single typo into a fresh lock — also once an expired lock is seen:
// the next wrong code after the lock lapses starts a new count from zero.
const MFA_MAX_FAILURES = 5;
const MFA_LOCK_MINUTES = 15;
const TOTP_STEP_SECONDS = 30;

// Verify a TOTP code and return the 30-second time-step it matched, or null.
// Refuses a step at or before `lastUsedStep` — a code that was already accepted
// (observed over a shoulder / in a log) can't be replayed inside its window.
function verifyTotpStep(secret, code, lastUsedStep) {
  const token = String(code == null ? '' : code).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(token)) return null;
  const match = speakeasy.totp.verifyDelta({ secret, encoding: 'base32', token, window: 1 });
  if (!match) return null;
  const step = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS) + match.delta;
  if (lastUsedStep != null && step <= Number(lastUsedStep)) return null;
  return step;
}

// Trial-abuse limits beyond the per-IP one. Corporate domains are limited per
// domain; free-mail domains (anyone can mint addresses there) only per exact
// address — "+tag" sub-addressing (and Gmail dots) folded away so they can't be
// used to multiply trials.
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'rocketmail.com', 'yahoo.co.uk', 'yahoo.ca',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'hotmail.co.uk', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'gmx.de', 'mail.com', 'zoho.com',
  'yandex.com', 'yandex.ru', 'mail.ru', 'fastmail.com', 'tutanota.com', 'hey.com',
  'comcast.net', 'att.net', 'sbcglobal.net', 'verizon.net', 'bellsouth.net', 'cox.net', 'charter.net', 'earthlink.net',
]);
function normalizeTrialEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return { address: e, domain: '' };
  const domain = e.slice(at + 1);
  let local = e.slice(0, at).replace(/\+.*$/, '');
  if (domain === 'gmail.com' || domain === 'googlemail.com') local = local.replace(/\./g, '');
  return { address: `${local}@${domain}`, domain };
}

// The send call sites below use a legacy { to, subject, html } object shape and
// rely on a throw to signal failure (registration rolls the account back if the
// confirmation email can't be sent). Forward to the central sendEmail() and
// re-throw on provider failure so that contract is preserved.
const sgMail = {
  send: async ({ to, subject, html }) => {
    const r = await sendEmail(to, subject, html);
    if (r && r.ok === false) { const e = new Error('email send failed'); e.emailFailed = true; throw e; }
    return r;
  },
};

const { validatePassword } = require('../passwordPolicy');

// Token lifetime = the idle window: a session dies this long after the LAST slide
// (see POST /auth/refresh). Default 1 day.
// Absolute cap: even a continuously-active session must re-login after this many days
// (measured from the original login via the `lgn` claim), regardless of refreshes.
const SESSION_MAX_DAYS = parseInt(process.env.SESSION_MAX_DAYS, 10) || 7;

function signToken(user, lgn) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      full_name: user.full_name,
      invoice_name: user.invoice_name || null,
      language: user.language,
      company_id: user.company_id,
      company_name: user.company_name,
      admin_permissions: user.admin_permissions || null,
      worker_access_ids: user.worker_access_ids || null,
      role_id: user.role_id ?? null,
      // tv (token version) lets us invalidate every outstanding token for
      // this user by bumping users.token_version. See middleware/auth.js.
      tv: user.token_version ?? 0,
      // lgn = original login time (epoch seconds). Preserved across /auth/refresh so the
      // absolute cap is measured from the real login, not from each slide. Fresh login
      // omits it → defaults to now.
      lgn: lgn ?? Math.floor(Date.now() / 1000),
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '1d' }
  );
}

async function buildSessionUser(baseUser) {
  const [companyRes, userRes] = await Promise.all([
    pool.query(
      `SELECT name, plan, subscription_status, addon_qbo, addon_certified_payroll, addon_advanced_payroll, addon_takeoff, addon_planroom, addon_storm, addon_roof,
              trial_ends_at, slug, accepts_service_requests, client_portal_pro_interest
       FROM companies WHERE id = $1`,
      [baseUser.company_id]
    ),
    pool.query(
      `SELECT mfa_enabled, language, admin_permissions, worker_access_ids, role_id,
              hourly_rate, rate_type, day_mark_mode, guaranteed_weekly_hours
       FROM users WHERE id = $1`,
      [baseUser.id]
    ),
  ]);
  const company = companyRes.rows[0] || {};
  const userRow = userRes.rows[0] || {};
  const permissions = await getUserPermissions({
    ...baseUser,
    role_id: userRow.role_id ?? null,
    admin_permissions: userRow.admin_permissions ?? null,
  });

  // Does this user still owe acceptance of the CURRENT legal docs? Super-admins
  // (platform operators) are exempt. Wrapped so a missing table / query error
  // NEVER blocks login — if we can't tell, we don't gate.
  let needsTerms = false;
  if (baseUser.role !== 'super_admin') {
    try {
      const acc = await pool.query(
        'SELECT 1 FROM legal_acceptances WHERE user_id = $1 AND version = $2 LIMIT 1',
        [baseUser.id, LEGAL_VERSION]
      );
      needsTerms = acc.rowCount === 0;
    } catch { needsTerms = false; }
  }

  return {
    id: baseUser.id,
    username: baseUser.username,
    role: baseUser.role,
    full_name: baseUser.full_name,
    invoice_name: baseUser.invoice_name || null,
    language: userRow.language || baseUser.language,
    company_id: baseUser.company_id,
    company_name: company.name || baseUser.company_name,
    plan: company.plan || 'free',
    subscription_status: effectiveSubscriptionStatus(company),
    addon_qbo: company.addon_qbo || false,
    addon_certified_payroll: company.addon_certified_payroll || false,
    addon_advanced_payroll: company.addon_advanced_payroll || false,
    addon_takeoff: company.addon_takeoff || false,
    addon_planroom: company.addon_planroom || false,
    addon_storm: company.addon_storm || false,
    addon_roof: company.addon_roof || false,
    company_slug: company.slug || null,
    accepts_service_requests: !!company.accepts_service_requests,
    client_portal_pro_interest: !!company.client_portal_pro_interest,
    trial_ends_at: company.trial_ends_at,
    mfa_enabled: userRow.mfa_enabled || false,
    admin_permissions: userRow.admin_permissions || null,
    worker_access_ids: userRow.worker_access_ids || null,
    role_id: userRow.role_id ?? null,
    permissions: [...permissions],
    hourly_rate: userRow.hourly_rate != null ? parseFloat(userRow.hourly_rate) : null,
    rate_type: userRow.rate_type || 'hourly',
    day_mark_mode: !!userRow.day_mark_mode,
    guaranteed_weekly_hours: userRow.guaranteed_weekly_hours != null ? parseFloat(userRow.guaranteed_weekly_hours) : null,
    needs_terms: needsTerms,
  };
}

// Login
router.post('/login', loginLimiter, async (req, res) => {
  const { password } = req.body;
  const username = req.body.username?.trim();
  const company_name = req.body.company_name?.trim();
  if (!username || !password || !company_name) {
    return res.status(400).json({ error: 'Company name, username, and password required' });
  }
  // Use req.ip (Express resolves it from the trusted proxy chain — see
  // `trust proxy` in index.js) rather than the raw X-Forwarded-For header,
  // which a client can spoof to poison the failure log / abuse tracking.
  const ip = req.ip;
  const logFailure = (reason) => pool.query(
    'INSERT INTO login_failures (attempted_company, attempted_username, failure_reason, ip) VALUES ($1, $2, $3, $4)',
    [company_name, username, reason, ip]
  ).catch(err => logger.error({ err }, 'Failed to log login failure'));
  try {
    // Step 1: check company name
    const companyRes = await pool.query(
      'SELECT id, active FROM companies WHERE LOWER(name) = LOWER($1)', [company_name]
    );
    if (!companyRes.rows[0]) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH); // equalize timing
      await logFailure('company_not_found');
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const companyId = companyRes.rows[0].id;
    const companyActive = companyRes.rows[0].active !== false;

    // Step 2: check username (or email) within that company. Accepting email
    // matches what users instinctively try — most SaaS apps use email as the
    // login identifier — and avoids tickets like "I can't log in".
    const userRes = await pool.query(
      `SELECT u.*, $2::text as company_name FROM users u
        WHERE (LOWER(u.username) = LOWER($1) OR LOWER(u.email) = LOWER($1))
          AND u.company_id = $3 AND u.active = true
        LIMIT 1`,
      [username, company_name, companyId]
    );
    const user = userRes.rows[0];

    // Lockout is enforced before the password is checked, but answered with the
    // SAME generic 401 as a wrong password / unknown user: a distinct 423 "account
    // locked" only ever fired for real accounts, so it confirmed the username
    // existed. Equalize timing like the miss paths.
    if (user && user.locked_until && new Date(user.locked_until) > new Date()) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
      await logFailure('locked');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH); // equalize timing
      await logFailure('user_not_found');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      await logFailure('wrong_password');
      // Increment failed attempts and lock if threshold reached
      const newCount = (user.failed_login_attempts || 0) + 1;
      if (newCount >= 10) {
        // 15-minute lockout (was 24h). Combined with the per-IP login
        // limiter this still stops online brute-force, but bounds the
        // denial-of-service window if an attacker deliberately locks a
        // known account by guessing wrong passwords.
        await pool.query(
          'UPDATE users SET failed_login_attempts = $1, locked_until = NOW() + INTERVAL \'15 minutes\' WHERE id = $2',
          [newCount, user.id]
        );
      } else {
        await pool.query('UPDATE users SET failed_login_attempts = $1 WHERE id = $2', [newCount, user.id]);
      }
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // A deactivated company locks every one of its users out (requireAuth also
    // refuses their existing sessions). Only revealed after a correct password.
    if (!companyActive) {
      await logFailure('company_inactive');
      return res.status(403).json(COMPANY_INACTIVE);
    }

    // Reset failed attempts on a successful password match — unless a second
    // factor is still owed: then the reset waits for /mfa/confirm to succeed, so
    // "right password, wrong/no code" doesn't wipe the brute-force counter.
    if (!user.mfa_enabled) {
      await pool.query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);
    }

    // Track first login for welcome modal
    let isFirstLogin = false;
    try {
      isFirstLogin = !user.welcomed_at;
      if (isFirstLogin) {
        await pool.query('UPDATE users SET welcomed_at = NOW() WHERE id = $1', [user.id]);
      }
    } catch {
      // welcomed_at column may not exist yet — login proceeds normally
    }

    if (!user.email_confirmed) {
      return res.status(403).json({ error: 'email_not_confirmed', email: user.email });
    }
    // If worker must change their temporary password, issue a short-lived setup token
    if (user.must_change_password) {
      const setupToken = jwt.sign({ id: user.id, setup_pending: true }, process.env.JWT_SECRET, { expiresIn: '15m' });
      return res.json({ must_change_password: true, setup_token: setupToken });
    }
    // If MFA is enabled, issue a short-lived MFA token instead of the full JWT
    if (user.mfa_enabled) {
      const mfaToken = jwt.sign({ id: user.id, mfa_pending: true }, process.env.JWT_SECRET, { expiresIn: '5m' });
      return res.json({ mfa_required: true, mfa_token: mfaToken });
    }
    const token = signToken(user);
    res.json({ token, first_login: isFirstLogin, user: await buildSessionUser(user) });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Get current user — includes live company billing info for client-side plan gating
router.get('/me', requireAuth, async (req, res) => {
  try {
    return res.json({ user: await buildSessionUser(req.user) });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Slide the session: re-issue a token with a fresh idle window so an actively-used app
// never gets bounced to login mid-day. requireAuth already re-validated the token live
// (unexpired + token_version + not deactivated), so a revoked/fired user can't refresh.
// Two guards keep it honest:
//   - impersonation / special-purpose tokens (no tv) can't slide — they must stay short.
//   - the absolute cap: past SESSION_MAX_DAYS since the original login, refresh is denied
//     so even a constantly-active worker re-authenticates (401 → the client goes to login).
router.post('/refresh', requireAuth, (req, res) => {
  const p = req.user;
  if (p.tv == null) return res.status(400).json({ error: 'This session cannot be extended' });
  const nowSec = Math.floor(Date.now() / 1000);
  const lgn = p.lgn ?? p.iat ?? nowSec; // legacy tokens: fall back to issued-at
  if (nowSec - lgn >= SESSION_MAX_DAYS * 86400) {
    return res.status(401).json({ error: 'Session expired, please log in again', code: 'session_max' });
  }
  const token = signToken({
    id: p.id, username: p.username, role: p.role, full_name: p.full_name,
    invoice_name: p.invoice_name, language: p.language, company_id: p.company_id,
    company_name: p.company_name, admin_permissions: p.admin_permissions,
    worker_access_ids: p.worker_access_ids, role_id: p.role_id, token_version: p.tv,
  }, lgn);
  res.json({ token });
});

// Record acceptance of the CURRENT legal docs for the logged-in user (the
// re-prompt gate for existing users + invited workers). Idempotent enough — a
// duplicate row for the same version is harmless; the audit trail keeps both.
router.post('/accept-terms', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO legal_acceptances (user_id, company_id, version, context, ip) VALUES ($1, $2, $3, 'login', $4)`,
      [req.user.id, req.user.company_id, LEGAL_VERSION, req.ip || 'unknown']
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'accept-terms error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Register — creates a new company and its first admin user
router.post('/register', authLimiter, async (req, res) => {
  const { password, timezone } = req.body;
  const company_name = req.body.company_name?.trim();
  const full_name = req.body.full_name?.trim();
  const first_name = req.body.first_name?.trim() || null;
  const middle_name = req.body.middle_name?.trim() || null;
  const last_name = req.body.last_name?.trim() || null;
  const username = req.body.username?.trim();
  const email = req.body.email?.trim();
  if (!company_name || !full_name || !username || !password || !email) {
    return res.status(400).json({ error: 'company_name, full_name, email, username, and password are required' });
  }
  if (company_name.length > 100) return res.status(400).json({ error: 'Company name must be 100 characters or fewer' });
  if (full_name.length > 100) return res.status(400).json({ error: 'Full name must be 100 characters or fewer' });
  if (username.length > 50) return res.status(400).json({ error: 'Username must be 50 characters or fewer' });
  const pwErr = validatePassword(password, username);
  if (pwErr) return res.status(400).json({ error: pwErr });
  // Clickwrap: the account owner must affirmatively accept the Terms + Privacy
  // Policy. Enforced here (not just the UI checkbox) and recorded below.
  if (req.body.accepted_terms !== true) {
    return res.status(400).json({ error: 'You must accept the Terms of Use and Privacy Policy to create an account.' });
  }

  // Capture real client IP (req.ip respects trust proxy setting)
  const registrationIp = req.ip || 'unknown';
  // IPv6: one subscriber usually holds a whole /56 (or more), so counting the
  // exact address let a user mint a new trial per address. Compare at /56 — the
  // same normalization the rate limiters use (express-rate-limit ipKeyGenerator).
  const ipIsV6 = registrationIp.includes(':') && !/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(registrationIp);
  const registrationSubnet = ipIsV6 ? ipKeyGenerator(registrationIp) : registrationIp;

  // Owner/dev IPs bypass all trial-limit checks
  const whitelistedIps = (process.env.WHITELISTED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ipIsWhitelisted = whitelistedIps.includes(registrationIp);

  // Block IPs that have registered too many trials recently (skipped for whitelisted IPs)
  const TRIAL_LIMIT = parseInt(process.env.TRIAL_LIMIT_PER_IP) || 5;
  if (!ipIsWhitelisted) {
    const ipQuery = await pool.query(
      ipIsV6
        ? `SELECT COUNT(*), array_agg(name ORDER BY created_at) as company_names
             FROM companies
            WHERE created_at > NOW() - INTERVAL '30 days'
              AND CASE WHEN registration_ip LIKE '%:%' AND registration_ip ~ '^[0-9A-Fa-f:.]+$'
                       THEN registration_ip::inet <<= $1::cidr ELSE false END`
        : `SELECT COUNT(*), array_agg(name ORDER BY created_at) as company_names
           FROM companies WHERE registration_ip = $1 AND created_at > NOW() - INTERVAL '30 days'`,
      [registrationSubnet]
    );
    const priorCount = parseInt(ipQuery.rows[0].count);
    if (priorCount >= TRIAL_LIMIT) {
      return res.status(429).json({ error: 'This IP address has been flagged for suspicious activity. Further registration attempts from this network are being logged and reviewed by our trust and safety team.' });
    }
    // Alert on second registration from same IP (priorCount >= 1 means this is #2+)
    if (priorCount >= 1) {
      const priorNames = ipQuery.rows[0].company_names || [];
      sgMail.send({
      to: 'info@opsfloa.com',
      subject: `⚠️ Multiple trial registrations from IP ${registrationIp}`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
          <h2 style="color:#dc2626;margin-bottom:8px">Multiple trial registrations</h2>
          <p style="color:#444">A new company is being registered from an IP address that has already signed up for a trial in the last 30 days.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px">
            <tr><td style="padding:6px 0;color:#6b7280;width:140px">IP Address</td><td style="padding:6px 0;font-weight:600">${escapeHtml(registrationIp)}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280">New company</td><td style="padding:6px 0;font-weight:600">${escapeHtml(company_name)}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280">New email</td><td style="padding:6px 0">${escapeHtml(email)}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280">Prior registrations</td><td style="padding:6px 0">${escapeHtml(priorNames.join(', '))}</td></tr>
            <tr><td style="padding:6px 0;color:#6b7280">Total from this IP</td><td style="padding:6px 0">${priorCount + 1} in last 30 days</td></tr>
          </table>
          <p style="color:#9ca3af;font-size:12px">Registration was allowed (limit is ${TRIAL_LIMIT}). You'll receive another alert if they register again.</p>
        </div>
      `,
    }).catch(err => logger.error({ err }, 'Trial abuse alert email failed'));
  }

    // Per-email / per-domain trial limit (the IP limit alone is beaten by a VPN).
    // Free-mail → per exact (normalized) address; any other domain → per domain.
    const { address: normEmail, domain: emailDomain } = normalizeTrialEmail(email);
    const freeMail = FREE_MAIL_DOMAINS.has(emailDomain);
    const TRIAL_LIMIT_EMAIL = parseInt(process.env.TRIAL_LIMIT_PER_EMAIL) || 2;
    const TRIAL_LIMIT_DOMAIN = parseInt(process.env.TRIAL_LIMIT_PER_DOMAIN) || 3;
    const emailQuery = await pool.query(
      `SELECT COUNT(DISTINCT c.id) AS count
         FROM companies c JOIN users u ON u.company_id = c.id
        WHERE c.created_at > NOW() - INTERVAL '30 days' AND u.role = 'admin'
          AND ${freeMail
            ? `regexp_replace(CASE WHEN split_part(LOWER(u.email), '@', 2) IN ('gmail.com','googlemail.com')
                                   THEN replace(split_part(LOWER(u.email), '@', 1), '.', '') || '@' || split_part(LOWER(u.email), '@', 2)
                                   ELSE LOWER(u.email) END, '\\+[^@]*@', '@') = $1`
            : `split_part(LOWER(u.email), '@', 2) = $1`}`,
      [freeMail ? normEmail : emailDomain]
    );
    const emailPrior = parseInt(emailQuery.rows[0]?.count) || 0;
    if (emailPrior >= (freeMail ? TRIAL_LIMIT_EMAIL : TRIAL_LIMIT_DOMAIN)) {
      return res.status(429).json({ error: 'A trial has already been started for this email address or organization. Contact support if you need another workspace.', code: 'trial_limit' });
    }
  } // end if (!ipIsWhitelisted)

  const slug = company_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM companies WHERE lower(name) = lower($1)', [company_name]);
    if (existing.rowCount > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A company with that name already exists' });
    }
    const trialDays = parseInt(process.env.TRIAL_DAYS) || 14;
    const companyResult = await client.query(
      // Set plan explicitly to 'free' — a new trial company has no paid plan. Leaving it
      // to the column default was tripping chk_companies_plan on the live DB (a NULL/invalid
      // default), which 500'd every registration. 'free' is in the allowed set and is treated
      // identically to NULL everywhere (company.plan || 'free').
      `INSERT INTO companies (name, slug, plan, subscription_status, trial_ends_at, registration_ip)
       VALUES ($1, $2, 'free', 'trial', NOW() + ($3 || ' days')::INTERVAL, $4) RETURNING id`,
      [company_name, slug, trialDays, registrationIp]
    );
    const companyId = companyResult.rows[0].id;
    const defaults = [['prevailing_wage_rate', 45], ['default_hourly_rate', 30], ['overtime_multiplier', 1.5]];
    for (const [key, value] of defaults) {
      await client.query('INSERT INTO settings (company_id, key, value) VALUES ($1, $2, $3)', [companyId, key, value]);
    }
    // The default rate is effective-dated (rate history, 0209): record the initial one.
    await recordInitialRate('company', { companyId, rate: 30 }, client);
    if (timezone && /^[A-Za-z_]+\/[A-Za-z_\/]+$/.test(timezone)) {
      await client.query('INSERT INTO settings (company_id, key, value) VALUES ($1, $2, $3)', [companyId, 'company_timezone', timezone]);
    }
    const hash = await bcrypt.hash(password, 10);
    const confirmToken = crypto.randomBytes(32).toString('hex');
    const confirmTokenHash = sha256(confirmToken);
    const confirmExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const userResult = await client.query(
      `INSERT INTO users (company_id, username, password_hash, full_name, first_name, middle_name, last_name, role, email,
        email_confirmed, email_confirm_token, email_confirm_token_expires)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'admin',$8,false,$9,$10)
       RETURNING id, username, full_name, role, company_id, email`,
      [companyId, username, hash, full_name, first_name||null, middle_name||null, last_name||null, email, confirmTokenHash, confirmExpires]
    );
    const newUserId = userResult.rows[0].id;

    // Record the clickwrap acceptance in the same transaction, so the audit row
    // rolls back with the account if anything below fails. Stamps the live docs
    // version + the registration IP.
    await client.query(
      `INSERT INTO legal_acceptances (user_id, company_id, version, context, ip) VALUES ($1, $2, $3, 'signup', $4)`,
      [newUserId, companyId, LEGAL_VERSION, registrationIp]
    );

    // Seed Worker/Admin/Owner built-in roles for the new company and assign
    // Owner to the admin we just created. Done inside the same transaction
    // so a failure rolls back the whole company creation.
    const { ownerId } = await seedBuiltinRoles(client, companyId);
    await client.query('UPDATE users SET role_id = $1 WHERE id = $2', [ownerId, newUserId]);

    // Send confirmation email — COMMIT only after success so email failure rolls back the account
    const confirmUrl = `${getAppUrl()}/confirm-email?token=${confirmToken}`;
    await sgMail.send({
      to: email,
      subject: 'Confirm your OpsFloa email',
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
          <h2 style="color:#1a56db;margin-bottom:8px">Confirm your email</h2>
          <p style="color:#444;margin-bottom:24px">Hi ${escapeHtml(full_name)}, click below to confirm your email and activate your OpsFloa account.</p>
          <a href="${confirmUrl}" style="display:inline-block;background:#1a56db;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">Confirm email</a>
          <p style="color:#999;font-size:13px;margin-top:24px">This link expires in 24 hours.</p>
        </div>
      `,
    });

    await client.query('COMMIT');
    res.status(201).json({ pending_confirmation: true, email });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Username already taken at this company' });
    if (err.emailFailed || err.response) {
      logger.error({ err: err.response?.body || err.message }, 'Confirmation email failed — account not created');
      return res.status(500).json({ error: 'Failed to send confirmation email. Please check your email address and try again.' });
    }
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// Confirm email
router.post('/confirm-email', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  try {
    const result = await pool.query(
      'SELECT id FROM users WHERE email_confirm_token = $1 AND email_confirm_token_expires > NOW()',
      [sha256(token)]
    );
    if (result.rowCount === 0) return res.status(400).json({ error: 'Confirmation link is invalid or has expired' });
    const user = result.rows[0];
    await pool.query(
      'UPDATE users SET email_confirmed = true, email_confirm_token = NULL, email_confirm_token_expires = NULL WHERE id = $1',
      [user.id]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Complete setup — worker sets a permanent password after first login
router.post('/complete-setup', async (req, res) => {
  const { setup_token, new_password } = req.body;
  if (!setup_token || !new_password) return res.status(400).json({ error: 'setup_token and new_password required' });
  let payload;
  try {
    payload = jwt.verify(setup_token, process.env.JWT_SECRET);
  } catch {
    return res.status(400).json({ error: 'Setup session expired. Please sign in again.' });
  }
  if (!payload.setup_pending) return res.status(400).json({ error: 'Invalid setup token' });
  try {
    const userRes = await pool.query(
      `SELECT u.*, c.name as company_name, c.active AS company_active FROM users u
       JOIN companies c ON c.id = u.company_id
       WHERE u.id = $1 AND u.active = true`,
      [payload.id]
    );
    const user = userRes.rows[0];
    if (!user) return res.status(400).json({ error: 'User not found' });
    if (user.company_active === false) return res.status(403).json(COMPANY_INACTIVE);
    // Validate after fetch so we can enforce the "password can't contain
    // your username" rule that validatePassword applies when given a username.
    const pwErr = validatePassword(new_password, user.username);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const hash = await bcrypt.hash(new_password, 10);
    // Bump token_version so any previously-issued tokens for this user
    // (e.g. from before a password was forced to be changed) are rejected.
    const upd = await pool.query(
      'UPDATE users SET password_hash = $1, must_change_password = false, token_version = token_version + 1 WHERE id = $2 RETURNING token_version',
      [hash, user.id]
    );
    user.token_version = upd.rows[0].token_version;
    const token = signToken(user);
    res.json({ token, user: await buildSessionUser(user) });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Resend confirmation email
router.post('/resend-confirmation', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND email_confirmed = false AND active = true',
      [email]
    );
    if (result.rowCount === 0) return res.json({ success: true }); // don't leak whether email exists
    const user = result.rows[0];
    const confirmToken = crypto.randomBytes(32).toString('hex');
    const confirmExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      'UPDATE users SET email_confirm_token = $1, email_confirm_token_expires = $2 WHERE id = $3',
      [sha256(confirmToken), confirmExpires, user.id]
    );
    const confirmUrl = `${getAppUrl()}/confirm-email?token=${confirmToken}`;
    try {
      await sgMail.send({
        to: email,
        subject: 'Confirm your OpsFloa email',
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
            <h2 style="color:#1a56db;margin-bottom:8px">Confirm your email</h2>
            <p style="color:#444;margin-bottom:24px">Hi ${escapeHtml(user.full_name)}, here's a fresh confirmation link.</p>
            <a href="${confirmUrl}" style="display:inline-block;background:#1a56db;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">Confirm email</a>
            <p style="color:#999;font-size:13px;margin-top:24px">This link expires in 24 hours.</p>
          </div>
        `,
      });
    } catch (emailErr) {
      logger.error({ err: emailErr?.response?.body || emailErr }, 'Resend confirmation email failed');
    }
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Forgot password — sends reset email
router.post('/forgot-password', authLimiter, async (req, res) => {
  const { email, company } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (!isValidEmail(email)) return res.json({ success: true }); // silently drop — don't leak validation info
  try {
    let result;
    if (company && company.trim()) {
      result = await pool.query(
        `SELECT u.* FROM users u
         JOIN companies c ON c.id = u.company_id
         WHERE u.email = $1 AND LOWER(c.name) = LOWER($2) AND u.active = true
         LIMIT 1`,
        [email, company.trim()]
      );
    } else {
      // No company given: the same address can belong to users in several
      // tenants. Picking one arbitrarily (LIMIT 1) left the others unable to
      // reset at all — send ONE email with a separate, company-labelled reset
      // link for every account on this address.
      result = await pool.query(
        `SELECT u.*, c.name AS company_name FROM users u
           JOIN companies c ON c.id = u.company_id
          WHERE u.email = $1 AND u.active = true
          ORDER BY c.name, u.id
          LIMIT 20`,
        [email]
      );
    }
    // Always return success to avoid leaking whether the email exists
    if (result.rowCount === 0) return res.json({ success: true });

    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    const links = [];
    for (const user of result.rows) {
      const token = crypto.randomBytes(32).toString('hex');
      await pool.query(
        'UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3',
        [sha256(token), expires, user.id]
      );
      links.push({ user, url: `${getAppUrl()}/reset-password?token=${token}` });
    }

    // Respond BEFORE sending so response time is uniform whether or not the
    // address exists — an awaited SendGrid call (hundreds of ms) for real
    // users vs an instant return for misses is a user-enumeration oracle.
    res.json({ success: true });

    const button = url => `<a href="${url}" style="display:inline-block;background:#1a56db;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">Reset password</a>`;
    const body = links.length === 1
      ? `<p style="color:#444;margin-bottom:24px">Hi ${escapeHtml(links[0].user.full_name)}, click the button below to reset your password. This link expires in 1 hour.</p>
          ${button(links[0].url)}
          <p style="color:#ccc;font-size:12px;margin-top:4px">${links[0].url}</p>`
      : `<p style="color:#444;margin-bottom:16px">This email address is used by more than one OpsFloa account. Each link below resets the password for that account only, and expires in 1 hour.</p>
          ${links.map(({ user, url }) => `
          <div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin-bottom:12px">
            <p style="color:#111;margin:0 0 8px"><strong>${escapeHtml(user.company_name || '')}</strong> — ${escapeHtml(user.username || '')}</p>
            ${button(url)}
          </div>`).join('')}`;
    sgMail.send({
      to: email,
      subject: 'Reset your OpsFloa password',
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
          <h2 style="color:#1a56db;margin-bottom:8px">Reset your password</h2>
          ${body}
          <p style="color:#999;font-size:13px;margin-top:24px">If you didn't request this, you can ignore this email.</p>
        </div>
      `,
    }).catch(err => logger.error({ err }, 'reset password email send failed'));
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Reset password — validates token, sets new password
router.post('/reset-password', authLimiter, async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'token and password required' });
  try {
    const result = await pool.query(
      'SELECT id, username FROM users WHERE reset_token = $1 AND reset_token_expires > NOW()',
      [sha256(token)]
    );
    if (result.rowCount === 0) return res.status(400).json({ error: 'Reset link is invalid or has expired' });
    // Validate after fetch so the "no username in password" rule applies.
    const pwErr = validatePassword(password, result.rows[0].username);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const hash = await bcrypt.hash(password, 10);
    // Bump token_version — if an attacker had stolen a token before the
    // legitimate user reset their password, that token is now dead.
    await pool.query(
      // Proving control of the mailbox also clears the password lockout (a
      // locked-out user resetting their password shouldn't stay locked out).
      'UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL, failed_login_attempts = 0, locked_until = NULL, token_version = token_version + 1 WHERE id = $2',
      [hash, result.rows[0].id]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Accept invite — set password from invite link
router.post('/accept-invite', authLimiter, async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'token and password required' });
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.company_id, c.name as company_name FROM users u
       JOIN companies c ON c.id = u.company_id
       WHERE u.invite_token = $1 AND u.invite_token_expires > NOW() AND u.invite_pending = true`,
      [sha256(token)]
    );
    if (result.rowCount === 0) return res.status(400).json({ error: 'Invite link is invalid or has expired' });
    const user = result.rows[0];
    // Validate after fetch so the "no username in password" rule applies.
    const pwErr = validatePassword(password, user.username);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, invite_token = NULL, invite_token_expires = NULL, invite_pending = false, email_confirmed = true, must_change_password = false, token_version = token_version + 1 WHERE id = $2',
      [hash, user.id]
    );
    res.json({ success: true, username: user.username, company_name: user.company_name });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Change password
router.post('/change-password', requireAuth, authLimiter, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'current_password and new_password required' });
  }
  const pwErr = validatePassword(new_password, req.user.username);
  if (pwErr) return res.status(400).json({ error: pwErr });
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!(await bcrypt.compare(current_password, user.password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const hash = await bcrypt.hash(new_password, 10);
    // Bump token_version: every other session (other devices, stolen tokens)
    // is invalidated. Then re-issue a fresh token for the current device so
    // the user stays logged in here.
    const upd = await pool.query(
      'UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2 RETURNING token_version',
      [hash, req.user.id]
    );
    user.token_version = upd.rows[0].token_version;
    const token = signToken(user);
    res.json({ success: true, token });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// MFA: complete login after TOTP verification
router.post('/mfa/confirm', loginLimiter, mfaLimiter, async (req, res) => {
  const { mfa_token, code } = req.body;
  if (!mfa_token || !code) return res.status(400).json({ error: 'mfa_token and code required' });
  try {
    let payload;
    try {
      payload = jwt.verify(mfa_token, process.env.JWT_SECRET);
    } catch {
      return res.status(400).json({ error: 'MFA session expired. Please sign in again.' });
    }
    if (!payload.mfa_pending) return res.status(400).json({ error: 'Invalid MFA token' });

    const result = await pool.query(
      `SELECT u.*, c.name as company_name, c.active AS company_active FROM users u
       JOIN companies c ON c.id = u.company_id
       WHERE u.id = $1 AND u.active = true`,
      [payload.id]
    );
    const user = result.rows[0];
    if (!user || !user.mfa_secret) return res.status(400).json({ error: 'MFA not configured' });
    if (user.company_active === false) return res.status(403).json(COMPANY_INACTIVE);

    // Per-user lock after MFA_MAX_FAILURES wrong codes (survives new mfa_tokens /
    // new IPs — the attacker already has the password, so the IP limiter alone
    // isn't the bound that matters).
    if (user.mfa_locked_until && new Date(user.mfa_locked_until) > new Date()) {
      return res.status(429).json({ error: 'Too many incorrect codes. Please wait 15 minutes and sign in again.', code: 'mfa_locked' });
    }

    const step = verifyTotpStep(decryptSecret(user.mfa_secret), code, user.mfa_last_used_step);
    if (step == null) {
      // A lock that has lapsed ends that round: clear the counter first so this
      // wrong code counts as 1, not MAX+1 (which would relock immediately).
      if (user.mfa_locked_until) {
        await pool.query(
          'UPDATE users SET mfa_failed_attempts = 0, mfa_locked_until = NULL WHERE id = $1 AND mfa_locked_until <= NOW()',
          [user.id]
        );
      }
      await pool.query(
        `UPDATE users
            SET mfa_failed_attempts = COALESCE(mfa_failed_attempts, 0) + 1,
                mfa_locked_until = CASE WHEN COALESCE(mfa_failed_attempts, 0) + 1 >= $2
                                        THEN NOW() + ($3 || ' minutes')::INTERVAL
                                        ELSE mfa_locked_until END
          WHERE id = $1`,
        [user.id, MFA_MAX_FAILURES, String(MFA_LOCK_MINUTES)]
      );
      return res.status(401).json({ error: 'Invalid code. Try again.' });
    }

    // Accept: record the step (replay guard — the WHERE makes a concurrent replay
    // of the same code lose the race) and only NOW clear both brute-force counters.
    const accepted = await pool.query(
      `UPDATE users
          SET mfa_last_used_step = $2, mfa_failed_attempts = 0, mfa_locked_until = NULL,
              failed_login_attempts = 0, locked_until = NULL
        WHERE id = $1 AND (mfa_last_used_step IS NULL OR mfa_last_used_step < $2)`,
      [user.id, step]
    );
    if (accepted.rowCount === 0) return res.status(401).json({ error: 'Invalid code. Try again.' });

    const token = signToken(user);
    res.json({ token, user: await buildSessionUser(user) });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// MFA: generate setup QR code
// Production without MFA_ENCRYPTION_KEY: refuse to enroll rather than store a
// TOTP seed in plaintext (secretBox logs this loudly at boot too).
function mfaUnavailable(req, res) {
  if (mfaEncryptionAvailable()) return false;
  logger.error({ userId: req.user && req.user.id }, 'SECURITY: MFA enrollment refused — MFA_ENCRYPTION_KEY is not configured in production');
  res.status(503).json({ error: 'Two-factor authentication is temporarily unavailable. Please try again later.', code: 'mfa_unavailable' });
  return true;
}

router.get('/mfa/setup', requireAuth, async (req, res) => {
  if (mfaUnavailable(req, res)) return;
  try {
    const secret = speakeasy.generateSecret({ name: `OpsFloa (${req.user.username})`, length: 20 });
    await pool.query('UPDATE users SET mfa_secret_pending = $1 WHERE id = $2', [encryptSecret(secret.base32), req.user.id]);
    const qr = await qrcode.toDataURL(secret.otpauth_url);
    res.json({ qr, secret: secret.base32 });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// MFA: verify first code and enable
router.post('/mfa/enable', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  if (mfaUnavailable(req, res)) return;
  try {
    const result = await pool.query('SELECT mfa_secret_pending FROM users WHERE id = $1', [req.user.id]);
    const stored = result.rows[0]?.mfa_secret_pending;
    if (!stored) return res.status(400).json({ error: 'No pending MFA setup. Start setup again.' });
    const secret = decryptSecret(stored); // plaintext base32 for verification

    const step = verifyTotpStep(secret, code, null);
    if (step == null) return res.status(401).json({ error: 'Invalid code. Try again.' });

    // Record the enrollment code's step so it can't be replayed at /mfa/confirm.
    await pool.query(
      'UPDATE users SET mfa_secret = $1, mfa_secret_pending = NULL, mfa_enabled = true, mfa_last_used_step = $3, mfa_failed_attempts = 0, mfa_locked_until = NULL WHERE id = $2',
      [encryptSecret(secret), req.user.id, step]
    );
    res.json({ enabled: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// MFA: disable — requires the password AND a current TOTP code. Password alone
// meant a stolen session + a phished/reused password could strip the second
// factor; the code proves possession of the authenticator.
router.post('/mfa/disable', requireAuth, authLimiter, async (req, res) => {
  const { password, code } = req.body;
  if (!password) return res.status(400).json({ error: 'password required' });
  try {
    const result = await pool.query(
      'SELECT password_hash, mfa_enabled, mfa_secret, mfa_last_used_step FROM users WHERE id = $1',
      [req.user.id]
    );
    const row = result.rows[0];
    if (!row || !(await bcrypt.compare(password, row.password_hash))) {
      return res.status(401).json({ error: 'Incorrect password' });
    }
    let step = null;
    if (row.mfa_enabled && row.mfa_secret) {
      if (!code) return res.status(400).json({ error: 'Authentication code required', code: 'mfa_code_required' });
      step = verifyTotpStep(decryptSecret(row.mfa_secret), code, row.mfa_last_used_step);
      if (step == null) return res.status(401).json({ error: 'Invalid code. Try again.' });
    }
    await pool.query(
      'UPDATE users SET mfa_secret = NULL, mfa_secret_pending = NULL, mfa_enabled = false, mfa_failed_attempts = 0, mfa_locked_until = NULL, mfa_last_used_step = COALESCE($2, mfa_last_used_step) WHERE id = $1',
      [req.user.id, step]
    );
    res.json({ disabled: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Update language
router.post('/update-language', requireAuth, async (req, res) => {
  const language = req.body.language?.trim();
  if (!language) return res.status(400).json({ error: 'language required' });
  // During a super-admin "Login as" session the language switch is view-only: it
  // must not overwrite the impersonated user's saved preference. The client still
  // flips its own display off this success response — we just skip the write.
  if (req.user.imp) return res.json({ success: true, language, persisted: false });
  try {
    await pool.query('UPDATE users SET language = $1 WHERE id = $2', [language, req.user.id]);
    res.json({ success: true, language, persisted: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
