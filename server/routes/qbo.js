const router = require('express').Router();
const pool = require('../db');
const logger = require('../logger');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { requireAuth, requireAdmin, requirePerm } = require('../middleware/auth');
const qbo = require('../services/qbo');
const { encrypt } = require('../services/encryption');
const { USER_WORKER_TYPES } = require('../constants/userEnums');
const { QBO_BILL_RANGE_PAY_KINDS } = require('../constants/qboEnums');
// Every punch this file bills or syncs is the PAID punch (hours-rules rounding),
// and every labor dollar on a bill comes from the pay engine (buildPayStatement),
// so OpsFloa's own pay surfaces and QuickBooks can't disagree about the same day.
const { loadSettings, otRuleFromSettings, otThreshold, leaveRateMultipliers } = require('../utils/paidHours');
const { roundEntriesFromSettings, otConfigFromSettings, sickRulesFromSettings } = require('../utils/hoursRules');
const { entryDuration, computeLeaveHours, shiftHoursByDate } = require('../utils/payCalculations');
const { applySettingsRows, ADMIN_SETTINGS_DEFAULTS } = require('../settingsDefaults');
const { companyStatements, buildPayStatement } = require('../utils/payStatement');
const { loadRateBookForEntries, workerRateOn } = require('../utils/rateHistory');
const { startOfWeek, toYMD } = require('../utils/weekBounds');
const { isValidIsoDate, dateRangeDays } = require('../utils/payPeriods');

const { logAudit } = require('../auditLog');

// GET /api/qbo/status — connection status for this company
router.get('/status', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT qbo_realm_id, qbo_connected_at, qbo_token_expires_at, qbo_disconnected FROM companies WHERE id = $1',
      [req.user.company_id]
    );
    const row = result.rows[0];
    const connected = !!row?.qbo_realm_id;

    let qbo_company_name = null;
    if (connected && !row?.qbo_disconnected) {
      try {
        const info = await qbo.getCompanyInfo(req.user.company_id);
        qbo_company_name = info?.CompanyName || null;
      } catch {
        // Non-fatal — connection display still works without the name
      }
    }

    res.json({
      connected,
      disconnected: row?.qbo_disconnected || false,
      connected_at: row?.qbo_connected_at || null,
      token_expires_at: row?.qbo_token_expires_at || null,
      qbo_company_name,
    });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── OAuth account linking ───────────────────────────────────────────────────
// The flow is bound to the admin who STARTED it. `state` is an HMAC-signed
// {company, user, nonce, issued_at}; the unauthenticated Intuit callback only
// checks the signature and hands code/state/realmId to the SPA, which POSTs them
// back to /callback/complete with its Bearer token. The code is redeemed only
// when that token's user + company match the state, the nonce is the one stored
// for the company (single use), and the state is < 15 min old.
//
// Why not just a cookie: the API and SPA can be on different sites, and a cookie
// set by a cross-site XHR response is often blocked (SameSite / 3rd-party cookie
// rules), so the Bearer-token round trip is the one binding that works here.
//
// Before: state was unsigned base64 {company_id, nonce} and the callback linked
// whichever QuickBooks company approved it — an attacker admin could send their
// authorize URL to another company's admin and link THAT QuickBooks to theirs.
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

function oauthStateSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
}
function signOAuthBody(body) {
  return crypto.createHmac('sha256', oauthStateSecret()).update(`qbo-oauth-state|${body}`).digest('base64url');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function makeOAuthState({ companyId, userId, nonce, issuedAt }) {
  const body = Buffer.from(JSON.stringify({ c: companyId, u: userId, n: nonce, t: issuedAt })).toString('base64url');
  return `${body}.${signOAuthBody(body)}`;
}
/** → { ok: true, payload } | { ok: false, code } — signature + shape + expiry. */
function verifyOAuthState(state) {
  if (typeof state !== 'string' || state.length > 2048) return { ok: false, code: 'invalid_state' };
  const dot = state.indexOf('.');
  if (dot <= 0) return { ok: false, code: 'invalid_state' };
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  if (!safeEqual(sig, signOAuthBody(body))) return { ok: false, code: 'invalid_state' };
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return { ok: false, code: 'invalid_state' }; }
  if (!payload || payload.c == null || payload.u == null || !payload.n || !Number.isFinite(payload.t)) {
    return { ok: false, code: 'invalid_state' };
  }
  const age = Date.now() - payload.t;
  if (age < 0 || age > OAUTH_STATE_TTL_MS) return { ok: false, code: 'qbo_state_expired' };
  return { ok: true, payload };
}

// GET /api/qbo/connect — returns the Intuit OAuth URL to redirect the user to
router.get('/connect', requireAdmin, requirePerm('manage_integrations'), async (req, res) => {
  if (!process.env.QBO_CLIENT_ID || !process.env.QBO_REDIRECT_URI) {
    return res.status(503).json({ error: 'QuickBooks integration not configured' });
  }
  try {
    // One pending flow per company: a new /connect replaces the stored nonce.
    const nonce = crypto.randomBytes(16).toString('hex');
    await pool.query('UPDATE companies SET qbo_oauth_nonce = $1 WHERE id = $2', [nonce, req.user.company_id]);
    const state = makeOAuthState({ companyId: req.user.company_id, userId: req.user.id, nonce, issuedAt: Date.now() });
    res.json({ url: qbo.getAuthUrl(state) });
  } catch (err) {
    logger.error({ err }, '[QBO connect]');
    res.status(500).json({ error: 'Server error' });
  }
});

function spaRedirect(res, params) {
  const qs = new URLSearchParams(params).toString();
  res.redirect(`${process.env.APP_URL}/administration?${qs}#integrations`);
}

// GET /api/qbo/callback — Intuit redirects here after the user authorizes.
// Exported and registered WITHOUT auth middleware in index.js — so it links
// NOTHING itself: it checks the state signature and forwards to the SPA, where
// the signed-in initiator completes the link via POST /callback/complete.
async function oauthCallback(req, res) {
  const { code, state, realmId, error } = req.query;
  if (error) return spaRedirect(res, { qbo_error: String(error).slice(0, 64) });
  if (!code || !state || !realmId) return spaRedirect(res, { qbo_error: 'missing_params' });
  try {
    const v = verifyOAuthState(String(state));
    if (!v.ok) return spaRedirect(res, { qbo_error: v.code === 'qbo_state_expired' ? 'expired' : 'invalid_state' });
    spaRedirect(res, { qbo_code: String(code), qbo_state: String(state), qbo_realm: String(realmId) });
  } catch (err) {
    logger.error({ err }, '[QBO callback]');
    spaRedirect(res, { qbo_error: 'auth_failed' });
  }
}
router.get('/callback', oauthCallback);

// POST /api/qbo/callback/complete — { code, state, realmId }, authenticated.
router.post('/callback/complete', requireAdmin, requirePerm('manage_integrations'), async (req, res) => {
  const { code, state, realmId } = req.body || {};
  if (!code || !state || !realmId) return res.status(400).json({ error: 'code, state and realmId are required', code: 'missing_params' });
  try {
    const v = verifyOAuthState(String(state));
    if (!v.ok) {
      return res.status(400).json({
        error: v.code === 'qbo_state_expired' ? 'The QuickBooks connection request expired — click Connect again.' : 'Invalid QuickBooks connection request.',
        code: v.code,
      });
    }
    const { c: companyId, u: userId, n: nonce } = v.payload;
    // The binding: only the admin who started this flow, in their own company.
    if (String(companyId) !== String(req.user.company_id) || String(userId) !== String(req.user.id)) {
      logger.warn({ stateCompany: companyId, stateUser: userId, company: req.user.company_id, user: req.user.id }, '[QBO callback] state/user mismatch');
      return res.status(403).json({ error: 'This QuickBooks connection was started by a different user. Click Connect again.', code: 'qbo_state_mismatch' });
    }
    // Consume the nonce atomically (single use; a replay finds it already cleared).
    const consumed = await pool.query(
      'UPDATE companies SET qbo_oauth_nonce = NULL WHERE id = $1 AND qbo_oauth_nonce = $2 RETURNING id',
      [req.user.company_id, nonce]
    );
    if (!consumed.rowCount) return res.status(400).json({ error: 'Invalid or already-used QuickBooks connection request.', code: 'invalid_state' });

    const tokens = await qbo.exchangeCode(String(code));
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    await pool.query(
      `UPDATE companies
       SET qbo_realm_id = $1, qbo_access_token = $2, qbo_refresh_token = $3,
           qbo_token_expires_at = $4, qbo_connected_at = NOW(),
           qbo_oauth_nonce = NULL, qbo_disconnected = false
       WHERE id = $5`,
      [encrypt(String(realmId)), encrypt(tokens.access_token), encrypt(tokens.refresh_token), expiresAt, req.user.company_id]
    );
    logAudit(req.user.company_id, req.user.id, req.user.full_name, 'qbo.connected', 'company', req.user.company_id, null, null);
    res.json({ connected: true });
  } catch (err) {
    logger.error({ err }, '[QBO callback complete]');
    res.status(500).json({ error: 'Failed to connect QuickBooks', code: 'auth_failed' });
  }
});

// DELETE /api/qbo/disconnect
router.delete('/disconnect', requireAdmin, requirePerm('manage_integrations'), async (req, res) => {
  try {
    await pool.query(
      `UPDATE companies
       SET qbo_realm_id = NULL, qbo_access_token = NULL, qbo_refresh_token = NULL,
           qbo_token_expires_at = NULL, qbo_connected_at = NULL, qbo_disconnected = false
       WHERE id = $1`,
      [req.user.company_id]
    );
    logAudit(req.user.company_id, req.user.id, req.user.full_name, 'qbo.disconnected', 'company', req.user.company_id, null, null);
    res.json({ disconnected: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/qbo/employees — list QBO employees (for mapping UI)
router.get('/employees', requireAdmin, async (req, res) => {
  try {
    const employees = await qbo.listEmployees(req.user.company_id);
    res.json(employees);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    const status = err.code === 'qbo_auth_expired' ? 401 : 500;
    res.status(status).json({ error: err.code === 'qbo_auth_expired' ? err.message : 'Server error', code: err.code });
  }
});

// GET /api/qbo/customers — list QBO customers (for mapping UI)
router.get('/customers', requireAdmin, async (req, res) => {
  try {
    const customers = await qbo.listCustomers(req.user.company_id);
    res.json(customers);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    const status = err.code === 'qbo_auth_expired' ? 401 : 500;
    res.status(status).json({ error: err.code === 'qbo_auth_expired' ? err.message : 'Server error', code: err.code });
  }
});

// GET /api/qbo/vendors — list QBO vendors (for contractor/subcontractor mapping)
router.get('/vendors', requireAdmin, async (req, res) => {
  try {
    const vendors = await qbo.listVendors(req.user.company_id);
    res.json(vendors);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    const status = err.code === 'qbo_auth_expired' ? 401 : 500;
    res.status(status).json({ error: err.code === 'qbo_auth_expired' ? err.message : 'Server error', code: err.code });
  }
});

// PATCH /api/qbo/workers/:id/mapping — save QBO employee or vendor ID for a worker
router.patch('/workers/:id/mapping', requireAdmin, requirePerm('manage_integrations'), async (req, res) => {
  const { qbo_employee_id, qbo_vendor_id } = req.body;
  try {
    if (qbo_vendor_id !== undefined) {
      await pool.query(
        'UPDATE users SET qbo_vendor_id = $1 WHERE id = $2 AND company_id = $3',
        [qbo_vendor_id || null, req.params.id, req.user.company_id]
      );
    } else {
      await pool.query(
        'UPDATE users SET qbo_employee_id = $1 WHERE id = $2 AND company_id = $3',
        [qbo_employee_id || null, req.params.id, req.user.company_id]
      );
    }
    res.json({ saved: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/qbo/projects/:id/mapping — save QBO customer ID and/or class ID for a project
router.patch('/projects/:id/mapping', requireAdmin, requirePerm('manage_integrations'), async (req, res) => {
  const { qbo_customer_id, qbo_class_id } = req.body;
  const fields = [];
  const vals = [];
  if (qbo_customer_id !== undefined) { vals.push(qbo_customer_id || null); fields.push(`qbo_customer_id = $${vals.length}`); }
  if (qbo_class_id !== undefined) { vals.push(qbo_class_id || null); fields.push(`qbo_class_id = $${vals.length}`); }
  if (fields.length === 0) return res.json({ saved: true });
  try {
    await pool.query(
      `UPDATE projects SET ${fields.join(', ')} WHERE id = $${vals.length + 1} AND company_id = $${vals.length + 2}`,
      [...vals, req.params.id, req.user.company_id]
    );
    res.json({ saved: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/qbo/items — list QBO service/non-inventory items for invoice line selection
router.get('/items', requireAdmin, async (req, res) => {
  try {
    const items = await qbo.listItems(req.user.company_id);
    res.json(items);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    const status = err.code === 'qbo_auth_expired' ? 401 : 500;
    res.status(status).json({ error: err.code === 'qbo_auth_expired' ? err.message : 'Server error', code: err.code });
  }
});

// POST /api/qbo/invoices — push a billing invoice to QBO
// Body: { customer_id, item_id, amount, description, doc_number, txn_date, project_id }
router.post('/invoices', requireAdmin, requirePerm('manage_integrations'), async (req, res) => {
  const { customer_id, item_id, amount, description, doc_number, txn_date, project_id } = req.body;
  if (!customer_id || !item_id || amount == null) {
    return res.status(400).json({ error: 'customer_id, item_id, and amount are required' });
  }
  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
  try {
    const invoice = await qbo.createInvoice(req.user.company_id, {
      customerId: customer_id,
      itemId: item_id,
      amount: parsed,
      description: description || '',
      docNumber: doc_number || null,
      txnDate: txn_date || null,
      // Dedup an accidental double-submit of the same invoice at Intuit (no source-row id
      // here, so key off the invoice's own fields).
      requestId: `ops-inv-${crypto.createHash('sha256').update(`${req.user.company_id}|${customer_id}|${item_id}|${parsed}|${doc_number || ''}|${txn_date || ''}`).digest('hex').slice(0, 32)}`,
    });
    // Mirror the pushed invoice into the NATIVE invoices table (source='qbo',
    // keyed by qbo_invoice_id) — project_invoices is retired. Fire-and-forget:
    // the QBO invoice already exists, so a mirror hiccup must not fail the push.
    // Number scheme 'QBO-<qboId>' is distinct from the migration's 'QBO-IMP-'.
    if (invoice?.Id && project_id) {
      const cents = Math.round(parsed * 100);
      pool.query(
        `WITH ins AS (
           INSERT INTO invoices
             (company_id, project_id, invoice_number, client_name_snapshot, status,
              subtotal_cents, tax_cents, total_cents, issue_date, qbo_invoice_id,
              qbo_doc_number, source, created_by)
           SELECT $1,
                  -- Scope project_id + the client-name snapshot to the caller's
                  -- company: a foreign project_id resolves to NULL / the fallback
                  -- name rather than linking to (or leaking) another tenant's data.
                  (SELECT p2.id FROM projects p2 WHERE p2.id = $2 AND p2.company_id = $1),
                  'QBO-' || $3,
                  COALESCE((SELECT NULLIF(cl.name, '') FROM projects p JOIN clients cl ON cl.id = p.client_id WHERE p.id = $2 AND p.company_id = $1), 'QuickBooks'),
                  'sent', $4, 0, $4, $5, $3, $6, 'qbo', $7
           RETURNING id, company_id
         )
         INSERT INTO invoice_lines (invoice_id, category, sort_order, description, qty, unit_cost_cents, total_cents)
         SELECT id, 'other', 0, $8, 1, $4, $4 FROM ins`,
        [req.user.company_id, project_id, invoice.Id, cents,
         txn_date || new Date().toLocaleDateString('en-CA'), invoice.DocNumber || null, req.user.id,
         description || `QuickBooks invoice ${invoice.DocNumber || invoice.Id}`]
      ).catch(err => logger.error({ err }, '[QBO invoice save]'));
    }
    logAudit(req.user.company_id, req.user.id, req.user.full_name, 'qbo.invoice_created', 'qbo_invoice', invoice?.Id || null, invoice?.DocNumber || null,
      { amount: parsed, customer_id, project_id: project_id || null });
    res.json(invoice);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    const status = err.code === 'qbo_auth_expired' ? 401 : 500;
    res.status(status).json({ error: err.code === 'qbo_auth_expired' ? err.message : 'Server error', code: err.code });
  }
});

// GET /api/qbo/invoices/project/:projectId — list saved invoices for a project
router.get('/invoices/project/:projectId', requireAdmin, async (req, res) => {
  try {
    // Read the native invoices that carry a QBO link, mapped back to the shape
    // the Projects QBO panel expects ({ doc_number, amount, balance, payment_status }).
    const { rows } = await pool.query(
      `SELECT i.id,
              i.qbo_invoice_id,
              i.qbo_doc_number AS doc_number,
              (i.total_cents / 100.0) AS amount,
              i.issue_date AS txn_date,
              GREATEST(0, i.total_cents - COALESCE(pay.paid, 0)) / 100.0 AS balance,
              CASE i.status WHEN 'paid' THEN 'paid' WHEN 'partial' THEN 'partial' ELSE 'unpaid' END AS payment_status,
              i.created_at,
              (SELECT MAX(created_at) FROM invoice_payments p2 WHERE p2.invoice_id = i.id) AS last_checked_at
         FROM invoices i
         LEFT JOIN (
           SELECT invoice_id, SUM(amount_cents) AS paid FROM invoice_payments GROUP BY invoice_id
         ) pay ON pay.invoice_id = i.id
        WHERE i.company_id = $1 AND i.project_id = $2 AND i.qbo_invoice_id IS NOT NULL
          AND i.status <> 'void'
        ORDER BY i.created_at DESC`,
      [req.user.company_id, req.params.projectId]
    );
    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/qbo/invoices/:invoiceId/check-payment — refresh payment status from QBO
router.post('/invoices/:invoiceId/check-payment', requireAdmin, requirePerm('manage_integrations'), async (req, res) => {
  try {
    const invoice = await qbo.getInvoice(req.user.company_id, req.params.invoiceId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found in QuickBooks' });

    const balance = parseFloat(invoice.Balance ?? invoice.TotalAmt ?? 0);
    const totalAmt = parseFloat(invoice.TotalAmt ?? 0);
    let payment_status = 'unknown';
    if (balance <= 0) payment_status = 'paid';
    else if (balance < totalAmt) payment_status = 'partial';
    else payment_status = 'unpaid';
    // Native status: 'sent' means fully unpaid (the QBO UI still labels it 'unpaid').
    const nativeStatus = balance <= 0 ? 'paid' : (balance < totalAmt ? 'partial' : 'sent');
    const paidCents = Math.round(Math.max(0, totalAmt - balance) * 100);

    // Refresh the native invoice(s) linked to this QBO invoice: update the total
    // + status and re-sync the imported payment (delete-then-insert keeps
    // check-payment idempotent — QBO stays the source of truth for the amount).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inv = await client.query(
        // Exclude 'void' — a voided invoice must not be resurrected into AR by a
        // later check-payment.
        "SELECT id FROM invoices WHERE qbo_invoice_id = $1 AND company_id = $2 AND status <> 'void'",
        [req.params.invoiceId, req.user.company_id]
      );
      for (const row of inv.rows) {
        await client.query(
          'UPDATE invoices SET total_cents = $1, subtotal_cents = $1, status = $2, updated_at = NOW() WHERE id = $3',
          [Math.round(totalAmt * 100), nativeStatus, row.id]
        );
        await client.query(
          `DELETE FROM invoice_payments WHERE invoice_id = $1 AND method = 'other' AND notes = 'QuickBooks payment (imported)'`,
          [row.id]
        );
        if (paidCents > 0) {
          await client.query(
            `INSERT INTO invoice_payments (invoice_id, company_id, amount_cents, paid_date, method, notes)
             VALUES ($1, $2, $3, CURRENT_DATE, 'other', 'QuickBooks payment (imported)')`,
            [row.id, req.user.company_id, paidCents]
          );
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    res.json({ qbo_invoice_id: req.params.invoiceId, balance, payment_status, total: totalAmt });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    const status = err.code === 'qbo_auth_expired' ? 401 : 500;
    res.status(status).json({ error: err.code === 'qbo_auth_expired' ? err.message : 'Server error', code: err.code });
  }
});

// GET /api/qbo/accounts — list all active QBO accounts
router.get('/accounts', requireAdmin, async (req, res) => {
  try {
    const accounts = await qbo.listAccounts(req.user.company_id);
    res.json(accounts);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    const status = err.code === 'qbo_auth_expired' ? 401 : 500;
    res.status(status).json({ error: err.code === 'qbo_auth_expired' ? err.message : 'Server error', code: err.code });
  }
});

// POST /api/qbo/expenses — push a reimbursement expense to QBO
// Body: { bank_account_id, expense_account_id, vendor_id, amount, description, txn_date }
router.post('/expenses', requireAdmin, requirePerm('manage_integrations'), async (req, res) => {
  const { bank_account_id, expense_account_id, vendor_id, amount, description, txn_date } = req.body;
  if (!bank_account_id || !expense_account_id || amount == null) {
    return res.status(400).json({ error: 'bank_account_id, expense_account_id, and amount are required' });
  }
  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
  try {
    const purchase = await qbo.createPurchase(req.user.company_id, {
      bankAccountId: bank_account_id,
      expenseAccountId: expense_account_id,
      vendorId: vendor_id || null,
      amount: parsed,
      description: description || '',
      txnDate: txn_date || null,
      // Dedup an accidental double-submit of the same one-off expense at Intuit.
      requestId: `ops-exp-${crypto.createHash('sha256').update(`${req.user.company_id}|${bank_account_id}|${expense_account_id}|${vendor_id || ''}|${parsed}|${txn_date || ''}`).digest('hex').slice(0, 32)}`,
    });
    res.json(purchase);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    const status = err.code === 'qbo_auth_expired' ? 401 : 500;
    res.status(status).json({ error: err.code === 'qbo_auth_expired' ? err.message : 'Server error', code: err.code });
  }
});

const sha = (s, n = 32) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, n);

// Intuit requestid for a TimeActivity (max 50 chars). Normal pushes, retry and the
// auto-push on approval all use `ops-ta-<id>` so a lost response dedupes; a forced
// re-push of an already-synced entry is versioned by what it replaces.
function timeActivityRequestId(entry, hours, force) {
  if (!force || !entry.qbo_activity_id) return `ops-ta-${entry.id}`;
  return `ops-ta-${entry.id}-v${sha(`${entry.qbo_activity_id}|${Math.round(hours * 60)}`, 16)}`;
}

// POST /api/qbo/push — push time entries to QBO for a date range
// Body: { from, to, force } — force=true re-pushes already-synced entries
router.post('/push', requireAdmin, requirePerm('manage_integrations'), async (req, res) => {
  const { from, to, force } = req.body;
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `SELECT te.*, u.qbo_employee_id, u.qbo_vendor_id, u.worker_type, u.role_id, p.qbo_customer_id, p.qbo_class_id,
              u.full_name as worker_name, p.name as project_name
       FROM time_entries te
       JOIN users u ON te.user_id = u.id
       LEFT JOIN projects p ON te.project_id = p.id
       WHERE te.company_id = $1
         AND te.status = 'approved'
         AND ($2::date IS NULL OR te.work_date >= $2::date)
         AND ($3::date IS NULL OR te.work_date <= $3::date)`,
      [companyId, from || null, to || null]
    );

    const pushRoleById = {};
    result.rows.forEach(e => { pushRoleById[e.user_id] = e.role_id; });
    // Paid (rounded) punch, break-net — the same helper the retry + auto-push use.
    const entries = qbo.timeActivityHours(result.rows, await loadSettings(companyId), pushRoleById);
    const skipped = [];
    const pushed = [];
    let alreadySynced = 0;

    for (const { entry, hours, workDate } of entries) {
      // Skip already-synced entries unless force re-push requested
      if (entry.qbo_activity_id && !force) {
        alreadySynced++;
        continue;
      }
      if (entry.worker_type === 'unpaid') {
        skipped.push({ entry_id: entry.id, reason: `Worker "${entry.worker_name}" is unpaid — labor is not synced to QuickBooks` });
        continue;
      }
      const usesVendor = entry.worker_type === 'contractor' || entry.worker_type === 'subcontractor';
      const mappedId = usesVendor ? entry.qbo_vendor_id : entry.qbo_employee_id;
      if (!mappedId) {
        skipped.push({ entry_id: entry.id, reason: `Worker "${entry.worker_name}" has no QBO mapping` });
        continue;
      }
      if (!entry.qbo_customer_id) {
        skipped.push({ entry_id: entry.id, reason: `Project "${entry.project_name || 'unknown'}" has no QBO mapping` });
        continue;
      }

      try {
        const activity = await qbo.pushTimeActivity(companyId, {
          ...(usesVendor ? { vendorId: entry.qbo_vendor_id } : { employeeId: entry.qbo_employee_id }),
          customerId: entry.qbo_customer_id,
          classId: entry.qbo_class_id || null,
          workDate,
          hours,
          description: entry.notes || '',
          // One activity per time entry — a double-click sends the same key so Intuit
          // dedupes instead of creating a duplicate. A FORCE re-push of an already-synced
          // entry must create a new activity, so it carries a version suffix derived from
          // the activity it replaces + the hours (reusing ops-ta-<id> just got the old one
          // back from Intuit's dedupe); a double-click of the same force still dedupes.
          requestId: timeActivityRequestId(entry, hours, force),
        });
        // Record the QB activity ID to prevent future duplicates
        await pool.query(
          'UPDATE time_entries SET qbo_activity_id = $1, qbo_synced_at = NOW() WHERE id = $2',
          [activity?.Id || 'synced', entry.id]
        );
        pushed.push(entry.id);
      } catch (pushErr) {
        skipped.push({ entry_id: entry.id, reason: pushErr.message });
      }
    }

    logAudit(companyId, req.user.id, req.user.full_name, 'qbo.time_pushed', null, null, null,
      { pushed: pushed.length, skipped: skipped.length, already_synced: alreadySynced, from: from || null, to: to || null, force: !!force });
    res.json({ pushed: pushed.length, skipped, already_synced: alreadySynced });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/qbo/import/workers — create OpsFloa workers from QB employees/vendors
router.post('/import/workers', requireAdmin, requirePerm('manage_integrations'), async (req, res) => {
  const companyId = req.user.company_id;
  const { workers } = req.body; // [{ display_name, email, qbo_employee_id, qbo_vendor_id, worker_type }]
  if (!Array.isArray(workers) || workers.length === 0) return res.status(400).json({ error: 'workers array required' });

  // Get company default temp password from settings
  const settingsRows = await pool.query('SELECT key, value FROM settings WHERE company_id = $1', [companyId]);
  const settings = applySettingsRows(settingsRows.rows, ADMIN_SETTINGS_DEFAULTS);
  const tempPassword = settings.default_temp_password || crypto.randomBytes(5).toString('hex');
  const hash = await bcrypt.hash(tempPassword, 10);

  const VALID_WORKER_TYPES = USER_WORKER_TYPES;
  const imported = [];
  const skipped = [];

  for (const w of workers) {
    const displayName = (w.display_name || '').trim().slice(0, 255);
    if (!displayName) { skipped.push({ display_name: displayName, reason: 'Missing name' }); continue; }

    const workerType = VALID_WORKER_TYPES.includes(w.worker_type) ? w.worker_type : 'employee';
    const email = w.email?.trim()?.slice(0, 255) || null;

    // Generate username from display name
    const parts = displayName.split(/\s+/);
    const base = ((parts[0]?.[0] || '') + (parts[parts.length - 1] || '')).toLowerCase().replace(/[^a-z0-9]/g, '') || 'worker';
    let username = base;
    let suffix = 2;
    while (true) {
      const conflict = await pool.query('SELECT id FROM users WHERE username = $1 AND company_id = $2', [username, companyId]);
      if (conflict.rowCount === 0) break;
      username = `${base}${suffix++}`;
    }

    try {
      const result = await pool.query(
        `INSERT INTO users (company_id, username, password_hash, full_name, role, language, email, email_confirmed, must_change_password, worker_type, qbo_employee_id, qbo_vendor_id)
         VALUES ($1, $2, $3, $4, 'worker', 'English', $5, true, true, $6, $7, $8)
         RETURNING id, username, full_name, worker_type`,
        [companyId, username, hash, displayName, email, workerType,
         w.qbo_employee_id || null, w.qbo_vendor_id || null]
      );
      imported.push({ ...result.rows[0], temp_password: tempPassword });
    } catch (err) {
      logger.error({ err }, 'QBO worker import error');
      skipped.push({ display_name: displayName, reason: 'Failed to import worker' });
    }
  }

  res.json({ imported, skipped, temp_password: tempPassword });
});

// POST /api/qbo/import/projects — create OpsFloa projects from QB customers
router.post('/import/projects', requireAdmin, requirePerm('manage_integrations'), async (req, res) => {
  const companyId = req.user.company_id;
  const { projects } = req.body; // [{ name, qbo_customer_id }]
  if (!Array.isArray(projects) || projects.length === 0) return res.status(400).json({ error: 'projects array required' });

  const imported = [];
  const skipped = [];

  for (const p of projects) {
    const name = (p.name || '').trim().slice(0, 255);
    if (!name) { skipped.push({ name, reason: 'Missing name' }); continue; }
    try {
      const result = await pool.query(
        `INSERT INTO projects (company_id, name, wage_type, qbo_customer_id)
         VALUES ($1, $2, 'regular', $3)
         RETURNING id, name, qbo_customer_id`,
        [companyId, name, p.qbo_customer_id || null]
      );
      imported.push(result.rows[0]);
    } catch (err) {
      logger.error({ err }, 'QBO project import error');
      if (err.code === '23505') skipped.push({ name, reason: 'Project with this name already exists' });
      else skipped.push({ name, reason: 'Failed to import project' });
    }
  }

  res.json({ imported, skipped });
});

// GET /api/qbo/classes — list QBO classes for job-costing mapping
router.get('/classes', requireAdmin, async (req, res) => {
  try {
    const classes = await qbo.listClasses(req.user.company_id);
    res.json(classes);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    const status = err.code === 'qbo_auth_expired' ? 401 : 500;
    res.status(status).json({ error: err.code === 'qbo_auth_expired' ? err.message : 'Server error', code: err.code });
  }
});

// GET /api/qbo/errors — list recent QBO sync errors for this company
router.get('/errors', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, entity_type, entity_id, error_message, created_at
       FROM qbo_sync_errors WHERE company_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [req.user.company_id]
    );
    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/qbo/errors — dismiss all sync errors for this company
router.delete('/errors', requireAdmin, requirePerm('manage_integrations'), async (req, res) => {
  try {
    await pool.query('DELETE FROM qbo_sync_errors WHERE company_id = $1', [req.user.company_id]);
    res.json({ cleared: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/qbo/errors/:id — dismiss a single sync error
router.delete('/errors/:id', requireAdmin, requirePerm('manage_integrations'), async (req, res) => {
  try {
    await pool.query('DELETE FROM qbo_sync_errors WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
    res.json({ cleared: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/qbo/push-expenses — push approved reimbursements to QBO for a date range
// Body: { from, to, force }
router.post('/push-expenses', requireAdmin, requirePerm('manage_integrations'), async (req, res) => {
  const { from, to, force } = req.body;
  const companyId = req.user.company_id;
  try {
    const [settingRows, reimbs] = await Promise.all([
      pool.query("SELECT key, value FROM settings WHERE company_id = $1 AND key IN ('qbo_expense_account_id', 'qbo_bank_account_id')", [companyId]),
      pool.query(
        `SELECT r.*, u.qbo_vendor_id, u.worker_type
         FROM reimbursements r
         JOIN users u ON r.user_id = u.id
         WHERE r.company_id = $1
           AND r.status = 'approved'
           AND ($2::date IS NULL OR r.expense_date >= $2::date)
           AND ($3::date IS NULL OR r.expense_date <= $3::date)`,
        [companyId, from || null, to || null]
      ),
    ]);

    const expenseAccountId = settingRows.rows.find(r => r.key === 'qbo_expense_account_id')?.value;
    const bankAccountId = settingRows.rows.find(r => r.key === 'qbo_bank_account_id')?.value;
    if (!expenseAccountId || !bankAccountId) {
      return res.status(400).json({ error: 'Configure expense and bank accounts in QBO Settings before pushing expenses.' });
    }

    const company = await pool.query('SELECT qbo_realm_id FROM companies WHERE id = $1', [companyId]);
    if (!company.rows[0]?.qbo_realm_id) return res.status(400).json({ error: 'QuickBooks not connected' });

    const pushed = [];
    const skipped = [];
    let alreadySynced = 0;

    for (const r of reimbs.rows) {
      if (r.qbo_purchase_id && !force) { alreadySynced++; continue; }
      try {
        const vendorId = (r.worker_type === 'contractor' || r.worker_type === 'subcontractor') ? r.qbo_vendor_id : null;
        const txnDate = r.expense_date ? r.expense_date.toISOString?.().substring(0, 10) || String(r.expense_date).substring(0, 10) : null;
        const purchase = await qbo.createPurchase(companyId, {
          bankAccountId, expenseAccountId, vendorId,
          amount: parseFloat(r.amount),
          description: r.description || r.category || 'Expense reimbursement',
          txnDate,
          // One purchase per reimbursement, keyed IDENTICALLY across the auto-sync, batch,
          // and retry paths (`ops-reimb-<id>`) so pushing the same reimbursement through a
          // different path can't create a second QBO Purchase.
          requestId: `ops-reimb-${r.id}`,
        });
        await pool.query(
          'UPDATE reimbursements SET qbo_purchase_id = $1, qbo_synced_at = NOW() WHERE id = $2',
          [purchase?.Id || 'synced', r.id]
        );
        pushed.push(r.id);
      } catch (pushErr) {
        skipped.push({ id: r.id, reason: pushErr.message });
      }
    }

    logAudit(req.user.company_id, req.user.id, req.user.full_name, 'qbo.expenses_pushed', null, null, null,
      { pushed: pushed.length, skipped: skipped.length, already_synced: alreadySynced });
    res.json({ pushed: pushed.length, skipped, already_synced: alreadySynced });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Push Bills ──────────────────────────────────────────────────────────
// Gathers approved time entries + approved reimbursements in a date range for
// the selected contractor-mapped workers, groups by vendor, and creates one
// QBO Bill per vendor. Labor lines are item-based, reimbursement lines are
// account-based (against qbo_expense_account_id).
//
// Every labor dollar comes from the PAY ENGINE (buildPayStatement, the same
// assembler behind the invoice / stubs / payroll CSV), so a bill is what the
// worker is paid. Before, bills re-derived pay on their own: gross punch hours
// (break ignored — 07:00–15:30 with a 30-min break billed 8.5h), every hour at
// the worker's hourly rate (prevailing + daily-rate workers mispriced), and an
// OT line of OT hours × rate × (multiplier − 1) that mispriced tiers / rest-day /
// 7th-day / weighted-average configs.
//
// Lines: one straight-time line per entry (paid hours × the rate that entry
// earns — job-costed to its customer/class), then the OT premium, night
// differential and rule-generated pay (min-daily floors, weekly guarantee, paid
// leave) as their own lines. The OT line is the remainder that makes the bill
// equal the statement to the cent.
//
// A bill is INCREMENTAL. Worked pay (straight time, OT, night) bills
//   statement(already-billed + new in-range rows) − statement(already-billed rows)
// so a late approval gets the OT / day-rate its week and day really earned: a
// late Saturday after a billed 40h week is all overtime, and a second entry on a
// daily-rate day that was already billed adds no second day rate. (Before, the
// already-billed rows were dropped entirely — not even week context.)
//
// Range-level pay (floors, weekly guarantee, leave) isn't tied to one entry, so
// it's ledgered in qbo_bill_range_pay (0211) per worker + kind + date (the
// week's start for the guarantee): each bill posts current − already billed and
// records the new amount. Leave and floors bill for the days in [from,to]; a
// week's guarantee bills on the bill whose range holds the week's LAST day
// (priced over the whole week). Before, this was billed only on the "first bill
// for a worker+range" heuristic: Sep 1–15 then Sep 1–30 never billed Sep 16–30,
// and Sep 1–7 then Sep 3–14 billed Sep 3–7 again. A forced re-push re-bills the
// full current amounts.

const toCents = n => Math.round((Number(n) || 0) * 100);
const RANGE_LEVEL_KINDS = new Set(['weekly_guarantee', 'sick', 'vacation']);
const NO_LEAVE = { sick: 0, vacation: 0 };
const copyRow = e => ({ ...e });

function isoDate(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.substring(0, 10);
  try { return d.toISOString().substring(0, 10); } catch { return String(d).substring(0, 10); }
}

// 'YYYY-MM-DD' ± n days (UTC arithmetic on a date string — no DST drift).
function addDaysYmd(s, n) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().substring(0, 10);
}

// The week_start-aligned full weeks touching [from,to], so weekly OT sees the
// whole week (same idea as the pay-statement loaders).
function billWeekSpan(from, to, weekStart) {
  if (!from || !to) return null;
  const end = startOfWeek(to, weekStart);
  end.setDate(end.getDate() + 6);
  return { from: toYMD(startOfWeek(from, weekStart)), to: toYMD(end) };
}

function badRange(from, to) {
  return (from && !isValidIsoDate(from)) || (to && !isValidIsoDate(to)) || (from && to && from > to);
}

// Paid leave per worker per day over [from,to]: Map(userId → Map(date → {sick, vacation})).
// Same valuation as computeCompanyLeave (schedule → leave rule → regular shift,
// partial requests on their start date), kept per day so the bill can ledger it.
async function loadLeaveDays(companyId, workers, settings, from, to) {
  const out = new Map();
  if (!from || !to || !workers.length) return out;
  const ids = workers.map(w => w.id);
  const [reqs, shifts] = await Promise.all([
    pool.query(
      `SELECT user_id, type, hours, start_date, end_date FROM time_off_requests
        WHERE company_id = $1 AND type IN ('sick','vacation') AND status = 'approved'
          AND start_date <= $3::date AND end_date >= $2::date AND user_id = ANY($4::int[])`,
      [companyId, from, to, ids]
    ),
    pool.query(
      `SELECT user_id, shift_date, start_time, end_time FROM shifts
        WHERE company_id = $1 AND shift_date >= $2::date AND shift_date <= $3::date AND user_id = ANY($4::int[])`,
      [companyId, from, to, ids]
    ),
  ]);
  for (const w of workers) {
    const detail = [];
    computeLeaveHours(
      (reqs.rows || []).filter(r => r.user_id === w.id),
      shiftHoursByDate((shifts.rows || []).filter(s => s.user_id === w.id)),
      sickRulesFromSettings(settings, w.role_id ?? null, w.id),
      settings.regular_shift_hours, from, to, detail
    );
    const days = new Map();
    for (const d of detail) {
      const v = days.get(d.date) || { sick: 0, vacation: 0 };
      v[d.type === 'vacation' ? 'vacation' : 'sick'] += parseFloat(d.hours) || 0;
      days.set(d.date, v);
    }
    out.set(w.id, days);
  }
  return out;
}

// { sick, vacation, leaveByDate } for the leave days inside [a,b].
function leaveBetween(days, a, b) {
  const out = { sick: 0, vacation: 0, leaveByDate: new Map() };
  for (const [d, v] of days || []) {
    if (d < a || d > b) continue;
    out.sick += v.sick; out.vacation += v.vacation;
    out.leaveByDate.set(d, v.sick + v.vacation);
  }
  return out;
}

// What range-level pay is already on a bill: Map('uid|kind|date' → {amountC, hours}).
async function loadRangePayLedger(companyId, userIds, from, to) {
  const out = new Map();
  if (!userIds.length || !from || !to) return out;
  const r = await pool.query(
    `SELECT user_id, kind, to_char(pay_date, 'YYYY-MM-DD') AS pay_date, amount_cents, hours
       FROM qbo_bill_range_pay
      WHERE company_id = $1 AND user_id = ANY($2::int[]) AND pay_date >= $3::date AND pay_date <= $4::date`,
    [companyId, userIds, from, to]
  );
  for (const row of r.rows || []) {
    out.set(`${row.user_id}|${row.kind}|${isoDate(row.pay_date)}`, { amountC: Number(row.amount_cents) || 0, hours: parseFloat(row.hours) || 0 });
  }
  return out;
}

async function gatherBillData(companyId, { from, to, workerIds, force }, settings) {
  const ids = Array.isArray(workerIds) && workerIds.length ? workerIds : null;
  const span = billWeekSpan(from, to, settings.week_start);
  const [timeRows, reimbRows] = await Promise.all([
    pool.query(
      // work_date as 'YYYY-MM-DD' text: the rules engine keys on the string (a
      // Date silently no-ops date-scoped rules). Fetches the full weeks touching
      // the range — out-of-range rows are weekly-OT context only, never billed.
      `SELECT te.id, te.user_id, te.project_id, to_char(te.work_date, 'YYYY-MM-DD') AS work_date,
              te.start_time, te.end_time, te.notes, te.qbo_bill_id, te.qbo_activity_id, te.wage_type,
              te.break_minutes, te.mileage, te.overtime_hours_override,
              te.start_ts, te.end_ts, te.timezone,
              u.full_name, u.qbo_vendor_id, u.hourly_rate, u.rate_type, u.worker_type, u.overtime_rule,
              u.role_id, u.guaranteed_weekly_hours,
              p.qbo_class_id, p.qbo_customer_id, p.name AS project_name, p.prevailing_wage_rate
         FROM time_entries te
         JOIN users u    ON te.user_id = u.id
         LEFT JOIN projects p ON te.project_id = p.id
        WHERE te.company_id = $1
          AND te.status = 'approved'
          AND ($2::date IS NULL OR te.work_date >= $2::date)
          AND ($3::date IS NULL OR te.work_date <= $3::date)
          AND ($4::int[] IS NULL OR te.user_id = ANY($4::int[]))
          AND u.qbo_vendor_id IS NOT NULL
          AND u.worker_type <> 'unpaid'
        ORDER BY te.user_id, te.work_date, te.start_time`,
      [companyId, (span ? span.from : from) || null, (span ? span.to : to) || null, ids]
    ),
    pool.query(
      `SELECT r.id, r.user_id, r.project_id, r.expense_date, r.amount, r.description, r.category,
              r.qbo_bill_id, r.qbo_purchase_id,
              u.full_name, u.qbo_vendor_id,
              p.qbo_class_id, p.qbo_customer_id, p.name AS project_name
         FROM reimbursements r
         JOIN users u    ON r.user_id = u.id
         LEFT JOIN projects p ON r.project_id = p.id
        WHERE r.company_id = $1
          AND r.status = 'approved'
          AND ($2::date IS NULL OR r.expense_date >= $2::date)
          AND ($3::date IS NULL OR r.expense_date <= $3::date)
          AND ($4::int[] IS NULL OR r.user_id = ANY($4::int[]))
          AND u.qbo_vendor_id IS NOT NULL`,
      [companyId, from || null, to || null, ids]
    ),
  ]);

  const roleById = {};
  timeRows.rows.forEach(e => { roleById[e.user_id] = e.role_id; });
  // Every punch billed is the PAID punch (hours-rules rounding), like every pay surface.
  const paidRows = roundEntriesFromSettings(timeRows.rows, settings, { workerRoleById: roleById });

  const projectRateMap = {};
  for (const e of paidRows) {
    if (e.project_id != null && e.prevailing_wage_rate != null) projectRateMap[e.project_id] = parseFloat(e.prevailing_wage_rate);
  }
  // Effective-dated rates: a re-push after a raise must bill last month's hours at
  // last month's rate. One batched load for every worker / project on the bill.
  const rateBook = paidRows.length ? await loadRateBookForEntries(companyId, paidRows) : null;

  const byUser = new Map();
  const get = (uid, row) => {
    if (!byUser.has(uid)) {
      byUser.set(uid, {
        userId: uid, fullName: row.full_name, vendorId: row.qbo_vendor_id, worker: null,
        billable: [], billed: [], context: [], workedDates: new Set(), reimbursements: [],
      });
    }
    return byUser.get(uid);
  };
  const inRange = d => (!from || d >= from) && (!to || d <= to);
  let minDate = null, maxDate = null;
  for (const te of paidRows) {
    const g = get(te.user_id, te);
    g.worker = g.worker || {
      id: te.user_id, full_name: te.full_name, hourly_rate: te.hourly_rate, rate_type: te.rate_type || 'hourly',
      overtime_rule: te.overtime_rule, role_id: te.role_id, worker_type: te.worker_type,
      guaranteed_weekly_hours: te.guaranteed_weekly_hours || 0,
    };
    if (te.wage_type === 'regular') g.workedDates.add(te.work_date);
    if (!inRange(te.work_date)) { g.context.push(te); continue; }
    if (!minDate || te.work_date < minDate) minDate = te.work_date;
    if (!maxDate || te.work_date > maxDate) maxDate = te.work_date;
    // Already on a bill: not billed again, but still the week/day context the new
    // rows' OT and day-rate are priced against (see header).
    if (te.qbo_bill_id && !force) { g.billed.push(te); continue; }
    g.billable.push(te);
  }
  for (const r of reimbRows.rows) {
    if (r.qbo_bill_id && !force) continue;
    const g = get(r.user_id, r);
    g.reimbursements.push({
      id: r.id, expenseDate: r.expense_date, amount: parseFloat(r.amount) || 0,
      qboBillId: r.qbo_bill_id || null,
      classId: r.qbo_class_id || null,
      customerId: r.qbo_customer_id || null,
      projectName: r.project_name || '',
      description: r.description || r.category || '',
    });
  }

  // Range-level pay: per-day leave over the whole weeks (the guarantee is priced
  // per week) + what's already billed. Without a full range only floors apply.
  const workerGroups = Array.from(byUser.values()).filter(g => g.worker);
  const ledgerSpan = span || (minDate ? { from: minDate, to: maxDate } : null);
  const [leaveDays, ledger] = await Promise.all([
    span ? loadLeaveDays(companyId, workerGroups.map(g => g.worker), settings, span.from, span.to) : new Map(),
    ledgerSpan ? loadRangePayLedger(companyId, workerGroups.map(g => g.userId), ledgerSpan.from, ledgerSpan.to) : new Map(),
  ]);

  for (const g of byUser.values()) {
    const L = g.worker ? billLabor(g, { settings, projectRateMap, rateBook, from, to, span, leaveDays, ledger, force }) : null;
    g.labor = L && (g.billable.length || L.rangeLines.length) ? L : null;
  }
  return Array.from(byUser.values()).filter(g => g.billable.length || g.reimbursements.length || g.labor);
}

/**
 * Price one worker's NEW entries (+ unbilled range-level pay) with the pay engine
 * and split the result into bill lines (amounts in integer cents). Worked pay is
 * statement(billed + new) − statement(billed); range-level pay is current −
 * ledgered. Sum of every line === totalC.
 */
function billLabor(g, { settings, projectRateMap, rateBook = null, from, to, span = null, leaveDays = null, ledger = new Map(), force = false }) {
  // The weekly guarantee is priced per week below, not over the range.
  const worker = { ...g.worker, guaranteed_weekly_hours: 0 };
  const otConfig = otConfigFromSettings(settings, worker.role_id ?? null, worker.id);
  const leaveDaysOf = (leaveDays && leaveDays.get(worker.id)) || new Map();
  const fullRange = !!(from && to);
  const rangeLeave = fullRange ? leaveBetween(leaveDaysOf, from, to) : NO_LEAVE;
  const statement = entries => buildPayStatement({
    worker,
    entries,
    weekContextEntries: g.context.map(copyRow),
    reimbursements: [],
    leave: rangeLeave, // only so no-clock-in floors count leave; leave $ is ledgered below
    deductions: [], // a bill is gross pay; deductions are the payer's side
    otConfig,
    projectRateMap,
    rateBook,
    settings,
    from: from || null,
    to: to || null,
    weekWorkedDays: g.workedDates,
  });
  const billedIds = new Set(g.billed.map(e => e.id));
  const stmt = statement([...g.billed, ...g.billable].map(copyRow));
  const prev = g.billed.length ? statement(g.billed.map(copyRow)) : null;

  const { rate, rateType, prevailingWageRate } = stmt.rates;
  const shiftHours = parseFloat(settings.regular_shift_hours) || 8;
  const paidHoursOf = entryDuration; // the engine's paid hours (DST-corrected) — lines must reconcile to the statement
  // The engine stamps each row with the rate it was priced at (pay_rate — the rate
  // in effect on that work_date); the fallbacks only cover a hand-built statement.
  const baseRateOf = e => (e.pay_rate != null ? e.pay_rate : (e.wage_type === 'prevailing'
    ? (projectRateMap[e.project_id] != null ? projectRateMap[e.project_id] : prevailingWageRate)
    : rate));
  const rateTypeOf = e => e.pay_rate_type || rateType;
  // Rule-generated hours on date d: the worker's rate in effect that day.
  const rateOnDate = d => (rateBook ? workerRateOn(rateBook, worker, d, settings) : { rate, rateType });
  const hourlyOn = d => { const r = rateOnDate(d); return r.rateType === 'daily' ? (shiftHours > 0 ? r.rate / shiftHours : 0) : r.rate; };

  // Rule-generated hours (min-daily floor top-ups, no-clock-in guarantee days) are
  // inside the statement's regular pay; priced out as their own (ledgered) lines.
  const floorsOf = s => s.entries
    .filter(e => e.synthetic && !RANGE_LEVEL_KINDS.has(e.kind))
    .map(f => {
      const r = rateOnDate(f.work_date);
      const fHourly = r.rateType === 'daily' ? (shiftHours > 0 ? r.rate / shiftHours : 0) : r.rate;
      const perHour = r.rateType === 'daily' ? (f.kind === 'guarantee' ? fHourly : 0) : r.rate;
      const hours = parseFloat(f.hours) || 0;
      return { date: isoDate(f.work_date), kind: f.kind, hours, amountC: toCents(hours * perHour) };
    });
  const workedC = s => {
    const c = s.cost;
    return toCents(c.regular) + toCents(c.overtime) + toCents(c.prevailing) + toCents(c.night)
      - floorsOf(s).reduce((sum, f) => sum + f.amountC, 0);
  };

  // Straight time for the NEW entries only. Daily-rate workers: each worked day
  // pays the daily rate once — a day already on a bill adds nothing; a new day's
  // rate is split across its entries by hours so every project gets its share.
  const real = stmt.entries.filter(e => !e.synthetic && !billedIds.has(e.id));
  const isDailyReg = e => e.wage_type === 'regular' && rateTypeOf(e) === 'daily';
  const billedDays = new Set(stmt.entries.filter(e => !e.synthetic && billedIds.has(e.id) && isDailyReg(e)).map(e => e.work_date));
  const dayHours = new Map(), dayCount = new Map();
  for (const e of real) {
    if (!isDailyReg(e)) continue;
    dayHours.set(e.work_date, (dayHours.get(e.work_date) || 0) + paidHoursOf(e));
    dayCount.set(e.work_date, (dayCount.get(e.work_date) || 0) + 1);
  }
  const entryLines = real.map(e => {
    const hours = paidHoursOf(e);
    if (isDailyReg(e)) {
      if (billedDays.has(e.work_date)) return { entry: e, hours, unitPrice: 0, amountC: 0 };
      const dh = dayHours.get(e.work_date) || 0;
      const share = dh > 0 ? hours / dh : 1 / (dayCount.get(e.work_date) || 1);
      const amount = baseRateOf(e) * share; // that day's daily rate, split by hours
      return { entry: e, hours, unitPrice: hours > 0 ? amount / hours : amount, amountC: toCents(amount) };
    }
    const base = baseRateOf(e);
    return { entry: e, hours, unitPrice: base, amountC: toCents(hours * base) };
  });

  // ── Range-level pay: current amounts, keyed like the ledger ──
  const inRange = d => (!from || d >= from) && (!to || d <= to);
  const current = new Map();
  const put = (kind, date, hours, amountC, label) => {
    if (!amountC) return;
    const k = `${kind}|${date}`;
    const cur = current.get(k) || { kind, date, hours: 0, amountC: 0, label };
    cur.hours += hours; cur.amountC += amountC;
    current.set(k, cur);
  };
  for (const f of floorsOf(stmt)) {
    if (inRange(f.date)) put('daily_floor', f.date, f.hours, f.amountC, f.kind === 'guarantee' ? 'Guaranteed hours (no clock-in)' : 'Minimum daily hours top-up');
  }
  if (fullRange) {
    const mult = leaveRateMultipliers(settings);
    for (const [d, v] of leaveDaysOf) {
      if (!inRange(d)) continue;
      if (v.sick) put('sick', d, v.sick, toCents(v.sick * hourlyOn(d) * mult.sick));
      if (v.vacation) put('vacation', d, v.vacation, toCents(v.vacation * hourlyOn(d) * mult.vacation));
    }
    // Weekly guarantee: one engine statement per whole week whose LAST day is in
    // the range (every entry of that week, billed or not, + that week's leave).
    if (span && parseFloat(g.worker.guaranteed_weekly_hours) > 0) {
      const all = [...g.context, ...g.billed, ...g.billable];
      for (let ws = span.from; ws <= span.to; ws = addDaysYmd(ws, 7)) {
        const we = addDaysYmd(ws, 6);
        if (!inRange(we)) continue;
        const wk = buildPayStatement({
          worker: g.worker,
          entries: all.filter(e => e.work_date >= ws && e.work_date <= we).map(copyRow),
          reimbursements: [], deductions: [],
          leave: leaveBetween(leaveDaysOf, ws, we),
          otConfig, projectRateMap, rateBook, settings, from: ws, to: we,
          weekWorkedDays: g.workedDates,
        });
        put('weekly_guarantee', ws, wk.hours.guaranteeShortfall || 0, toCents(wk.cost.guarantee));
      }
    }
  }

  // ── Diff against the ledger ──
  const inScope = (kind, date) => (kind === 'weekly_guarantee'
    ? fullRange && inRange(addDaysYmd(date, 6))
    : (kind === 'daily_floor' || fullRange) && inRange(date));
  const keys = new Set(current.keys());
  const prefix = `${worker.id}|`;
  for (const k of ledger.keys()) {
    if (!k.startsWith(prefix)) continue;
    const [kind, date] = k.slice(prefix.length).split('|');
    if (inScope(kind, date)) keys.add(`${kind}|${date}`);
  }
  const deltas = [], ledgerWrites = [];
  for (const k of [...keys].sort((a, b) => a.split('|')[1].localeCompare(b.split('|')[1]) || a.localeCompare(b))) {
    const [kind, date] = k.split('|');
    const cur = current.get(k) || { kind, date, hours: 0, amountC: 0, label: null };
    const stored = ledger.get(`${prefix}${k}`) || null;
    const was = force || !stored ? { amountC: 0, hours: 0 } : stored;
    const deltaC = cur.amountC - was.amountC;
    if (deltaC !== 0) deltas.push({ ...cur, deltaC, deltaHours: +(cur.hours - was.hours).toFixed(2), adjustment: was.amountC !== 0 });
    if (!stored ? cur.amountC !== 0 : (stored.amountC !== cur.amountC || force)) {
      ledgerWrites.push({ kind, date, amountC: cur.amountC, hours: +cur.hours.toFixed(2) });
    }
  }
  const rangeLines = [];
  for (const d of deltas.filter(x => x.kind === 'daily_floor')) {
    rangeLines.push({ key: `daily_floor|${d.date}`, hours: d.deltaHours, amountC: d.deltaC, description: `${d.date} · ${d.label || 'Minimum daily hours'}${d.adjustment ? ' (adjustment)' : ''}` });
  }
  for (const d of deltas.filter(x => x.kind === 'weekly_guarantee')) {
    rangeLines.push({ key: `weekly_guarantee|${d.date}`, hours: d.deltaHours, amountC: d.deltaC, description: `Weekly guaranteed-hours top-up — week of ${d.date}${d.adjustment ? ' (adjustment)' : ''}` });
  }
  for (const [kind, label] of [['sick', 'Paid sick leave'], ['vacation', 'Paid vacation']]) {
    const ds = deltas.filter(x => x.kind === kind);
    if (!ds.length) continue;
    const amountC = ds.reduce((s, x) => s + x.deltaC, 0);
    if (!amountC) continue;
    const dates = ds.map(x => x.date);
    const shown = dates.length > 10 ? `${dates.slice(0, 10).join(', ')} +${dates.length - 10} more` : dates.join(', ');
    rangeLines.push({
      key: `${kind}|${dates.join(',')}`,
      hours: +ds.reduce((s, x) => s + x.deltaHours, 0).toFixed(2),
      amountC,
      description: `${label}${ds.some(x => x.adjustment) ? ' adjustment' : ''} — ${shown}`,
    });
  }

  const nightC = toCents(stmt.cost.night) - (prev ? toCents(prev.cost.night) : 0);
  const nightHours = (stmt.hours.night || 0) - (prev ? (prev.hours.night || 0) : 0);
  const workedTargetC = workedC(stmt) - (prev ? workedC(prev) : 0);
  const straightC = entryLines.reduce((s, l) => s + l.amountC, 0);
  const rangeC = rangeLines.reduce((s, l) => s + l.amountC, 0);
  // The OT premium is what the engine paid beyond straight time — tiers, rest-day,
  // 7th-day, weighted-average and prevailing OT all land here at their real price
  // (and, on a follow-up bill, the OT the new rows added to the week).
  const premiumC = workedTargetC - straightC - nightC;
  const overtimeHours = +((stmt.hours.overtime || 0) - (prev ? (prev.hours.overtime || 0) : 0)).toFixed(2);
  const bands = prev ? '' : (stmt.hours.overtimeBands || []).map(b => `${Number(b.hours).toFixed(2)} h @ ${b.mult}×`).join(', ');
  const rule = otRuleFromSettings(settings, worker.overtime_rule);

  return {
    entryLines,
    rangeLines,
    ledgerWrites,
    premium: {
      hours: overtimeHours,
      amountC: premiumC,
      description: overtimeHours > 0
        ? `Overtime premium — ${bands || `${overtimeHours.toFixed(2)} h`} (${rule}${rule === 'none' ? '' : `, threshold ${otThreshold(settings, rule)} h`})`
        : 'Pay rounding adjustment',
    },
    night: { hours: nightHours, amountC: nightC },
    hours: entryLines.reduce((s, l) => s + l.hours, 0),
    rate,
    totalC: workedTargetC + rangeC,
    includeRangeLevel: rangeLines.length > 0,
  };
}

// Bill lines for one vendor group (labor from billLabor + reimbursements).
function billLinesFor(g, { laborItemId, expenseAccountId }) {
  const lines = [];
  const L = g.labor;
  if (L) {
    for (const l of L.entryLines) {
      if (l.amountC === 0 && l.hours <= 0) continue;
      const e = l.entry;
      lines.push({
        type: 'item', itemId: laborItemId,
        qty: l.hours, unitPrice: l.unitPrice, amount: l.amountC / 100,
        description: `${isoDate(e.work_date)}${e.project_name ? ' · ' + e.project_name : ''}${e.wage_type === 'prevailing' ? ' (prevailing)' : ''}${e.notes ? ' — ' + e.notes : ''}`.slice(0, 4000),
        customerId: e.qbo_customer_id || null,
        classId: e.qbo_class_id || null,
      });
    }
    for (const l of L.rangeLines) {
      lines.push({ type: 'item', itemId: laborItemId, qty: l.hours, unitPrice: l.hours > 0 ? l.amountC / 100 / l.hours : l.amountC / 100, amount: l.amountC / 100, description: l.description });
    }
    if (L.premium.amountC !== 0) {
      const h = L.premium.hours;
      lines.push({ type: 'item', itemId: laborItemId, qty: h > 0 ? h : 1, unitPrice: h > 0 ? L.premium.amountC / 100 / h : L.premium.amountC / 100, amount: L.premium.amountC / 100, description: L.premium.description });
    }
    if (L.night.amountC !== 0) {
      const h = L.night.hours;
      lines.push({ type: 'item', itemId: laborItemId, qty: h > 0 ? h : 1, unitPrice: h > 0 ? L.night.amountC / 100 / h : L.night.amountC / 100, amount: L.night.amountC / 100, description: `Night differential premium on ${h.toFixed(2)} h` });
    }
  }
  for (const r of g.reimbursements) {
    lines.push({
      type: 'account',
      accountId: expenseAccountId,
      amount: r.amount,
      description: `${isoDate(r.expenseDate)}${r.projectName ? ' · ' + r.projectName : ''}${r.description ? ' — ' + r.description : ''}`.slice(0, 4000),
      customerId: r.customerId,
      classId: r.classId,
    });
  }
  return lines;
}

// Intuit requestid for a vendor bill: the CONTENT (entry + reimbursement ids and
// amounts), not just vendor+range. Keyed by range alone, re-pushing the range after
// a late approval got the ORIGINAL bill back from Intuit's dedupe and stamped the
// new entries with it, so they were never billed. A force re-push is versioned by
// the bill(s) it replaces, so it creates a new bill but a double-click still dedupes.
function billRequestId(companyId, g, { from, to, force, totalC }) {
  const te = (g.labor ? g.labor.entryLines : []).map(l => `${l.entry.id}:${l.amountC}`).sort().join(',');
  const rb = g.reimbursements.map(r => `${r.id}:${toCents(r.amount)}`).sort().join(',');
  const rl = (g.labor ? g.labor.rangeLines : []).map(l => `${l.key}:${l.amountC}`).sort().join(',');
  const prior = force
    ? [...new Set([...g.billable.map(e => e.qbo_bill_id), ...g.reimbursements.map(r => r.qboBillId)].filter(Boolean))].sort().join(',')
    : '';
  return `ops-bill-${sha([companyId, g.vendorId, from || '', to || '', `te:${te}`, `r:${rb}`, ...(rl ? [`rl:${rl}`] : []), `t:${totalC}`, force ? `f:${prior}` : ''].join('|'))}`;
}

// POST /api/qbo/push-bills-preview — dry-run summary of what would be billed
// Body: { from, to, worker_ids, force }
router.post('/push-bills-preview', requireAdmin, requirePerm('manage_integrations'), async (req, res) => {
  const { from, to, worker_ids, force } = req.body;
  if (badRange(from, to)) return res.status(400).json({ error: 'from and to must be valid dates in ascending order', code: 'invalid_date_range' });
  try {
    // Settings first: gatherBillData needs the policy to compute the PAID punch.
    const settings = await loadSettings(req.user.company_id);
    const groups = await gatherBillData(req.user.company_id, { from, to, workerIds: worker_ids, force }, settings);
    const result = groups.map(g => {
      const L = g.labor;
      const reimbC = g.reimbursements.reduce((s, r) => s + toCents(r.amount), 0);
      const straightC = L ? L.entryLines.reduce((s, l) => s + l.amountC, 0) : 0;
      const rangeC = L ? L.rangeLines.reduce((s, l) => s + l.amountC, 0) : 0;
      return {
        user_id: g.userId,
        full_name: g.fullName,
        hourly_rate: L ? L.rate : (parseFloat(g.worker?.hourly_rate) || 0),
        time_entries: g.billable.length,
        hours: L ? parseFloat(L.hours.toFixed(2)) : 0,
        // Straight time + rule-generated pay (floors, weekly guarantee, leave).
        labor_amount: (straightC + rangeC) / 100,
        other_pay: rangeC / 100,
        overtime_hours: L ? parseFloat((L.premium.hours || 0).toFixed(2)) : 0,
        overtime_premium: L ? L.premium.amountC / 100 : 0,
        night_hours: L ? parseFloat((L.night.hours || 0).toFixed(2)) : 0,
        night_premium: L ? L.night.amountC / 100 : 0,
        range_level_pay_included: L ? L.includeRangeLevel : true,
        reimbursements: g.reimbursements.length,
        reimb_amount: reimbC / 100,
        time_entry_rows: (L ? L.entryLines : []).map(l => ({
          id: l.entry.id,
          work_date: isoDate(l.entry.work_date),
          hours: parseFloat(l.hours.toFixed(2)),
          amount: l.amountC / 100,
          project_name: l.entry.project_name || '',
          description: l.entry.notes || '',
        })),
        reimbursement_rows: g.reimbursements.map(r => ({
          id: r.id,
          expense_date: isoDate(r.expenseDate),
          amount: toCents(r.amount) / 100,
          project_name: r.projectName,
          description: r.description,
        })),
        total: ((L ? L.totalC : 0) + reimbC) / 100,
      };
    });
    const rule = otRuleFromSettings(settings, null);
    res.json({ groups: result, overtime: { rule, threshold: otThreshold(settings, rule), multiplier: parseFloat(settings.overtime_multiplier) || 1.5 } });
  } catch (err) {
    logger.error({ err }, 'push-bills-preview error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/qbo/push-bills — create one QBO Bill per vendor
// Body: { from, to, worker_ids, force }
router.post('/push-bills', requireAdmin, requirePerm('manage_integrations'), async (req, res) => {
  const { from, to, worker_ids, force } = req.body;
  const companyId = req.user.company_id;
  if (badRange(from, to)) return res.status(400).json({ error: 'from and to must be valid dates in ascending order', code: 'invalid_date_range' });
  try {
    const settingRows = await pool.query(
      "SELECT key, value FROM settings WHERE company_id = $1 AND key IN ('qbo_expense_account_id', 'qbo_labor_item_id', 'qbo_bill_terms_days')",
      [companyId]
    );
    const expenseAccountId = settingRows.rows.find(r => r.key === 'qbo_expense_account_id')?.value;
    const laborItemId      = settingRows.rows.find(r => r.key === 'qbo_labor_item_id')?.value;
    const termsDays        = parseInt(settingRows.rows.find(r => r.key === 'qbo_bill_terms_days')?.value || '0', 10);

    if (!laborItemId) return res.status(400).json({ error: 'Configure a Labor Service Item before pushing bills.' });

    const company = await pool.query('SELECT qbo_realm_id FROM companies WHERE id = $1', [companyId]);
    if (!company.rows[0]?.qbo_realm_id) return res.status(400).json({ error: 'QuickBooks not connected' });

    const settings = await loadSettings(companyId);
    const groups = await gatherBillData(companyId, { from, to, workerIds: worker_ids, force }, settings);

    // Only require the expense account when we actually need it (any reimbursement
    // line in this push). Contractors paid for time only don't need it.
    const anyReimbursements = groups.some(g => g.reimbursements.length > 0);
    if (anyReimbursements && !expenseAccountId) {
      return res.status(400).json({ error: 'Some contractors have reimbursements — set a Reimbursement Expense Account before pushing.' });
    }

    const today = new Date().toLocaleDateString('en-CA');
    const dueDate = (() => {
      if (!termsDays) return null;
      const d = new Date(); d.setDate(d.getDate() + termsDays);
      return d.toLocaleDateString('en-CA');
    })();

    const pushed = [];
    const skipped = [];

    for (const g of groups) {
      const lines = billLinesFor(g, { laborItemId, expenseAccountId });
      if (!lines.length) continue;
      const totalC = lines.reduce((s, l) => s + toCents(l.amount != null ? l.amount : l.qty * l.unitPrice), 0);
      // A follow-up bill can net out negative (e.g. leave revoked after it was
      // billed). QuickBooks can't take a negative bill — that's a vendor credit.
      if (totalC < 0) {
        skipped.push({ user_id: g.userId, full_name: g.fullName, reason: `Net adjustment is −$${(-totalC / 100).toFixed(2)} (pay already billed was reduced) — record a vendor credit in QuickBooks.` });
        continue;
      }
      if (totalC === 0 && !g.billable.length && !g.reimbursements.length) continue;

      try {
        const bill = await qbo.createBill(companyId, {
          vendorId: g.vendorId,
          txnDate: today,
          dueDate,
          memo: `OpsFloa bill ${from || ''}–${to || ''} for ${g.fullName}`.trim(),
          lines,
          requestId: billRequestId(companyId, g, { from, to, force, totalC }),
        });
        // Defensive: if Intuit hands back a bill that isn't this content (a dedupe
        // hit on some other bill), don't stamp these rows with it — they'd never bill.
        if (bill && bill.TotalAmt != null && toCents(bill.TotalAmt) !== totalC) {
          skipped.push({
            user_id: g.userId, full_name: g.fullName,
            reason: `QuickBooks returned bill ${bill.Id} for $${Number(bill.TotalAmt).toFixed(2)}, expected $${(totalC / 100).toFixed(2)} — rows were not marked billed.`,
          });
          continue;
        }
        const billId = bill?.Id || 'synced';
        const timeIds = g.billable.map(t => t.id);
        const reimbIds = g.reimbursements.map(r => r.id);
        if (timeIds.length) {
          await pool.query(
            "UPDATE time_entries SET qbo_bill_id = $1, qbo_synced_at = NOW() WHERE id = ANY($2::int[])",
            [billId, timeIds]
          );
        }
        if (reimbIds.length) {
          await pool.query(
            "UPDATE reimbursements SET qbo_bill_id = $1, qbo_synced_at = NOW() WHERE id = ANY($2::int[])",
            [billId, reimbIds]
          );
        }
        // Record the range-level pay this bill carries (current amounts), so the
        // next bill for an overlapping range posts only the difference.
        const lw = (g.labor ? g.labor.ledgerWrites : []).filter(w => QBO_BILL_RANGE_PAY_KINDS.includes(w.kind));
        if (lw.length) {
          // The bill exists and its rows are stamped — a failed ledger write must
          // not report it as skipped; log it (the next push would re-bill the diff).
          await pool.query(
            `INSERT INTO qbo_bill_range_pay (company_id, user_id, kind, pay_date, amount_cents, hours, qbo_bill_id)
             SELECT $1, t.user_id, t.kind, t.pay_date::date, t.amount_cents, t.hours, $7
               FROM unnest($2::int[], $3::text[], $4::text[], $5::bigint[], $6::numeric[])
                    AS t(user_id, kind, pay_date, amount_cents, hours)
             ON CONFLICT (company_id, user_id, kind, pay_date)
             DO UPDATE SET amount_cents = EXCLUDED.amount_cents, hours = EXCLUDED.hours,
                           qbo_bill_id = EXCLUDED.qbo_bill_id, updated_at = NOW()`,
            [companyId, lw.map(() => g.userId), lw.map(w => w.kind), lw.map(w => w.date), lw.map(w => w.amountC), lw.map(w => w.hours), billId]
          ).catch(ledgerErr => logger.error({ err: ledgerErr, billId, userId: g.userId }, 'push-bills: range-pay ledger write failed'));
        }
        pushed.push({ user_id: g.userId, full_name: g.fullName, bill_id: billId, time_entries: timeIds.length, reimbursements: reimbIds.length, total: totalC / 100 });
      } catch (pushErr) {
        skipped.push({ user_id: g.userId, full_name: g.fullName, reason: pushErr.response?.data?.Fault?.Error?.[0]?.Detail || pushErr.message });
      }
    }

    logAudit(req.user.company_id, req.user.id, req.user.full_name, 'qbo.bills_pushed', null, null, null,
      { pushed: pushed.length, skipped: skipped.length, from, to });
    res.json({ pushed, skipped });
  } catch (err) {
    logger.error({ err }, 'push-bills error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/qbo/push-payroll — push a payroll journal entry for a date range
// Body: { from, to, debit_account_id, credit_account_id }
//
// Every posting is recorded in qbo_payroll_journals (0207), so a push can see
// what's already in QuickBooks for the range:
//   - nothing yet            → post the gross
//   - same range, same total → no-op, reported as already_posted
//   - same range, new total  → post the DIFFERENCE as an adjustment (reversed
//                              debit/credit when the total went down)
//   - an OVERLAPPING range   → 409, never double-post the overlap
// Before, the Intuit key was company|from|to only: a corrected re-push silently
// returned the original JE, and an overlapping range posted the overlap twice.
router.post('/push-payroll', requireAdmin, requirePerm('manage_integrations'), requirePerm('manage_pay_periods'), requirePerm('view_worker_wages'), async (req, res) => {
  const { from, to, debit_account_id, credit_account_id } = req.body;
  if (!debit_account_id || !credit_account_id) {
    return res.status(400).json({ error: 'debit_account_id and credit_account_id are required' });
  }
  if (!from || !to) return res.status(400).json({ error: 'from and to date range are required' });
  if (!isValidIsoDate(from) || !isValidIsoDate(to) || from > to) {
    return res.status(400).json({ error: 'from and to must be valid dates in ascending order', code: 'invalid_date_range' });
  }
  if (dateRangeDays(from, to) > 366) {
    return res.status(400).json({ error: 'Payroll journal range cannot exceed 366 days', code: 'date_range_too_large' });
  }

  const companyId = req.user.company_id;
  try {
    const company = await pool.query('SELECT qbo_realm_id FROM companies WHERE id = $1', [companyId]);
    if (!company.rows[0]?.qbo_realm_id) return res.status(400).json({ error: 'QuickBooks not connected' });

    const payrollSettings = await loadSettings(companyId);
    // Everyone with pay in the range, NOT just today's active workers: a corrected
    // re-push after a worker was deactivated (or who logs time without the worker
    // role) used to drop them from the total and post a diff reversing their wages.
    // Active workers stay in for range-level pay (weekly guarantee) with no entries.
    const workers = await pool.query(
      `SELECT u.id, u.full_name, u.invoice_name, u.hourly_rate, u.rate_type, u.overtime_rule,
              u.role_id, u.guaranteed_weekly_hours
         FROM users u
        WHERE u.company_id = $1 AND u.worker_type <> 'unpaid'
          AND ((u.role = 'worker' AND u.active = true)
               OR EXISTS (SELECT 1 FROM time_entries te
                           WHERE te.user_id = u.id AND te.company_id = $1 AND te.status = 'approved'
                             AND te.work_date >= $2::date AND te.work_date <= $3::date)
               OR EXISTS (SELECT 1 FROM time_off_requests r
                           WHERE r.user_id = u.id AND r.company_id = $1 AND r.status = 'approved'
                             AND r.type IN ('sick','vacation')
                             AND r.start_date <= $3::date AND r.end_date >= $2::date))
        ORDER BY u.full_name`,
      [companyId, from, to]
    );
    const statements = await companyStatements({
      companyId,
      workers: workers.rows,
      settings: payrollSettings,
      from,
      to,
    });
    const payable = workers.rows
      .map(worker => ({ worker, statement: statements.get(worker.id) }))
      .filter(row => row.statement && row.statement.totals.grossWages > 0);
    const totalCents = payable.reduce(
      (sum, row) => sum + Math.round(row.statement.totals.grossWages * 100),
      0
    );

    const prior = await pool.query(
      `SELECT to_char(period_from, 'YYYY-MM-DD') AS period_from, to_char(period_to, 'YYYY-MM-DD') AS period_to,
              amount_cents, qbo_entry_id
         FROM qbo_payroll_journals
        WHERE company_id = $1 AND period_from <= $3::date AND period_to >= $2::date
        ORDER BY created_at, id`,
      [companyId, from, to]
    );
    const overlapping = prior.rows.filter(j => j.period_from !== from || j.period_to !== to);
    if (overlapping.length) {
      const ranges = [...new Set(overlapping.map(j => `${j.period_from} – ${j.period_to}`))];
      return res.status(409).json({
        error: `A payroll journal was already posted for an overlapping range (${ranges.join(', ')}). Push exactly that range to post a correction, or pick a range that doesn't overlap.`,
        code: 'overlapping_payroll_journal',
        ranges,
      });
    }
    const postedCents = prior.rows.reduce((s, j) => s + Number(j.amount_cents || 0), 0);
    if (!prior.rows.length && totalCents <= 0) return res.status(400).json({ error: 'No approved payroll found for this date range' });

    const totalCost = totalCents / 100;
    const deltaCents = totalCents - postedCents;
    if (deltaCents === 0) {
      const last = prior.rows[prior.rows.length - 1];
      return res.json({
        already_posted: true, entry_id: last?.qbo_entry_id || null, amount: 0, payroll_total: totalCost, workers: payable.length,
        description: `Payroll ${from} – ${to} already posted`,
        message: `Already posted — QuickBooks has $${totalCost.toFixed(2)} for ${from} – ${to}. Nothing to add.`,
      });
    }

    const isAdjustment = prior.rows.length > 0;
    const amountCents = Math.abs(deltaCents);
    const reverse = deltaCents < 0;
    const description = isAdjustment
      ? `Payroll adjustment ${from} – ${to}: ${reverse ? '−' : '+'}$${(amountCents / 100).toFixed(2)} (total now $${totalCost.toFixed(2)}, ${payable.length} workers)`
      : `Payroll ${from} – ${to} (${payable.length} workers)`;
    // Intuit guarantees write idempotency for a repeated requestid. The FIRST
    // posting of a range keeps the period key it always had, so a range posted
    // before this ledger existed still dedupes instead of double-posting; every
    // later posting is keyed by what's already posted + the new content.
    const workerSig = payable.map(r => `${r.worker.id}:${Math.round(r.statement.totals.grossWages * 100)}`).sort().join(',');
    const requestId = isAdjustment
      ? `ops-pay-${sha(`${companyId}|${from}|${to}|posted:${postedCents}|n:${prior.rows.length}|total:${totalCents}|${workerSig}`)}`
      : `ops-pay-${sha(`${companyId}|${from}|${to}`)}`;
    const entry = await qbo.createJournalEntry(companyId, {
      txnDate: to,
      description,
      debitAccountId: reverse ? credit_account_id : debit_account_id,
      creditAccountId: reverse ? debit_account_id : credit_account_id,
      amount: amountCents / 100,
      requestId,
    });

    // What QuickBooks actually holds for this posting. A first-posting key can hit
    // a journal created before this ledger existed, with a different amount —
    // record THAT amount so the next push posts the true difference.
    const returnedCents = entry && entry.TotalAmt != null ? Math.round(Number(entry.TotalAmt) * 100) : null;
    const recordedCents = (!isAdjustment && returnedCents != null && returnedCents !== amountCents)
      ? returnedCents
      : (reverse ? -amountCents : amountCents);
    await pool.query(
      `INSERT INTO qbo_payroll_journals
         (company_id, period_from, period_to, amount_cents, request_id, qbo_entry_id, debit_account_id, credit_account_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (company_id, request_id) DO NOTHING`,
      [companyId, from, to, recordedCents, requestId, entry?.Id || null, String(debit_account_id), String(credit_account_id), req.user.id]
    );
    const mismatch = recordedCents !== (reverse ? -amountCents : amountCents);

    logAudit(companyId, req.user.id, req.user.full_name, 'qbo.payroll_journal_pushed', 'qbo_journal', entry?.Id || null, description,
      { amount: amountCents / 100, reverse, adjustment: isAdjustment, payroll_total: totalCost, from, to, workers: payable.length, request_id: requestId });
    res.json({
      entry_id: entry?.Id, amount: amountCents / 100, workers: payable.length, request_id: requestId, description,
      adjustment: isAdjustment, reversed: reverse, payroll_total: totalCost,
      ...(mismatch ? {
        message: `QuickBooks already had a journal for ${from} – ${to} ($${(recordedCents / 100).toFixed(2)}). Push again to post the $${((totalCents - recordedCents) / 100).toFixed(2)} difference.`,
      } : {}),
    });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    const status = err.code === 'qbo_auth_expired' ? 401 : 500;
    res.status(status).json({ error: err.code === 'qbo_auth_expired' ? err.message : 'Server error', code: err.code });
  }
});

// POST /api/qbo/retry-error/:id — retry a failed QBO sync entry
router.post('/retry-error/:id', requireAdmin, requirePerm('manage_integrations'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const errRow = await pool.query(
      'SELECT * FROM qbo_sync_errors WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!errRow.rows.length) return res.status(404).json({ error: 'Error record not found' });
    const { entity_type, entity_id } = errRow.rows[0];

    if (entity_type === 'reimbursement') {
      const [reimb, settings] = await Promise.all([
        pool.query(
          `SELECT r.*, u.qbo_vendor_id, u.worker_type FROM reimbursements r JOIN users u ON r.user_id = u.id
           WHERE r.id = $1 AND r.company_id = $2`,
          [entity_id, companyId]
        ),
        pool.query(
          "SELECT key, value FROM settings WHERE company_id = $1 AND key IN ('qbo_expense_account_id', 'qbo_bank_account_id')",
          [companyId]
        ),
      ]);
      if (!reimb.rows.length) return res.status(404).json({ error: 'Reimbursement not found' });
      const r = reimb.rows[0];
      const expenseAccountId = settings.rows.find(s => s.key === 'qbo_expense_account_id')?.value;
      const bankAccountId = settings.rows.find(s => s.key === 'qbo_bank_account_id')?.value;
      if (!expenseAccountId || !bankAccountId) return res.status(400).json({ error: 'Configure expense and bank accounts in QBO settings first' });
      const vendorId = (r.worker_type === 'contractor' || r.worker_type === 'subcontractor') ? r.qbo_vendor_id : null;
      const txnDate = r.expense_date ? r.expense_date.toISOString?.().substring(0, 10) || String(r.expense_date).substring(0, 10) : null;
      const purchase = await qbo.createPurchase(companyId, {
        bankAccountId, expenseAccountId, vendorId,
        amount: parseFloat(r.amount),
        description: r.description || r.category || 'Expense reimbursement',
        txnDate,
        // SAME key as the auto-sync and batch-push paths — a recorded error usually means
        // the response was lost AFTER QBO created the Purchase, so retry must dedup, not
        // create a second Purchase for the same reimbursement.
        requestId: `ops-reimb-${entity_id}`,
      });
      await pool.query(
        'UPDATE reimbursements SET qbo_purchase_id = $1, qbo_synced_at = NOW() WHERE id = $2',
        [purchase?.Id || 'synced', entity_id]
      );
    } else if (entity_type === 'time_entry') {
      const entry = await pool.query(
        `SELECT te.*, u.qbo_employee_id, u.qbo_vendor_id, u.worker_type, u.role_id, p.qbo_customer_id, p.qbo_class_id
         FROM time_entries te JOIN users u ON te.user_id = u.id LEFT JOIN projects p ON te.project_id = p.id
         WHERE te.id = $1 AND te.company_id = $2`,
        [entity_id, companyId]
      );
      if (!entry.rows.length) return res.status(404).json({ error: 'Time entry not found' });
      const retryRow = entry.rows[0];
      const [{ entry: e, hours, workDate }] = qbo.timeActivityHours(entry.rows, await loadSettings(companyId), { [retryRow.user_id]: retryRow.role_id });
      if (e.worker_type === 'unpaid') return res.status(400).json({ error: 'Worker is unpaid — labor is not synced to QuickBooks' });
      const usesVendor = e.worker_type === 'contractor' || e.worker_type === 'subcontractor';
      const mappedId = usesVendor ? e.qbo_vendor_id : e.qbo_employee_id;
      if (!mappedId) return res.status(400).json({ error: 'Worker has no QBO mapping — set it in QuickBooks settings first' });
      if (!e.qbo_customer_id) return res.status(400).json({ error: 'Project has no QBO customer mapping — set it in QuickBooks settings first' });
      const activity = await qbo.pushTimeActivity(companyId, {
        ...(usesVendor ? { vendorId: e.qbo_vendor_id } : { employeeId: e.qbo_employee_id }),
        customerId: e.qbo_customer_id,
        classId: e.qbo_class_id || null,
        workDate, hours, description: e.notes || '',
        requestId: `ops-ta-${entity_id}`, // same key as manual + auto-sync so retry dedups
      });
      await pool.query(
        'UPDATE time_entries SET qbo_activity_id = $1, qbo_synced_at = NOW() WHERE id = $2',
        [activity?.Id || 'synced', entity_id]
      );
    } else {
      return res.status(400).json({ error: `Retry not supported for entity type: ${entity_type}` });
    }

    // Success — clear the error record
    await pool.query('DELETE FROM qbo_sync_errors WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    res.json({ retried: true });
  } catch (err) {
    logger.error({ err }, '[QBO retry-error]');
    const status = err.code === 'qbo_auth_expired' ? 401 : 500;
    res.status(status).json({ error: err.code === 'qbo_auth_expired' ? err.message : err.message || 'Retry failed', code: err.code });
  }
});

// POST /api/qbo/workers/create-vendor — create a QBO Vendor for a worker and save vendor ID
router.post('/workers/create-vendor', requireAdmin, requirePerm('manage_integrations'), async (req, res) => {
  const { user_id, display_name } = req.body;
  if (!user_id || !display_name) return res.status(400).json({ error: 'user_id and display_name are required' });
  try {
    // Verify worker belongs to company
    const worker = await pool.query(
      'SELECT id, worker_type FROM users WHERE id = $1 AND company_id = $2',
      [user_id, req.user.company_id]
    );
    if (!worker.rows.length) return res.status(404).json({ error: 'Worker not found' });

    const vendor = await qbo.createVendor(req.user.company_id, { displayName: display_name });
    if (!vendor?.Id) return res.status(500).json({ error: 'QBO did not return a vendor ID' });

    await pool.query(
      'UPDATE users SET qbo_vendor_id = $1 WHERE id = $2 AND company_id = $3',
      [vendor.Id, user_id, req.user.company_id]
    );
    res.json({ qbo_vendor_id: vendor.Id, display_name: vendor.DisplayName });
  } catch (err) {
    logger.error({ err }, '[QBO create-vendor]');
    const status = err.code === 'qbo_auth_expired' ? 401 : 500;
    res.status(status).json({ error: err.code === 'qbo_auth_expired' ? err.message : 'Failed to create vendor in QuickBooks', code: err.code });
  }
});

module.exports = router;
module.exports.oauthCallback = oauthCallback;
