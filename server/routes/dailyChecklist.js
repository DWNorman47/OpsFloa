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
const { requirePerm, hasPerm } = require('../permissions');
const { projectBelongsToCompany } = require('../utils/tenantRefs');
const { MAX_TEXT, normText, pauseOverdueCalendar, appendAssembledItems } = require('../utils/dailyChecklistCore');

const cleanText = v => (typeof v === 'string' ? v.trim() : '');
const isYmd = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

// Load a day scoped to the company (null if it isn't theirs / doesn't exist).
async function loadDay(db, dayId, companyId) {
  const r = await db.query('SELECT * FROM daily_checklists WHERE id = $1 AND company_id = $2', [dayId, companyId]);
  return r.rows[0] || null;
}
async function loadItems(db, dayId) {
  const r = await db.query(
    'SELECT id, text, kind, checked, value, order_index, source, checked_by, checked_at FROM daily_checklist_items WHERE daily_checklist_id = $1 ORDER BY order_index, id',
    [dayId]
  );
  return r.rows;
}
const isPosInt = v => Number.isInteger(v) && v > 0;
const cleanKind = k => (k === 'text' ? 'text' : 'check');

// A pending/paused plan can only be edited/reordered/deleted before it's worked.
const isPlannable = day => day && (day.status === 'pending' || day.status === 'paused');

// ── Recurring template ────────────────────────────────────────────────────────

// GET /projects/:projectId/recurring — the project's standing "every day" items.
router.get('/projects/:projectId/recurring', async (req, res) => {
  try {
    if (!(await projectBelongsToCompany(pool, req.params.projectId, req.user.company_id)))
      return res.status(404).json({ error: 'Project not found' });
    const r = await pool.query(
      'SELECT id, text, kind, order_index, active FROM daily_checklist_recurring_items WHERE company_id = $1 AND project_id = $2 ORDER BY order_index, id',
      [req.user.company_id, req.params.projectId]
    );
    res.json({ items: r.rows });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PUT /projects/:projectId/recurring — replace the whole recurring list.
// Body: { items: [{ text, kind?, active? }] } in display order.
router.put('/projects/:projectId/recurring', requirePerm('daily_checklist_manage_recurring'), async (req, res) => {
  const companyId = req.user.company_id;
  const projectId = req.params.projectId;
  const rows = (Array.isArray(req.body?.items) ? req.body.items : [])
    .map(it => ({ text: cleanText(it?.text), kind: cleanKind(it?.kind), active: it?.active !== false }))
    .filter(it => it.text)
    .map(it => ({ text: it.text.slice(0, MAX_TEXT), kind: it.kind, active: it.active }))
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
        'INSERT INTO daily_checklist_recurring_items (company_id, project_id, text, kind, order_index, active, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [companyId, projectId, rows[i].text, rows[i].kind, i, rows[i].active, req.user.id]
      );
    }
    await client.query('COMMIT');
    const r = await client.query(
      'SELECT id, text, kind, order_index, active FROM daily_checklist_recurring_items WHERE company_id = $1 AND project_id = $2 ORDER BY order_index, id',
      [companyId, projectId]
    );
    res.json({ items: r.rows });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// GET /clock-in-prompt — after a clock-in, which of the user's accessible projects have a
// daily checklist worth opening: a project with an ACTIVE day (anyone who can see the
// project), plus — for users who can start days — projects that are set up but not started
// yet (a recurring template or a queued/paused day). Drives the post-clock-in prompt.
router.get('/clock-in-prompt', async (req, res) => {
  const companyId = req.user.company_id;
  try {
    // A company can turn the clock-in prompt off (default on).
    const setting = await pool.query("SELECT value FROM settings WHERE company_id = $1 AND key = 'daily_checklist_clockin_prompt'", [companyId]);
    if (setting.rows[0]?.value === '0') return res.json({ candidates: [] });

    // Projects the user can see — mirrors routes/projects.js visibility (admins bypass;
    // otherwise projects.visible_to_user_ids gates non-shared projects).
    const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
    const vis = isAdmin ? '' : ' AND (visible_to_user_ids IS NULL OR COALESCE(array_length(visible_to_user_ids, 1), 0) = 0 OR $2 = ANY(visible_to_user_ids))';
    const params = isAdmin ? [companyId] : [companyId, req.user.id];
    const projs = await pool.query(
      `SELECT id, name FROM projects WHERE active = true AND company_id = $1${vis} ORDER BY name LIMIT 500`,
      params
    );
    if (projs.rows.length === 0) return res.json({ candidates: [] });
    const ids = projs.rows.map(p => p.id);
    const nameById = new Map(projs.rows.map(p => [p.id, p.name]));

    const active = await pool.query(
      "SELECT project_id, id AS day_id FROM daily_checklists WHERE company_id = $1 AND status = 'active' AND project_id = ANY($2)",
      [companyId, ids]
    );
    const activeByProject = new Map(active.rows.map(r => [r.project_id, r.day_id]));

    const candidates = [];
    for (const pid of ids) {
      if (activeByProject.has(pid)) candidates.push({ project_id: pid, project_name: nameById.get(pid), status: 'active', day_id: activeByProject.get(pid) });
    }

    // "Startable" projects only surface for users who can start a day.
    if (await hasPerm(req, 'daily_checklist_start_day')) {
      const notActive = ids.filter(pid => !activeByProject.has(pid));
      if (notActive.length) {
        const startable = await pool.query(
          `SELECT DISTINCT project_id FROM (
             SELECT project_id FROM daily_checklist_recurring_items WHERE company_id = $1 AND project_id = ANY($2) AND active = true
             UNION
             SELECT project_id FROM daily_checklists WHERE company_id = $1 AND project_id = ANY($2) AND status IN ('pending', 'paused')
           ) s`,
          [companyId, notActive]
        );
        for (const r of startable.rows) candidates.push({ project_id: r.project_id, project_name: nameById.get(r.project_id), status: 'startable' });
      }
    }

    candidates.sort((a, b) => String(a.project_name).localeCompare(String(b.project_name)));
    res.json({ candidates });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
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

// POST /projects/:projectId/start — start today's day. Idempotent (a day already active
// is returned unchanged). Otherwise resumes a prepared plan and slides it onto today:
// a calendar plan dated today, an ordinal plan targeting this day number, else the top of
// the pending queue; failing all, a fresh adhoc day. If BOTH a calendar and an ordinal plan
// claim this day, responds 409 { conflict } with each option's items — the client re-calls
// with resolution = 'calendar' | 'ordinal' | 'merge'. Recurring + rolled-over items are
// appended (deduped) on top of whatever the resumed plan already carries.
router.post('/projects/:projectId/start', requirePerm('daily_checklist_start_day'), async (req, res) => {
  const companyId = req.user.company_id;
  const projectId = req.params.projectId;
  const workDate = isYmd(req.body?.work_date) ? req.body.work_date : null; // client's local today; else CURRENT_DATE
  const resolution = ['calendar', 'ordinal', 'merge'].includes(req.body?.resolution) ? req.body.resolution : null;
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
      const d0 = existing.rows[0];
      return res.json({ day: d0, items: await loadItems(client, d0.id), started: false });
    }

    // Calendar plans whose date has passed → paused, so they can't match "today".
    await pauseOverdueCalendar(client, companyId, projectId);

    // The ordinal number this day would take, and the concrete date it lands on.
    const seq = await client.query(
      "SELECT COALESCE(MAX(day_number), 0) + 1 AS n FROM daily_checklists WHERE company_id = $1 AND project_id = $2 AND status IN ('active', 'completed')",
      [companyId, projectId]
    );
    const dayNumber = seq.rows[0].n;
    let workDateResolved = workDate;
    if (!workDateResolved) workDateResolved = (await client.query('SELECT CURRENT_DATE::text AS d')).rows[0].d;

    // Plans explicitly claiming this day: a calendar plan dated today, an ordinal plan for N.
    const pick = async (extra, val) => (await client.query(
      `SELECT * FROM daily_checklists WHERE company_id = $1 AND project_id = $2 AND status IN ('pending','paused') AND ${extra} ORDER BY queue_order NULLS LAST, id LIMIT 1`,
      [companyId, projectId, val]
    )).rows[0] || null;
    const calMatch = await pick("schedule_type = 'calendar' AND scheduled_date = $3::date", workDateResolved);
    const ordMatch = await pick("schedule_type = 'ordinal' AND ordinal_target = $3", dayNumber);

    // Both claim the day and differ → ask (unless the client already chose).
    if (calMatch && ordMatch && calMatch.id !== ordMatch.id && !resolution) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        conflict: true,
        day_number: dayNumber,
        calendar: { id: calMatch.id, name: calMatch.name, items: await loadItems(client, calMatch.id) },
        ordinal: { id: ordMatch.id, name: ordMatch.name, items: await loadItems(client, ordMatch.id) },
      });
    }

    // Choose the plan to resume (or null → adhoc).
    let chosen = null, mergeFrom = null;
    if (calMatch && ordMatch && calMatch.id !== ordMatch.id) {
      if (resolution === 'ordinal') chosen = ordMatch;
      else { chosen = calMatch; if (resolution === 'merge') mergeFrom = ordMatch; }
    } else {
      chosen = calMatch || ordMatch || (await client.query(
        "SELECT * FROM daily_checklists WHERE company_id = $1 AND project_id = $2 AND status IN ('pending','paused') ORDER BY queue_order NULLS LAST, id LIMIT 1",
        [companyId, projectId]
      )).rows[0] || null;
    }

    let day;
    if (chosen) {
      day = (await client.query(
        "UPDATE daily_checklists SET status = 'active', work_date = COALESCE($3::date, CURRENT_DATE), day_number = $4, started_by = $5, started_at = now(), queue_order = NULL, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *",
        [chosen.id, companyId, workDate, dayNumber, req.user.id]
      )).rows[0];
    } else {
      day = (await client.query(
        `INSERT INTO daily_checklists (company_id, project_id, status, schedule_type, work_date, day_number, started_by, started_at, created_by)
         VALUES ($1, $2, 'active', 'adhoc', COALESCE($3::date, CURRENT_DATE), $4, $5, now(), $5) RETURNING *`,
        [companyId, projectId, workDate, dayNumber, req.user.id]
      )).rows[0];
    }

    // Seed the dedup set + ordering from the day's existing (prepared) items.
    const cur = await client.query('SELECT text, order_index FROM daily_checklist_items WHERE daily_checklist_id = $1', [day.id]);
    const seen = new Set(cur.rows.map(r => normText(r.text)));
    let order = cur.rows.reduce((m, r) => Math.max(m, r.order_index + 1), 0);

    // Merge the other plan's items in, then retire it (merge resolution only).
    if (mergeFrom) {
      const mi = await client.query('SELECT text, kind FROM daily_checklist_items WHERE daily_checklist_id = $1 ORDER BY order_index, id', [mergeFrom.id]);
      for (const row of mi.rows) {
        const key = normText(row.text);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        await client.query("INSERT INTO daily_checklist_items (daily_checklist_id, text, kind, order_index, source) VALUES ($1, $2, $3, $4, 'scheduled')", [day.id, row.text.slice(0, MAX_TEXT), row.kind, order++]);
      }
      await client.query("UPDATE daily_checklists SET status = 'canceled', updated_at = now() WHERE id = $1", [mergeFrom.id]);
    }

    await appendAssembledItems(client, { dayId: day.id, companyId, projectId, seen, startOrder: order });

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

// POST /days/:dayId/items — add a manual item (checkbox or text field) to the active day.
router.post('/days/:dayId/items', requirePerm('daily_checklist_check_items'), async (req, res) => {
  const text = cleanText(req.body?.text).slice(0, MAX_TEXT);
  const kind = cleanKind(req.body?.kind);
  if (!text) return res.status(400).json({ error: 'Text is required' });
  try {
    const day = await loadDay(pool, req.params.dayId, req.user.company_id);
    if (!day) return res.status(404).json({ error: 'Day not found' });
    if (day.status !== 'active') return res.status(409).json({ error: 'Day is not active' });
    const ord = await pool.query('SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM daily_checklist_items WHERE daily_checklist_id = $1', [day.id]);
    const r = await pool.query(
      "INSERT INTO daily_checklist_items (daily_checklist_id, text, kind, order_index, source) VALUES ($1, $2, $3, $4, 'manual') RETURNING id, text, kind, checked, value, order_index, source",
      [day.id, text, kind, ord.rows[0].n]
    );
    res.status(201).json({ item: r.rows[0] });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /days/:dayId/items/:itemId — check/uncheck a box, set a text field's value, or edit
// the item's label. `checked` for check items, `value` for text items, `text` for the label.
router.patch('/days/:dayId/items/:itemId', requirePerm('daily_checklist_check_items'), async (req, res) => {
  const hasChecked = typeof req.body?.checked === 'boolean';
  const hasValue = typeof req.body?.value === 'string';
  const hasText = typeof req.body?.text === 'string';
  if (!hasChecked && !hasValue && !hasText) return res.status(400).json({ error: 'Nothing to update' });
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
    if (hasValue) sets.push(`value = $${vals.push(req.body.value.slice(0, 2000))}`);
    if (hasText) {
      const text = cleanText(req.body.text).slice(0, MAX_TEXT);
      if (!text) return res.status(400).json({ error: 'Text cannot be empty' });
      sets.push(`text = $${vals.push(text)}`);
    }
    vals.push(req.params.itemId, day.id);
    const r = await pool.query(
      `UPDATE daily_checklist_items SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND daily_checklist_id = $${vals.length}
       RETURNING id, text, kind, checked, value, order_index, source, checked_by, checked_at`,
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

// POST /days/:dayId/cancel — discard the active day. A canceled day is excluded from the
// day-number count (see start), so it doesn't burn its ordinal — the next start re-numbers
// from where it was and can pull a prepared day into that slot. Its items don't roll
// forward. Use when a day was started by mistake or should be replaced by a prepared one.
router.post('/days/:dayId/cancel', requirePerm('daily_checklist_complete_day'), async (req, res) => {
  try {
    const r = await pool.query(
      "UPDATE daily_checklists SET status = 'canceled', updated_at = now() WHERE id = $1 AND company_id = $2 AND status = 'active' RETURNING *",
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

// ── Day manager: prepare days ahead (Phase 2) ─────────────────────────────────

// Validate + normalize a plan's schedule fields. Returns { schedule_type, scheduled_date,
// ordinal_target } or an { error } string.
function normalizeSchedule(body) {
  const type = body?.schedule_type;
  if (type === 'calendar') {
    if (!isYmd(body?.scheduled_date)) return { error: 'A valid scheduled_date is required for a calendar day' };
    return { schedule_type: 'calendar', scheduled_date: body.scheduled_date, ordinal_target: null };
  }
  if (type === 'ordinal') {
    const n = Number(body?.ordinal_target);
    if (!isPosInt(n)) return { error: 'A positive ordinal_target is required for an ordinal day' };
    return { schedule_type: 'ordinal', scheduled_date: null, ordinal_target: n };
  }
  return { error: 'schedule_type must be calendar or ordinal' };
}
// Parse a template/plan item list into { text, kind } rows (blank-text rows dropped).
const planItems = body => (Array.isArray(body?.items) ? body.items : [])
  .map(it => ({ text: cleanText(it?.text), kind: cleanKind(it?.kind) }))
  .filter(it => it.text)
  .map(it => ({ text: it.text.slice(0, MAX_TEXT), kind: it.kind }))
  .slice(0, 200);

// The active day IF the given schedule targets it — an ordinal plan whose number matches the
// active day's day_number, or a calendar plan dated the same as its work_date. Preparing
// items for the day that's already running should land ON it, not queue a plan that can
// never activate (its slot is taken).
async function activeDayMatching(db, companyId, projectId, schedule) {
  const active = (await db.query(
    "SELECT id, work_date, day_number FROM daily_checklists WHERE company_id = $1 AND project_id = $2 AND status = 'active'",
    [companyId, projectId]
  )).rows[0];
  if (!active) return null;
  const matches = schedule.schedule_type === 'ordinal'
    ? Number(schedule.ordinal_target) === Number(active.day_number)
    : String(schedule.scheduled_date).slice(0, 10) === String(active.work_date).slice(0, 10);
  return matches ? active : null;
}

// Append { text, kind } items to a day, skipping ones already present (deduped by text).
async function appendItemsToDay(db, dayId, items) {
  const cur = await db.query('SELECT text, order_index FROM daily_checklist_items WHERE daily_checklist_id = $1', [dayId]);
  const seen = new Set(cur.rows.map(r => normText(r.text)));
  let order = cur.rows.reduce((m, r) => Math.max(m, r.order_index + 1), 0);
  for (const it of items) {
    const key = normText(it.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    await db.query("INSERT INTO daily_checklist_items (daily_checklist_id, text, kind, order_index, source) VALUES ($1, $2, $3, $4, 'scheduled')", [dayId, it.text.slice(0, MAX_TEXT), cleanKind(it.kind), order++]);
  }
}

// GET /projects/:projectId/queue — the pending + paused day plans, in queue order.
// Overdue calendar plans are lazily paused first so the list reflects reality.
router.get('/projects/:projectId/queue', async (req, res) => {
  try {
    if (!(await projectBelongsToCompany(pool, req.params.projectId, req.user.company_id)))
      return res.status(404).json({ error: 'Project not found' });
    await pauseOverdueCalendar(pool, req.user.company_id, req.params.projectId);
    const r = await pool.query(
      `SELECT d.id, d.status, d.schedule_type, d.scheduled_date, d.ordinal_target, d.queue_order, d.name,
              COUNT(i.id)::int AS item_count
         FROM daily_checklists d
         LEFT JOIN daily_checklist_items i ON i.daily_checklist_id = d.id
        WHERE d.company_id = $1 AND d.project_id = $2 AND d.status IN ('pending', 'paused')
        GROUP BY d.id
        ORDER BY d.queue_order NULLS LAST, d.id`,
      [req.user.company_id, req.params.projectId]
    );
    res.json({ days: r.rows });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /days/:dayId — a single day (any status) + its items, for viewing/editing a plan.
router.get('/days/:dayId', async (req, res) => {
  try {
    const day = await loadDay(pool, req.params.dayId, req.user.company_id);
    if (!day) return res.status(404).json({ error: 'Day not found' });
    res.json({ day, items: await loadItems(pool, day.id) });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /projects/:projectId/days — prepare a pending day plan (calendar or ordinal).
router.post('/projects/:projectId/days', requirePerm('daily_checklist_schedule_days'), async (req, res) => {
  const companyId = req.user.company_id;
  const projectId = req.params.projectId;
  const sched = normalizeSchedule(req.body);
  if (sched.error) return res.status(400).json({ error: sched.error });
  const items = planItems(req.body);
  const name = cleanText(req.body?.name).slice(0, 200) || null;
  const notes = cleanText(req.body?.notes).slice(0, 2000) || null;
  const client = await pool.connect();
  try {
    if (!(await projectBelongsToCompany(client, projectId, companyId))) {
      client.release();
      return res.status(404).json({ error: 'Project not found' });
    }
    await client.query('BEGIN');

    // If this plan targets the day already running, add its items straight to that day
    // instead of queuing a plan that could never activate.
    const activeMatch = await activeDayMatching(client, companyId, projectId, sched);
    if (activeMatch) {
      await appendItemsToDay(client, activeMatch.id, items);
      await client.query('COMMIT');
      return res.json({ merged_into_active: activeMatch.id, items: await loadItems(client, activeMatch.id) });
    }

    const q = await client.query(
      "SELECT COALESCE(MAX(queue_order), 0) + 1 AS n FROM daily_checklists WHERE company_id = $1 AND project_id = $2 AND status IN ('pending', 'paused')",
      [companyId, projectId]
    );
    const ins = await client.query(
      `INSERT INTO daily_checklists (company_id, project_id, status, schedule_type, scheduled_date, ordinal_target, queue_order, name, notes, created_by)
       VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [companyId, projectId, sched.schedule_type, sched.scheduled_date, sched.ordinal_target, q.rows[0].n, name, notes, req.user.id]
    );
    const day = ins.rows[0];
    for (let i = 0; i < items.length; i++) {
      await client.query("INSERT INTO daily_checklist_items (daily_checklist_id, text, kind, order_index, source) VALUES ($1, $2, $3, $4, 'scheduled')", [day.id, items[i].text, items[i].kind, i]);
    }
    await client.query('COMMIT');
    res.status(201).json({ day, items: await loadItems(client, day.id) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// PATCH /days/:dayId — edit a pending/paused plan: reschedule, rename, notes, or
// pause/cancel/re-open. Only while the day hasn't been worked.
router.patch('/days/:dayId', requirePerm('daily_checklist_schedule_days'), async (req, res) => {
  try {
    const day = await loadDay(pool, req.params.dayId, req.user.company_id);
    if (!day) return res.status(404).json({ error: 'Day not found' });
    if (!isPlannable(day)) return res.status(409).json({ error: 'Only a pending or paused day can be edited' });

    const sets = [], vals = [];
    if (req.body?.schedule_type !== undefined || req.body?.scheduled_date !== undefined || req.body?.ordinal_target !== undefined) {
      const sched = normalizeSchedule({ schedule_type: req.body.schedule_type ?? day.schedule_type, scheduled_date: req.body.scheduled_date, ordinal_target: req.body.ordinal_target });
      if (sched.error) return res.status(400).json({ error: sched.error });
      sets.push(`schedule_type = $${vals.push(sched.schedule_type)}`);
      sets.push(`scheduled_date = $${vals.push(sched.scheduled_date)}`);
      sets.push(`ordinal_target = $${vals.push(sched.ordinal_target)}`);
      // Re-scheduling a paused day makes it pending again.
      if (day.status === 'paused') sets.push(`status = 'pending'`);
    }
    if (typeof req.body?.name === 'string') sets.push(`name = $${vals.push(cleanText(req.body.name).slice(0, 200) || null)}`);
    if (typeof req.body?.notes === 'string') sets.push(`notes = $${vals.push(cleanText(req.body.notes).slice(0, 2000) || null)}`);
    if (['pending', 'paused', 'canceled'].includes(req.body?.status)) sets.push(`status = $${vals.push(req.body.status)}`);
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    sets.push('updated_at = now()');
    vals.push(day.id, req.user.company_id);
    const r = await pool.query(
      `UPDATE daily_checklists SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND company_id = $${vals.length} RETURNING *`,
      vals
    );
    res.json({ day: r.rows[0] });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PUT /days/:dayId/plan-items — replace a pending/paused plan's items.
router.put('/days/:dayId/plan-items', requirePerm('daily_checklist_schedule_days'), async (req, res) => {
  const items = planItems(req.body);
  const client = await pool.connect();
  try {
    const day = await loadDay(client, req.params.dayId, req.user.company_id);
    if (!day) { client.release(); return res.status(404).json({ error: 'Day not found' }); }
    if (!isPlannable(day)) { client.release(); return res.status(409).json({ error: 'Only a pending or paused day can be edited' }); }
    await client.query('BEGIN');
    await client.query('DELETE FROM daily_checklist_items WHERE daily_checklist_id = $1', [day.id]);
    for (let i = 0; i < items.length; i++) {
      await client.query("INSERT INTO daily_checklist_items (daily_checklist_id, text, kind, order_index, source) VALUES ($1, $2, $3, $4, 'scheduled')", [day.id, items[i].text, items[i].kind, i]);
    }
    // If this plan targets the day that's already running, mirror its items onto it too.
    const activeMatch = await activeDayMatching(client, req.user.company_id, day.project_id, day);
    if (activeMatch && activeMatch.id !== day.id) await appendItemsToDay(client, activeMatch.id, items);
    await client.query('COMMIT');
    res.json({ items: await loadItems(client, day.id), ...(activeMatch ? { merged_into_active: activeMatch.id } : {}) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// POST /projects/:projectId/queue/reorder — set queue order. Body { order: [dayId, ...] }.
router.post('/projects/:projectId/queue/reorder', requirePerm('daily_checklist_schedule_days'), async (req, res) => {
  const order = Array.isArray(req.body?.order) ? req.body.order.map(Number).filter(Number.isInteger) : null;
  if (!order || order.length === 0) return res.status(400).json({ error: 'order is required' });
  const client = await pool.connect();
  try {
    if (!(await projectBelongsToCompany(client, req.params.projectId, req.user.company_id))) {
      client.release();
      return res.status(404).json({ error: 'Project not found' });
    }
    await client.query('BEGIN');
    for (let i = 0; i < order.length; i++) {
      await client.query(
        "UPDATE daily_checklists SET queue_order = $1, updated_at = now() WHERE id = $2 AND company_id = $3 AND project_id = $4 AND status IN ('pending', 'paused')",
        [i, order[i], req.user.company_id, req.params.projectId]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// DELETE /days/:dayId — remove a pending/paused plan (a worked day is kept as history).
router.delete('/days/:dayId', requirePerm('daily_checklist_schedule_days'), async (req, res) => {
  try {
    const day = await loadDay(pool, req.params.dayId, req.user.company_id);
    if (!day) return res.status(404).json({ error: 'Day not found' });
    if (!isPlannable(day)) return res.status(409).json({ error: 'Only a pending or paused day can be deleted' });
    await pool.query('DELETE FROM daily_checklists WHERE id = $1 AND company_id = $2', [day.id, req.user.company_id]);
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
