/**
 * Effective-dated rates through the ONE pay engine (buildPayStatement + loaders +
 * laborCostCents). Each entry is priced at the rate in effect on its own
 * work_date; a raise today must never re-price an earlier period.
 */
jest.mock('../db', () => ({ query: jest.fn() }));
const pool = require('../db');
const { buildPayStatement, companyStatements, workerStatement, workerPeriodStatements } = require('../utils/payStatement');
const { laborCostCents } = require('../utils/paidHours');
const { splitRateAware } = require('../utils/rateAwareOvertime');
const { makeRateBook } = require('../utils/rateHistory');

const SETTINGS = {
  overtime_rule: 'daily', overtime_threshold: 8, week_start: 1, overtime_multiplier: 1.5,
  prevailing_wage_rate: 45, default_hourly_rate: 30,
  sick_pay_pct: 100, vacation_pay_pct: 100, regular_shift_hours: 8, deductions: null,
};
// Week of Mon 2026-07-06 .. Fri 2026-07-10; the raise lands on Wednesday 07-08.
const WEEK = ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10'];
const worker = (over = {}) => ({ id: 1, hourly_rate: 22, rate_type: 'hourly', overtime_rule: 'daily', role_id: null, guaranteed_weekly_hours: 0, ...over });
const entry = (over = {}) => ({ user_id: 1, work_date: '2026-07-06', wage_type: 'regular', start_time: '08:00:00', end_time: '16:00:00', break_minutes: 0, mileage: 0, project_id: null, ...over });
const days = (start, end, over = {}) => WEEK.map(d => entry({ work_date: d, start_time: start, end_time: end, ...over }));
const wRows = (...list) => list.map(([d, r, t = 'hourly', uid = 1]) => ({ user_id: uid, effective_date: d, hourly_rate: r, rate_type: t }));
const build = (opts = {}) => buildPayStatement({
  worker: worker(), entries: [], reimbursements: [], leave: { sick: 0, vacation: 0 },
  deductions: [], otConfig: null, projectRateMap: {}, settings: SETTINGS,
  from: '2026-07-06', to: '2026-07-12', explain: false, ...opts,
});
const RAISE = makeRateBook({ workerRows: wRows(['1900-01-01', 20], ['2026-07-08', 22]) });

describe('raise mid-period ($20 → $22 on Wednesday)', () => {
  test('Mon–Tue at 20, Wed–Fri at 22', () => {
    const st = build({ entries: days('08:00:00', '16:00:00'), rateBook: RAISE });
    expect(st.hours.regular).toBeCloseTo(40);
    expect(st.cost.regular).toBe(2 * 8 * 20 + 3 * 8 * 22); // 848
    expect(st.totals.grossWages).toBe(848);
    // Each line carries the rate it was priced at.
    expect(st.entries.map(e => e.pay_rate)).toEqual([20, 20, 22, 22, 22]);
    // The headline rate is the latest; the change is listed for the stub.
    expect(st.rates.rate).toBe(22);
    expect(st.rates.changes).toEqual([
      { from: '2026-07-06', rate: 20, rateType: 'hourly' },
      { from: '2026-07-08', rate: 22, rateType: 'hourly' },
    ]);
  });

  test('daily OT on each side of the raise is priced at that day\'s rate', () => {
    const st = build({ entries: days('08:00:00', '18:00:00'), rateBook: RAISE }); // 10h/day → 2h OT/day
    expect(st.cost.regular).toBe(2 * 8 * 20 + 3 * 8 * 22);
    expect(st.cost.overtime).toBe(2 * 2 * 20 * 1.5 + 3 * 2 * 22 * 1.5); // 120 + 198
  });

  test('no rate book → the current (cache) rate for every day, exactly as before', () => {
    const st = build({ entries: days('08:00:00', '16:00:00') });
    expect(st.cost.regular).toBe(40 * 22);
    expect(st.rates.changes).toBeUndefined();
    expect(st.entries.every(e => e.pay_rate === 22)).toBe(true);
  });

  test('history with a single rate in the period equals the single-rate engine', () => {
    const flat = makeRateBook({ workerRows: wRows(['1900-01-01', 22]) });
    const a = build({ entries: days('07:00:00', '17:30:00', { break_minutes: 17 }), rateBook: flat });
    const b = build({ entries: days('07:00:00', '17:30:00', { break_minutes: 17 }) });
    expect(a.cost).toEqual(b.cost);
    expect(a.totals).toEqual(b.totals);
  });
});

describe('weekly OT across a mid-week raise (rate-aware engine reused)', () => {
  const S = { ...SETTINGS, overtime_rule: 'weekly', overtime_threshold: 40 };
  const w = worker({ overtime_rule: 'weekly' });
  const entries = () => days('08:00:00', '17:00:00'); // 9h × 5 = 45h → 5h OT (chronologically: Friday's last 5h)

  test('rate_when_worked: the OT hours (Friday) are at the new rate', () => {
    const st = build({ worker: w, settings: S, entries: entries(), rateBook: RAISE });
    expect(st.hours.regular).toBeCloseTo(40);
    expect(st.hours.overtime).toBeCloseTo(5);
    expect(st.cost.regular).toBeCloseTo(18 * 20 + 22 * 22, 2); // Mon–Tue 18h @20, Wed–Fri 22 straight h @22
    expect(st.cost.overtime).toBeCloseTo(5 * 22 * 1.5, 2);
    expect(st.totals.grossWages).toBeCloseTo(360 + 484 + 165, 2);
  });

  test('weighted_average: FLSA blended regular rate across the raise', () => {
    const SW = { ...S, overtime_rate_method: 'weighted_average' };
    const st = build({ worker: w, settings: SW, entries: entries(), rateBook: RAISE });
    const straight = 18 * 20 + 27 * 22; // every hour at its own rate = 954
    const blended = straight / 45;
    expect(st.totals.grossWages).toBeCloseTo(straight + 5 * blended * 0.5, 2); // 954 + 53 = 1007
  });

  test('matches what splitRateAware does today for any mixed-rate week', () => {
    for (const method of ['rate_when_worked', 'weighted_average']) {
      const e = entries();
      const direct = splitRateAware(e, {
        rule: 'weekly', threshold: 40, weekStart: 1, otMult: 1.5, method, wagePriority: 'chronological',
        baseRateOf: x => (x.work_date < '2026-07-08' ? 20 : 22),
      });
      const st = build({ worker: w, settings: { ...S, overtime_rate_method: method }, entries: entries(), rateBook: RAISE });
      expect(st.cost.regular).toBeCloseTo(direct.regularCost, 2);
      expect(st.cost.overtime).toBeCloseTo(direct.overtimeCost, 2);
    }
  });

  test('a pay period that clips the week: context days keep their own rate', () => {
    // Period = Thu–Fri only; Mon–Wed are week context. 45h in the week → the 5 OT
    // hours land on Friday (in period) at 22.
    const all = entries();
    const st = build({ worker: w, settings: S, entries: all.slice(3), weekContextEntries: all.slice(0, 3), from: '2026-07-09', to: '2026-07-10', rateBook: RAISE });
    expect(st.hours.overtime).toBeCloseTo(5);
    expect(st.cost.overtime).toBeCloseTo(5 * 22 * 1.5, 2);
    expect(st.cost.regular).toBeCloseTo(13 * 22, 2);
  });
});

describe('premium OT config (per-band path) across a raise', () => {
  test('tiered daily OT: straight time per day rate; OT at the OT hours\' rates', () => {
    const otConfig = { dailyBands: [{ afterHours: 8, mult: 1.5 }, { afterHours: 12, mult: 2 }] };
    const st = build({ entries: days('08:00:00', '18:00:00'), rateBook: RAISE, otConfig });
    expect(st.cost.regular).toBeCloseTo(2 * 8 * 20 + 3 * 8 * 22, 2);
    // 10h OT total: 4h @ 20, 6h @ 22 → blended OT rate 21.2 × bands (all 1.5× here)
    expect(st.cost.overtime).toBeCloseTo(10 * 21.2 * 1.5, 2);
  });
});

describe('daily-rate worker: rate_type switch mid-period', () => {
  test('hourly $25 Mon–Tue, daily $200 Wed–Fri — each day by the type in effect', () => {
    const book = makeRateBook({ workerRows: wRows(['1900-01-01', 25, 'hourly'], ['2026-07-08', 200, 'daily']) });
    const st = build({ worker: worker({ hourly_rate: 200, rate_type: 'daily' }), entries: days('08:00:00', '16:00:00'), rateBook: book });
    expect(st.cost.regular).toBe(2 * 8 * 25 + 3 * 200); // 1000
    expect(st.totals.grossWages).toBe(1000);
    expect(st.entries.map(e => e.pay_rate_type)).toEqual(['hourly', 'hourly', 'daily', 'daily', 'daily']);
    expect(st.hours.regularDays).toBeNull();
    expect(st.rates.rateType).toBe('daily');
  });

  test('daily → hourly with weekly OT still counts the whole week', () => {
    const S = { ...SETTINGS, overtime_rule: 'weekly', overtime_threshold: 40 };
    const book = makeRateBook({ workerRows: wRows(['1900-01-01', 200, 'daily'], ['2026-07-09', 25, 'hourly']) });
    const st = build({ worker: worker({ overtime_rule: 'weekly' }), settings: S, entries: days('08:00:00', '17:00:00'), rateBook: book });
    // 45h in the week; OT = Friday's last 5h, which is an hourly day → 5 × 25 × 1.5.
    expect(st.hours.overtime).toBeCloseTo(5);
    expect(st.cost.overtime).toBeCloseTo(5 * 25 * 1.5, 2);
    // Mon–Wed: 3 daily days = 600; Thu 9h + Fri 4h straight @25 = 325.
    expect(st.cost.regular).toBeCloseTo(600 + 13 * 25, 2);
  });

  test('daily rate raise (same type) prices each day at its own daily rate', () => {
    const book = makeRateBook({ workerRows: wRows(['1900-01-01', 200, 'daily'], ['2026-07-08', 240, 'daily']) });
    const st = build({ worker: worker({ hourly_rate: 240, rate_type: 'daily' }), entries: days('08:00:00', '16:00:00'), rateBook: book });
    expect(st.cost.regular).toBe(2 * 200 + 3 * 240);
  });
});

describe('prevailing rate change mid-job', () => {
  test('project 45 → 50 on Wednesday', () => {
    const book = makeRateBook({
      workerRows: wRows(['1900-01-01', 20]),
      projectRows: [{ project_id: 3, effective_date: '1900-01-01', rate: 45 }, { project_id: 3, effective_date: '2026-07-08', rate: 50 }],
    });
    const st = build({ entries: days('08:00:00', '16:00:00', { wage_type: 'prevailing', project_id: 3 }), rateBook: book, projectRateMap: { 3: 50 } });
    expect(st.cost.prevailing).toBe(2 * 8 * 45 + 3 * 8 * 50);
    expect(st.entries.map(e => e.pay_rate)).toEqual([45, 45, 50, 50, 50]);
  });
});

describe('company default rate change', () => {
  test('affects only workers without their own rate', () => {
    const book = makeRateBook({
      workerRows: [
        { user_id: 1, effective_date: '1900-01-01', hourly_rate: null, rate_type: 'hourly' },
        { user_id: 2, effective_date: '1900-01-01', hourly_rate: 40, rate_type: 'hourly' },
      ],
      defaultRows: [{ effective_date: '1900-01-01', rate: 30 }, { effective_date: '2026-07-08', rate: 35 }],
    });
    const a = build({ worker: worker({ id: 1, hourly_rate: null }), entries: days('08:00:00', '16:00:00'), rateBook: book });
    const b = build({ worker: worker({ id: 2, hourly_rate: 40 }), entries: days('08:00:00', '16:00:00', { user_id: 2 }), rateBook: book });
    expect(a.cost.regular).toBe(2 * 8 * 30 + 3 * 8 * 35);
    expect(b.cost.regular).toBe(40 * 40);
  });
});

describe('leave across a raise', () => {
  test('a sick day before the raise is paid at the old rate', () => {
    const leave = { sick: 8, vacation: 0, leaveByDate: new Map([['2026-07-06', 8]]) };
    const st = build({ entries: days('08:00:00', '16:00:00').slice(1), leave, rateBook: RAISE });
    expect(st.cost.sick).toBe(8 * 20);
  });
});

describe('THE HEADLINE BUG: a raise today must not change last month\'s numbers', () => {
  const JUNE = ['2026-06-01', '2026-06-02', '2026-06-03'].map(d => entry({ work_date: d, end_time: '18:00:00' }));
  const before = makeRateBook({ workerRows: wRows(['1900-01-01', 20]) });
  const after = makeRateBook({ workerRows: wRows(['1900-01-01', 20], ['2026-09-24', 26]) });

  test('buildPayStatement for June is identical before and after the raise', () => {
    const a = build({ worker: worker({ hourly_rate: 20 }), entries: JUNE.map(e => ({ ...e })), from: '2026-06-01', to: '2026-06-07', rateBook: before });
    // After the raise the cache (users.hourly_rate) says 26 — the book must win.
    const b = build({ worker: worker({ hourly_rate: 26 }), entries: JUNE.map(e => ({ ...e })), from: '2026-06-01', to: '2026-06-07', rateBook: after });
    expect(b.cost).toEqual(a.cost);
    expect(b.totals).toEqual(a.totals);
    expect(a.totals.grossWages).toBe(3 * (8 * 20 + 2 * 30));
  });

  test('laborCostCents (invoices T&M, project spend, P&L/WIP) for June is unchanged', () => {
    const rows = cache => JUNE.map(e => ({ ...e, rate: cache, rate_type: 'hourly', worker_type: 'employee', ot_rule: null, role_id: null, prevailing_rate: null }));
    const beforeC = laborCostCents(rows(20), SETTINGS, { rateBook: before });
    const afterC = laborCostCents(rows(26), SETTINGS, { rateBook: after });
    expect(afterC).toBe(beforeC);
    expect(beforeC).toBe(3 * (8 * 20 + 2 * 30) * 100);
    // Without the book (legacy) the raise leaks into the past — the bug.
    expect(laborCostCents(rows(26), SETTINGS)).not.toBe(beforeC);
  });

  test('laborCostCents prices a mid-range raise per entry', () => {
    const rows = WEEK.map(d => ({ ...entry({ work_date: d }), rate: 22, rate_type: 'hourly', worker_type: 'employee', ot_rule: null, role_id: null, prevailing_rate: null }));
    expect(laborCostCents(rows, SETTINGS, { rateBook: RAISE })).toBe(84800);
  });
});

// ── Loaders: they load the book and price with it ─────────────────────────
function mockDb({ entries = [], workerHist = [], projectHist = [], defaultHist = [] }) {
  pool.query.mockImplementation(async (sql) => {
    if (/FROM worker_rate_history/.test(sql)) return { rows: workerHist };
    if (/FROM project_prevailing_rate_history/.test(sql)) return { rows: projectHist };
    if (/FROM company_default_rate_history/.test(sql)) return { rows: defaultHist };
    if (/FROM time_entries te/.test(sql) && /te\.start_time|te\.\*/.test(sql)) return { rows: entries };
    return { rows: [] };
  });
}

describe('loaders price at the dated rate', () => {
  beforeEach(() => pool.query.mockReset());
  const E = days('08:00:00', '16:00:00');

  test('companyStatements (payroll CSV / OT report / QBO JE)', async () => {
    mockDb({ entries: E, workerHist: wRows(['1900-01-01', 20], ['2026-07-08', 22]) });
    const out = await companyStatements({ companyId: 'co', workers: [worker()], settings: SETTINGS, from: '2026-07-06', to: '2026-07-12' });
    expect(out.get(1).cost.regular).toBe(848);
    const sqls = pool.query.mock.calls.map(c => c[0]);
    expect(sqls.filter(s => /rate_history/.test(s))).toHaveLength(3); // batched: one per history
  });

  test('workerStatement (worker invoice, ruleset pay stubs)', async () => {
    mockDb({ entries: E, workerHist: wRows(['1900-01-01', 20], ['2026-07-08', 22]) });
    const st = await workerStatement({ companyId: 'co', worker: worker(), settings: SETTINGS, from: '2026-07-06', to: '2026-07-12' });
    expect(st.cost.regular).toBe(848);
  });

  test('workerPeriodStatements (legacy pay stubs): each period at its own rates', async () => {
    const june = ['2026-06-01', '2026-06-02'].map(d => entry({ work_date: d }));
    mockDb({ entries: [...june, ...E], workerHist: wRows(['1900-01-01', 20], ['2026-07-08', 22]) });
    const out = await workerPeriodStatements({ companyId: 'co', worker: worker(), settings: SETTINGS, periods: [
      { id: 1, period_start: '2026-06-01', period_end: '2026-06-14' },
      { id: 2, period_start: '2026-07-06', period_end: '2026-07-12' },
    ] });
    expect(out.find(o => o.period.id === 1).statement.cost.regular).toBe(2 * 8 * 20);
    expect(out.find(o => o.period.id === 2).statement.cost.regular).toBe(848);
  });
});
