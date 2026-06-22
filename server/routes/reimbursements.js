const express = require('express');
const logger = require('../logger');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { userOrIpKey } = require('../middleware/rateLimitKey');
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { uploadBase64, deleteByUrl } = require('../r2');
const { incrementStorage, decrementStorage, checkStorageLimit } = require('../storage');
const { getAdvancedSettings, ADVANCED_DEFAULTS } = require('./admin');
const qbo = require('../services/qbo');
const { logAudit } = require('../auditLog');
const { coerceBody } = require('../middleware/coerce');

// GET /api/reimbursements/categories
// Returns:
//   active — shown in form dropdowns (defaults minus suppressed, plus custom)
//   known  — all valid category values for display (all defaults + current custom)
//            if a stored category isn't in "known", the client shows "Other"
router.get('/categories', async (req, res) => {
  try {
    const all = await getAdvancedSettings(req.user.company_id);
    const cfg = all.reimbursement_categories;
    const active = [
      ...cfg.defaults.filter(c => !cfg.suppressed.includes(c)),
      ...cfg.custom,
    ];
    const known = [...cfg.defaults, ...cfg.custom];
    res.json({ active, known });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/reimbursements — worker: list own reimbursements
router.get('/', async (req, res) => {
  try {
    const [reimb, settings] = await Promise.all([
      pool.query(
        `SELECT r.id, r.amount, r.description, r.category, r.expense_date, r.receipt_url,
                r.status, r.admin_notes, r.created_at, r.project_id, r.miles, r.mileage_rate,
                p.name AS project_name
         FROM reimbursements r
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE r.company_id = $1 AND r.user_id = $2
         ORDER BY r.expense_date DESC, r.created_at DESC
         LIMIT 500`,
        [req.user.company_id, req.user.id]
      ),
      getAdvancedSettings(req.user.company_id),
    ]);
    res.json({ items: reimb.rows, mileage_rate: settings.mileage_rate.rate });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Failed to load reimbursements' });
  }
});

// POST /api/reimbursements — worker: submit a reimbursement
const reimbLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  keyGenerator: userOrIpKey,
  standardHeaders: true,
  legacyHeaders: false,
});
router.post('/', reimbLimiter, coerceBody({ int: ['project_id'], float: ['miles', 'amount'] }), async (req, res) => {
  const { expense_date, receipt, project_id } = req.body;
  const description = req.body.description?.trim() || null;
  const category    = req.body.category?.trim() || null;
  if (!expense_date) return res.status(400).json({ error: 'expense_date is required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expense_date) || isNaN(Date.parse(expense_date))) {
    return res.status(400).json({ error: 'expense_date must be a valid date (YYYY-MM-DD)' });
  }

  // Mileage path: miles provided, amount auto-calculated
  let amt, milesVal = null, mileageRateVal = null;
  if (req.body.miles != null && req.body.miles !== '') {
    milesVal = parseFloat(req.body.miles);
    if (isNaN(milesVal) || milesVal <= 0) return res.status(400).json({ error: 'miles must be a positive number' });
    const settings = await getAdvancedSettings(req.user.company_id);
    mileageRateVal = settings.mileage_rate.rate;
    amt = parseFloat((milesVal * mileageRateVal).toFixed(2));
  } else {
    const amount = req.body.amount;
    if (!amount) return res.status(400).json({ error: 'amount or miles is required' });
    amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
  }

  let receiptUrl = null;
  let receiptSizeBytes = null;

  try {
    if (receipt) {
      const { allowed } = await checkStorageLimit(req.user.company_id, 5 * 1024 * 1024);
      if (!allowed) return res.status(400).json({ error: 'Storage limit reached. Upgrade your plan to upload more files.' });

      const uploaded = await uploadBase64(receipt, 'receipts');
      receiptUrl = uploaded.url;
      receiptSizeBytes = uploaded.sizeBytes;
      await incrementStorage(req.user.company_id, receiptSizeBytes);
    }

    const { rows } = await pool.query(
      `INSERT INTO reimbursements
         (company_id, user_id, amount, description, category, expense_date, receipt_url, receipt_size_bytes, project_id, miles, mileage_rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, amount, description, category, expense_date, receipt_url, status, admin_notes, created_at, project_id, miles, mileage_rate`,
      [req.user.company_id, req.user.id, amt, description || null, category || null, expense_date, receiptUrl, receiptSizeBytes, project_id || null, milesVal, mileageRateVal]
    );
    logAudit(req.user.company_id, req.user.id, req.user.full_name, 'reimbursement.submitted', 'reimbursement', rows[0].id, description || null,
      { amount: amt, category, expense_date });
    res.status(201).json(rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    // If the DB insert failed after a successful R2 upload, clean up the orphaned file
    if (receiptUrl) {
      deleteByUrl(receiptUrl).catch(err => logger.error({ err }, 'R2 cleanup failed'));
      decrementStorage(req.user.company_id, receiptSizeBytes).catch(() => {});
    }
    res.status(500).json({ error: 'Failed to submit reimbursement' });
  }
});

// DELETE /api/reimbursements/:id — worker: delete own pending reimbursement
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `DELETE FROM reimbursements WHERE id = $1 AND company_id = $2 AND user_id = $3 AND status = 'pending'
       RETURNING receipt_size_bytes`,
      [req.params.id, req.user.company_id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found or cannot be deleted' });
    if (rows[0].receipt_size_bytes) {
      await decrementStorage(req.user.company_id, rows[0].receipt_size_bytes);
    }
    logAudit(req.user.company_id, req.user.id, req.user.full_name, 'reimbursement.deleted', 'reimbursement', req.params.id, null, null);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Failed to delete reimbursement' });
  }
});

// --- Admin routes ---

// POST /api/reimbursements/admin — admin: submit a reimbursement for any worker (or self)
router.post('/admin', requireAdmin, async (req, res) => {
  const { user_id, expense_date, receipt, project_id, status = 'approved' } = req.body;
  const description = req.body.description?.trim() || null;
  const category    = req.body.category?.trim() || null;
  if (!user_id || !expense_date) {
    return res.status(400).json({ error: 'user_id and expense_date are required' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expense_date) || isNaN(Date.parse(expense_date))) {
    return res.status(400).json({ error: 'expense_date must be a valid date (YYYY-MM-DD)' });
  }
  if (!['pending', 'approved'].includes(status)) return res.status(400).json({ error: 'status must be pending or approved' });

  let amt, milesVal = null, mileageRateVal = null;
  if (req.body.miles != null && req.body.miles !== '') {
    milesVal = parseFloat(req.body.miles);
    if (isNaN(milesVal) || milesVal <= 0) return res.status(400).json({ error: 'miles must be a positive number' });
    const settings = await getAdvancedSettings(req.user.company_id);
    mileageRateVal = settings.mileage_rate.rate;
    amt = parseFloat((milesVal * mileageRateVal).toFixed(2));
  } else {
    const amount = req.body.amount;
    if (!amount) return res.status(400).json({ error: 'amount or miles is required' });
    amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
  }

  const worker = await pool.query('SELECT id FROM users WHERE id = $1 AND company_id = $2', [user_id, req.user.company_id]).catch(() => null);
  if (!worker?.rows.length) return res.status(404).json({ error: 'Worker not found' });

  let receiptUrl = null;
  let receiptSizeBytes = null;

  try {
    if (receipt) {
      const { allowed } = await checkStorageLimit(req.user.company_id, 5 * 1024 * 1024);
      if (!allowed) return res.status(400).json({ error: 'Storage limit reached.' });
      const uploaded = await uploadBase64(receipt, 'receipts');
      receiptUrl = uploaded.url;
      receiptSizeBytes = uploaded.sizeBytes;
      await incrementStorage(req.user.company_id, receiptSizeBytes);
    }

    const { rows } = await pool.query(
      `INSERT INTO reimbursements
         (company_id, user_id, amount, description, category, expense_date, receipt_url, receipt_size_bytes, status, project_id, miles, mileage_rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, amount, description, category, expense_date, receipt_url, status, admin_notes, created_at, project_id, miles, mileage_rate`,
      [req.user.company_id, user_id, amt, description || null, category || null, expense_date, receiptUrl, receiptSizeBytes, status, project_id || null, milesVal, mileageRateVal]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    // If the DB insert failed after a successful R2 upload, clean up the orphaned file
    if (receiptUrl) {
      deleteByUrl(receiptUrl).catch(err => logger.error({ err }, 'R2 cleanup failed'));
      decrementStorage(req.user.company_id, receiptSizeBytes).catch(() => {});
    }
    res.status(500).json({ error: 'Failed to submit reimbursement' });
  }
});

// GET /api/reimbursements/admin — admin: list all reimbursements for company
router.get('/admin', requireAdmin, async (req, res) => {
  const { status, user_id } = req.query;
  const conditions = ['r.company_id = $1'];
  const params = [req.user.company_id];
  if (status) { params.push(status); conditions.push(`r.status = $${params.length}`); }
  if (user_id) { params.push(user_id); conditions.push(`r.user_id = $${params.length}`); }

  try {
    const [reimb, settings] = await Promise.all([
      pool.query(
        `SELECT r.id, r.amount, r.description, r.category, r.expense_date, r.receipt_url,
                r.status, r.admin_notes, r.created_at, r.updated_at, r.project_id, r.miles, r.mileage_rate,
                r.qbo_purchase_id, r.qbo_synced_at,
                p.name AS project_name, u.full_name, u.username
         FROM reimbursements r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN projects p ON p.id = r.project_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY r.expense_date DESC, r.created_at DESC
         LIMIT 1000`,
        params
      ),
      getAdvancedSettings(req.user.company_id),
    ]);
    res.json({ items: reimb.rows, mileage_rate: settings.mileage_rate.rate });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Failed to load reimbursements' });
  }
});

// PATCH /api/reimbursements/admin/:id — admin: approve or reject
router.patch('/admin/:id', requireAdmin, async (req, res) => {
  const { status } = req.body;
  const admin_notes = req.body.admin_notes?.trim() || null;
  const clientUpdatedAt = req.body.updated_at || null;
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'status must be approved, rejected, or pending' });
  }
  if (admin_notes && admin_notes.length > 1000) return res.status(400).json({ error: 'admin_notes too long (max 1000 characters)' });
  try {
    const existing = await pool.query(
      'SELECT updated_at FROM reimbursements WHERE id=$1 AND company_id=$2',
      [req.params.id, req.user.company_id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Not found' });
    if (clientUpdatedAt && new Date(existing.rows[0].updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
      return res.status(409).json({ error: 'conflict' });
    }

    const { rows } = await pool.query(
      `UPDATE reimbursements
       SET status = $1, admin_notes = $2, updated_at = NOW()
       WHERE id = $3 AND company_id = $4
       RETURNING id, amount, description, category, expense_date, receipt_url,
                 status, admin_notes, created_at, updated_at, project_id, user_id`,
      [status, admin_notes, req.params.id, req.user.company_id]
    );
    const reimb = rows[0];
    logAudit(req.user.company_id, req.user.id, req.user.full_name, `reimbursement.${status}`, 'reimbursement', reimb.id, null,
      { amount: reimb.amount, worker_user_id: reimb.user_id });
    res.json(reimb);

    // QBO expense auto-sync — fire-and-forget, only on approval
    if (status === 'approved') {
      setImmediate(async () => {
        try {
          const [autopush, accounts] = await Promise.all([
            pool.query("SELECT value FROM settings WHERE company_id = $1 AND key = 'qbo_auto_push_expenses'", [req.user.company_id]),
            pool.query("SELECT key, value FROM settings WHERE company_id = $1 AND key IN ('qbo_expense_account_id', 'qbo_bank_account_id')", [req.user.company_id]),
          ]);
          if (autopush.rows[0]?.value !== '1') return;
          const expenseAccountId = accounts.rows.find(r => r.key === 'qbo_expense_account_id')?.value;
          const bankAccountId = accounts.rows.find(r => r.key === 'qbo_bank_account_id')?.value;
          if (!expenseAccountId || !bankAccountId) return;

          const company = await pool.query('SELECT qbo_realm_id FROM companies WHERE id = $1', [req.user.company_id]);
          if (!company.rows[0]?.qbo_realm_id) return;

          // Optional: get vendor ID if worker is a contractor/subcontractor
          let vendorId = null;
          if (reimb.user_id) {
            const worker = await pool.query('SELECT qbo_vendor_id, worker_type FROM users WHERE id = $1', [reimb.user_id]);
            const w = worker.rows[0];
            if (w && (w.worker_type === 'contractor' || w.worker_type === 'subcontractor') && w.qbo_vendor_id) {
              vendorId = w.qbo_vendor_id;
            }
          }

          const txnDate = reimb.expense_date ? reimb.expense_date.toISOString?.().substring(0, 10) || String(reimb.expense_date).substring(0, 10) : null;
          const purchase = await qbo.createPurchase(req.user.company_id, {
            bankAccountId,
            expenseAccountId,
            vendorId,
            amount: parseFloat(reimb.amount),
            description: reimb.description || reimb.category || 'Expense reimbursement',
            txnDate,
          });
          if (purchase?.Id) {
            await pool.query('UPDATE reimbursements SET qbo_purchase_id = $1, qbo_synced_at = NOW() WHERE id = $2', [purchase.Id, reimb.id]);
          }
        } catch (err) {
          logger.error({ err }, '[QBO expense auto-sync]');
          pool.query(
            'INSERT INTO qbo_sync_errors (company_id, entity_type, entity_id, error_message) VALUES ($1, $2, $3, $4)',
            [req.user.company_id, 'reimbursement', reimb.id, err.message]
          ).catch(() => {});
        }
      });
    }
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Failed to update reimbursement' });
  }
});

module.exports = router;
