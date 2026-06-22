const router = require('express').Router();
const pool = require('../db');
const logger = require('../logger');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { haversineDistanceFt } = require('../utils/geoUtils');
const { sendPushToCompanyAdmins } = require('../push');
const { createInboxItem, createInboxItemBatch } = require('./inbox');
const { applySettingsRows, SETTINGS_DEFAULTS } = require('../settingsDefaults');
const { sendEmail } = require('../email');
const { wallClockInTZ, validLocalTime, entryInstants } = require('../utils/timeFormat');
const rateLimit = require('express-rate-limit');
const { userOrIpKey } = require('../middleware/rateLimitKey');

// Per-user limiter for clock actions (keyed by user ID once authenticated)
const clockLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 60, // 60 clock-in/out actions per hour is far beyond any real usage
  keyGenerator: userOrIpKey,
  message: { error: 'Too many clock requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /api/clock/status — returns active clock-in for this user, if any
router.get('/status', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ac.*, p.name as project_name, p.wage_type
       FROM active_clock ac
       LEFT JOIN projects p ON ac.project_id = p.id
       WHERE ac.user_id = $1`,
      [req.user.id]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

const { validCoords } = require('../utils/geoUtils');
const { coerceBody } = require('../middleware/coerce');
const { logFailure } = require('../failureLog');

// POST /api/clock/in
router.post('/in', requireAuth, requirePerm('clock_self'), clockLimiter, coerceBody({ int: ['project_id'] }), async (req, res) => {
  const { project_id, lat, lng, local_work_date, timezone, location_denied, clock_in_time } = req.body;
  const notes = req.body.notes?.trim() || null;
  if (notes && notes.length > 500) {
    logFailure(req, 'clock.in', 'notes_too_long', { length: notes.length });
    return res.status(400).json({ error: 'notes too long (max 500 characters)' });
  }
  if ((lat != null || lng != null) && !validCoords(lat, lng)) {
    logFailure(req, 'clock.in', 'invalid_coords', { lat, lng });
    return res.status(400).json({ error: 'Invalid coordinates' });
  }
  const companyId = req.user.company_id;
  try {
    // Single query for both settings needed before clock-in
    const settingsRows = await pool.query(
      `SELECT key, value FROM settings WHERE company_id=$1 AND key IN ('feature_project_integration','global_required_checklist_template_id')`,
      [companyId]
    );
    const settingsMap = Object.fromEntries(settingsRows.rows.map(r => [r.key, r.value]));
    const projectsEnabled = settingsMap['feature_project_integration'] !== '0';
    const globalChecklistId = settingsMap['global_required_checklist_template_id'] ? parseInt(settingsMap['global_required_checklist_template_id']) : null;

    if (!project_id && projectsEnabled) {
      // Fall back gracefully when the company has no active projects — otherwise
      // workers are stranded with nothing to pick.
      const anyProjects = await pool.query(
        'SELECT 1 FROM projects WHERE company_id = $1 AND active = true LIMIT 1',
        [companyId]
      );
      if (anyProjects.rowCount > 0) {
        logFailure(req, 'clock.in', 'project_required_not_supplied');
        return res.status(400).json({ error: 'project_id required' });
      }
    }

    // Verify project and fetch everything needed in one query (reused below for response)
    let projName = null, projWageType = 'regular';
    if (project_id) {
      const proj = await pool.query(
        'SELECT id, name, wage_type, geo_lat, geo_lng, geo_radius_ft, required_checklist_template_id FROM projects WHERE id = $1 AND company_id = $2 AND active = true',
        [project_id, companyId]
      );
      if (proj.rowCount === 0) {
        logFailure(req, 'clock.in', 'project_not_found', { project_id });
        return res.status(400).json({ error: 'Project not found' });
      }

      const p = proj.rows[0];
      projName = p.name;
      projWageType = p.wage_type;

      // Geofence check
      if (p.geo_lat && p.geo_lng && p.geo_radius_ft) {
        if (!lat || !lng) {
          logFailure(req, 'clock.in', 'geofence_missing_location', { project_id });
          return res.status(403).json({ error: 'This job site requires location access to clock in. Please enable GPS and try again.', geofence: true });
        }
        const distanceFt = Math.round(haversineDistanceFt(lat, lng, parseFloat(p.geo_lat), parseFloat(p.geo_lng)));
        if (distanceFt > p.geo_radius_ft) {
          logFailure(req, 'clock.in', 'geofence_too_far', { project_id, distance_ft: distanceFt, radius_ft: p.geo_radius_ft });
          return res.status(403).json({
            error: `You are ${distanceFt.toLocaleString()} ft from the job site. Must be within ${p.geo_radius_ft.toLocaleString()} ft to clock in.`,
            geofence: true,
            distance_ft: distanceFt,
            radius_ft: p.geo_radius_ft,
          });
        }
      }

      // Checklist requirement (project-level overrides global)
      const requiredChecklistId = p.required_checklist_template_id || globalChecklistId;
      if (requiredChecklistId) {
        const sub = await pool.query(
          `SELECT id FROM safety_checklist_submissions
           WHERE company_id=$1 AND template_id=$2 AND submitted_by=$3 AND check_date=CURRENT_DATE`,
          [companyId, requiredChecklistId, req.user.id]
        );
        if (sub.rowCount === 0) {
          logFailure(req, 'clock.in', 'checklist_required', { template_id: requiredChecklistId, project_id });
          return res.status(403).json({
            error: 'Complete the required safety checklist before clocking in.',
            checklist_required: true,
            template_id: requiredChecklistId,
          });
        }
      }
    } else if (globalChecklistId) {
      const sub = await pool.query(
        `SELECT id FROM safety_checklist_submissions
         WHERE company_id=$1 AND template_id=$2 AND submitted_by=$3 AND check_date=CURRENT_DATE`,
        [companyId, globalChecklistId, req.user.id]
      );
      if (sub.rowCount === 0) {
        logFailure(req, 'clock.in', 'checklist_required', { template_id: globalChecklistId });
        return res.status(403).json({
          error: 'Complete the required safety checklist before clocking in.',
          checklist_required: true,
          template_id: globalChecklistId,
        });
      }
    }

    // Use client-supplied clock_in_time (captured at button-press, before GPS wait).
    // Falls back to NOW() if not provided or unparseable.
    const parsedClockInTime = clock_in_time ? new Date(clock_in_time) : null;
    const clockInTs = parsedClockInTime && !isNaN(parsedClockInTime) ? parsedClockInTime : null;

    const result = await pool.query(
      `INSERT INTO active_clock (user_id, company_id, project_id, clock_in_time, clock_in_lat, clock_in_lng, work_date, notes, timezone, clock_source, clocked_in_by)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()), $5, $6, COALESCE($7::date, CURRENT_DATE), $8, $9, $10, $11)
       ON CONFLICT (user_id) DO UPDATE
         SET project_id = EXCLUDED.project_id,
             clock_in_time = EXCLUDED.clock_in_time,
             clock_in_lat = EXCLUDED.clock_in_lat,
             clock_in_lng = EXCLUDED.clock_in_lng,
             work_date = EXCLUDED.work_date,
             notes = EXCLUDED.notes,
             timezone = EXCLUDED.timezone,
             clock_source = EXCLUDED.clock_source,
             clocked_in_by = EXCLUDED.clocked_in_by
       RETURNING *`,
      [req.user.id, companyId, project_id, clockInTs, lat || null, lng || null, local_work_date || null, notes || null, timezone || null, 'worker', null]
    );

    const row = result.rows[0];

    // Respond immediately — all notifications are fire-and-forget
    res.status(201).json({ ...row, project_name: projName, wage_type: projWageType });

    // Post-response notifications (never delay the worker)
    setImmediate(async () => {
      try {
        if (location_denied) {
          const workerName = req.user.full_name || req.user.username;
          const title = `Location denied: ${workerName}`;
          const body = `${workerName} clocked in but their browser blocked location access. Their location was not recorded.`;
          await sendPushToCompanyAdmins(companyId, { title, body, url: '/workforce#live' });
          const adminRows = await pool.query(
            `SELECT id FROM users WHERE company_id = $1 AND role IN ('admin','super_admin') AND active = true`,
            [companyId]
          );
          createInboxItemBatch(adminRows.rows.map(a => a.id), companyId, 'location_denied', title, body, '/workforce#live');
        }

        // Outside-hours notification
        const allSettings = await pool.query('SELECT key, value FROM settings WHERE company_id = $1', [companyId]);
        const s = { notification_start_hour: 6, notification_end_hour: 20, notification_use_work_hours: true, company_timezone: '' };
        allSettings.rows.forEach(r => {
          if (r.key === 'notification_use_work_hours') s[r.key] = r.value === '1';
          else if (r.key === 'company_timezone') s[r.key] = r.value;
          else s[r.key] = parseFloat(r.value);
        });
        const tz = timezone || s.company_timezone || 'UTC';
        const nowHour = parseInt(new Date().toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false })) % 24;
        if (s.notification_use_work_hours && (nowHour < s.notification_start_hour || nowHour >= s.notification_end_hour)) {
          const adminResult = await pool.query(
            `SELECT u.email, u.full_name FROM users u
             WHERE u.company_id = $1 AND u.role = 'admin' AND u.active = true AND u.email IS NOT NULL
             LIMIT 1`, [companyId]
          );
          if (adminResult.rowCount > 0) {
            const admin = adminResult.rows[0];
            const timeStr = new Date().toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
            await sendEmail(
              admin.email,
              `Unusual clock-in: ${req.user.full_name}`,
              `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">
                <h3 style="color:#d97706">Unusual clock-in detected</h3>
                <p><strong>${req.user.full_name}</strong> clocked in at <strong>${timeStr}</strong> on project <strong>${projName}</strong>.</p>
                <p style="color:#888;font-size:13px">This is outside your configured work hours (${s.notification_start_hour}:00–${s.notification_end_hour}:00).</p>
              </div>`
            );
          }
        }
      } catch {} // never throw from background work
    });

  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/clock/switch — close the current project and start the next one in one request
router.post('/switch', requireAuth, requirePerm('clock_self'), clockLimiter, coerceBody({ int: ['project_id'], float: ['break_minutes', 'mileage'] }), async (req, res) => {
  const { project_id, lat, lng, break_minutes, mileage, local_clock_in, local_clock_out, local_work_date, timezone, clock_in_time } = req.body;
  if (!project_id) {
    logFailure(req, 'clock.switch', 'project_required_not_supplied');
    return res.status(400).json({ error: 'project_id required' });
  }
  if ((lat != null || lng != null) && !validCoords(lat, lng)) {
    logFailure(req, 'clock.switch', 'invalid_coords', { lat, lng });
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  const companyId = req.user.company_id;
  try {
    const settingsRows = await pool.query(
      `SELECT key, value FROM settings
       WHERE company_id=$1 AND key IN ('feature_project_integration','global_required_checklist_template_id')`,
      [companyId]
    );
    const settingsMap = Object.fromEntries(settingsRows.rows.map(r => [r.key, r.value]));
    const projectsEnabled = settingsMap['feature_project_integration'] !== '0';
    const globalChecklistId = settingsMap['global_required_checklist_template_id'] ? parseInt(settingsMap['global_required_checklist_template_id']) : null;
    if (!projectsEnabled) {
      logFailure(req, 'clock.switch', 'projects_disabled');
      return res.status(400).json({ error: 'Projects are not enabled for this company' });
    }

    const targetResult = await pool.query(
      'SELECT id, name, wage_type, geo_lat, geo_lng, geo_radius_ft, required_checklist_template_id FROM projects WHERE id = $1 AND company_id = $2 AND active = true',
      [project_id, companyId]
    );
    if (targetResult.rowCount === 0) {
      logFailure(req, 'clock.switch', 'project_not_found', { project_id });
      return res.status(400).json({ error: 'Project not found' });
    }

    const target = targetResult.rows[0];
    if (target.geo_lat && target.geo_lng && target.geo_radius_ft) {
      if (!lat || !lng) {
        logFailure(req, 'clock.switch', 'geofence_missing_location', { project_id });
        return res.status(403).json({ error: 'This job site requires location access to switch projects. Please enable GPS and try again.', geofence: true });
      }
      const distanceFt = Math.round(haversineDistanceFt(lat, lng, parseFloat(target.geo_lat), parseFloat(target.geo_lng)));
      if (distanceFt > target.geo_radius_ft) {
        logFailure(req, 'clock.switch', 'geofence_too_far', { project_id, distance_ft: distanceFt, radius_ft: target.geo_radius_ft });
        return res.status(403).json({
          error: `You are ${distanceFt.toLocaleString()} ft from the job site. Must be within ${target.geo_radius_ft.toLocaleString()} ft to switch projects.`,
          geofence: true,
          distance_ft: distanceFt,
          radius_ft: target.geo_radius_ft,
        });
      }
    }

    const requiredChecklistId = target.required_checklist_template_id || globalChecklistId;
    if (requiredChecklistId) {
      const sub = await pool.query(
        `SELECT id FROM safety_checklist_submissions
         WHERE company_id=$1 AND template_id=$2 AND submitted_by=$3 AND check_date=CURRENT_DATE`,
        [companyId, requiredChecklistId, req.user.id]
      );
      if (sub.rowCount === 0) {
        logFailure(req, 'clock.switch', 'checklist_required', { template_id: requiredChecklistId, project_id });
        return res.status(403).json({
          error: 'Complete the required safety checklist before switching projects.',
          checklist_required: true,
          template_id: requiredChecklistId,
        });
      }
    }

    const switchInTs = (() => {
      const parsed = clock_in_time ? new Date(clock_in_time) : null;
      return parsed && !isNaN(parsed) ? parsed : new Date();
    })();
    const clockOutTime = new Date();
    // Wall-clock strings are computed after oldClock is loaded inside the
    // transaction below so we can use its timezone for the fallback.

    const txClient = await pool.connect();
    let oldClock;
    let oldProjectName = null;
    let oldWageType = 'regular';
    let entryResult;
    let activeResult;
    try {
      await txClient.query('BEGIN');
      const clockResult = await txClient.query(
        'SELECT user_id, company_id, project_id, clock_in_time, clock_in_lat, clock_in_lng, work_date, notes, timezone, clock_source, clocked_in_by FROM active_clock WHERE user_id = $1 FOR UPDATE',
        [req.user.id]
      );
      if (clockResult.rowCount === 0) {
        await txClient.query('ROLLBACK');
        logFailure(req, 'clock.switch', 'not_clocked_in');
        return res.status(400).json({ error: 'Not clocked in' });
      }

      oldClock = clockResult.rows[0];
      if (String(oldClock.project_id || '') === String(project_id)) {
        await txClient.query('ROLLBACK');
        logFailure(req, 'clock.switch', 'same_project', { project_id });
        return res.status(400).json({ error: 'You are already clocked into that project' });
      }

      if (oldClock.project_id) {
        const oldProjectResult = await txClient.query('SELECT wage_type, name FROM projects WHERE id = $1', [oldClock.project_id]);
        if (oldProjectResult.rowCount === 0) {
          await txClient.query('ROLLBACK');
          logFailure(req, 'clock.switch', 'current_project_not_found', { project_id: oldClock.project_id });
          return res.status(400).json({ error: 'Current project not found' });
        }
        oldWageType = oldProjectResult.rows[0].wage_type;
        oldProjectName = oldProjectResult.rows[0].name;
      }

      const clockInTime = new Date(oldClock.clock_in_time);
      // Wall-clock fallback uses the worker's stored timezone instead of
      // server UTC. start_ts/end_ts are real instants written below, so
      // the legacy time columns just need to display correctly.
      const start_time = validLocalTime(local_clock_in)  || wallClockInTZ(clockInTime,  oldClock.timezone);
      const end_time   = validLocalTime(local_clock_out) || wallClockInTZ(clockOutTime, oldClock.timezone);

      entryResult = await txClient.query(
        `INSERT INTO time_entries
           (company_id, user_id, project_id, work_date, start_time, end_time, start_ts, end_ts, wage_type, notes,
            clock_in_lat, clock_in_lng, clock_out_lat, clock_out_lng, break_minutes, mileage, timezone,
            clock_source, clocked_in_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         RETURNING *`,
        [
          companyId, req.user.id, oldClock.project_id, oldClock.work_date,
          start_time, end_time, clockInTime, clockOutTime, oldWageType, oldClock.notes || null,
          oldClock.clock_in_lat, oldClock.clock_in_lng, lat || null, lng || null,
          parseInt(break_minutes) || 0, mileage != null ? parseFloat(mileage) : null,
          oldClock.timezone || null,
          oldClock.clock_source, oldClock.clocked_in_by,
        ]
      );

      activeResult = await txClient.query(
        `UPDATE active_clock
         SET project_id = $2,
             clock_in_time = $3,
             clock_in_lat = $4,
             clock_in_lng = $5,
             work_date = COALESCE($6::date, CURRENT_DATE),
             notes = NULL,
             timezone = $7,
             clock_source = 'worker',
             clocked_in_by = NULL,
             current_lat = NULL,
             current_lng = NULL,
             location_updated_at = NULL
         WHERE user_id = $1
         RETURNING *`,
        [req.user.id, project_id, switchInTs, lat || null, lng || null, local_work_date || null, timezone || oldClock.timezone || null]
      );
      await txClient.query('COMMIT');
    } catch (err) {
      await txClient.query('ROLLBACK');
      throw err;
    } finally {
      txClient.release();
    }

    const closedEntry = entryResult.rows[0];
    const activeClock = activeResult.rows[0];
    res.status(201).json({
      ...activeClock,
      project_name: target.name,
      wage_type: target.wage_type,
      closed_entry: { ...closedEntry, project_name: oldProjectName },
    });

    setImmediate(async () => {
      try {
        const allSettings = await pool.query('SELECT key, value FROM settings WHERE company_id = $1', [companyId]);
        const s = applySettingsRows(allSettings.rows, SETTINGS_DEFAULTS);
        if (!s.feature_overtime || !s.feature_overtime_alerts) return;

        const workDate = oldClock.work_date;
        const threshold = parseFloat(s.overtime_threshold) || 8;
        const rule = s.overtime_rule || 'daily';
        const calcH = (start, end, brk = 0) => {
          const startDate = new Date(`1970-01-01T${start}`);
          const endDate = new Date(`1970-01-01T${end}`);
          let hours = (endDate - startDate) / 3600000;
          if (hours < 0) hours += 24;
          return Math.max(0, hours - (brk || 0) / 60);
        };

        let prevHours = 0;
        let totalHours = 0;
        if (rule === 'weekly') {
          const weekRows = await pool.query(
            `SELECT start_time, end_time, break_minutes FROM time_entries
             WHERE user_id = $1 AND wage_type = 'regular'
               AND DATE_TRUNC('week', work_date::date) = DATE_TRUNC('week', $2::date)`,
            [req.user.id, workDate]
          );
          const newEntryHours = calcH(closedEntry.start_time, closedEntry.end_time, closedEntry.break_minutes);
          totalHours = weekRows.rows.reduce((sum, r) => sum + calcH(r.start_time, r.end_time, r.break_minutes), 0);
          prevHours = totalHours - newEntryHours;
          const weeklyThreshold = threshold <= 10 ? 40 : threshold;
          if (prevHours < weeklyThreshold && totalHours >= weeklyThreshold && oldWageType === 'regular') {
            await _sendOvertimeAlert(req.user, companyId, oldProjectName, totalHours, weeklyThreshold, 'weekly', s);
          }
        } else {
          const dayRows = await pool.query(
            `SELECT start_time, end_time, break_minutes FROM time_entries
             WHERE user_id = $1 AND work_date = $2 AND wage_type = 'regular'`,
            [req.user.id, workDate]
          );
          const newEntryHours = calcH(closedEntry.start_time, closedEntry.end_time, closedEntry.break_minutes);
          totalHours = dayRows.rows.reduce((sum, r) => sum + calcH(r.start_time, r.end_time, r.break_minutes), 0);
          prevHours = totalHours - newEntryHours;
          if (prevHours < threshold && totalHours >= threshold && oldWageType === 'regular') {
            await _sendOvertimeAlert(req.user, companyId, oldProjectName, totalHours, threshold, 'daily', s);
          }
        }
      } catch (alertErr) {
        logger.warn({ err: alertErr }, 'switch overtime alert error');
      }
    });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/clock/out
router.post('/out', requireAuth, requirePerm('clock_self'), clockLimiter, coerceBody({ float: ['break_minutes', 'mileage'] }), async (req, res) => {
  const { lat, lng, break_minutes, mileage, local_clock_in, local_clock_out } = req.body;
  if ((lat != null || lng != null) && !validCoords(lat, lng)) {
    logFailure(req, 'clock.out', 'invalid_coords', { lat, lng });
    return res.status(400).json({ error: 'Invalid coordinates' });
  }
  const companyId = req.user.company_id;
  try {
    const clockResult = await pool.query(
      'SELECT user_id, company_id, project_id, clock_in_time, clock_in_lat, clock_in_lng, work_date, notes, timezone, clock_source, clocked_in_by FROM active_clock WHERE user_id = $1',
      [req.user.id]
    );
    if (clockResult.rowCount === 0) {
      logFailure(req, 'clock.out', 'not_clocked_in');
      return res.status(400).json({ error: 'Not clocked in' });
    }
    const clock = clockResult.rows[0];

    // Clock-out must never strand a worker because projects were disabled,
    // archived, or otherwise no longer resolve. Preserve the project when it
    // still exists and projects are enabled; otherwise close the shift without it.
    let wage_type = 'regular';
    let project_name = null;
    let entryProjectId = clock.project_id;
    if (clock.project_id) {
      const featureResult = await pool.query(
        `SELECT value FROM settings
         WHERE company_id = $1 AND key = 'feature_project_integration'`,
        [companyId]
      );
      const projectsEnabled = featureResult.rowCount === 0 || featureResult.rows[0].value !== '0';
      if (projectsEnabled) {
        const projResult = await pool.query(
          'SELECT wage_type, name FROM projects WHERE id = $1 AND company_id = $2',
          [clock.project_id, companyId]
        );
        if (projResult.rowCount > 0) {
          ({ wage_type, name: project_name } = projResult.rows[0]);
        } else {
          entryProjectId = null;
          logger.warn({ project_id: clock.project_id, user_id: req.user.id }, 'clock out ignoring stale project');
        }
      } else {
        entryProjectId = null;
      }
    }

    // Use client-supplied local times if available — the modern client
    // always sends them, but old PWA caches may not. The fallback used
    // to be `getUTCHours()` etc., which stamped wall-clock times in UTC
    // and silently mis-recorded shifts for any worker not in UTC. Now
    // we use wallClockInTZ() against the worker's stored timezone (set
    // on clock-in into active_clock.timezone). Phase-2 start_ts / end_ts
    // are computed below from clockInTime/clockOutTime directly, so they
    // remain correct regardless of the wall-clock fallback path.
    const clockInTime = new Date(clock.clock_in_time);
    const clockOutTime = new Date();
    const start_time = validLocalTime(local_clock_in) || wallClockInTZ(clockInTime, clock.timezone);
    const end_time   = validLocalTime(local_clock_out) || wallClockInTZ(clockOutTime, clock.timezone);

    // Create the time entry and remove active clock atomically
    const txClient = await pool.connect();
    let entryResult;
    try {
      await txClient.query('BEGIN');
      // Phase 2 dual-write: clockInTime / clockOutTime are already real UTC
      // instants, so we can write them straight to start_ts / end_ts without
      // round-tripping through wall-clock + TZ.
      entryResult = await txClient.query(
        `INSERT INTO time_entries
           (company_id, user_id, project_id, work_date, start_time, end_time, start_ts, end_ts, wage_type, notes,
            clock_in_lat, clock_in_lng, clock_out_lat, clock_out_lng, break_minutes, mileage, timezone,
            clock_source, clocked_in_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         RETURNING *`,
        [
          companyId, req.user.id, entryProjectId, clock.work_date,
          start_time, end_time, clockInTime, clockOutTime, wage_type, clock.notes || null,
          clock.clock_in_lat, clock.clock_in_lng, lat || null, lng || null,
          parseInt(break_minutes) || 0, mileage != null ? parseFloat(mileage) : null,
          clock.timezone || null,
          clock.clock_source, clock.clocked_in_by,
        ]
      );
      await txClient.query('DELETE FROM active_clock WHERE user_id = $1', [req.user.id]);
      await txClient.query('COMMIT');
    } catch (err) {
      await txClient.query('ROLLBACK');
      throw err;
    } finally { txClient.release(); }

    const clockOutEntry = entryResult.rows[0];
    res.json({ ...clockOutEntry, project_name });

    setImmediate(async () => {
      // Overtime alert — fire-and-forget, never block the response
      try {
        const settingsRows = await pool.query(
          'SELECT key, value FROM settings WHERE company_id = $1', [companyId]
        );
        const s = applySettingsRows(settingsRows.rows, SETTINGS_DEFAULTS);

        if (s.feature_overtime && s.feature_overtime_alerts) {
          const workDate = clock.work_date;
          const threshold = parseFloat(s.overtime_threshold) || 8;
          const rule = s.overtime_rule || 'daily';

          // Get all entries for this worker on the relevant period (before this new entry)
          let prevHours = 0;
          let totalHours = 0;

          if (rule === 'weekly') {
            // Sum this ISO week (Mon–Sun). Include break_minutes so
            // entries with logged breaks don't inflate the weekly total
            // and trigger spurious OT alerts for workers who haven't
            // actually crossed the 40h paid-hours line.
            const allWeekRows = await pool.query(
              `SELECT start_time, end_time, break_minutes FROM time_entries
               WHERE user_id = $1 AND wage_type = 'regular'
                 AND DATE_TRUNC('week', work_date::date) = DATE_TRUNC('week', $2::date)`,
              [req.user.id, workDate]
            );
            const allEntries = allWeekRows.rows;
            const newEntry = entryResult.rows[0];
            const calcH = (s, e, brk) => {
              const start = new Date(`1970-01-01T${s}`);
              const end = new Date(`1970-01-01T${e}`);
              let h = (end - start) / 3600000;
              if (h < 0) h += 24;
              return Math.max(0, h - (brk || 0) / 60);
            };
            const newEntryHours = calcH(newEntry.start_time, newEntry.end_time, newEntry.break_minutes);
            totalHours = allEntries.reduce((sum, r) => sum + calcH(r.start_time, r.end_time, r.break_minutes), 0);
            prevHours = totalHours - newEntryHours;
            // Weekly threshold is typically 40
            const weeklyThreshold = threshold <= 10 ? 40 : threshold;
            if (prevHours < weeklyThreshold && totalHours >= weeklyThreshold && wage_type === 'regular') {
              await _sendOvertimeAlert(req.user, companyId, project_name, totalHours, weeklyThreshold, 'weekly', s);
            }
          } else {
            // Daily rule — check today's total
            const dayRows = await pool.query(
              `SELECT start_time, end_time, break_minutes FROM time_entries
               WHERE user_id = $1 AND work_date = $2 AND wage_type = 'regular'`,
              [req.user.id, workDate]
            );
            const calcH = (s, e, brk) => {
              const start = new Date(`1970-01-01T${s}`);
              const end = new Date(`1970-01-01T${e}`);
              let h = (end - start) / 3600000;
              if (h < 0) h += 24;
              return Math.max(0, h - (brk || 0) / 60);
            };
            const newEntry = entryResult.rows[0];
            const newEntryHours = calcH(newEntry.start_time, newEntry.end_time, newEntry.break_minutes);
            totalHours = dayRows.rows.reduce((sum, r) => sum + calcH(r.start_time, r.end_time, r.break_minutes), 0);
            prevHours = totalHours - newEntryHours;
            if (prevHours < threshold && totalHours >= threshold && wage_type === 'regular') {
              await _sendOvertimeAlert(req.user, companyId, project_name, totalHours, threshold, 'daily', s);
            }
          }
        }
      } catch (alertErr) {
        logger.warn({ err: alertErr }, 'overtime alert error');
      }
    });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

async function _sendOvertimeAlert(worker, companyId, projectName, totalHours, threshold, rule, settings) {
  const workerName = worker.full_name || worker.username;
  const extra = (totalHours - threshold).toFixed(1);
  const title = `Overtime: ${workerName}`;
  const body = `${workerName} has worked ${totalHours.toFixed(1)}h today${projectName ? ` on ${projectName}` : ''} — ${extra}h over the ${threshold}h ${rule} threshold`;

  await sendPushToCompanyAdmins(companyId, { title, body, url: '/workforce#reports' });

  const adminRows = await pool.query(
    `SELECT id FROM users WHERE company_id = $1 AND role IN ('admin','super_admin') AND active = true`,
    [companyId]
  );
  createInboxItemBatch(adminRows.rows.map(a => a.id), companyId, 'overtime_alert', title, body, '/workforce#reports');
}

// DELETE /api/clock/cancel — discard an active clock-in without creating a time entry
router.delete('/cancel', requireAuth, requirePerm('clock_self'), clockLimiter, async (req, res) => {
  try {
    // Scope to the caller's company too — defensive against future
    // user-id reuse / merge scenarios. user_id alone is unique today.
    const result = await pool.query(
      'DELETE FROM active_clock WHERE user_id = $1 AND company_id = $2 RETURNING id',
      [req.user.id, req.user.company_id]
    );
    if (result.rowCount === 0) return res.status(400).json({ error: 'Not clocked in' });
    res.json({ cancelled: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/clock/location — update current GPS position while clocked in
router.post('/location', requireAuth, async (req, res) => {
  const { lat, lng } = req.body;
  if (!validCoords(lat, lng)) return res.status(400).json({ error: 'Invalid coordinates' });
  try {
    const result = await pool.query(
      `UPDATE active_clock
       SET current_lat = $1, current_lng = $2, location_updated_at = NOW()
       WHERE user_id = $3
       RETURNING id`,
      [lat, lng, req.user.id]
    );
    if (result.rowCount === 0) return res.status(400).json({ error: 'Not clocked in' });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/clock/mark-day — daily-rate workers with day_mark_mode=true
// record a single "I worked today" entry instead of clocking in/out.
// Creates a finished time entry (start=end=now, wage_type=regular, status=pending)
// for today, with same dedup semantics as any other time entry.
// Gated on clock_self since it's the equivalent operation for day-mark workers.
router.post('/mark-day', requireAuth, requirePerm('clock_self'), clockLimiter, async (req, res) => {
  const { local_work_date, local_time, timezone } = req.body || {};
  try {
    const userResult = await pool.query(
      'SELECT rate_type, day_mark_mode FROM users WHERE id = $1',
      [req.user.id]
    );
    if (userResult.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    const { rate_type, day_mark_mode } = userResult.rows[0];
    if (rate_type !== 'daily' || !day_mark_mode) {
      return res.status(400).json({
        error: 'Mark Day is only available to daily-rate workers in day-mark mode',
        code: 'not_day_mark_worker',
      });
    }

    // Today's date — use client-supplied local date if provided, else server date.
    const workDate = local_work_date || new Date().toISOString().substring(0, 10);

    // Dedup: one marked day per work_date per worker.
    const existing = await pool.query(
      'SELECT id FROM time_entries WHERE user_id = $1 AND work_date = $2',
      [req.user.id, workDate]
    );
    if (existing.rowCount > 0) {
      return res.status(409).json({
        error: 'Already marked for today',
        code: 'already_marked',
        entry_id: existing.rows[0].id,
      });
    }

    // Start = end = the worker's current local time (HH:MM:SS). Use the
    // client-supplied value if valid; otherwise fall back to the worker's
    // timezone-aware now() rather than the server's UTC.
    const timeStr = validLocalTime(local_time) || wallClockInTZ(new Date(), timezone);
    // Phase 2 dual-write: derive the matching UTC instant from the wall-clock
    // we just resolved + the worker's TZ. start_ts === end_ts since mark-day
    // is a zero-duration entry.
    const ts = entryInstants(workDate, timeStr, timeStr, timezone).start_ts;

    const result = await pool.query(
      `INSERT INTO time_entries
         (company_id, user_id, project_id, work_date, start_time, end_time, start_ts, end_ts,
          wage_type, status, timezone, clock_source, clocked_in_by)
       VALUES ($1, $2, NULL, $3, $4, $4, $5, $5, 'regular', 'pending', $6, 'worker', NULL)
       RETURNING *`,
      [req.user.company_id, req.user.id, workDate, timeStr, ts, timezone || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/clock/today-marked — has today already been recorded for this
// worker? Used by the client to decide whether to show the Mark Day button
// or the "already marked" state.
router.get('/today-marked', requireAuth, async (req, res) => {
  try {
    const { local_work_date } = req.query;
    const workDate = local_work_date || new Date().toISOString().substring(0, 10);
    const r = await pool.query(
      'SELECT id, status, start_time FROM time_entries WHERE user_id = $1 AND work_date = $2 LIMIT 1',
      [req.user.id, workDate]
    );
    res.json({
      marked: r.rowCount > 0,
      entry: r.rows[0] || null,
    });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
