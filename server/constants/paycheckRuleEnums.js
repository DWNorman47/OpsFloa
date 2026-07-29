/**
 * Fixed-value sets + a defensive normalizer for the `paycheck_rules` company
 * setting — a JSON policy of named RULESETS describing when paychecks are issued
 * and how/when deductions apply. Assigned to employee types + consumed by the pay
 * engine LATER; this phase only stores + edits them.
 *
 * Money is stored in CENTS (house convention). See docs/plans/paycheck-rules.md and
 * docs/db-enums.md (every fixed-value field below has a row there). The normalizer
 * mirrors hoursRules.parsePolicy: any malformed input degrades to a safe empty/
 * defaulted value rather than throwing, so a bad settings row can never break a read.
 */

const PAYCHECK_FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly'];
// How a weekly/biweekly pay period relates to its pay date (semimonthly/monthly are
// calendar spans and ignore this). See server/utils/payPeriods.js periodBounds().
const PERIOD_BASES         = ['work_week', 'prior_cycle', 'on_payday'];
const DEDUCTION_TIMINGS    = ['every', 'grouped'];
const GROUP_BY             = ['pair', 'month'];
const GROUP_APPLY_ON       = ['first', 'second', 'last'];
const WEEKEND_SHIFTS       = ['none', 'before', 'after'];
const DEDUCTION_CAP_TYPES  = ['none', 'amount', 'percent'];
const DEDUCTION_SCOPES     = ['all', 'selected'];

const MAX_RULESETS = 50;

// ── clamps ────────────────────────────────────────────────────────────────────
const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const clampWeekday = v => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 && n <= 6 ? n : 4; }; // default Thu
const clampDay = (v, fallback = null) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 1 && n <= 31 ? n : fallback; };
const clampPct = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 0; };
const nonNegCents = v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? n : 0; };
const isYmd = v => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const date = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === v;
};

function normalizeRuleset(r, i) {
  if (!r || typeof r !== 'object') return null;
  const sched = r.schedule && typeof r.schedule === 'object' ? r.schedule : {};
  const ded = r.deductions && typeof r.deductions === 'object' ? r.deductions : {};
  const group = ded.group && typeof ded.group === 'object' ? ded.group : {};
  const cap = ded.cap && typeof ded.cap === 'object' ? ded.cap : {};

  const daysOfMonth = (Array.isArray(sched.daysOfMonth) ? sched.daysOfMonth : [])
    .map(d => clampDay(d))
    .filter(d => d != null)
    .slice(0, 2);

  return {
    id: (typeof r.id === 'string' && r.id) ? r.id.slice(0, 40) : `pr_${i}`,
    name: String(r.name == null ? '' : r.name).slice(0, 120),
    // Role IDs are integer database keys. Normalize JSON strings so a restored or
    // externally written setting still matches users.role_id with strict equality.
    roles: [...new Set(
      (Array.isArray(r.roles) ? r.roles : [])
        .filter(x => (typeof x === 'number' || typeof x === 'string') && String(x).trim() !== '')
        .map(Number)
        .filter(x => Number.isInteger(x) && x > 0)
    )].slice(0, 200),
    schedule: {
      frequency: oneOf(sched.frequency, PAYCHECK_FREQUENCIES, 'biweekly'),
      periodBasis: oneOf(sched.periodBasis, PERIOD_BASES, 'work_week'),
      payWeekday: clampWeekday(sched.payWeekday),
      anchorDate: isYmd(sched.anchorDate) ? sched.anchorDate : null,
      daysOfMonth,
      dayOfMonth: sched.dayOfMonth === 'last' ? 'last' : clampDay(sched.dayOfMonth, 30),
      weekendShift: oneOf(sched.weekendShift, WEEKEND_SHIFTS, 'none'),
    },
    deductions: {
      timing: oneOf(ded.timing, DEDUCTION_TIMINGS, 'every'),
      group: {
        by: oneOf(group.by, GROUP_BY, 'pair'),
        applyOn: oneOf(group.applyOn, GROUP_APPLY_ON, 'second'),
      },
      combineGroup: ded.combineGroup !== false, // default true
      exemptAmountCents: nonNegCents(ded.exemptAmountCents),
      cap: {
        type: oneOf(cap.type, DEDUCTION_CAP_TYPES, 'none'),
        valueCents: nonNegCents(cap.valueCents),
        valuePct: clampPct(cap.valuePct),
      },
      minNetCents: nonNegCents(ded.minNetCents),
      scope: oneOf(ded.scope, DEDUCTION_SCOPES, 'all'),
      selectedDeductionIds: (Array.isArray(ded.selectedDeductionIds) ? ded.selectedDeductionIds : [])
        .filter(x => typeof x === 'string')
        .slice(0, 100),
    },
    notes: String(r.notes == null ? '' : r.notes).slice(0, 500),
  };
}

/** Parse the stored `paycheck_rules` string into a normalized policy. Never throws. */
function normalizePaycheckRules(raw) {
  if (raw == null || raw === '') return { version: 1, rulesets: [] };
  let obj;
  try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return { version: 1, rulesets: [] }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { version: 1, rulesets: [] };
  const rulesets = (Array.isArray(obj.rulesets) ? obj.rulesets : [])
    .map((r, i) => normalizeRuleset(r, i))
    .filter(Boolean)
    .slice(0, MAX_RULESETS);
  return { version: 1, rulesets };
}

module.exports = {
  PAYCHECK_FREQUENCIES,
  PERIOD_BASES,
  DEDUCTION_TIMINGS,
  GROUP_BY,
  GROUP_APPLY_ON,
  WEEKEND_SHIFTS,
  DEDUCTION_CAP_TYPES,
  DEDUCTION_SCOPES,
  MAX_RULESETS,
  normalizeRuleset,
  normalizePaycheckRules,
};
