const router  = require('express').Router();
const crypto  = require('crypto');
const pool    = require('../db');
const logger  = require('../logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../auditLog');
const {
  CHANGE_ORDER_STATUSES,
  CHANGE_ORDER_FROZEN_STATUSES,
  MONEY_CATEGORIES,
  computeEstimateTotals,
  computeLineTotal,
} = require('../constants/projectMoneyEnums');

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function isFrozen(status) {
  return CHANGE_ORDER_FROZEN_STATUSES.includes(status);
}

function parsePct(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n) || n < 0 || n > 1000) return null;
  return n;
}

function normaliseLine(line, sortOrder) {
  if (!line || typeof line !== 'object') return null;
  if (!MONEY_CATEGORIES.includes(line.category)) return null;
  const description = (line.description || '').toString().trim();
  if (!description) return null;
  const qty = typeof line.qty === 'number' ? line.qty : parseFloat(line.qty);
  const unit_cost_cents = typeof line.unit_cost_cents === 'number'
    ? line.unit_cost_cents
    : parseInt(line.unit_cost_cents, 10);
  if (!Number.isFinite(qty) || qty < 0) return null;
  if (!Number.isFinite(unit_cost_cents) || unit_cost_cents < 0) return null;
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

async function assertProjectInCompany(companyId, projectId) {
  const r = await pool.query(
    'SELECT id, name FROM projects WHERE id = $1 AND company_id = $2',
    [projectId, companyId]
  );
  return r.rows[0] || null;
}

async function assertCoInCompany(companyId, coId) {
  const r = await pool.query(
    `SELECT co.*, p.name AS project_name
       FROM change_orders co
       JOIN projects p ON co.project_id = p.id
      WHERE co.id = $1 AND co.company_id = $2`,
    [coId, companyId]
  );
  return r.rows[0] || null;
}

async function loadCoFull(companyId, coId) {
  const head = await assertCoInCompany(companyId, coId);
  if (!head) return null;
  const linesRes = await pool.query(
    'SELECT * FROM change_order_lines WHERE change_order_id = $1 ORDER BY sort_order, id',
    [coId]
  );
  return { ...head, lines: linesRes.rows };
}

async function recomputeTotals(client, coId) {
  const head = await client.query(
    'SELECT overhead_pct, margin_pct, tax_pct FROM change_orders WHERE id = $1',
    [coId]
  );
  if (head.rowCount === 0) throw new Error('CO not found');
  const linesRes = await client.query(
    'SELECT total_cents FROM change_order_lines WHERE change_order_id = $1',
    [coId]
  );
  const lines = linesRes.rows.map(r => ({ total_cents: parseInt(r.total_cents, 10) }));
  const h = head.rows[0];
  const totals = computeEstimateTotals({
    lines,
    overhead_pct:    parseFloat(h.overhead_pct),
    margin_pct:      parseFloat(h.margin_pct),
    contingency_pct: 0,  // COs don't carry a separate contingency
    tax_pct:         parseFloat(h.tax_pct),
  });
  await client.query(
    'UPDATE change_orders SET subtotal_cents = $1, total_cents = $2 WHERE id = $3',
    [totals.subtotal, totals.total, coId]
  );
  return totals;
}

// ── List + create ────────────────────────────────────────────────────────────

router.get('/change-orders', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const { status, project_id, q } = req.query;
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const conditions = ['co.company_id = $1'];
  const params = [companyId];
  if (status) {
    if (!CHANGE_ORDER_STATUSES.includes(status)) return res.status(400).json({ error: 'invalid status' });
    params.push(status);
    conditions.push(`co.status = $${params.length}`);
  }
  if (project_id) { params.push(project_id); conditions.push(`co.project_id = $${params.length}`); }
  if (q) {
    params.push(`%${q}%`);
    conditions.push(`(co.co_number ILIKE $${params.length} OR co.description ILIKE $${params.length})`);
  }
  const where = conditions.join(' AND ');
  try {
    const [countRes, dataRes] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM change_orders co WHERE ${where}`, params),
      pool.query(
        `SELECT co.*, p.name AS project_name
           FROM change_orders co JOIN projects p ON co.project_id = p.id
          WHERE ${where}
          ORDER BY co.created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    res.json({
      items: dataRes.rows,
      total: parseInt(countRes.rows[0].count, 10),
      page,
      pages: Math.ceil(parseInt(countRes.rows[0].count, 10) / limit),
    });
  } catch (err) {
    req.log.error({ err }, 'CO list error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/projects/:projectId/change-orders', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const description = (req.body.description || '').toString().trim();
  if (!description) return res.status(400).json({ error: 'description is required' });
  const overhead_pct = parsePct(req.body.overhead_pct);
  const margin_pct   = parsePct(req.body.margin_pct);
  const tax_pct      = parsePct(req.body.tax_pct);
  if (overhead_pct === null || margin_pct === null || tax_pct === null) {
    return res.status(400).json({ error: 'percentage out of range' });
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
    const project = await assertProjectInCompany(companyId, req.params.projectId);
    if (!project) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Project not found' });
    }
    const headRes = await client.query(
      `INSERT INTO change_orders
         (company_id, project_id, co_number, description, overhead_pct, margin_pct, tax_pct,
          notes, created_by)
       VALUES
         ($1, $2,
          (SELECT 'CO-' || LPAD((COALESCE(MAX(
             CASE WHEN co_number ~ '^CO-[0-9]+$' THEN SUBSTRING(co_number FROM '[0-9]+')::int
                  ELSE 0 END
           ), 0) + 1)::text, 3, '0')
           FROM change_orders WHERE project_id = $2),
          $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [companyId, req.params.projectId, description, overhead_pct, margin_pct, tax_pct,
       req.body.notes || null, req.user.id]
    );
    const coId = headRes.rows[0].id;
    for (const ln of lines) {
      await client.query(
        `INSERT INTO change_order_lines
           (change_order_id, category, sort_order, description, qty, unit, unit_cost_cents, total_cents, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [coId, ln.category, ln.sort_order, ln.description, ln.qty, ln.unit, ln.unit_cost_cents, ln.total_cents, ln.notes]
      );
    }
    await recomputeTotals(client, coId);
    await client.query('COMMIT');
    await logAudit(companyId, req.user.id, req.user.full_name,
      'change_order.created', 'change_order', coId, headRes.rows[0].co_number,
      { project_id: req.params.projectId, line_count: lines.length });
    const full = await loadCoFull(companyId, coId);
    res.status(201).json(full);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'CO create error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.get('/change-orders/:id', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const full = await loadCoFull(companyId, req.params.id);
    if (!full) return res.status(404).json({ error: 'Change order not found' });
    res.json(full);
  } catch (err) {
    req.log.error({ err }, 'CO detail error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/change-orders/:id', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const co = await assertCoInCompany(companyId, req.params.id);
    if (!co) return res.status(404).json({ error: 'Change order not found' });
    if (isFrozen(co.status)) return res.status(409).json({ error: 'CO is frozen at this status' });
    const fields = [];
    const params = [];
    let idx = 1;
    if (req.body.description !== undefined) {
      const v = (req.body.description || '').toString().trim();
      if (!v) return res.status(400).json({ error: 'description cannot be empty' });
      fields.push(`description = $${idx++}`); params.push(v);
    }
    for (const k of ['overhead_pct', 'margin_pct', 'tax_pct']) {
      if (req.body[k] !== undefined) {
        const v = parsePct(req.body[k]);
        if (v === null) return res.status(400).json({ error: `${k} out of range` });
        fields.push(`${k} = $${idx++}`); params.push(v);
      }
    }
    if (req.body.notes !== undefined) { fields.push(`notes = $${idx++}`); params.push(req.body.notes || null); }
    if (fields.length === 0) return res.json(co);
    params.push(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE change_orders SET ${fields.join(', ')} WHERE id = $${idx}`,
        params
      );
      await recomputeTotals(client, req.params.id);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    const full = await loadCoFull(companyId, req.params.id);
    res.json(full);
  } catch (err) {
    req.log.error({ err }, 'CO patch error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/change-orders/:id/lines', requireAdmin, async (req, res) => {
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
      'SELECT status FROM change_orders WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [req.params.id, companyId]
    );
    if (headRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Change order not found' }); }
    if (isFrozen(headRes.rows[0].status)) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'CO is frozen' }); }
    await client.query('DELETE FROM change_order_lines WHERE change_order_id = $1', [req.params.id]);
    for (const ln of lines) {
      await client.query(
        `INSERT INTO change_order_lines
           (change_order_id, category, sort_order, description, qty, unit, unit_cost_cents, total_cents, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [req.params.id, ln.category, ln.sort_order, ln.description, ln.qty, ln.unit, ln.unit_cost_cents, ln.total_cents, ln.notes]
      );
    }
    await recomputeTotals(client, req.params.id);
    await client.query('COMMIT');
    const full = await loadCoFull(companyId, req.params.id);
    res.json(full);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'CO lines replace error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

router.post('/change-orders/:id/send', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const headRes = await client.query(
      'SELECT id, status, co_number FROM change_orders WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [req.params.id, companyId]
    );
    if (headRes.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'CO not found' }); }
    if (headRes.rows[0].status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Cannot send from status '${headRes.rows[0].status}'` });
    }
    await recomputeTotals(client, req.params.id);
    const rawToken = crypto.randomBytes(32).toString('hex');
    await client.query(
      `UPDATE change_orders SET status='sent', sent_at=NOW(), response_token_hash=$1, send_email_status='pending' WHERE id=$2`,
      [sha256(rawToken), req.params.id]
    );
    await client.query('COMMIT');
    await logAudit(companyId, req.user.id, req.user.full_name,
      'change_order.sent', 'change_order', req.params.id, headRes.rows[0].co_number, null);
    const full = await loadCoFull(companyId, req.params.id);
    res.json({ ...full, response_token: rawToken });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'CO send error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.post('/change-orders/:id/withdraw', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const co = await assertCoInCompany(companyId, req.params.id);
    if (!co) return res.status(404).json({ error: 'CO not found' });
    if (!['draft', 'sent'].includes(co.status)) {
      return res.status(409).json({ error: `Cannot withdraw from '${co.status}'` });
    }
    await pool.query(
      `UPDATE change_orders SET status='withdrawn', responded_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    await logAudit(companyId, req.user.id, req.user.full_name,
      'change_order.withdrawn', 'change_order', req.params.id, co.co_number, null);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, 'CO withdraw error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin-side accept (e.g. shop-internal approval; the public token-keyed
// path also exists). Both flow through the same budget-bump logic.
//
// Guarded against double-bumping by the budget_applied_at column on the CO
// row: if it's already set, this is a no-op. This matters because admins
// could (in theory) flip status manually or roll a CO back; the public
// accept path also has a status guard, but budget_applied_at is the
// canonical idempotency flag and the code now actually checks it.
async function applyAcceptedCoToBudget(client, coId, projectId) {
  // Lock the project row too. The CO FOR UPDATE prevents concurrent CO
  // accepts; locking the project prevents a concurrent admin budget edit
  // in routes/projectBudget.js from racing the UPSERT and producing a
  // lost-write on budget_cents.
  await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
  // Idempotency check — read with FOR UPDATE so a concurrent accept
  // can't squeeze through between the read and the marker write.
  const guardRes = await client.query(
    `SELECT budget_applied_at, total_cents FROM change_orders WHERE id = $1 FOR UPDATE`,
    [coId]
  );
  if (guardRes.rowCount === 0) return 0;
  if (guardRes.rows[0].budget_applied_at) {
    // Already applied — no-op so duplicate accept can't double-bump.
    return 0;
  }
  const totalCents = parseInt(guardRes.rows[0].total_cents, 10) || 0;

  // Aggregate line totals by category.
  const sumsRes = await client.query(
    `SELECT category, SUM(total_cents)::bigint AS sum_cents
       FROM change_order_lines
      WHERE change_order_id = $1
      GROUP BY category`,
    [coId]
  );
  // For each category with a positive delta, upsert into
  // project_budget_categories — INCREMENT existing budget rather than
  // overwrite.
  for (const row of sumsRes.rows) {
    const cents = parseInt(row.sum_cents, 10);
    if (!cents) continue;
    await client.query(
      `INSERT INTO project_budget_categories (project_id, category, budget_cents)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id, category) DO UPDATE SET
         budget_cents = project_budget_categories.budget_cents + EXCLUDED.budget_cents`,
      [projectId, row.category, cents]
    );
  }
  // Reset the alert watermark + bump legacy budget_dollars by total in
  // dollars. Use a parameterised round on the JS side to avoid the
  // integer-truncation that `(total_cents / 100)` does in SQL — odd
  // cent totals would otherwise drop a dollar.
  const totalDollars = Math.round(totalCents / 100);
  await client.query(
    `UPDATE projects SET budget_alert_pct = NULL,
            budget_dollars = COALESCE(budget_dollars, 0) + $1
      WHERE id = $2`,
    [totalDollars, projectId]
  );
  // Mark the CO as applied so a duplicate re-fire is a no-op.
  await client.query(
    `UPDATE change_orders SET budget_applied_at = NOW() WHERE id = $1`,
    [coId]
  );
  return sumsRes.rowCount;
}

// ── Public token-keyed accept / decline ──────────────────────────────────────

const publicRouter = require('express').Router();

publicRouter.get('/view/:token', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, company_id, project_id, co_number, description, status,
              subtotal_cents, overhead_pct, margin_pct, tax_pct, total_cents,
              sent_at, responded_at, accepted_signer_name, notes
         FROM change_orders WHERE response_token_hash = $1`,
      [sha256(req.params.token)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    const linesRes = await pool.query(
      'SELECT category, sort_order, description, qty, unit, unit_cost_cents, total_cents, notes FROM change_order_lines WHERE change_order_id = $1 ORDER BY sort_order, id',
      [r.rows[0].id]
    );
    res.json({ ...r.rows[0], lines: linesRes.rows });
  } catch (err) {
    logger.error({ err }, 'public CO view error');
    res.status(500).json({ error: 'Server error' });
  }
});

publicRouter.post('/accept/:token', async (req, res) => {
  const signerName = (req.body.typed_name || '').toString().trim();
  if (!signerName) return res.status(400).json({ error: 'typed_name is required' });
  if (req.body.authorized !== true) return res.status(400).json({ error: 'authorization confirmation required' });
  const tokenHash = sha256(req.params.token);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT id, project_id, status, co_number FROM change_orders
        WHERE response_token_hash = $1 FOR UPDATE`,
      [tokenHash]
    );
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    if (r.rows[0].status !== 'sent') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Cannot accept from '${r.rows[0].status}'` });
    }
    await client.query(
      `UPDATE change_orders
         SET status='accepted', responded_at=NOW(),
             accepted_signer_name=$1, accepted_signer_ip=$2
       WHERE id=$3`,
      [signerName, req.ip, r.rows[0].id]
    );
    // Bump the project budget in the same TX so partial failures don't
    // leave the budget out of sync with the accepted CO.
    const bumped = await applyAcceptedCoToBudget(client, r.rows[0].id, r.rows[0].project_id);
    await client.query('COMMIT');
    res.json({ success: true, categories_bumped: bumped });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err }, 'public CO accept error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

publicRouter.post('/decline/:token', async (req, res) => {
  const tokenHash = sha256(req.params.token);
  try {
    const r = await pool.query(
      `SELECT id, status FROM change_orders WHERE response_token_hash = $1`,
      [tokenHash]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    if (r.rows[0].status !== 'sent') return res.status(409).json({ error: `Cannot decline from '${r.rows[0].status}'` });
    await pool.query(
      `UPDATE change_orders SET status='declined', responded_at=NOW() WHERE id=$1`,
      [r.rows[0].id]
    );
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'public CO decline error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.publicRouter = publicRouter;
module.exports = router;
