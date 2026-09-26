const pool = require('../db');
const { normalizePaycheckRules } = require('../constants/paycheckRuleEnums');
const { resolveRuleset, rulesetsForActiveRoles, groupOpts } = require('../utils/paycheckRun');
const { generatePeriods, groupPeriods, dateRangeDays } = require('../utils/payPeriods');
const { PAYROLL_WORKERS_SQL } = require('../utils/payStatement');
const { ADMIN_SETTINGS_DEFAULTS, applySettingsRows } = require('../settingsDefaults');
const { workerAccessIds } = require('../utils/workerScope');

function isoDate(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? null : text;
}

function displayDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return String(value || '').slice(0, 10);
}

function shiftIsoDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function todayIso() {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString().slice(0, 10);
}

function denied(required) {
  return { ok: false, error: 'permission_denied', required };
}

function payrollAddonState(company) {
  if (!company) return { available: false, code: 'company_not_found', message: 'The company could not be loaded.' };
  const status = String(company.subscription_status || '');
  const trialExpired = status === 'trial' && company.trial_ends_at && new Date(company.trial_ends_at) < new Date();
  if (status === 'canceled' || status === 'trial_expired' || trialExpired) {
    return { available: false, code: 'subscription_required', message: 'An active subscription is required for Advanced Payroll.' };
  }
  const available = status === 'exempt' || status === 'trial' || company.addon_advanced_payroll || company.addon_certified_payroll;
  return available
    ? { available: true }
    : { available: false, code: 'advanced_payroll_required', message: 'The Advanced Payroll add-on is required.' };
}

function exactPayrollRuleset(rulesets, requestedName) {
  if (!requestedName) return { ruleset: null };
  const wanted = requestedName.toLowerCase();
  const matches = rulesets.filter(ruleset => String(ruleset.name || 'Unnamed ruleset').toLowerCase() === wanted);
  if (matches.length === 0) return { error: 'ruleset_not_found' };
  if (matches.length > 1) return { error: 'ruleset_ambiguous' };
  return { ruleset: matches[0] };
}

function payrollPeriodsForWindow(ruleset, from, to, weekStart) {
  if (!ruleset) return [];
  return groupPeriods(
    generatePeriods(ruleset.schedule, shiftIsoDate(from, -45), shiftIsoDate(to, 45), weekStart),
    groupOpts(ruleset.deductions)
  ).filter(period => period.payDate >= from && period.payDate <= to);
}

async function recentPayrollRuns(req, accessIds) {
  const params = [req.user.company_id];
  const scope = accessIds ? ' AND c.user_id = ANY($2::int[])' : '';
  if (accessIds) params.push(accessIds);
  const { rows } = await pool.query(
    `SELECT pr.period_from, pr.period_to, pr.status, pr.created_at,
            COUNT(c.id)::int AS check_count,
            COUNT(c.id) FILTER (WHERE c.status = 'paid')::int AS paid_count
       FROM payroll_runs pr
       JOIN payroll_run_checks c ON c.run_id = pr.id AND c.company_id = pr.company_id${scope}
      WHERE pr.company_id = $1
      GROUP BY pr.id, pr.period_from, pr.period_to, pr.status, pr.created_at
      ORDER BY pr.created_at DESC
      LIMIT 3`,
    params
  );
  return rows.map(row => ({
    period_from: displayDate(row.period_from),
    period_to: displayDate(row.period_to),
    status: row.status,
    checks: Number(row.check_count) || 0,
    paid: Number(row.paid_count) || 0,
  }));
}

async function payrollEntryCounts(req, from, to, accessIds) {
  const params = [req.user.company_id, from, to];
  let scope = '';
  if (accessIds) {
    params.push(accessIds);
    scope = ` AND u.id = ANY($${params.length}::int[])`;
  }
  const { rows } = await pool.query(
    `WITH eligible_users AS (
       SELECT u.id FROM users u
        WHERE u.company_id = $1
          AND COALESCE(u.worker_type, 'employee') NOT IN ('owner', 'unpaid')${scope}
     ), entry_counts AS (
       SELECT COUNT(*) FILTER (WHERE te.status = 'approved')::int AS approved_entries,
              COUNT(*) FILTER (WHERE te.status = 'pending')::int AS pending_entries,
              COUNT(*) FILTER (WHERE te.status = 'rejected')::int AS rejected_entries,
              COUNT(DISTINCT te.user_id) FILTER (WHERE te.status = 'approved')::int AS approved_workers,
              COUNT(DISTINCT te.user_id) FILTER (WHERE te.status = 'pending')::int AS pending_workers
         FROM time_entries te JOIN eligible_users eu ON eu.id = te.user_id
        WHERE te.company_id = $1 AND te.work_date BETWEEN $2::date AND $3::date
     ), leave_counts AS (
       SELECT COUNT(*)::int AS approved_paid_leave
         FROM time_off_requests r JOIN eligible_users eu ON eu.id = r.user_id
        WHERE r.company_id = $1 AND r.status = 'approved' AND r.type IN ('sick', 'vacation')
          AND r.start_date <= $3::date AND r.end_date >= $2::date
     ), clock_counts AS (
       SELECT COUNT(*)::int AS open_clocks
         FROM active_clock ac JOIN eligible_users eu ON eu.id = ac.user_id
        WHERE ac.company_id = $1 AND ac.work_date BETWEEN $2::date AND $3::date
     )
     SELECT * FROM entry_counts CROSS JOIN leave_counts CROSS JOIN clock_counts`,
    params
  );
  const row = rows[0] || {};
  return {
    approved_entries: Number(row.approved_entries) || 0,
    approved_workers: Number(row.approved_workers) || 0,
    pending_entries: Number(row.pending_entries) || 0,
    pending_workers: Number(row.pending_workers) || 0,
    rejected_entries: Number(row.rejected_entries) || 0,
    approved_paid_leave: Number(row.approved_paid_leave) || 0,
    open_clocks: Number(row.open_clocks) || 0,
  };
}

async function payrollWorkersForRange(req, from, to, accessIds) {
  const params = [req.user.company_id, from, to];
  let scope = '';
  if (accessIds) {
    params.push(accessIds);
    scope = ` WHERE pw.id = ANY($${params.length}::int[])`;
  }
  const { rows } = await pool.query(
    `SELECT pw.*, r.name AS role_name
       FROM (${PAYROLL_WORKERS_SQL}) pw
       LEFT JOIN roles r ON r.id = pw.role_id AND r.company_id = $1${scope}
      ORDER BY pw.full_name, pw.id`,
    params
  );
  return rows;
}

async function getPayrollReadiness(req, permissions, input = {}) {
  const isAdmin = ['admin', 'super_admin'].includes(req.user.role);
  if (!isAdmin || !permissions.has('view_reports') || !permissions.has('view_worker_wages')) {
    return denied(['admin_role', 'view_reports', 'view_worker_wages']);
  }

  const hasFrom = Object.prototype.hasOwnProperty.call(input, 'from');
  const hasTo = Object.prototype.hasOwnProperty.call(input, 'to');
  if (hasFrom !== hasTo) return { ok: false, error: 'incomplete_date_range', detail: 'Provide both from and to dates.' };
  const from = hasFrom ? isoDate(input.from) : null;
  const to = hasTo ? isoDate(input.to) : null;
  if (hasFrom && (!from || !to || from > to)) {
    return { ok: false, error: 'invalid_date_range', detail: 'Use real YYYY-MM-DD dates in ascending order.' };
  }
  if (from && dateRangeDays(from, to) > 366) {
    return { ok: false, error: 'date_range_too_large', detail: 'Payroll pay-date windows may be at most 366 days.' };
  }
  const rawRulesetName = input.ruleset_name == null ? '' : String(input.ruleset_name).trim();
  if (rawRulesetName.length > 120) return { ok: false, error: 'ruleset_name_too_long' };

  const company = await pool.query(
    `SELECT subscription_status, trial_ends_at, addon_advanced_payroll, addon_certified_payroll
       FROM companies WHERE id = $1`,
    [req.user.company_id]
  );
  const addon = payrollAddonState(company.rows[0]);
  const accessIds = workerAccessIds(req);
  const scope = accessIds ? 'assigned_workers' : 'company';
  if (!addon.available) {
    return {
      ok: true,
      available: false,
      scope,
      readiness_basis: 'preflight_without_pay_calculation',
      exact_register_required: true,
      preview_ready: false,
      finalization_ready: false,
      blockers: [{ code: addon.code, message: addon.message }],
      warnings: [],
      recent_runs: [],
    };
  }

  const settingsRows = await pool.query(
    "SELECT key, value FROM settings WHERE company_id = $1 AND key = ANY($2::text[])",
    [req.user.company_id, ['week_start', 'paycheck_rules']]
  );
  const settings = applySettingsRows(settingsRows.rows, ADMIN_SETTINGS_DEFAULTS);
  const weekStart = parseInt(settings.week_start ?? 1, 10);
  const rulesets = normalizePaycheckRules(settings.paycheck_rules).rulesets;
  const availableRulesets = rulesets.map(ruleset => ruleset.name || 'Unnamed ruleset');
  const requestedRuleset = exactPayrollRuleset(rulesets, rawRulesetName);
  if (requestedRuleset.error) {
    return {
      ok: false,
      error: requestedRuleset.error,
      detail: requestedRuleset.error === 'ruleset_not_found'
        ? 'No paycheck ruleset exactly matches that name.'
        : 'More than one paycheck ruleset has that name.',
      available_rulesets: availableRulesets,
    };
  }

  const recentRuns = await recentPayrollRuns(req, accessIds);
  const blockers = [];
  const warnings = [];
  let selectedRuleset = requestedRuleset.ruleset;
  let payFrom = from;
  let payTo = to;
  let targetPeriods = [];
  const rangeSource = from ? 'requested' : 'latest_closed_period';

  if (from) {
    if (!selectedRuleset && rulesets.length === 1) selectedRuleset = rulesets[0];
    if (!selectedRuleset && rulesets.length > 1) {
      return {
        ok: true,
        available: true,
        scope,
        readiness_basis: 'preflight_without_pay_calculation',
        exact_register_required: true,
        preview_ready: false,
        finalization_ready: false,
        blockers: [{ code: 'ruleset_required', message: 'Choose an exact paycheck ruleset for this pay-date window.' }],
        warnings,
        available_rulesets: availableRulesets,
        recent_runs: recentRuns,
      };
    }
    targetPeriods = payrollPeriodsForWindow(selectedRuleset, payFrom, payTo, weekStart);
    if (!rulesets.length) targetPeriods = [{ periodStart: payFrom, periodEnd: payTo, payDate: payTo }];
  } else {
    const boundsParams = [req.user.company_id];
    const boundsScope = accessIds ? ' AND te.user_id = ANY($2::int[])' : '';
    if (accessIds) boundsParams.push(accessIds);
    const bounds = await pool.query(
      `SELECT to_char(MIN(te.work_date), 'YYYY-MM-DD') AS first,
              to_char(MAX(te.work_date), 'YYYY-MM-DD') AS last
         FROM time_entries te WHERE te.company_id = $1${boundsScope}`,
      boundsParams
    );
    const roleParams = [req.user.company_id];
    const roleScope = accessIds ? ' AND id = ANY($2::int[])' : '';
    if (accessIds) roleParams.push(accessIds);
    const activeRoles = await pool.query(
      `SELECT DISTINCT role_id FROM users
        WHERE company_id = $1 AND role = 'worker' AND active = true
          AND worker_type <> 'unpaid' AND role_id IS NOT NULL${roleScope}`,
      roleParams
    );
    const firstWork = bounds.rows[0]?.first;
    const lastWork = bounds.rows[0]?.last;
    let scheduledRulesets = rulesetsForActiveRoles(rulesets, activeRoles.rows.map(row => row.role_id));
    if (selectedRuleset) scheduledRulesets = scheduledRulesets.filter(ruleset => ruleset.id === selectedRuleset.id);
    if (firstWork) {
      const today = todayIso();
      const recentFloor = shiftIsoDate(today, -800);
      const genFrom = shiftIsoDate(firstWork < recentFloor ? recentFloor : firstWork, -45);
      const genTo = shiftIsoDate(today, 45);
      const choices = [];
      for (const ruleset of scheduledRulesets) {
        const periods = groupPeriods(
          generatePeriods(ruleset.schedule, genFrom, genTo, weekStart)
            .filter(period => !(period.periodEnd < firstWork || period.periodStart > lastWork)),
          groupOpts(ruleset.deductions)
        );
        periods.filter(period => period.periodEnd <= today).forEach(period => choices.push({ ruleset, period }));
      }
      choices.sort((a, b) => b.period.payDate.localeCompare(a.period.payDate) || String(a.ruleset.name).localeCompare(String(b.ruleset.name)));
      if (choices.length) {
        selectedRuleset = choices[0].ruleset;
        payFrom = choices[0].period.payDate;
        payTo = choices[0].period.payDate;
        targetPeriods = payrollPeriodsForWindow(selectedRuleset, payFrom, payTo, weekStart);
      }
    }
  }

  if (!rulesets.length) {
    blockers.push({ code: 'no_paycheck_rules', message: 'Configure at least one paycheck ruleset before finalizing payroll.' });
  }
  if (!payFrom || !payTo) {
    blockers.push({ code: 'no_default_period', message: 'No closed scheduled pay period is available. Configure a ruleset schedule or specify a date range.' });
    return {
      ok: true,
      available: true,
      scope,
      readiness_basis: 'preflight_without_pay_calculation',
      exact_register_required: true,
      preview_ready: false,
      finalization_ready: accessIds ? null : false,
      blockers,
      warnings,
      available_rulesets: availableRulesets,
      target: null,
      recent_runs: recentRuns,
    };
  }
  if (selectedRuleset && !targetPeriods.length) {
    blockers.push({ code: 'no_scheduled_paychecks', message: 'The selected ruleset does not issue a paycheck in this pay-date window.' });
  }

  const workFrom = targetPeriods.length
    ? targetPeriods.reduce((value, period) => period.periodStart < value ? period.periodStart : value, targetPeriods[0].periodStart)
    : payFrom;
  const workTo = targetPeriods.length
    ? targetPeriods.reduce((value, period) => period.periodEnd > value ? period.periodEnd : value, targetPeriods[0].periodEnd)
    : payTo;
  const setupWorkers = await payrollWorkersForRange(req, shiftIsoDate(payFrom, -45), shiftIsoDate(payTo, 45), accessIds);
  const payableWorkers = await payrollWorkersForRange(req, workFrom, workTo, accessIds);
  const setupErrors = [];
  const payrollWorkers = [];
  for (const worker of setupWorkers) {
    const resolved = resolveRuleset(rulesets, worker.role_id);
    if (resolved.error) {
      setupErrors.push({
        worker: worker.invoice_name || worker.full_name,
        role: worker.role_name || null,
        reason: resolved.error,
        matches: resolved.matches || null,
      });
    }
  }
  for (const worker of payableWorkers) {
    const resolved = resolveRuleset(rulesets, worker.role_id);
    if (!resolved.error && (!selectedRuleset || !resolved.ruleset || resolved.ruleset.id === selectedRuleset.id)) {
      payrollWorkers.push(worker);
    }
  }
  if (setupErrors.length) {
    blockers.push({ code: 'worker_setup_errors', message: `${setupErrors.length} payroll worker setup issue(s) must be fixed.` });
  }
  if (!payrollWorkers.length) {
    blockers.push({ code: 'no_payable_workers', message: 'No workers have approved payable activity, paid leave, or a weekly guarantee for this period.' });
  }

  const counts = await payrollEntryCounts(req, workFrom, workTo, accessIds);
  if (counts.pending_entries) {
    warnings.push({ code: 'pending_time', message: 'Pending time is excluded from payroll until approved.', count: counts.pending_entries, workers: counts.pending_workers });
  }
  if (counts.rejected_entries) {
    warnings.push({ code: 'rejected_time', message: 'Rejected time is excluded from payroll.', count: counts.rejected_entries });
  }
  if (counts.open_clocks) {
    warnings.push({ code: 'open_clocks', message: 'Workers are still clocked in within the covered work dates.', count: counts.open_clocks });
  }
  if (accessIds) {
    warnings.push({ code: 'limited_scope', message: 'This result covers only the workers assigned to this manager, so company-wide finalization readiness is unknown.' });
  }

  let finalizedOverlap = { run_count: 0, check_count: 0 };
  const candidateIds = payrollWorkers.map(worker => Number(worker.id)).filter(id => Number.isInteger(id) && id > 0);
  if (candidateIds.length) {
    const overlap = await pool.query(
      `SELECT COUNT(DISTINCT c.run_id)::int AS run_count, COUNT(*)::int AS check_count
         FROM payroll_run_checks c JOIN payroll_runs pr ON pr.id = c.run_id
        WHERE c.company_id = $1 AND pr.status <> 'void'
          AND c.user_id = ANY($4::int[])
          AND c.period_start <= $3::date AND c.period_end >= $2::date`,
      [req.user.company_id, workFrom, workTo, candidateIds]
    );
    finalizedOverlap = overlap.rows[0] || finalizedOverlap;
    if (Number(finalizedOverlap.check_count) > 0) {
      blockers.push({ code: 'already_finalized', message: 'One or more workers already have finalized payroll covering these work dates.' });
    }
  }
  if (!permissions.has('manage_pay_periods')) {
    blockers.push({ code: 'finalize_permission_required', message: 'The manage pay periods permission is required to finalize payroll.' });
  }

  const previewBlockers = new Set(['no_scheduled_paychecks', 'worker_setup_errors', 'no_payable_workers']);
  const previewReady = !blockers.some(blocker => previewBlockers.has(blocker.code));
  const finalizationReady = accessIds
    ? null
    : previewReady && !blockers.some(blocker => ['no_paycheck_rules', 'already_finalized', 'finalize_permission_required'].includes(blocker.code));
  return {
    ok: true,
    available: true,
    scope,
    readiness_basis: 'preflight_without_pay_calculation',
    exact_register_required: true,
    preview_ready: previewReady,
    finalization_ready: finalizationReady,
    target: {
      source: rangeSource,
      pay_window: { from: payFrom, to: payTo },
      work_period: { from: workFrom, to: workTo },
      ruleset: selectedRuleset ? selectedRuleset.name || 'Unnamed ruleset' : null,
      frequency: selectedRuleset ? selectedRuleset.schedule.frequency : null,
      scheduled_checks: targetPeriods.length,
      pay_dates: [...new Set(targetPeriods.map(period => period.payDate))].slice(0, 20),
    },
    counts: {
      payroll_workers: payrollWorkers.length,
      ...counts,
      finalized_runs_covering_period: Number(finalizedOverlap.run_count) || 0,
      finalized_checks_covering_period: Number(finalizedOverlap.check_count) || 0,
    },
    blockers,
    warnings,
    setup_errors: setupErrors.slice(0, 20),
    setup_error_count: setupErrors.length,
    available_rulesets: availableRulesets,
    recent_runs: recentRuns,
  };
}

module.exports = { getPayrollReadiness };
