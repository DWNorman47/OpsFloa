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
const { DAILY_CHECKLIST_ITEM_MODES } = require('../constants/dailyChecklistEnums');
const { ymd } = require('../utils/hoursRules');

// Who is viewing a day — admins see every item; a worker sees all-types items plus their
// own team-member-type's, and sees their own private state for individual items.
function viewerOf(req) {
  const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  return { isAdmin, userId: req.user.id, roleId: req.user.role_id ?? null };
}
const cleanMode = m => (m === 'individual' ? 'individual' : 'shared');

const cleanText = v => (typeof v === 'string' ? v.trim() : '');
const isYmd = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

// Load a day scoped to the company (null if it isn't theirs / doesn't exist).
async function loadDay(db, dayId, companyId) {
  const r = await db.query('SELECT * FROM daily_checklists WHERE id = $1 AND company_id = $2', [dayId, companyId]);
  return r.rows[0] || null;
}
// Load a day's items from a viewer's perspective. Individual items resolve to that
// viewer's own private state (via daily_checklist_item_user_state); shared items use the
// item row. A non-admin viewer sees only all-types items + their own type's. With no
// viewer (admin/day-manager contexts), every item is returned with its shared state.
async function loadItems(db, dayId, viewer = null) {
  const uid = viewer ? viewer.userId : null;
  const params = [dayId, uid];
  let where = 'i.daily_checklist_id = $1';
  if (viewer && !viewer.isAdmin) {
    params.push(viewer.roleId);
    where += ` AND (i.role_ids IS NULL OR $${params.length} = ANY(i.role_ids))`;
  }
  const r = await db.query(
    `SELECT i.id, i.text, i.kind, i.order_index, i.source, i.role_ids, i.mode,
            CASE WHEN i.mode = 'individual' THEN COALESCE(us.checked, false) ELSE i.checked END AS checked,
            CASE WHEN i.mode = 'individual' THEN us.value ELSE i.value END AS value,
            CASE WHEN i.mode = 'individual' THEN us.checked_at ELSE i.checked_at END AS checked_at,
            CASE WHEN i.mode = 'individual' THEN us.user_id ELSE i.checked_by END AS checked_by
       FROM daily_checklist_items i
       LEFT JOIN daily_checklist_item_user_state us ON us.item_id = i.id AND us.user_id = $2
      WHERE ${where}
      ORDER BY i.order_index, i.id`,
    params
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

// ── Project Daily assignments ────────────────────────────────────────────────────
// The Project Daily tab seeds each day from whole Checklist Builder checklists. An
// assignment = one template + a project scope + a team-role scope + a mode:
//   project_id: null = all projects | id = one project (single scope)
//   role_ids:   null/[] = all team-member-types | a set = those roles (one shared row,
//                                                 visible to any of them)
//   mode:       'shared' | 'individual' (the whole checklist)
// At day-assembly each matching assignment expands its template's items onto the day.

// Sanitize a role scope array: [] or non-array → null (= all); else the subset of ids that
// belong to the company (via `valid`, a Set of allowed ids as strings).
const scopeIds = (raw, valid) => {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const ids = [...new Set(raw.map(Number).filter(n => Number.isInteger(n) && valid.has(String(n))))];
  return ids.length ? ids : null;
};

async function companyRoleIds(db, companyId) {
  const r = await db.query('SELECT id FROM roles WHERE company_id = $1', [companyId]);
  return new Set(r.rows.map(x => String(x.id)));
}

// Normalize an assignment's day schedule from the body → { schedule_type, ordinal_target,
// scheduled_date } or { error }. 'none'/'every' clear both targets. Unknown → 'none'.
function normAssignmentSchedule(body) {
  if (body?.schedule_type === 'ordinal') {
    const n = Number(body?.ordinal_target);
    if (!Number.isInteger(n) || n < 1) return { error: 'ordinal_target must be a positive integer' };
    return { schedule_type: 'ordinal', ordinal_target: n, scheduled_date: null };
  }
  if (body?.schedule_type === 'date') {
    if (!isYmd(body?.scheduled_date)) return { error: 'scheduled_date must be YYYY-MM-DD' };
    return { schedule_type: 'date', ordinal_target: null, scheduled_date: body.scheduled_date };
  }
  if (body?.schedule_type === 'every') return { schedule_type: 'every', ordinal_target: null, scheduled_date: null };
  return { schedule_type: 'none', ordinal_target: null, scheduled_date: null };
}

// GET /assignments?project_id= — assignments for one project scope (absent/blank = the
// all-projects scope, i.e. project_id IS NULL), with template name + item count.
router.get('/assignments', async (req, res) => {
  const raw = req.query.project_id;
  const params = [req.user.company_id];
  let scope = 'a.project_id IS NULL';
  if (raw != null && raw !== '') {
    if (!(await projectBelongsToCompany(pool, raw, req.user.company_id))) return res.status(404).json({ error: 'Project not found' });
    params.push(raw); scope = `a.project_id = $${params.length}`;
  }
  try {
    const r = await pool.query(
      `SELECT a.id, a.template_id, a.project_id, a.role_ids, a.mode, a.order_index, a.active,
              a.schedule_type, a.ordinal_target, a.scheduled_date, a.carryover,
              t.name AS template_name, t.type AS template_type,
              COALESCE(jsonb_array_length(t.items), 0) AS item_count
         FROM daily_checklist_assignments a
         JOIN safety_checklist_templates t ON t.id = a.template_id
        WHERE a.company_id = $1 AND ${scope}
        ORDER BY a.order_index, a.id`,
      params
    );
    res.json({ assignments: r.rows });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /assignments — assign a checklist. Body: { template_id, project_id?, role_ids?, mode? }.
router.post('/assignments', requirePerm('daily_checklist_manage_recurring'), async (req, res) => {
  const companyId = req.user.company_id;
  const templateId = Number(req.body?.template_id);
  if (!Number.isInteger(templateId)) return res.status(400).json({ error: 'template_id required' });
  const rawProject = req.body?.project_id;
  try {
    const tmpl = await pool.query('SELECT id FROM safety_checklist_templates WHERE id = $1 AND company_id = $2', [templateId, companyId]);
    if (tmpl.rowCount === 0) return res.status(404).json({ error: 'Checklist not found' });
    let projectId = null;
    if (rawProject != null && rawProject !== '') {
      if (!(await projectBelongsToCompany(pool, rawProject, companyId))) return res.status(400).json({ error: 'Invalid project' });
      projectId = rawProject;
    }
    const roleIds = scopeIds(req.body?.role_ids, await companyRoleIds(pool, companyId));
    const sched = normAssignmentSchedule(req.body);
    if (sched.error) return res.status(400).json({ error: sched.error });
    const ord = await pool.query(
      'SELECT COALESCE(MAX(order_index), -1) + 1 AS n FROM daily_checklist_assignments WHERE company_id = $1 AND project_id IS NOT DISTINCT FROM $2',
      [companyId, projectId]
    );
    const r = await pool.query(
      `INSERT INTO daily_checklist_assignments
         (company_id, template_id, project_id, role_ids, mode, schedule_type, ordinal_target, scheduled_date, carryover, order_index, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [companyId, templateId, projectId, roleIds, cleanMode(req.body?.mode),
       sched.schedule_type, sched.ordinal_target, sched.scheduled_date, req.body?.carryover === true, ord.rows[0].n, req.user.id]
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /assignments/:id — update role scope / mode / active. Any field may be omitted.
router.patch('/assignments/:id', requirePerm('daily_checklist_manage_recurring'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const existing = await pool.query('SELECT * FROM daily_checklist_assignments WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    const cur = existing.rows[0];
    const roleIds = req.body?.role_ids !== undefined ? scopeIds(req.body.role_ids, await companyRoleIds(pool, companyId)) : cur.role_ids;
    const mode = req.body?.mode !== undefined ? cleanMode(req.body.mode) : cur.mode;
    const active = typeof req.body?.active === 'boolean' ? req.body.active : cur.active;
    const carryover = typeof req.body?.carryover === 'boolean' ? req.body.carryover : cur.carryover;
    let schedType = cur.schedule_type, ordTarget = cur.ordinal_target, schedDate = cur.scheduled_date;
    if (req.body?.schedule_type !== undefined) {
      const sched = normAssignmentSchedule(req.body);
      if (sched.error) return res.status(400).json({ error: sched.error });
      ({ schedule_type: schedType, ordinal_target: ordTarget, scheduled_date: schedDate } = sched);
    }
    const r = await pool.query(
      `UPDATE daily_checklist_assignments
          SET role_ids = $1, mode = $2, active = $3, schedule_type = $4, ordinal_target = $5,
              scheduled_date = $6, carryover = $7, updated_at = now()
        WHERE id = $8 AND company_id = $9
        RETURNING id, template_id, project_id, role_ids, mode, schedule_type, ordinal_target, scheduled_date, carryover, order_index, active`,
      [roleIds, mode, active, schedType, ordTarget, schedDate, carryover, req.params.id, companyId]
    );
    res.json({ assignment: r.rows[0] });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /assignments/reorder — set order_index by array position. Body: { order: [id, ...] }
// (the assignment ids of one project scope, in the desired order).
router.post('/assignments/reorder', requirePerm('daily_checklist_manage_recurring'), async (req, res) => {
  const order = Array.isArray(req.body?.order) ? req.body.order : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < order.length; i++) {
      await client.query(
        'UPDATE daily_checklist_assignments SET order_index = $1, updated_at = now() WHERE id = $2 AND company_id = $3',
        [i, order[i], req.user.company_id]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// DELETE /assignments/:id
router.delete('/assignments/:id', requirePerm('daily_checklist_manage_recurring'), async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM daily_checklist_assignments WHERE id = $1 AND company_id = $2 RETURNING id', [req.params.id, req.user.company_id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// ── Project work-calendar (the scheduler) ───────────────────────────────────────
// Which calendar dates a project is worked. The Nth worked date is Day N — the day
// number is computed by rank over ALL the project's worked dates, then windowed to the
// requested range, so a mid-range date still shows its true global Day number.

// GET /projects/:projectId/work-days?from=&to= — worked dates in [from,to] + their Day #.
router.get('/projects/:projectId/work-days', async (req, res) => {
  try {
    if (!(await projectBelongsToCompany(pool, req.params.projectId, req.user.company_id)))
      return res.status(404).json({ error: 'Project not found' });
    const params = [req.user.company_id, req.params.projectId];
    let range = '';
    if (isYmd(req.query.from)) { params.push(req.query.from); range += ` AND work_date >= $${params.length}`; }
    if (isYmd(req.query.to))   { params.push(req.query.to);   range += ` AND work_date <= $${params.length}`; }
    const r = await pool.query(
      `SELECT to_char(work_date, 'YYYY-MM-DD') AS work_date, day_number
         FROM (
           SELECT work_date, ROW_NUMBER() OVER (ORDER BY work_date) AS day_number
             FROM project_work_days WHERE company_id = $1 AND project_id = $2
         ) t
        WHERE true${range}
        ORDER BY work_date`,
      params
    );
    res.json({ days: r.rows.map(x => ({ work_date: x.work_date, day_number: Number(x.day_number) })) });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PUT /projects/:projectId/work-days — mark a date worked/unworked. Body { work_date, worked }.
router.put('/projects/:projectId/work-days', requirePerm('daily_checklist_manage_recurring'), async (req, res) => {
  const { work_date, worked } = req.body || {};
  if (!isYmd(work_date)) return res.status(400).json({ error: 'work_date must be YYYY-MM-DD' });
  try {
    if (!(await projectBelongsToCompany(pool, req.params.projectId, req.user.company_id)))
      return res.status(404).json({ error: 'Project not found' });
    if (worked === false) {
      await pool.query('DELETE FROM project_work_days WHERE company_id = $1 AND project_id = $2 AND work_date = $3', [req.user.company_id, req.params.projectId, work_date]);
    } else {
      await pool.query(
        'INSERT INTO project_work_days (company_id, project_id, work_date, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT (project_id, work_date) DO NOTHING',
        [req.user.company_id, req.params.projectId, work_date, req.user.id]
      );
    }
    res.json({ ok: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
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
    res.json({ day, items: day ? await loadItems(pool, day.id, viewerOf(req)) : [] });
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
              -- An INDIVIDUAL item's "done" state lives in daily_checklist_item_user_state, not
              -- i.checked, so count it done when anyone completed it — otherwise a crew that
              -- finished a per-person day still read "0 / N".
              COUNT(i.id) FILTER (
                WHERE (i.mode <> 'individual' AND i.checked)
                   OR (i.mode = 'individual' AND EXISTS (
                         SELECT 1 FROM daily_checklist_item_user_state s WHERE s.item_id = i.id AND s.checked = true))
              )::int AS checked_count
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

// GET /days/:dayId — one day's full item breakdown, with who checked each and when.
// Read-only (field access); used by the history view to expand a completed day.
router.get('/days/:dayId', async (req, res) => {
  try {
    const day = await loadDay(pool, req.params.dayId, req.user.company_id);
    if (!day) return res.status(404).json({ error: 'Not found' });
    const viewer = viewerOf(req);
    // History is a REVIEW of a completed day — an individual item aggregates the whole crew's
    // per-person state (who checked, all their text answers, latest time), NOT the viewer's own
    // (the old query resolved us.user_id = the viewer, so a reviewing admin saw everything as
    // unchecked and every completion credited to whoever was looking).
    const params = [req.params.dayId];
    let where = 'i.daily_checklist_id = $1';
    if (!viewer.isAdmin) { params.push(viewer.roleId); where += ` AND (i.role_ids IS NULL OR $${params.length} = ANY(i.role_ids))`; }
    const items = await pool.query(
      `SELECT i.id, i.text, i.kind, i.order_index, i.source, i.role_ids, i.mode,
              CASE WHEN i.mode = 'individual'
                   THEN EXISTS (SELECT 1 FROM daily_checklist_item_user_state s WHERE s.item_id = i.id AND s.checked = true)
                   ELSE i.checked END AS checked,
              CASE WHEN i.mode = 'individual'
                   THEN (SELECT string_agg(s.value, E'\n') FROM daily_checklist_item_user_state s WHERE s.item_id = i.id AND s.value IS NOT NULL AND s.value <> '')
                   ELSE i.value END AS value,
              CASE WHEN i.mode = 'individual'
                   THEN (SELECT max(s.checked_at) FROM daily_checklist_item_user_state s WHERE s.item_id = i.id AND s.checked = true)
                   ELSE i.checked_at END AS checked_at,
              CASE WHEN i.mode = 'individual'
                   THEN (SELECT string_agg(su.full_name, ', ' ORDER BY su.full_name)
                           FROM daily_checklist_item_user_state s JOIN users su ON su.id = s.user_id
                          WHERE s.item_id = i.id AND s.checked = true)
                   ELSE u.full_name END AS checked_by_name
         FROM daily_checklist_items i
         LEFT JOIN users u ON u.id = i.checked_by
        WHERE ${where}
        ORDER BY i.order_index, i.id`,
      params
    );
    res.json({
      day: { id: day.id, day_number: day.day_number, work_date: day.work_date, status: day.status, completed_at: day.completed_at },
      items: items.rows,
    });
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
      return res.json({ day: d0, items: await loadItems(client, d0.id, viewerOf(req)), started: false });
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

    await appendAssembledItems(client, { dayId: day.id, companyId, projectId, seen, startOrder: order, dayNumber: day.day_number, workDate: day.work_date });

    await client.query('COMMIT');
    res.status(201).json({ day, items: await loadItems(client, day.id, viewerOf(req)), started: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Lost a race to another start → the other one won; return the active day.
    if (err && err.code === '23505') {
      try {
        const r = await pool.query(
          "SELECT * FROM daily_checklists WHERE company_id = $1 AND project_id = $2 AND status = 'active'",
          [companyId, projectId]
        );
        if (r.rows[0]) return res.json({ day: r.rows[0], items: await loadItems(pool, r.rows[0].id, viewerOf(req)), started: false });
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
      "INSERT INTO daily_checklist_items (daily_checklist_id, text, kind, order_index, source) VALUES ($1, $2, $3, $4, 'manual') RETURNING id, text, kind, checked, value, order_index, source, role_ids, mode",
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
    const viewer = viewerOf(req);
    const itemRow = (await pool.query(
      'SELECT id, mode, role_ids FROM daily_checklist_items WHERE id = $1 AND daily_checklist_id = $2',
      [req.params.itemId, day.id]
    )).rows[0];
    if (!itemRow) return res.status(404).json({ error: 'Item not found' });
    // A worker may only touch items their team-member-type can see.
    if (!viewer.isAdmin && Array.isArray(itemRow.role_ids) && itemRow.role_ids.length &&
        !itemRow.role_ids.map(String).includes(String(viewer.roleId))) {
      return res.status(404).json({ error: 'Item not found' });
    }

    if (itemRow.mode === 'individual') {
      // Private per-person check/value; a label edit still updates the shared definition.
      if (hasChecked || hasValue) {
        await pool.query(
          `INSERT INTO daily_checklist_item_user_state (item_id, user_id, checked, value, checked_at)
             VALUES ($1, $2, $3, $4, CASE WHEN $3 THEN now() ELSE NULL END)
           ON CONFLICT (item_id, user_id) DO UPDATE SET
             checked    = CASE WHEN $5 THEN EXCLUDED.checked ELSE daily_checklist_item_user_state.checked END,
             value      = CASE WHEN $6 THEN EXCLUDED.value   ELSE daily_checklist_item_user_state.value END,
             checked_at = CASE WHEN $5 THEN (CASE WHEN EXCLUDED.checked THEN now() ELSE NULL END) ELSE daily_checklist_item_user_state.checked_at END`,
          [itemRow.id, viewer.userId, hasChecked ? req.body.checked : false, hasValue ? req.body.value.slice(0, 2000) : null, hasChecked, hasValue]
        );
      }
      if (hasText) {
        const text = cleanText(req.body.text).slice(0, MAX_TEXT);
        if (!text) return res.status(400).json({ error: 'Text cannot be empty' });
        await pool.query('UPDATE daily_checklist_items SET text = $1 WHERE id = $2 AND daily_checklist_id = $3', [text, itemRow.id, day.id]);
      }
    } else {
      // Shared: update the item row (everyone matching sees the change).
      // A shared TEXT value is a single field — two people filling it silently overwrite each
      // other (last-write-wins). When the client sends `prev_value` (what it loaded), do a
      // compare-and-swap and 409 on a concurrent change so the second writer reloads/merges
      // instead of clobbering. Omitting prev_value keeps the legacy overwrite (older clients).
      if (hasValue && typeof req.body?.prev_value === 'string') {
        const r = await pool.query(
          'UPDATE daily_checklist_items SET value = $1 WHERE id = $2 AND daily_checklist_id = $3 AND value IS NOT DISTINCT FROM $4',
          [req.body.value.slice(0, 2000), req.params.itemId, day.id, req.body.prev_value]
        );
        if (r.rowCount === 0) {
          const still = await pool.query('SELECT value FROM daily_checklist_items WHERE id = $1 AND daily_checklist_id = $2', [req.params.itemId, day.id]);
          if (still.rowCount === 0) return res.status(404).json({ error: 'Item not found' });
          return res.status(409).json({ error: 'Someone else updated this note — reload to see their entry before saving.', code: 'value_conflict', value: still.rows[0].value });
        }
      }
      const sets = [], vals = [];
      if (hasChecked) {
        sets.push(`checked = $${vals.push(req.body.checked)}`);
        if (req.body.checked) { sets.push(`checked_by = $${vals.push(req.user.id)}`); sets.push('checked_at = now()'); }
        else { sets.push('checked_by = NULL'); sets.push('checked_at = NULL'); }
      }
      if (hasValue && typeof req.body?.prev_value !== 'string') sets.push(`value = $${vals.push(req.body.value.slice(0, 2000))}`);
      if (hasText) {
        const text = cleanText(req.body.text).slice(0, MAX_TEXT);
        if (!text) return res.status(400).json({ error: 'Text cannot be empty' });
        sets.push(`text = $${vals.push(text)}`);
      }
      if (sets.length) {
        vals.push(req.params.itemId, day.id);
        const upd = await pool.query(
          `UPDATE daily_checklist_items SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND daily_checklist_id = $${vals.length}`,
          vals
        );
        if (upd.rowCount === 0) return res.status(404).json({ error: 'Item not found' });
      }
    }

    const item = (await loadItems(pool, day.id, viewer)).find(r => String(r.id) === String(req.params.itemId));
    res.json({ item });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /days/:dayId/items/:itemId — remove an item from the active day.
router.delete('/days/:dayId/items/:itemId', requirePerm('daily_checklist_check_items'), async (req, res) => {
  try {
    const day = await loadDay(pool, req.params.dayId, req.user.company_id);
    if (!day) return res.status(404).json({ error: 'Day not found' });
    if (day.status !== 'active') return res.status(409).json({ error: 'Day is not active' });
    const viewer = viewerOf(req);
    const params = [req.params.itemId, day.id];
    let extra = '';
    if (!viewer.isAdmin) { params.push(viewer.roleId); extra = ` AND (role_ids IS NULL OR $${params.length} = ANY(role_ids))`; }
    const r = await pool.query(`DELETE FROM daily_checklist_items WHERE id = $1 AND daily_checklist_id = $2${extra} RETURNING id`, params);
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
// Parse a template/plan item list into { text, kind, carryover } rows (blank-text dropped).
// `carryover` marks a row as recurring — it belongs to the project's recurring template
// rather than the one prepared day.
const planItems = body => (Array.isArray(body?.items) ? body.items : [])
  .map(it => ({ text: cleanText(it?.text), kind: cleanKind(it?.kind), carryover: it?.carryover === true }))
  .filter(it => it.text)
  .map(it => ({ text: it.text.slice(0, MAX_TEXT), kind: it.kind, carryover: it.carryover }))
  .slice(0, 200);

// Replace the project's recurring template with `items` (the carryover rows from a day
// form). Full replace — the form always pre-loads the current recurring set, so what it
// sends back IS the intended template.
async function replaceRecurring(client, companyId, projectId, items, userId) {
  await client.query('DELETE FROM daily_checklist_recurring_items WHERE company_id = $1 AND project_id = $2', [companyId, projectId]);
  for (let i = 0; i < items.length; i++) {
    await client.query(
      'INSERT INTO daily_checklist_recurring_items (company_id, project_id, text, kind, order_index, active, created_by) VALUES ($1, $2, $3, $4, $5, true, $6)',
      [companyId, projectId, items[i].text, items[i].kind, i, userId]
    );
  }
}

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
    : ymd(schedule.scheduled_date) === ymd(active.work_date); // both DATE cols → normalize (String().slice gave "Www Mmm DD", equal only by coincidence)
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
  const recurring = items.filter(it => it.carryover);   // → the recurring template
  const dayItems = items.filter(it => !it.carryover);   // → this one prepared day
  const name = cleanText(req.body?.name).slice(0, 200) || null;
  const notes = cleanText(req.body?.notes).slice(0, 2000) || null;
  const client = await pool.connect();
  try {
    if (!(await projectBelongsToCompany(client, projectId, companyId))) {
      client.release();
      return res.status(404).json({ error: 'Project not found' });
    }
    await client.query('BEGIN');
    await replaceRecurring(client, companyId, projectId, recurring, req.user.id);

    // If this plan targets the day already running, add its items straight to that day
    // (both the one-offs and the just-set recurring rows) instead of queuing a plan that
    // could never activate.
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
    // Only the day-specific rows are stored on the plan; recurring rows apply when it starts.
    for (let i = 0; i < dayItems.length; i++) {
      await client.query("INSERT INTO daily_checklist_items (daily_checklist_id, text, kind, order_index, source) VALUES ($1, $2, $3, $4, 'scheduled')", [day.id, dayItems[i].text, dayItems[i].kind, i]);
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
  const recurring = items.filter(it => it.carryover);
  const dayItems = items.filter(it => !it.carryover);
  const client = await pool.connect();
  try {
    const day = await loadDay(client, req.params.dayId, req.user.company_id);
    if (!day) { client.release(); return res.status(404).json({ error: 'Day not found' }); }
    if (!isPlannable(day)) { client.release(); return res.status(409).json({ error: 'Only a pending or paused day can be edited' }); }
    await client.query('BEGIN');
    await replaceRecurring(client, req.user.company_id, day.project_id, recurring, req.user.id);
    await client.query('DELETE FROM daily_checklist_items WHERE daily_checklist_id = $1', [day.id]);
    for (let i = 0; i < dayItems.length; i++) {
      await client.query("INSERT INTO daily_checklist_items (daily_checklist_id, text, kind, order_index, source) VALUES ($1, $2, $3, $4, 'scheduled')", [day.id, dayItems[i].text, dayItems[i].kind, i]);
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
