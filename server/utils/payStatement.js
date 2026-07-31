const pool = require('../db');
const {
  computeOT, annotateEntryOvertime, computeDailyPayCosts, otBandsCost,
  nightPremiumCost, nightHoursForEntry, hoursWorked, computeGuaranteeShortfall,
  computeLeaveHours, shiftHoursByDate,
} = require('./payCalculations');
const { leaveRateMultipliers, computeWorkerLeave, computeCompanyLeave, otRuleFromSettings } = require('./paidHours');
const { roundEntriesFromSettings, otConfigFromSettings, otConfigByRoleFactory, sickRulesFromSettings } = require('./hoursRules');
const { parseCompanyDeductions, normalizeWorkerDeductions, payStubTotals } = require('./deductions');
const { splitRateAware, hasSimpleOtConfig } = require('./rateAwareOvertime');

/**
 * ONE pay statement, produced once, rendered by every pay surface.
 *
 * Why: the worker invoice, the pay stubs, the overtime report and the payroll CSV
 * must report the same number for the same worker/period. The hours layer was
 * already shared (rounding → computeOT → leave hours), but the cost-assembly
 * layer — hours → costs → prevailing → guarantee → leave $ → deductions → net —
 * was inlined in the invoice route only, and had drifted (prevailing rate,
 * guarantee, deductions differed by surface). Now every surface builds this
 * statement and flattens it into its own shape.
 *
 * `buildPayStatement` is PURE (no DB, no policy parsing): it takes already-fetched
 * inputs. The two loaders below feed it — one worker (invoice, pay stub per
 * period) or a whole company in batched queries (report, CSV), no N+1.
 */

const cents = n => Math.round((Number(n) || 0) * 100) / 100;

/**
 * @param opts.worker            { id, invoice_name, full_name, email, hourly_rate,
 *                                 rate_type, overtime_rule, role_id, guaranteed_weekly_hours }
 * @param opts.entries           PAID entries (roundEntriesFromSettings output) — mutated to carry overtime_hours
 * @param opts.reimbursements    approved reimbursement rows ([] to exclude, e.g. payroll views)
 * @param opts.leave             { sick, vacation, detail? } hours from computeWorker/CompanyLeave
 * @param opts.deductions        normalized deduction list (company ++ worker); [] for none
 * @param opts.otConfig          otConfigFromSettings / otConfigByRole result (or null)
 * @param opts.projectRateMap    { project_id: prevailing_rate } — per-project prevailing wage
 * @param opts.settings          scalar settings (thresholds, multiplier, rates, leave %, regular shift)
 * @param opts.from,opts.to      period (may be null for an all-time invoice)
 * @param opts.explain           attach settings_used / leaveDetail + per-entry OT/wage notes
 */
function buildPayStatement({ worker, entries, reimbursements = [], leave = { sick: 0, vacation: 0 }, deductions = [], otConfig = null, projectRateMap = {}, settings = {}, from = null, to = null, explain = false }) {
  const rule = otRuleFromSettings(settings, worker.overtime_rule);
  const threshold = parseFloat(settings.overtime_threshold) || 8;
  const weekStart = settings.week_start;
  const otMult = parseFloat(settings.overtime_multiplier) || 1.5;
  const prevRate = parseFloat(settings.prevailing_wage_rate) || 45;
  const rate = parseFloat(worker.hourly_rate) || parseFloat(settings.default_hourly_rate) || 0;
  const rateType = worker.rate_type || 'hourly';
  const paid = entries || [];

  // The base rate a given entry earns: its project's prevailing rate (company
  // rate as fallback) for prevailing work, the worker's rate otherwise.
  const baseRateOf = e => e.wage_type === 'prevailing'
    ? (projectRateMap && projectRateMap[e.project_id] != null ? projectRateMap[e.project_id] : prevRate)
    : rate;

  let regularHours, overtimeHours, prevailingHours, totalHours;
  let regularCostRaw, overtimeCostRaw, prevailingCostRaw;
  let overtimeBands = []; // [{hours, mult}] — how many OT hours at which multiplier
  // Rule-generated regular hours (min-daily floor / no-clock-in guarantee), per day —
  // materialized below as real entry rows so no paid hour is invisible.
  let floorDetail = [];

  if (rateType !== 'daily' && hasSimpleOtConfig(otConfig)) {
    // ── Rate-aware path ─────────────────────────────────────────────────────
    // ALL worked hours (regular + prevailing, any per-project prevailing rate)
    // count toward ONE overtime threshold, and each OT hour is priced at the rate
    // it earned (or the weighted-average blend). This is the only path that pays
    // overtime on prevailing / multi-rate hours — see docs/plans/rate-aware-overtime.md.
    const otMethod = settings.overtime_rate_method === 'weighted_average' ? 'weighted_average' : 'rate_when_worked';
    const split = splitRateAware(paid, { rule, threshold, weekStart, otMult, baseRateOf, method: otMethod });
    // Per-entry OT + reason for the line-item display column (BillPDF / WorkerMetrics).
    for (const e of paid) { e.overtime_hours = 0; e.overtime_reason = null; }
    split.worked.forEach((e, i) => { e.overtime_hours = split.perEntry[i].ot; e.overtime_reason = split.perEntry[i].reason; });
    ({ regularHours, overtimeHours, prevailingHours, regularCost: regularCostRaw, overtimeCost: overtimeCostRaw, prevailingCost: prevailingCostRaw } = split);
    totalHours = regularHours + overtimeHours + prevailingHours;
    // Simple config → every OT hour is at the one multiplier.
    if (overtimeHours > 0) overtimeBands = [{ hours: overtimeHours, mult: otMult }];
  } else {
    // ── Existing path ───────────────────────────────────────────────────────
    // Daily-rate workers, or premium OT configs (tiers, rest-day, 7th-day,
    // windows, night differential) that need per-band attribution. Prevailing
    // stays flat here until the per-band rate-aware work lands.
    const ot = computeOT(paid, rule, threshold, weekStart, otConfig, { from, to });
    annotateEntryOvertime(paid, rule, threshold, weekStart, otConfig);
    regularHours = ot.regularHours; overtimeHours = ot.overtimeHours;
    floorDetail = ot.floorDetail || [];
    prevailingHours = 0; prevailingCostRaw = 0;
    for (const e of paid) {
      if (e.wage_type !== 'prevailing') continue;
      // Clamp at 0 (matches entryDuration): a break longer than the shift must not
      // produce negative prevailing hours/cost.
      const h = Math.max(0, hoursWorked(e.start_time, e.end_time) - (e.break_minutes || 0) / 60);
      prevailingHours += h;
      prevailingCostRaw += h * (projectRateMap && projectRateMap[e.project_id] != null ? projectRateMap[e.project_id] : prevRate);
    }
    totalHours = regularHours + overtimeHours + prevailingHours;
    if (rateType === 'daily') {
      const dc = computeDailyPayCosts(paid, rule, threshold, rate, otMult, otConfig);
      regularCostRaw = dc.regularCost;
      overtimeCostRaw = dc.overtimeCost;
    } else {
      regularCostRaw = regularHours * rate;
      overtimeCostRaw = otBandsCost(ot.otBands, rate, otMult);
    }
    // Premium configs price OT per band — surface how many hours at each multiplier
    // (mult null = the plain overtime multiplier) so a 2× rest-day or a tier is visible.
    overtimeBands = (ot.otBands || [])
      .filter(b => (b.hours || 0) > 0)
      .map(b => ({ hours: b.hours, mult: b.mult != null ? b.mult : otMult }));
  }

  // Night-shift differential — an ADDITIVE premium on hours worked inside the
  // night window, at the regular rate (prevailing / daily-rate excluded). Broken
  // out as its own factor so it's visible instead of buried in the overtime cost.
  let nightPremiumRaw = 0, nightHours = 0;
  const nightCfg = (rateType !== 'daily' && otConfig && otConfig.nightDifferential) ? otConfig.nightDifferential : null;
  if (nightCfg) {
    const npct = parseFloat(nightCfg.pct) || 0;
    const nfrom = parseFloat(nightCfg.fromHour), nto = parseFloat(nightCfg.toHour);
    if (npct && Number.isFinite(nfrom) && Number.isFinite(nto)) {
      for (const e of paid) if (e.wage_type === 'regular') nightHours += nightHoursForEntry(e, nfrom, nto);
      nightPremiumRaw = nightPremiumCost(paid, nightCfg, rate);
    }
  }

  const mult = leaveRateMultipliers(settings);
  const sickHours = (leave && leave.sick) || 0;
  const vacationHours = (leave && leave.vacation) || 0;

  // Paid leave counts toward the weekly-hours guarantee. A worker guaranteed 40h
  // who worked 30h and took 10h sick has been covered for 40h — paying a 10h
  // guarantee shortfall ON TOP of the 10h sick pay would double-pay those hours.
  const { shortfall: guaranteeShortfall, minHours: guaranteeMinHours, weeks: guaranteeWeeks } =
    computeGuaranteeShortfall(totalHours + sickHours + vacationHours, worker.guaranteed_weekly_hours, from, to);

  // Round every line to cents so line items provably sum to the totals.
  const regularCost = cents(regularCostRaw);
  const overtimeCost = cents(overtimeCostRaw);
  const prevailingCost = cents(prevailingCostRaw);
  const guaranteeCost = cents(guaranteeShortfall * rate);
  const sickCost = cents(sickHours * rate * mult.sick);
  const vacationCost = cents(vacationHours * rate * mult.vacation);
  const nightPremium = cents(nightPremiumRaw);
  const grossWages = regularCost + overtimeCost + prevailingCost + nightPremium + guaranteeCost + sickCost + vacationCost;

  const reimbursementTotal = cents((reimbursements || []).reduce((s, r) => s + (parseFloat(r.amount) || 0), 0));
  const mileage = paid.reduce((s, e) => s + (parseFloat(e.mileage) || 0), 0);
  const stub = payStubTotals(grossWages, reimbursementTotal, deductions || []);
  const netWages = cents(stub.gross_wages - stub.deductions_total); // wages net of deductions, reimbursements EXCLUDED

  let settingsUsed = null;
  if (explain) {
    for (const e of paid) {
      const ex = e.explain || (e.explain = []);
      if (e.wage_type === 'prevailing') ex.push({ code: 'wage_type', wageType: 'prevailing' });
      // The entry's own logged break silently reduces paid hours and was never
      // traced (only rule-driven auto_break was). When a rule changed the break
      // (raw_break_minutes set), the auto_break item already explains it; otherwise
      // this surfaces the break that's recorded on the entry so it's visible.
      if ((e.break_minutes || 0) > 0 && e.raw_break_minutes == null) ex.push({ code: 'break_logged', breakMin: e.break_minutes });
      if ((e.overtime_hours || 0) > 0) ex.push({ code: 'overtime', otHours: e.overtime_hours, reason: e.overtime_reason || (rule === 'weekly' ? 'weekly' : 'daily'), threshold, rule });
    }
    settingsUsed = {
      rate, rate_type: rateType, overtime_rule: rule, overtime_threshold: threshold,
      overtime_multiplier: otMult, week_start: weekStart, role_id: worker.role_id,
      prevailing_wage_rate: prevRate, regular_shift_hours: settings.regular_shift_hours,
      sick_pay_pct: settings.sick_pay_pct, vacation_pay_pct: settings.vacation_pay_pct,
      guaranteed_weekly_hours: worker.guaranteed_weekly_hours,
      // Night differential (only when configured) so Inputs Used can show the window + %.
      ...(nightCfg && nightPremiumRaw > 0 ? { night_differential: { fromHour: parseFloat(nightCfg.fromHour), toHour: parseFloat(nightCfg.toHour), pct: parseFloat(nightCfg.pct) } } : {}),
    };
  }

  // Materialize rule-generated hours as ENTRY ROWS: a no-clock-in "guarantee N paid
  // hours" day, or a minimum-daily floor topping up a short worked day. Their hours are
  // already inside regularHours (computeOT) — these rows don't add pay, they just make
  // every paid hour a visible, traceable line instead of a hidden bump in Regular.
  const mkSynthetic = (o) => ({
    synthetic: true, project_name: null, start_time: null, end_time: null,
    break_minutes: 0, wage_type: 'regular', overtime_hours: 0, ...o,
    work_date_str: o.work_date,
  });
  const syntheticEntries = floorDetail.map(f => mkSynthetic({
    kind: f.kind, id: `floor-${f.kind}-${f.date}`, work_date: f.date, hours: f.hours,
    explain: [{ code: f.kind === 'guarantee' ? 'guarantee_day' : 'min_daily_floor', hours: f.hours }],
  }));
  // Weekly-hours guarantee top-up and paid leave are also rule-generated hours, not
  // clocked time — same rule: they only get paid if they're an entry. `cost` is set on
  // these (their category isn't inside Regular) so each row is self-reconciling.
  const periodEnd = to || (paid.length ? paid[paid.length - 1].work_date : from) || null;
  if (guaranteeShortfall > 0) syntheticEntries.push(mkSynthetic({
    kind: 'weekly_guarantee', id: 'wk-guarantee', work_date: periodEnd,
    hours: guaranteeShortfall, cost: guaranteeCost,
    explain: [{ code: 'weekly_guarantee', minHours: guaranteeMinHours, weeks: guaranteeWeeks, hours: guaranteeShortfall }],
  }));
  if (sickHours > 0) syntheticEntries.push(mkSynthetic({
    kind: 'sick', id: 'leave-sick', work_date: periodEnd, hours: sickHours, cost: sickCost,
    explain: [{ code: 'leave', leaveType: 'sick', hours: sickHours }],
  }));
  if (vacationHours > 0) syntheticEntries.push(mkSynthetic({
    kind: 'vacation', id: 'leave-vacation', work_date: periodEnd, hours: vacationHours, cost: vacationCost,
    explain: [{ code: 'leave', leaveType: 'vacation', hours: vacationHours }],
  }));
  const outEntries = syntheticEntries.length
    ? [...paid, ...syntheticEntries].sort((a, b) => {
        const d = String(a.work_date).localeCompare(String(b.work_date));
        return d !== 0 ? d : String(a.start_time || '99:99').localeCompare(String(b.start_time || '99:99'));
      })
    : paid;

  return {
    worker,
    period: { from: from || null, to: to || null },
    entries: outEntries,
    reimbursements: reimbursements || [],
    hours: {
      regular: regularHours, overtime: overtimeHours, prevailing: prevailingHours,
      // OT hours grouped by the multiplier they were paid at (highest first) so the
      // report can show "2h at 2×, 3h at 1.5×" instead of one opaque overtime figure.
      overtimeBands: Object.entries(
        overtimeBands.reduce((m, b) => { const k = String(b.mult); m[k] = (m[k] || 0) + b.hours; return m; }, {})
      ).map(([mult, h]) => ({ mult: parseFloat(mult), hours: +h.toFixed(2) })).sort((a, b) => b.mult - a.mult),
      night: nightHours,
      sick: sickHours, vacation: vacationHours,
      guaranteeShortfall, guaranteeMin: guaranteeMinHours, guaranteeWeeks,
      total: totalHours, mileage,
    },
    cost: {
      regular: regularCost, overtime: overtimeCost, prevailing: prevailingCost,
      night: nightPremium,
      sick: sickCost, vacation: vacationCost, guarantee: guaranteeCost,
      sickRate: cents(rate * mult.sick), vacationRate: cents(rate * mult.vacation),
    },
    rates: { rate, rateType, prevailingWageRate: prevRate, overtimeMultiplier: otMult, sickPct: settings.sick_pay_pct, vacationPct: settings.vacation_pay_pct },
    deductions: stub.deductions,
    totals: {
      grossWages: stub.gross_wages, deductionsTotal: stub.deductions_total,
      reimbursementTotal: stub.reimbursement_total, netPay: stub.net_pay, netWages,
      totalCost: grossWages + reimbursementTotal, // gross labor + reimbursements (the invoice's "Total Due")
    },
    ...(explain ? { settingsUsed, leaveDetail: (leave && leave.detail) || [] } : {}),
  };
}

/** { id: rate } for every project that sets a prevailing wage. */
async function loadProjectRateMap(companyId) {
  const r = await pool.query('SELECT id, prevailing_wage_rate FROM projects WHERE company_id = $1', [companyId]);
  const m = {};
  r.rows.forEach(p => { if (p.prevailing_wage_rate != null) m[p.id] = parseFloat(p.prevailing_wage_rate); });
  return m;
}

/**
 * One worker's statement over [from,to]. Fetches this worker's entries,
 * reimbursements, deductions, leave + the project rate map, then builds. Used by
 * the invoice and (per period) the pay stubs.
 */
async function workerStatement({ companyId, worker, settings, from, to, explain = false }) {
  const [entriesR, reimbR, dedR, projectRateMap, leave] = await Promise.all([
    pool.query(
      // work_date AS text — this column wins over te.*'s Date. pg returns DATE as
      // a JS Date, but the rules engine keys on a 'YYYY-MM-DD' string, so a Date
      // silently no-ops every date-scoped rule (Mon-scoped OT, rest-day, etc.).
      // Not a global pg-types parser — other code relies on Date objects.
      `SELECT te.*, p.name as project_name, to_char(te.work_date, 'YYYY-MM-DD') AS work_date
       FROM time_entries te
       LEFT JOIN projects p ON te.project_id = p.id
       WHERE te.user_id = $1 AND te.status = 'approved'
         AND ($2::date IS NULL OR te.work_date >= $2::date)
         AND ($3::date IS NULL OR te.work_date <= $3::date)
       ORDER BY te.work_date ASC, te.start_time ASC`,
      [worker.id, from || null, to || null]
    ),
    pool.query(
      `SELECT r.id, r.amount, r.description, r.category, r.expense_date, r.project_id, p.name AS project_name
       FROM reimbursements r
       LEFT JOIN projects p ON p.id = r.project_id
       WHERE r.user_id = $1 AND r.company_id = $2 AND r.status = 'approved'
         AND ($3::date IS NULL OR r.expense_date >= $3::date)
         AND ($4::date IS NULL OR r.expense_date <= $4::date)
       ORDER BY r.expense_date ASC`,
      [worker.id, companyId, from || null, to || null]
    ),
    pool.query(
      'SELECT id, name, kind, value, cap_amount, active FROM worker_deductions WHERE user_id = $1 AND company_id = $2 AND active = true ORDER BY id',
      [worker.id, companyId]
    ),
    loadProjectRateMap(companyId),
    computeWorkerLeave({ companyId, userId: worker.id, roleId: worker.role_id, settings, from, to, withDetail: explain }),
  ]);

  const entries = roundEntriesFromSettings(entriesR.rows, settings, { workerRoleById: { [worker.id]: worker.role_id }, explain });
  const otConfig = otConfigFromSettings(settings, worker.role_id);
  const deductions = parseCompanyDeductions(settings.deductions).concat(normalizeWorkerDeductions(dedR.rows));

  return buildPayStatement({
    worker, entries, reimbursements: reimbR.rows, leave, deductions,
    otConfig, projectRateMap, settings, from, to, explain,
  });
}

/**
 * Statements for a whole company's workers over [from,to] → Map(userId →
 * statement). One query each for entries, deductions, project rates and leave —
 * no per-worker round-trips. Reimbursements are excluded (payroll views show
 * wages, not expense repayments). Used by the overtime report + payroll CSV.
 * `workers` rows must include guaranteed_weekly_hours for the guarantee line.
 */
async function companyStatements({ companyId, workers, settings, from, to }) {
  const out = new Map();
  const list = workers || [];
  if (list.length === 0) return out;

  const workerRoleById = {};
  list.forEach(w => { workerRoleById[w.id] = w.role_id; });

  const [entriesR, dedR, projectRateMap, leaveByUser] = await Promise.all([
    pool.query(
      // ORDER BY is REQUIRED, not cosmetic: rate-aware OT attributes overtime to
      // the chronologically-later hours and prices each at its own rate, so the
      // gross depends on entry order. The single-worker loaders order the same
      // way; without this, the overtime report / payroll CSV could disagree with
      // the invoice for a multi-rate worker (nondeterministic DB scan order).
      `SELECT te.user_id, te.project_id, te.wage_type, te.start_time, te.end_time, to_char(te.work_date, 'YYYY-MM-DD') AS work_date, te.break_minutes, te.mileage
       FROM time_entries te
       WHERE te.company_id = $1 AND te.work_date >= $2 AND te.work_date <= $3 AND te.status = 'approved'
       ORDER BY te.user_id, te.work_date ASC, te.start_time ASC`,
      [companyId, from, to]
    ),
    pool.query(
      'SELECT user_id, id, name, kind, value, cap_amount, active FROM worker_deductions WHERE company_id = $1 AND active = true ORDER BY id',
      [companyId]
    ),
    loadProjectRateMap(companyId),
    computeCompanyLeave({ companyId, workers: list, settings, from, to }),
  ]);

  const paidRows = roundEntriesFromSettings(entriesR.rows, settings, { workerRoleById });
  const byWorker = {};
  paidRows.forEach(e => { (byWorker[e.user_id] = byWorker[e.user_id] || []).push(e); });

  const companyDeductions = parseCompanyDeductions(settings.deductions);
  const dedByUser = {};
  dedR.rows.forEach(r => { (dedByUser[r.user_id] = dedByUser[r.user_id] || []).push(r); });

  const otConfigByRole = otConfigByRoleFactory(settings);
  for (const w of list) {
    out.set(w.id, buildPayStatement({
      worker: w,
      entries: byWorker[w.id] || [],
      reimbursements: [],
      leave: leaveByUser.get(w.id) || { sick: 0, vacation: 0 },
      deductions: companyDeductions.concat(normalizeWorkerDeductions(dedByUser[w.id] || [])),
      otConfig: otConfigByRole(w.role_id),
      projectRateMap,
      settings, from, to, explain: false,
    }));
  }
  return out;
}

/**
 * One statement PER PAY PERIOD for a worker, fetching the whole span ONCE then
 * pricing each period from the shared slice (no per-period round-trips). Returns
 * [{ period, statement }] for every period that had activity (entries or leave);
 * fully-empty periods are dropped. Used by the worker's pay stubs.
 * `periods` are pay_period rows ({ id, period_start, period_end, label, ... }).
 */
async function workerPeriodStatements({ companyId, worker, settings, periods }) {
  const out = [];
  const list = periods || [];
  if (list.length === 0) return out;
  const day = d => String(d).substring(0, 10);
  const minDate = list.reduce((m, p) => (day(p.period_start) < m ? day(p.period_start) : m), day(list[0].period_start));
  const maxDate = list.reduce((m, p) => (day(p.period_end) > m ? day(p.period_end) : m), day(list[0].period_end));

  const [entriesR, dedR, projectRateMap, leaveReqs, leaveShifts] = await Promise.all([
    pool.query(
      `SELECT te.*, p.name as project_name, to_char(te.work_date, 'YYYY-MM-DD') AS work_date
       FROM time_entries te LEFT JOIN projects p ON te.project_id = p.id
       WHERE te.user_id = $1 AND te.status = 'approved' AND te.work_date >= $2 AND te.work_date <= $3
       ORDER BY te.work_date, te.start_time`,
      [worker.id, minDate, maxDate]
    ),
    pool.query(
      'SELECT id, name, kind, value, cap_amount, active FROM worker_deductions WHERE user_id = $1 AND company_id = $2 AND active = true ORDER BY id',
      [worker.id, companyId]
    ),
    loadProjectRateMap(companyId),
    pool.query(
      `SELECT type, hours, start_date, end_date FROM time_off_requests
       WHERE user_id = $1 AND company_id = $2 AND type IN ('sick','vacation') AND status = 'approved'
         AND start_date <= $4::date AND end_date >= $3::date`,
      [worker.id, companyId, minDate, maxDate]
    ),
    pool.query(
      `SELECT shift_date, start_time, end_time FROM shifts
       WHERE user_id = $1 AND company_id = $2 AND shift_date >= $3::date AND shift_date <= $4::date`,
      [worker.id, companyId, minDate, maxDate]
    ),
  ]);

  const paidAll = roundEntriesFromSettings(entriesR.rows, settings, { workerRoleById: { [worker.id]: worker.role_id } });
  const otConfig = otConfigFromSettings(settings, worker.role_id);
  const deductions = parseCompanyDeductions(settings.deductions).concat(normalizeWorkerDeductions(dedR.rows));
  const leaveRules = sickRulesFromSettings(settings, worker.role_id);
  const shiftsByDate = shiftHoursByDate(leaveShifts.rows);

  for (const period of list) {
    const ps = day(period.period_start), pe = day(period.period_end);
    const entries = paidAll.filter(e => e.work_date >= ps && e.work_date <= pe);
    const leave = computeLeaveHours(leaveReqs.rows, shiftsByDate, leaveRules, settings.regular_shift_hours, ps, pe);
    if (entries.length === 0 && leave.sick === 0 && leave.vacation === 0) continue; // leave-only periods still show; fully-empty drop
    const statement = buildPayStatement({
      worker, entries, reimbursements: [], leave, deductions,
      otConfig, projectRateMap, settings, from: ps, to: pe, explain: false,
    });
    out.push({ period, statement });
  }
  return out;
}

module.exports = { buildPayStatement, workerStatement, companyStatements, workerPeriodStatements };
