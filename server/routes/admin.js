const router = require('express').Router();
const bcrypt = require('bcryptjs');
const logger = require('../logger');
const { csvCell } = require('../utils/csv');
const { escapeHtml } = require('../utils/htmlEscape');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { userOrIpKey } = require('../middleware/rateLimitKey');
const { entryInstants, validLocalDate, wallClockInTZ } = require('../utils/timeFormat');
const { PROJECT_STATUSES } = require('../constants/projectEnums');
const { clearSuppression } = require('../services/emailSuppression');
const pool = require('../db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(email) { return EMAIL_RE.test(String(email).trim()); }
const { requireAdmin, requirePlan, requireCertifiedPayrollAddon, requirePerm } = require('../middleware/auth');
const { PERMISSIONS, PERMISSION_KEYS, BUILTIN_ROLES, getUserPermissions } = require('../permissions');
const { coerceBody } = require('../middleware/coerce');
const { logFailure } = require('../failureLog');
const { sendPushToUser, sendPushToAllWorkers } = require('../push');
const { sendEmail } = require('../email');
const { hoursWorked, computeOT, annotateEntryOvertime, computeDailyPayCosts, otBandsCost, nightPremiumCost } = require('../utils/payCalculations');
const { roundEntriesFromSettings, otConfigFromSettings, otConfigByRoleFactory, validatePolicyRaw, migrateFixedSlots, hasFixedSlots } = require('../utils/hoursRules');
const { computePaid, computeWorkerLeave, computeCompanyLeave, leaveRateMultipliers } = require('../utils/paidHours');
const { parseCompanyDeductions, normalizeWorkerDeductions, payStubTotals } = require('../utils/deductions');
const { DEDUCTION_KINDS } = require('../constants/deductionEnums');
const { weekRange, weekBucketKey } = require('../utils/weekBounds');
const { createInboxItem, createInboxItemBatch } = require('./inbox');
const qbo = require('../services/qbo');

// Legacy { to, subject, html } send shape → central sendEmail(); re-throw on
// provider failure so the invite try/catch still sets email_sent correctly.
const sgMail = {
  send: async ({ to, subject, html }) => {
    const r = await sendEmail(to, subject, html);
    if (r && r.ok === false) throw new Error('email send failed');
    return r;
  },
};

// Worker limits per plan (null = unlimited). Trial always gets unlimited.
const WORKER_LIMITS = { free: 3, starter: 10, business: null };
const ENTRY_HAS_ENDED_SQL = `end_ts IS NOT NULL AND end_ts <= NOW()`;

async function checkWorkerLimit(companyId) {
  const company = await pool.query(
    'SELECT plan, subscription_status, trial_ends_at, bonus_seats FROM companies WHERE id = $1', [companyId]
  );
  const { plan, subscription_status, trial_ends_at, bonus_seats } = company.rows[0] || {};
  const trialActive = subscription_status === 'trial' && (!trial_ends_at || new Date(trial_ends_at) >= new Date());
  if (trialActive) return null; // active trial = unlimited
  const base = WORKER_LIMITS[plan || 'free'];
  if (base === null) return null; // business = unlimited
  // Complimentary seats a super_admin granted this company sit on top of the
  // plan cap and are not billed (see superadmin PATCH bonus_seats).
  const limit = base + (parseInt(bonus_seats, 10) || 0);
  const count = await pool.query(
    `SELECT COUNT(*) FROM users WHERE company_id = $1 AND role = 'worker' AND active = true`,
    [companyId]
  );
  const current = parseInt(count.rows[0].count, 10);
  return current >= limit ? { limit, current, plan: plan || 'free' } : null;
}

const { logAudit } = require('../auditLog');

const { FEATURE_KEYS, ADMIN_SETTINGS_DEFAULTS, applySettingsRows } = require('../settingsDefaults');

async function getSettings(companyId) {
  const result = await pool.query('SELECT key, value FROM settings WHERE company_id = $1', [companyId]);
  return applySettingsRows(result.rows, ADMIN_SETTINGS_DEFAULTS);
}


// GET /admin/kpis — live summary cards for the Live tab
router.get('/kpis', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const settings = await getSettings(companyId);
    const weekStartDateStr = weekRange(settings.week_start, 0).from; // ISO start-of-current-week
    const [pending, clockedIn, weekHours, openWorkOrders] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM time_entries WHERE company_id = $1 AND status = 'pending'`, [companyId]),
      pool.query(`SELECT COUNT(*) FROM active_clock WHERE company_id = $1`, [companyId]),
      pool.query(
        `SELECT COALESCE(SUM(
           EXTRACT(EPOCH FROM (
             CASE WHEN end_time < start_time
               THEN (end_time + INTERVAL '1 day') - start_time
               ELSE end_time - start_time
             END
           )) / 3600 - (break_minutes::float / 60)
         ), 0) as hours
         FROM time_entries
         WHERE company_id = $1
           AND work_date >= $2::date
           AND work_date <= CURRENT_DATE
           AND status != 'rejected'`,
        [companyId, weekStartDateStr]
      ),
      pool.query(`SELECT COUNT(*) FROM work_orders WHERE company_id = $1 AND active = true AND status NOT IN ('completed','canceled')`, [companyId]),
    ]);

    // Workers who've exceeded the OT threshold this week
    const { overtime_rule, overtime_threshold } = settings;
    let otWorkers = 0;
    if (overtime_rule === 'weekly') {
      const r = await pool.query(
        `SELECT COUNT(*) FROM (
           SELECT user_id, SUM(
             EXTRACT(EPOCH FROM (
               CASE WHEN end_time < start_time THEN (end_time + INTERVAL '1 day') - start_time ELSE end_time - start_time END
             )) / 3600 - (break_minutes::float / 60)
           ) as total_hours
           FROM time_entries
           WHERE company_id = $1 AND work_date >= $3::date
             AND wage_type = 'regular' AND status != 'rejected'
           GROUP BY user_id
           HAVING SUM(
             EXTRACT(EPOCH FROM (
               CASE WHEN end_time < start_time THEN (end_time + INTERVAL '1 day') - start_time ELSE end_time - start_time END
             )) / 3600 - (break_minutes::float / 60)
           ) > $2
         ) sub`,
        [companyId, overtime_threshold, weekStartDateStr]
      );
      otWorkers = parseInt(r.rows[0].count);
    } else {
      // daily: any worker with a single day > threshold this week
      const r = await pool.query(
        `SELECT COUNT(DISTINCT user_id) FROM (
           SELECT user_id, work_date, SUM(
             EXTRACT(EPOCH FROM (
               CASE WHEN end_time < start_time THEN (end_time + INTERVAL '1 day') - start_time ELSE end_time - start_time END
             )) / 3600 - (break_minutes::float / 60)
           ) as day_hours
           FROM time_entries
           WHERE company_id = $1 AND work_date >= $3::date
             AND wage_type = 'regular' AND status != 'rejected'
           GROUP BY user_id, work_date
           HAVING SUM(
             EXTRACT(EPOCH FROM (
               CASE WHEN end_time < start_time THEN (end_time + INTERVAL '1 day') - start_time ELSE end_time - start_time END
             )) / 3600 - (break_minutes::float / 60)
           ) > $2
         ) sub`,
        [companyId, overtime_threshold, weekStartDateStr]
      );
      otWorkers = parseInt(r.rows[0].count);
    }

    res.json({
      pending_approvals: parseInt(pending.rows[0].count),
      clocked_in_count: parseInt(clockedIn.rows[0].count),
      company_hours_this_week: +parseFloat(weekHours.rows[0].hours).toFixed(1),
      overtime_workers_this_week: otWorkers,
      open_work_orders: parseInt(openWorkOrders.rows[0].count),
    });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Get settings
router.get('/settings', requireAdmin, async (req, res) => {
  try {
    const s = await getSettings(req.user.company_id);
    // Present the hours-rules policy as custom rules: convert any legacy fixed-slot
    // config (rounding / OT bands / premiums) into the equivalent rules for the
    // builder. Display-only — the stored value (which the pay engine reads) is
    // untouched until the admin saves; the rule equivalents are proven identical
    // (hoursRulesMigrate.test.js), so nothing changes either way.
    if (s && typeof s.hours_rules === 'string' && s.hours_rules) {
      try {
        const raw = JSON.parse(s.hours_rules);
        if (hasFixedSlots(raw)) s.hours_rules = JSON.stringify(migrateFixedSlots(raw));
      } catch (_) { /* leave as-is if it doesn't parse */ }
    }
    res.json(s);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Update settings
router.patch('/settings', requireAdmin, requirePerm('manage_settings'), async (req, res) => {
  const rateKeys = ['prevailing_wage_rate', 'default_hourly_rate', 'overtime_multiplier'];
  const notifKeys = ['notification_inactive_days', 'notification_start_hour', 'notification_end_hour', 'chat_retention_days'];
  // shift_reminder_hour / pto_annual_days / cycle_count_* sat in
  // ADMIN_SETTINGS_DEFAULTS without being in this allowlist, so the UI
  // couldn't update them. Added during 2026-04-30 audit pass.
  const adminNumericKeys = ['shift_reminder_hour', 'pto_annual_days', 'cycle_count_audit_pct', 'cycle_count_reconcile_threshold'];
  const numericKeys = [...rateKeys, ...notifKeys, ...adminNumericKeys, 'overtime_threshold', 'media_retention_days', 'qbo_bill_terms_days', 'week_start', 'work_week_end', 'regular_shift_hours', 'sick_pay_pct', 'vacation_pay_pct'];
  const stringKeys = ['overtime_rule', 'currency', 'company_timezone', 'invoice_signature', 'default_temp_password', 'global_required_checklist_template_id', 'qbo_expense_account_id', 'qbo_bank_account_id', 'qbo_labor_item_id', 'setup_questionnaire_completed_at', 'label_client', 'label_worker', 'label_field', 'hours_rules', 'deductions'];
  const allowed = [...numericKeys, ...stringKeys, ...FEATURE_KEYS];
  const companyId = req.user.company_id;
  try {
    const current = await getSettings(companyId);
    const changed = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        if (FEATURE_KEYS.includes(key)) {
          const val = req.body[key] ? '1' : '0';
          await pool.query(
            'INSERT INTO settings (company_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (company_id, key) DO UPDATE SET value = $3',
            [companyId, key, val]
          );
          const newVal = val === '1';
          if (current[key] !== newVal) changed[key] = newVal;
        } else if (stringKeys.includes(key)) {
          const val = req.body[key];
          if (key === 'overtime_rule' && !['daily', 'weekly'].includes(val))
            return res.status(400).json({ error: 'overtime_rule must be daily or weekly' });
          if (key === 'currency' && !/^[A-Z]{3}$/.test(val))
            return res.status(400).json({ error: 'currency must be a valid 3-letter ISO code' });
          if (key === 'company_timezone' && val !== '' && !/^[A-Za-z_]+\/[A-Za-z_\/]+$/.test(val))
            return res.status(400).json({ error: 'Invalid timezone' });
          if (key === 'invoice_signature' && !['none', 'optional', 'required'].includes(val))
            return res.status(400).json({ error: 'invoice_signature must be none, optional, or required' });
          if (key.startsWith('label_') && (!String(val).trim() || String(val).length > 32))
            return res.status(400).json({ error: 'Labels must be 1-32 characters' });
          if (key === 'hours_rules' && val !== '') {
            // Stored as a JSON policy document; the engine (hoursRules.parsePolicy)
            // normalizes on read, so we only guard shape + size here. A too-large
            // or non-object value is rejected outright.
            // Per-role rule lists multiply the document size (one rule set per
            // role on top of the standard list), so the cap is generous but still
            // bounded to keep a runaway payload out of the settings row.
            if (String(val).length > 40000) return res.status(400).json({ error: 'hours_rules is too large' });
            let parsed;
            try { parsed = JSON.parse(val); } catch { return res.status(400).json({ error: 'hours_rules must be valid JSON' }); }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
              return res.status(400).json({ error: 'hours_rules must be a JSON object' });
            // Beyond shape: refuse a rule list that can't mean anything. An
            // Add Time rule with no End Time to measure from would fall back to
            // adding onto the punch and quietly bill the wrong number, so it is
            // rejected here rather than surprising someone on an invoice.
            const problems = validatePolicyRaw(val);
            if (problems.length) {
              return res.status(400).json({
                error: problems[0].message,
                rule_errors: problems,
              });
            }
          }
          if (key === 'global_required_checklist_template_id' && val !== '') {
            const id = parseInt(val);
            if (isNaN(id)) return res.status(400).json({ error: 'Invalid checklist template ID' });
            const tmpl = await pool.query('SELECT id FROM safety_checklist_templates WHERE id=$1 AND company_id=$2', [id, companyId]);
            if (tmpl.rowCount === 0) return res.status(400).json({ error: 'Checklist template not found' });
          }
          if (key === 'deductions' && val !== '') {
            // A JSON list of company-wide deductions; the engine (parseCompanyDeductions)
            // normalizes on read and drops anything malformed, so only shape + size
            // are guarded here.
            if (String(val).length > 20000) return res.status(400).json({ error: 'deductions is too large' });
            let parsed;
            try { parsed = JSON.parse(val); } catch { return res.status(400).json({ error: 'deductions must be valid JSON' }); }
            if (!parsed || typeof parsed !== 'object') return res.status(400).json({ error: 'deductions must be a JSON object or array' });
          }
          await pool.query(
            'INSERT INTO settings (company_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (company_id, key) DO UPDATE SET value = $3',
            [companyId, key, val]
          );
          if (current[key] !== val) changed[key] = val;
        } else {
          const val = parseFloat(req.body[key]);
          if (isNaN(val)) return res.status(400).json({ error: `Invalid value for ${key}` });
          const allowZero = ['prevailing_wage_rate', 'overtime_multiplier'];
          if (rateKeys.includes(key) && (allowZero.includes(key) ? val < 0 : val <= 0)) return res.status(400).json({ error: `Invalid value for ${key}` });
          if ([...notifKeys, 'overtime_threshold'].includes(key) && val < 0) return res.status(400).json({ error: `Invalid value for ${key}` });
          await pool.query(
            'INSERT INTO settings (company_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (company_id, key) DO UPDATE SET value = $3',
            [companyId, key, val]
          );
          if (current[key] !== val) changed[key] = val;
        }
      }
    }
    if (Object.keys(changed).length === 0) { const s = await getSettings(companyId); return res.json(s); }
    await logAudit(companyId, req.user.id, req.user.full_name, 'settings.updated', 'settings', null, 'Settings', changed);
    const s = await getSettings(companyId);
    res.json(s);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Advanced Settings ──────────────────────────────────────────────────────────

const ADVANCED_SETTING_KEYS = ['reimbursement_categories', 'item_units', 'mileage_rate', 'job_classifications', 'service_request_categories'];

// Hardcoded defaults — never stored in DB unless overridden
const ADVANCED_DEFAULTS = {
  reimbursement_categories: {
    defaults: ['Fuel', 'Tools & Equipment', 'Supplies', 'Meals', 'Travel', 'Lodging', 'Parking', 'Mileage', 'Other'],
    suppressed: [],
    custom: [],
  },
  item_units: {
    defaults: ['each', 'box', 'bag', 'bundle', 'pallet', 'lb', 'kg', 'ft', 'm', 'sq ft', 'gal', 'L', 'roll', 'sheet', 'piece', 'other'],
    suppressed: [],
    custom: [],
  },
  mileage_rate: { rate: 0.67 },
  // Job classifications used for Certified Payroll. Defaults are the common
  // Davis-Bacon / construction trades; companies can suppress defaults they
  // don't use and add custom ones (e.g. "Concrete Finisher — Journeyman").
  job_classifications: {
    defaults: [
      'Carpenter', 'Electrician', 'Plumber', 'Laborer', 'Operating Engineer',
      'Ironworker', 'Cement Mason', 'Painter', 'Roofer', 'Sheet Metal Worker',
      'Pipefitter', 'Welder', 'Drywall Installer', 'Glazier', 'Insulator',
      'Heavy Equipment Operator', 'Truck Driver', 'Foreman', 'Apprentice',
      'Journeyman', 'Helper',
    ],
    suppressed: [],
    custom: [],
  },
  // Categories shown in the public client intake form. Admins can
  // suppress defaults and add custom categories; the selected label is
  // stored verbatim in service_requests.category.
  service_request_categories: {
    defaults: [
      'New work / project inquiry',
      'Service call / repair',
      'Request a quote',
      'Other',
    ],
    suppressed: [],
    custom: [],
  },
};

async function getAdvancedSettings(companyId) {
  const result = await pool.query(
    'SELECT key, value FROM advanced_settings WHERE company_id = $1',
    [companyId]
  );
  const out = {};
  for (const key of ADVANCED_SETTING_KEYS) {
    const row = result.rows.find(r => r.key === key);
    const def = ADVANCED_DEFAULTS[key];
    out[key] = row ? { ...def, ...row.value } : { ...def };
  }
  return out;
}

router.get('/advanced-settings', requireAdmin, async (req, res) => {
  try {
    res.json(await getAdvancedSettings(req.user.company_id));
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/advanced-settings/:key', requireAdmin, requirePerm('manage_settings'), async (req, res) => {
  const { key } = req.params;
  if (!ADVANCED_SETTING_KEYS.includes(key))
    return res.status(400).json({ error: 'Unknown advanced setting key' });
  const companyId = req.user.company_id;
  try {
    const def = ADVANCED_DEFAULTS[key];
    let value = {};

    if (key === 'reimbursement_categories' || key === 'item_units' || key === 'job_classifications' || key === 'service_request_categories') {
      const suppressed = Array.isArray(req.body.suppressed)
        ? req.body.suppressed.filter(s => def.defaults.includes(s))
        : [];
      const custom = Array.isArray(req.body.custom)
        ? req.body.custom.map(s => String(s).trim()).filter(Boolean)
        : [];
      value = { suppressed, custom };
    } else if (key === 'mileage_rate') {
      const rate = parseFloat(req.body.rate);
      if (isNaN(rate) || rate < 0 || rate > 10) return res.status(400).json({ error: 'rate must be between 0 and 10' });
      value = { rate };
    }

    await pool.query(
      `INSERT INTO advanced_settings (company_id, key, value, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (company_id, key) DO UPDATE SET value = $3, updated_at = NOW()`,
      [companyId, key, JSON.stringify(value)]
    );
    res.json(await getAdvancedSettings(companyId));
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Notifications — inactive workers
router.get('/notifications', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const s = await getSettings(companyId);
    const days = s.notification_inactive_days || 3;
    const result = await pool.query(
      `SELECT u.id, u.full_name, u.email,
              MAX(te.work_date) as last_entry_date,
              (CURRENT_DATE - COALESCE(MAX(te.work_date), DATE(u.created_at)))::int AS days_inactive
       FROM users u
       LEFT JOIN time_entries te ON te.user_id = u.id AND te.company_id = $1
       WHERE u.company_id = $1 AND u.active = true AND u.role = 'worker'
         AND NOT EXISTS (SELECT 1 FROM active_clock ac WHERE ac.user_id = u.id AND ac.company_id = $1)
       GROUP BY u.id, u.full_name, u.email, u.created_at
       HAVING MAX(te.work_date) IS NULL OR MAX(te.work_date) < CURRENT_DATE - $2::integer
       ORDER BY last_entry_date ASC NULLS FIRST`,
      [companyId, days]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /admin/mark-day — admin marks a day-mark worker present for today.
// Same rules as the worker-side /clock/mark-day: must be rate_type=daily
// with day_mark_mode=true, one entry per work_date, creates a pending
// time entry with start=end=now.
router.post('/mark-day', requireAdmin, requirePerm('manage_workers'), async (req, res) => {
  const companyId = req.user.company_id;
  const { user_id, local_work_date, local_time } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  try {
    const worker = await pool.query(
      'SELECT id, full_name, rate_type, day_mark_mode, timezone FROM users WHERE id = $1 AND company_id = $2 AND active = true',
      [user_id, companyId]
    );
    if (worker.rowCount === 0) return res.status(404).json({ error: 'Worker not found' });
    const w = worker.rows[0];
    if (w.rate_type !== 'daily' || !w.day_mark_mode) {
      return res.status(400).json({
        error: 'Worker is not configured for day-mark mode',
        code: 'not_day_mark_worker',
      });
    }
    const workDate = local_work_date || new Date().toISOString().substring(0, 10);
    const existing = await pool.query(
      'SELECT id FROM time_entries WHERE user_id = $1 AND work_date = $2',
      [user_id, workDate]
    );
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: 'Already marked for today', code: 'already_marked', entry_id: existing.rows[0].id });
    }
    // Use admin's local time if supplied; server clock is UTC so the
    // fallback would mis-record. (Same caveat as /clock/mark-day.)
    const validLocalTime = typeof local_time === 'string' && /^\d{2}:\d{2}(:\d{2})?$/.test(local_time);
    let timeStr;
    if (validLocalTime) {
      timeStr = local_time.length === 5 ? `${local_time}:00` : local_time;
    } else {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }
    // Phase 2 dual-write: derive matching UTC instant from the resolved
    // wall-clock + the worker's stored timezone.
    const ts = entryInstants(workDate, timeStr, timeStr, w.timezone).start_ts;
    const result = await pool.query(
      `INSERT INTO time_entries
         (company_id, user_id, project_id, work_date, start_time, end_time, start_ts, end_ts,
          wage_type, status, timezone, clock_source, clocked_in_by)
       VALUES ($1, $2, NULL, $3, $4, $4, $5, $5, 'regular', 'pending', $6, 'admin', $7)
       RETURNING *`,
      [companyId, user_id, workDate, timeStr, ts, w.timezone || null, req.user.id]
    );
    await logAudit(companyId, req.user.id, req.user.full_name, 'worker.day_marked_by_admin', 'user', parseInt(user_id), w.full_name);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /admin/clock-in — admin clocks in a worker on their behalf
router.post('/clock-in', requireAdmin, requirePerm('manage_workers'), async (req, res) => {
  const companyId = req.user.company_id;
  const { user_id, project_id } = req.body;
  const notes = req.body.notes?.trim() || null;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  if (notes && notes.length > 500) return res.status(400).json({ error: 'notes too long (max 500 characters)' });
  try {
    // Verify worker belongs to this company
    const workerRow = await pool.query(
      'SELECT id, full_name FROM users WHERE id = $1 AND company_id = $2 AND active = true',
      [user_id, companyId]
    );
    if (workerRow.rowCount === 0) return res.status(404).json({ error: 'Worker not found' });

    const result = await pool.query(
      `INSERT INTO active_clock (user_id, company_id, project_id, clock_in_time, work_date, notes, clock_source, clocked_in_by)
       VALUES ($1, $2, $3, NOW(), CURRENT_DATE, $4, 'admin', $5)
       ON CONFLICT (user_id) DO UPDATE
         SET project_id = EXCLUDED.project_id,
             clock_in_time = EXCLUDED.clock_in_time,
             work_date = EXCLUDED.work_date,
             notes = EXCLUDED.notes,
             clock_source = EXCLUDED.clock_source,
             clocked_in_by = EXCLUDED.clocked_in_by
       RETURNING *`,
      [user_id, companyId, project_id || null, notes || null, req.user.id]
    );
    const projName = project_id
      ? await pool.query('SELECT name FROM projects WHERE id = $1', [project_id])
      : { rows: [{ name: null }] };
    await logAudit(companyId, req.user.id, req.user.full_name, 'worker.clocked_in_by_admin', 'user', parseInt(user_id), workerRow.rows[0].full_name);
    res.status(201).json({ ...result.rows[0], project_name: projName.rows[0]?.name, clocked_in_by_name: req.user.full_name });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /admin/clock-out/:user_id — admin clocks out a worker
router.post('/clock-out/:user_id', requireAdmin, requirePerm('manage_workers'), async (req, res) => {
  const companyId = req.user.company_id;
  const { break_minutes, mileage } = req.body;
  const mileageVal = mileage != null && mileage !== '' ? parseFloat(mileage) : null;
  if (mileageVal !== null && isNaN(mileageVal)) return res.status(400).json({ error: 'mileage must be a number' });
  try {
    const clockResult = await pool.query(
      `SELECT ac.*, p.wage_type, p.name AS project_name
       FROM active_clock ac
       LEFT JOIN projects p ON ac.project_id = p.id
       WHERE ac.user_id = $1 AND ac.company_id = $2`,
      [req.params.user_id, companyId]
    );
    if (clockResult.rowCount === 0) return res.status(400).json({ error: 'Worker is not clocked in' });
    const clock = clockResult.rows[0];

    const clockInTime = new Date(clock.clock_in_time);
    const clockOutTime = new Date();
    // Use the worker's stored timezone for the wall-clock fallback — the
    // server runs in UTC so a raw getUTCHours() would stamp the wrong
    // wall-clock for any worker outside that zone. start_ts / end_ts
    // below are real UTC instants and remain correct.
    const start_time = wallClockInTZ(clockInTime,  clock.timezone);
    const end_time   = wallClockInTZ(clockOutTime, clock.timezone);

    const client = await pool.connect();
    let entryResult;
    try {
      await client.query('BEGIN');
      // Phase 2 dual-write: clockInTime / clockOutTime are real UTC instants
      // — write them straight to start_ts / end_ts.
      entryResult = await client.query(
        `INSERT INTO time_entries
           (company_id, user_id, project_id, work_date, start_time, end_time, start_ts, end_ts, wage_type, notes,
            clock_in_lat, clock_in_lng, break_minutes, mileage, timezone, clock_source, clocked_in_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING *`,
        [
          companyId, clock.user_id, clock.project_id, clock.work_date,
          start_time, end_time, clockInTime, clockOutTime, clock.wage_type || 'regular', clock.notes || null,
          clock.clock_in_lat, clock.clock_in_lng,
          parseInt(break_minutes) || 0, mileageVal,
          clock.timezone || null,
          clock.clock_source, clock.clocked_in_by,
        ]
      );
      await client.query('DELETE FROM active_clock WHERE user_id = $1', [clock.user_id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }

    await logAudit(companyId, req.user.id, req.user.full_name, 'worker.clocked_out_by_admin', 'user', parseInt(req.params.user_id), null);
    res.json(entryResult.rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/active-clock/:user_id — admin edits the clock-in time of a running clock
router.patch('/active-clock/:user_id', requireAdmin, requirePerm('manage_workers'), async (req, res) => {
  const companyId = req.user.company_id;
  const { clock_in_time } = req.body;
  if (!clock_in_time) return res.status(400).json({ error: 'clock_in_time required' });
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(clock_in_time)) return res.status(400).json({ error: 'clock_in_time must be HH:MM or HH:MM:SS' });
  try {
    const result = await pool.query(
      `UPDATE active_clock SET clock_in_time = $1
       WHERE user_id = $2 AND company_id = $3
       RETURNING *`,
      [clock_in_time, req.params.user_id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Active clock not found' });
    await logAudit(companyId, req.user.id, req.user.full_name, 'worker.clock_in_time_edited', 'user', parseInt(req.params.user_id), null);
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/entries/:id/times — admin edits start/end times (kept for backwards compat)
router.patch('/entries/:id/times', requireAdmin, requirePerm('manage_workers'), async (req, res) => {
  const companyId = req.user.company_id;
  const { start_time, end_time } = req.body;
  if (!start_time || !end_time) return res.status(400).json({ error: 'start_time and end_time required' });
  try {
    const s = await getSettings(companyId);
    if (s.feature_admin_edit_time === false) {
      return res.status(403).json({ error: 'Admin time editing is disabled in Company Settings.' });
    }
    // Phase 2 dual-write: fetch the entry's work_date + timezone so we can
    // populate the new start_ts / end_ts columns alongside the legacy
    // start_time / end_time.
    const cur = await pool.query(
      'SELECT work_date, timezone FROM time_entries WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (cur.rowCount === 0) return res.status(404).json({ error: 'Entry not found' });
    const workDateStr = new Date(cur.rows[0].work_date).toISOString().substring(0, 10);
    const { start_ts, end_ts } = entryInstants(workDateStr, start_time, end_time, cur.rows[0].timezone);
    const result = await pool.query(
      `UPDATE time_entries SET start_time = $1, end_time = $2, start_ts = $3, end_ts = $4
       WHERE id = $5 AND company_id = $6
       RETURNING *`,
      [start_time, end_time, start_ts, end_ts, req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Entry not found' });
    await logAudit(companyId, req.user.id, req.user.full_name, 'entry.times_edited', 'time_entry', parseInt(req.params.id), null);
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/entries/:id/edit — admin edits times + project on a pending entry
router.patch('/entries/:id/edit', requireAdmin, requirePerm('approve_entries'),
  coerceBody({ int: ['project_id'], float: ['overtime_hours_override'] }),
  async (req, res) => {
  const companyId = req.user.company_id;
  const { start_time, end_time, project_id, overtime_hours_override } = req.body;
  const clientUpdatedAt = req.body.updated_at || null;
  // work_date is optional — admins occasionally need to fix an entry that
  // landed on the wrong day (e.g. midnight clock-out got recorded as the
  // wrong calendar date). When present we move the row, recompute start_ts /
  // end_ts against the new date, and check pay-period locks for both the
  // origin and destination dates.
  const newWorkDate = req.body.work_date ? validLocalDate(req.body.work_date) : null;
  if (req.body.work_date && !newWorkDate) {
    return res.status(400).json({ error: 'work_date must be YYYY-MM-DD' });
  }
  if (!start_time || !end_time) return res.status(400).json({ error: 'start_time and end_time required' });
  if (overtime_hours_override != null && overtime_hours_override < 0) {
    return res.status(400).json({ error: 'overtime_hours_override must be non-negative' });
  }
  try {
    const s = await getSettings(companyId);
    if (s.feature_admin_edit_time === false) {
      return res.status(403).json({ error: 'Admin time editing is disabled in Company Settings.' });
    }
    // Phase 2 dual-write: always fetch the existing entry so we have the
    // work_date + timezone needed to derive start_ts / end_ts. This SELECT
    // also serves the optimistic-lock check.
    const cur = await pool.query(
      'SELECT updated_at, work_date, timezone FROM time_entries WHERE id=$1 AND company_id=$2',
      [req.params.id, companyId]
    );
    if (!cur.rows.length) return res.status(404).json({ error: 'Entry not found' });
    if (clientUpdatedAt) {
      if (new Date(cur.rows[0].updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
        return res.status(409).json({ error: 'conflict' });
      }
    }
    const oldWorkDateStr = new Date(cur.rows[0].work_date).toISOString().substring(0, 10);
    const workDateStr = newWorkDate || oldWorkDateStr;
    // If the date changed, ensure neither origin nor destination is locked.
    if (newWorkDate && newWorkDate !== oldWorkDateStr) {
      const lockCheck = await pool.query(
        `SELECT 1 FROM pay_periods
          WHERE company_id = $1
            AND (period_start <= $2::date AND period_end >= $2::date)
             OR (period_start <= $3::date AND period_end >= $3::date)
          LIMIT 1`,
        [companyId, oldWorkDateStr, newWorkDate]
      );
      if (lockCheck.rowCount > 0) {
        return res.status(403).json({ error: 'Cannot move an entry into or out of a locked pay period' });
      }
    }
    const { start_ts, end_ts } = entryInstants(workDateStr, start_time, end_time, cur.rows[0].timezone);
    // Derive wage_type from new project if provided
    let wage_type = 'regular';
    if (project_id) {
      const proj = await pool.query('SELECT wage_type FROM projects WHERE id=$1 AND company_id=$2', [project_id, companyId]);
      if (proj.rowCount === 0) return res.status(400).json({ error: 'Project not found' });
      wage_type = proj.rows[0].wage_type;
    }
    // overtime_hours_override is only meaningful when the field is explicitly
    // present on the request body. `in req.body` distinguishes "don't touch"
    // from "clear to null".
    const touchOvertimeOverride = 'overtime_hours_override' in req.body;
    const result = touchOvertimeOverride
      ? await pool.query(
          `UPDATE time_entries
              SET work_date=$1, start_time=$2, end_time=$3, start_ts=$4, end_ts=$5,
                  project_id=$6, wage_type=$7,
                  overtime_hours_override=$8, updated_at=NOW()
            WHERE id=$9 AND company_id=$10 RETURNING *`,
          [workDateStr, start_time, end_time, start_ts, end_ts, project_id || null, wage_type, overtime_hours_override, req.params.id, companyId]
        )
      : await pool.query(
          `UPDATE time_entries SET work_date=$1, start_time=$2, end_time=$3,
             start_ts=$4, end_ts=$5, project_id=$6, wage_type=$7, updated_at=NOW()
            WHERE id=$8 AND company_id=$9 RETURNING *`,
          [workDateStr, start_time, end_time, start_ts, end_ts, project_id || null, wage_type, req.params.id, companyId]
        );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Entry not found' });
    // Return with project name joined
    const full = await pool.query(
      `SELECT te.*, COALESCE(u.invoice_name, u.full_name) as worker_name, p.name as project_name
       FROM time_entries te
       JOIN users u ON te.user_id = u.id
       LEFT JOIN projects p ON te.project_id = p.id
       WHERE te.id=$1`,
      [req.params.id]
    );
    const auditDetails = (newWorkDate && newWorkDate !== oldWorkDateStr)
      ? { from_work_date: oldWorkDateStr, to_work_date: newWorkDate }
      : null;
    await logAudit(companyId, req.user.id, req.user.full_name, 'entry.edited', 'time_entry', parseInt(req.params.id), null, auditDetails);
    res.json(full.rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /admin/entries/:id/split — split a pending entry into multiple project segments
router.post('/entries/:id/split', requireAdmin, requirePerm('approve_entries'), async (req, res) => {
  const companyId = req.user.company_id;
  const { segments } = req.body; // [{ project_id, start_time, end_time }, ...]
  if (!Array.isArray(segments) || segments.length < 2) {
    return res.status(400).json({ error: 'At least 2 segments required' });
  }
  for (const seg of segments) {
    if (!seg.start_time || !seg.end_time) return res.status(400).json({ error: 'Each segment needs start_time and end_time' });
  }
  try {
    const s = await getSettings(companyId);
    if (s.feature_admin_edit_time === false) {
      return res.status(403).json({ error: 'Admin time editing is disabled in Company Settings.' });
    }
    const orig = await pool.query(
      'SELECT * FROM time_entries WHERE id=$1 AND company_id=$2',
      [req.params.id, companyId]
    );
    if (orig.rowCount === 0) return res.status(404).json({ error: 'Entry not found' });
    const o = orig.rows[0];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Delete original
      await client.query('DELETE FROM time_entries WHERE id=$1', [req.params.id]);

      // Insert new segments. Phase 2 dual-write: each segment derives its
      // own start_ts / end_ts from the original entry's work_date + tz.
      const created = [];
      const workDateStr = new Date(o.work_date).toISOString().substring(0, 10);
      for (const seg of segments) {
        let wage_type = 'regular';
        if (seg.project_id) {
          const proj = await client.query('SELECT wage_type FROM projects WHERE id=$1 AND company_id=$2', [seg.project_id, companyId]);
          if (proj.rowCount > 0) wage_type = proj.rows[0].wage_type;
        }
        const { start_ts, end_ts } = entryInstants(workDateStr, seg.start_time, seg.end_time, o.timezone);
        const r = await client.query(
          `INSERT INTO time_entries
             (company_id, user_id, project_id, work_date, start_time, end_time, start_ts, end_ts, wage_type,
              notes, break_minutes, mileage, timezone, clock_source, clocked_in_by, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending') RETURNING *`,
          [
            companyId, o.user_id, seg.project_id || null, o.work_date,
            seg.start_time, seg.end_time, start_ts, end_ts, wage_type,
            o.notes, o.break_minutes || 0, o.mileage, o.timezone || null,
            'admin', req.user.id,
          ]
        );
        created.push(r.rows[0]);
      }

      await client.query('COMMIT');
      await logAudit(companyId, req.user.id, req.user.full_name, 'entry.split', 'time_entry', parseInt(req.params.id), null);
      res.status(201).json({ created });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /admin/active-clocks — currently clocked-in workers with location
router.get('/active-clocks', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `SELECT ac.user_id, ac.clock_in_time, ac.clock_in_lat, ac.clock_in_lng,
              ac.current_lat, ac.current_lng, ac.location_updated_at,
              ac.notes, u.full_name, p.name as project_name, p.wage_type,
              ac.clock_source, ac.clocked_in_by, admin_u.full_name AS clocked_in_by_name
       FROM active_clock ac
       JOIN users u ON ac.user_id = u.id
       LEFT JOIN projects p ON ac.project_id = p.id
       LEFT JOIN users admin_u ON ac.clocked_in_by = admin_u.id
       WHERE ac.company_id = $1
       ORDER BY ac.clock_in_time ASC`,
      [companyId]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// List all active workers with summary metrics (overtime = regular hours > 8/day)
router.get('/workers', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const allRoles = req.query.all_roles === 'true';
  const roleFilter = allRoles ? `u.role IN ('worker', 'admin')` : `u.role = 'worker'`;
  const accessIds = req.user.worker_access_ids;
  try {
    const settings = await getSettings(companyId);
    const threshold = parseFloat(settings.overtime_threshold) || 8;
    const weekStart = parseInt(settings.week_start ?? 1, 10);

    // LESSON LEARNED — node-pg parameter binding (Postgres 42P18):
    // Postgres infers each parameter's type from how it's USED in the SQL.
    // Passing a param that the SQL never references fails with
    //   "could not determine data type of parameter $N"
    // The earlier version passed `null` as $3 to keep $4 = weekStart at a
    // fixed position, but when accessFilter was empty the SQL never touched
    // $3 → 42P18. Fix: only push a param when we know the SQL will reference
    // it, and let the index track the true position.
    const queryParams = [companyId, threshold];
    let accessParamSql = '';
    if (accessIds && accessIds.length) {
      queryParams.push(accessIds);
      accessParamSql = `AND (u.role != 'worker' OR u.id = ANY($${queryParams.length}))`;
    }
    queryParams.push(weekStart);
    const wsIdx = queryParams.length;

    // Week-start-aware bucket: DATE - ((DOW - ws + 7) % 7) rolls any day
    // back to the start of its week. DOW is 0..6 (Sun..Sat).
    const weekBucketSql = `(work_date - ((EXTRACT(DOW FROM work_date)::int - $${wsIdx} + 7) % 7))::date`;

    const result = await pool.query(
      `WITH daily_regular AS (
        SELECT user_id, work_date,
          SUM(EXTRACT(EPOCH FROM (CASE WHEN end_time < start_time THEN end_time + INTERVAL '1 day' - start_time ELSE end_time - start_time END)) / 3600) as day_hours
        FROM time_entries
        WHERE wage_type = 'regular' AND company_id = $1
          AND work_date >= CURRENT_DATE - INTERVAL '365 days'
        GROUP BY user_id, work_date
      ),
      weekly_regular AS (
        SELECT user_id,
          ${weekBucketSql} as week_start,
          SUM(day_hours) as week_hours
        FROM daily_regular
        GROUP BY user_id, ${weekBucketSql}
      )
      SELECT u.id, u.full_name, u.invoice_name, u.username, u.role, u.role_id, u.language, u.hourly_rate, u.rate_type, u.day_mark_mode, u.overtime_rule, u.email, u.admin_permissions, u.worker_access_ids, u.worker_type, u.must_change_password, u.qbo_employee_id, u.qbo_vendor_id, u.classification, u.email_bounced_at, u.email_bounce_reason,
        COUNT(te.id) as total_entries,
        COALESCE(SUM(EXTRACT(EPOCH FROM (CASE WHEN te.end_time < te.start_time THEN te.end_time + INTERVAL '1 day' - te.start_time ELSE te.end_time - te.start_time END)) / 3600), 0) as total_hours,
        COALESCE(
          CASE WHEN u.overtime_rule = 'weekly' THEN
            (SELECT SUM(LEAST(week_hours, $2)) FROM weekly_regular wr WHERE wr.user_id = u.id)
          ELSE
            (SELECT SUM(LEAST(day_hours, $2)) FROM daily_regular dr WHERE dr.user_id = u.id)
          END
        , 0) as regular_hours,
        COALESCE(
          CASE WHEN u.overtime_rule = 'none' THEN 0
               WHEN u.overtime_rule = 'weekly' THEN
                 (SELECT SUM(GREATEST(week_hours - $2, 0)) FROM weekly_regular wr WHERE wr.user_id = u.id)
               ELSE
                 (SELECT SUM(GREATEST(day_hours - $2, 0)) FROM daily_regular dr WHERE dr.user_id = u.id)
               END
        , 0) as overtime_hours,
        COALESCE(SUM(CASE WHEN te.wage_type = 'prevailing' THEN EXTRACT(EPOCH FROM (CASE WHEN te.end_time < te.start_time THEN te.end_time + INTERVAL '1 day' - te.start_time ELSE te.end_time - te.start_time END)) / 3600 ELSE 0 END), 0) as prevailing_hours
      FROM users u
      LEFT JOIN time_entries te ON te.user_id = u.id
        AND te.work_date >= CURRENT_DATE - INTERVAL '365 days'
      WHERE ${roleFilter} AND u.active = true AND u.company_id = $1 ${accessParamSql}
      GROUP BY u.id, u.full_name, u.invoice_name, u.username, u.role, u.role_id, u.language, u.hourly_rate, u.rate_type, u.day_mark_mode, u.overtime_rule, u.email, u.admin_permissions, u.worker_access_ids, u.worker_type, u.must_change_password, u.qbo_employee_id, u.qbo_vendor_id, u.classification, u.email_bounced_at, u.email_bounce_reason
      ORDER BY u.role DESC, u.full_name
      LIMIT 500`,
      queryParams
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// List archived (removed) workers
router.get('/workers/archived', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `SELECT id, full_name, username, role, language, hourly_rate
       FROM users WHERE active = false AND company_id = $1 ORDER BY full_name LIMIT 500`,
      [companyId]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Restore an archived worker
router.patch('/workers/:id/restore', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      'UPDATE users SET active = true WHERE id = $1 AND active = false AND company_id = $2 RETURNING id, full_name, username, role, language, hourly_rate',
      [req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Archived worker not found' });
    await logAudit(companyId, req.user.id, req.user.full_name, 'worker.restored', 'worker', result.rows[0].id, result.rows[0].full_name);
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Get a worker's entries for a date range (for bill generation)
router.post('/workers/:id/entries', requireAdmin, requirePerm('manage_workers'), async (req, res) => {
  const companyId = req.user.company_id;
  const { work_date, start_time, end_time, project_id, break_minutes, mileage } = req.body;
  const notes = req.body.notes?.trim() || null;
  if (!work_date || !start_time || !end_time) {
    return res.status(400).json({ error: 'work_date, start_time, and end_time are required' });
  }
  const entryMileageVal = mileage != null && mileage !== '' ? parseFloat(mileage) : null;
  if (entryMileageVal !== null && isNaN(entryMileageVal)) return res.status(400).json({ error: 'mileage must be a number' });
  try {
    const workerRow = await pool.query(
      'SELECT id, timezone FROM users WHERE id = $1 AND company_id = $2 AND active = true',
      [req.params.id, companyId]
    );
    if (workerRow.rowCount === 0) return res.status(404).json({ error: 'Worker not found' });

    let wage_type = 'regular';
    if (project_id) {
      const proj = await pool.query('SELECT wage_type FROM projects WHERE id = $1 AND company_id = $2', [project_id, companyId]);
      if (proj.rowCount === 0) return res.status(400).json({ error: 'Project not found' });
      wage_type = proj.rows[0].wage_type;
    }

    // Phase 2 dual-write: derive instants from the wall-clock + the worker's tz.
    const { start_ts, end_ts } = entryInstants(work_date, start_time, end_time, workerRow.rows[0].timezone);
    const result = await pool.query(
      `INSERT INTO time_entries
         (company_id, user_id, project_id, work_date, start_time, end_time, start_ts, end_ts, wage_type, notes,
          break_minutes, mileage, timezone, clock_source, clocked_in_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'log_entry', $14)
       RETURNING *`,
      [
        companyId, req.params.id, project_id || null, work_date,
        start_time, end_time, start_ts, end_ts, wage_type, notes || null,
        parseInt(break_minutes) || 0, entryMileageVal,
        workerRow.rows[0].timezone || null,
        req.user.id,
      ]
    );
    await logAudit(companyId, req.user.id, req.user.full_name, 'entry.admin_added', 'time_entry', result.rows[0].id, null);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/workers/:id/entries', requireAdmin, async (req, res) => {
  const { from, to } = req.query;
  const companyId = req.user.company_id;
  try {
    const userResult = await pool.query(
      'SELECT id, full_name, invoice_name, username, email, hourly_rate, rate_type, overtime_rule, guaranteed_weekly_hours, role_id FROM users WHERE id = $1 AND role = $2 AND company_id = $3',
      [req.params.id, 'worker', companyId]
    );
    if (userResult.rowCount === 0) return res.status(404).json({ error: 'Worker not found' });

    const entriesResult = await pool.query(
      `SELECT te.*, p.name as project_name
       FROM time_entries te
       LEFT JOIN projects p ON te.project_id = p.id
       WHERE te.user_id = $1
         AND te.status = 'approved'
         AND ($2::date IS NULL OR te.work_date >= $2::date)
         AND ($3::date IS NULL OR te.work_date <= $3::date)
       ORDER BY te.work_date ASC, te.start_time ASC`,
      [req.params.id, from || null, to || null]
    );

    let entries = entriesResult.rows;

    const reimbResult = await pool.query(
      `SELECT r.id, r.amount, r.description, r.category, r.expense_date, r.project_id, p.name AS project_name
       FROM reimbursements r
       LEFT JOIN projects p ON p.id = r.project_id
       WHERE r.user_id = $1 AND r.company_id = $2 AND r.status = 'approved'
         AND ($3::date IS NULL OR r.expense_date >= $3::date)
         AND ($4::date IS NULL OR r.expense_date <= $4::date)
       ORDER BY r.expense_date ASC`,
      [req.params.id, companyId, from || null, to || null]
    );
    const reimbursements = reimbResult.rows;
    const reimbursementTotal = reimbursements.reduce((sum, r) => sum + parseFloat(r.amount), 0);

    const settings = await getSettings(companyId);
    const worker = userResult.rows[0];
    // The Team Member Report asks for ?explain=1 to get, per entry, a trace of
    // what the pay engine did — off by default so every other caller is unchanged.
    const explain = req.query.explain === '1' || req.query.explain === 'true';
    entries = roundEntriesFromSettings(entries, settings, { workerRoleById: { [worker.id]: worker.role_id }, explain });
    const workerOTRule = worker.overtime_rule || 'daily';
    const otConfig = otConfigFromSettings(settings, worker.role_id);
    // range carries the min_daily "no clock-in" guarantee; null from/to (all-time
    // invoice) → the guard in computeOT skips it, so behaviour is unchanged.
    const { regularHours, overtimeHours, otBands } = computeOT(entries, workerOTRule, settings.overtime_threshold, settings.week_start, otConfig, { from, to });
    // Per-entry OT for the invoice's daily line-item column (sums to overtimeHours above)
    annotateEntryOvertime(entries, workerOTRule, settings.overtime_threshold, settings.week_start, otConfig);
    const prevailingHours = entries.filter(e => e.wage_type === 'prevailing').reduce((sum, e) => {
      const h = hoursWorked(e.start_time, e.end_time) - (e.break_minutes || 0) / 60;
      return sum + h;
    }, 0);
    const totalHours = regularHours + overtimeHours + prevailingHours;
    const rate = parseFloat(worker.hourly_rate) || settings.default_hourly_rate;
    let regularCost, overtimeCost;
    if (worker.rate_type === 'daily') {
      const dc = computeDailyPayCosts(entries, workerOTRule, settings.overtime_threshold, rate, settings.overtime_multiplier, otConfig);
      regularCost = dc.regularCost;
      overtimeCost = dc.overtimeCost;
    } else {
      regularCost = regularHours * rate;
      overtimeCost = otBandsCost(otBands, rate, settings.overtime_multiplier)
        + nightPremiumCost(entries, otConfig && otConfig.nightDifferential, rate);
    }
    const prevailingCost = prevailingHours * settings.prevailing_wage_rate;
    const { shortfall: guaranteeShortfall, minHours: guaranteeMinHours, weeks: guaranteeWeeks } =
      computeGuaranteeShortfall(totalHours, worker.guaranteed_weekly_hours, from, to);
    const guaranteeCost = guaranteeShortfall * rate;
    // Paid sick + vacation: approved time-off valued schedule-first (shift hours →
    // weekday leave rule → Regular Shift default), each its own line. Sick and
    // vacation pay at their configured percent of base (default 100%).
    const { sick: sickHours, vacation: vacationHours, detail: leaveDetail } =
      await computeWorkerLeave({ companyId, userId: req.params.id, roleId: worker.role_id, settings, from, to, withDetail: explain });
    const leaveMult = leaveRateMultipliers(settings);
    const roundedSickCost = Math.round(sickHours * rate * leaveMult.sick * 100) / 100;
    const roundedVacationCost = Math.round(vacationHours * rate * leaveMult.vacation * 100) / 100;
    // Round each cost component to cents so displayed line items always sum to the total
    const roundedRegularCost = Math.round(regularCost * 100) / 100;
    const roundedOvertimeCost = Math.round(overtimeCost * 100) / 100;
    const roundedPrevailingCost = Math.round(prevailingCost * 100) / 100;
    const roundedGuaranteeCost = Math.round(guaranteeCost * 100) / 100;
    const roundedReimbTotal = Math.round(reimbursementTotal * 100) / 100;
    const totalCost = roundedRegularCost + roundedOvertimeCost + roundedPrevailingCost + roundedGuaranteeCost + roundedSickCost + roundedVacationCost;

    // Pay-stub deductions: the company-wide list (settings) plus this worker's own
    // rows, applied to gross wages. Empty config → no deduction lines and net_pay
    // equals the gross Total Due, so the stub is unchanged for companies that
    // never configure deductions.
    const workerDedRows = await pool.query(
      'SELECT id, name, kind, value, cap_amount, active FROM worker_deductions WHERE user_id = $1 AND company_id = $2 AND active = true ORDER BY id',
      [req.params.id, companyId]
    );
    const dedList = parseCompanyDeductions(settings.deductions).concat(normalizeWorkerDeductions(workerDedRows.rows));
    const stub = payStubTotals(totalCost, roundedReimbTotal, dedList);

    // Explain view: attach per-entry overtime + wage-type notes to each entry's
    // trace, and a settings-used block (employee + base values the line-item math
    // read). Rule ids in the trace resolve against the policy the client already
    // has (settings.hours_rules). Off by default → no cost, no shape change.
    let settingsUsed = null;
    if (explain) {
      for (const e of entries) {
        const ex = e.explain || (e.explain = []);
        if (e.wage_type === 'prevailing') ex.push({ code: 'wage_type', wageType: 'prevailing' });
        if ((e.overtime_hours || 0) > 0) ex.push({ code: 'overtime', otHours: e.overtime_hours, threshold: settings.overtime_threshold, rule: workerOTRule });
      }
      settingsUsed = {
        rate, rate_type: worker.rate_type || 'hourly', overtime_rule: workerOTRule,
        overtime_threshold: settings.overtime_threshold, overtime_multiplier: settings.overtime_multiplier,
        week_start: settings.week_start, role_id: worker.role_id,
        prevailing_wage_rate: settings.prevailing_wage_rate, regular_shift_hours: settings.regular_shift_hours,
        sick_pay_pct: settings.sick_pay_pct, vacation_pay_pct: settings.vacation_pay_pct,
        guaranteed_weekly_hours: worker.guaranteed_weekly_hours,
      };
    }

    res.json({
      worker,
      entries,
      reimbursements,
      ...(explain ? { settings_used: settingsUsed, leave_detail: leaveDetail } : {}),
      summary: {
        total_hours: totalHours, regular_hours: regularHours, overtime_hours: overtimeHours, prevailing_hours: prevailingHours,
        rate, regular_cost: roundedRegularCost, overtime_cost: roundedOvertimeCost, prevailing_cost: roundedPrevailingCost,
        guarantee_shortfall_hours: guaranteeShortfall, guarantee_min_hours: guaranteeMinHours,
        guarantee_weeks: guaranteeWeeks, guarantee_cost: roundedGuaranteeCost,
        sick_hours: sickHours, sick_cost: roundedSickCost, sick_rate: Math.round(rate * leaveMult.sick * 100) / 100,
        vacation_hours: vacationHours, vacation_cost: roundedVacationCost, vacation_rate: Math.round(rate * leaveMult.vacation * 100) / 100,
        reimbursement_total: roundedReimbTotal,
        total_cost: totalCost + roundedReimbTotal,
        // Deductions → net pay (gross wages − deductions + reimbursements).
        gross_wages: stub.gross_wages, deductions: stub.deductions,
        deductions_total: stub.deductions_total, net_pay: stub.net_pay,
        overtime_multiplier: settings.overtime_multiplier, prevailing_wage_rate: settings.prevailing_wage_rate,
      },
      period: { from: from || null, to: to || null },
    });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /admin/workers/:id/deductions — this worker's OWN deduction lines (on top
// of the company-wide list). Returns the full rows so the editor can round-trip.
router.get('/workers/:id/deductions', requireAdmin, requirePerm('manage_workers'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const ok = await pool.query('SELECT 1 FROM users WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    if (ok.rowCount === 0) return res.status(404).json({ error: 'Worker not found' });
    const { rows } = await pool.query(
      'SELECT id, name, kind, value, cap_amount, note, active FROM worker_deductions WHERE user_id = $1 AND company_id = $2 ORDER BY id',
      [req.params.id, companyId]
    );
    res.json({ deductions: rows });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /admin/workers/:id/deductions — replace this worker's whole deduction set.
// Body: { deductions: [{ name, kind, value, cap_amount?, note? }] }. Validated
// against DEDUCTION_KINDS; unknown-kind / negative / unnamed rows are dropped.
router.put('/workers/:id/deductions', requireAdmin, requirePerm('manage_workers'), async (req, res) => {
  const companyId = req.user.company_id;
  const userId = req.params.id;
  const incoming = Array.isArray(req.body.deductions) ? req.body.deductions : [];
  try {
    const ok = await pool.query('SELECT 1 FROM users WHERE id = $1 AND company_id = $2', [userId, companyId]);
    if (ok.rowCount === 0) return res.status(404).json({ error: 'Worker not found' });

    const rows = [];
    for (const d of incoming) {
      if (!d || !DEDUCTION_KINDS.includes(d.kind)) continue;
      const name = String(d.name == null ? '' : d.name).trim().slice(0, 120);
      const value = parseFloat(d.value);
      if (!name || !Number.isFinite(value) || value < 0) continue;
      const capNum = parseFloat(d.cap_amount);
      const cap = d.kind === 'percent' && Number.isFinite(capNum) && capNum > 0 ? capNum : null;
      rows.push({ name, kind: d.kind, value, cap, note: typeof d.note === 'string' ? d.note.slice(0, 500) : null });
    }
    if (rows.length > 50) return res.status(400).json({ error: 'Too many deductions (max 50)' });

    // Replace the full set atomically so a failure can't leave the worker with a
    // half-applied deduction list.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM worker_deductions WHERE user_id = $1 AND company_id = $2', [userId, companyId]);
      for (const r of rows) {
        await client.query(
          `INSERT INTO worker_deductions (user_id, company_id, name, kind, value, cap_amount, note, active, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, NOW())`,
          [userId, companyId, r.name, r.kind, r.value, r.cap, r.note]
        );
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    const fresh = await pool.query(
      'SELECT id, name, kind, value, cap_amount, note, active FROM worker_deductions WHERE user_id = $1 AND company_id = $2 ORDER BY id',
      [userId, companyId]
    );
    res.json({ deductions: fresh.rows });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /admin/workers/check-username — check if a username is already taken
router.get('/workers/check-username', requireAdmin, async (req, res) => {
  const { username, exclude_id } = req.query;
  if (!username) return res.json({ taken: false });
  try {
    const companyId = req.user.company_id;
    const result = exclude_id
      ? await pool.query('SELECT id FROM users WHERE username = $1 AND company_id = $2 AND id != $3', [username.toLowerCase().trim(), companyId, exclude_id])
      : await pool.query('SELECT id FROM users WHERE username = $1 AND company_id = $2', [username.toLowerCase().trim(), companyId]);
    res.json({ taken: result.rowCount > 0 });
  } catch (err) {
    res.json({ taken: false });
  }
});

// Invite a worker by email
const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  keyGenerator: userOrIpKey,
  standardHeaders: true,
  legacyHeaders: false,
});
router.post('/workers/invite', requireAdmin, requirePerm('manage_workers'), inviteLimiter, async (req, res) => {
  const full_name = req.body.full_name?.trim();
  const firstName = req.body.first_name?.trim() || null;
  const lastName = req.body.last_name?.trim() || null;
  const email = req.body.email?.trim();
  const { role, language, hourly_rate } = req.body;
  if (!full_name || !email) return res.status(400).json({ error: 'full_name and email required' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email address' });
  if (full_name.length > 100) return res.status(400).json({ error: 'Full name must be 100 characters or fewer' });
  if (firstName && firstName.length > 100) return res.status(400).json({ error: 'First name must be 100 characters or fewer' });
  if (lastName && lastName.length > 100) return res.status(400).json({ error: 'Last name must be 100 characters or fewer' });
  const companyId = req.user.company_id;
  const VALID_LANGUAGES = ['English', 'Spanish'];
  const VALID_OT_RULES = ['daily', 'weekly', 'none'];
  const VALID_WORKER_TYPES = ['employee', 'contractor', 'subcontractor', 'owner'];
  const assignedRole = role === 'admin' ? 'admin' : 'worker';
  const assignedLanguage = VALID_LANGUAGES.includes(language) ? language : 'English';
  const assignedRateType = ['hourly', 'daily'].includes(req.body.rate_type) ? req.body.rate_type : 'hourly';
  const assignedOTRule = VALID_OT_RULES.includes(req.body.overtime_rule) ? req.body.overtime_rule : 'daily';
  const assignedWorkerType = VALID_WORKER_TYPES.includes(req.body.worker_type) ? req.body.worker_type : 'employee';
  const assignedClassification = req.body.classification?.trim() || null;
  if (assignedClassification && assignedClassification.length > 100) {
    return res.status(400).json({ error: 'classification must be 100 characters or fewer' });
  }
  const rateVal = parseFloat(hourly_rate);
  if (hourly_rate !== undefined && (isNaN(rateVal) || rateVal < 0)) {
    return res.status(400).json({ error: 'hourly_rate must be a non-negative number' });
  }
  const assignedRate = (!isNaN(rateVal) && rateVal >= 0) ? rateVal : 30;

  // Enforce worker count limit (admins don't count against the limit)
  if (assignedRole === 'worker') {
    const overLimit = await checkWorkerLimit(companyId);
    if (overLimit) {
      const planName = overLimit.plan.charAt(0).toUpperCase() + overLimit.plan.slice(1);
      return res.status(403).json({
        error: `Worker limit reached. Your ${planName} plan allows up to ${overLimit.limit} workers (you have ${overLimit.current}). Upgrade to add more.`,
        code: 'worker_limit_reached',
        limit: overLimit.limit,
        current: overLimit.current,
      });
    }
  }

  // Auto-generate username from name
  const parts = full_name.toLowerCase().split(/\s+/);
  const base = parts.length > 1 ? parts[0][0] + parts[parts.length - 1] : parts[0];
  const baseUsername = base.replace(/[^a-z0-9]/g, '');
  let username = baseUsername;
  let suffix = 2;
  while (true) {
    const exists = await pool.query('SELECT id FROM users WHERE username = $1 AND company_id = $2', [username, companyId]);
    if (exists.rowCount === 0) break;
    username = baseUsername + suffix++;
  }

  // Phase B: optional role_id at invite time. Same escalation guard as POST.
  let resolvedRoleId = null;
  let resolvedLegacyRole = assignedRole;
  if (req.body.role_id != null) {
    const roleLookup = await pool.query(
      `SELECT r.id, r.parent_role,
              ARRAY(SELECT permission FROM role_permissions WHERE role_id = r.id) AS perms
         FROM roles r WHERE r.id = $1 AND r.company_id = $2`,
      [parseInt(req.body.role_id), companyId]
    );
    if (roleLookup.rowCount === 0) return res.status(404).json({ error: 'Role not found' });
    const reqPerms = await getUserPermissions(req.user);
    for (const p of roleLookup.rows[0].perms) {
      if (!reqPerms.has(p)) return res.status(403).json({ error: `Cannot assign a role granting "${p}" — you don't have it yourself`, code: 'permission_escalation', required: p });
    }
    resolvedRoleId = roleLookup.rows[0].id;
    resolvedLegacyRole = roleLookup.rows[0].parent_role;
  } else {
    const defaultName = assignedRole === 'admin' ? 'Admin' : 'Worker';
    const def = await pool.query('SELECT id FROM roles WHERE company_id = $1 AND is_builtin = true AND name = $2', [companyId, defaultName]);
    if (def.rowCount > 0) resolvedRoleId = def.rows[0].id;
  }

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  try {
    const result = await pool.query(
      `INSERT INTO users (
         company_id, username, password_hash, full_name, first_name, last_name,
         role, role_id, language, hourly_rate, rate_type, overtime_rule,
         worker_type, classification, email, invite_token, invite_token_expires, invite_pending
       )
       VALUES ($1, $2, '', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, true)
       RETURNING id, username, full_name, first_name, last_name, role, role_id,
                 language, hourly_rate, rate_type, overtime_rule, worker_type,
                 classification, email`,
      [
        companyId, username, full_name, firstName, lastName,
        resolvedLegacyRole, resolvedRoleId, assignedLanguage, assignedRate,
        assignedRateType, assignedOTRule, assignedWorkerType,
        assignedClassification, email, tokenHash, expires,
      ]
    );
    await logAudit(companyId, req.user.id, req.user.full_name, 'worker.invited', 'worker', result.rows[0].id, full_name, {
      email,
      role_id: resolvedRoleId,
      worker_type: assignedWorkerType,
      classification: assignedClassification,
    });
    const inviteUrl = `${process.env.APP_URL}/accept-invite?token=${token}`;
    let emailSent = true;
    try {
      await sgMail.send({
        to: email,
        subject: `You've been invited to OpsFloA`,
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
            <h2 style="color:#1a56db;margin-bottom:8px">You're invited!</h2>
            <p style="color:#444;margin-bottom:8px">Hi ${full_name}, ${req.user.full_name} has invited you to join OpsFloA.</p>
            <p style="color:#444;margin-bottom:24px">Your username is: <strong>${username}</strong></p>
            <a href="${inviteUrl}" style="display:inline-block;background:#1a56db;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">Set your password</a>
            <p style="color:#999;font-size:13px;margin-top:24px">This invite expires in 7 days.</p>
          </div>
        `,
      });
    } catch (emailErr) {
      logger.error({ err: emailErr?.response?.body || emailErr }, 'Invite email failed');
      emailSent = false;
    }
    res.status(201).json({ ...result.rows[0], email_sent: emailSent });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Send invite email to an existing worker who hasn't signed in yet
router.post('/workers/:id/send-invite', requireAdmin, requirePerm('manage_workers'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      'SELECT id, full_name, username, email, must_change_password FROM users WHERE id = $1 AND company_id = $2 AND active = true',
      [req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Worker not found' });
    const worker = result.rows[0];
    if (!worker.email) return res.status(400).json({ error: 'Worker has no email address' });
    if (!worker.must_change_password) return res.status(400).json({ error: 'Worker has already signed in' });

    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    await pool.query(
      'UPDATE users SET invite_token = $1, invite_token_expires = $2, invite_pending = true WHERE id = $3',
      [token, expires, worker.id]
    );
    const inviteUrl = `${process.env.APP_URL}/accept-invite?token=${token}`;
    let emailSent = true;
    try {
      await sgMail.send({
        to: worker.email,
        subject: `You've been invited to OpsFloA`,
        html: `
          <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
            <h2 style="color:#1a56db;margin-bottom:8px">You're invited!</h2>
            <p style="color:#444;margin-bottom:8px">Hi ${worker.full_name}, ${req.user.full_name} has invited you to join OpsFloA.</p>
            <p style="color:#444;margin-bottom:24px">Your username is: <strong>${worker.username}</strong></p>
            <a href="${inviteUrl}" style="display:inline-block;background:#1a56db;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">Set your password</a>
            <p style="color:#999;font-size:13px;margin-top:24px">This invite expires in 7 days.</p>
          </div>
        `,
      });
    } catch (emailErr) {
      logger.error({ err: emailErr?.response?.body || emailErr }, 'Send invite email failed');
      emailSent = false;
    }
    res.json({ email_sent: emailSent });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Create a worker or admin
router.post('/workers', requireAdmin, requirePerm('manage_workers'),
  coerceBody({ float: ['hourly_rate'], int: ['role_id'] }),
  async (req, res) => {
  const { password, role, role_id } = req.body;
  const username = req.body.username?.trim();
  const full_name = req.body.full_name?.trim();
  const first_name = req.body.first_name?.trim() || null;
  const middle_name = req.body.middle_name?.trim() || null;
  const last_name = req.body.last_name?.trim() || null;
  if (!username || !password || !full_name) {
    return res.status(400).json({ error: 'username, password, and full_name required' });
  }
  const companyId = req.user.company_id;
  const VALID_LANGUAGES = ['English', 'Spanish'];
  const assignedRole = role === 'admin' ? 'admin' : 'worker';
  const assignedLanguage = VALID_LANGUAGES.includes(req.body.language) ? req.body.language : 'English';
  const rateVal = parseFloat(req.body.hourly_rate);
  if (req.body.hourly_rate !== undefined && (isNaN(rateVal) || rateVal < 0)) {
    return res.status(400).json({ error: 'hourly_rate must be a non-negative number' });
  }
  const assignedRate = (!isNaN(rateVal) && rateVal >= 0) ? rateVal : 30;
  const rawEmail = req.body.email?.trim() || null;
  if (rawEmail && !isValidEmail(rawEmail)) return res.status(400).json({ error: 'Invalid email address' });
  const assignedEmail = rawEmail;
  const VALID_OT_RULES = ['daily', 'weekly', 'none'];
  const assignedRateType = ['hourly', 'daily'].includes(req.body.rate_type) ? req.body.rate_type : 'hourly';
  const assignedOTRule = VALID_OT_RULES.includes(req.body.overtime_rule) ? req.body.overtime_rule : 'daily';
  const VALID_WORKER_TYPES = ['employee', 'contractor', 'subcontractor', 'owner'];
  const assignedWorkerType = VALID_WORKER_TYPES.includes(req.body.worker_type) ? req.body.worker_type : 'employee';

  // Enforce worker count limit (admins don't count against the limit)
  if (assignedRole === 'worker') {
    const overLimit = await checkWorkerLimit(companyId);
    if (overLimit) {
      const planName = overLimit.plan.charAt(0).toUpperCase() + overLimit.plan.slice(1);
      return res.status(403).json({
        error: `Worker limit reached. Your ${planName} plan allows up to ${overLimit.limit} workers (you have ${overLimit.current}). Upgrade to add more.`,
        code: 'worker_limit_reached',
        limit: overLimit.limit,
        current: overLimit.current,
      });
    }
  }

  // Phase B: optional role_id assignment at creation. If supplied, validate
  // it's a real role for this company and that the requester can grant it.
  // Also rewrite assignedRole to match the role's parent_role so the legacy
  // role column stays consistent with role_id.
  let resolvedRoleId = null;
  let resolvedLegacyRole = assignedRole;
  if (role_id != null) {
    const roleLookup = await pool.query(
      `SELECT r.id, r.parent_role,
              ARRAY(SELECT permission FROM role_permissions WHERE role_id = r.id) AS perms
         FROM roles r WHERE r.id = $1 AND r.company_id = $2`,
      [role_id, companyId]
    );
    if (roleLookup.rowCount === 0) return res.status(404).json({ error: 'Role not found' });
    const reqPerms = await getUserPermissions(req.user);
    for (const p of roleLookup.rows[0].perms) {
      if (!reqPerms.has(p)) {
        return res.status(403).json({
          error: `Cannot assign a role granting "${p}" — you don't have it yourself`,
          code: 'permission_escalation',
          required: p,
        });
      }
    }
    resolvedRoleId = roleLookup.rows[0].id;
    resolvedLegacyRole = roleLookup.rows[0].parent_role;
  } else {
    // No role_id given. Default to the company's built-in Worker or Admin
    // role based on the legacy `role` field, so newly created users always
    // have a role_id (no more "stuck on legacy fallback" problem).
    const defaultName = assignedRole === 'admin' ? 'Admin' : 'Worker';
    const defaultLookup = await pool.query(
      `SELECT id FROM roles WHERE company_id = $1 AND is_builtin = true AND name = $2`,
      [companyId, defaultName]
    );
    if (defaultLookup.rowCount > 0) resolvedRoleId = defaultLookup.rows[0].id;
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (company_id, username, password_hash, full_name, first_name, middle_name, last_name, role, role_id, language, hourly_rate, rate_type, overtime_rule, email, email_confirmed, must_change_password, worker_type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true, true, $15) RETURNING id, username, full_name, first_name, middle_name, last_name, role, role_id, language, hourly_rate, rate_type, overtime_rule, email, worker_type',
      [companyId, username, hash, full_name, first_name || null, middle_name || null, last_name || null, resolvedLegacyRole, resolvedRoleId, assignedLanguage, assignedRate, assignedRateType, assignedOTRule, assignedEmail, assignedWorkerType]
    );
    await logAudit(companyId, req.user.id, req.user.full_name, 'worker.created', 'worker', result.rows[0].id, full_name, { role: resolvedLegacyRole, role_id: resolvedRoleId });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      const existing = await pool.query('SELECT id, full_name, active FROM users WHERE username = $1 AND company_id = $2', [username, companyId]);
      const u = existing.rows[0];
      if (u && !u.active) {
        return res.status(409).json({ error: `Username "${username}" belongs to a removed user (${u.full_name}). Restore them instead?`, archived_id: u.id, archived_name: u.full_name });
      }
      return res.status(409).json({ error: 'Username already exists' });
    }
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Helper: compute how many hours short of the weekly guarantee a period is
function computeGuaranteeShortfall(totalHours, guaranteedWeeklyHours, fromDate, toDate) {
  if (!guaranteedWeeklyHours || parseFloat(guaranteedWeeklyHours) <= 0) return { shortfall: 0, minHours: 0, weeks: 0 };
  let weeks = 1;
  if (fromDate && toDate) {
    const f = new Date(String(fromDate).substring(0, 10) + 'T00:00:00');
    const t = new Date(String(toDate).substring(0, 10) + 'T00:00:00');
    const days = Math.round((t - f) / (1000 * 60 * 60 * 24)) + 1;
    weeks = Math.max(1, Math.round(days / 7));
  }
  const minHours = parseFloat(guaranteedWeeklyHours) * weeks;
  const shortfall = Math.max(0, minHours - totalHours);
  return { shortfall: +shortfall.toFixed(2), minHours: +minHours.toFixed(2), weeks };
}

// Update a worker (full_name, first_name, middle_name, last_name, username, role, language, hourly_rate, rate_type, email, worker_type)
router.patch('/workers/:id', requireAdmin, requirePerm('manage_workers'),
  coerceBody({ float: ['hourly_rate', 'guaranteed_weekly_hours'] }),
  async (req, res) => {
  const { role, language, hourly_rate, rate_type, overtime_rule, worker_type, day_mark_mode } = req.body;
  const full_name = req.body.full_name?.trim();
  const first_name = req.body.first_name !== undefined ? (req.body.first_name?.trim() || null) : undefined;
  const middle_name = req.body.middle_name !== undefined ? (req.body.middle_name?.trim() || null) : undefined;
  const last_name = req.body.last_name !== undefined ? (req.body.last_name?.trim() || null) : undefined;
  const username = req.body.username?.trim();
  const email = req.body.email !== undefined ? (req.body.email?.trim() || null) : undefined;
  const hasGuarantee = 'guaranteed_weekly_hours' in req.body;
  if (!full_name && !first_name && !last_name && !username && !role && !language && hourly_rate === undefined && rate_type === undefined && overtime_rule === undefined && email === undefined && worker_type === undefined && !hasGuarantee && day_mark_mode === undefined) {
    return res.status(400).json({ error: 'At least one field required' });
  }
  if (email && !isValidEmail(email)) return res.status(400).json({ error: 'Invalid email address' });
  const VALID_LANGUAGES = ['English', 'Spanish'];
  if (language !== undefined && !VALID_LANGUAGES.includes(language)) {
    return res.status(400).json({ error: 'Invalid language' });
  }
  const companyId = req.user.company_id;
  const assignedRole = role ? (role === 'admin' ? 'admin' : 'worker') : undefined;
  const VALID_RATE_TYPES = ['hourly', 'daily'];
  const VALID_OT_RULES = ['daily', 'weekly', 'none'];
  const VALID_WORKER_TYPES = ['employee', 'contractor', 'subcontractor', 'owner'];
  try {
    if (username) {
      const clean = username.toLowerCase().trim();
      const conflict = await pool.query('SELECT id FROM users WHERE username = $1 AND id != $2', [clean, req.params.id]);
      if (conflict.rowCount > 0) return res.status(409).json({ error: 'Username already taken' });
    }
    if (rate_type !== undefined && !VALID_RATE_TYPES.includes(rate_type)) {
      return res.status(400).json({ error: 'Invalid rate_type' });
    }
    if (overtime_rule !== undefined && !VALID_OT_RULES.includes(overtime_rule)) {
      return res.status(400).json({ error: 'Invalid overtime_rule' });
    }
    if (worker_type !== undefined && !VALID_WORKER_TYPES.includes(worker_type)) {
      return res.status(400).json({ error: 'Invalid worker_type' });
    }
    const fields = [];
    const values = [];
    let idx = 1;
    if (full_name) { fields.push(`full_name = $${idx++}`); values.push(full_name); }
    if (first_name !== undefined) { fields.push(`first_name = $${idx++}`); values.push(first_name || null); }
    if (middle_name !== undefined) { fields.push(`middle_name = $${idx++}`); values.push(middle_name || null); }
    if (last_name !== undefined) { fields.push(`last_name = $${idx++}`); values.push(last_name || null); }
    if (username) { fields.push(`username = $${idx++}`); values.push(username.toLowerCase().trim()); }
    if (assignedRole !== undefined) {
      fields.push(`role = $${idx++}`); values.push(assignedRole);
      // A role change alters the authorization claims baked into the user's
      // JWT — bump token_version so the stale token is rejected next request.
      fields.push(`token_version = COALESCE(token_version, 0) + 1`);
    }
    if (language) { fields.push(`language = $${idx++}`); values.push(language); }
    if (hourly_rate !== undefined) {
      const rv = parseFloat(hourly_rate);
      if (isNaN(rv) || rv < 0) return res.status(400).json({ error: 'hourly_rate must be a non-negative number' });
      fields.push(`hourly_rate = $${idx++}`); values.push(rv);
    }
    if (rate_type !== undefined) { fields.push(`rate_type = $${idx++}`); values.push(rate_type); }
    if (day_mark_mode !== undefined) { fields.push(`day_mark_mode = $${idx++}`); values.push(!!day_mark_mode); }
    if (overtime_rule !== undefined) { fields.push(`overtime_rule = $${idx++}`); values.push(overtime_rule); }
    if (email !== undefined) {
      // Correcting a typo'd address is the obvious fix for a bounce, and it
      // used not to work: the suppression flag stayed on the row, so the NEW
      // address was skipped too and the worker still got nothing.
      //
      // Only clear on an actual change — this PATCH carries the whole form, so
      // `email !== undefined` fires on every worker edit, and clearing
      // unconditionally would lift every suppression the moment anyone touched
      // a rate. Postgres evaluates all SET expressions against the pre-update
      // row, so bare `email` below is the OLD address despite being assigned in
      // the same statement.
      const p = idx++;
      values.push(email || null);
      fields.push(`email = $${p}`);
      fields.push(`email_bounced_at    = CASE WHEN LOWER(email) IS DISTINCT FROM LOWER($${p}) THEN NULL ELSE email_bounced_at    END`);
      fields.push(`email_bounce_reason = CASE WHEN LOWER(email) IS DISTINCT FROM LOWER($${p}) THEN NULL ELSE email_bounce_reason END`);
    }
    if (worker_type !== undefined) { fields.push(`worker_type = $${idx++}`); values.push(worker_type); }
    if (req.body.classification !== undefined) {
      const cls = req.body.classification?.trim() || null;
      if (cls && cls.length > 100) return res.status(400).json({ error: 'classification must be 100 characters or fewer' });
      fields.push(`classification = $${idx++}`); values.push(cls);
    }
    if (req.body.invoice_name !== undefined) {
      const inv = req.body.invoice_name?.trim() || null;
      if (inv && inv.length > 100) return res.status(400).json({ error: 'invoice_name must be 100 characters or fewer' });
      fields.push(`invoice_name = $${idx++}`); values.push(inv);
    }
    if (hasGuarantee) {
      const gv = req.body.guaranteed_weekly_hours;
      if (gv === null || gv === '' || gv === undefined) {
        fields.push(`guaranteed_weekly_hours = $${idx++}`); values.push(null);
      } else {
        const gn = parseFloat(gv);
        if (isNaN(gn) || gn < 0) return res.status(400).json({ error: 'guaranteed_weekly_hours must be a non-negative number' });
        fields.push(`guaranteed_weekly_hours = $${idx++}`); values.push(gn);
      }
    }
    const workerClientUpdatedAt = req.body.updated_at || null;
    if (workerClientUpdatedAt) {
      const cur = await pool.query('SELECT updated_at FROM users WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
      if (!cur.rows.length) return res.status(404).json({ error: 'Worker not found' });
      if (new Date(cur.rows[0].updated_at).getTime() !== new Date(workerClientUpdatedAt).getTime()) {
        return res.status(409).json({ error: 'conflict' });
      }
    }
    fields.push(`updated_at = NOW()`);
    values.push(req.params.id);
    values.push(companyId);
    const result = await pool.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING id, username, full_name, invoice_name, role, language, hourly_rate, rate_type, day_mark_mode, overtime_rule, email, worker_type, classification, guaranteed_weekly_hours, email_bounced_at, email_bounce_reason, updated_at`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Worker not found' });
    await logAudit(companyId, req.user.id, req.user.full_name, 'worker.updated', 'worker', result.rows[0].id, result.rows[0].full_name);
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Lift an email suppression without changing the address.
//
// Needed because a suppression is otherwise a one-way door: the flag stops all
// mail to that worker — invites and password resets included — and nothing in
// the app ever cleared it. A mailbox that was full, or a spam-flag the worker
// has since sorted out with their IT, left them permanently unreachable with no
// way back. Use when the address is right and the problem is fixed; if the
// address itself is wrong, just correct it (PATCH clears the flag on a change).
router.post('/workers/:id/clear-email-bounce', requireAdmin, requirePerm('manage_workers'), async (req, res) => {
  try {
    const cleared = await clearSuppression(req.params.id, req.user.company_id);
    if (!cleared) {
      // Either no such worker in this company, or they weren't suppressed.
      // Both are "nothing to do" from the caller's point of view.
      return res.status(404).json({ error: 'Worker not found or not suppressed' });
    }
    await logAudit(req.user.company_id, req.user.id, req.user.full_name, 'worker.email_bounce_cleared', 'worker', cleared.id, cleared.email);
    res.json({ ok: true, id: cleared.id, email: cleared.email });
  } catch (err) {
    logger.error({ err }, 'failed to clear email bounce');
    res.status(500).json({ error: 'Server error' });
  }
});

// Update admin permissions for another admin (full-access admins only)
router.patch('/workers/:id/permissions', requireAdmin, requirePerm('manage_roles'), async (req, res) => {
  // Only admins with null admin_permissions (full access) may manage others' permissions
  if (req.user.admin_permissions != null) {
    return res.status(403).json({ error: 'Only full-access admins can manage permissions' });
  }
  if (String(req.params.id) === String(req.user.id)) {
    return res.status(400).json({ error: 'You cannot change your own permissions' });
  }
  const VALID_KEYS = ['approve_entries', 'manage_workers', 'manage_projects', 'view_reports', 'manage_settings'];
  const { admin_permissions } = req.body;
  let perms = null;
  if (admin_permissions !== null && admin_permissions !== undefined) {
    perms = {};
    for (const key of VALID_KEYS) perms[key] = admin_permissions[key] === true;
  }
  try {
    const result = await pool.query(
      `UPDATE users SET admin_permissions = $1, token_version = COALESCE(token_version, 0) + 1
       WHERE id = $2 AND company_id = $3 AND role = 'admin' RETURNING id, full_name, admin_permissions`,
      [perms ? JSON.stringify(perms) : null, req.params.id, req.user.company_id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Admin not found' });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/workers/:id/worker-access — set which workers a partial admin can access (full-access admins only)
router.patch('/workers/:id/worker-access', requireAdmin, requirePerm('manage_roles'), async (req, res) => {
  if (req.user.admin_permissions != null) {
    return res.status(403).json({ error: 'Only full-access admins can manage worker access' });
  }
  if (String(req.params.id) === String(req.user.id)) {
    return res.status(400).json({ error: 'You cannot change your own worker access' });
  }
  const { worker_access_ids } = req.body;
  let ids = null;
  if (Array.isArray(worker_access_ids) && worker_access_ids.length > 0) {
    ids = worker_access_ids.map(Number).filter(n => !isNaN(n));
  }
  try {
    const result = await pool.query(
      `UPDATE users SET worker_access_ids = $1, token_version = COALESCE(token_version, 0) + 1 WHERE id = $2 AND company_id = $3 AND role = 'admin' RETURNING id, full_name, worker_access_ids`,
      [ids, req.params.id, req.user.company_id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Admin not found' });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Remove (soft-delete) a worker
router.delete('/workers/:id', requireAdmin, requirePerm('manage_workers'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const worker = await pool.query('SELECT full_name FROM users WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    // Bump token_version so any live JWT for this user is invalidated on the
    // next request (belt-and-suspenders alongside the requireAuth active check).
    const result = await pool.query(
      `UPDATE users SET active = false, token_version = COALESCE(token_version, 0) + 1
        WHERE id = $1 AND active = true AND company_id = $2 RETURNING id`,
      [req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Worker not found' });
    await logAudit(companyId, req.user.id, req.user.full_name, 'worker.deleted', 'worker', parseInt(req.params.id), worker.rows[0]?.full_name);
    res.json({ removed: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Get a project's entries for a date range (for bill generation)
router.get('/projects/:id/entries', requireAdmin, async (req, res) => {
  const { from, to } = req.query;
  const companyId = req.user.company_id;
  try {
    const projectResult = await pool.query('SELECT * FROM projects WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    if (projectResult.rowCount === 0) return res.status(404).json({ error: 'Project not found' });

    const entriesResult = await pool.query(
      `SELECT te.*, COALESCE(u.invoice_name, u.full_name) as worker_name, u.username, u.hourly_rate, u.rate_type, u.overtime_rule, u.role_id
       FROM time_entries te
       JOIN users u ON te.user_id = u.id
       WHERE te.project_id = $1
         AND te.status = 'approved'
         AND ($2::date IS NULL OR te.work_date >= $2::date)
         AND ($3::date IS NULL OR te.work_date <= $3::date)
       ORDER BY te.work_date ASC, te.start_time ASC`,
      [req.params.id, from || null, to || null]
    );

    let entries = entriesResult.rows;
    const settings = await getSettings(companyId);
    const workerRoleById = {};
    entries.forEach(e => { workerRoleById[e.user_id] = e.role_id; });
    entries = roundEntriesFromSettings(entries, settings, { workerRoleById });

    // Per-worker OT using each worker's own rule
    const workerEntries = {};
    entries.filter(e => e.wage_type === 'regular').forEach(e => {
      if (!workerEntries[e.user_id]) workerEntries[e.user_id] = { items: [], rate: parseFloat(e.hourly_rate) || settings.default_hourly_rate, rate_type: e.rate_type, overtime_rule: e.overtime_rule || 'daily', role_id: e.role_id };
      workerEntries[e.user_id].items.push(e);
    });
    let regularHours = 0, overtimeHours = 0, regularCost = 0, overtimeCost = 0;
    const otConfigByRole = otConfigByRoleFactory(settings);
    Object.values(workerEntries).forEach(({ items, rate, rate_type, overtime_rule, role_id }) => {
      const otConfig = otConfigByRole(role_id);
      const { regularHours: reg, overtimeHours: ot, otBands } = computeOT(items, overtime_rule, settings.overtime_threshold, settings.week_start, otConfig);
      // Per-entry OT for the project bill's daily line-item column (each worker uses their own rule)
      annotateEntryOvertime(items, overtime_rule, settings.overtime_threshold, settings.week_start, otConfig);
      regularHours += reg; overtimeHours += ot;
      if (rate_type === 'daily') {
        const dc = computeDailyPayCosts(items, overtime_rule, settings.overtime_threshold, rate, settings.overtime_multiplier, otConfig);
        regularCost += dc.regularCost;
        overtimeCost += dc.overtimeCost;
      } else {
        regularCost += reg * rate;
        overtimeCost += otBandsCost(otBands, rate, settings.overtime_multiplier)
          + nightPremiumCost(items, otConfig && otConfig.nightDifferential, rate);
      }
    });

    const effectivePrevRate = parseFloat(projectResult.rows[0].prevailing_wage_rate) || settings.prevailing_wage_rate;
    let prevailingHours = 0, prevailingCost = 0;
    entries.filter(e => e.wage_type === 'prevailing').forEach(e => {
      const h = hoursWorked(e.start_time, e.end_time) - (e.break_minutes || 0) / 60;
      prevailingHours += h;
      prevailingCost += h * effectivePrevRate;
    });

    const totalHours = regularHours + overtimeHours + prevailingHours;
    const totalCost = regularCost + overtimeCost + prevailingCost;

    res.json({
      project: projectResult.rows[0],
      entries,
      summary: { total_hours: totalHours, regular_hours: regularHours, overtime_hours: overtimeHours, prevailing_hours: prevailingHours, regular_cost: regularCost, overtime_cost: overtimeCost, prevailing_cost: prevailingCost, total_cost: totalCost, overtime_multiplier: settings.overtime_multiplier, prevailing_wage_rate: effectivePrevRate },
      period: { from: from || null, to: to || null },
    });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Project metrics report (active projects only).
// Rewritten to load entries + run computeOT per project so per-entry
// overtime_hours_override is honored. The previous SQL-only path used
// GREATEST/LEAST per day-bucket, which couldn't see the override column.
router.get('/projects/metrics', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const metricsSettings = await getSettings(companyId);
    const defaultRate = metricsSettings.default_hourly_rate || 30;
    const otThreshold = metricsSettings.overtime_threshold || 8;
    const weekStart   = parseInt(metricsSettings.week_start) || 1;

    const [projectsRes, entriesRes] = await Promise.all([
      pool.query(
        `SELECT id, name, budget_hours, budget_dollars
           FROM projects
          WHERE active = true AND company_id = $1`,
        [companyId]
      ),
      pool.query(
        `SELECT te.project_id, te.user_id, te.work_date, te.start_time, te.end_time,
                te.break_minutes, te.wage_type, te.overtime_hours_override,
                COALESCE(u.hourly_rate, $2) AS rate,
                COALESCE(u.overtime_rule, 'daily') AS ot_rule,
                u.role_id AS role_id
           FROM time_entries te
           JOIN users u ON te.user_id = u.id
          WHERE te.company_id = $1 AND te.status != 'rejected'`,
        [companyId, defaultRate]
      ),
    ]);

    const metricsRoleById = {};
    entriesRes.rows.forEach(e => { metricsRoleById[e.user_id] = e.role_id; });
    const byProject = new Map();
    for (const e of roundEntriesFromSettings(entriesRes.rows, metricsSettings, { workerRoleById: metricsRoleById })) {
      if (!byProject.has(e.project_id)) byProject.set(e.project_id, []);
      byProject.get(e.project_id).push(e);
    }

    const rows = projectsRes.rows.map(p => {
      const pe = byProject.get(p.id) || [];
      // Overtime is a per-WORKER concept: the rule is the worker's
      // (users.overtime_rule) and so is the rate. This used to hardcode 'daily'
      // for the whole project and pass no tiered config, so a project staffed by
      // weekly-rule workers reported overtime none of them had actually earned.
      // Split by worker, then sum.
      let regularHours = 0, overtimeHours = 0;
      const byWorker = new Map();
      for (const e of pe) {
        if (!byWorker.has(e.user_id)) byWorker.set(e.user_id, []);
        byWorker.get(e.user_id).push(e);
      }
      for (const rows_ of byWorker.values()) {
        const r = computePaid(rows_, metricsSettings, { rule: rows_[0].ot_rule || 'daily', roleId: rows_[0].role_id ?? null });
        regularHours += r.regularHours;
        overtimeHours += r.overtimeHours;
      }
      let totalHours = 0, prevailingHours = 0, estimatedCost = 0;
      const workerIds = new Set();
      for (const e of pe) {
        const h = hoursWorked(e.start_time, e.end_time) - (e.break_minutes || 0) / 60;
        totalHours += h;
        if (e.wage_type === 'prevailing') prevailingHours += h;
        estimatedCost += h * parseFloat(e.rate);
        workerIds.add(e.user_id);
      }
      return {
        id: p.id,
        name: p.name,
        budget_hours: p.budget_hours,
        budget_dollars: p.budget_dollars,
        total_entries: pe.length,
        worker_count: workerIds.size,
        total_hours: totalHours,
        regular_hours: regularHours,
        overtime_hours: overtimeHours,
        prevailing_hours: prevailingHours,
        estimated_cost: estimatedCost,
      };
    });
    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// List active projects
router.get('/projects', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `SELECT id, company_id, name, wage_type, prevailing_wage_rate, geo_lat, geo_lng, geo_radius_ft,
              budget_hours, budget_dollars, active, created_at,
              client_name, job_number, address, start_date, end_date, description, status,
              required_checklist_template_id, progress_pct, visible_to_user_ids
       FROM projects WHERE (active = true OR $2 = true) AND company_id = $1 ORDER BY active DESC, name LIMIT 500`,
      [companyId, req.query.include_archived === 'true']
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// List archived (removed) projects
router.get('/projects/archived', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query('SELECT * FROM projects WHERE active = false AND company_id = $1 ORDER BY name LIMIT 500', [companyId]);
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Restore an archived project
router.patch('/projects/:id/restore', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      'UPDATE projects SET active = true WHERE id = $1 AND active = false AND company_id = $2 RETURNING *',
      [req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Archived project not found' });
    await logAudit(companyId, req.user.id, req.user.full_name, 'project.restored', 'project', result.rows[0].id, result.rows[0].name);
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Update project (name and/or wage_type and/or geofence)
router.patch('/projects/:id', requireAdmin, requirePerm('manage_projects'),
  coerceBody({
    int:   ['geo_radius_ft', 'required_checklist_template_id', 'progress_pct'],
    float: ['geo_lat', 'geo_lng', 'budget_hours', 'budget_dollars', 'prevailing_wage_rate'],
  }),
  async (req, res) => {
  const { wage_type, name, geo_lat, geo_lng, geo_radius_ft, clear_geofence, budget_hours, budget_dollars, prevailing_wage_rate, required_checklist_template_id,
          client_name, job_number, address, start_date, end_date, description, status, progress_pct, active } = req.body;
  const VALID_STATUSES = PROJECT_STATUSES;
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    logFailure(req, 'admin.projects.update', 'invalid_status', { status });
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }
  if (wage_type !== undefined && !['regular', 'prevailing'].includes(wage_type)) {
    logFailure(req, 'admin.projects.update', 'invalid_wage_type', { wage_type });
    return res.status(400).json({ error: 'wage_type must be regular or prevailing' });
  }
  if (name !== undefined && !name.trim()) {
    logFailure(req, 'admin.projects.update', 'empty_name');
    return res.status(400).json({ error: 'Project name cannot be empty' });
  }
  const companyId = req.user.company_id;
  try {
    const fields = [];
    const values = [];
    let idx = 1;
    if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name.trim()); }
    if (wage_type !== undefined) { fields.push(`wage_type = $${idx++}`); values.push(wage_type); }
    if (clear_geofence) {
      fields.push(`geo_lat = NULL`, `geo_lng = NULL`, `geo_radius_ft = NULL`);
    } else {
      if (geo_lat !== undefined) { fields.push(`geo_lat = $${idx++}`); values.push(parseFloat(geo_lat)); }
      if (geo_lng !== undefined) { fields.push(`geo_lng = $${idx++}`); values.push(parseFloat(geo_lng)); }
      if (geo_radius_ft !== undefined && geo_radius_ft !== null) {
        if (geo_radius_ft <= 0) {
          logFailure(req, 'admin.projects.update', 'invalid_geo_radius', { geo_radius_ft });
          return res.status(400).json({ error: 'geo_radius_ft must be a positive number' });
        }
        fields.push(`geo_radius_ft = $${idx++}`); values.push(geo_radius_ft);
      }
    }
    if (budget_hours !== undefined) {
      if (budget_hours !== null && budget_hours < 0) {
        logFailure(req, 'admin.projects.update', 'negative_budget_hours', { budget_hours });
        return res.status(400).json({ error: 'budget_hours must be non-negative' });
      }
      fields.push(`budget_hours = $${idx++}`); values.push(budget_hours);
      // Reset alert tracker so new budget gets fresh alerts
      fields.push(`budget_alert_pct = NULL`);
    }
    if (budget_dollars !== undefined) {
      if (budget_dollars !== null && budget_dollars < 0) {
        logFailure(req, 'admin.projects.update', 'negative_budget_dollars', { budget_dollars });
        return res.status(400).json({ error: 'budget_dollars must be non-negative' });
      }
      fields.push(`budget_dollars = $${idx++}`); values.push(budget_dollars);
    }
    if (prevailing_wage_rate !== undefined) {
      if (prevailing_wage_rate !== null && prevailing_wage_rate < 0) {
        logFailure(req, 'admin.projects.update', 'negative_wage_rate', { prevailing_wage_rate });
        return res.status(400).json({ error: 'prevailing_wage_rate must be non-negative' });
      }
      fields.push(`prevailing_wage_rate = $${idx++}`); values.push(prevailing_wage_rate);
    }
    if (required_checklist_template_id !== undefined) {
      fields.push(`required_checklist_template_id = $${idx++}`);
      values.push(required_checklist_template_id);
    }
    if (client_name !== undefined) { fields.push(`client_name = $${idx++}`); values.push(client_name || null); }
    if (job_number !== undefined)   { fields.push(`job_number = $${idx++}`);   values.push(job_number || null); }
    if (address !== undefined)      { fields.push(`address = $${idx++}`);      values.push(address || null); }
    if (start_date !== undefined)   { fields.push(`start_date = $${idx++}`);   values.push(start_date || null); }
    if (end_date !== undefined)     { fields.push(`end_date = $${idx++}`);     values.push(end_date || null); }
    if (description !== undefined)  { fields.push(`description = $${idx++}`);  values.push(description || null); }
    if (status !== undefined)       { fields.push(`status = $${idx++}`);       values.push(status); }
    if (progress_pct !== undefined) {
      if (progress_pct !== null && (progress_pct < 0 || progress_pct > 100)) {
        logFailure(req, 'admin.projects.update', 'progress_out_of_range', { progress_pct });
        return res.status(400).json({ error: 'progress_pct must be 0–100' });
      }
      fields.push(`progress_pct = $${idx++}`); values.push(progress_pct);
    }
    if (active !== undefined) { fields.push(`active = $${idx++}`); values.push(!!active); }
    if (req.body.visible_to_user_ids !== undefined) {
      // null or empty array → unrestricted (visible to everyone in the company)
      const raw = req.body.visible_to_user_ids;
      let value = null;
      if (Array.isArray(raw) && raw.length > 0) {
        value = raw.map(Number).filter(n => Number.isInteger(n) && n > 0);
        if (value.length === 0) value = null;
      }
      fields.push(`visible_to_user_ids = $${idx++}`); values.push(value);
    }
    if (fields.length === 0) {
      logFailure(req, 'admin.projects.update', 'nothing_to_update');
      return res.status(400).json({ error: 'Nothing to update' });
    }
    const clientUpdatedAt = req.body.updated_at || null;
    if (clientUpdatedAt) {
      const cur = await pool.query('SELECT updated_at FROM projects WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
      if (!cur.rows.length) {
        logFailure(req, 'admin.projects.update', 'not_found', { project_id: req.params.id });
        return res.status(404).json({ error: 'Project not found' });
      }
      if (new Date(cur.rows[0].updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
        logFailure(req, 'admin.projects.update', 'conflict', { project_id: req.params.id });
        return res.status(409).json({ error: 'conflict' });
      }
    }
    fields.push(`updated_at = NOW()`);
    values.push(req.params.id);
    values.push(companyId);
    const result = await pool.query(
      `UPDATE projects SET ${fields.join(', ')} WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING *`,
      values
    );
    if (result.rowCount === 0) {
      logFailure(req, 'admin.projects.update', 'not_found', { project_id: req.params.id });
      return res.status(404).json({ error: 'Project not found' });
    }
    await logAudit(companyId, req.user.id, req.user.full_name, 'project.updated', 'project', result.rows[0].id, result.rows[0].name);
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /admin/geocode?q=<address>
// Forward an address to OpenStreetMap Nominatim and return { lat, lng,
// display_name } for the top hit, or 404 if there's no match. Used by
// the project Create / Edit forms to auto-fill the geofence center
// from a typed address.
//
// Why proxy rather than call Nominatim from the client: their terms of
// service ask for a real User-Agent identifying the calling app, and a
// browser fetch can't set that header reliably. Going through the
// server also keeps our usage trackable and rate-limit-able.
const geocodeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,             // generous — a typing admin won't realistically exceed
  keyGenerator: userOrIpKey,
  message: { error: 'Too many geocode requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});
router.get('/geocode', requireAdmin, requirePerm('manage_projects'), geocodeLimiter, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q || q.length < 5) return res.status(400).json({ error: 'Address too short' });
  if (q.length > 200)     return res.status(400).json({ error: 'Address too long' });
  try {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', q);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');
    const r = await fetch(url.toString(), {
      headers: {
        // Nominatim ToS requires a meaningful User-Agent identifying the app.
        'User-Agent': `OpsFloa/1.0 (${process.env.APP_URL || 'https://opsfloa.com'})`,
      },
    });
    if (!r.ok) {
      logger.warn({ status: r.status }, 'geocode upstream error');
      return res.status(502).json({ error: 'Geocoding service unavailable' });
    }
    const results = await r.json();
    if (!Array.isArray(results) || results.length === 0) {
      return res.status(404).json({ error: 'Address not found' });
    }
    const { lat, lon, display_name } = results[0];
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lon);
    if (isNaN(latNum) || isNaN(lngNum)) return res.status(502).json({ error: 'Invalid coordinates' });
    res.json({ lat: latNum, lng: lngNum, display_name });
  } catch (err) {
    logger.error({ err }, 'geocode error');
    res.status(500).json({ error: 'Geocoding failed' });
  }
});

// Create a project
router.post('/projects', requireAdmin, requirePerm('manage_projects'),
  coerceBody({ float: ['prevailing_wage_rate', 'geo_lat', 'geo_lng'], int: ['geo_radius_ft'] }),
  async (req, res) => {
  const { wage_type, prevailing_wage_rate, client_id, job_number, address, start_date, end_date, status, description,
          geo_lat, geo_lng, geo_radius_ft } = req.body;
  const name = req.body.name?.trim();
  if (!name) {
    logFailure(req, 'admin.projects.create', 'name_required');
    return res.status(400).json({ error: 'Project name required' });
  }
  const companyId = req.user.company_id;
  const wt = wage_type === 'prevailing' ? 'prevailing' : 'regular';
  const pwr = prevailing_wage_rate;
  if (pwr !== null && pwr !== undefined && pwr < 0) {
    logFailure(req, 'admin.projects.create', 'negative_wage_rate', { pwr });
    return res.status(400).json({ error: 'prevailing_wage_rate must be non-negative' });
  }
  // Geofence: all three fields required together, or none. radius must be
  // positive when present.
  const geoFieldsPresent = [geo_lat, geo_lng, geo_radius_ft].filter(v => v !== undefined && v !== null && v !== '').length;
  if (geoFieldsPresent > 0 && geoFieldsPresent < 3) {
    return res.status(400).json({ error: 'geofence requires geo_lat, geo_lng, and geo_radius_ft together' });
  }
  if (geo_radius_ft !== undefined && geo_radius_ft !== null && geo_radius_ft <= 0) {
    return res.status(400).json({ error: 'geo_radius_ft must be a positive number' });
  }
  const validStatuses = PROJECT_STATUSES;
  const st = validStatuses.includes(status) ? status : 'in_progress';
  try {
    let resolvedClientName = null;
    if (client_id) {
      const cr = await pool.query('SELECT name FROM clients WHERE id = $1 AND company_id = $2', [client_id, companyId]);
      if (cr.rows.length) resolvedClientName = cr.rows[0].name;
    }
    const result = await pool.query(
      `INSERT INTO projects (company_id, name, wage_type, prevailing_wage_rate, client_id, client_name, job_number, address, start_date, end_date, status, description, geo_lat, geo_lng, geo_radius_ft)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [companyId, name, wt, pwr,
       client_id || null, resolvedClientName, job_number?.trim() || null,
       address?.trim() || null, start_date || null, end_date || null, st, description?.trim() || null,
       geoFieldsPresent === 3 ? geo_lat : null,
       geoFieldsPresent === 3 ? geo_lng : null,
       geoFieldsPresent === 3 ? geo_radius_ft : null]
    );
    await logAudit(companyId, req.user.id, req.user.full_name, 'project.created', 'project', result.rows[0].id, name, { wage_type: wt });
    const newProject = result.rows[0];
    res.status(201).json(newProject);

    // QBO auto-create customer — fire-and-forget
    setImmediate(async () => {
      try {
        const setting = await pool.query("SELECT value FROM settings WHERE company_id = $1 AND key = 'qbo_auto_create_customers'", [companyId]);
        if (setting.rows[0]?.value !== '1') return;
        const company = await pool.query('SELECT qbo_realm_id FROM companies WHERE id = $1', [companyId]);
        if (!company.rows[0]?.qbo_realm_id) return;
        const customer = await qbo.createCustomer(companyId, { displayName: name });
        if (customer?.Id) {
          await pool.query('UPDATE projects SET qbo_customer_id = $1 WHERE id = $2', [customer.Id, newProject.id]);
        }
      } catch (err) { logger.error({ err }, '[QBO auto-create customer]'); }
    });
  } catch (err) {
    if (err.code === '23505') {
      const existing = await pool.query('SELECT id, name, active FROM projects WHERE name = $1 AND company_id = $2', [name, companyId]);
      const p = existing.rows[0];
      if (p && !p.active) {
        logFailure(req, 'admin.projects.create', 'archived_name_collision', { archived_id: p.id });
        return res.status(409).json({ error: `A removed project named "${name}" already exists. Restore it instead?`, archived_id: p.id, archived_name: p.name });
      }
      logFailure(req, 'admin.projects.create', 'name_conflict');
      return res.status(409).json({ error: 'Project already exists' });
    }
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Unified activity feed for a project (field notes + punchlist items)
// Recent photos for a project (across all field reports)
router.get('/projects/:id/photos', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `SELECT ph.url, ph.caption, ph.media_type, ph.created_at,
              COALESCE(r.report_date, r.reported_at::date) AS report_date,
              COALESCE(u.invoice_name, u.full_name) AS worker_name
       FROM field_report_photos ph
       JOIN field_reports r ON ph.report_id = r.id
       JOIN users u ON r.user_id = u.id
       WHERE r.project_id = $1 AND r.company_id = $2 AND ph.url IS NOT NULL
       ORDER BY COALESCE(r.report_date, r.reported_at::date) DESC, ph.created_at DESC
       LIMIT 60`,
      [req.params.id, companyId]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Project documents
//
// Both endpoints below verify project ownership before touching anything.
// Without this check, an admin could mint upload URLs or attach document
// rows against a project_id belonging to another tenant — project IDs are
// sequential ints, so they're guessable. The read endpoints already
// filter `WHERE project_id = $1 AND company_id = $2`, so cross-tenant rows
// wouldn't be visible to the victim, but they would sit in the DB tied
// to the wrong project and could leak through any future join that
// forgets the company scope.
async function assertProjectInCompany(projectId, companyId) {
  const r = await pool.query(
    'SELECT 1 FROM projects WHERE id = $1 AND company_id = $2 LIMIT 1',
    [projectId, companyId]
  );
  return r.rowCount > 0;
}

router.get('/projects/:id/documents/upload-url', requireAdmin, async (req, res) => {
  const { filename, contentType } = req.query;
  if (!filename || !contentType) return res.status(400).json({ error: 'filename and contentType required' });
  const ALLOWED = ['application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/jpeg', 'image/png', 'image/webp', 'text/plain', 'text/csv'];
  if (!ALLOWED.includes(contentType)) return res.status(400).json({ error: 'File type not allowed' });
  try {
    if (!(await assertProjectInCompany(req.params.id, req.user.company_id))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const ext = filename.split('.').pop().toLowerCase();
    const { getPresignedUploadUrl } = require('../r2');
    const { uploadUrl, publicUrl } = await getPresignedUploadUrl('documents', ext, contentType);
    res.json({ uploadUrl, publicUrl });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Failed to generate upload URL' }); }
});

router.post('/projects/:id/documents', requireAdmin, async (req, res) => {
  const { name, url, size_bytes } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  const companyId = req.user.company_id;
  try {
    if (!(await assertProjectInCompany(req.params.id, companyId))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const result = await pool.query(
      `INSERT INTO project_documents (company_id, project_id, name, url, size_bytes, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [companyId, req.params.id, name.trim(), url, size_bytes || null, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

router.get('/projects/:id/documents', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `SELECT d.*, COALESCE(u.full_name, '') AS uploader_name
       FROM project_documents d
       LEFT JOIN users u ON d.uploaded_by = u.id
       WHERE d.project_id = $1 AND d.company_id = $2
       ORDER BY d.created_at DESC`,
      [req.params.id, companyId]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

router.delete('/projects/:id/documents/:docId', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const doc = await pool.query(
      'SELECT url FROM project_documents WHERE id=$1 AND project_id=$2 AND company_id=$3',
      [req.params.docId, req.params.id, companyId]
    );
    if (doc.rowCount === 0) return res.status(404).json({ error: 'Document not found' });
    const { deleteByUrl } = require('../r2');
    await deleteByUrl(doc.rows[0].url).catch(() => {});
    await pool.query('DELETE FROM project_documents WHERE id=$1', [req.params.docId]);
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// RFIs for a project
router.get('/projects/:id/rfis', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `SELECT id, rfi_number, subject, status, directed_to, date_submitted, date_due
       FROM rfis
       WHERE project_id = $1 AND company_id = $2
       ORDER BY rfi_number DESC
       LIMIT 100`,
      [req.params.id, companyId]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Project health snapshot — counts + approximate cost in one query
router.get('/projects/:id/health', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM punchlist_items
          WHERE project_id=$1 AND company_id=$2 AND status='open')::int             AS open_punchlist,
         (SELECT COUNT(*) FROM punchlist_items
          WHERE project_id=$1 AND company_id=$2 AND status!='verified')::int        AS active_punchlist,
         (SELECT COUNT(*) FROM rfis
          WHERE project_id=$1 AND company_id=$2 AND status='open')::int             AS open_rfis,
         (SELECT COUNT(*) FROM field_reports
          WHERE project_id=$1 AND company_id=$2
            AND COALESCE(report_date, reported_at::date) >= CURRENT_DATE - 7)::int  AS reports_week,
         (SELECT ROUND(COALESCE(SUM(
            EXTRACT(EPOCH FROM (
              CASE WHEN te.end_time < te.start_time
                THEN te.end_time + INTERVAL '1 day' - te.start_time
                ELSE te.end_time - te.start_time
              END
            )) / 3600 * COALESCE(u.hourly_rate, (
              SELECT value::numeric FROM settings
              WHERE company_id=$2 AND key='default_hourly_rate' LIMIT 1
            ), 30)
          ), 0)::numeric, 0)
          FROM time_entries te
          JOIN users u ON te.user_id = u.id
          WHERE te.project_id=$1 AND te.company_id=$2)                              AS approx_cost`,
      [req.params.id, companyId]
    );
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/projects/:id/activity', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `WITH notes AS (
         SELECT 'note'::text AS type,
                r.id::text,
                r.notes AS title,
                r.reported_at AS event_at,
                COALESCE(u.invoice_name, u.full_name) AS worker_name,
                NULL::text AS status,
                NULL::text AS priority
         FROM field_reports r
         JOIN users u ON r.user_id = u.id
         WHERE r.project_id = $1 AND r.company_id = $2
           AND r.notes IS NOT NULL AND r.notes <> ''
         ORDER BY r.reported_at DESC
         LIMIT 10
       ),
       punches AS (
         SELECT 'punch'::text AS type,
                pi.id::text,
                pi.title,
                pi.created_at AS event_at,
                NULL::text AS worker_name,
                pi.status,
                pi.priority
         FROM punchlist_items pi
         WHERE pi.project_id = $1 AND pi.company_id = $2
         ORDER BY pi.created_at DESC
         LIMIT 15
       )
       SELECT * FROM notes
       UNION ALL
       SELECT * FROM punches
       ORDER BY event_at DESC
       LIMIT 25`,
      [req.params.id, companyId]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Workers who have time entries on this project
router.get('/projects/:id/workers', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `SELECT u.id,
              COALESCE(u.invoice_name, u.full_name) AS worker_name,
              COUNT(te.id)::int AS entry_count,
              ROUND(
                COALESCE(SUM(EXTRACT(EPOCH FROM (
                  CASE WHEN te.end_time < te.start_time
                    THEN te.end_time + INTERVAL '1 day' - te.start_time
                    ELSE te.end_time - te.start_time
                  END
                )) / 3600), 0)::numeric, 1
              ) AS total_hours,
              MAX(te.work_date) AS last_worked
       FROM time_entries te
       JOIN users u ON te.user_id = u.id
       WHERE te.project_id = $1 AND te.company_id = $2
       GROUP BY u.id, COALESCE(u.invoice_name, u.full_name)
       ORDER BY total_hours DESC`,
      [req.params.id, companyId]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Remove (soft-delete) a project
router.get('/projects/:id/media-urls', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const photos = await pool.query(
      `SELECT p.url FROM field_report_photos p
       JOIN field_reports r ON p.report_id = r.id
       WHERE r.company_id = $1 AND r.project_id = $2 AND p.url IS NOT NULL`,
      [companyId, req.params.id]
    );
    const attachments = await pool.query(
      `SELECT a.url FROM safety_talk_attachments a
       JOIN safety_talks t ON a.talk_id = t.id
       WHERE t.company_id = $1 AND t.project_id = $2 AND a.url IS NOT NULL`,
      [companyId, req.params.id]
    );
    const urls = [
      ...photos.rows.map(r => r.url),
      ...attachments.rows.map(r => r.url),
    ];
    res.json({ urls, count: urls.length });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/projects/:id/media-zip', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const projectRow = await pool.query(
      'SELECT name FROM projects WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (projectRow.rowCount === 0) return res.status(404).json({ error: 'Project not found' });
    const projectName = projectRow.rows[0].name.replace(/[^a-z0-9]/gi, '_');

    const photos = await pool.query(
      `SELECT p.url FROM field_report_photos p
       JOIN field_reports r ON p.report_id = r.id
       WHERE r.company_id = $1 AND r.project_id = $2 AND p.url IS NOT NULL`,
      [companyId, req.params.id]
    );
    const attachments = await pool.query(
      `SELECT a.url FROM safety_talk_attachments a
       JOIN safety_talks t ON a.talk_id = t.id
       WHERE t.company_id = $1 AND t.project_id = $2 AND a.url IS NOT NULL`,
      [companyId, req.params.id]
    );
    // Bound the URLs we'll fetch to known R2 / CDN hosts. The URL column
    // is populated from R2 upload responses today, but a bad row from a
    // future import, raw SQL, or compromised endpoint could otherwise
    // point this fetch at an internal address (169.254.169.254, RFC1918,
    // metadata services) — classic SSRF. Reject anything that doesn't
    // match the allow-list before we touch the network.
    const r2Public = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
    const allowedHostnames = new Set();
    try { if (r2Public) allowedHostnames.add(new URL(r2Public).hostname); } catch { /* env unset / malformed */ }
    const isAllowedUrl = u => {
      try {
        const p = new URL(u);
        if (p.protocol !== 'https:' && p.protocol !== 'http:') return false;
        return allowedHostnames.size === 0 ? false : allowedHostnames.has(p.hostname);
      } catch { return false; }
    };
    const allUrls = [
      ...photos.rows.map(r => r.url),
      ...attachments.rows.map(r => r.url),
    ];
    const urls = allUrls.filter(isAllowedUrl);
    const skipped = allUrls.length - urls.length;
    if (skipped > 0) {
      logger.warn({ project_id: req.params.id, skipped }, 'media-zip: dropped URLs not on allow-list');
    }

    if (urls.length === 0) return res.status(404).json({ error: 'No media found for this project' });

    const archiver = require('archiver');
    const https = require('https');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${projectName}_media.zip"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(res);
    archive.on('error', err => { logger.error({ err }, 'media-zip archive error'); });

    // Only https. The allow-list above rejected anything else, so we
    // don't need the http module at all anymore.
    await Promise.all(urls.map((url, i) => new Promise(resolve => {
      const ext = url.split('?')[0].split('.').pop().toLowerCase() || 'bin';
      const filename = `${String(i + 1).padStart(4, '0')}.${ext}`;
      https.get(url, stream => {
        archive.append(stream, { name: filename });
        resolve();
      }).on('error', resolve);
    })));

    await archive.finalize();
  } catch (err) {
    logger.error({ err }, 'catch block error');
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
  }
});

// Merge one project into another — moves all data, deletes source
router.post('/projects/:id/merge-into/:target_id', requireAdmin, requirePerm('manage_projects'), async (req, res) => {
  const sourceId = parseInt(req.params.id);
  const targetId = parseInt(req.params.target_id);
  const companyId = req.user.company_id;

  if (sourceId === targetId) return res.status(400).json({ error: 'Cannot merge a project into itself' });

  try {
    const check = await pool.query(
      'SELECT id, name FROM projects WHERE id = ANY($1) AND company_id = $2',
      [[sourceId, targetId], companyId]
    );
    if (check.rowCount < 2) return res.status(404).json({ error: 'One or both projects not found' });

    const sourceName = check.rows.find(r => r.id === sourceId)?.name;
    const targetName = check.rows.find(r => r.id === targetId)?.name;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const intTables = [
        'time_entries', 'active_clock', 'shifts', 'field_reports', 'daily_reports',
        'punchlist_items', 'safety_talks', 'incident_reports', 'sub_reports',
        'equipment_hours', 'rfis', 'safety_checklist_submissions',
      ];
      for (const table of intTables) {
        await client.query(`UPDATE ${table} SET project_id = $1 WHERE project_id = $2 AND company_id = $3`, [targetId, sourceId, companyId]);
      }
      // inspections stores project_id as UUID/text column
      await client.query(
        `UPDATE inspections SET project_id = $1::text WHERE project_id::text = $2::text AND company_id = $3`,
        [targetId, sourceId, companyId]
      );

      await client.query('DELETE FROM projects WHERE id = $1 AND company_id = $2', [sourceId, companyId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await logAudit(companyId, req.user.id, req.user.full_name, 'project.merged', 'project', sourceId, sourceName, `Merged into "${targetName}" (id ${targetId})`);
    res.json({ success: true, message: `Merged "${sourceName}" into "${targetName}"` });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/projects/:id', requireAdmin, requirePerm('manage_projects'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const project = await pool.query('SELECT name FROM projects WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    const result = await pool.query(
      'UPDATE projects SET active = false WHERE id = $1 AND active = true AND company_id = $2 RETURNING id',
      [req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Project not found' });
    await logAudit(companyId, req.user.id, req.user.full_name, 'project.deleted', 'project', parseInt(req.params.id), project.rows[0]?.name);

    // Delete project media if setting is enabled — fire and forget
    try {
      const settingRow = await pool.query(
        `SELECT value FROM settings WHERE company_id=$1 AND key='media_delete_on_project_archive'`,
        [companyId]
      );
      if (settingRow.rows[0]?.value === '1') {
        const { deleteMediaForProject } = require('../jobs/mediaRetention');
        deleteMediaForProject(companyId, req.params.id).catch(() => {});
      }
    } catch {}

    res.json({ removed: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /admin/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/analytics', requireAdmin, requirePerm('view_reports'), requirePlan('business'), async (req, res) => {
  const companyId = req.user.company_id;
  const { from, to } = req.query;
  // Validate dates if provided
  const fromDate = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : null;
  const toDate = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : null;
  const hoursExpr = `EXTRACT(EPOCH FROM (CASE WHEN end_time < start_time THEN end_time + INTERVAL '1 day' - start_time ELSE end_time - start_time END)) / 3600`;
  try {
    const settings = await getSettings(companyId);
    const ws = parseInt(settings.week_start ?? 1, 10);
    const weekStartDate = weekRange(ws, 0).from; // Monday-of-this-week, respecting setting
    // SQL fragment that computes the start-of-week date for any `work_date`, honoring week_start.
    // (EXTRACT DOW is 0-6 Sun..Sat; subtract (dow - ws) mod 7 days to land on the week's first day.)
    const weekBucketSql = `(work_date - ((EXTRACT(DOW FROM work_date)::int - ${ws} + 7) % 7))::date`;
    const [daily, weekly, projects, workers, summary] = await Promise.all([
      // Hours per day — custom range or last 14 days
      fromDate || toDate
        ? pool.query(
            `SELECT work_date::text as date,
                    ROUND(SUM(${hoursExpr})::numeric, 2) as hours
             FROM time_entries
             WHERE company_id = $1
               AND ($2::date IS NULL OR work_date >= $2::date)
               AND ($3::date IS NULL OR work_date <= $3::date)
             GROUP BY work_date ORDER BY work_date ASC LIMIT 90`,
            [companyId, fromDate, toDate]
          )
        : pool.query(
            `SELECT work_date::text as date,
                    ROUND(SUM(${hoursExpr})::numeric, 2) as hours
             FROM time_entries
             WHERE company_id = $1 AND work_date >= CURRENT_DATE - 13
             GROUP BY work_date ORDER BY work_date ASC LIMIT 14`,
            [companyId]
          ),
      // Hours per week — custom range or last 12 weeks
      fromDate || toDate
        ? pool.query(
            `SELECT to_char(${weekBucketSql}, 'YYYY-MM-DD') as week_start,
                    ROUND(SUM(${hoursExpr})::numeric, 1) as hours
             FROM time_entries
             WHERE company_id = $1
               AND ($2::date IS NULL OR work_date >= $2::date)
               AND ($3::date IS NULL OR work_date <= $3::date)
             GROUP BY week_start ORDER BY week_start ASC`,
            [companyId, fromDate, toDate]
          )
        : pool.query(
            `SELECT to_char(${weekBucketSql}, 'YYYY-MM-DD') as week_start,
                    ROUND(SUM(${hoursExpr})::numeric, 1) as hours
             FROM time_entries
             WHERE company_id = $1 AND work_date >= CURRENT_DATE - 83
             GROUP BY week_start ORDER BY week_start ASC LIMIT 12`,
            [companyId]
          ),
      // Top projects by hours
      pool.query(
        `SELECT p.name,
                ROUND(SUM(${hoursExpr})::numeric, 2) as hours
         FROM time_entries te
         JOIN projects p ON te.project_id = p.id
         WHERE te.company_id = $1
           AND ($2::date IS NULL OR te.work_date >= $2::date)
           AND ($3::date IS NULL OR te.work_date <= $3::date)
           ${!fromDate && !toDate ? 'AND te.work_date >= CURRENT_DATE - 29' : ''}
         GROUP BY p.name ORDER BY hours DESC LIMIT 10`,
        [companyId, fromDate, toDate]
      ),
      // Top workers by hours
      pool.query(
        `SELECT u.full_name as name,
                ROUND(SUM(${hoursExpr})::numeric, 2) as hours
         FROM time_entries te
         JOIN users u ON te.user_id = u.id
         WHERE te.company_id = $1
           AND ($2::date IS NULL OR te.work_date >= $2::date)
           AND ($3::date IS NULL OR te.work_date <= $3::date)
           ${!fromDate && !toDate ? 'AND te.work_date >= CURRENT_DATE - 29' : ''}
         GROUP BY u.full_name ORDER BY hours DESC LIMIT 10`,
        [companyId, fromDate, toDate]
      ),
      // Summary stats — always current (this week / this month)
      pool.query(
        `SELECT
           ROUND(COALESCE(SUM(CASE WHEN work_date >= $2::date
             THEN ${hoursExpr} END), 0)::numeric, 1) as hours_this_week,
           COUNT(DISTINCT CASE WHEN work_date >= $2::date THEN user_id END) as active_workers_this_week,
           COUNT(DISTINCT CASE WHEN work_date >= date_trunc('month', CURRENT_DATE) THEN user_id END) as active_workers_this_month,
           ROUND(COALESCE(SUM(CASE WHEN work_date >= date_trunc('month', CURRENT_DATE)
             THEN ${hoursExpr} END), 0)::numeric, 1) as hours_this_month,
           COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_approvals,
           ROUND(COALESCE(SUM(CASE WHEN work_date >= $2::date THEN mileage END), 0)::numeric, 1) as mileage_this_week,
           ROUND(COALESCE(SUM(CASE WHEN work_date >= date_trunc('month', CURRENT_DATE) THEN mileage END), 0)::numeric, 1) as mileage_this_month
         FROM time_entries WHERE company_id = $1
           AND (work_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
                OR status = 'pending')`,
        [companyId, weekStartDate]
      ),
    ]);

    res.json({
      daily_hours: daily.rows,
      weekly_hours: weekly.rows,
      project_hours: projects.rows,
      worker_hours: workers.rows,
      summary: summary.rows[0],
    });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /admin/entries/pending — pending time entries for this company (max 200 per page; has_more signals more available)
router.get('/entries/pending', requireAdmin, requirePerm('approve_entries'), async (req, res) => {
  const companyId = req.user.company_id;
  const LIMIT = 200;
  const accessIds = req.user.worker_access_ids;
  const { from, to, offset: offsetParam } = req.query;
  const offset = parseInt(offsetParam) || 0;
  try {
    const conditions = [`te.company_id = $1`, `te.status = 'pending'`];
    const params = [companyId];
    if (accessIds && accessIds.length) { params.push(accessIds); conditions.push(`te.user_id = ANY($${params.length})`); }
    if (from) { params.push(from); conditions.push(`te.work_date >= $${params.length}`); }
    if (to) { params.push(to); conditions.push(`te.work_date <= $${params.length}`); }
    params.push(LIMIT + 1);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;
    const result = await pool.query(
      `SELECT te.*, COALESCE(u.invoice_name, u.full_name) as worker_name, u.email as worker_email, p.name as project_name,
              te.clock_source, te.clocked_in_by, admin_u.full_name AS clocked_in_by_name
       FROM time_entries te
       JOIN users u ON te.user_id = u.id
       LEFT JOIN projects p ON te.project_id = p.id
       LEFT JOIN users admin_u ON te.clocked_in_by = admin_u.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY te.worker_signed_at DESC NULLS LAST, te.work_date DESC, te.start_time DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );
    const has_more = result.rows.length > LIMIT;
    res.json({ entries: result.rows.slice(0, LIMIT), has_more });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /admin/entries/recently-approved — entries approved in the last 24 hours
router.get('/entries/recently-approved', requireAdmin, requirePerm('approve_entries'), async (req, res) => {
  const companyId = req.user.company_id;
  const accessIds = req.user.worker_access_ids;
  try {
    const workerFilter = accessIds && accessIds.length ? `AND te.user_id = ANY($2)` : '';
    const params = accessIds && accessIds.length ? [companyId, accessIds] : [companyId];
    const { rows } = await pool.query(
      `SELECT te.id, te.work_date, te.start_time, te.end_time, te.project_id, te.user_id, te.approved_at,
              te.qbo_activity_id, te.qbo_synced_at,
              COALESCE(u.invoice_name, u.full_name) AS worker_name, p.name AS project_name
       FROM time_entries te
       JOIN users u ON te.user_id = u.id
       LEFT JOIN projects p ON te.project_id = p.id
       WHERE te.company_id = $1 AND te.status = 'approved'
         AND te.approved_at >= NOW() - INTERVAL '24 hours'
         ${workerFilter}
       ORDER BY te.approved_at DESC
       LIMIT 100`,
      params
    );
    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /admin/entries/bulk-approve — approve a specific set of entry IDs
router.post('/entries/bulk-approve', requireAdmin, requirePerm('approve_entries'), async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'ids required' });
  if (ids.length > 200) return res.status(400).json({ error: 'Max 200 entries per bulk approve' });
  const companyId = req.user.company_id;
  const accessIds = req.user.worker_access_ids;
  const accessFilter = accessIds && accessIds.length ? `AND user_id = ANY($4)` : '';
  const params = accessIds && accessIds.length
    ? [req.user.id, ids, companyId, accessIds]
    : [req.user.id, ids, companyId];
  try {
    const blockedFilter = accessIds && accessIds.length ? `AND user_id = ANY($3)` : '';
    const blockedParams = accessIds && accessIds.length ? [ids, companyId, accessIds] : [ids, companyId];
    const blocked = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM time_entries
       WHERE id = ANY($1::int[]) AND company_id = $2 AND status = 'pending'
         AND NOT (${ENTRY_HAS_ENDED_SQL}) ${blockedFilter}`,
      blockedParams
    );
    if ((blocked.rows[0]?.count || 0) > 0) {
      return res.status(409).json({ error: 'Time entries cannot be approved until their end time has passed.' });
    }
    const result = await pool.query(
      `UPDATE time_entries SET status = 'approved', locked = true, approved_by = $1, approved_at = NOW()
       WHERE id = ANY($2::int[]) AND company_id = $3 AND status = 'pending' AND ${ENTRY_HAS_ENDED_SQL} ${accessFilter}
       RETURNING id, user_id, work_date, start_time, end_time`,
      params
    );
    // Group by worker so each gets one push (not one per entry)
    const byWorker = {};
    for (const row of result.rows) {
      if (!byWorker[row.user_id]) byWorker[row.user_id] = [];
      byWorker[row.user_id].push(row);
    }
    for (const [userId, rows] of Object.entries(byWorker)) {
      const count = rows.length;
      const pushBody = count === 1
        ? `Your entry for ${rows[0].work_date?.toString().substring(0,10)} (${rows[0].start_time}–${rows[0].end_time}) was approved.`
        : `${count} time entries were approved.`;
      sendPushToUser(parseInt(userId), { title: 'Time entry approved', body: pushBody, url: '/timeclock' });
      createInboxItem(parseInt(userId), companyId, 'approval', 'Time entry approved ✓', pushBody, '/timeclock');
    }
    await logAudit(companyId, req.user.id, req.user.full_name, 'entries.bulk_approved', 'time_entry', null, null, { count: result.rowCount, ids });
    res.json({ approved: result.rowCount });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /admin/entries/approve-all — approve every pending entry for this company
router.post('/entries/approve-all', requireAdmin, requirePerm('approve_entries'), async (req, res) => {
  const companyId = req.user.company_id;
  const accessIds = req.user.worker_access_ids;
  try {
    const workerFilter = accessIds && accessIds.length ? `AND user_id = ANY($3)` : '';
    const params = accessIds && accessIds.length ? [req.user.id, companyId, accessIds] : [req.user.id, companyId];
    const result = await pool.query(
      `UPDATE time_entries SET status = 'approved', locked = true, approved_by = $1, approved_at = NOW()
       WHERE company_id = $2 AND status = 'pending' AND ${ENTRY_HAS_ENDED_SQL} ${workerFilter} RETURNING id`,
      params
    );
    await logAudit(companyId, req.user.id, req.user.full_name, 'entries.approved_all', 'time_entry', null, null, { count: result.rowCount });
    res.json({ approved: result.rowCount });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/entries/:id/approve
router.patch('/entries/:id/approve', requireAdmin, requirePerm('approve_entries'),
  coerceBody({ float: ['overtime_hours_override'] }),
  async (req, res) => {
  const companyId = req.user.company_id;
  const { note, overtime_hours_override } = req.body;
  if (note && note.length > 500) return res.status(400).json({ error: 'Note must be 500 characters or fewer' });
  if (overtime_hours_override != null && overtime_hours_override < 0) {
    return res.status(400).json({ error: 'overtime_hours_override must be non-negative' });
  }
  const touchOverride = 'overtime_hours_override' in req.body;
  const accessIds = req.user.worker_access_ids;
  try {
    // Include the override in the UPDATE only when it was part of the request.
    // Same shape as /edit — 'not in body' means "don't touch existing value".
    const setOverride = touchOverride ? ', overtime_hours_override = $5' : '';
    const baseParams = [note || null, req.user.id, req.params.id, companyId];
    if (touchOverride) baseParams.push(overtime_hours_override);
    const workerFilter = accessIds && accessIds.length ? `AND user_id = ANY($${baseParams.length + 1})` : '';
    const params = accessIds && accessIds.length ? [...baseParams, accessIds] : baseParams;
    const result = await pool.query(
      `UPDATE time_entries SET status = 'approved', locked = true, approval_note = $1, approved_by = $2, approved_at = NOW()${setOverride}
       WHERE id = $3 AND company_id = $4 AND status = 'pending' AND ${ENTRY_HAS_ENDED_SQL} ${workerFilter} RETURNING *`,
      params
    );
    if (result.rowCount === 0) {
      const existing = await pool.query('SELECT id, status, end_ts FROM time_entries WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
      if (existing.rows[0]?.status === 'pending' && (!existing.rows[0].end_ts || new Date(existing.rows[0].end_ts) > new Date())) {
        return res.status(409).json({ error: 'Time entries cannot be approved until their end time has passed.' });
      }
      return res.status(404).json({ error: 'Entry not found' });
    }
    await logAudit(companyId, req.user.id, req.user.full_name, 'entry.approved', 'time_entry', parseInt(req.params.id), null);
    const worker = await pool.query('SELECT email, full_name FROM users WHERE id = $1', [result.rows[0].user_id]);
    if (worker.rows[0]?.email) {
      const { work_date, start_time, end_time } = result.rows[0];
      sendEmail(worker.rows[0].email, 'Time entry approved ✓',
        `<p>Hi ${escapeHtml(worker.rows[0].full_name)},</p><p>Your time entry for <b>${work_date?.toString().substring(0,10)}</b> (${start_time}–${end_time}) has been <b style="color:#059669">approved</b>.</p><p>— OpsFloa</p>`);
    }
    const entry = result.rows[0];
    sendPushToUser(entry.user_id, { title: 'Time entry approved', body: 'An admin approved your time entry.', url: '/timeclock' });
    createInboxItem(entry.user_id, companyId, 'approval', 'Time entry approved ✓',
      `Your entry for ${entry.work_date?.toString().substring(0,10)} (${entry.start_time}–${entry.end_time}) was approved.`, '/timeclock');
    res.json(entry);

    // QBO auto-sync — fire-and-forget, never blocks the response
    setImmediate(async () => {
      try {
        const autopush = await pool.query("SELECT value FROM settings WHERE company_id = $1 AND key = 'qbo_auto_push'", [companyId]);
        if (autopush.rows[0]?.value !== '1') return;
        const company = await pool.query('SELECT qbo_realm_id FROM companies WHERE id = $1', [companyId]);
        if (!company.rows[0]?.qbo_realm_id) return;
        const worker = await pool.query('SELECT qbo_employee_id, qbo_vendor_id, worker_type FROM users WHERE id = $1', [entry.user_id]);
        const w = worker.rows[0];
        if (!w) return;
        const usesVendor = w.worker_type === 'contractor' || w.worker_type === 'subcontractor';
        const mappedId = usesVendor ? w.qbo_vendor_id : w.qbo_employee_id;
        if (!mappedId) return;
        if (!entry.project_id) return;
        const proj = await pool.query('SELECT qbo_customer_id, qbo_class_id FROM projects WHERE id = $1', [entry.project_id]);
        const customerId = proj.rows[0]?.qbo_customer_id;
        if (!customerId) return;
        let ms = new Date(`1970-01-01T${entry.end_time}`) - new Date(`1970-01-01T${entry.start_time}`);
        if (ms < 0) ms += 86400000;
        const hours = Math.max(0, ms / 3600000 - (entry.break_minutes || 0) / 60);
        const workDate = entry.work_date.toISOString().substring(0, 10);
        const activity = await qbo.pushTimeActivity(companyId, {
          ...(usesVendor ? { vendorId: w.qbo_vendor_id } : { employeeId: w.qbo_employee_id }),
          customerId,
          classId: proj.rows[0]?.qbo_class_id || null,
          workDate,
          hours,
          description: entry.notes || '',
        });
        await pool.query(
          'UPDATE time_entries SET qbo_activity_id = $1, qbo_synced_at = NOW() WHERE id = $2',
          [activity?.Id || 'synced', entry.id]
        );
      } catch (err) {
        logger.error({ err }, '[QBO auto-sync]');
        pool.query(
          'INSERT INTO qbo_sync_errors (company_id, entity_type, entity_id, error_message) VALUES ($1, $2, $3, $4)',
          [companyId, 'time_entry', entry.id, err.message]
        ).catch(() => {});
      }
    });

    // Budget alert — fire-and-forget after response is sent
    if (entry.project_id) {
      setImmediate(async () => {
        try {
          const proj = await pool.query(
            `SELECT id, name, budget_hours, budget_alert_pct FROM projects WHERE id = $1 AND company_id = $2`,
            [entry.project_id, companyId]
          );
          if (!proj.rows[0] || !proj.rows[0].budget_hours) return;
          const { id: pid, name: pname, budget_hours: budgetH, budget_alert_pct: alertedPct } = proj.rows[0];

          const totals = await pool.query(
            `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (
               CASE WHEN end_time < start_time THEN end_time + INTERVAL '1 day' - start_time
                    ELSE end_time - start_time END)) / 3600), 0) AS approved_hours
             FROM time_entries
             WHERE project_id = $1 AND company_id = $2 AND status = 'approved'`,
            [pid, companyId]
          );
          const approvedH = parseFloat(totals.rows[0].approved_hours);
          const pct = (approvedH / budgetH) * 100;

          let threshold = null;
          if (pct >= 100 && (alertedPct === null || alertedPct < 100)) threshold = 100;
          else if (pct >= 90 && (alertedPct === null || alertedPct < 90)) threshold = 90;
          if (!threshold) return;

          const notifSetting = await pool.query(
            `SELECT value FROM settings WHERE company_id = $1 AND key = 'notify_budget_alerts'`,
            [companyId]
          );
          await pool.query(
            `UPDATE projects SET budget_alert_pct = $1 WHERE id = $2 AND company_id = $3`,
            [threshold, pid, companyId]
          );
          if (notifSetting.rows[0]?.value === '0') return;

          const admins = await pool.query(
            `SELECT email, full_name FROM users WHERE company_id = $1 AND role = 'admin' AND email IS NOT NULL`,
            [companyId]
          );
          const subject = threshold === 100
            ? `Budget exceeded: ${pname}`
            : `Budget alert (${threshold}%): ${pname}`;
          const body = threshold === 100
            ? `<p>The project <b>${pname}</b> has exceeded its hour budget.</p><p>Approved: <b>${approvedH.toFixed(1)} hrs</b> / Budget: <b>${budgetH} hrs</b></p><p>— OpsFloa</p>`
            : `<p>The project <b>${pname}</b> has reached ${threshold}% of its hour budget.</p><p>Approved: <b>${approvedH.toFixed(1)} hrs</b> / Budget: <b>${budgetH} hrs</b></p><p>— OpsFloa</p>`;
          for (const admin of admins.rows) {
            sendEmail(admin.email, subject, body);
          }
        } catch (alertErr) {
          logger.error({ err: alertErr }, 'Budget alert error');
        }
      });
    }
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/entries/:id/reject
router.patch('/entries/:id/reject', requireAdmin, requirePerm('approve_entries'), async (req, res) => {
  const companyId = req.user.company_id;
  const { note } = req.body;
  if (note && note.length > 500) return res.status(400).json({ error: 'Note must be 500 characters or fewer' });
  const accessIds = req.user.worker_access_ids;
  try {
    const workerFilter = accessIds && accessIds.length ? `AND user_id = ANY($5)` : '';
    const params = accessIds && accessIds.length
      ? [note || null, req.user.id, req.params.id, companyId, accessIds]
      : [note || null, req.user.id, req.params.id, companyId];
    const result = await pool.query(
      `UPDATE time_entries SET status = 'rejected', approval_note = $1, approved_by = $2, approved_at = NOW()
       WHERE id = $3 AND company_id = $4 ${workerFilter} RETURNING *`,
      params
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Entry not found' });
    await logAudit(companyId, req.user.id, req.user.full_name, 'entry.rejected', 'time_entry', parseInt(req.params.id), null, { note });
    const rejWorker = await pool.query('SELECT email, full_name FROM users WHERE id = $1', [result.rows[0].user_id]);
    if (rejWorker.rows[0]?.email) {
      const { work_date, start_time, end_time } = result.rows[0];
      sendEmail(rejWorker.rows[0].email, 'Time entry rejected',
        `<p>Hi ${escapeHtml(rejWorker.rows[0].full_name)},</p><p>Your time entry for <b>${work_date?.toString().substring(0,10)}</b> (${start_time}–${end_time}) was <b style="color:#ef4444">rejected</b>${note ? ` with the note: <i>${escapeHtml(note)}</i>` : ''}.</p><p>Please log in to review and resubmit.</p><p>— OpsFloa</p>`);
    }
    const rejEntry = result.rows[0];
    sendPushToUser(rejEntry.user_id, {
      title: 'Time entry rejected',
      body: note ? `Reason: ${note}` : 'An admin rejected your time entry.',
      url: '/timeclock',
    });
    createInboxItem(rejEntry.user_id, companyId, 'rejection', 'Time entry rejected',
      `Your entry for ${rejEntry.work_date?.toString().substring(0,10)} was rejected.${note ? ` Reason: ${note}` : ''}`, '/timeclock');
    res.json(rejEntry);

    // QBO cleanup — void the time activity if already synced
    if (rejEntry.qbo_activity_id && rejEntry.qbo_activity_id !== 'synced') {
      setImmediate(async () => {
        try {
          await qbo.deleteTimeActivity(companyId, rejEntry.qbo_activity_id);
          await pool.query('UPDATE time_entries SET qbo_activity_id = NULL, qbo_synced_at = NULL WHERE id = $1 AND company_id = $2', [rejEntry.id, companyId]);
        } catch (err) { logger.error({ err }, '[QBO delete on reject]'); }
      });
    }
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/entries/:id/unapprove — revert an approved entry back to pending
router.patch('/entries/:id/unapprove', requireAdmin, requirePerm('approve_entries'), async (req, res) => {
  const companyId = req.user.company_id;
  const accessIds = req.user.worker_access_ids;
  try {
    // Fetch existing qbo_activity_id before clearing it
    const existing = await pool.query('SELECT qbo_activity_id FROM time_entries WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    const existingActivityId = existing.rows[0]?.qbo_activity_id;

    const workerFilter = accessIds && accessIds.length ? `AND user_id = ANY($3)` : '';
    const params = accessIds && accessIds.length ? [req.params.id, companyId, accessIds] : [req.params.id, companyId];
    const result = await pool.query(
      `UPDATE time_entries
       SET status = 'pending', locked = false, approved_by = NULL, approved_at = NULL, approval_note = NULL,
           qbo_activity_id = NULL, qbo_synced_at = NULL
       WHERE id = $1 AND company_id = $2 AND status = 'approved' ${workerFilter}
       RETURNING *`,
      params
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Entry not found or not in approved state' });
    await logAudit(companyId, req.user.id, req.user.full_name, 'entry.unapproved', 'time_entry', parseInt(req.params.id), null);
    res.json(result.rows[0]);

    // QBO cleanup — delete the time activity that was previously pushed
    if (existingActivityId && existingActivityId !== 'synced') {
      setImmediate(async () => {
        try { await qbo.deleteTimeActivity(companyId, existingActivityId); }
        catch (err) { logger.error({ err }, '[QBO delete on unapprove]'); }
      });
    }
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/entries/:id/unlock
router.patch('/entries/:id/unlock', requireAdmin, requirePerm('approve_entries'), async (req, res) => {
  const companyId = req.user.company_id;
  const accessIds = req.user.worker_access_ids;
  try {
    const workerFilter = accessIds && accessIds.length ? `AND user_id = ANY($3)` : '';
    const params = accessIds && accessIds.length ? [req.params.id, companyId, accessIds] : [req.params.id, companyId];
    const result = await pool.query(
      `UPDATE time_entries SET locked = false WHERE id = $1 AND company_id = $2 ${workerFilter} RETURNING *`,
      params
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Entry not found' });
    await logAudit(companyId, req.user.id, req.user.full_name, 'entry.unlocked', 'time_entry', parseInt(req.params.id), null);
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// Pay periods
router.get('/pay-periods', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pp.*, u.full_name as locked_by_name
       FROM pay_periods pp LEFT JOIN users u ON pp.locked_by = u.id
       WHERE pp.company_id = $1 ORDER BY pp.period_start DESC`,
      [req.user.company_id]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

router.post('/pay-periods', requireAdmin, requirePerm('approve_entries'), async (req, res) => {
  const { period_start, period_end, label } = req.body;
  if (!period_start || !period_end) return res.status(400).json({ error: 'period_start and period_end required' });
  if (period_start >= period_end) return res.status(400).json({ error: 'period_end must be after period_start' });
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `INSERT INTO pay_periods (company_id, period_start, period_end, label, locked_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [companyId, period_start, period_end, label || null, req.user.id]
    );
    await logAudit(companyId, req.user.id, req.user.full_name, 'pay_period.locked', 'pay_period', result.rows[0].id, label || `${period_start} – ${period_end}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A pay period overlapping those dates already exists' });
    req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/pay-periods/:id', requireAdmin, requirePerm('approve_entries'), async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      'DELETE FROM pay_periods WHERE id = $1 AND company_id = $2 RETURNING *',
      [req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Pay period not found' });
    await logAudit(companyId, req.user.id, req.user.full_name, 'pay_period.unlocked', 'pay_period', parseInt(req.params.id), result.rows[0].label);
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// CSV Export
router.get('/export', requireAdmin, requirePerm('view_reports'), requirePlan('starter'), async (req, res) => {
  const { from, to, worker_id, project_id, status } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const companyId = req.user.company_id;
  const conditions = ['te.company_id = $1', 'te.work_date >= $2', 'te.work_date <= $3'];
  const values = [companyId, from, to];
  let idx = 4;
  if (worker_id) { conditions.push(`te.user_id = $${idx++}`); values.push(parseInt(worker_id)); }
  if (project_id) { conditions.push(`te.project_id = $${idx++}`); values.push(parseInt(project_id)); }
  if (status) { conditions.push(`te.status = $${idx++}`); values.push(status); }
  try {
    const result = await pool.query(
      `SELECT te.*, COALESCE(u.invoice_name, u.full_name) as worker_name, p.name as project_name,
              to_char(te.work_date, 'YYYY-MM-DD') as work_date_str
       FROM time_entries te
       JOIN users u ON te.user_id = u.id
       LEFT JOIN projects p ON te.project_id = p.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY te.work_date, COALESCE(u.invoice_name, u.full_name), te.start_time`,
      values
    );
    const esc = csvCell; // RFC-4180 quoting + spreadsheet formula-injection guard
    const fmtTime = t => { const [h, m] = t.split(':'); const hr = parseInt(h); return `${hr % 12 || 12}:${m} ${hr < 12 ? 'AM' : 'PM'}`; };
    const netHours = (s, e, brk) => (hoursWorked(s, e) - (brk || 0) / 60).toFixed(2);
    const headers = ['Worker', 'Project', 'Date', 'Start', 'End', 'Break (min)', 'Net Hours', 'Wage Type', 'Mileage (mi)', 'Status', 'Notes'];
    const lines = [
      headers.join(','),
      ...result.rows.map(r => [
        esc(r.worker_name), esc(r.project_name), esc(r.work_date_str),
        esc(fmtTime(r.start_time)), esc(fmtTime(r.end_time)),
        r.break_minutes || 0, netHours(r.start_time, r.end_time, r.break_minutes),
        esc(r.wage_type), r.mileage != null ? parseFloat(r.mileage).toFixed(1) : '',
        esc(r.status || 'pending'), esc(r.notes),
      ].join(',')),
    ];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="timecrunch-${from}-to-${to}.csv"`);
    res.send(lines.join('\r\n'));
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// Overtime report
router.get('/overtime-report', requireAdmin, requirePerm('view_reports'), requirePlan('starter'), async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const companyId = req.user.company_id;
  try {
    const s = await getSettings(companyId);
    const rule = s.overtime_rule || 'daily';
    const threshold = parseFloat(s.overtime_threshold) || 8;
    const otMult = parseFloat(s.overtime_multiplier) || 1.5;
    const defaultRate = parseFloat(s.default_hourly_rate) || 30;
    const prevRate = parseFloat(s.prevailing_wage_rate) || 45;

    const workers = await pool.query(
      `SELECT u.id, u.full_name, u.invoice_name, u.hourly_rate, u.rate_type, u.overtime_rule, u.role_id FROM users u
       WHERE u.company_id = $1 AND u.role = 'worker' AND u.active = true
       ORDER BY u.full_name`,
      [companyId]
    );
    const entries = await pool.query(
      `SELECT te.user_id, te.project_id, te.wage_type, te.start_time, te.end_time, te.work_date, te.break_minutes, te.mileage
       FROM time_entries te
       WHERE te.company_id = $1 AND te.work_date >= $2 AND te.work_date <= $3 AND te.status = 'approved'`,
      [companyId, from, to]
    );
    const projectRates = await pool.query(
      'SELECT id, prevailing_wage_rate FROM projects WHERE company_id = $1', [companyId]
    );
    const projectRateMap = {};
    projectRates.rows.forEach(p => { if (p.prevailing_wage_rate != null) projectRateMap[p.id] = parseFloat(p.prevailing_wage_rate); });

    const otWorkerRoleById = {};
    workers.rows.forEach(w => { otWorkerRoleById[w.id] = w.role_id; });
    const paidRows = roundEntriesFromSettings(entries.rows, s, { workerRoleById: otWorkerRoleById });
    const byWorker = {};
    paidRows.forEach(e => {
      if (!byWorker[e.user_id]) byWorker[e.user_id] = [];
      byWorker[e.user_id].push(e);
    });

    const otConfigByRole = otConfigByRoleFactory(s);
    const leaveByUser = await computeCompanyLeave({ companyId, workers: workers.rows, settings: s, from, to });
    const leaveMult = leaveRateMultipliers(s);
    const rows = workers.rows.map(w => {
      const wEntries = byWorker[w.id] || [];
      const workerOTRule = w.overtime_rule || 'daily';
      const otConfig = otConfigByRole(w.role_id);
      const { regularHours, overtimeHours, otBands } = computeOT(wEntries, workerOTRule, threshold, s.week_start, otConfig, { from, to });
      let prevHours = 0, prevailingCost = 0;
      wEntries.filter(e => e.wage_type === 'prevailing').forEach(e => {
        const h = hoursWorked(e.start_time, e.end_time) - (e.break_minutes || 0) / 60;
        prevHours += h;
        prevailingCost += h * (projectRateMap[e.project_id] ?? prevRate);
      });
      const totalHours = regularHours + overtimeHours + prevHours;
      const rate = parseFloat(w.hourly_rate) || defaultRate;
      let regularCost, overtimeCost;
      if (w.rate_type === 'daily') {
        const dc = computeDailyPayCosts(wEntries, workerOTRule, threshold, rate, otMult, otConfig);
        regularCost = dc.regularCost;
        overtimeCost = dc.overtimeCost;
      } else {
        regularCost = regularHours * rate;
        overtimeCost = otBandsCost(otBands, rate, otMult)
          + nightPremiumCost(wEntries, otConfig && otConfig.nightDifferential, rate);
      }
      const { sick: sickHours, vacation: vacationHours } = leaveByUser.get(w.id) || { sick: 0, vacation: 0 };
      const sickCost = sickHours * rate * leaveMult.sick;
      const vacationCost = vacationHours * rate * leaveMult.vacation;
      const totalCost = regularCost + overtimeCost + prevailingCost + sickCost + vacationCost;
      const mileage = wEntries.reduce((s, e) => s + (parseFloat(e.mileage) || 0), 0);
      return {
        worker_id: w.id, worker_name: w.invoice_name || w.full_name, rate, rate_type: w.rate_type || 'hourly', overtime_rule: workerOTRule,
        regular_hours: parseFloat(regularHours.toFixed(2)),
        overtime_hours: parseFloat(overtimeHours.toFixed(2)),
        prevailing_hours: parseFloat(prevHours.toFixed(2)),
        sick_hours: parseFloat(sickHours.toFixed(2)),
        vacation_hours: parseFloat(vacationHours.toFixed(2)),
        total_hours: parseFloat(totalHours.toFixed(2)),
        mileage: parseFloat(mileage.toFixed(1)),
        regular_cost: parseFloat(regularCost.toFixed(2)),
        overtime_cost: parseFloat(overtimeCost.toFixed(2)),
        prevailing_cost: parseFloat(prevailingCost.toFixed(2)),
        sick_cost: parseFloat(sickCost.toFixed(2)),
        vacation_cost: parseFloat(vacationCost.toFixed(2)),
        total_cost: parseFloat(totalCost.toFixed(2)),
      };
    });
    res.json(rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// Payroll export CSV
router.get('/payroll-export', requireAdmin, requirePerm('view_reports'), requirePlan('starter'), async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const companyId = req.user.company_id;
  try {
    const s = await getSettings(companyId);
    const rule = s.overtime_rule || 'daily';
    const threshold = parseFloat(s.overtime_threshold) || 8;
    const otMult = parseFloat(s.overtime_multiplier) || 1.5;
    const defaultRate = parseFloat(s.default_hourly_rate) || 30;
    const prevRate = parseFloat(s.prevailing_wage_rate) || 45;

    const workers = await pool.query(
      `SELECT u.id, u.full_name, u.invoice_name, u.hourly_rate, u.rate_type, u.overtime_rule, u.role_id FROM users u
       WHERE u.company_id = $1 AND u.role = 'worker' AND u.active = true
       ORDER BY u.full_name`,
      [companyId]
    );
    const entries = await pool.query(
      `SELECT te.user_id, te.project_id, te.wage_type, te.start_time, te.end_time, te.work_date, te.break_minutes, te.mileage
       FROM time_entries te
       WHERE te.company_id = $1 AND te.work_date >= $2 AND te.work_date <= $3 AND te.status = 'approved'`,
      [companyId, from, to]
    );
    const projectRatesExport = await pool.query(
      'SELECT id, prevailing_wage_rate FROM projects WHERE company_id = $1', [companyId]
    );
    const projectRateMapExport = {};
    projectRatesExport.rows.forEach(p => { if (p.prevailing_wage_rate != null) projectRateMapExport[p.id] = parseFloat(p.prevailing_wage_rate); });

    const exportRoleById = {};
    workers.rows.forEach(w => { exportRoleById[w.id] = w.role_id; });
    const paidRows = roundEntriesFromSettings(entries.rows, s, { workerRoleById: exportRoleById });
    const byWorker = {};
    paidRows.forEach(e => {
      if (!byWorker[e.user_id]) byWorker[e.user_id] = [];
      byWorker[e.user_id].push(e);
    });

    const esc = csvCell; // RFC-4180 quoting + spreadsheet formula-injection guard
    const headers = ['Worker', 'Rate Type', 'Overtime', 'Rate', 'Regular Hrs', 'OT Hrs', 'Prevailing Hrs', 'Sick Hrs', 'Vacation Hrs', 'Total Hrs', 'Mileage (mi)', 'Regular Pay', 'OT Pay', 'Prevailing Pay', 'Sick Pay', 'Vacation Pay', 'Total Pay'];
    const lines = [headers.join(',')];

    const otConfigByRole = otConfigByRoleFactory(s);
    const leaveByUser = await computeCompanyLeave({ companyId, workers: workers.rows, settings: s, from, to });
    const leaveMult = leaveRateMultipliers(s);
    workers.rows.forEach(w => {
      const wEntries = byWorker[w.id] || [];
      const workerOTRule = w.overtime_rule || 'daily';
      const otConfig = otConfigByRole(w.role_id);
      const { regularHours, overtimeHours, otBands } = computeOT(wEntries, workerOTRule, threshold, s.week_start, otConfig, { from, to });
      let prevHours = 0, prevailingCost = 0;
      wEntries.filter(e => e.wage_type === 'prevailing').forEach(e => {
        const h = hoursWorked(e.start_time, e.end_time) - (e.break_minutes || 0) / 60;
        prevHours += h;
        prevailingCost += h * (projectRateMapExport[e.project_id] ?? prevRate);
      });
      const rate = parseFloat(w.hourly_rate) || defaultRate;
      const mileage = wEntries.reduce((s, e) => s + (parseFloat(e.mileage) || 0), 0);
      let regularCost, overtimeCost;
      if (w.rate_type === 'daily') {
        const dc = computeDailyPayCosts(wEntries, workerOTRule, threshold, rate, otMult, otConfig);
        regularCost = dc.regularCost;
        overtimeCost = dc.overtimeCost;
      } else {
        regularCost = regularHours * rate;
        overtimeCost = otBandsCost(otBands, rate, otMult)
          + nightPremiumCost(wEntries, otConfig && otConfig.nightDifferential, rate);
      }
      const { sick: sickHours, vacation: vacationHours } = leaveByUser.get(w.id) || { sick: 0, vacation: 0 };
      const sickCost = sickHours * rate * leaveMult.sick;
      const vacationCost = vacationHours * rate * leaveMult.vacation;
      lines.push([
        esc(w.invoice_name || w.full_name), w.rate_type || 'hourly', workerOTRule, rate.toFixed(2),
        regularHours.toFixed(2), overtimeHours.toFixed(2), prevHours.toFixed(2),
        sickHours.toFixed(2),
        vacationHours.toFixed(2),
        (regularHours + overtimeHours + prevHours).toFixed(2),
        mileage.toFixed(1),
        regularCost.toFixed(2),
        overtimeCost.toFixed(2),
        prevailingCost.toFixed(2),
        sickCost.toFixed(2),
        vacationCost.toFixed(2),
        (regularCost + overtimeCost + prevailingCost + sickCost + vacationCost).toFixed(2),
      ].join(','));
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="payroll-${from}-to-${to}.csv"`);
    res.send(lines.join('\r\n'));
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /admin/export/worker-hours — one CSV row per worker with their APPROVED
// hours (Regular / OT / Total + days worked) over a date range. A leaner sibling
// of /payroll-export (no pay/rate columns). Honors the acting admin's
// worker_access_ids scope.
router.get('/export/worker-hours', requireAdmin, requirePerm('view_reports'), requirePlan('starter'), async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  const companyId = req.user.company_id;
  const accessIds = req.user.worker_access_ids;
  try {
    const s = await getSettings(companyId);
    const threshold = parseFloat(s.overtime_threshold) || 8;
    const weekStart = s.week_start;

    const wConds = ['company_id = $1', "role = 'worker'", 'active = true'];
    const wVals = [companyId];
    if (accessIds && accessIds.length) { wVals.push(accessIds); wConds.push(`id = ANY($${wVals.length})`); }
    const workers = await pool.query(
      `SELECT id, full_name, invoice_name, overtime_rule, role_id FROM users WHERE ${wConds.join(' AND ')} ORDER BY full_name`,
      wVals
    );

    const eConds = ['company_id = $1', 'work_date >= $2', 'work_date <= $3', "status = 'approved'"];
    const eVals = [companyId, from, to];
    if (accessIds && accessIds.length) { eVals.push(accessIds); eConds.push(`user_id = ANY($${eVals.length})`); }
    const entries = await pool.query(
      `SELECT user_id, start_time, end_time, work_date, break_minutes FROM time_entries WHERE ${eConds.join(' AND ')}`,
      eVals
    );

    const whRoleById = {};
    workers.rows.forEach(w => { whRoleById[w.id] = w.role_id; });
    const paidRows = roundEntriesFromSettings(entries.rows, s, { workerRoleById: whRoleById });
    const byWorker = {};
    paidRows.forEach(e => { (byWorker[e.user_id] = byWorker[e.user_id] || []).push(e); });

    const netHours = e => hoursWorked(e.start_time, e.end_time) - (e.break_minutes || 0) / 60;
    const dayKey = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

    const lines = [['Worker', 'Regular Hrs', 'OT Hrs', 'Total Hrs', 'Days Worked'].join(',')];
    let tReg = 0, tOt = 0, tTot = 0, tDays = 0;
    for (const w of workers.rows) {
      const we = byWorker[w.id] || [];
      const total = we.reduce((sum, e) => sum + netHours(e), 0);
      const { overtimeHours } = computeOT(we, w.overtime_rule || 'daily', threshold, weekStart);
      const ot = Math.min(overtimeHours, total);     // OT can't exceed total worked
      const regular = Math.max(0, total - ot);        // Regular = Total − OT (no double count)
      const days = new Set(we.map(e => dayKey(e.work_date))).size;
      tReg += regular; tOt += ot; tTot += total; tDays += days;
      lines.push([csvCell(w.invoice_name || w.full_name), regular.toFixed(2), ot.toFixed(2), total.toFixed(2), days].join(','));
    }
    lines.push([csvCell('TOTAL'), tReg.toFixed(2), tOt.toFixed(2), tTot.toFixed(2), tDays].join(','));

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="worker-hours-${from}-to-${to}.csv"`);
    res.send(lines.join('\r\n'));
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /admin/company — company profile
router.get('/company', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, subscription_status, trial_ends_at, plan, address, phone, contact_email, logo_url FROM companies WHERE id = $1',
      [req.user.company_id]
    );
    res.json(result.rows[0] || {});
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /admin/company — update company profile
router.patch('/company', requireAdmin, async (req, res) => {
  const { name, address, phone, contact_email } = req.body;
  if (name !== undefined && !name?.trim()) return res.status(400).json({ error: 'name cannot be empty' });
  try {
    const fields = [];
    const values = [];
    let idx = 1;
    if (name !== undefined) {
      const existing = await pool.query('SELECT id FROM companies WHERE lower(name) = lower($1) AND id != $2', [name.trim(), req.user.company_id]);
      if (existing.rowCount > 0) return res.status(409).json({ error: 'That company name is already taken' });
      fields.push(`name = $${idx++}`); values.push(name.trim());
    }
    if (address !== undefined) { fields.push(`address = $${idx++}`); values.push(address || null); }
    if (phone !== undefined) { fields.push(`phone = $${idx++}`); values.push(phone || null); }
    if (contact_email !== undefined) { fields.push(`contact_email = $${idx++}`); values.push(contact_email || null); }
    if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    values.push(req.user.company_id);
    const result = await pool.query(
      `UPDATE companies SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, name, address, phone, contact_email, logo_url`,
      values
    );
    await logAudit(req.user.company_id, req.user.id, req.user.full_name, 'company.updated', 'company', req.user.company_id, result.rows[0].name);
    res.json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /admin/company/logo — upload/replace the company logo (base64 → R2)
router.post('/company/logo', requireAdmin, async (req, res) => {
  const { dataUrl } = req.body;
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return res.status(400).json({ error: 'An image file is required' });
  }
  // logos are small; cap the raw base64 string (~2MB of image)
  if (dataUrl.length > 2_800_000) return res.status(413).json({ error: 'Logo is too large (max ~2 MB)' });
  try {
    const { uploadBase64, deleteByUrl } = require('../r2');
    const prev = await pool.query('SELECT logo_url FROM companies WHERE id = $1', [req.user.company_id]);
    const { url } = await uploadBase64(dataUrl, 'company-logos');
    await pool.query('UPDATE companies SET logo_url = $1 WHERE id = $2', [url, req.user.company_id]);
    const old = prev.rows[0]?.logo_url;
    if (old && old !== url) deleteByUrl(old).catch(() => {}); // best-effort cleanup of the replaced file
    await logAudit(req.user.company_id, req.user.id, req.user.full_name, 'company.logo_updated', 'company', req.user.company_id, null);
    res.json({ logo_url: url });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Upload failed' }); }
});

// DELETE /admin/company/logo — remove the company logo
router.delete('/company/logo', requireAdmin, async (req, res) => {
  try {
    const { deleteByUrl } = require('../r2');
    const prev = await pool.query('SELECT logo_url FROM companies WHERE id = $1', [req.user.company_id]);
    await pool.query('UPDATE companies SET logo_url = NULL WHERE id = $1', [req.user.company_id]);
    const old = prev.rows[0]?.logo_url;
    if (old) deleteByUrl(old).catch(() => {});
    await logAudit(req.user.company_id, req.user.id, req.user.full_name, 'company.logo_removed', 'company', req.user.company_id, null);
    res.json({ ok: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// Audit log
router.get('/audit-log', requireAdmin, requirePerm('view_reports'), async (req, res) => {
  const companyId = req.user.company_id;
  const limit = parseInt(req.query.limit) || 30;
  const offset = parseInt(req.query.offset) || 0;
  const { group, from, to } = req.query;
  const conditions = ['company_id = $1'];
  const values = [companyId];
  let idx = 2;
  if (group) {
    if (!/^[a-zA-Z0-9_]+$/.test(group)) return res.status(400).json({ error: 'Invalid group' });
    conditions.push(`action LIKE $${idx++}`); values.push(`${group}.%`);
  }
  if (from) { conditions.push(`created_at >= $${idx++}`); values.push(from); }
  if (to) { conditions.push(`created_at < ($${idx++}::date + interval '1 day')`); values.push(to); }
  const where = conditions.join(' AND ');
  try {
    const result = await pool.query(
      `SELECT id, actor_name, action, entity_type, entity_id, entity_name, details, created_at
       FROM audit_log WHERE ${where}
       ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, limit, offset]
    );
    const total = await pool.query(`SELECT COUNT(*) FROM audit_log WHERE ${where}`, values);
    res.json({ entries: result.rows, total: parseInt(total.rows[0].count) });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /admin/broadcast — push a message to all active workers
router.post('/broadcast', requireAdmin, requirePerm('manage_settings'), requirePlan('business'), async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });
  if (message.length > 200) return res.status(400).json({ error: 'Message must be 200 characters or fewer' });
  const companyId = req.user.company_id;
  await sendPushToAllWorkers(companyId, {
    title: `📢 ${req.user.company_name || 'Announcement'}`,
    body: message.trim(),
    url: '/timeclock',
  });
  // Create inbox item for every active worker (single batch insert)
  const broadcastWorkers = await pool.query(
    `SELECT id FROM users WHERE company_id = $1 AND role = 'worker' AND active = true`,
    [companyId]
  );
  createInboxItemBatch(
    broadcastWorkers.rows.map(w => w.id),
    companyId, 'announcement',
    `📢 ${req.user.company_name || 'Announcement'}`,
    message.trim(), '/timeclock'
  );
  await logAudit(companyId, req.user.id, req.user.full_name, 'broadcast.sent', null, null, null, { message: message.trim() });
  res.json({ sent: true });
});

// GET /admin/certified-payroll?week_end=YYYY-MM-DD&project_id=N
// Returns prevailing-wage hours by worker broken down by day of week for a 7-day window
router.get('/certified-payroll', requireAdmin, requirePerm('view_reports'), requireCertifiedPayrollAddon, async (req, res) => {
  const { week_end, project_id } = req.query;
  if (!week_end) return res.status(400).json({ error: 'week_end required' });
  const companyId = req.user.company_id;

  const weekEndDate = new Date(week_end + 'T00:00:00');
  const weekStartDate = new Date(weekEndDate);
  weekStartDate.setDate(weekStartDate.getDate() - 6);
  const weekStart = weekStartDate.toISOString().substring(0, 10);

  try {
    const companyRow = await pool.query('SELECT name FROM companies WHERE id = $1', [companyId]);
    const contractor = companyRow.rows[0]?.name || '';

    let projectName = null;
    let projectPrevRate = null;
    if (project_id) {
      const pr = await pool.query('SELECT name, prevailing_wage_rate FROM projects WHERE id = $1 AND company_id = $2', [project_id, companyId]);
      projectName = pr.rows[0]?.name || null;
      projectPrevRate = pr.rows[0]?.prevailing_wage_rate != null ? parseFloat(pr.rows[0].prevailing_wage_rate) : null;
    }

    const conditions = ['te.company_id = $1', 'te.work_date >= $2', 'te.work_date <= $3'];
    const values = [companyId, weekStart, week_end];
    let idx = 4;
    if (project_id) { conditions.push(`te.project_id = $${idx++}`); values.push(parseInt(project_id)); }

    const result = await pool.query(
      `SELECT te.user_id, COALESCE(u.invoice_name, u.full_name) as worker_name, u.hourly_rate, u.classification, u.role_id,
              to_char(te.work_date, 'YYYY-MM-DD') as work_date,
              te.start_time, te.end_time, te.break_minutes, te.wage_type,
              te.classification AS entry_classification
       FROM time_entries te
       JOIN users u ON te.user_id = u.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY COALESCE(u.invoice_name, u.full_name), te.work_date, te.start_time`,
      values
    );

    const s = await getSettings(companyId);
    const defaultRate = parseFloat(s.default_hourly_rate) || 30;
    const prevRate = projectPrevRate ?? parseFloat(s.prevailing_wage_rate) ?? 45;

    const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const workerMap = {};

    const cpRoleById = {};
    result.rows.forEach(r => { cpRoleById[r.user_id] = r.role_id; });
    for (const row of roundEntriesFromSettings(result.rows, s, { workerRoleById: cpRoleById })) {
      if (!workerMap[row.user_id]) {
        workerMap[row.user_id] = {
          worker_id: row.user_id,
          worker_name: row.worker_name,
          rate: parseFloat(row.hourly_rate) || defaultRate,
          classification: row.entry_classification || row.classification || null,
          regular_days: { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 },
          prevailing_days: { mon: 0, tue: 0, wed: 0, thu: 0, fri: 0, sat: 0, sun: 0 },
        };
      }
      const w = workerMap[row.user_id];
      const dayKey = DAY_KEYS[new Date(row.work_date + 'T00:00:00').getDay()];
      const h = hoursWorked(row.start_time, row.end_time) - (row.break_minutes || 0) / 60;
      if (row.wage_type === 'prevailing') {
        w.prevailing_days[dayKey] = +(w.prevailing_days[dayKey] + h).toFixed(2);
      } else {
        w.regular_days[dayKey] = +(w.regular_days[dayKey] + h).toFixed(2);
      }
    }

    // Pull fringes and SSN last-4 (both gated by feature flags; the CP addon
    // being off silently yields empty values).
    const userIds = Object.keys(workerMap).map(Number);
    const { loadSsnLast4 } = require('./certifiedPayroll');
    const [fringesRows, ssnMap] = await Promise.all([
      userIds.length ? pool.query('SELECT user_id, category, rate_per_hour FROM worker_fringes WHERE user_id = ANY($1::int[])', [userIds]) : Promise.resolve({ rows: [] }),
      s.cp_collect_ssn !== false ? loadSsnLast4(userIds) : {},
    ]);
    const fringesByUser = {};
    for (const r of fringesRows.rows) {
      (fringesByUser[r.user_id] ||= {})[r.category] = parseFloat(r.rate_per_hour);
    }

    const workers = Object.values(workerMap).map(w => {
      const regTotal = +Object.values(w.regular_days).reduce((s, h) => s + h, 0).toFixed(2);
      const prevTotal = +Object.values(w.prevailing_days).reduce((s, h) => s + h, 0).toFixed(2);
      const total = +(regTotal + prevTotal).toFixed(2);
      const fringes = fringesByUser[w.worker_id] || {};
      const fringeTotalPerHour = Object.values(fringes).reduce((a, b) => a + b, 0);
      return {
        ...w,
        regular_total: regTotal,
        prevailing_total: prevTotal,
        total,
        prevailing_rate: prevRate,
        ssn_last4: ssnMap[w.worker_id] || null,
        fringes,
        fringe_total_per_hour: +fringeTotalPerHour.toFixed(4),
        gross_pay: +((regTotal * w.rate) + (prevTotal * prevRate)).toFixed(2),
      };
    });

    // Pull the signature for this report window, if any.
    const sigParams = [companyId, week_end];
    let sigProjectClause = 'AND project_id IS NULL';
    if (project_id) { sigParams.push(project_id); sigProjectClause = `AND project_id = $${sigParams.length}`; }
    const sigRes = await pool.query(
      `SELECT signer_name, signer_title, compliance_text, signed_at
         FROM certified_payroll_signatures
        WHERE company_id = $1 AND week_ending = $2 ${sigProjectClause}
        ORDER BY signed_at DESC LIMIT 1`,
      sigParams
    );

    res.json({
      week_start: weekStart,
      week_end,
      contractor,
      project: projectName,
      workers,
      signature: sigRes.rows[0] || null,
      settings: {
        cp_track_classifications: s.cp_track_classifications !== false,
        cp_track_fringes:         s.cp_track_fringes !== false,
        cp_collect_ssn:           s.cp_collect_ssn !== false,
        cp_require_signature:     s.cp_require_signature !== false,
        cp_wh347_format:          s.cp_wh347_format !== false,
      },
    });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

router.post('/support', requireAdmin, async (req, res) => {
  const { subject, message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });
  const { sendEmail } = require('../email');
  const companyName = req.user.company_name || 'Unknown company';
  const userName = req.user.full_name || req.user.username || 'Unknown user';
  const userEmail = req.user.email || '';
  const subjectLine = subject?.trim() ? subject.trim() : 'Support Request';
  const body = '<p><strong>From:</strong> ' + escapeHtml(userName) + ' (' + escapeHtml(userEmail) + ')</p>' +
    '<p><strong>Company:</strong> ' + escapeHtml(companyName) + '</p>' +
    '<p><strong>Subject:</strong> ' + escapeHtml(subjectLine) + '</p><hr/>' +
    '<p>' + escapeHtml(message.trim()).replace(/\n/g, '<br/>') + '</p>';
  await sendEmail('support@opsfloa.com', '[OpsFloa Support] ' + subjectLine + ' — ' + companyName, body);
  res.json({ ok: true });
});

// POST /admin/projects/:id/rfis — create a new RFI
router.post('/projects/:id/rfis', requireAdmin, async (req, res) => {
  const { subject, directed_to, description, date_submitted, date_due } = req.body;
  if (!subject?.trim()) return res.status(400).json({ error: 'subject is required' });
  const companyId = req.user.company_id;
  try {
    const projCheck = await pool.query('SELECT id FROM projects WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    if (projCheck.rowCount === 0) return res.status(404).json({ error: 'Project not found' });
    const maxNum = await pool.query(
      'SELECT COALESCE(MAX(rfi_number), 0) + 1 AS next FROM rfis WHERE project_id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    const rfi_number = maxNum.rows[0].next;
    const today = new Date().toLocaleDateString('en-CA');
    const result = await pool.query(
      `INSERT INTO rfis (company_id, project_id, rfi_number, subject, description, directed_to, submitted_by, date_submitted, date_due, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open')
       RETURNING id, rfi_number, subject, status, directed_to, date_submitted, date_due`,
      [companyId, req.params.id, rfi_number, subject.trim(), description || null,
       directed_to || null, req.user.full_name, date_submitted || today, date_due || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// ── Clients ───────────────────────────────────────────────────────────────────

router.get('/clients', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `SELECT c.*,
        COUNT(DISTINCT p.id) FILTER (WHERE p.active = true) AS project_count,
        COUNT(DISTINCT d.id) AS document_count,
        MIN(d.expires_at) FILTER (WHERE d.expires_at IS NOT NULL AND d.expires_at >= CURRENT_DATE) AS next_expiry
       FROM clients c
       LEFT JOIN projects p ON p.client_id = c.id AND p.company_id = $1
       LEFT JOIN client_documents d ON d.client_id = c.id AND d.company_id = $1
       WHERE c.company_id = $1 AND c.active = true
       GROUP BY c.id
       ORDER BY c.name`,
      [companyId]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

router.post('/clients', requireAdmin, async (req, res) => {
  const { name, contact_name, contact_email, contact_phone, address, notes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Client name is required' });
  // Preferred document language for estimate/CO PDFs; falls back to
  // English if absent or unrecognised. CHECK constraint is the backstop.
  const VALID_LANGUAGES = ['English', 'Spanish'];
  const language = VALID_LANGUAGES.includes(req.body.language) ? req.body.language : 'English';
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `INSERT INTO clients (company_id, name, contact_name, contact_email, contact_phone, address, notes, language)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [companyId, name.trim(), contact_name || null, contact_email || null,
       contact_phone || null, address || null, notes || null, language]
    );
    res.status(201).json({ ...result.rows[0], project_count: 0, document_count: 0 });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

router.patch('/clients/:id', requireAdmin, async (req, res) => {
  const { name, contact_name, contact_email, contact_phone, address, notes } = req.body;
  const clientUpdatedAt = req.body.updated_at || null;
  if (!name?.trim()) return res.status(400).json({ error: 'Client name is required' });
  const VALID_LANGUAGES = ['English', 'Spanish'];
  const language = VALID_LANGUAGES.includes(req.body.language) ? req.body.language : 'English';
  const companyId = req.user.company_id;
  try {
    if (clientUpdatedAt) {
      const cur = await pool.query('SELECT updated_at FROM clients WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
      if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
      if (new Date(cur.rows[0].updated_at).getTime() !== new Date(clientUpdatedAt).getTime()) {
        return res.status(409).json({ error: 'conflict' });
      }
    }
    const result = await pool.query(
      `UPDATE clients SET name=$1, contact_name=$2, contact_email=$3, contact_phone=$4,
       address=$5, notes=$6, language=$7, updated_at=NOW() WHERE id=$8 AND company_id=$9 RETURNING *`,
      [name.trim(), contact_name || null, contact_email || null, contact_phone || null,
       address || null, notes || null, language, req.params.id, companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

router.delete('/clients/:id', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'UPDATE clients SET active=false WHERE id=$1 AND company_id=$2 RETURNING id',
      [req.params.id, companyId]
    );
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Client not found' });
    }
    await client.query('UPDATE projects SET client_id=NULL WHERE client_id=$1 AND company_id=$2', [req.params.id, companyId]);
    await client.query('COMMIT');
    res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  } finally { client.release(); }
});

// Client documents
const CLIENT_DOC_TYPES = ['w9', 'w2', 'coi', 'contract', 'license', 'other'];

router.post('/clients/:id/documents/upload', requireAdmin, async (req, res) => {
  const { dataUrl, name, doc_type, expires_at, direction } = req.body;
  if (!dataUrl || !name) return res.status(400).json({ error: 'dataUrl and name required' });
  const companyId = req.user.company_id;
  const CLIENT_DOC_TYPES_LOCAL = ['coi', 'w9', 'w2', 'contract', 'license', 'other'];
  const safeType = CLIENT_DOC_TYPES_LOCAL.includes(doc_type) ? doc_type : 'other';
  const safeDir = direction === 'from_company' ? 'from_company' : 'from_client';
  try {
    const { uploadBase64 } = require('../r2');
    const { url, sizeBytes } = await uploadBase64(dataUrl, 'client-docs');
    const result = await pool.query(
      `INSERT INTO client_documents (company_id, client_id, name, url, size_bytes, doc_type, expires_at, uploaded_by, direction)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [companyId, req.params.id, name.trim(), url, sizeBytes || null,
       safeType, expires_at || null, req.user.id, safeDir]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Upload failed' }); }
});

router.post('/clients/:id/documents', requireAdmin, async (req, res) => {
  const { name, url, size_bytes, doc_type, expires_at } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  const companyId = req.user.company_id;
  const safeType = CLIENT_DOC_TYPES.includes(doc_type) ? doc_type : 'other';
  try {
    const clientCheck = await pool.query('SELECT id FROM clients WHERE id=$1 AND company_id=$2', [req.params.id, companyId]);
    if (clientCheck.rowCount === 0) return res.status(404).json({ error: 'Client not found' });
    const result = await pool.query(
      `INSERT INTO client_documents (company_id, client_id, name, url, size_bytes, doc_type, expires_at, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [companyId, req.params.id, name.trim(), url, size_bytes || null,
       safeType, expires_at || null, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

router.get('/clients/:id/documents', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `SELECT d.*, COALESCE(u.full_name, '') AS uploader_name
       FROM client_documents d
       LEFT JOIN users u ON d.uploaded_by = u.id
       WHERE d.client_id = $1 AND d.company_id = $2
       ORDER BY d.doc_type, d.created_at DESC`,
      [req.params.id, companyId]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

router.delete('/clients/:id/documents/:docId', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const doc = await pool.query(
      'SELECT url FROM client_documents WHERE id=$1 AND client_id=$2 AND company_id=$3',
      [req.params.docId, req.params.id, companyId]
    );
    if (doc.rowCount === 0) return res.status(404).json({ error: 'Document not found' });
    const { deleteByUrl } = require('../r2');
    await pool.query('DELETE FROM client_documents WHERE id=$1', [req.params.docId]);
    deleteByUrl(doc.rows[0].url).catch(() => {});
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// ── Worker Documents ────────────────────────────────────────────────────────

const { uploadBase64, deleteByUrl } = require('../r2');

router.get('/workers/:id/documents', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const result = await pool.query(
      `SELECT d.id, d.name, d.url, d.size_bytes, d.mime_type, d.created_at, u.full_name as uploaded_by_name
       FROM worker_documents d LEFT JOIN users u ON d.uploaded_by = u.id
       WHERE d.user_id = $1 AND d.company_id = $2 ORDER BY d.created_at DESC`,
      [req.params.id, companyId]
    );
    res.json(result.rows);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

router.post('/workers/:id/documents', requireAdmin, async (req, res) => {
  const { name, data } = req.body; // data = base64 data URL
  const trimmedName = name?.trim();
  if (!trimmedName || !data) return res.status(400).json({ error: 'name and data required' });
  if (trimmedName.length > 255) return res.status(400).json({ error: 'name too long' });
  const companyId = req.user.company_id;

  const workerCheck = await pool.query('SELECT id FROM users WHERE id = $1 AND company_id = $2', [req.params.id, companyId]).catch(() => null);
  if (!workerCheck?.rows.length) return res.status(404).json({ error: 'Worker not found' });

  let uploaded = null;
  try {
    uploaded = await uploadBase64(data, 'documents');
    const result = await pool.query(
      `INSERT INTO worker_documents (company_id, user_id, name, url, size_bytes, mime_type, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [companyId, req.params.id, trimmedName, uploaded.url, uploaded.sizeBytes || null,
       data.match(/^data:([^;]+)/)?.[1] || null, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (uploaded?.url) deleteByUrl(uploaded.url).catch(() => {});
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/workers/:id/documents/:docId', requireAdmin, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const doc = await pool.query(
      'SELECT url FROM worker_documents WHERE id = $1 AND user_id = $2 AND company_id = $3',
      [req.params.docId, req.params.id, companyId]
    );
    if (doc.rowCount === 0) return res.status(404).json({ error: 'Document not found' });
    await pool.query('DELETE FROM worker_documents WHERE id = $1 AND company_id = $2', [req.params.docId, companyId]);
    deleteByUrl(doc.rows[0].url).catch(() => {});
    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// ── Phase B: roles & permissions management ─────────────────────────────────
//
// Permission gates:
//   - GET  /roles, /permissions/catalog: requireAdmin only — anyone with the
//     admin dashboard needs to see the role list to pick from it. The picker
//     itself is still gated by assign_roles at the assign endpoint.
//   - POST/PATCH/DELETE /roles: requirePerm('manage_roles') — Owner-only
//     by default, but Owner can delegate by granting the perm to another role.
//   - PATCH /workers/:id/role: requirePerm('assign_roles') — usually all admins.
//
// Privilege-escalation guard: when creating or editing a role, the requester
// can only grant permissions they themselves hold. Owner has all perms so
// is unconstrained; a non-Owner with delegated manage_roles cannot grant
// manage_billing or other Owner-only perms unless they themselves have them.
//
// Last-Owner guard: removing a user from the Owner role (via PATCH /workers/:id/role)
// is rejected if they're the only Owner in the company. The same check
// applies if the legacy users.role drops below 'admin' as a side effect.

// GET /admin/roles — list all roles for the requester's company
router.get('/roles', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.name, r.description, r.is_builtin, r.parent_role,
              r.created_at, r.updated_at,
              COALESCE(perm_counts.cnt, 0) AS permission_count,
              COALESCE(user_counts.cnt, 0) AS user_count
         FROM roles r
         LEFT JOIN (
           SELECT role_id, COUNT(*)::int AS cnt FROM role_permissions GROUP BY role_id
         ) perm_counts ON perm_counts.role_id = r.id
         LEFT JOIN (
           SELECT role_id, COUNT(*)::int AS cnt FROM users WHERE active = true GROUP BY role_id
         ) user_counts ON user_counts.role_id = r.id
         WHERE r.company_id = $1
         ORDER BY r.is_builtin DESC, r.name`,
      [req.user.company_id]
    );
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, 'route error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /admin/roles/:id — single role with its full permission list
router.get('/roles/:id', requireAdmin, async (req, res) => {
  try {
    const roleResult = await pool.query(
      `SELECT id, name, description, is_builtin, parent_role, created_at, updated_at
         FROM roles WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]
    );
    if (roleResult.rowCount === 0) return res.status(404).json({ error: 'Role not found' });
    const permsResult = await pool.query(
      'SELECT permission FROM role_permissions WHERE role_id = $1',
      [req.params.id]
    );
    res.json({
      ...roleResult.rows[0],
      permissions: permsResult.rows.map(r => r.permission),
    });
  } catch (err) {
    req.log.error({ err }, 'route error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /admin/permissions/catalog — return the full permission catalog so the
// UI can render the checkbox grid grouped by area.
router.get('/permissions/catalog', requireAdmin, (_req, res) => {
  res.json(PERMISSIONS);
});

// POST /admin/roles — create a custom role
router.post('/roles', requireAdmin, requirePerm('manage_roles'), async (req, res) => {
  const { name, description, parent_role, permissions } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (parent_role !== 'worker' && parent_role !== 'admin') {
    return res.status(400).json({ error: 'parent_role must be "worker" or "admin"' });
  }
  if (!Array.isArray(permissions)) {
    return res.status(400).json({ error: 'permissions must be an array' });
  }
  for (const p of permissions) {
    if (!PERMISSION_KEYS.has(p)) return res.status(400).json({ error: `Unknown permission: ${p}` });
  }
  // Privilege-escalation guard
  const requesterPerms = await getUserPermissions(req.user);
  for (const p of permissions) {
    if (!requesterPerms.has(p)) {
      return res.status(403).json({
        error: `Cannot grant ${p} — you don't have it yourself`,
        code: 'permission_escalation',
        required: p,
      });
    }
  }
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `INSERT INTO roles (company_id, name, description, is_builtin, parent_role)
         VALUES ($1, $2, $3, false, $4) RETURNING id`,
        [req.user.company_id, name.trim(), description?.trim() || null, parent_role]
      );
      const roleId = r.rows[0].id;
      for (const perm of permissions) {
        await client.query(
          'INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [roleId, perm]
        );
      }
      await client.query('COMMIT');
      res.status(201).json({ id: roleId });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return res.status(409).json({ error: 'A role with that name already exists' });
      }
      throw err;
    } finally { client.release(); }
  } catch (err) {
    req.log.error({ err }, 'route error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/roles/:id — edit a role's name, description, or permissions.
// Built-in roles can have permissions edited but not name/parent.
router.patch('/roles/:id', requireAdmin, requirePerm('manage_roles'), async (req, res) => {
  const { name, description, permissions } = req.body || {};
  try {
    const existing = await pool.query(
      'SELECT id, is_builtin, name FROM roles WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Role not found' });
    const role = existing.rows[0];

    if (Array.isArray(permissions)) {
      for (const p of permissions) {
        if (!PERMISSION_KEYS.has(p)) return res.status(400).json({ error: `Unknown permission: ${p}` });
      }
      const requesterPerms = await getUserPermissions(req.user);
      for (const p of permissions) {
        if (!requesterPerms.has(p)) {
          return res.status(403).json({
            error: `Cannot grant ${p} — you don't have it yourself`,
            code: 'permission_escalation',
            required: p,
          });
        }
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Built-ins: only permissions are editable. Name and parent stay locked
      // so the fallback-on-delete contract for custom roles always resolves.
      if (!role.is_builtin) {
        if (name !== undefined) {
          if (!name.trim()) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'name cannot be empty' });
          }
          await client.query(
            'UPDATE roles SET name = $1, updated_at = NOW() WHERE id = $2',
            [name.trim(), role.id]
          );
        }
        if (description !== undefined) {
          await client.query(
            'UPDATE roles SET description = $1, updated_at = NOW() WHERE id = $2',
            [description?.trim() || null, role.id]
          );
        }
      } else if ((name !== undefined && name !== null) || description !== undefined) {
        // Built-in: description is editable, name is locked. Only reject an
        // ACTUAL rename — the UI sends the (unchanged) current name alongside a
        // permissions edit, which must not be treated as a rename attempt.
        if (name !== undefined && name !== null && name.trim() !== role.name) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Cannot rename a built-in role' });
        }
        if (description !== undefined) {
          await client.query(
            'UPDATE roles SET description = $1, updated_at = NOW() WHERE id = $2',
            [description?.trim() || null, role.id]
          );
        }
      }

      if (Array.isArray(permissions)) {
        await client.query('DELETE FROM role_permissions WHERE role_id = $1', [role.id]);
        for (const perm of permissions) {
          await client.query(
            'INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)',
            [role.id, perm]
          );
        }
        await client.query('UPDATE roles SET updated_at = NOW() WHERE id = $1', [role.id]);
      }
      await client.query('COMMIT');
      res.json({ updated: true });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return res.status(409).json({ error: 'A role with that name already exists' });
      }
      throw err;
    } finally { client.release(); }
  } catch (err) {
    req.log.error({ err }, 'route error');
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /admin/roles/:id — delete a custom role; users on it fall back to
// the parent's built-in role.
router.delete('/roles/:id', requireAdmin, requirePerm('manage_roles'), async (req, res) => {
  try {
    const existing = await pool.query(
      'SELECT id, is_builtin, parent_role FROM roles WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.company_id]
    );
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Role not found' });
    const role = existing.rows[0];
    if (role.is_builtin) return res.status(400).json({ error: 'Cannot delete a built-in role' });

    const fallbackName = role.parent_role === 'worker' ? 'Worker' : 'Admin';
    const fallback = await pool.query(
      'SELECT id FROM roles WHERE company_id = $1 AND is_builtin = true AND name = $2',
      [req.user.company_id, fallbackName]
    );
    if (fallback.rowCount === 0) {
      // Should not happen — built-ins are always seeded — but fail safely.
      return res.status(500).json({ error: 'Fallback built-in role missing' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Reassign every active user on this role to the parent built-in,
      // and bump their token_version so any in-flight JWT becomes invalid
      // and they re-auth with the new permission set.
      await client.query(
        'UPDATE users SET role_id = $1, token_version = COALESCE(token_version, 0) + 1 WHERE role_id = $2',
        [fallback.rows[0].id, role.id]
      );
      await client.query('DELETE FROM roles WHERE id = $1', [role.id]);
      await client.query('COMMIT');
      res.json({ deleted: true, fallback_role_id: fallback.rows[0].id });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
  } catch (err) {
    req.log.error({ err }, 'route error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /admin/workers/:id/role — assign a role to a worker
// Side effect: also updates legacy users.role to match the role's parent_role
// so legacy `requirePerm(...)` middleware keeps working through Phase B.
// Phase C drops users.role and removes this side effect.
router.patch('/workers/:id/role', requireAdmin, requirePerm('assign_roles'), async (req, res) => {
  const { role_id } = req.body || {};
  if (!role_id) return res.status(400).json({ error: 'role_id is required' });
  try {
    const targetRole = await pool.query(
      'SELECT id, name, parent_role, is_builtin FROM roles WHERE id = $1 AND company_id = $2',
      [role_id, req.user.company_id]
    );
    if (targetRole.rowCount === 0) return res.status(404).json({ error: 'Role not found' });

    // Privilege-escalation guard: a user may only grant a role whose
    // permission set is a SUBSET of their own. Without this, anyone with
    // `assign_roles` could grant themselves (or a confederate) the built-in
    // Owner role — or a hand-crafted custom role carrying manage_billing /
    // manage_roles / delete_company — and escalate past their own tier.
    const [granterPerms, targetRolePermsRes] = await Promise.all([
      getUserPermissions(req.user),
      pool.query('SELECT permission FROM role_permissions WHERE role_id = $1', [role_id]),
    ]);
    const exceeded = targetRolePermsRes.rows
      .map(r => r.permission)
      .filter(p => !granterPerms.has(p));
    if (exceeded.length > 0) {
      return res.status(403).json({
        error: 'You cannot grant a role with more permissions than you hold.',
        code: 'role_exceeds_granter',
      });
    }

    const targetUser = await pool.query(
      `SELECT u.id, u.full_name, u.role_id AS current_role_id, r.name AS current_role_name
         FROM users u LEFT JOIN roles r ON r.id = u.role_id
         WHERE u.id = $1 AND u.company_id = $2 AND u.active = true`,
      [req.params.id, req.user.company_id]
    );
    if (targetUser.rowCount === 0) return res.status(404).json({ error: 'Worker not found' });
    const user = targetUser.rows[0];

    // Last-Owner guard: if changing AWAY from Owner, ensure ≥1 other Owner
    // remains in the company. Built-in Owner role has name 'Owner'.
    if (user.current_role_name === 'Owner' && targetRole.rows[0].name !== 'Owner') {
      const otherOwners = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM users u
           JOIN roles r ON r.id = u.role_id
           WHERE u.company_id = $1 AND r.is_builtin = true AND r.name = 'Owner'
             AND u.id != $2 AND u.active = true`,
        [req.user.company_id, user.id]
      );
      if (otherOwners.rows[0].cnt === 0) {
        return res.status(400).json({
          error: 'Cannot remove the only Owner. Promote another user to Owner first.',
          code: 'last_owner',
        });
      }
    }

    // Update both columns + bump token_version. users.role is the legacy
    // parent role; role_id is the new authoritative reference. Bumping
    // token_version invalidates the user's existing JWT (which carries
    // the old role_id) so the next request 401s and they re-auth, picking
    // up a fresh token + permission set. Without this, they'd walk around
    // with stale permissions until their JWT expires (8h).
    await pool.query(
      'UPDATE users SET role_id = $1, role = $2, token_version = COALESCE(token_version, 0) + 1 WHERE id = $3',
      [role_id, targetRole.rows[0].parent_role, user.id]
    );
    res.json({ updated: true });
  } catch (err) {
    req.log.error({ err }, 'route error');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.getAdvancedSettings = getAdvancedSettings;
module.exports.ADVANCED_DEFAULTS = ADVANCED_DEFAULTS;
