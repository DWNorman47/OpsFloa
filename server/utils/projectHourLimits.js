/**
 * Per-project worker hour limits.
 *
 * A project can cap how many hours a single worker logs on it per day and/or
 * per week (see projects.hour_limit_mode + daily/weekly_hour_limit, migration
 * 0167). Two modes:
 *   warn — soft: nothing is blocked; the worker/admin are warned when a limit
 *          is crossed (worker via the live clock banner, admin via a clock-out
 *          alert).
 *   hard — the shift is stopped, or switched to the overflow project, at the
 *          exact instant the limit is reached.
 *
 * The enforcement is DETERMINISTIC BY LIMIT-TIME, not by whether an app is open.
 * Given a running shift's clock-in instant + the hours already worked on the
 * project + the cap, the exact instant the worker reaches the limit (`limitTs`)
 * is known. Whenever an active clock is *observed* — the worker opens the app
 * (`GET /clock/status`) or an admin loads Workforce (`GET /admin/active-clocks`)
 * — we reconcile it: if `now >= limitTs` and it hasn't already stopped/switched,
 * we apply the stop-or-switch AS OF `limitTs` (not "now"), so the recorded hours
 * never overshoot regardless of who was watching. Mirrors the app's other lazy
 * sweeps (sweepStaleActiveClock, checklist lazy-generation).
 *
 * Scope: per-project for now. Every function that reads caps takes them off the
 * passed project row, so a per-worker-per-project override can slot in later
 * without touching the call sites.
 */

const pool = require('../db');
const logger = require('../logger');
const { wallClockInTZ } = require('./timeFormat');
const { HOUR_LIMIT_MODES } = require('../constants/projectEnums');

const MS_PER_HOUR = 3600000;

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Net worked hours of a completed entry from its wall-clock time strings, minus
// logged break. Same formula the overtime-alert path uses in clock.js — kept in
// lockstep so a cap and an OT alert count a shift identically.
function calcH(start, end, brk = 0) {
  const startDate = new Date(`1970-01-01T${start}`);
  const endDate = new Date(`1970-01-01T${end}`);
  let hours = (endDate - startDate) / MS_PER_HOUR;
  if (hours < 0) hours += 24; // crossed midnight
  return Math.max(0, hours - (brk || 0) / 60);
}

async function loadWeekStart(db, companyId) {
  const r = await db.query(
    `SELECT value FROM settings WHERE company_id = $1 AND key = 'week_start'`,
    [companyId]
  );
  const n = parseInt(r.rows[0]?.value ?? 1, 10);
  return Number.isFinite(n) ? n : 1;
}

/**
 * Hours this worker has ALREADY logged on this project (completed time entries),
 * for the given work day and the company week that contains it. All wage types
 * count — a prevailing-wage hour is still an hour against the cap.
 * `workDate` may be null → the server's CURRENT_DATE is used (COALESCE in SQL).
 */
async function loadPriorHours(db, userId, projectId, workDate, weekStart) {
  const dayRows = await db.query(
    `SELECT start_time, end_time, break_minutes FROM time_entries
      WHERE user_id = $1 AND project_id = $2
        AND work_date = COALESCE($3::date, CURRENT_DATE)`,
    [userId, projectId, workDate || null]
  );
  // Bucket by the company's week_start (DATE_TRUNC('week') is always Monday and
  // would misgroup non-Monday weeks); identical math to the OT-alert query.
  const weekRows = await db.query(
    `SELECT start_time, end_time, break_minutes FROM time_entries
      WHERE user_id = $1 AND project_id = $2
        AND (work_date::date - ((EXTRACT(DOW FROM work_date::date)::int - $4 + 7) % 7))
          = (COALESCE($3::date, CURRENT_DATE)
              - ((EXTRACT(DOW FROM COALESCE($3::date, CURRENT_DATE))::int - $4 + 7) % 7))`,
    [userId, projectId, workDate || null, weekStart]
  );
  const sum = (rows) => rows.reduce((s, r) => s + calcH(r.start_time, r.end_time, r.break_minutes), 0);
  return { daily: sum(dayRows.rows), weekly: sum(weekRows.rows) };
}

/**
 * The instant a running shift reaches the project's limit: the earlier of the
 * daily and weekly caps (whichever are set). `clockInTime` is a Date; `prior`
 * is the {daily, weekly} already-worked hours BEFORE this shift. Running-shift
 * time is gross elapsed (breaks aren't known until clock-out). Returns
 * {limitTs: Date|null, reason: 'daily'|'weekly'|null}.
 */
function computeLimitTs({ clockInTime, prior, project }) {
  const candidates = [];
  const daily = numOrNull(project.daily_hour_limit);
  const weekly = numOrNull(project.weekly_hour_limit);
  if (daily != null) {
    const remaining = Math.max(0, daily - prior.daily);
    candidates.push({ ts: new Date(clockInTime.getTime() + remaining * MS_PER_HOUR), reason: 'daily' });
  }
  if (weekly != null) {
    const remaining = Math.max(0, weekly - prior.weekly);
    candidates.push({ ts: new Date(clockInTime.getTime() + remaining * MS_PER_HOUR), reason: 'weekly' });
  }
  if (!candidates.length) return { limitTs: null, reason: null };
  candidates.sort((a, b) => a.ts - b.ts);
  return { limitTs: candidates[0].ts, reason: candidates[0].reason };
}

/**
 * Clock-in / switch gate: is the worker ALREADY at/over a limit before starting
 * on `project`? (The mid-shift crossing is handled by reconciliation, not here.)
 */
function evaluateGate(project, prior) {
  const mode = project.hour_limit_mode;
  if (mode !== 'warn' && mode !== 'hard') return { mode: 'off', atLimit: false };
  const daily = numOrNull(project.daily_hour_limit);
  const weekly = numOrNull(project.weekly_hour_limit);
  const overDaily = daily != null && prior.daily >= daily;
  const overWeekly = weekly != null && prior.weekly >= weekly;
  return {
    mode,
    atLimit: overDaily || overWeekly,
    reason: overDaily ? 'daily' : (overWeekly ? 'weekly' : null),
    limit: overDaily ? daily : (overWeekly ? weekly : null),
    overflowProjectId: project.hour_limit_overflow_project_id || null,
  };
}

// A project row (id, name, wage_type, active, hour_limit_*) usable as an overflow
// target if it exists, is active, isn't the source, and has spare capacity at
// `atTs` for this worker; otherwise null (→ caller clocks the worker out instead).
async function pickOverflowTarget(db, { userId, overflowProjectId, sourceProjectId, companyId, workDate, weekStart, atTs }) {
  if (!overflowProjectId || overflowProjectId === sourceProjectId) return null;
  const r = await db.query(
    `SELECT id, name, wage_type, active, hour_limit_mode, daily_hour_limit, weekly_hour_limit,
            hour_limit_overflow_project_id
       FROM projects WHERE id = $1 AND company_id = $2`,
    [overflowProjectId, companyId]
  );
  const ov = r.rows[0];
  if (!ov || !ov.active) return null;
  if (ov.hour_limit_mode === 'hard') {
    const ovPrior = await loadPriorHours(db, userId, ov.id, workDate, weekStart);
    const { limitTs } = computeLimitTs({ clockInTime: atTs, prior: ovPrior, project: ov });
    // No spare capacity if the overflow's own limit is already reached at atTs.
    if (limitTs && limitTs.getTime() <= atTs.getTime()) return null;
  }
  return ov;
}

// Write the completed portion of a shift (clock-in → endTs) as a time entry,
// mirroring the /switch and /out INSERT in clock.js. System-initiated, so no
// break/mileage/clock-out location. Skips a zero-length entry.
async function closeEntryAsOf(db, ac, endTs) {
  const clockInTime = new Date(ac.clock_in_time);
  if (endTs.getTime() <= clockInTime.getTime()) return null; // nothing worked
  const start_time = wallClockInTZ(clockInTime, ac.timezone);
  const end_time = wallClockInTZ(endTs, ac.timezone);
  const res = await db.query(
    `INSERT INTO time_entries
       (company_id, user_id, project_id, work_date, start_time, end_time, start_ts, end_ts, wage_type, notes,
        clock_in_lat, clock_in_lng, clock_out_lat, clock_out_lng, break_minutes, mileage, timezone,
        clock_source, clocked_in_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, NULL, 0, NULL, $13, $14, $15)
     RETURNING *`,
    [
      ac.company_id, ac.user_id, ac.project_id, ac.work_date,
      start_time, end_time, clockInTime, endTs, ac.wage_type || 'regular', ac.notes || null,
      ac.clock_in_lat, ac.clock_in_lng, ac.timezone || null,
      ac.clock_source, ac.clocked_in_by,
    ]
  );
  return res.rows[0];
}

/**
 * Reconcile ONE worker's active clock against its project's hard limit. Opens
 * its own transaction and row-locks the active clock (like /out and /switch).
 * Loops so a switch that lands on an already-exhausted overflow resolves fully
 * — each hop's clock-in strictly advances toward now, so it always terminates.
 * No-op for off/warn projects, or when the limit hasn't been reached yet.
 * Returns { actions: [{type:'switch'|'clock_out', at, from, to?, toName?, reason}] }.
 */
async function reconcileUserActiveClock(userId) {
  const client = await pool.connect();
  const actions = [];
  try {
    await client.query('BEGIN');
    let guard = 0;
    while (guard++ < 100) {
      const acRes = await client.query(
        `SELECT ac.*, p.wage_type, p.hour_limit_mode, p.daily_hour_limit, p.weekly_hour_limit,
                p.hour_limit_overflow_project_id, p.name AS project_name
           FROM active_clock ac JOIN projects p ON p.id = ac.project_id
          WHERE ac.user_id = $1 FOR UPDATE`,
        [userId]
      );
      if (acRes.rowCount === 0) break;              // not clocked in, or no project
      const ac = acRes.rows[0];
      if (ac.hour_limit_mode !== 'hard') break;     // off/warn never auto-stop

      const weekStart = await loadWeekStart(client, ac.company_id);
      const prior = await loadPriorHours(client, userId, ac.project_id, ac.work_date, weekStart);
      const { limitTs, reason } = computeLimitTs({ clockInTime: new Date(ac.clock_in_time), prior, project: ac });
      if (!limitTs) break;                          // no daily/weekly cap set
      if (Date.now() < limitTs.getTime()) break;    // limit not reached yet

      // Past the limit → close the worked portion AS OF limitTs, then switch to
      // the overflow (if it has capacity) or clock out.
      const target = await pickOverflowTarget(client, {
        userId, overflowProjectId: ac.hour_limit_overflow_project_id, sourceProjectId: ac.project_id,
        companyId: ac.company_id, workDate: ac.work_date, weekStart, atTs: limitTs,
      });
      await closeEntryAsOf(client, ac, limitTs);

      if (target) {
        await client.query(
          `UPDATE active_clock
              SET project_id = $2, clock_in_time = $3, clock_in_lat = NULL, clock_in_lng = NULL,
                  notes = NULL, current_lat = NULL, current_lng = NULL, location_updated_at = NULL
            WHERE user_id = $1`,
          [userId, target.id, limitTs]
        );
        actions.push({ type: 'switch', at: limitTs, reason, from: ac.project_id, fromName: ac.project_name, to: target.id, toName: target.name });
        continue; // the new project may itself be immediately past its limit
      }
      await client.query('DELETE FROM active_clock WHERE user_id = $1', [userId]);
      actions.push({ type: 'clock_out', at: limitTs, reason, from: ac.project_id, fromName: ac.project_name });
      break;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { actions };
}

// Reconcile every worker in a company whose active clock is on a hard-limited
// project. Each worker gets its own transaction (reconcileUserActiveClock),
// which no-ops if they haven't reached the limit. Best-effort per worker.
async function reconcileCompanyActiveClocks(companyId) {
  const candidates = await pool.query(
    `SELECT ac.user_id
       FROM active_clock ac JOIN projects p ON p.id = ac.project_id
      WHERE ac.company_id = $1 AND p.hour_limit_mode = 'hard'
        AND (p.daily_hour_limit IS NOT NULL OR p.weekly_hour_limit IS NOT NULL)`,
    [companyId]
  );
  const results = [];
  for (const { user_id } of candidates.rows) {
    try {
      const r = await reconcileUserActiveClock(user_id);
      if (r.actions.length) results.push({ userId: user_id, ...r });
    } catch (err) {
      logger.warn({ err, userId: user_id }, 'hour-limit reconcile failed');
    }
  }
  return results;
}

// Global hourly backstop (prod cron): reconcile every worker across all
// companies whose active clock sits on a hard-limited project. The lazy
// observers (/clock/status, /admin/active-clocks) do the real-time enforcing;
// this just catches a shift nobody looked at. Returns the number of actions.
async function reconcileStaleHourLimits() {
  const candidates = await pool.query(
    `SELECT ac.user_id
       FROM active_clock ac JOIN projects p ON p.id = ac.project_id
      WHERE p.hour_limit_mode = 'hard'
        AND (p.daily_hour_limit IS NOT NULL OR p.weekly_hour_limit IS NOT NULL)`
  );
  let count = 0;
  for (const { user_id } of candidates.rows) {
    try {
      const r = await reconcileUserActiveClock(user_id);
      count += r.actions.length;
    } catch (err) {
      logger.warn({ err, userId: user_id }, 'hour-limit backstop reconcile failed');
    }
  }
  return count;
}

/**
 * Describe the active project's limit for the client (live banner / auto-refresh
 * trigger). `activeClock` is a status row already joined to its project's
 * hour_limit_* columns. Returns null when the project has no limit.
 */
async function describeActiveLimit(db, activeClock, weekStart) {
  if (!activeClock || !activeClock.project_id) return null;
  const mode = activeClock.hour_limit_mode;
  if (mode !== 'warn' && mode !== 'hard') return null;
  if (numOrNull(activeClock.daily_hour_limit) == null && numOrNull(activeClock.weekly_hour_limit) == null) return null;
  const prior = await loadPriorHours(db, activeClock.user_id, activeClock.project_id, activeClock.work_date, weekStart);
  const { limitTs, reason } = computeLimitTs({ clockInTime: new Date(activeClock.clock_in_time), prior, project: activeClock });
  return {
    mode,
    reason,
    limit_ts: limitTs ? limitTs.toISOString() : null,
    daily_hour_limit: numOrNull(activeClock.daily_hour_limit),
    weekly_hour_limit: numOrNull(activeClock.weekly_hour_limit),
    has_overflow: !!activeClock.hour_limit_overflow_project_id,
  };
}

/**
 * Validate the hour-limit fields for a project create/update. `daily`/`weekly`/
 * `overflowProjectId` should be the EFFECTIVE post-write values (body value if
 * provided, else the existing row's) so a partial update isn't wrongly rejected.
 * Returns { error } on failure, { ok: true } on success.
 */
async function validateHourLimitInput(db, { companyId, projectId, mode, daily, weekly, overflowProjectId }) {
  if (mode !== undefined && mode !== null && !HOUR_LIMIT_MODES.includes(mode)) {
    return { error: `hour_limit_mode must be one of: ${HOUR_LIMIT_MODES.join(', ')}` };
  }
  const d = numOrNull(daily);
  const w = numOrNull(weekly);
  if (d != null && d < 0) return { error: 'daily_hour_limit must be non-negative' };
  if (w != null && w < 0) return { error: 'weekly_hour_limit must be non-negative' };
  if (mode === 'warn' || mode === 'hard') {
    if (!(d != null && d > 0) && !(w != null && w > 0)) {
      return { error: 'Set a daily or weekly hour limit when the mode is warn or hard' };
    }
  }
  if (overflowProjectId != null && overflowProjectId !== '') {
    if (projectId != null && Number(overflowProjectId) === Number(projectId)) {
      return { error: 'The overflow project must be different from this project' };
    }
    const r = await db.query('SELECT active FROM projects WHERE id = $1 AND company_id = $2', [overflowProjectId, companyId]);
    if (!r.rows.length) return { error: 'Overflow project not found' };
    if (!r.rows[0].active) return { error: 'Overflow project must be active' };
  }
  return { ok: true };
}

module.exports = {
  numOrNull,
  calcH,
  validateHourLimitInput,
  loadWeekStart,
  loadPriorHours,
  computeLimitTs,
  evaluateGate,
  pickOverflowTarget,
  reconcileUserActiveClock,
  reconcileCompanyActiveClocks,
  reconcileStaleHourLimits,
  describeActiveLimit,
};
