const router  = require('express').Router();
const crypto  = require('crypto');
const pool    = require('../db');
const logger  = require('../logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../auditLog');
const {
  ESTIMATE_STATUSES,
  ESTIMATE_FROZEN_STATUSES,
  MONEY_CATEGORIES,
  computeEstimateTotals,
  computeLineTotal,
} = require('../constants/projectMoneyEnums');

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// Validation helpers — keep route handlers narrow.

function isNonNegFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

// Coerce a possibly-string percentage into a number in [0, 100].
function parsePct(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(v);
  // Tightened to 100% in 0115. The DB CHECK constraint now bounds at
  // 100; accepting >100 here would just produce a 500 from PG. Keeping
  // route-level rejection at 400 gives a clearer error than a constraint
  // violation surfacing as a server error.
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

// Pull the editable header fields out of a request body.
function readHeaderFields(body) {
  return {
    client_id:            body.client_id ?? null,
    client_name_snapshot: (body.client_name_snapshot || '').toString().trim(),
    client_email:         body.client_email ? body.client_email.toString().trim() : null,
    project_address:      body.project_address || null,
    project_name:         (body.project_name || '').toString().trim(),
    scope_summary:        body.scope_summary || null,
    overhead_pct:         parsePct(body.overhead_pct),
    margin_pct:           parsePct(body.margin_pct),
    contingency_pct:      parsePct(body.contingency_pct),
    tax_pct:              parsePct(body.tax_pct),
    valid_until:          body.valid_until || null,
    notes:                body.notes || null,
    exclusions:           body.exclusions || null,
    terms:                body.terms || null,
  };
}

// ── Helpers for line items ────────────────────────────────────────────────────

// Read a single line and round qty × unit_cost to a cent total. Returns
// null if the line is malformed (caller should 400).
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
  const total_cents = computeLineTotal({ qty, unit_cost_cents });
  return {
    category: line.category,
    sort_order: Number.isFinite(sortOrder) ? sortOrder : 0,
    description,
    qty,
    unit: line.unit ? line.unit.toString().slice(0, 20) : null,
    unit_cost_cents,
    total_cents,
    notes: line.notes ? line.notes.toString() : null,
  };
}

async function loadEstimateFull(companyId, estimateId) {
  // client_language drives the PDF's language (the client's preference,
  // resolved live from clients.language; NULL when the estimate has no
  // linked client → the renderer falls back to English).
  const headRes = await pool.query(
    `SELECT e.*, c.language AS client_language
       FROM estimates e
       LEFT JOIN clients c ON c.id = e.client_id
      WHERE e.id = $1 AND e.company_id = $2`,
    [estimateId, companyId]
  );
  if (headRes.rowCount === 0) return null;
  const linesRes = await pool.query(
    'SELECT * FROM estimate_lines WHERE estimate_id = $1 ORDER BY sort_order, id',
    [estimateId]
  );
  return { ...headRes.rows[0], lines: linesRes.rows };
}

async function recomputeAndStoreTotals(client, estimateId) {
  // Run inside a TX-bound client so the SUM and the UPDATE see the same snapshot.
  const headRes = await client.query(
    'SELECT overhead_pct, margin_pct, contingency_pct, tax_pct FROM estimates WHERE id = $1',
    [estimateId]
  );
  if (headRes.rowCount === 0) throw new Error('estimate not found');
  const linesRes = await client.query(
    'SELECT total_cents FROM estimate_lines WHERE estimate_id = $1',
    [estimateId]
  );
  const lines = linesRes.rows.map(r => ({ total_cents: parseInt(r.total_cents, 10) }));
  const head = headRes.rows[0];
  const totals = computeEstimateTotals({
    lines,
    overhead_pct:    parseFloat(head.overhead_pct),
    margin_pct:      parseFloat(head.margin_pct),
    contingency_pct: parseFloat(head.contingency_pct),
    tax_pct:         parseFloat(head.tax_pct),
  });
  await client.query(
    'UPDATE estimates SET subtotal_cents = $1, total_cents = $2 WHERE id = $3',
    [totals.subtotal, totals.total, estimateId]
  );
  return totals;
}

function isFrozen(status) {
  return ESTIMATE_FROZEN_STATUSES.includes(status);
}

async function recordAudit({ estimateId, action, actorKind, actorUserId, actorIp, details }) {
  try {
    await pool.query(
      `INSERT INTO estimate_audit (estimate_id, action, actor_kind, actor_user_id, actor_ip, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [estimateId, action, actorKind, actorUserId || null, actorIp || null, details ? JSON.stringify(details) : null]
    );
  } catch (err) {
    // Audit must not break the primary action.
    logger.error({ err, estimateId, action }, 'estimate audit write failed');
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /estimates — list with filters
router.get('/', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const { status, client_id, q } = req.query;
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const conditions = ['company_id = $1'];
  const params = [companyId];
  if (status) {
    if (!ESTIMATE_STATUSES.includes(status)) return res.status(400).json({ error: 'invalid status' });
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (client_id) {
    params.push(client_id);
    conditions.push(`client_id = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(project_name ILIKE $${params.length} OR client_name_snapshot ILIKE $${params.length} OR estimate_number ILIKE $${params.length})`);
  }
  const where = conditions.join(' AND ');
  try {
    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM estimates WHERE ${where}`, params),
      pool.query(
        `SELECT id, estimate_number, project_name, client_name_snapshot, status,
                subtotal_cents, total_cents, valid_until, sent_at, responded_at, created_at
           FROM estimates WHERE ${where}
          ORDER BY created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    const total = parseInt(countRes.rows[0].count, 10);
    res.json({ items: dataRes.rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    req.log.error({ err }, 'estimates list error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /estimates — create a draft (with optional initial lines)
router.post('/', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const fields = readHeaderFields(req.body);
  if (!fields.project_name) return res.status(400).json({ error: 'project_name is required' });
  if (!fields.client_name_snapshot) return res.status(400).json({ error: 'client_name_snapshot is required' });
  for (const k of ['overhead_pct', 'margin_pct', 'contingency_pct', 'tax_pct']) {
    if (fields[k] === null) return res.status(400).json({ error: `${k} out of range` });
  }
  const rawLines = Array.isArray(req.body.lines) ? req.body.lines : [];
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const n = normaliseLine(rawLines[i], i);
    if (!n) return res.status(400).json({ error: `invalid line at index ${i}` });
    lines.push(n);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const headRes = await client.query(
      `INSERT INTO estimates
        (company_id, estimate_number, client_id, client_name_snapshot, client_email,
         project_address, project_name, scope_summary,
         overhead_pct, margin_pct, contingency_pct, tax_pct,
         valid_until, notes, exclusions, terms, created_by)
       VALUES
        ($1,
         (SELECT 'EST-' ||
                 EXTRACT(YEAR FROM CURRENT_DATE)::int ||
                 '-' ||
                 LPAD((COALESCE(MAX(
                   CASE WHEN estimate_number ~ '^EST-' || EXTRACT(YEAR FROM CURRENT_DATE)::int || '-[0-9]+$'
                        THEN SUBSTRING(estimate_number FROM '[0-9]+$')::int
                        ELSE 0 END
                 ), 0) + 1)::text, 4, '0')
          FROM estimates WHERE company_id = $1),
         $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [companyId, fields.client_id, fields.client_name_snapshot, fields.client_email,
       fields.project_address, fields.project_name, fields.scope_summary,
       fields.overhead_pct, fields.margin_pct, fields.contingency_pct, fields.tax_pct,
       fields.valid_until, fields.notes, fields.exclusions, fields.terms, req.user.id]
    );
    const estimateId = headRes.rows[0].id;
    for (const ln of lines) {
      await client.query(
        `INSERT INTO estimate_lines
          (estimate_id, category, sort_order, description, qty, unit, unit_cost_cents, total_cents, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [estimateId, ln.category, ln.sort_order, ln.description, ln.qty, ln.unit, ln.unit_cost_cents, ln.total_cents, ln.notes]
      );
    }
    await recomputeAndStoreTotals(client, estimateId);
    await client.query('COMMIT');
    await recordAudit({
      estimateId, action: 'created', actorKind: 'admin',
      actorUserId: req.user.id, actorIp: req.ip,
      details: { line_count: lines.length },
    });
    await logAudit(companyId, req.user.id, req.user.full_name,
      'estimate.created', 'estimate', estimateId, headRes.rows[0].estimate_number, null);
    const full = await loadEstimateFull(companyId, estimateId);
    res.status(201).json(full);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'estimate create error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// GET /estimates/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const full = await loadEstimateFull(req.user.company_id, req.params.id);
    if (!full) return res.status(404).json({ error: 'Estimate not found' });
    const auditRes = await pool.query(
      'SELECT * FROM estimate_audit WHERE estimate_id = $1 ORDER BY created_at',
      [full.id]
    );
    full.audit = auditRes.rows;
    res.json(full);
  } catch (err) {
    req.log.error({ err }, 'estimate detail error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /estimates/:id — header fields only; draft only
router.patch('/:id', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const headRes = await pool.query(
      'SELECT status FROM estimates WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (headRes.rowCount === 0) return res.status(404).json({ error: 'Estimate not found' });
    if (isFrozen(headRes.rows[0].status)) {
      return res.status(409).json({ error: 'Estimate is frozen at this status; duplicate to revise' });
    }
    const fields = readHeaderFields(req.body);
    for (const k of ['overhead_pct', 'margin_pct', 'contingency_pct', 'tax_pct']) {
      if (fields[k] === null) return res.status(400).json({ error: `${k} out of range` });
    }
    if (!fields.project_name) return res.status(400).json({ error: 'project_name is required' });
    if (!fields.client_name_snapshot) return res.status(400).json({ error: 'client_name_snapshot is required' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE estimates SET
           client_id=$1, client_name_snapshot=$2, client_email=$3,
           project_address=$4, project_name=$5, scope_summary=$6,
           overhead_pct=$7, margin_pct=$8, contingency_pct=$9, tax_pct=$10,
           valid_until=$11, notes=$12, exclusions=$13, terms=$14
         WHERE id = $15`,
        [fields.client_id, fields.client_name_snapshot, fields.client_email,
         fields.project_address, fields.project_name, fields.scope_summary,
         fields.overhead_pct, fields.margin_pct, fields.contingency_pct, fields.tax_pct,
         fields.valid_until, fields.notes, fields.exclusions, fields.terms,
         req.params.id]
      );
      await recomputeAndStoreTotals(client, req.params.id);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    const full = await loadEstimateFull(companyId, req.params.id);
    res.json(full);
  } catch (err) {
    req.log.error({ err }, 'estimate patch error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /estimates/:id/lines — bulk replace; draft only
router.put('/:id/lines', requireAdmin, async (req, res) => {
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
    const headRes = await client.query(
      'SELECT status FROM estimates WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [req.params.id, companyId]
    );
    if (headRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Estimate not found' });
    }
    if (isFrozen(headRes.rows[0].status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Estimate is frozen at this status; duplicate to revise' });
    }
    await client.query('DELETE FROM estimate_lines WHERE estimate_id = $1', [req.params.id]);
    for (const ln of lines) {
      await client.query(
        `INSERT INTO estimate_lines
          (estimate_id, category, sort_order, description, qty, unit, unit_cost_cents, total_cents, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [req.params.id, ln.category, ln.sort_order, ln.description, ln.qty, ln.unit, ln.unit_cost_cents, ln.total_cents, ln.notes]
      );
    }
    const totals = await recomputeAndStoreTotals(client, req.params.id);
    await client.query('COMMIT');
    const full = await loadEstimateFull(companyId, req.params.id);
    res.json({ ...full, totals });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'estimate lines replace error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// POST /estimates/:id/send — draft → sent. Generates response token,
// freezes the line items, recomputes totals one last time. Email sending
// is wired in the email Phase (this commit returns the raw token to the
// admin for now so they can preview the URL).
router.post('/:id/send', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const headRes = await client.query(
      'SELECT id, status, estimate_number FROM estimates WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [req.params.id, companyId]
    );
    if (headRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Estimate not found' });
    }
    if (headRes.rows[0].status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Cannot send from status '${headRes.rows[0].status}'` });
    }
    // Re-snap totals against current lines just before freezing.
    await recomputeAndStoreTotals(client, req.params.id);
    const rawToken = crypto.randomBytes(32).toString('hex');
    await client.query(
      // No email is actually sent on /send today — the raw token is
      // returned in the response and the admin shares it manually. The
      // send_email_status column stays NULL until a real email path
      // gets wired AND patches it to 'sent' / 'failed'. Writing
      // 'pending' here would leave every estimate forever-pending and
      // make the column meaningless as a failure signal.
      `UPDATE estimates SET status = 'sent', sent_at = NOW(), response_token_hash = $1 WHERE id = $2`,
      [sha256(rawToken), req.params.id]
    );
    await client.query('COMMIT');
    await recordAudit({
      estimateId: req.params.id, action: 'sent', actorKind: 'admin',
      actorUserId: req.user.id, actorIp: req.ip,
    });
    await logAudit(companyId, req.user.id, req.user.full_name,
      'estimate.sent', 'estimate', req.params.id, headRes.rows[0].estimate_number, null);
    const full = await loadEstimateFull(companyId, req.params.id);
    // Return the raw token only on this response — it disappears after.
    res.json({ ...full, response_token: rawToken });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'estimate send error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// POST /estimates/:id/withdraw — admin cancels (draft or sent)
router.post('/:id/withdraw', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const headRes = await pool.query(
      'SELECT status, estimate_number FROM estimates WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (headRes.rowCount === 0) return res.status(404).json({ error: 'Estimate not found' });
    if (!['draft', 'sent'].includes(headRes.rows[0].status)) {
      return res.status(409).json({ error: `Cannot withdraw from status '${headRes.rows[0].status}'` });
    }
    await pool.query(
      `UPDATE estimates SET status='withdrawn', responded_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    await recordAudit({
      estimateId: req.params.id, action: 'withdrawn', actorKind: 'admin',
      actorUserId: req.user.id, actorIp: req.ip,
    });
    await logAudit(companyId, req.user.id, req.user.full_name,
      'estimate.withdrawn', 'estimate', req.params.id, headRes.rows[0].estimate_number, null);
    const full = await loadEstimateFull(companyId, req.params.id);
    res.json(full);
  } catch (err) {
    req.log.error({ err }, 'estimate withdraw error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /estimates/:id/convert — accepted → project. Creates a projects
// row AND seeds project_budget_categories with one row per category
// summed from the estimate lines. The shared MONEY_CATEGORIES vocabulary
// is what makes this seamless — same column values, no mapping table.
router.post('/:id/convert', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const headRes = await client.query(
      'SELECT * FROM estimates WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [req.params.id, companyId]
    );
    if (headRes.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Estimate not found' });
    }
    const est = headRes.rows[0];
    if (est.status !== 'accepted') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Estimate must be accepted before convert' });
    }
    if (est.converted_project_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Estimate already converted' });
    }
    // Honour valid_until on convert too. Public accept enforces this,
    // but if the convert is fired late (admin clicked convert after
    // the validity window closed) the price commitment is stale.
    if (est.valid_until) {
      const exp = new Date(`${est.valid_until}T23:59:59Z`);
      if (Date.now() > exp.getTime()) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Estimate has expired since acceptance — duplicate to revise' });
      }
    }
    // Sum line totals by category — this is the seed for budget categories.
    const catSumsRes = await client.query(
      `SELECT category, SUM(total_cents)::bigint AS sum_cents
         FROM estimate_lines
        WHERE estimate_id = $1
        GROUP BY category`,
      [req.params.id]
    );
    const projRes = await client.query(
      `INSERT INTO projects (company_id, name, address, budget_dollars, active, client_id, created_at)
       VALUES ($1, $2, $3, $4, true, $5, NOW()) RETURNING id`,
      [companyId, est.project_name, est.project_address,
       // Keep budget_dollars populated for legacy reads during the
       // transition. Total in dollars (round at the cent edge).
       Math.round(parseInt(est.total_cents, 10) / 100),
       est.client_id]
    );
    const projectId = projRes.rows[0].id;
    // Seed per-category budgets. Skip zero-cent rows so unused categories
    // don't litter the budget bar.
    for (const row of catSumsRes.rows) {
      const cents = parseInt(row.sum_cents, 10);
      if (!cents) continue;
      await client.query(
        `INSERT INTO project_budget_categories (project_id, category, budget_cents)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id, category) DO UPDATE SET budget_cents = EXCLUDED.budget_cents`,
        [projectId, row.category, cents]
      );
    }
    await client.query(
      `UPDATE estimates SET converted_project_id = $1 WHERE id = $2`,
      [projectId, req.params.id]
    );
    await client.query('COMMIT');
    await recordAudit({
      estimateId: req.params.id, action: 'converted', actorKind: 'admin',
      actorUserId: req.user.id, actorIp: req.ip,
      details: { project_id: projectId, categories_seeded: catSumsRes.rowCount },
    });
    await logAudit(companyId, req.user.id, req.user.full_name,
      'estimate.converted', 'estimate', req.params.id, est.estimate_number,
      { project_id: projectId, categories_seeded: catSumsRes.rowCount });
    const full = await loadEstimateFull(companyId, req.params.id);
    res.json({ ...full, project_id: projectId, categories_seeded: catSumsRes.rowCount });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'estimate convert error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── Public endpoints (no auth, token-keyed) ──────────────────────────────────

const publicRouter = require('express').Router();

publicRouter.get('/view/:token', async (req, res) => {
  try {
    // PUBLIC (client-facing) view: deliberately omits the internal cost
    // structure. overhead_pct / margin_pct / contingency_pct expose the
    // contractor's profit markup; per-line unit_cost_cents is the cost
    // basis; the estimate-level `notes` field is internal. The client sees
    // subtotal / tax / total, scope, exclusions, terms, and line totals —
    // the same numbers the PDF shows them — but not the buildup.
    const r = await pool.query(
      `SELECT id, company_id, estimate_number, project_name, client_name_snapshot, scope_summary,
              subtotal_cents, tax_pct, total_cents,
              valid_until, status, sent_at, responded_at, accepted_signer_name,
              exclusions, terms
         FROM estimates WHERE response_token_hash = $1`,
      [sha256(req.params.token)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    const linesRes = await pool.query(
      'SELECT category, sort_order, description, qty, unit, total_cents FROM estimate_lines WHERE estimate_id = $1 ORDER BY sort_order, id',
      [r.rows[0].id]
    );
    res.json({ ...r.rows[0], lines: linesRes.rows });
  } catch (err) {
    logger.error({ err }, 'public estimate view error');
    res.status(500).json({ error: 'Server error' });
  }
});

publicRouter.post('/accept/:token', async (req, res) => {
  const signerName = (req.body.typed_name || '').toString().trim();
  if (!signerName) return res.status(400).json({ error: 'typed_name is required' });
  const authorized = req.body.authorized === true;
  if (!authorized) return res.status(400).json({ error: 'authorization confirmation required' });
  const tokenHash = sha256(req.params.token);
  const client = await pool.connect();
  try {
    // Lock the row so two simultaneous accepts (double-click / replay) can't
    // both pass the status guard — matches the CO + lien-waiver flows.
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT id, company_id, status, estimate_number, valid_until
         FROM estimates WHERE response_token_hash = $1 FOR UPDATE`,
      [tokenHash]
    );
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const est = r.rows[0];
    if (est.status !== 'sent') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Cannot accept from status '${est.status}'` });
    }
    if (est.valid_until) {
      const exp = new Date(`${est.valid_until}T23:59:59Z`);
      if (Date.now() > exp.getTime()) {
        await client.query(`UPDATE estimates SET status='expired' WHERE id=$1 AND status='sent'`, [est.id]);
        await client.query('COMMIT');
        return res.status(409).json({ error: 'Estimate has expired' });
      }
    }
    const upd = await client.query(
      `UPDATE estimates SET
         status='accepted', responded_at=NOW(),
         accepted_signer_name=$1, accepted_signer_ip=$2
       WHERE id=$3 AND status='sent'`,
      [signerName, req.ip, est.id]
    );
    await client.query('COMMIT');
    if (upd.rowCount === 0) return res.status(409).json({ error: 'Estimate is no longer acceptable' });
    await recordAudit({
      estimateId: est.id, action: 'accepted', actorKind: 'client',
      actorIp: req.ip, details: { typed_name: signerName, user_agent: req.headers['user-agent'] || null },
    });
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err }, 'public estimate accept error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

publicRouter.post('/decline/:token', async (req, res) => {
  const reason = req.body.reason ? req.body.reason.toString().slice(0, 1000) : null;
  try {
    const r = await pool.query(
      `SELECT id, status FROM estimates WHERE response_token_hash = $1`,
      [sha256(req.params.token)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    if (r.rows[0].status !== 'sent') {
      return res.status(409).json({ error: `Cannot decline from status '${r.rows[0].status}'` });
    }
    await pool.query(
      `UPDATE estimates SET status='declined', responded_at=NOW() WHERE id=$1 AND status='sent'`,
      [r.rows[0].id]
    );
    await recordAudit({
      estimateId: r.rows[0].id, action: 'declined', actorKind: 'client',
      actorIp: req.ip, details: { reason },
    });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'public estimate decline error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.publicRouter = publicRouter;
module.exports = router;
