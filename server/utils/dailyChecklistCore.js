/**
 * Shared Daily Checklist logic used by both routes/dailyChecklist.js and the optional
 * clock-in auto-start hook (routes/clock.js). Keeping the item-assembly here means the two
 * entry points can't drift. See docs/plans/daily-checklist.md.
 */

const MAX_TEXT = 500;
const normText = v => (typeof v === 'string' ? v.trim().toLowerCase() : '');

// Flip pending calendar plans whose date has passed to 'paused' (lazy, no cron). They stay
// in the queue — resumable or reschedulable — they just no longer read as "on time".
async function pauseOverdueCalendar(db, companyId, projectId) {
  await db.query(
    "UPDATE daily_checklists SET status = 'paused', updated_at = now() WHERE company_id = $1 AND project_id = $2 AND status = 'pending' AND schedule_type = 'calendar' AND scheduled_date < CURRENT_DATE",
    [companyId, projectId]
  );
}

// Insert the recurring template then the previous day's unchecked items onto `dayId`,
// skipping any whose normalized text is already present (`seen`). `startOrder` continues
// the item ordering after whatever items the day already has. Returns the next order index.
async function appendAssembledItems(client, { dayId, companyId, projectId, seen, startOrder, dayNumber = null, workDate = null }) {
  let order = startOrder;
  // roleIds: null/[] = all team-member-types; a set = visible to those types only.
  // carryover: whether this item's "not done" state rolls forward to the next day.
  const add = async (text, kind, source, roleIds = null, mode = 'shared', carryover = true) => {
    const key = normText(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    const roles = Array.isArray(roleIds) && roleIds.length ? roleIds : null;
    await client.query(
      'INSERT INTO daily_checklist_items (daily_checklist_id, text, kind, order_index, source, role_ids, mode, carryover) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [dayId, text.slice(0, MAX_TEXT), kind === 'text' ? 'text' : 'check', order++, source, roles, mode === 'individual' ? 'individual' : 'shared', carryover !== false]
    );
  };

  // The project's own hand-typed recurring template (the day-form carryover). All-types,
  // shared, carries forward — added first so it wins the text-dedup over any assigned dup.
  const recurring = await client.query(
    'SELECT text, kind FROM daily_checklist_recurring_items WHERE company_id = $1 AND project_id = $2 AND active = true ORDER BY order_index, id',
    [companyId, projectId]
  );
  for (const row of recurring.rows) await add(row.text, row.kind, 'recurring', null, 'shared', true);

  // Assigned Checklist Builder checklists (Project Daily): each active assignment matching
  // this project AND scheduled for this day (every / this ordinal / this date) expands its
  // template's items, tagged with the assignment's role set, mode, and carryover flag.
  // An ordinal and a date assignment that resolve to the same day both match here → their
  // checklists combine (deduped) into the one day.
  const assigned = await client.query(
    `SELECT a.role_ids, a.mode, a.carryover, t.items
       FROM daily_checklist_assignments a
       JOIN safety_checklist_templates t ON t.id = a.template_id
      WHERE a.company_id = $1 AND a.active = true
        AND (a.project_id IS NULL OR a.project_id = $2)
        AND (a.schedule_type = 'every'
             OR (a.schedule_type = 'ordinal' AND $3::int IS NOT NULL AND a.ordinal_target = $3::int)
             OR (a.schedule_type = 'date' AND $4::date IS NOT NULL AND a.scheduled_date = $4::date))
      ORDER BY a.order_index, a.id`,
    [companyId, projectId, dayNumber, workDate]
  );
  for (const asg of assigned.rows) {
    const items = Array.isArray(asg.items) ? asg.items : [];
    for (const it of items) {
      const label = it && (it.label ?? it.text ?? it.name);
      if (!label) continue;
      await add(label, it.type === 'text' ? 'text' : 'check', 'recurring', asg.role_ids, asg.mode, asg.carryover);
    }
  }

  const prev = await client.query(
    "SELECT id FROM daily_checklists WHERE company_id = $1 AND project_id = $2 AND status = 'completed' ORDER BY work_date DESC NULLS LAST, day_number DESC LIMIT 1",
    [companyId, projectId]
  );
  if (prev.rows[0]) {
    // Roll forward unchecked SHARED items that opted into carryover. Individual items are
    // per-person, re-seed fresh each day, and have no single "not done" to carry. "Not
    // done" is generalized: an unchecked box or an empty text field.
    const carry = await client.query(
      "SELECT text, kind, role_ids FROM daily_checklist_items WHERE daily_checklist_id = $1 AND mode = 'shared' AND carryover = true AND ((kind = 'check' AND checked = false) OR (kind = 'text' AND (value IS NULL OR value = ''))) ORDER BY order_index, id",
      [prev.rows[0].id]
    );
    for (const row of carry.rows) await add(row.text, row.kind, 'rollover', row.role_ids, 'shared', true);
  }
  return order;
}

/**
 * Start the next day for a project if none is active — the clock-in auto-start path.
 * An automatic trigger can't prompt, so a calendar plan dated today wins, then an ordinal
 * plan for this day number, then the top of the pending queue, then a fresh adhoc day
 * (this is the same precedence as the manual route, minus the conflict prompt). Assumes it
 * runs inside a caller-managed transaction. Returns { started, dayId }.
 */
async function autoStartDay(client, { companyId, projectId, userId, workDate = null }) {
  const active = await client.query(
    "SELECT id FROM daily_checklists WHERE company_id = $1 AND project_id = $2 AND status = 'active'",
    [companyId, projectId]
  );
  if (active.rows[0]) return { started: false, dayId: active.rows[0].id };

  await pauseOverdueCalendar(client, companyId, projectId);
  const dayNumber = (await client.query(
    "SELECT COALESCE(MAX(day_number), 0) + 1 AS n FROM daily_checklists WHERE company_id = $1 AND project_id = $2 AND status IN ('active', 'completed')",
    [companyId, projectId]
  )).rows[0].n;
  let wd = workDate;
  if (!wd) wd = (await client.query('SELECT CURRENT_DATE::text AS d')).rows[0].d;

  const pick = async (extra, val) => (await client.query(
    `SELECT * FROM daily_checklists WHERE company_id = $1 AND project_id = $2 AND status IN ('pending','paused') AND ${extra} ORDER BY queue_order NULLS LAST, id LIMIT 1`,
    [companyId, projectId, val]
  )).rows[0] || null;
  const chosen = (await pick("schedule_type = 'calendar' AND scheduled_date = $3::date", wd))
    || (await pick("schedule_type = 'ordinal' AND ordinal_target = $3", dayNumber))
    || (await client.query(
      "SELECT * FROM daily_checklists WHERE company_id = $1 AND project_id = $2 AND status IN ('pending','paused') ORDER BY queue_order NULLS LAST, id LIMIT 1",
      [companyId, projectId]
    )).rows[0]
    || null;

  let day;
  if (chosen) {
    day = (await client.query(
      "UPDATE daily_checklists SET status = 'active', work_date = COALESCE($3::date, CURRENT_DATE), day_number = $4, started_by = $5, started_at = now(), queue_order = NULL, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *",
      [chosen.id, companyId, workDate, dayNumber, userId]
    )).rows[0];
  } else {
    day = (await client.query(
      `INSERT INTO daily_checklists (company_id, project_id, status, schedule_type, work_date, day_number, started_by, started_at, created_by)
       VALUES ($1, $2, 'active', 'adhoc', COALESCE($3::date, CURRENT_DATE), $4, $5, now(), $5) RETURNING *`,
      [companyId, projectId, workDate, dayNumber, userId]
    )).rows[0];
  }

  const cur = await client.query('SELECT text, order_index FROM daily_checklist_items WHERE daily_checklist_id = $1', [day.id]);
  const seen = new Set(cur.rows.map(r => normText(r.text)));
  const startOrder = cur.rows.reduce((m, r) => Math.max(m, r.order_index + 1), 0);
  await appendAssembledItems(client, { dayId: day.id, companyId, projectId, seen, startOrder, dayNumber: day.day_number, workDate: day.work_date });
  return { started: true, dayId: day.id };
}

// Transaction wrapper for the clock-in hook — best-effort, swallows a lost start race.
async function autoStartDayTx(pool, opts) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await autoStartDay(client, opts);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err && err.code === '23505') return { started: false, race: true }; // another start won
    throw err;
  } finally { client.release(); }
}

module.exports = { MAX_TEXT, normText, pauseOverdueCalendar, appendAssembledItems, autoStartDay, autoStartDayTx };
