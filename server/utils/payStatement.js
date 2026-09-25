const pool = require('../db');
const {
  computeOT, annotateEntryOvertime, computeDailyPayCosts, otBandsCost,
  nightPremiumCost, nightHoursForEntry, entryDuration,
  computeLeaveHours, shiftHoursByDate,
} = require('./payCalculations');
const { leaveRateMultipliers, computeWorkerLeave, computeCompanyLeave, otRuleFromSettings, otThreshold } = require('./paidHours');
const { roundEntriesFromSettings, otConfigFromSettings, otConfigByRoleFactory, sickRulesFromSettings, ymd } = require('./hoursRules');
const { parseCompanyDeductions, normalizeWorkerDeductions, payStubTotals } = require('./deductions');
const { splitRateAware, hasSimpleOtConfig } = require('./rateAwareOvertime');
const { workerRateOn, prevailingRateOn, companyPrevailingRateOn, loadRateBook, blendRate } = require('./rateHistory');
const { resolveRuleset, deductionsForRole, splitDeductionsByTiming } = require('./paycheckRun');
const { normalizePaycheckRules } = require('../constants/paycheckRuleEnums');
const { normWeekStart } = require('./weekBounds');

// Resolve the worker's paycheck ruleset, then split their role's company deductions +
// personal deductions into the ones that come out every paycheck vs. the ones GROUPED
// once per pair/month. A per-range preview (an arbitrary date range or one pay period)
// can only honestly show the PER-CHECK deductions — the grouped ones (exempt + combined
// gross across the whole group) are figured on the payroll run — so it returns
// { previewDeductions, deferredNames } and the caller notes the deferred ones.
function previewDeductionSplit(settings, worker, workerDedRows) {
  const companyDeds = parseCompanyDeductions(settings.deductions);
  const workerDeds = normalizeWorkerDeductions(workerDedRows);
  const rulesets = normalizePaycheckRules(settings.paycheck_rules).rulesets;
  const resolved = resolveRuleset(rulesets, worker.role_id);
  const ruleset = resolved && resolved.ruleset ? resolved.ruleset : null;
  const roleDeds = deductionsForRole(companyDeds, worker.role_id);
  const { perCheck, grouped } = splitDeductionsByTiming(roleDeds, workerDeds, ruleset);
  return { previewDeductions: perCheck, deferredNames: grouped.map(d => d.name) };
}

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

// Chronological order (work_date, then start_time) — the same order every loader's
// SQL uses. Stable, so same-slot rows keep their incoming order.
function sortChrono(list) {
  return list.slice().sort((a, b) => {
    const d = String(ymd(a.work_date)).localeCompare(String(ymd(b.work_date)));
    return d !== 0 ? d : String(a.start_time || '').localeCompare(String(b.start_time || ''));
  });
}

// otBands(a) − otBands(b), matched by multiplier (null = the default multiplier).
function diffBands(a, b) {
  const m = new Map();
  for (const x of a || []) m.set(x.mult, (m.get(x.mult) || 0) + x.hours);
  for (const x of b || []) m.set(x.mult, (m.get(x.mult) || 0) - x.hours);
  return [...m.entries()].map(([mult, hours]) => ({ hours, mult })).filter(x => x.hours > 1e-9);
}

// Add k days to a 'YYYY-MM-DD' key (UTC, TZ-independent).
function addDays(dk, k) {
  const m = String(dk).substring(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) + k * 86400000).toISOString().substring(0, 10);
}

/**
 * The full week_start-aligned weeks touching [from,to]: { from, to } widened back
 * to the first week's start and forward to the last week's end. Null bounds → null
 * (an all-time range has no clipped weeks).
 */
function fullWeekSpan(from, to, weekStart) {
  if (!from || !to) return null;
  const f = ymd(from), t = ymd(to);
  const ws = normWeekStart(weekStart ?? 1); // same normalization computeOT's week buckets use
  const dow = dk => { const m = dk.match(/^(\d{4})-(\d{2})-(\d{2})$/); return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay(); };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const wf = addDays(f, -((dow(f) - ws + 7) % 7));
  const wt = addDays(t, 6 - ((dow(t) - ws + 7) % 7));
  return { from: wf, to: wt };
}

// Split one worker's paid entries (already covering the full-week span) into the
// in-period rows and the week-context rows outside [from,to].
function splitPeriod(rows, from, to) {
  const f = ymd(from), t = ymd(to);
  const inRange = [], context = [];
  for (const e of rows || []) {
    const d = ymd(e.work_date);
    (d >= f && d <= t ? inRange : context).push(e);
  }
  return { inRange, context };
}

// Every 'YYYY-MM-DD' in [from,to] (UTC; tiny ranges — a pay period).
function eachDay(from, to) {
  const out = [];
  let d = ymd(from);
  const t = ymd(to);
  for (let i = 0; d && d <= t && i < 4000; i++) { out.push(d); d = addDays(d, 1); }
  return out;
}

/**
 * The weekly-hours guarantee, one row per week this period pays:
 * [{ weekStart, weekEnd, covered, shortfall, cost }].
 *
 * The guarantee is a WEEKLY floor, so it's figured per company week (week_start),
 * never pooled across a period — pooled, a 50h week hid a 30h week's shortfall on
 * the stub / payroll while the QBO bill (priced per week) billed it. A week
 * belongs to the period holding its LAST day, the same chronological attribution
 * full-week OT loading uses: its out-of-period hours (contextEntries) and leave
 * (contextLeaveByDate) count toward it, and a week that ends after `to` is paid
 * by the next period — so adjacent periods sum to the full weeks. Open range (no
 * from/to): every week holding a worked row. Covered hours = paid punches + rule
 * floor hours + paid leave. Each week's cost is cents-rounded at the hourly rate
 * in effect on the week's last day.
 */
function weekGuarantee({ guaranteed, weekStart, from, to, paid, floorDetail, contextEntries, leave, contextLeaveByDate, hourlyOn }) {
  const G = parseFloat(guaranteed) || 0;
  if (!(G > 0)) return [];
  const ws0 = normWeekStart(weekStart ?? 1);
  const dow = dk => { const m = String(dk).match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay() : null; };
  const weekOf = dk => { const w = dow(dk); return w == null ? null : addDays(dk, -((w - ws0 + 7) % 7)); };
  const f = from ? ymd(from) : null, t = to ? ymd(to) : null;
  const inPeriod = d => !!(f && t) && d >= f && d <= t;
  let weeks;
  if (f && t) {
    weeks = [];
    const span = fullWeekSpan(f, t, weekStart);
    for (let ws = span ? span.from : null; ws && ws <= span.to; ws = addDays(ws, 7)) {
      const we = addDays(ws, 6);
      if (we >= f && we <= t) weeks.push(ws);
    }
  } else {
    weeks = [...new Set((paid || []).map(e => weekOf(ymd(e.work_date))).filter(Boolean))].sort();
  }
  if (!weeks.length) return [];
  const covered = new Map(weeks.map(w => [w, 0]));
  const add = (d, h) => { const w = d ? weekOf(ymd(d)) : null; if (w && covered.has(w)) covered.set(w, covered.get(w) + (parseFloat(h) || 0)); };
  for (const e of paid || []) add(e.work_date, entryDuration(e));
  for (const fl of floorDetail || []) add(fl.date, fl.hours);
  for (const e of contextEntries || []) { const d = ymd(e.work_date); if (!inPeriod(d)) add(d, entryDuration(e)); }
  if (leave && leave.leaveByDate instanceof Map) {
    for (const [d, h] of leave.leaveByDate) add(d, h);
  } else if (leave && ((leave.sick || 0) + (leave.vacation || 0)) > 0) {
    // Undated leave totals (a hand-built statement): the last week, where the
    // leave lines are dated.
    const last = weeks[weeks.length - 1];
    covered.set(last, covered.get(last) + (leave.sick || 0) + (leave.vacation || 0));
  }
  if (contextLeaveByDate instanceof Map) for (const [d, h] of contextLeaveByDate) if (!inPeriod(ymd(d))) add(d, h);
  return weeks.map(ws => {
    const we = addDays(ws, 6);
    const c = covered.get(ws);
    const shortfall = +Math.max(0, G - c).toFixed(2);
    return { weekStart: ws, weekEnd: we, covered: +c.toFixed(2), shortfall, cost: cents(shortfall * hourlyOn(we)) };
  });
}

/**
 * Hours → worked-pay for ONE rate TYPE (hourly or daily): regular / OT /
 * prevailing / night. Every rate is looked up per entry (its own work_date), so
 * a mid-period raise prices each day at the rate in effect that day. When every
 * regular hour earns one rate, the math is exactly the single-rate engine.
 *
 * p.rateOf(e)      the worker's base rate for entry e (its date)
 * p.rateOnDate(d)  the worker's base rate on date d (rule-generated floor hours)
 * p.prevOf(e)      the prevailing rate entry e earns
 */
function workedPay(p) {
  const { paid, ctxRows, rateType, rateOf, rateOnDate, typeOnDate, prevOf, rule, threshold, weekStart, otMult, otConfig, settings, from, to, weekWorkedDays, leave } = p;

  const baseRateOf = e => (e.wage_type === 'prevailing' ? prevOf(e) : rateOf(e));

  let regularHours, overtimeHours, prevailingHours, totalHours;
  let regularCostRaw, overtimeCostRaw, prevailingCostRaw;
  let regularDays = null; // daily-rate workers only: # of paid days behind regular pay (days × rate)
  let overtimeBands = []; // [{hours, mult}] — how many OT hours at which multiplier
  // Rule-generated regular hours (min-daily floor / no-clock-in guarantee), per day —
  // materialized below as real entry rows so no paid hour is invisible.
  let floorDetail = [];

  // Weekly rule + a period that clips a week: the out-of-period hours of those weeks
  // (see weekContextEntries). `withCtx` is every entry of the touched weeks in
  // chronological order; `inPeriod` marks the ones this statement pays.
  const ctx = ctxRows;
  const inPeriod = ctx ? new Set(paid) : null;
  const withCtx = ctx ? sortChrono([...ctx, ...paid]) : paid;

  // The single rate every in-period regular hour earns, or null when a rate
  // change falls inside the period (then each hour is priced at its own rate).
  const regEntries = paid.filter(e => e.wage_type === 'regular');
  const fallbackRate = regEntries.length ? rateOf(regEntries[regEntries.length - 1]) : rateOnDate(to || from || null);

  if (rateType !== 'daily' && hasSimpleOtConfig(otConfig)) {
    // ── Rate-aware path ─────────────────────────────────────────────────────
    // ALL worked hours (regular + prevailing, any per-project prevailing rate)
    // count toward ONE overtime threshold, and each OT hour is priced at the rate
    // it earned (or the weighted-average blend). This is the only path that pays
    // overtime on prevailing / multi-rate hours — see docs/plans/rate-aware-overtime.md.
    // A dated raise inside the period is just another "multi-rate" week to it.
    const otMethod = settings.overtime_rate_method === 'weighted_average' ? 'weighted_average' : 'rate_when_worked';
    // 'regular_first' draws OT from regular hours before prevailing on a mixed day/
    // week (default 'chronological' = today's behavior). See payEnums.js.
    const wagePriority = settings.overtime_wage_priority === 'regular_first' ? 'regular_first' : 'chronological';
    // Week-context rows can fall on days paid a DAILY rate (a daily ↔ hourly switch
    // in the week: the other run of a type-switch period, or context outside it).
    // Their rate is a DAY amount, not an hourly one — blending $200/day as $200/h
    // into the weighted-average regular rate inflated OT ~2.5×. Such a day enters
    // the blend at its hourly equivalent: day pay ÷ that day's regular hours, so
    // Σ(hours × rate) over the day === the day's pay (FLSA regular rate).
    const dailyDayHours = new Map();
    if (typeOnDate) {
      for (const e of withCtx) {
        if (e.wage_type !== 'regular' || !e.start_time || !e.end_time) continue;
        const d = ymd(e.work_date);
        if (typeOnDate(d) === 'daily') dailyDayHours.set(d, (dailyDayHours.get(d) || 0) + entryDuration(e));
      }
    }
    const otBaseRateOf = e => {
      if (e.wage_type === 'regular' && dailyDayHours.size) {
        const h = dailyDayHours.get(ymd(e.work_date));
        if (h != null) return h > 0 ? rateOf(e) / h : 0;
      }
      return baseRateOf(e);
    };
    const split = splitRateAware(withCtx, {
      rule, threshold, weekStart, otMult, baseRateOf: otBaseRateOf, method: otMethod, wagePriority,
      ...(inPeriod ? { countIf: e => inPeriod.has(e) } : {}),
    });
    // Per-entry OT + reason for the line-item display column (BillPDF / WorkerMetrics).
    for (const e of paid) { e.overtime_hours = 0; e.overtime_reason = null; }
    split.worked.forEach((e, i) => {
      if (inPeriod && !inPeriod.has(e)) return; // context rows are never shown or paid here
      e.overtime_hours = split.perEntry[i].ot; e.overtime_reason = split.perEntry[i].reason;
    });
    ({ regularHours, overtimeHours, prevailingHours, regularCost: regularCostRaw, overtimeCost: overtimeCostRaw, prevailingCost: prevailingCostRaw } = split);
    totalHours = regularHours + overtimeHours + prevailingHours;
    // Simple config → every OT hour is at the one multiplier.
    if (overtimeHours > 0) overtimeBands = [{ hours: overtimeHours, mult: otMult }];
  } else {
    // ── Existing path ───────────────────────────────────────────────────────
    // Daily-rate workers, or premium OT configs (tiers, rest-day, 7th-day,
    // windows, night differential) that need per-band attribution. Prevailing
    // stays flat here until the per-band rate-aware work lands.
    const otRange = {
      from, to, workedDays: weekWorkedDays,
      // Paid-leave hours per day: a no-clock-in daily guarantee only tops the day up
      // to its floor counting leave already paid (no double-pay; partial leave still
      // gets the remainder).
      leaveByDate: (leave && leave.leaveByDate instanceof Map) ? leave.leaveByDate : null,
    };
    let ot;
    if (ctx) {
      // Chronological attribution over the whole week: this period's share is
      // OT(week hours up to `to`) − OT(week hours before `from`). Buckets are
      // cumulative per week, so the difference is exactly the in-period hours'
      // regular/OT split, per band (tiers, overrides and windows are additive).
      const fromKey = ymd(from);
      const before = ctx.filter(e => ymd(e.work_date) < fromKey);
      const upTo = computeOT(sortChrono([...before, ...paid]), rule, threshold, weekStart, otConfig, otRange);
      const prior = computeOT(before, rule, threshold, weekStart, otConfig);
      ot = { ...upTo, regularHours: upTo.regularHours - prior.regularHours, overtimeHours: upTo.overtimeHours - prior.overtimeHours, otBands: diffBands(upTo.otBands, prior.otBands) };
    } else {
      ot = computeOT(paid, rule, threshold, weekStart, otConfig, otRange);
    }
    // Per-entry OT over every entry of the touched weeks (chronological), so the
    // in-period rows carry the OT they earned given the week's earlier hours.
    annotateEntryOvertime(withCtx, rule, threshold, weekStart, otConfig);
    regularHours = ot.regularHours; overtimeHours = ot.overtimeHours;
    floorDetail = ot.floorDetail || [];
    prevailingHours = 0; prevailingCostRaw = 0;
    for (const e of paid) {
      if (e.wage_type !== 'prevailing') continue;
      // Clamp at 0 (matches entryDuration): a break longer than the shift must not
      // produce negative prevailing hours/cost.
      const h = entryDuration(e); // DST-corrected, break clamped — same definition as the OT engine
      prevailingHours += h;
      prevailingCostRaw += h * prevOf(e);
    }
    totalHours = regularHours + overtimeHours + prevailingHours;

    // Rate weights: straight-time hours of each regular entry (+ floor hours on
    // their date) and each entry's OT hours, at the rate in effect on that date.
    // One rate in the period → blendRate returns it verbatim (single-rate math).
    const otOf = e => Math.min(entryDuration(e), Math.max(0, e.overtime_hours || 0));
    const regPairs = [
      ...regEntries.map(e => ({ w: entryDuration(e) - otOf(e), r: rateOf(e) })),
      ...floorDetail.map(f => ({ w: parseFloat(f.hours) || 0, r: rateOnDate(f.date) })),
    ];
    const otPairs = regEntries.map(e => ({ w: otOf(e), r: rateOf(e) }));
    const allRates = new Set(regPairs.map(x => x.r));
    const uniform = allRates.size <= 1;
    const rate = uniform ? (allRates.size ? [...allRates][0] : fallbackRate) : null;

    if (rateType === 'daily') {
      const dailyHours = parseFloat(settings.regular_shift_hours) || 8; // daily rate ÷ standard day (8) → hourly
      const guaranteeFloors = floorDetail.filter(f => f.kind === 'guarantee');
      const guaranteeHours = guaranteeFloors.reduce((s, f) => s + (parseFloat(f.hours) || 0), 0);
      if (uniform) {
        const dc = computeDailyPayCosts(paid, rule, threshold, rate, otMult, otConfig, dailyHours, weekStart);
        // Worked days pay a flat daily rate (they showed up). Guaranteed EXTRA hours
        // (min_daily no-clock-in, no worked entry) are paid at the hourly rate — daily ÷ 8
        // — per guaranteed hour, so a 4h guarantee is half a day's pay, not a whole one.
        regularDays = guaranteeHours > 0 ? null : dc.days; // days-form label only when it reconciles to days × rate
        regularCostRaw = dc.regularCost + guaranteeHours * dc.hourly;
        // With week context the in-period OT bands come from the whole-week split above
        // (dc only sees this period's entries); days stay the in-period days.
        overtimeCostRaw = ctx ? otBandsCost(ot.otBands, dc.hourly, otMult) : dc.overtimeCost;
      } else {
        // The daily rate changed inside the period: each worked day pays the daily
        // rate in effect THAT day; OT / guaranteed hours at that day's daily ÷ 8.
        const dayRate = new Map();
        for (const e of regEntries) if (!dayRate.has(ymd(e.work_date))) dayRate.set(ymd(e.work_date), rateOf(e));
        regularDays = null; // "N days × rate" can't reconcile across two rates
        regularCostRaw = [...dayRate.values()].reduce((s, r) => s + r, 0)
          + guaranteeFloors.reduce((s, f) => s + (parseFloat(f.hours) || 0) * (dailyHours > 0 ? rateOnDate(f.date) / dailyHours : 0), 0);
        const bands = ctx ? ot.otBands : (rule === 'none' ? [] : computeOT(paid, rule, threshold, weekStart, otConfig).otBands);
        const otHourly = blendRate(otPairs.map(x => ({ w: x.w, r: dailyHours > 0 ? x.r / dailyHours : 0 })), dailyHours > 0 ? fallbackRate / dailyHours : 0);
        overtimeCostRaw = otBandsCost(bands, otHourly, otMult);
      }
    } else {
      const regRate = uniform ? rate : blendRate(regPairs, fallbackRate);
      const otRate = uniform ? rate : blendRate(otPairs, fallbackRate);
      regularCostRaw = regularHours * regRate;
      overtimeCostRaw = otBandsCost(ot.otBands, otRate, otMult);
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
      const nightRates = new Set(regEntries.map(rateOf));
      nightPremiumRaw = nightRates.size <= 1
        ? nightPremiumCost(paid, nightCfg, nightRates.size ? [...nightRates][0] : fallbackRate)
        : regEntries.reduce((s, e) => s + nightPremiumCost([e], nightCfg, rateOf(e)), 0);
    }
  }

  // The rate each in-period row was priced at, for renderers / QBO bill lines.
  for (const e of paid) { e.pay_rate = baseRateOf(e); e.pay_rate_type = e.wage_type === 'prevailing' ? 'hourly' : rateType; }

  return {
    regularHours, overtimeHours, prevailingHours, totalHours,
    regularCostRaw, overtimeCostRaw, prevailingCostRaw, regularDays, overtimeBands, floorDetail,
    nightHours, nightPremiumRaw,
  };
}

/**
 * @param opts.worker            { id, invoice_name, full_name, email, hourly_rate,
 *                                 rate_type, overtime_rule, role_id, guaranteed_weekly_hours }
 * @param opts.entries           PAID entries (roundEntriesFromSettings output) — mutated to carry overtime_hours
 * @param opts.reimbursements    approved reimbursement rows ([] to exclude, e.g. payroll views)
 * @param opts.leave             { sick, vacation, detail? } hours from computeWorker/CompanyLeave
 * @param opts.deductions        normalized deduction list (company ++ worker); [] for none
 * @param opts.otConfig          otConfigFromSettings / otConfigByRole result (or null)
 * @param opts.projectRateMap    { project_id: prevailing_rate } — per-project prevailing wage
 *                                (the CURRENT rate; only used for projects without rate history)
 * @param opts.rateBook          effective-dated rates (utils/rateHistory loadRateBook). When
 *                                given, every entry is priced at the worker / project / company
 *                                default rate IN EFFECT ON ITS work_date. Absent → the current
 *                                worker.hourly_rate / rate_type / projectRateMap (legacy).
 * @param opts.settings          scalar settings (thresholds, multiplier, rates, leave %, regular shift)
 * @param opts.from,opts.to      period (may be null for an all-time invoice)
 * @param opts.explain           attach settings_used / leaveDetail + per-entry OT/wage notes
 * @param opts.weekContextEntries PAID entries OUTSIDE [from,to] but inside the
 *                                (week_start-aligned) weeks that [from,to] touches.
 *                                Weekly OT is a whole-week fact: these count toward
 *                                each week's threshold, but only in-period hours
 *                                are paid here — the OT goes to the chronologically
 *                                later hours, so the period holding the hours past
 *                                the threshold gets that OT and two adjacent periods
 *                                sum to the full week. Ignored for OT unless the
 *                                worker's effective rule is 'weekly' (daily OT is
 *                                per-day); always counted toward the weekly guarantee.
 * @param opts.weekContextLeaveByDate Map('YYYY-MM-DD' → paid-leave hours) over those
 *                                same whole weeks (dates in [from,to] are ignored —
 *                                `leave` has them): leave just outside the period
 *                                that covers a guarantee week's hours.
 */
function buildPayStatement({ worker, entries, reimbursements = [], leave = { sick: 0, vacation: 0 }, deductions = [], otConfig = null, projectRateMap = {}, settings = {}, from = null, to = null, explain = false, weekWorkedDays = null, weekContextEntries = null, weekContextLeaveByDate = null, rateBook = null }) {
  // 'unpaid' team members are tracked (hours are still computed from their entries) but
  // earn NOTHING. Force every wage RATE to 0 and drop the pay artifacts (guarantee top-up,
  // leave, deductions, per-project prevailing rates) so ALL pay math below yields $0 —
  // regular, OT, prevailing, night premium — without special-casing each surface. This is
  // the single fail-safe every pay surface flows through (the batch routes also list-exclude
  // them so they don't render a $0 row). Reimbursements are expense REPAYMENT, not wages, so
  // they're left intact (an unpaid worker who fronted money is still owed it). Local reassigns
  // only — the caller's objects are never mutated.
  const unpaid = !!(worker && worker.worker_type === 'unpaid');
  if (unpaid) {
    worker = { ...worker, guaranteed_weekly_hours: 0 };
    leave = { sick: 0, vacation: 0 };
    deductions = [];
    projectRateMap = {}; // prevailing entries fall back to prevRate, which is 0 below
  }
  const rule = otRuleFromSettings(settings, worker.overtime_rule);
  const threshold = otThreshold(settings, rule);
  const weekStart = settings.week_start;
  const otMult = parseFloat(settings.overtime_multiplier) || 1.5;
  // Gate rate/prevRate on `unpaid` directly — a `... || 45`/`... || 0` fallback would turn a
  // zeroed setting back into the default (0 is falsy), leaking prevailing pay.
  // The company prevailing fallback (a prevailing entry on a project with no rate of
  // its own) is effective-dated too (company_prevailing_rate_history, 0210): the rate
  // in effect on the entry's date, so changing the setting never re-prices past pay.
  // No history → the setting (legacy). `|| 45` is the engine's long-standing default.
  const prevFallbackAt = d => {
    if (unpaid) return 0;
    const v = rateBook ? companyPrevailingRateOn(rateBook, d || null, settings) : parseFloat(settings.prevailing_wage_rate);
    return v || 45;
  };
  const paid = entries || [];

  // ── Rates, per date ─────────────────────────────────────────────────────
  // Without a rate book: the worker's CURRENT rate for every date (legacy). With
  // one: the effective-dated rate (utils/rateHistory.js — greatest
  // effective_date <= the date; own rate 0/missing → company default that day).
  const legacyRate = { rate: unpaid ? 0 : (parseFloat(worker.hourly_rate) || parseFloat(settings.default_hourly_rate) || 0), rateType: worker.rate_type || 'hourly' };
  const rateCache = new Map();
  const workerRateAt = (d) => {
    if (!rateBook) return legacyRate;
    const k = ymd(d) || '';
    if (!rateCache.has(k)) {
      const r = workerRateOn(rateBook, worker, k || null, settings);
      rateCache.set(k, { rate: unpaid ? 0 : r.rate, rateType: r.rateType });
    }
    return rateCache.get(k);
  };
  const prevOf = e => {
    if (unpaid) return 0;
    const pr = rateBook
      ? prevailingRateOn(rateBook, e.project_id, e.work_date, projectRateMap)
      : (projectRateMap && projectRateMap[e.project_id] != null ? projectRateMap[e.project_id] : null);
    return pr != null ? pr : prevFallbackAt(ymd(e.work_date));
  };
  const rateOf = e => workerRateAt(e.work_date).rate;
  const rateOnDate = d => workerRateAt(d).rate;
  // Period end: the date the headline rate / range-level pay (weekly guarantee) uses.
  const lastWorked = paid.length ? sortChrono(paid)[paid.length - 1].work_date : null;
  const periodEndKey = ymd(to || lastWorked || from) || null;
  // Headline company prevailing fallback (stub / explain display): the period end's.
  const prevRate = prevFallbackAt(periodEndKey);

  // Weekly rule + a period that clips a week: the out-of-period hours of those weeks.
  const ctxRows = (rule === 'weekly' && from && to && Array.isArray(weekContextEntries) && weekContextEntries.length)
    // Shallow copies: the OT annotation mutates rows, and a context row may be
    // another period's in-period row (workerPeriodStatements shares one fetch).
    ? weekContextEntries.map(e => ({ ...e })) : null;

  const typeAt = d => workerRateAt(d).rateType;
  const common = { rateOf, rateOnDate, typeOnDate: typeAt, prevOf, rule, threshold, weekStart, otMult, otConfig, settings, weekWorkedDays, leave };
  let core;
  const types = rateBook ? new Set([...paid.map(e => typeAt(e.work_date)), ...(from && to ? eachDay(from, to).map(typeAt) : [])]) : null;
  if (!types || types.size <= 1) {
    const rateType = types && types.size === 1 ? [...types][0] : (rateBook ? typeAt(periodEndKey) : legacyRate.rateType);
    core = workedPay({ ...common, paid, ctxRows, rateType, from, to });
  } else {
    // The rate TYPE changed inside the period (hourly ↔ daily): price each run of
    // days under the type in effect those days. Runs partition [from,to] (or the
    // worked dates when the range is open). Each run sees the rest of the week
    // (other runs + outside context) as weekly-OT context, so OT is still
    // attributed chronologically across the switch.
    // Every day of the period plus every worked date (so no entry can fall outside a run).
    const days = [...new Set([...(from && to ? eachDay(from, to) : []), ...paid.map(e => ymd(e.work_date))])].sort();
    const runs = [];
    for (const d of days) {
      const t = typeAt(d);
      if (!runs.length || runs[runs.length - 1].type !== t) runs.push({ type: t, from: d, to: d });
      else runs[runs.length - 1].to = d;
    }
    const sorted = sortChrono(paid);
    core = { regularHours: 0, overtimeHours: 0, prevailingHours: 0, totalHours: 0, regularCostRaw: 0, overtimeCostRaw: 0, prevailingCostRaw: 0, regularDays: null, overtimeBands: [], floorDetail: [], nightHours: 0, nightPremiumRaw: 0 };
    for (const run of runs) {
      const seg = sorted.filter(e => ymd(e.work_date) >= run.from && ymd(e.work_date) <= run.to);
      const others = sorted.filter(e => !seg.includes(e)).map(e => ({ ...e }));
      const segCtx = rule === 'weekly' ? [...(ctxRows || []), ...others] : null;
      const r = workedPay({ ...common, paid: seg, ctxRows: segCtx && segCtx.length ? segCtx : null, rateType: run.type, from: run.from, to: run.to });
      for (const k of ['regularHours', 'overtimeHours', 'prevailingHours', 'totalHours', 'regularCostRaw', 'overtimeCostRaw', 'prevailingCostRaw', 'nightHours', 'nightPremiumRaw']) core[k] += r[k] || 0;
      core.overtimeBands.push(...r.overtimeBands);
      core.floorDetail.push(...r.floorDetail);
    }
  }
  const { regularHours, overtimeHours, prevailingHours, totalHours, regularCostRaw, overtimeCostRaw, prevailingCostRaw, regularDays, overtimeBands, floorDetail, nightHours, nightPremiumRaw } = core;
  const nightCfg = (otConfig && otConfig.nightDifferential) ? otConfig.nightDifferential : null; // explain only (nightPremiumRaw > 0)

  // Headline rate: the rate the LAST worked day earned (else the period end's).
  // `rateChanges` lists each distinct rate the period's worked days earned, in
  // order, when there was more than one — so a stub can say "rate changed".
  const headline = workerRateAt(lastWorked || periodEndKey);
  const rate = headline.rate;
  const rateType = headline.rateType;
  const rateChanges = [];
  if (rateBook) {
    for (const e of sortChrono(paid)) {
      if (e.wage_type === 'prevailing') continue;
      const r = workerRateAt(e.work_date);
      const last = rateChanges[rateChanges.length - 1];
      if (!last || last.rate !== r.rate || last.rateType !== r.rateType) rateChanges.push({ from: ymd(e.work_date), rate: r.rate, rateType: r.rateType });
    }
  }

  const mult = leaveRateMultipliers(settings);
  const sickHours = (leave && leave.sick) || 0;
  const vacationHours = (leave && leave.vacation) || 0;

  // Per-hour pay lines (leave, weekly guarantee shortfall) price at an HOURLY rate.
  // For a daily-rate worker `rate` is the DAILY amount, so use the derived hourly
  // (daily ÷ standard day) — otherwise 8h of sick would pay 8 daily rates (~8× over).
  const leaveDailyHours = parseFloat(settings.regular_shift_hours) || 8;
  const hourlyOn = d => { const r = workerRateAt(d); return r.rateType === 'daily' ? (leaveDailyHours > 0 ? r.rate / leaveDailyHours : 0) : r.rate; };
  const hourlyRate = hourlyOn(periodEndKey);

  // Weekly-hours guarantee, PER WEEK (weekGuarantee below). Paid leave counts toward
  // it: a worker guaranteed 40h who worked 30h and took 10h sick has been covered.
  const guaranteeByWeek = weekGuarantee({
    guaranteed: worker.guaranteed_weekly_hours, weekStart, from, to, paid, floorDetail,
    contextEntries: weekContextEntries, leave, contextLeaveByDate: weekContextLeaveByDate, hourlyOn,
  });
  const guaranteeShortfall = +guaranteeByWeek.reduce((s, w) => s + w.shortfall, 0).toFixed(2);
  const guaranteeWeeks = guaranteeByWeek.length;
  const guaranteeMinHours = +((parseFloat(worker.guaranteed_weekly_hours) || 0) * guaranteeWeeks).toFixed(2);
  // Leave is priced at the rate in effect on each leave day (a raise mid-period pays
  // the pre-raise sick day at the old rate). One rate → exactly hourlyRate.
  const blendLeave = m => blendRate([...m].map(([d, h]) => ({ w: h, r: hourlyOn(d) })), hourlyRate);
  const leaveHourly = (leave && leave.leaveByDate instanceof Map && leave.leaveByDate.size)
    ? blendLeave(leave.leaveByDate)
    : hourlyRate;
  // Sick and vacation each at the rates of THEIR OWN days (computeLeaveHours'
  // sickByDate / vacationByDate). One merged blend priced a $20 sick day and a
  // $30 vacation day both at $25. Callers without the per-type maps keep the blend.
  const typedLeaveHourly = m => (m instanceof Map ? (m.size ? blendLeave(m) : hourlyRate) : leaveHourly);
  const sickHourly = typedLeaveHourly(leave && leave.sickByDate);
  const vacationHourly = typedLeaveHourly(leave && leave.vacationByDate);

  // Round every line to cents so line items provably sum to the totals.
  const regularCost = cents(regularCostRaw);
  const overtimeCost = cents(overtimeCostRaw);
  const prevailingCost = cents(prevailingCostRaw);
  // One cents-rounded line per week (each at the rate in effect on the week's last
  // day), summed — the QBO bill posts exactly these per-week amounts.
  const guaranteeCost = cents(guaranteeByWeek.reduce((s, w) => s + w.cost, 0));
  const sickCost = cents(sickHours * sickHourly * mult.sick);
  const vacationCost = cents(vacationHours * vacationHourly * mult.vacation);
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
      if ((e.overtime_hours || 0) > 0) ex.push({ code: 'overtime', otHours: e.overtime_hours, reason: e.overtime_reason || (rule === 'weekly' ? 'weekly' : 'daily'), threshold, rule, ruleId: e.overtime_ruleId || undefined });
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
    explain: [{ code: f.kind === 'guarantee' ? 'guarantee_day' : 'min_daily_floor', hours: f.hours, ruleId: f.ruleId || undefined }],
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
  // Each worked row carries the paid hours the engine priced it at (entryDuration:
  // the paid punch, DST-corrected, net of break) so renderers display the server's
  // number instead of re-deriving it from start/end — which can't see a DST change.
  for (const e of paid) if (!e.synthetic) e.paid_hours = entryDuration(e);
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
      // [{ weekStart, weekEnd, covered, shortfall, cost }] — the weeks this period pays.
      guaranteeByWeek,
      total: totalHours, mileage,
      // Daily-rate workers: the paid-day count behind regular pay (regular = days × rate),
      // so a stub can show "N days × rate/day" instead of an unverifiable "/hr" line.
      regularDays,
    },
    cost: {
      regular: regularCost, overtime: overtimeCost, prevailing: prevailingCost,
      night: nightPremium,
      sick: sickCost, vacation: vacationCost, guarantee: guaranteeCost,
      sickRate: cents(sickHourly * mult.sick), vacationRate: cents(vacationHourly * mult.vacation),
    },
    rates: { rate, rateType, prevailingWageRate: prevRate, overtimeMultiplier: otMult, sickPct: settings.sick_pay_pct, vacationPct: settings.vacation_pay_pct, ...(rateChanges.length > 1 ? { changes: rateChanges } : {}) },
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
  // Entries are fetched for the FULL weeks touching [from,to] so weekly OT sees the
  // whole week; only [from,to] is paid (buildPayStatement weekContextEntries).
  const span = fullWeekSpan(from, to, settings.week_start);
  // The weekly guarantee counts leave on the week's out-of-period days too.
  const wantCtxLeave = !!span && (parseFloat(worker.guaranteed_weekly_hours) || 0) > 0;
  const [entriesR, reimbR, dedR, projectRateMap, leave, weekWorkedR, rateBook, spanLeave] = await Promise.all([
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
      [worker.id, (span ? span.from : from) || null, (span ? span.to : to) || null]
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
    // Worked-day DATES for the whole weeks touching [from,to] (±7d), so a week-based
    // guarantee gate can see clock-ins just outside the pulled range. Dates only —
    // these never become entries or pay; they only inform the gate. See computeOT.
    pool.query(
      `SELECT DISTINCT to_char(work_date, 'YYYY-MM-DD') AS d
         FROM time_entries
        WHERE user_id = $1 AND status = 'approved' AND wage_type = 'regular'
          AND $2::date IS NOT NULL AND $3::date IS NOT NULL
          AND work_date >= ($2::date - 7) AND work_date <= ($3::date + 7)`,
      [worker.id, from || null, to || null]
    ),
    // Effective-dated rates: this worker, every company project, the company default.
    loadRateBook({ companyId, userIds: [worker.id], projectIds: null, to: (span ? span.to : to) || null }),
    wantCtxLeave ? computeWorkerLeave({ companyId, userId: worker.id, roleId: worker.role_id, settings, from: span.from, to: span.to }) : null,
  ]);

  const rounded = roundEntriesFromSettings(entriesR.rows, settings, { workerRoleById: { [worker.id]: worker.role_id }, explain });
  const { inRange: entries, context: weekContextEntries } = span ? splitPeriod(rounded, from, to) : { inRange: rounded, context: [] };
  const otConfig = otConfigFromSettings(settings, worker.role_id, worker.id);
  const { previewDeductions, deferredNames } = previewDeductionSplit(settings, worker, dedR.rows);
  const weekWorkedDays = new Set((weekWorkedR.rows || []).map(r => r.d));

  const stmt = buildPayStatement({
    worker, entries, reimbursements: reimbR.rows, leave, deductions: previewDeductions,
    otConfig, projectRateMap, settings, from, to, explain, weekWorkedDays, weekContextEntries, rateBook,
    weekContextLeaveByDate: spanLeave ? spanLeave.leaveByDate : null,
  });
  stmt.deferredDeductions = deferredNames; // grouped/monthly deductions shown at payroll run, not here
  return stmt;
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

  // Full weeks touching [from,to], so weekly OT sees the whole week (see workerStatement).
  const span = fullWeekSpan(from, to, settings.week_start);
  // The weekly guarantee counts leave on the week's out-of-period days too.
  const ctxLeaveWorkers = span ? list.filter(w => (parseFloat(w.guaranteed_weekly_hours) || 0) > 0) : [];
  const [entriesR, dedR, projectRateMap, leaveByUser, weekWorkedR, rateBook, spanLeaveByUser] = await Promise.all([
    pool.query(
      // ORDER BY is REQUIRED, not cosmetic: rate-aware OT attributes overtime to
      // the chronologically-later hours and prices each at its own rate, so the
      // gross depends on entry order. The single-worker loaders order the same
      // way; without this, the overtime report / payroll CSV could disagree with
      // the invoice for a multi-rate worker (nondeterministic DB scan order).
      //
      // Explicit column list: it MUST carry every te.* column the engine reads —
      // overtime_hours_override was missing, so the report / CSV / QBO journal
      // ignored admin OT overrides the invoice and stubs honoured.
      `SELECT te.id, te.user_id, te.project_id, te.wage_type, te.start_time, te.end_time, to_char(te.work_date, 'YYYY-MM-DD') AS work_date,
              te.break_minutes, te.mileage, te.overtime_hours_override,
              te.start_ts, te.end_ts, te.timezone
       FROM time_entries te
       WHERE te.company_id = $1 AND te.work_date >= $2 AND te.work_date <= $3 AND te.status = 'approved'
       ORDER BY te.user_id, te.work_date ASC, te.start_time ASC`,
      [companyId, span ? span.from : from, span ? span.to : to]
    ),
    pool.query(
      'SELECT user_id, id, name, kind, value, cap_amount, active FROM worker_deductions WHERE company_id = $1 AND active = true ORDER BY id',
      [companyId]
    ),
    loadProjectRateMap(companyId),
    computeCompanyLeave({ companyId, workers: list, settings, from, to }),
    // Worked-day DATES for the whole weeks touching [from,to] (±7d), per worker, so a
    // week-based guarantee gate sees clock-ins just outside the pulled range. Dates
    // only — never entries or pay. See the pay-rule-window principle in computeOT.
    pool.query(
      `SELECT te.user_id, to_char(te.work_date, 'YYYY-MM-DD') AS d
         FROM time_entries te
        WHERE te.company_id = $1 AND te.status = 'approved' AND te.wage_type = 'regular'
          AND te.work_date >= ($2::date - 7) AND te.work_date <= ($3::date + 7)
        GROUP BY te.user_id, te.work_date`,
      [companyId, from, to]
    ),
    // Effective-dated rates for these workers + every company project, one query each.
    loadRateBook({ companyId, userIds: list.map(w => w.id), projectIds: null, to: span ? span.to : to }),
    ctxLeaveWorkers.length ? computeCompanyLeave({ companyId, workers: ctxLeaveWorkers, settings, from: span.from, to: span.to }) : new Map(),
  ]);

  const paidRows = roundEntriesFromSettings(entriesR.rows, settings, { workerRoleById });
  const byWorker = {};
  paidRows.forEach(e => { (byWorker[e.user_id] = byWorker[e.user_id] || []).push(e); });
  const weekWorkedByUser = new Map();
  (weekWorkedR.rows || []).forEach(r => { (weekWorkedByUser.get(r.user_id) || weekWorkedByUser.set(r.user_id, new Set()).get(r.user_id)).add(r.d); });

  const dedByUser = {};
  dedR.rows.forEach(r => { (dedByUser[r.user_id] = dedByUser[r.user_id] || []).push(r); });

  const otConfigByRole = otConfigByRoleFactory(settings);
  for (const w of list) {
    const { previewDeductions, deferredNames } = previewDeductionSplit(settings, w, dedByUser[w.id] || []);
    const { inRange, context } = span ? splitPeriod(byWorker[w.id] || [], from, to) : { inRange: byWorker[w.id] || [], context: [] };
    const stmt = buildPayStatement({
      worker: w,
      entries: inRange,
      weekContextEntries: context,
      reimbursements: [],
      leave: leaveByUser.get(w.id) || { sick: 0, vacation: 0 },
      deductions: previewDeductions,
      otConfig: otConfigByRole(w.role_id, w.id),
      projectRateMap,
      rateBook,
      settings, from, to, explain: false,
      weekWorkedDays: weekWorkedByUser.get(w.id) || null,
      weekContextLeaveByDate: spanLeaveByUser.has(w.id) ? spanLeaveByUser.get(w.id).leaveByDate : null,
    });
    stmt.deferredDeductions = deferredNames;
    out.set(w.id, stmt);
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
  // pg returns pay_periods.period_start/end as local-midnight Date objects; ymd()
  // normalizes both Date and string to 'YYYY-MM-DD'. A bare String(date).slice gave
  // "Wed Aug 19", which then threw as a ::date bound AND never matched a to_char'd
  // work_date in the filter below — 500-ing the legacy (no-ruleset) pay-stub path.
  const day = d => ymd(d);
  const minDate = list.reduce((m, p) => (day(p.period_start) < m ? day(p.period_start) : m), day(list[0].period_start));
  const maxDate = list.reduce((m, p) => (day(p.period_end) > m ? day(p.period_end) : m), day(list[0].period_end));
  // Entries for the FULL weeks touching the span, so each period's weekly OT sees
  // the whole week (incl. the parts in an adjacent / not-requested period).
  const span = fullWeekSpan(minDate, maxDate, settings.week_start) || { from: minDate, to: maxDate };

  const [entriesR, dedR, projectRateMap, leaveReqs, leaveShifts, weekWorkedR, rateBook] = await Promise.all([
    pool.query(
      `SELECT te.*, p.name as project_name, to_char(te.work_date, 'YYYY-MM-DD') AS work_date
       FROM time_entries te LEFT JOIN projects p ON te.project_id = p.id
       WHERE te.user_id = $1 AND te.status = 'approved' AND te.work_date >= $2 AND te.work_date <= $3
       ORDER BY te.work_date, te.start_time`,
      [worker.id, span.from, span.to]
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
      [worker.id, companyId, span.from, span.to] // whole weeks: the weekly guarantee counts a week's leave
    ),
    pool.query(
      `SELECT shift_date, start_time, end_time FROM shifts
       WHERE user_id = $1 AND company_id = $2 AND shift_date >= $3::date AND shift_date <= $4::date`,
      [worker.id, companyId, span.from, span.to]
    ),
    // Worked-day DATES for the whole weeks touching the span (±7d), so each period's
    // week-based guarantee gate sees clock-ins in adjacent periods / just outside the
    // span. Dates only — never entries or pay. See the pay-rule-window principle.
    pool.query(
      `SELECT DISTINCT to_char(work_date, 'YYYY-MM-DD') AS d FROM time_entries
        WHERE user_id = $1 AND status = 'approved' AND wage_type = 'regular'
          AND work_date >= ($2::date - 7) AND work_date <= ($3::date + 7)`,
      [worker.id, minDate, maxDate]
    ),
    loadRateBook({ companyId, userIds: [worker.id], projectIds: null, to: span.to }),
  ]);

  const paidAll = roundEntriesFromSettings(entriesR.rows, settings, { workerRoleById: { [worker.id]: worker.role_id } });
  const weekWorkedDays = new Set((weekWorkedR.rows || []).map(r => r.d));
  const otConfig = otConfigFromSettings(settings, worker.role_id, worker.id);
  const { previewDeductions, deferredNames } = previewDeductionSplit(settings, worker, dedR.rows);
  const leaveRules = sickRulesFromSettings(settings, worker.role_id, worker.id);
  const shiftsByDate = shiftHoursByDate(leaveShifts.rows);

  for (const period of list) {
    const ps = day(period.period_start), pe = day(period.period_end);
    const entries = paidAll.filter(e => e.work_date >= ps && e.work_date <= pe);
    const leave = computeLeaveHours(leaveReqs.rows, shiftsByDate, leaveRules, settings.regular_shift_hours, ps, pe);
    if (entries.length === 0 && leave.sick === 0 && leave.vacation === 0) continue; // leave-only periods still show; fully-empty drop
    // This period's week context: rows outside [ps,pe] but in the weeks it touches.
    const pw = fullWeekSpan(ps, pe, settings.week_start);
    const weekContextEntries = pw ? paidAll.filter(e => (e.work_date < ps || e.work_date > pe) && e.work_date >= pw.from && e.work_date <= pw.to) : [];
    const weekContextLeaveByDate = pw && (parseFloat(worker.guaranteed_weekly_hours) || 0) > 0
      ? computeLeaveHours(leaveReqs.rows, shiftsByDate, leaveRules, settings.regular_shift_hours, pw.from, pw.to).leaveByDate
      : null;
    const statement = buildPayStatement({
      worker, entries, reimbursements: [], leave, deductions: previewDeductions,
      otConfig, projectRateMap, rateBook, settings, from: ps, to: pe, explain: false, weekWorkedDays, weekContextEntries,
      weekContextLeaveByDate,
    });
    statement.deferredDeductions = deferredNames; // grouped/monthly deductions shown at payroll run, not here
    out.push({ period, statement });
  }
  return out;
}

/**
 * THE worker set for every company-wide payroll total: the payroll CSV, the
 * overtime report and the QuickBooks payroll journal. They used to disagree —
 * the JE loaded anyone with approved time/leave (incl. owners/admins), the CSV /
 * report only ACTIVE role='worker' users — so the JE posted wages the payroll CSV
 * never paid, and the CSV dropped a worker deactivated mid-period.
 *
 *   - approved time OR approved sick/vacation in [$2,$3], whatever the active flag,
 *     OR still active with a weekly-hours guarantee (owed a top-up with no time);
 *   - never worker_type 'owner' / 'unpaid';
 *   - there is no "salaried" flag, so role admin / super_admin only when they have
 *     their own rate DURING THE RANGE (rates are effective-dated): a
 *     worker_rate_history row with a rate > 0 in effect at some point in [$2,$3]
 *     — effective on/before $3 and not superseded on/before $2. No history at all
 *     (pre-0209 data) → the current users.hourly_rate. An owner-operator logging
 *     time for job cost is not put on payroll at the company default rate, and a
 *     re-run of an old range isn't changed by today's rate.
 * Params: $1 company_id, $2 from, $3 to. Rows carry what companyStatements needs.
 */
const PAYROLL_WORKERS_SQL = `SELECT u.id, u.full_name, u.invoice_name, u.hourly_rate, u.rate_type, u.overtime_rule,
       u.role_id, u.guaranteed_weekly_hours, u.worker_type
  FROM users u
 WHERE u.company_id = $1
   AND COALESCE(u.worker_type, 'employee') NOT IN ('owner', 'unpaid')
   AND (u.role NOT IN ('admin', 'super_admin')
        OR EXISTS (SELECT 1 FROM worker_rate_history h
                    WHERE h.user_id = u.id AND h.company_id = $1 AND h.hourly_rate > 0
                      AND h.effective_date <= $3::date
                      AND NOT EXISTS (SELECT 1 FROM worker_rate_history h2
                                       WHERE h2.user_id = u.id AND h2.company_id = $1
                                         AND h2.effective_date > h.effective_date AND h2.effective_date <= $2::date))
        OR (NOT EXISTS (SELECT 1 FROM worker_rate_history h3 WHERE h3.user_id = u.id AND h3.company_id = $1)
            AND COALESCE(u.hourly_rate, 0) > 0))
   AND (EXISTS (SELECT 1 FROM time_entries te
                 WHERE te.user_id = u.id AND te.company_id = $1 AND te.status = 'approved'
                   AND te.work_date >= $2::date AND te.work_date <= $3::date)
        OR EXISTS (SELECT 1 FROM time_off_requests r
                    WHERE r.user_id = u.id AND r.company_id = $1 AND r.status = 'approved'
                      AND r.type IN ('sick','vacation')
                      AND r.start_date <= $3::date AND r.end_date >= $2::date)
        OR (u.active = true AND COALESCE(u.guaranteed_weekly_hours, 0) > 0))
 ORDER BY u.full_name, u.id`;

/** Rows of PAYROLL_WORKERS_SQL for [from,to]. */
async function payrollWorkers(companyId, from, to, db = pool) {
  const r = await db.query(PAYROLL_WORKERS_SQL, [companyId, from, to]);
  return (r && r.rows) || [];
}

module.exports = { buildPayStatement, workerStatement, companyStatements, workerPeriodStatements, payrollWorkers, PAYROLL_WORKERS_SQL };
