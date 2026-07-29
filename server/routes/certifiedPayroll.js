/**
 * Certified Payroll endpoints. All routes require the addon (or an exempt/
 * trial subscription); list-style endpoints admins need for dropdowns
 * (like job classifications) are exposed a level looser so admins can
 * configure even when the addon is off.
 */

const router = require('express').Router();
const pool   = require('../db');
const logger = require('../logger');
const { requireAuth, requireAdmin, requireCertifiedPayrollAddon } = require('../middleware/auth');
const { getAdvancedSettings } = require('./admin');
const { encrypt, decrypt } = require('../services/encryption');
const { logAudit } = require('../auditLog');

// GET /api/certified-payroll/classifications — resolved list of job classes
// (default ∖ suppressed ∪ custom). Admins use this for dropdowns whether or
// not the addon is on; a company not on the addon still benefits from
// having classifications pre-tagged on workers for future use.
router.get('/classifications', requireAuth, async (req, res) => {
  try {
    const all = await getAdvancedSettings(req.user.company_id);
    const cfg = all.job_classifications;
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

const FRINGE_CATEGORIES = ['health', 'pension', 'vacation', 'apprenticeship', 'other'];

// GET /api/certified-payroll/workers/:id/fringes — per-worker fringe rates
router.get('/workers/:id/fringes', requireAdmin, requireCertifiedPayrollAddon, async (req, res) => {
  try {
    // Make sure the target user belongs to this company before returning PII-adjacent data.
    const ok = await pool.query('SELECT 1 FROM users WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
    if (ok.rowCount === 0) return res.status(404).json({ error: 'Worker not found' });

    const { rows } = await pool.query(
      'SELECT category, rate_per_hour, notes FROM worker_fringes WHERE user_id = $1 ORDER BY category',
      [req.params.id]
    );
    res.json({ fringes: rows });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/certified-payroll/workers/:id/fringes — upsert the full set
router.put('/workers/:id/fringes', requireAdmin, requireCertifiedPayrollAddon, async (req, res) => {
  const companyId = req.user.company_id;
  const userId = req.params.id;
  const incoming = Array.isArray(req.body.fringes) ? req.body.fringes : [];

  try {
    const ok = await pool.query('SELECT 1 FROM users WHERE id = $1 AND company_id = $2', [userId, companyId]);
    if (ok.rowCount === 0) return res.status(404).json({ error: 'Worker not found' });

    // Validate: only known categories, non-negative numbers, reasonable upper bound.
    const rows = [];
    for (const f of incoming) {
      if (!FRINGE_CATEGORIES.includes(f.category)) continue;
      const rate = parseFloat(f.rate_per_hour);
      if (isNaN(rate) || rate < 0 || rate > 1000) continue;
      rows.push({ category: f.category, rate, notes: typeof f.notes === 'string' ? f.notes.slice(0, 500) : null });
    }

    // Upsert each category; delete zero-rate categories with no notes so the
    // table only carries non-trivial rows.
    for (const row of rows) {
      if (row.rate === 0 && !row.notes) {
        await pool.query('DELETE FROM worker_fringes WHERE user_id = $1 AND category = $2', [userId, row.category]);
        continue;
      }
      await pool.query(
        `INSERT INTO worker_fringes (user_id, company_id, category, rate_per_hour, notes, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (user_id, category) DO UPDATE
           SET rate_per_hour = EXCLUDED.rate_per_hour,
               notes = EXCLUDED.notes,
               updated_at = NOW()`,
        [userId, companyId, row.category, row.rate, row.notes]
      );
    }

    const fresh = await pool.query(
      'SELECT category, rate_per_hour, notes FROM worker_fringes WHERE user_id = $1 ORDER BY category',
      [userId]
    );
    res.json({ fringes: fresh.rows });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// SSN last-4 (encrypted, write-mostly)
// ────────────────────────────────────────────────────────────────────────────
// We store only the last 4 digits, encrypted with the same AES-GCM key used
// for QBO refresh tokens. The GET endpoint returns ONLY a boolean "hasSsn"
// — we never send the value back to the client after it's been set, and
// never log it. To change the value, admins re-enter the last 4 digits.

// GET /api/certified-payroll/workers/:id/ssn — presence check only
router.get('/workers/:id/ssn', requireAdmin, requireCertifiedPayrollAddon, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT ssn_last4_enc FROM users WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Worker not found' });
    res.json({ hasSsn: !!rows[0].ssn_last4_enc });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/certified-payroll/workers/:id/ssn { ssn_last4 } — set or clear
router.put('/workers/:id/ssn', requireAdmin, requireCertifiedPayrollAddon, async (req, res) => {
  const raw = String(req.body.ssn_last4 || '').replace(/\D/g, '');
  try {
    const ok = await pool.query('SELECT id FROM users WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
    if (ok.rowCount === 0) return res.status(404).json({ error: 'Worker not found' });

    if (!raw) {
      // Clearing the value
      await pool.query('UPDATE users SET ssn_last4_enc = NULL WHERE id = $1 AND company_id = $2', [req.params.id, req.user.company_id]);
      await logAudit(req.user.company_id, req.user.id, req.user.full_name, 'worker.ssn_cleared', 'worker', req.params.id, null);
      return res.json({ hasSsn: false });
    }

    if (raw.length !== 4) return res.status(400).json({ error: 'SSN must be exactly 4 digits (last 4 only)' });

    const ciphertext = encrypt(raw);
    await pool.query(
      'UPDATE users SET ssn_last4_enc = $1 WHERE id = $2 AND company_id = $3',
      [ciphertext, req.params.id, req.user.company_id]
    );
    // Audit trail records that it was set (never the value).
    await logAudit(req.user.company_id, req.user.id, req.user.full_name, 'worker.ssn_set', 'worker', req.params.id, null);
    res.json({ hasSsn: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Helper for the report generator — not exposed as a route. `companyId` scopes the
// lookup so a caller can never decrypt another tenant's SSN last-4 (defence in depth;
// callers already pass company-scoped ids, but PII shouldn't rely on that).
async function loadSsnLast4(userIds, companyId) {
  if (!userIds.length) return {};
  const { rows } = await pool.query(
    'SELECT id, ssn_last4_enc FROM users WHERE id = ANY($1::int[]) AND company_id = $2',
    [userIds, companyId]
  );
  const out = {};
  for (const r of rows) {
    if (r.ssn_last4_enc) {
      try { out[r.id] = decrypt(r.ssn_last4_enc); }
      catch (e) { logger.warn({ user_id: r.id, err: e.message }, 'ssn_decrypt_failed'); }
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Statement of Compliance signatures
// ────────────────────────────────────────────────────────────────────────────

// The legal text signed with each weekly report. WH-347 calls for this
// declaration per the Davis-Bacon Act / Copeland Anti-Kickback Act.
const DEFAULT_COMPLIANCE_TEXT = [
  'I, the undersigned, do hereby state:',
  '(1) That I pay or supervise the payment of the persons employed by the above contractor on the above-referenced project; that during the payroll period noted, all persons employed on said project have been paid the full weekly wages earned, that no rebates have been or will be made either directly or indirectly to or on behalf of said contractor from the full weekly wages earned by any person and that no deductions have been made either directly or indirectly from the full wages earned by any person, other than permissible deductions as defined in Regulations, Part 3 (29 CFR Subtitle A).',
  '(2) That any payrolls otherwise under this contract required to be submitted for the above period are correct and complete; that the wage rates for laborers or mechanics contained therein are not less than the applicable wage rates contained in any wage determination incorporated into the contract; that the classifications set forth therein for each laborer or mechanic conform with the work he or she performed.',
  '(3) That any apprentices employed in the above period are duly registered in a bona fide apprenticeship program registered with a State apprenticeship agency recognized by the Bureau of Apprenticeship and Training, United States Department of Labor, or if no such recognized agency exists in a State, are registered with the Bureau of Apprenticeship and Training, United States Department of Labor.',
  '(4) That fringe benefits have been paid as specified in the contract.',
].join('\n\n');

// GET /api/certified-payroll/signatures?project_id=&week_ending= — most recent signature for this report, if any
router.get('/signatures', requireAdmin, requireCertifiedPayrollAddon, async (req, res) => {
  const { project_id, week_ending } = req.query;
  if (!week_ending || !/^\d{4}-\d{2}-\d{2}$/.test(week_ending)) {
    return res.status(400).json({ error: 'week_ending (YYYY-MM-DD) is required' });
  }
  try {
    const params = [req.user.company_id, week_ending];
    let projectClause = 'AND project_id IS NULL';
    if (project_id) { params.push(project_id); projectClause = `AND project_id = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT id, signer_user_id, signer_name, signer_title, compliance_text, signed_at
         FROM certified_payroll_signatures
        WHERE company_id = $1 AND week_ending = $2 ${projectClause}
        ORDER BY signed_at DESC
        LIMIT 1`,
      params
    );
    res.json({ signature: rows[0] || null, default_compliance_text: DEFAULT_COMPLIANCE_TEXT });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/certified-payroll/signatures { project_id?, week_ending, signer_name, signer_title?, signature_data }
router.post('/signatures', requireAdmin, requireCertifiedPayrollAddon, async (req, res) => {
  const { project_id, week_ending, signer_name, signer_title, signature_data } = req.body;
  if (!week_ending || !/^\d{4}-\d{2}-\d{2}$/.test(week_ending)) {
    return res.status(400).json({ error: 'week_ending (YYYY-MM-DD) is required' });
  }
  const name = (signer_name || '').trim();
  const sig = (signature_data || '').trim();
  if (!name) return res.status(400).json({ error: 'signer_name is required' });
  if (!sig)  return res.status(400).json({ error: 'signature_data is required' });
  if (name.length > 200 || sig.length > 2000) return res.status(400).json({ error: 'Signature or name too long' });
  const title = (signer_title || '').trim().slice(0, 200) || null;

  try {
    // Upsert — one signature per (company, project, week). Re-signing overwrites
    // with the new snapshot; history lives in the audit log.
    const ip = req.ip || req.headers['x-forwarded-for'] || null;
    const { rows } = await pool.query(
      `INSERT INTO certified_payroll_signatures
         (company_id, project_id, week_ending, signer_user_id, signer_name, signer_title, signature_data, compliance_text, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (company_id, project_id, week_ending) DO UPDATE
         SET signer_user_id = EXCLUDED.signer_user_id,
             signer_name    = EXCLUDED.signer_name,
             signer_title   = EXCLUDED.signer_title,
             signature_data = EXCLUDED.signature_data,
             compliance_text = EXCLUDED.compliance_text,
             ip_address     = EXCLUDED.ip_address,
             signed_at      = NOW()
       RETURNING id, signer_user_id, signer_name, signer_title, compliance_text, signed_at`,
      [req.user.company_id, project_id || null, week_ending, req.user.id, name, title, sig, DEFAULT_COMPLIANCE_TEXT, ip]
    );
    await logAudit(req.user.company_id, req.user.id, req.user.full_name, 'certified_payroll.signed', 'signature', rows[0].id, `${name} · ${week_ending}`, { project_id: project_id || null });
    res.json({ signature: rows[0] });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.requireCertifiedPayrollAddon = requireCertifiedPayrollAddon;
module.exports.loadSsnLast4 = loadSsnLast4;
module.exports.DEFAULT_COMPLIANCE_TEXT = DEFAULT_COMPLIANCE_TEXT;
