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

  test('feature_overtime off → no overtime accrues (all hours straight)', () => {
    // 10h day, daily-8: normally 8 reg + 2 OT. With "Allow overtime" off, the
    // rule resolves to 'none', so all 10h are regular and there's no OT premium.
    const st = build({ entries: [entry({ end_time: '18:00:00' })], settings: { ...SETTINGS, feature_overtime: false } });
    expect(st.hours.regular).toBeCloseTo(10);
    expect(st.hours.overtime).toBeCloseTo(0);
    expect(st.cost.regular).toBe(300);   // 10 × 30
    expect(st.cost.overtime).toBe(0);
    expect(st.totals.grossWages).toBe(300);
  });

  test('deterministic — same inputs, same numbers', () => {
    const a = build({ entries: [entry({ end_time: '18:00:00' })] });
    const b = build({ entries: [entry({ end_time: '18:00:00' })] });
    expect(a.cost).toEqual(b.cost);
    expect(a.totals).toEqual(b.totals);
    expect(a.hours).toEqual(b.hours);
  });
});

describe('buildPayStatement — unpaid worker earns nothing (hours still tracked)', () => {
  test('all wage costs + totals are zero, hours still computed, reimbursement still repaid', () => {
    const st = build({
      worker: worker({ worker_type: 'unpaid', guaranteed_weekly_hours: 40 }),
      entries: [entry({ end_time: '18:00:00' })], // 10h → would be 8 reg + 2 OT = $330 if paid
      reimbursements: [{ amount: 25 }],
      leave: { sick: 8, vacation: 8 },
      deductions: [{ id: 'x', name: 'Tax', kind: 'percent', value: 10 }],
    });
    // Hours are still tracked
    expect(st.hours.regular).toBeCloseTo(8);
    expect(st.hours.overtime).toBeCloseTo(2);
    expect(st.hours.total).toBeGreaterThan(0);
    // Every wage cost is zero (regular, OT, prevailing, night, guarantee, leave)
    for (const k of ['regular', 'overtime', 'prevailing', 'night', 'guarantee', 'sick', 'vacation']) {
      expect(st.cost[k]).toBe(0);
    }
    // Zero wages, zero deductions; the reimbursement (expense repayment) is still owed
    expect(st.totals.grossWages).toBe(0);
    expect(st.totals.deductionsTotal).toBe(0);
    expect(st.totals.netWages).toBe(0);
    expect(st.deductions).toEqual([]);
    expect(st.totals.reimbursementTotal).toBe(25);
    expect(st.totals.netPay).toBe(25); // only the reimbursement, no wages
  });

  test('prevailing hours also earn nothing for an unpaid worker', () => {
    const st = build({
      worker: worker({ worker_type: 'unpaid' }),
      entries: [entry({ wage_type: 'prevailing', project_id: null })], // 8h prevailing @ $45 if paid
    });
    expect(st.hours.prevailing).toBeCloseTo(8);
    expect(st.cost.prevailing).toBe(0);
    expect(st.totals.grossWages).toBe(0);
  });

  test('a paid worker with the same inputs DOES earn (guards against over-zeroing)', () => {
    const st = build({ worker: worker({ worker_type: 'employee' }), entries: [entry({ end_time: '18:00:00' })] });
    expect(st.totals.grossWages).toBe(330);
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
    // 10h prevailing @ $50, daily-8 → 8h straight-time + 2h overtime (rate-aware
    // pays prevailing overtime; before, all 10h were flat).
    const st = build({ entries: [entry({ end_time: '18:00:00', wage_type: 'prevailing', project_id: 7 })], projectRateMap: { 7: 50 }, leave: { sick: 8, vacation: 0 } });
    const invoice = { regular_hours: st.hours.regular, overtime_hours: st.hours.overtime, prevailing_hours: st.hours.prevailing, prevailing_cost: st.cost.prevailing, sick_hours: st.hours.sick, sick_cost: st.cost.sick };
    const report = { regular_hours: st.hours.regular, overtime_hours: st.hours.overtime, prevailing_hours: st.hours.prevailing, prevailing_cost: st.cost.prevailing, sick_hours: st.hours.sick, sick_cost: st.cost.sick };
    expect(report).toEqual(invoice);           // one computation feeding both projections
    expect(st.hours.prevailing).toBe(8);        // straight-time prevailing
    expect(st.hours.overtime).toBe(2);          // the 2h over the daily-8 threshold, now paid
    expect(st.cost.prevailing).toBe(400);       // 8h × 50
    expect(st.cost.overtime).toBe(150);         // 2h × 50 × 1.5 — OT at the PREVAILING rate
  });

  test('excavator: mixed prevailing + civilian in one day reconciles to $420 (scenario A)', () => {
    // 6h prevailing @45 THEN 4h civilian @30, daily-8. buildPayStatement must
    // produce the same number the standalone calculator does.
    const st = build({
      worker: worker({ hourly_rate: 30 }),
      entries: [
        entry({ start_time: '06:00:00', end_time: '12:00:00', wage_type: 'prevailing', project_id: 1 }), // 6h @45
        entry({ start_time: '12:00:00', end_time: '16:00:00', wage_type: 'regular' }),                    // 4h @30 (last 2h OT)
      ],
      projectRateMap: { 1: 45 },
    });
    expect(st.hours.prevailing).toBeCloseTo(6);
    expect(st.hours.regular).toBeCloseTo(2);
    expect(st.hours.overtime).toBeCloseTo(2);
    expect(st.cost.prevailing).toBe(270); // 6 × 45
    expect(st.cost.regular).toBe(60);     // 2 × 30
    expect(st.cost.overtime).toBe(90);    // 2 × 30 × 1.5 (civilian OT)
    expect(st.totals.grossWages).toBe(420);
  });
});

describe('buildPayStatement — explain trace surfaces the break', () => {
  test("an entry's logged break is a trace item, not invisible", () => {
    // The confusion David hit: a 30-min break silently cut paid hours with no
    // trace line. It should show up as a 'break_logged' explain item.
    const st = build({ entries: [entry({ break_minutes: 30 })], explain: true });
    const ex = st.entries[0].explain || [];
    expect(ex.some(i => i.code === 'break_logged' && i.breakMin === 30)).toBe(true);
  });

  test('no break → no break trace item', () => {
    const st = build({ entries: [entry({ break_minutes: 0 })], explain: true });
    const ex = st.entries[0].explain || [];
    expect(ex.some(i => i.code === 'break_logged')).toBe(false);
  });
});

describe('buildPayStatement — night differential is its own visible factor', () => {
  test('night premium is broken out of overtime, gross unchanged', () => {
    // 22:00–06:00 = 8h overnight; window 19:00–05:00 covers 22:00–05:00 = 7h.
    const st = build({
      entries: [entry({ start_time: '22:00:00', end_time: '06:00:00' })],
      otConfig: { nightDifferential: { fromHour: 19, toHour: 5, pct: 25 } },
    });
    expect(st.hours.night).toBeCloseTo(7);
    expect(st.cost.night).toBe(52.5);        // 7 × 30 × 0.25 — its own line
    expect(st.cost.overtime).toBe(0);        // 8h day, no OT; night NOT folded into overtime
    expect(st.totals.grossWages).toBe(292.5); // 8×30 regular + 52.50 night
  });

  test('no night config → no night cost/hours', () => {
    const st = build({ entries: [entry({ start_time: '22:00:00', end_time: '06:00:00' })] });
    expect(st.cost.night).toBe(0);
    expect(st.hours.night).toBeCloseTo(0);
  });
});

describe('buildPayStatement — overtime bands expose the multiplier', () => {
  test('simple OT reports its hours at the plain multiplier', () => {
    const st = build({ entries: [entry({ end_time: '18:00:00' })] }); // 10h → 2h OT at 1.5×
    expect(st.hours.overtimeBands).toEqual([{ mult: 1.5, hours: 2 }]);
  });

  test('a premium rest-day rate is visible as its own 2× band', () => {
    // 2026-07-05 is a Sunday; rest-day config makes the whole day OT at 2×.
    const st = build({
      entries: [entry({ work_date: '2026-07-05', start_time: '08:00:00', end_time: '14:00:00' })], // 6h
      otConfig: { restDay: { mult: 2, days: [0] } },
    });
    expect(st.hours.overtimeBands.some(b => b.mult === 2 && b.hours > 0)).toBe(true);
  });

  test('no OT → no bands', () => {
    const st = build({ entries: [entry()] }); // 8h, no OT
    expect(st.hours.overtimeBands).toEqual([]);
  });
});
