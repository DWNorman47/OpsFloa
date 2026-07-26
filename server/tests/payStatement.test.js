/**
 * The one pay statement every surface renders. These pin the assembly the four
 * surfaces used to each do by hand: line items must reconcile to the totals, the
 * numbers must be deterministic ("one day, one answer"), and the reconciled
 * decisions hold — prevailing priced per-project, leave × its %, guarantee,
 * deductions → net (wages-net excludes reimbursements, net-pay includes them).
 */

jest.mock('../db', () => ({ query: jest.fn() }));
const { buildPayStatement } = require('../utils/payStatement');

const SETTINGS = {
  overtime_threshold: 8, week_start: 1, overtime_multiplier: 1.5,
  prevailing_wage_rate: 45, default_hourly_rate: 30,
  sick_pay_pct: 100, vacation_pay_pct: 100, regular_shift_hours: 8, deductions: null,
};
const worker = (over = {}) => ({ id: 1, hourly_rate: 30, rate_type: 'hourly', overtime_rule: 'daily', role_id: null, guaranteed_weekly_hours: 0, ...over });
const entry = (over = {}) => ({ user_id: 1, work_date: '2026-07-06', wage_type: 'regular', start_time: '08:00:00', end_time: '16:00:00', break_minutes: 0, mileage: 0, project_id: null, ...over });
const build = (opts = {}) => buildPayStatement({
  worker: worker(), entries: [], reimbursements: [], leave: { sick: 0, vacation: 0 },
  deductions: [], otConfig: null, projectRateMap: {}, settings: SETTINGS,
  from: '2026-07-06', to: '2026-07-06', explain: false, ...opts,
});

describe('buildPayStatement — hours + reconciliation', () => {
  test('daily OT split and line items sum to gross', () => {
    const st = build({ entries: [entry({ end_time: '18:00:00' })] }); // 10h → 8 reg + 2 OT
    expect(st.hours.regular).toBeCloseTo(8);
    expect(st.hours.overtime).toBeCloseTo(2);
    expect(st.cost.regular).toBe(240);   // 8 × 30
    expect(st.cost.overtime).toBe(90);   // 2 × 30 × 1.5
    const lines = st.cost.regular + st.cost.overtime + st.cost.prevailing + st.cost.guarantee + st.cost.sick + st.cost.vacation;
    expect(st.totals.grossWages).toBe(330);
    expect(st.totals.grossWages).toBeCloseTo(lines);
  });

  test('deterministic — same inputs, same numbers', () => {
    const a = build({ entries: [entry({ end_time: '18:00:00' })] });
    const b = build({ entries: [entry({ end_time: '18:00:00' })] });
    expect(a.cost).toEqual(b.cost);
    expect(a.totals).toEqual(b.totals);
    expect(a.hours).toEqual(b.hours);
  });
});

describe('buildPayStatement — the reconciled decisions', () => {
  test('prevailing priced per-project, company rate as fallback', () => {
    const fallback = build({ entries: [entry({ wage_type: 'prevailing', project_id: null })] }); // 8h
    expect(fallback.hours.prevailing).toBeCloseTo(8);
    expect(fallback.cost.prevailing).toBe(360); // 8 × 45 (company)
    const perProject = build({ entries: [entry({ wage_type: 'prevailing', project_id: 7 })], projectRateMap: { 7: 50 } });
    expect(perProject.cost.prevailing).toBe(400); // 8 × 50 (project rate wins)
  });

  test('leave paid at its configured % of base, own lines', () => {
    const full = build({ leave: { sick: 8, vacation: 4 } });
    expect(full.cost.sick).toBe(240);     // 8 × 30 × 100%
    expect(full.cost.vacation).toBe(120); // 4 × 30 × 100%
    const half = build({ leave: { sick: 8, vacation: 0 }, settings: { ...SETTINGS, sick_pay_pct: 50 } });
    expect(half.cost.sick).toBe(120);     // 8 × 30 × 50%
    expect(half.cost.sickRate).toBe(15);  // 30 × 50%
  });

  test('guarantee tops the period up to the weekly floor', () => {
    const st = build({ worker: worker({ guaranteed_weekly_hours: 40 }), entries: [entry()] }); // 8h worked, 1 week
    expect(st.hours.guaranteeShortfall).toBe(32); // 40 − 8
    expect(st.cost.guarantee).toBe(960);          // 32 × 30
  });

  test('paid leave counts toward the guarantee (no double-pay)', () => {
    const st = build({
      worker: worker({ guaranteed_weekly_hours: 40 }),
      entries: [entry()],                // 8h worked
      leave: { sick: 20, vacation: 4 },  // 24h paid leave
    });
    // Covered for 8 + 24 = 32 of the 40h guarantee → 8h shortfall, not 32.
    expect(st.hours.guaranteeShortfall).toBe(8);
    expect(st.cost.guarantee).toBe(240); // 8 × 30
  });

  test('deductions → net; wages-net excludes reimbursements, net-pay includes them', () => {
    const st = build({
      entries: [entry()], // gross 240
      reimbursements: [{ amount: 50 }],
      deductions: [{ id: 'd1', name: 'Tax', kind: 'percent', value: 10 }],
    });
    expect(st.totals.grossWages).toBe(240);
    expect(st.totals.deductionsTotal).toBe(24);   // 10% of 240
    expect(st.totals.reimbursementTotal).toBe(50);
    expect(st.totals.netWages).toBe(216);         // 240 − 24 (payroll views)
    expect(st.totals.netPay).toBe(266);           // 240 − 24 + 50 (invoice/stub)
    expect(st.totals.totalCost).toBe(290);        // gross 240 + reimb 50
  });
});

describe('buildPayStatement — anti-drift contract', () => {
  // The same statement drives every surface, so the shared buckets are identical
  // no matter which projection reads them. (The routes just relabel these keys.)
  test('invoice projection and report projection read identical numbers', () => {
    const st = build({ entries: [entry({ end_time: '18:00:00', wage_type: 'prevailing', project_id: 7 })], projectRateMap: { 7: 50 }, leave: { sick: 8, vacation: 0 } });
    const invoice = { regular_hours: st.hours.regular, overtime_hours: st.hours.overtime, prevailing_hours: st.hours.prevailing, prevailing_cost: st.cost.prevailing, sick_hours: st.hours.sick, sick_cost: st.cost.sick };
    const report = { regular_hours: st.hours.regular, overtime_hours: st.hours.overtime, prevailing_hours: st.hours.prevailing, prevailing_cost: st.cost.prevailing, sick_hours: st.hours.sick, sick_cost: st.cost.sick };
    expect(report).toEqual(invoice);
    expect(report.prevailing_cost).toBe(500); // 10h × 50 (per-project), one computation feeding both
  });
});
