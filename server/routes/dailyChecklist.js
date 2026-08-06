/**
 * Daily Checklist — a per-project checklist that recurs each working day.
 * See docs/plans/daily-checklist.md. Distinct from punchlist (the issue tracker).
 *
 * Phase 1 (this file): the recurring template, starting a day (adhoc), the active-day
 * view, checking / adding / removing items, and completing a day — with unchecked items
 * rolling forward (deduped) into the NEXT day when it's started. Advance scheduling (the
 * day manager: calendar/ordinal plans, the pending queue, pause/reschedule) is Phase 2;
 * the schema already carries those columns.
 *
 * Mounted at /api/daily-checklist behind requireAuth + requirePlan('business'). GETs need
 * only field access; mutations are gated by the granular daily_checklist_* permissions.
 */

const router = require('express').Router();
const pool = require('../db');
const { requirePerm } = require('../permissions');
const { projectBelongsToCompany } = require('../utils/tenantRefs');

const MAX_TEXT = 500;
const cleanText = v => (typeof v === 'string' ? v.trim() : '');
const normText = v => cleanText(v).toLowerCase();
const isYmd = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

// Load a day scoped to the company (null if it isn't theirs / doesn't exist).
async function loadDay(db, dayId, companyId) {
  const r = await db.query('SELECT * FROM daily_checklists WHERE id = $1 AND company_id = $2', [dayId, companyId]);
  return r.rows[0] || null;
}
async function loadItems(db, dayId) {
  const r = await db.query(
    'SELECT id, text, checked, order_index, source, checked_by, checked_at FROM daily_checklist_items WHERE daily_checklist_id = $1 ORDER BY order_index, id',
    [dayId]
  );
  return r.rows;
}

// ── Recurring template ────────────────────────────────────────────────────────

// GET /projects/:projectId/recurring — the project's standing "every day" items.
router.get('/projects/:projectId/recurring', async (req, res) => {
  try {
    if (!(await projectBelongsToCompany(pool, req.params.projectId, req.user.company_id)))
      return res.status(404).json({ error: 'Project not found' });
    const r = await pool.query(
      'SELECT id, text, order_index, active FROM daily_checklist_recurring_items WHERE company_id = $1 AND project_id = $2 ORDER BY order_index, id',
      [req.user.company_id, req.params.projectId]
    );
    res.json({ items: r.rows });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PUT /projects/:projectId/recurring — replace the whole recurring list.
// Body: { items: [{ text, active? }] } in display order.
router.put('/projects/:projectId/recurring', requirePerm('daily_checklist_manage_recurring'), async (req, res) => {
  const companyId = req.user.company_id;
  const projectId = req.params.projectId;
  const rows = (Array.isArray(req.body?.items) ? req.body.items : [])
    .map(it => ({ text: cleanText(it?.text), active: it?.active !== false }))
    .filter(it => it.text)
    .map(it => ({ text: it.text.slice(0, MAX_TEXT), active: it.active }))
    .slice(0, 200);
  const client = await pool.connect();
  try {
    if (!(await projectBelongsToCompany(client, projectId, companyId))) {
      client.release();
      return res.status(404).json({ error: 'Project not found' });
    }
    await client.query('BEGIN');
    await client.query('DELETE FROM daily_checklist_recurring_items WHERE company_id = $1 AND project_id = $2', [companyId, projectId]);
    for (let i = 0; i < rows.length; i++) {
      await client.query(
        'INSERT INTO daily_checklist_recurring_items (company_id, project_id, text, order_index, active, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [companyId, projectId, rows[i].text, i, rows[i].active, req.user.id]
      );
    }
    await client.query('COMMIT');
    const r = await client.query(
      'SELECT id, text, order_index, active FROM daily_checklist_recurring_items WHERE company_id = $1 AND project_id = $2 ORDER BY order_index, id',
      [companyId, projectId]
    );
    res.json({ items: r.rows });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// ── The day ───────────────────────────────────────────────────────────────────

// GET /projects/:projectId/active — the live day + its items, or { day: null }.
router.get('/projects/:projectId/active', async (req, res) => {
  try {
    if (!(await projectBelongsToCompany(pool, req.params.projectId, req.user.company_id)))
      return res.status(404).json({ error: 'Project not found' });
    const r = await pool.query(
      "SELECT * FROM daily_checklists WHERE company_id = $1 AND project_id = $2 AND status = 'active'",
      [req.user.company_id, req.params.projectId]
    );
    const day = r.rows[0] || null;
    res.json({ day, items: day ? await loadItems(pool, day.id) : [] });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /projects/:projectId/history — recent completed days (newest first).
router.get('/projects/:projectId/history', async (req, res) => {
  try {
    if (!(await projectBelongsToCompany(pool, req.params.projectId, req.user.company_id)))
      return res.status(404).json({ error: 'Project not found' });
    const r = await pool.query(
      `SELECT d.id, d.day_number, d.work_date, d.completed_at,
              COUNT(i.id)::int AS item_count,
              COUNT(i.id) FILTER (WHERE i.checked)::int AS checked_count
         FROM daily_checklists d
         LEFT JOIN daily_checklist_items i ON i.daily_checklist_id = d.id
        WHERE d.company_id = $1 AND d.project_id = $2 AND d.status = 'completed'
        GROUP BY d.id
        ORDER BY d.work_date DESC NULLS LAST, d.day_number DESC
        LIMIT 60`,
      [req.user.company_id, req.params.projectId]
    );
    res.json({ days: r.rows });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /projects/:projectId/start — start today's day (adhoc). Idempotent: if a day is
// already active for the project, returns it unchanged. Assembles items from the recurring
// template + unchecked items rolled over (deduped) from the most recent completed day.
router.post('/projects/:projectId/start', requirePerm('daily_checklist_start_day'), async (req, res) => {
  const companyId = req.user.company_id;
  const projectId = req.params.projectId;
  const workDate = isYmd(req.body?.work_date) ? req.body.work_date : null; // client's local today; else CURRENT_DATE
  const client = await pool.connect();
  try {
    if (!(await projectBelongsToCompany(client, projectId, companyId))) {
      client.release();
      return res.status(404).json({ error: 'Project not found' });
    }
    await client.query('BEGIN');

    // Already started today? Return the live day (idempotent start).
    const existing = await client.query(
      "SELECT * FROM daily_checklists WHERE company_id = $1 AND project_id = $2 AND status = 'active'",
      [companyId, projectId]
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      const day = existing.rows[0];
      return res.json({ day, items: await loadItems(client, day.id), started: false });
    }

    // Next ordinal = worked days so far + 1 (only active/completed days count).
    const seq = await client.query(
      "SELECT COALESCE(MAX(day_number), 0) + 1 AS n FROM daily_checklists WHERE company_id = $1 AND project_id = $2 AND status IN ('active', 'completed')",
      [companyId, projectId]
    );
    const dayNumber = seq.rows[0].n;

    const ins = await client.query(
      `INSERT INTO daily_checklists (company_id, project_id, status, schedule_type, work_date, day_number, started_by, started_at, created_by)
       VALUES ($1, $2, 'active', 'adhoc', COALESCE($3::date, CURRENT_DATE), $4, $5, now(), $5)
       RETURNING *`,
      [companyId, projectId, workDate, dayNumber, req.user.id]
    );
    const day = ins.rows[0];

    // Assemble items: recurring template first, then rolled-over unchecked items from the
    // most recent completed day that aren't already present (deduped by normalized text).
    const seen = new Set();
    let order = 0;
    const addItem = async (text, source) => {
      const key = normText(text);
      if (!key || seen.has(key)) return;
      seen.add(key);
      await client.query(
        'INSERT INTO daily_checklist_items (daily_checklist_id, text, order_index, source) VALUES ($1, $2, $3, $4)',
        [day.id, text.slice(0, MAX_TEXT), order++, source]
      );
    };

    const recurring = await client.query(
      'SELECT text FROM daily_checklist_recurring_items WHERE company_id = $1 AND project_id = $2 AND active = true ORDER BY order_index, id',
      [companyId, projectId]
    );
    for (const row of recurring.rows) await addItem(row.text, 'recurring');

    const prev = await client.query(
      "SELECT id FROM daily_checklists WHERE company_id = $1 AND project_id = $2 AND status = 'completed' ORDER BY work_date DESC NULLS LAST, day_number DESC LIMIT 1",
      [companyId, projectId]
    );
    if (prev.rows[0]) {
      const carry = await client.query(
        'SELECT text FROM daily_checklist_items WHERE daily_checklist_id = $1 AND checked = false ORDER BY order_index, id',
        [prev.rows[0].id]
      );
      for (const row of carry.rows) await addItem(row.text, 'rollover');
    }

    await client.query('COMMIT');
    res.status(201).json({ day, items: await loadItems(client, day.id), started: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Lost a race to another start → the other one won; return the active day.
    if (err && err.code === '23505') {
      try {
        const r = await pool.query(
          "SELECT * FROM daily_checklists WHERE company_id = $1 AND project_id = $2 AND status = 'active'",
          [companyId, projectId]
        );
        if (r.rows[0]) return res.json({ day: r.rows[0], items: await loadItems(pool, r.rows[0].id), started: false });
      } catch { /* fall through to 500 */ }
    }
    req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// ── Items on a day ──────────────────────────────────────────────────────────

// POST /days/:dayId/items — add a manual item to the active day.
router.post('/days/:dayId/items', requirePerm('daily_checklist_check_items'), async (req, res) => {
  const text = cleanText(req.body?.text).slice(0, MAX_TEXT);
  if (!text) return res.status(400).json({ error: 'Text is required' });
  try {
    const day = await loadDay(pool, req.params.dayId, req.user.company_id);
    if (!day) return res.status(404).json({ error: 'Day not found' });
    if (day.status !== 'active') return res.status(409).json({ error: 'Day is not active' });
    const ord = await pool.query('SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM daily_checklist_items WHERE daily_checklist_id = $1', [day.id]);
    const r = await pool.query(
      "INSERT INTO daily_checklist_items (daily_checklist_id, text, order_index, source) VALUES ($1, $2, $3, 'manual') RETURNING id, text, checked, order_index, source",
      [day.id, text, ord.rows[0].n]
    );
    res.status(201).json({ item: r.rows[0] });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /days/:dayId/items/:itemId — check/uncheck or edit an item's text.
router.patch('/days/:dayId/items/:itemId', requirePerm('daily_checklist_check_items'), async (req, res) => {
  const hasChecked = typeof req.body?.checked === 'boolean';
  const hasText = typeof req.body?.text === 'string';
  if (!hasChecked && !hasText) return res.status(400).json({ error: 'Nothing to update' });
  try {
    const day = await loadDay(pool, req.params.dayId, req.user.company_id);
    if (!day) return res.status(404).json({ error: 'Day not found' });
    if (day.status !== 'active') return res.status(409).json({ error: 'Day is not active' });
    const sets = [], vals = [];
    if (hasChecked) {
      sets.push(`checked = $${vals.push(req.body.checked)}`);
      if (req.body.checked) { sets.push(`checked_by = $${vals.push(req.user.id)}`); sets.push('checked_at = now()'); }
      else { sets.push('checked_by = NULL'); sets.push('checked_at = NULL'); }
    }
    if (hasText) {
      const text = cleanText(req.body.text).slice(0, MAX_TEXT);
      if (!text) return res.status(400).json({ error: 'Text cannot be empty' });
      sets.push(`text = $${vals.push(text)}`);
    }
    vals.push(req.params.itemId, day.id);
    const r = await pool.query(
      `UPDATE daily_checklist_items SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND daily_checklist_id = $${vals.length}
       RETURNING id, text, checked, order_index, source, checked_by, checked_at`,
      vals
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Item not found' });
    res.json({ item: r.rows[0] });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /days/:dayId/items/:itemId — remove an item from the active day.
router.delete('/days/:dayId/items/:itemId', requirePerm('daily_checklist_check_items'), async (req, res) => {
  try {
    const day = await loadDay(pool, req.params.dayId, req.user.company_id);
    if (!day) return res.status(404).json({ error: 'Day not found' });
    if (day.status !== 'active') return res.status(409).json({ error: 'Day is not active' });
    const r = await pool.query('DELETE FROM daily_checklist_items WHERE id = $1 AND daily_checklist_id = $2 RETURNING id', [req.params.itemId, day.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Item not found' });
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /days/:dayId/complete — close the active day. Unchecked items roll into the next
// day when it's started (computed there). Can close with items still unchecked.
router.post('/days/:dayId/complete', requirePerm('daily_checklist_complete_day'), async (req, res) => {
  try {
    const r = await pool.query(
      "UPDATE daily_checklists SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1 AND company_id = $2 AND status = 'active' RETURNING *",
      [req.params.dayId, req.user.company_id]
    );
    if (r.rowCount === 0) {
      const day = await loadDay(pool, req.params.dayId, req.user.company_id);
      if (!day) return res.status(404).json({ error: 'Day not found' });
      return res.status(409).json({ error: 'Day is not active' });
    }
    res.json({ day: r.rows[0] });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
