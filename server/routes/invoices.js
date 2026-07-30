const router  = require('express').Router();
const crypto  = require('crypto');
const pool    = require('../db');
const logger  = require('../logger');
const { requireAuth } = require('../middleware/auth');
const { requireCommercialAccess } = require('../middleware/commercialAccess');
const { logAudit } = require('../auditLog');
const {
  INVOICE_STATUSES,
  INVOICE_FROZEN_STATUSES,
  INVOICE_PAYMENT_METHODS,
  MONEY_CATEGORIES,
  computeInvoiceTotals,
  computeLineTotal,
} = require('../constants/projectMoneyEnums');
const { loadSettings, laborCostCents, LABOR_ENTRY_COLUMNS } = require('../utils/paidHours');
const { sendEmail } = require('../email');
const { escapeHtml } = require('../utils/htmlEscape');
const { projectBelongsToCompany, clientBelongsToCompany } = require('../utils/tenantRefs');

// Frontend base URL for the client-facing link in the send email — the same env
// the auth / invite emails use. Trailing slash trimmed so `${APP_URL}/i/<token>`
// is clean.
const APP_URL = (process.env.APP_URL || 'https://opsfloa.com').replace(/\/+$/, '');

// Native invoices (owner-side AR) — OpsFloa's own invoice concept so a company
// without QuickBooks can invoice, record payment, and close out. Mirrors
// routes/estimates.js: header + child lines + audit, cents/BIGINT money. Adds
// invoice_payments (partial/progress), void, and three creation sources.

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function isNonNegFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

// Coerce a possibly-string percentage into a number in [0, 100]; null = out of range.
function parsePct(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

function readHeaderFields(body) {
  return {
    project_id:           body.project_id ?? null,
    client_id:            body.client_id ?? null,
    // These three are VARCHAR(255) — cap so an over-long value is a clean 400
    // (below) or a truncated store, not a "value too long" 500 at INSERT/UPDATE.
    client_name_snapshot: (body.client_name_snapshot || '').toString().trim().slice(0, 255),
    client_email:         body.client_email ? body.client_email.toString().trim().slice(0, 255) : null,
    project_name:         (body.project_name || '').toString().trim().slice(0, 255) || null,
    project_address:      body.project_address || null,
    tax_pct:              parsePct(body.tax_pct),
    retainage_pct:        parsePct(body.retainage_pct),
    issue_date:           body.issue_date || null,
    due_date:             body.due_date || null,
    notes:                body.notes || null,
    terms:                body.terms || null,
  };
}

// Read a single line and round qty × unit_cost to a cent total; null if malformed.
function normaliseLine(line, sortOrder) {
  if (!line || typeof line !== 'object') return null;
  if (!MONEY_CATEGORIES.includes(line.category)) return null;
  const description = (line.description || '').toString().trim();
  if (!description) return null;
  const qty = typeof line.qty === 'number' ? line.qty : parseFloat(line.qty);
  const unit_cost_cents = typeof line.unit_cost_cents === 'number'
    ? line.unit_cost_cents
    : parseInt(line.unit_cost_cents, 10);
  if (!isNonNegFiniteNumber(qty)) return null;
  if (!isNonNegFiniteNumber(unit_cost_cents)) return null;
  return {
    category: line.category,
    sort_order: Number.isFinite(sortOrder) ? sortOrder : 0,
    description,
    qty,
    unit: line.unit ? line.unit.toString().slice(0, 20) : null,
    unit_cost_cents,
    total_cents: computeLineTotal({ qty, unit_cost_cents }),
    notes: line.notes ? line.notes.toString() : null,
  };
}

async function loadInvoiceFull(companyId, invoiceId) {
  const headRes = await pool.query(
    `SELECT i.*, c.language AS client_language
       FROM invoices i
       LEFT JOIN clients c ON c.id = i.client_id
      WHERE i.id = $1 AND i.company_id = $2`,
    [invoiceId, companyId]
  );
  if (headRes.rowCount === 0) return null;
  const [linesRes, payRes] = await Promise.all([
    pool.query('SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order, id', [invoiceId]),
    pool.query('SELECT id, amount_cents, paid_date, method, reference, notes, created_at FROM invoice_payments WHERE invoice_id = $1 ORDER BY paid_date, id', [invoiceId]),
  ]);
  // Never leak the share token (raw or hash) in the general payload — the raw
  // token is only returned by /send and /link, on purpose.
  const { response_token_hash, response_token, ...head } = headRes.rows[0]; // eslint-disable-line no-unused-vars
  const paid = payRes.rows.reduce((s, p) => s + parseInt(p.amount_cents, 10), 0);
  return { ...head, lines: linesRes.rows, payments: payRes.rows, amount_paid_cents: paid, balance_cents: Math.max(0, parseInt(head.total_cents, 10) - paid) };
}

// Sum lines → subtotal/tax/total/retainage, store on the header. TX-bound client.
async function recomputeTotals(client, invoiceId) {
  const headRes = await client.query('SELECT tax_pct, retainage_pct FROM invoices WHERE id = $1', [invoiceId]);
  if (headRes.rowCount === 0) throw new Error('invoice not found');
  const linesRes = await client.query('SELECT total_cents FROM invoice_lines WHERE invoice_id = $1', [invoiceId]);
  const lines = linesRes.rows.map(r => ({ total_cents: parseInt(r.total_cents, 10) }));
  const head = headRes.rows[0];
  const totals = computeInvoiceTotals({ lines, tax_pct: parseFloat(head.tax_pct), retainage_pct: parseFloat(head.retainage_pct) });
  await client.query(
    'UPDATE invoices SET subtotal_cents = $1, tax_cents = $2, total_cents = $3, retainage_held_cents = $4, updated_at = NOW() WHERE id = $5',
    [totals.subtotal, totals.tax, totals.total, totals.retainage_held, invoiceId]
  );
  return totals;
}

// Derive draft/sent/partial/paid from recorded payments vs total. Never touches
// a void invoice. TX-bound client. Returns the new status.
async function applyPaymentStatus(client, invoiceId) {
  const r = await client.query('SELECT total_cents, status FROM invoices WHERE id = $1', [invoiceId]);
  if (r.rowCount === 0) return null;
  const cur = r.rows[0];
  if (cur.status === 'void') return 'void';
  const p = await client.query('SELECT COALESCE(SUM(amount_cents), 0) AS paid FROM invoice_payments WHERE invoice_id = $1', [invoiceId]);
  const paid = parseInt(p.rows[0].paid, 10);
  const total = parseInt(cur.total_cents, 10);
  let status;
  if (total > 0 && paid >= total) status = 'paid';
  else if (paid > 0) status = 'partial';
  else status = cur.status === 'draft' ? 'draft' : 'sent'; // no payments → keep pre-payment state
  await client.query('UPDATE invoices SET status = $1, updated_at = NOW() WHERE id = $2', [status, invoiceId]);
  return status;
}

const isFrozen = status => INVOICE_FROZEN_STATUSES.includes(status);

async function recordAudit({ invoiceId, action, actorKind, actorUserId, actorIp, details }) {
  try {
    await pool.query(
      `INSERT INTO invoice_audit (invoice_id, action, actor_kind, actor_user_id, actor_ip, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [invoiceId, action, actorKind, actorUserId || null, actorIp || null, details ? JSON.stringify(details) : null]
    );
  } catch (err) {
    logger.error({ err, invoiceId, action }, 'invoice audit write failed');
  }
}

// The per-company invoice-number generator, as an inline SQL expression (matches
// the estimates 'EST-YYYY-NNNN' pattern). $1 is the company_id in the outer query.
const NUMBER_SQL = `
  (SELECT 'INV-' || EXTRACT(YEAR FROM CURRENT_DATE)::int || '-' ||
          LPAD((COALESCE(MAX(
            CASE WHEN invoice_number ~ ('^INV-' || EXTRACT(YEAR FROM CURRENT_DATE)::int || '-[0-9]+$')
                 THEN SUBSTRING(invoice_number FROM '[0-9]+$')::int ELSE 0 END
          ), 0) + 1)::text, 4, '0')
     FROM invoices WHERE company_id = $1)`;

// Insert a header (with generated number) + lines + totals in one TX; returns the id.
async function createInvoice(client, companyId, userId, fields, lines, { source = 'scratch', source_estimate_id = null } = {}) {
  // Serialize number generation per company within this tx so two concurrent
  // creates can't compute the same MAX+1 and collide on uq_invoices_number.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`invoice_number:${companyId}`]);
  const headRes = await client.query(
    `INSERT INTO invoices
       (company_id, invoice_number, project_id, client_id, client_name_snapshot, client_email,
        project_name, project_address, tax_pct, retainage_pct, issue_date, due_date,
        notes, terms, source, source_estimate_id, created_by)
     VALUES ($1, ${NUMBER_SQL}, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING *`,
    [companyId, fields.project_id, fields.client_id, fields.client_name_snapshot, fields.client_email,
     fields.project_name, fields.project_address, fields.tax_pct, fields.retainage_pct,
     fields.issue_date, fields.due_date, fields.notes, fields.terms, source, source_estimate_id, userId]
  );
  const invoiceId = headRes.rows[0].id;
  for (const ln of lines) {
    await client.query(
      `INSERT INTO invoice_lines (invoice_id, category, sort_order, description, qty, unit, unit_cost_cents, total_cents, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [invoiceId, ln.category, ln.sort_order, ln.description, ln.qty, ln.unit, ln.unit_cost_cents, ln.total_cents, ln.notes]
    );
  }
  await recomputeTotals(client, invoiceId);
  return { invoiceId, number: headRes.rows[0].invoice_number };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /invoices — list with filters
router.get('/', requireAuth, requireCommercialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  const { status, project_id, client_id, q } = req.query;
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const conditions = ['company_id = $1'];
  const params = [companyId];
  if (status) {
    if (!INVOICE_STATUSES.includes(status)) return res.status(400).json({ error: 'invalid status' });
    params.push(status); conditions.push(`status = $${params.length}`);
  }
  if (project_id) { params.push(project_id); conditions.push(`project_id = $${params.length}`); }
  if (client_id) { params.push(client_id); conditions.push(`client_id = $${params.length}`); }
  if (q) {
    // Escape ILIKE metacharacters so a literal % or _ in the query matches
    // literally (default backslash escape) rather than acting as a wildcard.
    params.push(`%${String(q).replace(/([\\%_])/g, '\\$1')}%`);
    conditions.push(`(project_name ILIKE $${params.length} OR client_name_snapshot ILIKE $${params.length} OR invoice_number ILIKE $${params.length})`);
  }
  const where = conditions.join(' AND ');
  try {
    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM invoices WHERE ${where}`, params),
      pool.query(
        `SELECT i.id, i.invoice_number, i.project_id, i.project_name, i.client_name_snapshot, i.status,
                i.subtotal_cents, i.total_cents, i.retainage_held_cents, i.issue_date, i.due_date, i.sent_at, i.created_at,
                COALESCE((SELECT SUM(amount_cents) FROM invoice_payments p WHERE p.invoice_id = i.id), 0) AS amount_paid_cents
           FROM invoices i WHERE ${where}
          ORDER BY i.created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    const total = parseInt(countRes.rows[0].count, 10);
    res.json({ items: dataRes.rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    req.log.error({ err }, 'invoices list error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /invoices — create a draft from scratch (with optional initial lines)
router.post('/', requireAuth, requireCommercialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  const fields = readHeaderFields(req.body);
  if (!fields.client_name_snapshot) return res.status(400).json({ error: 'client_name_snapshot is required' });
  for (const k of ['tax_pct', 'retainage_pct']) {
    if (fields[k] === null) return res.status(400).json({ error: `${k} out of range` });
  }
  const rawLines = Array.isArray(req.body.lines) ? req.body.lines : [];
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const n = normaliseLine(rawLines[i], i);
    if (!n) return res.status(400).json({ error: `invalid line at index ${i}` });
    lines.push(n);
  }
  // A referenced project/client must belong to this company (null is allowed — scratch
  // invoices need no project). Without this the row could point at another tenant's client.
  if (!(await projectBelongsToCompany(pool, fields.project_id, companyId))) return res.status(400).json({ error: 'invalid project_id' });
  if (!(await clientBelongsToCompany(pool, fields.client_id, companyId))) return res.status(400).json({ error: 'invalid client_id' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { invoiceId, number } = await createInvoice(client, companyId, req.user.id, fields, lines, { source: 'scratch' });
    await client.query('COMMIT');
    await recordAudit({ invoiceId, action: 'created', actorKind: 'admin', actorUserId: req.user.id, actorIp: req.ip, details: { line_count: lines.length } });
    await logAudit(companyId, req.user.id, req.user.full_name, 'invoice.created', 'invoice', invoiceId, number, null);
    res.status(201).json(await loadInvoiceFull(companyId, invoiceId));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'invoice create error');
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// POST /invoices/from-estimate/:estimateId — draft invoice from an accepted estimate
router.post('/from-estimate/:estimateId', requireAuth, requireCommercialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  const client = await pool.connect();
  try {
    const estRes = await client.query(
      `SELECT id, status, client_id, client_name_snapshot, client_email, project_name, project_address,
              tax_pct, converted_project_id
         FROM estimates WHERE id = $1 AND company_id = $2`,
      [req.params.estimateId, companyId]
    );
    if (estRes.rowCount === 0) return res.status(404).json({ error: 'Estimate not found' });
    const est = estRes.rows[0];
    if (est.status !== 'accepted') return res.status(409).json({ error: 'Only an accepted estimate can be invoiced' });
    const estLines = (await client.query(
      'SELECT category, sort_order, description, qty, unit, unit_cost_cents, total_cents, notes FROM estimate_lines WHERE estimate_id = $1 ORDER BY sort_order, id',
      [est.id]
    )).rows.map((l, i) => ({ ...l, sort_order: i }));
    const fields = {
      project_id: est.converted_project_id, client_id: est.client_id,
      client_name_snapshot: est.client_name_snapshot, client_email: est.client_email,
      project_name: est.project_name, project_address: est.project_address,
      tax_pct: parseFloat(est.tax_pct) || 0, retainage_pct: 0,
      issue_date: null, due_date: null, notes: null, terms: null,
    };
    await client.query('BEGIN');
    const { invoiceId, number } = await createInvoice(client, companyId, req.user.id, fields, estLines, { source: 'estimate', source_estimate_id: est.id });
    await client.query('COMMIT');
    await recordAudit({ invoiceId, action: 'created', actorKind: 'admin', actorUserId: req.user.id, actorIp: req.ip, details: { from_estimate: est.id, line_count: estLines.length } });
    await logAudit(companyId, req.user.id, req.user.full_name, 'invoice.created', 'invoice', invoiceId, number, null);
    res.status(201).json(await loadInvoiceFull(companyId, invoiceId));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'invoice from-estimate error');
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// POST /invoices/from-project/:projectId — draft invoice prefilled from the
// project's approved labor (one line at labor cost) + its expenses (a line each),
// editable before send. The T&M path — bill at cost, mark up on the draft.
router.post('/from-project/:projectId', requireAuth, requireCommercialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const projRes = await pool.query(
      `SELECT p.id, p.name, p.client_id, c.name AS client_name, c.contact_email
         FROM projects p LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1 AND p.company_id = $2`,
      [req.params.projectId, companyId]
    );
    if (projRes.rowCount === 0) return res.status(404).json({ error: 'Project not found' });
    const proj = projRes.rows[0];
    const settings = await loadSettings(companyId);
    const [entriesRes, expensesRes] = await Promise.all([
      pool.query(
        `SELECT ${LABOR_ENTRY_COLUMNS} FROM time_entries te JOIN users u ON u.id = te.user_id
          WHERE te.project_id = $1 AND te.status = 'approved'`,
        [proj.id]
      ),
      pool.query(
        'SELECT category, description, amount_cents FROM project_expenses WHERE project_id = $1 ORDER BY id',
        [proj.id]
      ),
    ]);
    const laborCents = laborCostCents(entriesRes.rows, settings);
    const lines = [];
    let sort = 0;
    if (laborCents > 0) lines.push({ category: 'labor', sort_order: sort++, description: `Labor — ${proj.name}`, qty: 1, unit: null, unit_cost_cents: laborCents, total_cents: laborCents, notes: null });
    for (const e of expensesRes.rows) {
      const amt = parseInt(e.amount_cents, 10) || 0;
      if (amt <= 0) continue; // skip $0 expenses — they'd just clutter the draft
      lines.push({ category: MONEY_CATEGORIES.includes(e.category) ? e.category : 'other', sort_order: sort++, description: e.description || 'Expense', qty: 1, unit: null, unit_cost_cents: amt, total_cents: amt, notes: null });
    }
    if (lines.length === 0) return res.status(400).json({ error: 'No approved labor or expenses to invoice on this project' });
    const fields = {
      project_id: proj.id, client_id: proj.client_id,
      client_name_snapshot: proj.client_name || proj.name || '(no client)', client_email: proj.contact_email || null,
      project_name: proj.name, project_address: null, tax_pct: 0, retainage_pct: 0,
      issue_date: null, due_date: null, notes: null, terms: null,
    };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { invoiceId, number } = await createInvoice(client, companyId, req.user.id, fields, lines, { source: 'project' });
      await client.query('COMMIT');
      await recordAudit({ invoiceId, action: 'created', actorKind: 'admin', actorUserId: req.user.id, actorIp: req.ip, details: { from_project: proj.id, line_count: lines.length } });
      await logAudit(companyId, req.user.id, req.user.full_name, 'invoice.created', 'invoice', invoiceId, number, null);
      res.status(201).json(await loadInvoiceFull(companyId, invoiceId));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
  } catch (err) {
    req.log.error({ err }, 'invoice from-project error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /invoices/:id
router.get('/:id', requireAuth, requireCommercialAccess, async (req, res) => {
  try {
    const full = await loadInvoiceFull(req.user.company_id, req.params.id);
    if (!full) return res.status(404).json({ error: 'Invoice not found' });
    const auditRes = await pool.query('SELECT * FROM invoice_audit WHERE invoice_id = $1 ORDER BY created_at', [full.id]);
    full.audit = auditRes.rows;
    res.json(full);
  } catch (err) {
    req.log.error({ err }, 'invoice detail error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /invoices/:id — header fields; draft only
router.patch('/:id', requireAuth, requireCommercialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  const fields = readHeaderFields(req.body);
  for (const k of ['tax_pct', 'retainage_pct']) {
    if (fields[k] === null) return res.status(400).json({ error: `${k} out of range` });
  }
  if (!fields.client_name_snapshot) return res.status(400).json({ error: 'client_name_snapshot is required' });
  if (!(await projectBelongsToCompany(pool, fields.project_id, companyId))) return res.status(400).json({ error: 'invalid project_id' });
  if (!(await clientBelongsToCompany(pool, fields.client_id, companyId))) return res.status(400).json({ error: 'invalid client_id' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the row and re-check frozen INSIDE the tx (like PUT /:id/lines): a
    // concurrent send could otherwise flip draft→sent between the check and this
    // UPDATE and let a total-changing edit land on a sent document of record.
    const headRes = await client.query('SELECT status FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE', [req.params.id, companyId]);
    if (headRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Invoice not found' }); }
    if (isFrozen(headRes.rows[0].status)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Invoice is frozen at this status; void and reissue to revise' }); }
    await client.query(
      `UPDATE invoices SET
         project_id=$1, client_id=$2, client_name_snapshot=$3, client_email=$4,
         project_name=$5, project_address=$6, tax_pct=$7, retainage_pct=$8,
         issue_date=$9, due_date=$10, notes=$11, terms=$12, updated_at=NOW()
       WHERE id = $13 AND company_id = $14`,
      [fields.project_id, fields.client_id, fields.client_name_snapshot, fields.client_email,
       fields.project_name, fields.project_address, fields.tax_pct, fields.retainage_pct,
       fields.issue_date, fields.due_date, fields.notes, fields.terms, req.params.id, companyId]
    );
    await recomputeTotals(client, req.params.id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'invoice patch error');
    return res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
  res.json(await loadInvoiceFull(companyId, req.params.id));
});

// PUT /invoices/:id/lines — bulk replace; draft only
router.put('/:id/lines', requireAuth, requireCommercialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  if (!Array.isArray(req.body.lines)) return res.status(400).json({ error: 'lines must be an array' });
  const lines = [];
  for (let i = 0; i < req.body.lines.length; i++) {
    const n = normaliseLine(req.body.lines[i], i);
    if (!n) return res.status(400).json({ error: `invalid line at index ${i}` });
    lines.push(n);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const headRes = await client.query('SELECT status FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE', [req.params.id, companyId]);
    if (headRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Invoice not found' }); }
    if (isFrozen(headRes.rows[0].status)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Invoice is frozen at this status; void and reissue to revise' }); }
    await client.query('DELETE FROM invoice_lines WHERE invoice_id = $1', [req.params.id]);
    for (const ln of lines) {
      await client.query(
        `INSERT INTO invoice_lines (invoice_id, category, sort_order, description, qty, unit, unit_cost_cents, total_cents, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [req.params.id, ln.category, ln.sort_order, ln.description, ln.qty, ln.unit, ln.unit_cost_cents, ln.total_cents, ln.notes]
      );
    }
    const totals = await recomputeTotals(client, req.params.id);
    await client.query('COMMIT');
    res.json({ ...(await loadInvoiceFull(companyId, req.params.id)), totals });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'invoice lines replace error');
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// Amount as a currency string for the email (there's no shared server money
// formatter). Intl gives the right symbol per ISO code; falls back to a plain
// number if the code is odd.
function formatMoney(cents, currency) {
  const n = (parseInt(cents, 10) || 0) / 100;
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(n); }
  catch { return `${n.toFixed(2)} ${currency || 'USD'}`; }
}

// Client-facing "your invoice is ready" email: greeting, balance due, and a
// button to the public /i/<token> view page. Best-effort — the caller sends it
// AFTER the invoice is committed as 'sent', so a delivery failure never blocks
// the send (the admin still has the copyable link). Returns sendEmail()'s result.
async function emailInvoiceToClient({ invoice, token, companyName, currency, replyTo }) {
  const co  = escapeHtml(companyName || 'OpsFloa');
  const num = escapeHtml(invoice.invoice_number || '');
  const who = escapeHtml(invoice.client_name_snapshot || 'there');
  const url = `${APP_URL}/i/${token}`;
  const total   = parseInt(invoice.total_cents, 10) || 0;
  const paid    = parseInt(invoice.amount_paid_cents, 10) || 0;
  const balance = Math.max(0, total - paid);
  const dueLabel = paid > 0 ? 'Balance due' : 'Amount due';
  // due_date is a JS Date here (pg returns DATE columns as Date, and this is
  // pre-JSON) — String(date) is "Mon Jul 20 2026 …", so format to YYYY-MM-DD.
  const dueLine = invoice.due_date
    ? `<p style="color:#6b7280;font-size:13px;margin:0 0 20px">Due ${escapeHtml(new Date(invoice.due_date).toISOString().slice(0, 10))}</p>`
    : '';
  const subject = `Invoice ${invoice.invoice_number} from ${companyName || 'OpsFloa'}`;
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
      <h2 style="color:#1a56db;margin:0 0 8px">Invoice ${num}</h2>
      <p style="color:#444;margin:0 0 16px">Hi ${who}, ${co} sent you an invoice.</p>
      <p style="color:#111827;font-size:16px;margin:0 0 6px"><strong>${dueLabel}: ${formatMoney(balance, currency)}</strong></p>
      ${dueLine}
      <a href="${url}" style="display:inline-block;background:#1a56db;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin-top:8px">View invoice</a>
      <p style="color:#9ca3af;font-size:12px;margin-top:24px;word-break:break-all">${url}</p>
    </div>`;
  // From shows the company name; replies go to the sender (not OpsFloa).
  return sendEmail(invoice.client_email, subject, html, undefined, { fromName: companyName, replyTo });
}

// POST /invoices/:id/send — draft → sent; mint a public token, freeze lines,
// and email the client the link (best-effort). Returns the raw token too so the
// admin can copy the /i/<token> link (and share it manually if there's no email).
router.post('/:id/send', requireAuth, requireCommercialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const headRes = await client.query('SELECT id, status, invoice_number FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE', [req.params.id, companyId]);
    if (headRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Invoice not found' }); }
    if (headRes.rows[0].status !== 'draft') { await client.query('ROLLBACK'); return res.status(409).json({ error: `Cannot send from status '${headRes.rows[0].status}'` }); }
    await recomputeTotals(client, req.params.id);
    const rawToken = crypto.randomBytes(32).toString('hex');
    await client.query(
      `UPDATE invoices SET status = 'sent', sent_at = NOW(),
         issue_date = COALESCE(issue_date, CURRENT_DATE),
         response_token = $1, response_token_hash = $2, updated_at = NOW()
       WHERE id = $3`,
      [rawToken, sha256(rawToken), req.params.id]
    );
    await client.query('COMMIT');
    await recordAudit({ invoiceId: req.params.id, action: 'sent', actorKind: 'admin', actorUserId: req.user.id, actorIp: req.ip });
    await logAudit(companyId, req.user.id, req.user.full_name, 'invoice.sent', 'invoice', req.params.id, headRes.rows[0].invoice_number, null);
    const full = await loadInvoiceFull(companyId, req.params.id);
    // Email the client the /i/<token> link, best-effort. The invoice is already
    // committed 'sent', so a delivery failure/skip just means the admin shares
    // the copyable link instead — never a 500.
    let email = { sent: false, reason: 'no_recipient' };
    if (full.client_email) {
      try {
        const meta = await pool.query(
          `SELECT co.name AS company_name,
                  COALESCE((SELECT value FROM settings s WHERE s.company_id = $1 AND s.key = 'currency'), 'USD') AS currency,
                  (SELECT email FROM users WHERE id = $2) AS sender_email
             FROM companies co WHERE co.id = $1`,
          [companyId, req.user.id]
        );
        const r = await emailInvoiceToClient({
          invoice: full, token: rawToken,
          companyName: meta.rows[0]?.company_name, currency: meta.rows[0]?.currency || 'USD',
          replyTo: meta.rows[0]?.sender_email || null,
        });
        email = r?.ok
          ? { sent: true, to: full.client_email }
          : { sent: false, to: full.client_email, reason: r?.error ? 'error' : (r?.skipped || r?.suppressed || 'unknown') };
      } catch (err) {
        req.log.error({ err }, 'invoice send email error');
        email = { sent: false, to: full.client_email, reason: 'error' };
      }
    }
    res.json({ ...full, response_token: rawToken, email });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'invoice send error');
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// POST /invoices/:id/link — get the client-facing share link for a sent invoice
// again (so the admin can re-copy it). Returns the STORED token, so it matches
// the link already emailed and never rotates. Legacy invoices sent before the
// token was stored mint one on first call (which rotates that one link only).
router.post('/:id/link', requireAuth, requireCommercialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const headRes = await pool.query('SELECT status, response_token FROM invoices WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    if (headRes.rowCount === 0) return res.status(404).json({ error: 'Invoice not found' });
    if (headRes.rows[0].status === 'draft') return res.status(400).json({ error: 'Invoice has not been sent yet' });
    let token = headRes.rows[0].response_token;
    if (!token) {
      token = crypto.randomBytes(32).toString('hex');
      await pool.query('UPDATE invoices SET response_token = $1, response_token_hash = $2 WHERE id = $3 AND company_id = $4', [token, sha256(token), req.params.id, companyId]);
    }
    res.json({ response_token: token });
  } catch (err) {
    req.log.error({ err }, 'invoice link error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /invoices/:id/payments — record a full/partial payment; recompute status.
router.post('/:id/payments', requireAuth, requireCommercialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  const amount = typeof req.body.amount_cents === 'number' ? req.body.amount_cents : parseInt(req.body.amount_cents, 10);
  // Must be a whole number of cents — a fractional value would 500 on the BIGINT
  // column, not 400.
  if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'amount_cents must be a positive integer' });
  const method = INVOICE_PAYMENT_METHODS.includes(req.body.method) ? req.body.method : 'other';
  const paid_date = req.body.paid_date || null;
  if (paid_date && !/^\d{4}-\d{2}-\d{2}$/.test(paid_date)) return res.status(400).json({ error: 'paid_date must be YYYY-MM-DD' });
  const reference = req.body.reference ? req.body.reference.toString().slice(0, 120) : null;
  const notes = req.body.notes ? req.body.notes.toString() : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const headRes = await client.query('SELECT id, status, invoice_number FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE', [req.params.id, companyId]);
    if (headRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Invoice not found' }); }
    if (['draft', 'void'].includes(headRes.rows[0].status)) { await client.query('ROLLBACK'); return res.status(409).json({ error: `Cannot record a payment on a ${headRes.rows[0].status} invoice` }); }
    await client.query(
      `INSERT INTO invoice_payments (invoice_id, company_id, amount_cents, paid_date, method, reference, notes, created_by)
       VALUES ($1,$2,$3, COALESCE($4::date, CURRENT_DATE), $5, $6, $7, $8)`,
      [req.params.id, companyId, amount, paid_date, method, reference, notes, req.user.id]
    );
    const status = await applyPaymentStatus(client, req.params.id);
    await client.query('COMMIT');
    await recordAudit({ invoiceId: req.params.id, action: 'payment', actorKind: 'admin', actorUserId: req.user.id, actorIp: req.ip, details: { amount_cents: amount, method, status } });
    await logAudit(companyId, req.user.id, req.user.full_name, 'invoice.payment', 'invoice', req.params.id, headRes.rows[0].invoice_number, null);
    res.status(201).json(await loadInvoiceFull(companyId, req.params.id));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'invoice payment error');
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// POST /invoices/:id/void — cancel an invoice (any status). Payments stay for the record.
router.post('/:id/void', requireAuth, requireCommercialAccess, async (req, res) => {
  const companyId = req.user.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the row so void can't interleave with a concurrent /payments (which
    // also locks) — otherwise the two status writes could race.
    const headRes = await client.query('SELECT status, invoice_number FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE', [req.params.id, companyId]);
    if (headRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Invoice not found' }); }
    if (headRes.rows[0].status === 'void') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Invoice is already void' }); }
    await client.query("UPDATE invoices SET status = 'void', updated_at = NOW() WHERE id = $1 AND company_id = $2", [req.params.id, companyId]);
    await client.query('COMMIT');
    await recordAudit({ invoiceId: req.params.id, action: 'voided', actorKind: 'admin', actorUserId: req.user.id, actorIp: req.ip });
    await logAudit(companyId, req.user.id, req.user.full_name, 'invoice.voided', 'invoice', req.params.id, headRes.rows[0].invoice_number, null);
    res.json(await loadInvoiceFull(companyId, req.params.id));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'invoice void error');
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// ── Public (client-facing) invoice view ──────────────────────────────────────
const publicRouter = require('express').Router();
const { publicReadLimiter } = require('../middleware/publicLimiters');
publicRouter.use(publicReadLimiter);

publicRouter.get('/view/:token', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT i.id, i.company_id, i.invoice_number, i.project_name, i.client_name_snapshot,
              COALESCE((SELECT value FROM settings s WHERE s.company_id = i.company_id AND s.key = 'currency'), 'USD') AS currency,
              i.subtotal_cents, i.tax_pct, i.tax_cents, i.total_cents, i.retainage_held_cents,
              i.issue_date, i.due_date, i.status, i.sent_at, i.terms, c.language AS client_language,
              co.name AS company_name, co.logo_url AS company_logo_url,
              COALESCE((SELECT SUM(amount_cents) FROM invoice_payments p WHERE p.invoice_id = i.id), 0) AS amount_paid_cents
         FROM invoices i
         LEFT JOIN clients c ON c.id = i.client_id
         LEFT JOIN companies co ON co.id = i.company_id
        WHERE i.response_token_hash = $1`,
      [sha256(req.params.token)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    const linesRes = await pool.query(
      'SELECT category, sort_order, description, qty, unit, total_cents FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order, id',
      [r.rows[0].id]
    );
    res.json({ ...r.rows[0], lines: linesRes.rows });
  } catch (err) {
    logger.error({ err }, 'public invoice view error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.publicRouter = publicRouter;
module.exports = router;
