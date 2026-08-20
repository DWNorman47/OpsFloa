/**
 * Client-submitted service requests.
 *
 * Two surfaces:
 *   - Public intake: POST /api/public/service-requests/:slug
 *     Unauthenticated. Rate-limited per IP (5/hour). Honeypot field
 *     rejects bots. Optional Google reCAPTCHA placeholder (not yet wired).
 *   - Admin management: list, update status, convert to project.
 *
 * The admin surface lives here; the public route is mounted separately in
 * index.js with no auth.
 */

const router = require('express').Router();
const publicRouter = require('express').Router();
const rateLimit = require('express-rate-limit');
const { userOrIpKey } = require('../middleware/rateLimitKey');
const pool = require('../db');
const logger = require('../logger');
const { requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../auditLog');
const { createInboxItemBatch } = require('./inbox');
const { sendEmail } = require('../email');
const { getAdvancedSettings } = require('./admin');
const { SERVICE_REQUEST_STATUSES: VALID_STATUSES } = require('../constants/serviceRequestEnums');

// Resolve the active (default ∖ suppressed ∪ custom) category list for a company
async function loadActiveCategories(companyId) {
  const all = await getAdvancedSettings(companyId);
  const cfg = all.service_request_categories;
  return [
    ...cfg.defaults.filter(c => !cfg.suppressed.includes(c)),
    ...cfg.custom,
  ];
}

// ────────────────────────────────────────────────────────────────────────────
// Public intake (unauthenticated)
// ────────────────────────────────────────────────────────────────────────────

const publicSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  keyGenerator: userOrIpKey,
  message: { error: 'Too many submissions. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /api/public/service-requests/:slug — returns company name + accepts flag
// so the form page can render a proper header and warn if submissions are off.
publicRouter.get('/:slug', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.accepts_service_requests,
              NOT EXISTS (
                SELECT 1 FROM settings se
                 WHERE se.company_id = c.id AND se.key = 'feature_public' AND se.value = '0'
              ) AS feature_public_enabled,
              EXISTS (
                SELECT 1
                  FROM company_public_profiles p
                 WHERE p.company_id = c.id
                   AND p.is_public = true
              ) AS has_public_profile
         FROM companies c
        WHERE c.slug = $1 AND c.active = true`,
      [req.params.slug]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Company not found' });
    const categories = await loadActiveCategories(rows[0].id);
    // feature_public is the master switch for the public-facing surfaces; when
    // it's off, neither request intake nor the public profile is exposed.
    const featurePublic = !!rows[0].feature_public_enabled;
    res.json({
      company_name: rows[0].name,
      accepting: featurePublic && !!rows[0].accepts_service_requests,
      has_public_profile: featurePublic && !!rows[0].has_public_profile,
      categories,
    });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

publicRouter.post('/:slug', publicSubmitLimiter, async (req, res) => {
  try {
    const {
      requester_name, requester_email, requester_phone, requester_address,
      category, description,
      website,      // honeypot — should always be empty from a real user
    } = req.body;

    // Honeypot: bots tend to fill every field; real forms hide this one via CSS.
    // Silently succeed so we don't teach bots what's wrong; don't save the row.
    if (website && String(website).length > 0) {
      logger.warn({ ip: req.ip, slug: req.params.slug }, 'service_request.honeypot_triggered');
      return res.json({ ok: true });
    }

    const name = String(requester_name || '').trim();
    const desc = String(description || '').trim();
    if (!name || name.length > 200) return res.status(400).json({ error: 'Name is required (max 200 chars)' });
    if (!desc || desc.length > 5000) return res.status(400).json({ error: 'Description is required (max 5000 chars)' });

    const companyRes = await pool.query(
      `SELECT c.id, c.name, c.accepts_service_requests,
              NOT EXISTS (
                SELECT 1 FROM settings se
                 WHERE se.company_id = c.id AND se.key = 'feature_public' AND se.value = '0'
              ) AS feature_public_enabled
         FROM companies c
        WHERE c.slug = $1 AND c.active = true`,
      [req.params.slug]
    );
    if (companyRes.rows.length === 0) return res.status(404).json({ error: 'Company not found' });
    const company = companyRes.rows[0];
    if (!company.feature_public_enabled || !company.accepts_service_requests) {
      return res.status(403).json({ error: 'This company is not accepting requests right now.' });
    }

    // Validate category against the company's active list.
    const activeCats = await loadActiveCategories(company.id);
    const catRaw = String(category || '').trim();
    const cat = activeCats.find(c => c.toLowerCase() === catRaw.toLowerCase()) || activeCats[0] || 'Other';

    const email = String(requester_email || '').trim().slice(0, 200) || null;
    const phone = String(requester_phone || '').trim().slice(0, 40) || null;
    const address = String(requester_address || '').trim().slice(0, 500) || null;
    const ip = (req.ip || req.headers['x-forwarded-for'] || '').toString().slice(0, 45);

    const { rows } = await pool.query(
      `INSERT INTO service_requests
         (company_id, requester_name, requester_email, requester_phone, requester_address, category, description, submitter_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, created_at`,
      [company.id, name, email, phone, address, cat, desc, ip]
    );
    const requestId = rows[0].id;

    // Notify admins — Inbox + email (best-effort; don't block the response).
    notifyAdminsOfNewRequest(company.id, company.name, requestId, name, cat).catch(err => {
      logger.warn({ err: err.message, request_id: requestId }, 'service_request.notify_failed');
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

async function notifyAdminsOfNewRequest(companyId, companyName, requestId, requesterName, category) {
  const admins = await pool.query(
    `SELECT id, email, full_name, language FROM users
      WHERE company_id = $1 AND role IN ('admin', 'super_admin') AND active = true
        AND notify_service_requests = true`,
    [companyId]
  );
  if (admins.rows.length === 0) return;

  // Category is now a free-form label (admin-configurable); use it verbatim.
  const catLabel = category || 'Request';

  // Inbox
  createInboxItemBatch(
    admins.rows.map(a => a.id),
    companyId,
    'service_request',
    `📥 ${catLabel}: ${requesterName}`,
    `A client submitted a new request. Review it in Administration → Requests.`,
    '/administration#requests',
  );

  // Email
  for (const a of admins.rows) {
    if (!a.email) continue;
    try {
      await sendEmail(
        a.email,
        `New client request — ${requesterName}`,
        `<p>A client submitted a new request to ${escapeHtml(String(companyName ?? ''))} via OpsFloa.</p>
         <p><strong>From:</strong> ${escapeHtml(requesterName)}</p>
         <p><strong>Type:</strong> ${catLabel}</p>
         <p>Review it in your <a href="${process.env.APP_URL || 'https://app.opsfloa.com'}/administration#requests">Administration → Requests</a> tab.</p>`
      );
    } catch (e) { /* best-effort */ }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ────────────────────────────────────────────────────────────────────────────
// Admin management
// ────────────────────────────────────────────────────────────────────────────

// GET /api/admin/service-requests?status=new|in_review|converted|declined|spam|all
router.get('/', requireAdmin, async (req, res) => {
  const { status } = req.query;
  const params = [req.user.company_id];
  let whereClause = 'r.company_id = $1';
  if (status && status !== 'all') {
    if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    params.push(status);
    whereClause += ` AND r.status = $${params.length}`;
  }
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.requester_name, r.requester_email, r.requester_phone, r.requester_address,
              r.category, r.description, r.status, r.admin_notes, r.created_at, r.updated_at,
              r.converted_project_id, r.converted_work_order_id, r.reviewed_at,
              u.full_name AS reviewed_by_name,
              p.name AS converted_project_name,
              wo.title AS converted_work_order_title
         FROM service_requests r
         LEFT JOIN users u    ON r.reviewed_by = u.id
         LEFT JOIN projects p ON r.converted_project_id = p.id
         LEFT JOIN work_orders wo ON r.converted_work_order_id = wo.id
        WHERE ${whereClause}
        ORDER BY r.created_at DESC
        LIMIT 500`,
      params
    );
    res.json({ requests: rows });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/admin/service-requests/settings — enable/disable public intake.
// Declared BEFORE the :id route so Express doesn't treat 'settings' as an id.
router.patch('/settings', requireAdmin, async (req, res) => {
  const { accepts_service_requests } = req.body;
  if (typeof accepts_service_requests !== 'boolean') return res.status(400).json({ error: 'accepts_service_requests (boolean) required' });
  try {
    await pool.query('UPDATE companies SET accepts_service_requests = $1 WHERE id = $2', [accepts_service_requests, req.user.company_id]);
    await logAudit(req.user.company_id, req.user.id, req.user.full_name, `service_requests.${accepts_service_requests ? 'enabled' : 'disabled'}`, null, null, null);
    res.json({ accepts_service_requests });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/admin/service-requests/recipients — list of admin users with their notify flags
router.get('/recipients', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, full_name, username, email, notify_service_requests
         FROM users
        WHERE company_id = $1 AND role IN ('admin', 'super_admin') AND active = true
        ORDER BY full_name`,
      [req.user.company_id]
    );
    res.json({ recipients: rows });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/admin/service-requests/recipients/:userId { notify } — toggle one admin's flag
router.patch('/recipients/:userId', requireAdmin, async (req, res) => {
  const { notify } = req.body;
  if (typeof notify !== 'boolean') return res.status(400).json({ error: 'notify (boolean) required' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE users SET notify_service_requests = $1
        WHERE id = $2 AND company_id = $3 AND role IN ('admin', 'super_admin')`,
      [notify, req.params.userId, req.user.company_id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Admin not found' });
    await logAudit(req.user.company_id, req.user.id, req.user.full_name, `service_request.notify_${notify ? 'on' : 'off'}`, 'user', req.params.userId, null);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/service-requests/client-portal-interest — flag "notify me when Pro ready"
router.post('/client-portal-interest', requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE companies SET client_portal_pro_interest = true WHERE id = $1', [req.user.company_id]);
    await logAudit(req.user.company_id, req.user.id, req.user.full_name, 'client_portal_pro.interest_registered', null, null, null);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/admin/service-requests/:id — update status and/or admin_notes
router.patch('/:id', requireAdmin, async (req, res) => {
  const { status, admin_notes } = req.body;
  const fields = [];
  const values = [];
  let idx = 1;

  if (status !== undefined) {
    if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    fields.push(`status = $${idx++}`); values.push(status);
    fields.push(`reviewed_by = $${idx++}`); values.push(req.user.id);
    fields.push(`reviewed_at = NOW()`);
  }
  if (admin_notes !== undefined) {
    const notes = String(admin_notes).slice(0, 5000) || null;
    fields.push(`admin_notes = $${idx++}`); values.push(notes);
  }
  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

  fields.push(`updated_at = NOW()`);
  values.push(req.params.id);
  values.push(req.user.company_id);

  try {
    const { rows, rowCount } = await pool.query(
      `UPDATE service_requests SET ${fields.join(', ')}
        WHERE id = $${idx++} AND company_id = $${idx}
        RETURNING id, status, admin_notes, reviewed_at`,
      values
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Request not found' });
    await logAudit(req.user.company_id, req.user.id, req.user.full_name, 'service_request.updated', 'service_request', rows[0].id, null, { status: rows[0].status });
    res.json(rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/service-requests/:id/convert — create a Project from the request
router.post('/:id/convert', requireAdmin, async (req, res) => {
  const { project_name, address, start_date } = req.body;
  try {
    // Pull the request to validate ownership + reuse address if not overridden
    const reqRow = await pool.query(
      'SELECT * FROM service_requests WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );
    if (reqRow.rowCount === 0) return res.status(404).json({ error: 'Request not found' });
    const r = reqRow.rows[0];
    if (r.status === 'converted') return res.status(400).json({ error: 'Already converted' });

    const name = String(project_name || '').trim() || `Request from ${r.requester_name}`;
    const addr = String(address || '').trim() || r.requester_address || null;
    const sd = start_date && /^\d{4}-\d{2}-\d{2}$/.test(start_date) ? start_date : null;

    // Status must match the project-status enum used by the rest of the app
    // (see admin.js VALID_STATUSES). 'in_progress' is the right default for
    // a freshly converted request — the work was just accepted, treat it as
    // active. Using 'active' here was a bug — admins couldn't save edits on
    // these projects because the status didn't match the dropdown options.
    const proj = await pool.query(
      `INSERT INTO projects (company_id, name, address, start_date, status, description)
       VALUES ($1, $2, $3, $4, 'in_progress', $5)
       RETURNING id, name`,
      [req.user.company_id, name.slice(0, 200), addr, sd, `Converted from client request #${r.id}:\n\n${r.description}`]
    );

    await pool.query(
      `UPDATE service_requests
          SET status = 'converted',
              converted_project_id = $1,
              reviewed_by = $2,
              reviewed_at = NOW(),
              updated_at = NOW()
        WHERE id = $3`,
      [proj.rows[0].id, req.user.id, r.id]
    );

    await logAudit(req.user.company_id, req.user.id, req.user.full_name, 'service_request.converted', 'service_request', r.id, proj.rows[0].name, { project_id: proj.rows[0].id });
    res.json({ project_id: proj.rows[0].id, project_name: proj.rows[0].name });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/admin/service-requests/:id/convert-work-order — create a Work Order
// (a service call) from the request, instead of a full Project.
router.post('/:id/convert-work-order', requireAdmin, async (req, res) => {
  const { title, address } = req.body;
  try {
    const reqRow = await pool.query(
      'SELECT * FROM service_requests WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );
    if (reqRow.rowCount === 0) return res.status(404).json({ error: 'Request not found' });
    const r = reqRow.rows[0];
    if (r.status === 'converted') return res.status(400).json({ error: 'Already converted' });

    const woTitle = String(title || '').trim() || `Service call — ${r.requester_name}`;
    const addr = String(address || '').trim() || r.requester_address || null;

    const wo = await pool.query(
      `INSERT INTO work_orders (company_id, client_id, title, address, status, description, created_by)
       VALUES ($1, $2, $3, $4, 'open', $5, $6)
       RETURNING id, title`,
      [req.user.company_id, r.client_id || null, woTitle.slice(0, 255), addr,
        `From client request #${r.id}:\n\n${r.description}`, req.user.id]
    );

    await pool.query(
      `UPDATE service_requests
          SET status = 'converted',
              converted_work_order_id = $1,
              reviewed_by = $2,
              reviewed_at = NOW(),
              updated_at = NOW()
        WHERE id = $3`,
      [wo.rows[0].id, req.user.id, r.id]
    );

    await logAudit(req.user.company_id, req.user.id, req.user.full_name, 'service_request.converted_work_order', 'service_request', r.id, wo.rows[0].title, { work_order_id: wo.rows[0].id });
    res.json({ work_order_id: wo.rows[0].id, work_order_title: wo.rows[0].title });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.publicRouter = publicRouter;
