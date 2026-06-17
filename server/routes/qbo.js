const router = require('express').Router();
const pool = require('../db');
const logger = require('../logger');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const qbo = require('../services/qbo');
const { encrypt } = require('../services/encryption');
const { applySettingsRows, ADMIN_SETTINGS_DEFAULTS } = require('../settingsDefaults');
const { computeOT } = require('../utils/payCalculations');
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

// GET /api/qbo/connect — returns the Intuit OAuth URL to redirect the user to
router.get('/connect', requireAdmin, async (req, res) => {
  if (!process.env.QBO_CLIENT_ID || !process.env.QBO_REDIRECT_URI) {
    return res.status(503).json({ error: 'QuickBooks integration not configured' });
  }
  // Generate a CSRF nonce, store it, encode it in state
  const nonce = crypto.randomBytes(16).toString('hex');
  await pool.query('UPDATE companies SET qbo_oauth_nonce = $1 WHERE id = $2', [nonce, req.user.company_id]);
  const state = Buffer.from(JSON.stringify({ company_id: req.user.company_id, nonce })).toString('base64');
  res.json({ url: qbo.getAuthUrl(state) });
});

// GET /api/qbo/callback — Intuit redirects here after user authorizes
// This handler is exported and registered WITHOUT auth middleware in index.js
async function oauthCallback(req, res) {
  const { code, state, realmId } = req.query;
  if (!code || !state || !realmId) {
    return res.redirect(`${process.env.APP_URL}/administration#qbo?error=missing_params`);
  }
  try {
    const { company_id, nonce } = JSON.parse(Buffer.from(state, 'base64').toString());

    // CSRF check — verify nonce matches what we stored
    const nonceResult = await pool.query('SELECT qbo_oauth_nonce FROM companies WHERE id = $1', [company_id]);
    const storedNonce = nonceResult.rows[0]?.qbo_oauth_nonce;
    if (!nonce || !storedNonce || nonce !== storedNonce) {
      return res.redirect(`${process.env.APP_URL}/administration#qbo?error=invalid_state`);
    }

    const tokens = await qbo.exchangeCode(code);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    await pool.query(
      `UPDATE companies
       SET qbo_realm_id = $1, qbo_access_token = $2, qbo_refresh_token = $3,
           qbo_token_expires_at = $4, qbo_connected_at = NOW(),
           qbo_oauth_nonce = NULL, qbo_disconnected = false
       WHERE id = $5`,
      [encrypt(realmId), encrypt(tokens.access_token), encrypt(tokens.refresh_token), expiresAt, company_id]
    );
    res.redirect(`${process.env.APP_URL}/administration#integrations`);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.redirect(`${process.env.APP_URL}/administration#integrations?error=auth_failed`);
  }
}
router.get('/callback', oauthCallback);

// DELETE /api/qbo/disconnect
router.delete('/disconnect', requireAdmin, async (req, res) => {
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
router.patch('/workers/:id/mapping', requireAdmin, async (req, res) => {
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
router.patch('/projects/:id/mapping', requireAdmin, async (req, res) => {
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
router.post('/invoices', requireAdmin, async (req, res) => {
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
    });
    // Persist invoice record if project_id provided
    if (invoice?.Id && project_id) {
      pool.query(
        `INSERT INTO project_invoices (company_id, project_id, qbo_invoice_id, doc_number, amount, txn_date, balance, payment_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'unpaid')`,
        [req.user.company_id, project_id, invoice.Id, invoice.DocNumber || null, parsed,
         txn_date || new Date().toLocaleDateString('en-CA'), parsed]
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
    const { rows } = await pool.query(
      `SELECT id, qbo_invoice_id, doc_number, amount, txn_date, balance, payment_status, created_at, last_checked_at
       FROM project_invoices
       WHERE company_id = $1 AND project_id = $2
       ORDER BY created_at DESC`,
      [req.user.company_id, req.params.projectId]
    );
    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/qbo/invoices/:invoiceId/check-payment — refresh payment status from QBO
router.post('/invoices/:invoiceId/check-payment', requireAdmin, async (req, res) => {
  try {
    const invoice = await qbo.getInvoice(req.user.company_id, req.params.invoiceId);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found in QuickBooks' });

    const balance = parseFloat(invoice.Balance ?? invoice.TotalAmt ?? 0);
    const totalAmt = parseFloat(invoice.TotalAmt ?? 0);
    let payment_status = 'unknown';
    if (balance <= 0) payment_status = 'paid';
    else if (balance < totalAmt) payment_status = 'partial';
    else payment_status = 'unpaid';

    await pool.query(
      `UPDATE project_invoices
       SET balance = $1, payment_status = $2, last_checked_at = NOW()
       WHERE qbo_invoice_id = $3 AND company_id = $4`,
      [balance, payment_status, req.params.invoiceId, req.user.company_id]
    );

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
router.post('/expenses', requireAdmin, async (req, res) => {
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
    });
    res.json(purchase);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    const status = err.code === 'qbo_auth_expired' ? 401 : 500;
    res.status(status).json({ error: err.code === 'qbo_auth_expired' ? err.message : 'Server error', code: err.code });
  }
});

// POST /api/qbo/push — push time entries to QBO for a date range
// Body: { from, to, force } — force=true re-pushes already-synced entries
router.post('/push', requireAdmin, async (req, res) => {
  const { from, to, force } = req.body;
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `SELECT te.*, u.qbo_employee_id, u.qbo_vendor_id, u.worker_type, p.qbo_customer_id, p.qbo_class_id,
              u.full_name as worker_name, p.name as project_name
       FROM time_entries te
       JOIN users u ON te.user_id = u.id
       LEFT JOIN projects p ON te.project_id = p.id
       WHERE te.company_id = $1
         AND ($2::date IS NULL OR te.work_date >= $2::date)
         AND ($3::date IS NULL OR te.work_date <= $3::date)`,
      [companyId, from || null, to || null]
    );

    const entries = result.rows;
    const skipped = [];
    const pushed = [];
    let alreadySynced = 0;

    for (const entry of entries) {
      // Skip already-synced entries unless force re-push requested
      if (entry.qbo_activity_id && !force) {
        alreadySynced++;
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

      // Correct hours: handle midnight-crossing and subtract break minutes
      let ms = new Date(`1970-01-01T${entry.end_time}`) - new Date(`1970-01-01T${entry.start_time}`);
      if (ms < 0) ms += 86400000;
      const hours = Math.max(0, ms / 3600000 - (entry.break_minutes || 0) / 60);
      const workDate = entry.work_date.toISOString().substring(0, 10);

      try {
        const activity = await qbo.pushTimeActivity(companyId, {
          ...(usesVendor ? { vendorId: entry.qbo_vendor_id } : { employeeId: entry.qbo_employee_id }),
          customerId: entry.qbo_customer_id,
          classId: entry.qbo_class_id || null,
          workDate,
          hours,
          description: entry.notes || '',
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
router.post('/import/workers', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const { workers } = req.body; // [{ display_name, email, qbo_employee_id, qbo_vendor_id, worker_type }]
  if (!Array.isArray(workers) || workers.length === 0) return res.status(400).json({ error: 'workers array required' });

  // Get company default temp password from settings
  const settingsRows = await pool.query('SELECT key, value FROM settings WHERE company_id = $1', [companyId]);
  const settings = applySettingsRows(settingsRows.rows, ADMIN_SETTINGS_DEFAULTS);
  const tempPassword = settings.default_temp_password || crypto.randomBytes(5).toString('hex');
  const hash = await bcrypt.hash(tempPassword, 10);

  const VALID_WORKER_TYPES = ['employee', 'contractor', 'subcontractor', 'owner'];
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
router.post('/import/projects', requireAdmin, async (req, res) => {
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
router.delete('/errors', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM qbo_sync_errors WHERE company_id = $1', [req.user.company_id]);
    res.json({ cleared: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/qbo/errors/:id — dismiss a single sync error
router.delete('/errors/:id', requireAdmin, async (req, res) => {
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
router.post('/push-expenses', requireAdmin, async (req, res) => {
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
// QBO Bill per vendor. Labor lines are item-based (hours × rate on an Item),
// reimbursement lines are account-based (against qbo_expense_account_id).

async function gatherBillData(companyId, { from, to, workerIds, force }) {
  const ids = Array.isArray(workerIds) && workerIds.length ? workerIds : null;
  const [timeRows, reimbRows] = await Promise.all([
    pool.query(
      `SELECT te.id, te.user_id, te.project_id, te.work_date, te.start_time, te.end_time,
              te.notes, te.qbo_bill_id, te.qbo_activity_id, te.wage_type, te.break_minutes,
              u.full_name, u.qbo_vendor_id, u.hourly_rate, u.worker_type, u.overtime_rule,
              p.qbo_class_id, p.qbo_customer_id, p.name AS project_name
         FROM time_entries te
         JOIN users u    ON te.user_id = u.id
         LEFT JOIN projects p ON te.project_id = p.id
        WHERE te.company_id = $1
          AND te.status = 'approved'
          AND ($2::date IS NULL OR te.work_date >= $2::date)
          AND ($3::date IS NULL OR te.work_date <= $3::date)
          AND ($4::int[] IS NULL OR te.user_id = ANY($4::int[]))
          AND u.qbo_vendor_id IS NOT NULL`,
      [companyId, from || null, to || null, ids]
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

  // Group per worker (vendor)
  const byUser = new Map();
  const get = (uid) => {
    if (!byUser.has(uid)) byUser.set(uid, { userId: uid, fullName: '', vendorId: '', hourlyRate: 0, overtimeRule: null, timeEntries: [], reimbursements: [] });
    return byUser.get(uid);
  };
  for (const te of timeRows.rows) {
    if (te.qbo_bill_id && !force) continue;
    const hours = hoursBetween(te.start_time, te.end_time);
    if (hours <= 0) continue;
    const g = get(te.user_id);
    g.fullName = te.full_name;
    g.vendorId = te.qbo_vendor_id;
    g.hourlyRate = parseFloat(te.hourly_rate) || 0;
    g.overtimeRule = te.overtime_rule || g.overtimeRule;
    g.timeEntries.push({
      id: te.id, workDate: te.work_date, hours,
      wageType: te.wage_type || 'regular',
      breakMinutes: te.break_minutes || 0,
      startTime: te.start_time,
      endTime: te.end_time,
      classId: te.qbo_class_id || null,
      customerId: te.qbo_customer_id || null,
      projectName: te.project_name || '',
      description: te.notes || '',
    });
  }
  for (const r of reimbRows.rows) {
    if (r.qbo_bill_id && !force) continue;
    const g = get(r.user_id);
    g.fullName = r.full_name;
    g.vendorId = r.qbo_vendor_id;
    g.reimbursements.push({
      id: r.id, expenseDate: r.expense_date, amount: parseFloat(r.amount) || 0,
      classId: r.qbo_class_id || null,
      customerId: r.qbo_customer_id || null,
      projectName: r.project_name || '',
      description: r.description || r.category || '',
    });
  }
  return Array.from(byUser.values()).filter(g => g.timeEntries.length || g.reimbursements.length);
}

function hoursBetween(start, end) {
  if (!start || !end) return 0;
  const s = new Date(`1970-01-01T${start}`);
  let e = new Date(`1970-01-01T${end}`);
  if (e < s) e = new Date(e.getTime() + 24 * 3600 * 1000);
  return Math.max(0, (e - s) / 3600000);
}

function isoDate(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.substring(0, 10);
  try { return d.toISOString().substring(0, 10); } catch { return String(d).substring(0, 10); }
}

/**
 * Pull overtime settings the bill push needs. Returns company defaults; the
 * per-entry wage_type and per-user overtime_rule override-selection happens
 * inside computeOT / computeGroupOvertime.
 */
async function getOvertimeSettings(companyId) {
  const { rows } = await pool.query(
    "SELECT key, value FROM settings WHERE company_id = $1 AND key IN ('overtime_rule','overtime_threshold','overtime_multiplier','week_start')",
    [companyId]
  );
  const pick = k => rows.find(r => r.key === k)?.value;
  const rule = pick('overtime_rule') || 'daily';
  const threshold = parseFloat(pick('overtime_threshold')) || (rule === 'weekly' ? 40 : 8);
  const multiplier = parseFloat(pick('overtime_multiplier')) || 1.5;
  const weekStart = parseInt(pick('week_start') ?? '1', 10);
  return { rule, threshold, multiplier, weekStart };
}

/**
 * Compute overtime hours and premium dollars for one contractor group.
 * Uses the worker's overtime_rule if set, else the company default.
 * Premium = ot_hours × base_rate × (multiplier - 1), which is what needs to
 * be added on top of the straight hours × base_rate already billed per entry.
 */
function computeGroupOvertime(group, companyRule, threshold, multiplier, weekStart = 1) {
  const rule = group.overtimeRule || companyRule;
  if (rule === 'none' || !group.timeEntries.length) {
    return { overtimeHours: 0, overtimePremium: 0, rule };
  }
  const entries = group.timeEntries.map(te => ({
    work_date:     te.workDate,
    start_time:    te.startTime,
    end_time:      te.endTime,
    wage_type:     te.wageType,
    break_minutes: te.breakMinutes,
  }));
  const { overtimeHours } = computeOT(entries, rule, threshold, weekStart);
  const premium = overtimeHours * group.hourlyRate * (multiplier - 1);
  return { overtimeHours, overtimePremium: premium, rule };
}

// POST /api/qbo/push-bills-preview — dry-run summary of what would be billed
// Body: { from, to, worker_ids, force }
router.post('/push-bills-preview', requireAdmin, async (req, res) => {
  const { from, to, worker_ids, force } = req.body;
  try {
    const [groups, ot] = await Promise.all([
      gatherBillData(req.user.company_id, { from, to, workerIds: worker_ids, force }),
      getOvertimeSettings(req.user.company_id),
    ]);
    const result = groups.map(g => {
      const laborHours = g.timeEntries.reduce((s, t) => s + t.hours, 0);
      const laborAmount = laborHours * g.hourlyRate;
      const reimbAmount = g.reimbursements.reduce((s, r) => s + r.amount, 0);
      const { overtimeHours, overtimePremium } = computeGroupOvertime(g, ot.rule, ot.threshold, ot.multiplier, ot.weekStart);
      return {
        user_id: g.userId,
        full_name: g.fullName,
        hourly_rate: g.hourlyRate,
        time_entries: g.timeEntries.length,
        hours: parseFloat(laborHours.toFixed(2)),
        labor_amount: parseFloat(laborAmount.toFixed(2)),
        overtime_hours: parseFloat(overtimeHours.toFixed(2)),
        overtime_premium: parseFloat(overtimePremium.toFixed(2)),
        reimbursements: g.reimbursements.length,
        reimb_amount: parseFloat(reimbAmount.toFixed(2)),
        time_entry_rows: g.timeEntries.map(te => ({
          id: te.id,
          work_date: isoDate(te.workDate),
          hours: parseFloat(te.hours.toFixed(2)),
          amount: parseFloat((te.hours * g.hourlyRate).toFixed(2)),
          project_name: te.projectName,
          description: te.description,
        })),
        reimbursement_rows: g.reimbursements.map(r => ({
          id: r.id,
          expense_date: isoDate(r.expenseDate),
          amount: parseFloat(r.amount.toFixed(2)),
          project_name: r.projectName,
          description: r.description,
        })),
        total: parseFloat((laborAmount + overtimePremium + reimbAmount).toFixed(2)),
      };
    });
    res.json({ groups: result, overtime: { rule: ot.rule, threshold: ot.threshold, multiplier: ot.multiplier } });
  } catch (err) {
    logger.error({ err }, 'push-bills-preview error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/qbo/push-bills — create one QBO Bill per vendor
// Body: { from, to, worker_ids, force }
router.post('/push-bills', requireAdmin, async (req, res) => {
  const { from, to, worker_ids, force } = req.body;
  const companyId = req.user.company_id;
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

    const [groups, ot] = await Promise.all([
      gatherBillData(companyId, { from, to, workerIds: worker_ids, force }),
      getOvertimeSettings(companyId),
    ]);

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
      const lines = [];
      for (const te of g.timeEntries) {
        lines.push({
          type: 'item',
          itemId: laborItemId,
          qty: te.hours,
          unitPrice: g.hourlyRate,
          description: `${isoDate(te.workDate)}${te.projectName ? ' · ' + te.projectName : ''}${te.description ? ' — ' + te.description : ''}`.slice(0, 4000),
          customerId: te.customerId,
          classId: te.classId,
        });
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

      // Overtime premium: an extra item-based line that covers the (multiplier-1)
      // uplift on OT hours. The per-entry lines above price straight hours at
      // the base rate; this line makes the contractor whole for their OT shifts.
      const { overtimeHours, overtimePremium } = computeGroupOvertime(g, ot.rule, ot.threshold, ot.multiplier, ot.weekStart);
      if (overtimeHours > 0 && overtimePremium > 0) {
        lines.push({
          type: 'item',
          itemId: laborItemId,
          qty: parseFloat(overtimeHours.toFixed(2)),
          unitPrice: parseFloat((g.hourlyRate * (ot.multiplier - 1)).toFixed(4)),
          description: `Overtime premium — ${ot.multiplier}× on ${overtimeHours.toFixed(2)} h (${ot.rule}, threshold ${ot.threshold} h)`,
        });
      }

      if (!lines.length) continue;

      try {
        const bill = await qbo.createBill(companyId, {
          vendorId: g.vendorId,
          txnDate: today,
          dueDate,
          memo: `OpsFloa bill ${from || ''}–${to || ''} for ${g.fullName}`.trim(),
          lines,
        });
        const billId = bill?.Id || 'synced';
        const timeIds = g.timeEntries.map(t => t.id);
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
        pushed.push({ user_id: g.userId, full_name: g.fullName, bill_id: billId, time_entries: timeIds.length, reimbursements: reimbIds.length });
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
router.post('/push-payroll', requireAdmin, async (req, res) => {
  const { from, to, debit_account_id, credit_account_id } = req.body;
  if (!debit_account_id || !credit_account_id) {
    return res.status(400).json({ error: 'debit_account_id and credit_account_id are required' });
  }
  if (!from || !to) return res.status(400).json({ error: 'from and to date range are required' });

  const companyId = req.user.company_id;
  try {
    const company = await pool.query('SELECT qbo_realm_id FROM companies WHERE id = $1', [companyId]);
    if (!company.rows[0]?.qbo_realm_id) return res.status(400).json({ error: 'QuickBooks not connected' });

    // Calculate total labor cost for approved entries in the range
    const settings = await pool.query(
      'SELECT key, value FROM settings WHERE company_id = $1 AND key IN (\'default_hourly_rate\', \'prevailing_wage_rate\')',
      [companyId]
    );
    const defaultRate = parseFloat(settings.rows.find(r => r.key === 'default_hourly_rate')?.value || 30);
    const prevRate = parseFloat(settings.rows.find(r => r.key === 'prevailing_wage_rate')?.value || 45);

    const entries = await pool.query(
      `SELECT te.start_time, te.end_time, te.break_minutes, te.wage_type, u.default_hourly_rate
       FROM time_entries te
       JOIN users u ON te.user_id = u.id
       WHERE te.company_id = $1
         AND te.status = 'approved'
         AND te.work_date >= $2::date
         AND te.work_date <= $3::date`,
      [companyId, from, to]
    );

    let totalCost = 0;
    for (const e of entries.rows) {
      let ms = new Date(`1970-01-01T${e.end_time}`) - new Date(`1970-01-01T${e.start_time}`);
      if (ms < 0) ms += 86400000;
      const hours = Math.max(0, ms / 3600000 - (e.break_minutes || 0) / 60);
      const rate = e.wage_type === 'prevailing' ? prevRate : (e.default_hourly_rate || defaultRate);
      totalCost += hours * rate;
    }

    if (totalCost <= 0) return res.status(400).json({ error: 'No approved entries found for this date range' });

    const description = `Payroll ${from} – ${to} (${entries.rowCount} entries)`;
    const entry = await qbo.createJournalEntry(companyId, {
      txnDate: to,
      description,
      debitAccountId: debit_account_id,
      creditAccountId: credit_account_id,
      amount: totalCost,
    });

    logAudit(companyId, req.user.id, req.user.full_name, 'qbo.payroll_journal_pushed', 'qbo_journal', entry?.Id || null, description,
      { amount: totalCost, from, to, entries: entries.rowCount });
    res.json({ entry_id: entry?.Id, amount: totalCost, entries: entries.rowCount, description });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    const status = err.code === 'qbo_auth_expired' ? 401 : 500;
    res.status(status).json({ error: err.code === 'qbo_auth_expired' ? err.message : 'Server error', code: err.code });
  }
});

// POST /api/qbo/retry-error/:id — retry a failed QBO sync entry
router.post('/retry-error/:id', requireAdmin, async (req, res) => {
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
      });
      await pool.query(
        'UPDATE reimbursements SET qbo_purchase_id = $1, qbo_synced_at = NOW() WHERE id = $2',
        [purchase?.Id || 'synced', entity_id]
      );
    } else if (entity_type === 'time_entry') {
      const entry = await pool.query(
        `SELECT te.*, u.qbo_employee_id, u.qbo_vendor_id, u.worker_type, p.qbo_customer_id, p.qbo_class_id
         FROM time_entries te JOIN users u ON te.user_id = u.id LEFT JOIN projects p ON te.project_id = p.id
         WHERE te.id = $1 AND te.company_id = $2`,
        [entity_id, companyId]
      );
      if (!entry.rows.length) return res.status(404).json({ error: 'Time entry not found' });
      const e = entry.rows[0];
      const usesVendor = e.worker_type === 'contractor' || e.worker_type === 'subcontractor';
      const mappedId = usesVendor ? e.qbo_vendor_id : e.qbo_employee_id;
      if (!mappedId) return res.status(400).json({ error: 'Worker has no QBO mapping — set it in QuickBooks settings first' });
      if (!e.qbo_customer_id) return res.status(400).json({ error: 'Project has no QBO customer mapping — set it in QuickBooks settings first' });
      let ms = new Date(`1970-01-01T${e.end_time}`) - new Date(`1970-01-01T${e.start_time}`);
      if (ms < 0) ms += 86400000;
      const hours = Math.max(0, ms / 3600000 - (e.break_minutes || 0) / 60);
      const workDate = e.work_date.toISOString().substring(0, 10);
      const activity = await qbo.pushTimeActivity(companyId, {
        ...(usesVendor ? { vendorId: e.qbo_vendor_id } : { employeeId: e.qbo_employee_id }),
        customerId: e.qbo_customer_id,
        classId: e.qbo_class_id || null,
        workDate, hours, description: e.notes || '',
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
router.post('/workers/create-vendor', requireAdmin, async (req, res) => {
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
