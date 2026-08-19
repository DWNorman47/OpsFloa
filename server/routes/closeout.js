// Project closeout — orchestrates checklist items derived from other
// modules (punchlist, lien waivers, invoices) into a single screen.
// Manual items live alongside auto-status items; the auto ones are
// computed on read so the closeout view never drifts from the source
// of truth.

const router = require('express').Router();
const pool   = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { logAudit } = require('../auditLog');
const { loadSettings } = require('../utils/paidHours');
const { computeProjectPnl } = require('./projectReports');
const {
  CLOSEOUT_STATUSES,
  CLOSEOUT_ITEM_STATUSES,
  CLOSEOUT_ITEM_DONE_STATUSES,
  CLOSEOUT_ITEM_CATEGORIES,
  DEFAULT_CHECKLIST,
} = require('../constants/closeoutEnums');

async function assertProjectInCompany(companyId, projectId) {
  const r = await pool.query(
    'SELECT id, name FROM projects WHERE id = $1 AND company_id = $2',
    [projectId, companyId]
  );
  return r.rows[0] || null;
}

async function tableExists(name) {
  try {
    const r = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1",
      [name]
    );
    return r.rowCount > 0;
  } catch { return false; }
}

// ── Template ──────────────────────────────────────────────────────────────────

async function ensureTemplate(companyId) {
  const r = await pool.query(
    'SELECT id FROM closeout_checklist_template WHERE company_id = $1 LIMIT 1',
    [companyId]
  );
  if (r.rowCount > 0) return;
  // Seed default template.
  for (const item of DEFAULT_CHECKLIST) {
    await pool.query(
      `INSERT INTO closeout_checklist_template
         (company_id, category, title, description, sort_order, required, auto_source, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
      [companyId, item.category, item.title, item.description || null,
       item.sort_order, item.required, item.auto_source || null]
    );
  }
}

router.get('/closeout-template', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    await ensureTemplate(companyId);
    const r = await pool.query(
      `SELECT * FROM closeout_checklist_template
        WHERE company_id = $1 AND active = true
        ORDER BY sort_order, id`,
      [companyId]
    );
    res.json({ items: r.rows });
  } catch (err) {
    req.log.error({ err }, 'closeout template read error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/closeout-template', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  if (!Array.isArray(req.body.items)) return res.status(400).json({ error: 'items must be an array' });
  // Validate first.
  for (let i = 0; i < req.body.items.length; i++) {
    const it = req.body.items[i];
    if (!CLOSEOUT_ITEM_CATEGORIES.includes(it.category)) {
      return res.status(400).json({ error: `invalid category at index ${i}` });
    }
    if (!it.title || !it.title.toString().trim()) {
      return res.status(400).json({ error: `title required at index ${i}` });
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Replace: soft-mark old rows inactive rather than DELETE so any
    // prior reference remains accessible if needed.
    await client.query(
      `UPDATE closeout_checklist_template SET active = false WHERE company_id = $1 AND active = true`,
      [companyId]
    );
    for (let i = 0; i < req.body.items.length; i++) {
      const it = req.body.items[i];
      await client.query(
        `INSERT INTO closeout_checklist_template
           (company_id, category, title, description, sort_order, required, auto_source, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
        [companyId, it.category, it.title.toString().trim(), it.description || null,
         it.sort_order != null ? it.sort_order : i * 10,
         it.required !== false, it.auto_source || null]
      );
    }
    await client.query('COMMIT');
    await logAudit(companyId, req.user.id, req.user.full_name,
      'closeout_template.updated', null, null, null, { item_count: req.body.items.length });
    const r = await pool.query(
      `SELECT * FROM closeout_checklist_template
        WHERE company_id = $1 AND active = true ORDER BY sort_order, id`,
      [companyId]
    );
    res.json({ items: r.rows });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'closeout template write error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── Auto-status computation ──────────────────────────────────────────────────

// Inspects another module's data to decide whether an auto-status item
// is done. Returns the new status or null to leave unchanged. The map
// must be kept in sync with the auto_source values in DEFAULT_CHECKLIST.
async function computeAutoStatus(companyId, projectId, item) {
  if (!item.auto_source) return null;
  if (item.auto_source === 'punchlist') {
    try {
      const r = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status NOT IN ('resolved','verified')) AS open_count,
           COUNT(*) AS total
         FROM punchlist_items WHERE project_id = $1`,
        [projectId]
      );
      const row = r.rows[0];
      if (parseInt(row.total, 10) === 0) return 'n_a';
      return parseInt(row.open_count, 10) === 0 ? 'done' : 'in_progress';
    } catch { return null; }
  }
  if (item.auto_source === 'lien_waivers' && item.category === 'lien_waivers_subs') {
    if (!(await tableExists('subcontract_pos'))) return null;
    if (!(await tableExists('subcontract_po_payments'))) return null;
    if (!(await tableExists('lien_waivers'))) return null;
    // All sub-PO payments requiring a waiver have received one.
    try {
      const r = await pool.query(
        `SELECT COUNT(*) AS missing
           FROM subcontract_po_payments p
           JOIN subcontract_pos po ON p.po_id = po.id
          WHERE po.project_id = $1
            AND p.waiver_required = true
            AND p.waiver_received = false`,
        [projectId]
      );
      return parseInt(r.rows[0].missing, 10) === 0 ? 'done' : 'in_progress';
    } catch { return null; }
  }
  if (item.auto_source === 'lien_waivers' && item.category === 'lien_waiver_to_owner') {
    if (!(await tableExists('lien_waivers'))) return null;
    try {
      const r = await pool.query(
        `SELECT COUNT(*) AS done
           FROM lien_waivers
          WHERE project_id = $1 AND direction = 'from_us'
            AND waiver_type = 'unconditional_final'
            AND status IN ('signed','received')`,
        [projectId]
      );
      // Consistent with punchlist + lien_waivers_subs: 'in_progress'
      // for not-yet-done so the UI shows a half-filled icon rather
      // than reverting to 'pending' (which suggests "untouched").
      return parseInt(r.rows[0].done, 10) > 0 ? 'done' : 'in_progress';
    } catch { return null; }
  }
  if (item.auto_source === 'invoices' && item.category === 'final_invoice') {
    try {
      // Native invoices are the single source of truth — QBO-synced invoices now
      // live here too (project_invoices was unified in). Zero invoices →
      // 'in_progress' (not a permanent block — the item's manual-waive is the
      // escape hatch for projects that never invoice here).
      const r = await pool.query(
        `SELECT COUNT(*) AS done FROM invoices WHERE project_id = $1 AND status = 'paid'`,
        [projectId]
      );
      return parseInt(r.rows[0].done, 10) > 0 ? 'done' : 'in_progress';
    } catch { return null; }
  }
  if (item.auto_source === 'invoices' && item.category === 'retainage_release') {
    try {
      // Retainage is native-only modeling (project_invoices has no retainage
      // column). Done only when invoices EXIST and none still hold retainage —
      // the old SUM(balance) over project_invoices returned 0 (→ 'done') for
      // every non-QBO project, which had zero rows: a false positive.
      // Done once no invoice still WITHHOLDS retainage — i.e. it's all been
      // released (outstanding = held − released = 0). "Release retainage" sets
      // released = held across the project's invoices.
      const r = await pool.query(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(retainage_held_cents - retainage_released_cents), 0) AS outstanding
           FROM invoices WHERE project_id = $1 AND status <> 'void'`,
        [projectId]
      );
      const n = parseInt(r.rows[0].n, 10);
      if (n === 0) return 'in_progress';               // nothing invoiced → not released
      return parseInt(r.rows[0].outstanding, 10) === 0 ? 'done' : 'in_progress';
    } catch { return null; }
  }
  return null;
}

// An item's effective status: a manual waive/N-A override if set, else its
// computed auto-status (for auto_source items), else the stored status. The GET
// read path layers the same computation in; the transition gate uses this so the
// two never disagree about whether an item is "done".
async function effectiveItemStatus(companyId, projectId, item) {
  // A manual waive / N-A override wins over the auto compute — the escape hatch
  // for an auto item that won't reach 'done' on its own (e.g. billed outside
  // OpsFloa, or paid via QBO where the mirror row stays 'sent').
  if (item.status === 'waived' || item.status === 'n_a') return item.status;
  if (item.auto_source) {
    const auto = await computeAutoStatus(companyId, projectId, item);
    if (auto) return auto;
  }
  return item.status;
}

// ── Closeout CRUD ─────────────────────────────────────────────────────────────

router.get('/projects/:id/closeout', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const project = await assertProjectInCompany(companyId, req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const closeoutRes = await pool.query(
      'SELECT * FROM project_closeouts WHERE project_id = $1',
      [req.params.id]
    );
    if (closeoutRes.rowCount === 0) {
      return res.json({ closeout: null, items: [] });
    }
    const closeout = closeoutRes.rows[0];
    const itemsRes = await pool.query(
      `SELECT * FROM project_closeout_items WHERE closeout_id = $1 ORDER BY sort_order, id`,
      [closeout.id]
    );
    // Layer in auto-status computations.
    const items = [];
    for (const it of itemsRes.rows) {
      let status = it.status;
      let computedAuto = null;
      // A manual waive / N-A override wins over the auto compute (see effectiveItemStatus).
      if (it.auto_source && it.status !== 'waived' && it.status !== 'n_a') {
        computedAuto = await computeAutoStatus(companyId, req.params.id, it);
        if (computedAuto) status = computedAuto;
      }
      items.push({ ...it, status, auto_status: computedAuto });
    }
    res.json({ closeout, items });
  } catch (err) {
    req.log.error({ err }, 'closeout read error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/projects/:id/closeout', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const project = await assertProjectInCompany(companyId, req.params.id);
    if (!project) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Project not found' }); }
    // Already exists? Return it.
    const existing = await client.query(
      'SELECT id FROM project_closeouts WHERE project_id = $1',
      [req.params.id]
    );
    let closeoutId;
    if (existing.rowCount > 0) {
      closeoutId = existing.rows[0].id;
    } else {
      const r = await client.query(
        `INSERT INTO project_closeouts (company_id, project_id, status, created_by)
         VALUES ($1, $2, 'open', $3) RETURNING id`,
        [companyId, req.params.id, req.user.id]
      );
      closeoutId = r.rows[0].id;
      // Seed items from the template.
      await ensureTemplate(companyId);
      const tplRes = await client.query(
        `SELECT * FROM closeout_checklist_template
          WHERE company_id = $1 AND active = true ORDER BY sort_order, id`,
        [companyId]
      );
      for (const t of tplRes.rows) {
        await client.query(
          `INSERT INTO project_closeout_items
             (closeout_id, category, title, description, sort_order, required, auto_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [closeoutId, t.category, t.title, t.description, t.sort_order, t.required, t.auto_source]
        );
      }
    }
    await client.query('COMMIT');
    if (existing.rowCount === 0) {
      await logAudit(companyId, req.user.id, req.user.full_name,
        'closeout.opened', 'project_closeout', closeoutId, project.name,
        { project_id: req.params.id });
    }
    // Re-fetch so the response includes computed auto-status.
    const headRes = await pool.query('SELECT * FROM project_closeouts WHERE id = $1', [closeoutId]);
    const itemsRes = await pool.query(
      'SELECT * FROM project_closeout_items WHERE closeout_id = $1 ORDER BY sort_order, id',
      [closeoutId]
    );
    res.status(existing.rowCount === 0 ? 201 : 200).json({
      closeout: headRes.rows[0],
      items: itemsRes.rows,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'closeout open error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.patch('/projects/:id/closeout', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const project = await assertProjectInCompany(companyId, req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const fields = [];
    const params = [];
    let idx = 1;
    for (const k of ['substantial_completion_date', 'final_completion_date', 'warranty_start_date', 'notes']) {
      if (req.body[k] !== undefined) { fields.push(`${k} = $${idx++}`); params.push(req.body[k] || null); }
    }
    if (req.body.warranty_months !== undefined) {
      const v = parseInt(req.body.warranty_months, 10);
      if (req.body.warranty_months !== null && (!Number.isFinite(v) || v < 0)) {
        return res.status(400).json({ error: 'invalid warranty_months' });
      }
      fields.push(`warranty_months = $${idx++}`); params.push(req.body.warranty_months == null ? null : v);
    }
    if (fields.length === 0) return res.status(400).json({ error: 'no fields to update' });
    params.push(req.params.id);
    const r = await pool.query(
      `UPDATE project_closeouts SET ${fields.join(', ')} WHERE project_id = $${idx} RETURNING *`,
      params
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Closeout not opened yet' });
    res.json(r.rows[0]);
  } catch (err) {
    req.log.error({ err }, 'closeout patch error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Transition the closeout to a new top-level status (substantial_complete /
// final_complete / closed / reopened). Validates the requested move
// against the items' completion state.
router.post('/projects/:id/closeout/transition', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const to = req.body.to_status;
  if (!CLOSEOUT_STATUSES.includes(to)) return res.status(400).json({ error: 'invalid to_status' });
  try {
    const project = await assertProjectInCompany(companyId, req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const closeoutRes = await pool.query(
      'SELECT * FROM project_closeouts WHERE project_id = $1',
      [req.params.id]
    );
    if (closeoutRes.rowCount === 0) return res.status(404).json({ error: 'Closeout not opened yet' });
    const co = closeoutRes.rows[0];
    // Substantial requires punchlist done + final inspection done. Auto-source
    // items (punchlist) are never persisted past 'pending' — their real status
    // is computed on read — so the gate MUST compute it here too, else it reads
    // a stale 'pending' and 409s even when the source module says done.
    if (to === 'substantially_complete') {
      const r = await pool.query(
        `SELECT category, status, auto_source FROM project_closeout_items
          WHERE closeout_id = $1 AND category IN ('punchlist','final_inspection')`,
        [co.id]
      );
      for (const cat of ['punchlist', 'final_inspection']) {
        const item = r.rows.find(i => i.category === cat);
        if (!item) continue;
        const status = await effectiveItemStatus(companyId, req.params.id, item);
        if (!CLOSEOUT_ITEM_DONE_STATUSES.includes(status)) {
          return res.status(409).json({ error: `Cannot transition to substantially_complete: ${cat} item not done` });
        }
      }
    }
    if (to === 'final_complete' || to === 'closed') {
      // `closed` freezes the P&L too, so it needs the same completeness gate as
      // final_complete — else a straight open→closed freezes a number taken
      // before the final invoice / retainage items are satisfied.
      // Same compute-on-read fix: a pure SQL count over stored `status` treats
      // every auto item as 'pending' (they're never written past that), so
      // final_complete was unreachable for EVERY company. Compute each required
      // item's effective status before deciding it's still missing.
      const r = await pool.query(
        `SELECT category, status, auto_source FROM project_closeout_items
          WHERE closeout_id = $1 AND required = true`,
        [co.id]
      );
      for (const item of r.rows) {
        const status = await effectiveItemStatus(companyId, req.params.id, item);
        if (!CLOSEOUT_ITEM_DONE_STATUSES.includes(status)) {
          return res.status(409).json({
            error: `Cannot transition to ${to}: required items still pending`,
          });
        }
      }
    }
    const subDate = (to === 'substantially_complete' && !co.substantial_completion_date)
      ? new Date().toISOString().slice(0, 10) : co.substantial_completion_date;
    const finalDate = (to === 'final_complete' && !co.final_completion_date)
      ? new Date().toISOString().slice(0, 10) : co.final_completion_date;
    const closedAt = to === 'closed' ? 'NOW()' : 'closed_at';

    // Freeze the final cost/profit on the FIRST time the job reaches
    // final_complete or closed — first-freeze-wins, so a reopen→edit→reclose
    // can't silently rewrite the locked number. Reopening clears the freeze so
    // it can be re-taken fresh.
    const clearSnapshot = to === 'reopened';
    let snapshot = null;
    if ((to === 'final_complete' || to === 'closed') && !co.final_financials) {
      try {
        const settings = await loadSettings(companyId);
        snapshot = await computeProjectPnl(req.params.id, companyId, settings);
      } catch (err) {
        req.log.error({ err }, 'closeout snapshot compute failed');  // don't block the transition
      }
    }
    const updRes = await pool.query(
      `UPDATE project_closeouts SET
         status = $1,
         substantial_completion_date = $2,
         final_completion_date = $3,
         warranty_start_date = COALESCE(warranty_start_date, $2),
         closed_at = ${closedAt},
         final_financials       = CASE WHEN $6 THEN NULL WHEN $5 IS NOT NULL AND final_financials IS NULL THEN $5::jsonb ELSE final_financials END,
         financials_snapshot_at = CASE WHEN $6 THEN NULL WHEN $5 IS NOT NULL AND final_financials IS NULL THEN NOW() ELSE financials_snapshot_at END
       WHERE id = $4 RETURNING *`,
      [to, subDate, finalDate, co.id, snapshot ? JSON.stringify(snapshot) : null, clearSnapshot]
    );
    await logAudit(companyId, req.user.id, req.user.full_name,
      `closeout.${to}`, 'project_closeout', co.id, project.name,
      { from: co.status, to });
    res.json(updRes.rows[0]);
  } catch (err) {
    req.log.error({ err }, 'closeout transition error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH a single (manual) checklist item.
router.patch('/closeout-items/:id', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    // Verify the item belongs to a closeout for a project in the caller's company.
    const checkRes = await pool.query(
      `SELECT ci.*, co.project_id FROM project_closeout_items ci
         JOIN project_closeouts co ON ci.closeout_id = co.id
         JOIN projects p ON co.project_id = p.id
        WHERE ci.id = $1 AND p.company_id = $2`,
      [req.params.id, companyId]
    );
    if (checkRes.rowCount === 0) return res.status(404).json({ error: 'Checklist item not found' });
    const item = checkRes.rows[0];
    if (item.auto_source) {
      // Auto items normally compute their status, but allow an explicit manual
      // OVERRIDE — waive / mark N/A (the closeout escape hatch), or reset to
      // 'pending' to hand control back to the auto compute. Anything else must
      // come from the source module.
      const s = req.body.status;
      if (s !== undefined && !['waived', 'n_a', 'pending'].includes(s)) {
        return res.status(409).json({ error: 'Auto-computed items can only be waived, marked N/A, or reset to pending' });
      }
    }
    const fields = [];
    const params = [];
    let idx = 1;
    if (req.body.status !== undefined) {
      if (!CLOSEOUT_ITEM_STATUSES.includes(req.body.status)) {
        return res.status(400).json({ error: 'invalid status' });
      }
      fields.push(`status = $${idx++}`); params.push(req.body.status);
      if (CLOSEOUT_ITEM_DONE_STATUSES.includes(req.body.status)) {
        fields.push(`completed_at = NOW()`);
        fields.push(`completed_by = $${idx++}`); params.push(req.user.id);
      } else {
        fields.push(`completed_at = NULL, completed_by = NULL`);
      }
    }
    if (req.body.notes !== undefined) { fields.push(`notes = $${idx++}`); params.push(req.body.notes || null); }
    if (fields.length === 0) return res.json(item);
    params.push(req.params.id);
    const r = await pool.query(
      `UPDATE project_closeout_items SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    res.json(r.rows[0]);
  } catch (err) {
    req.log.error({ err }, 'closeout item patch error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Warranty-expiring query (dashboard tile) ──────────────────────────────────

router.get('/warranties-expiring', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const within = Math.min(365, Math.max(1, parseInt(req.query.within_days) || 60));
  try {
    const r = await pool.query(
      `SELECT co.*, p.name AS project_name,
              (co.substantial_completion_date + (co.warranty_months || ' months')::interval) AS warranty_end_date
         FROM project_closeouts co
         JOIN projects p ON co.project_id = p.id
        WHERE co.company_id = $1
          AND co.substantial_completion_date IS NOT NULL
          AND co.warranty_months IS NOT NULL
          AND (co.substantial_completion_date + (co.warranty_months || ' months')::interval)
              BETWEEN CURRENT_DATE AND (CURRENT_DATE + ($2 || ' days')::interval)
        ORDER BY warranty_end_date ASC`,
      [companyId, within]
    );
    res.json({ items: r.rows });
  } catch (err) {
    req.log.error({ err }, 'warranties expiring error');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
