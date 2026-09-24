/**
 * Money-critical pay bugs, each pinned with the dollar figure it used to get wrong.
 *
 *  1. A worker's own OT rule vs the company's stored threshold — the stored
 *     `overtime_threshold` belongs to the COMPANY rule; a weekly-rule worker in a
 *     daily company must get the weekly default (40), not a weekly threshold of 8.
 *  2. Weekly OT across a pay-period boundary — the week is computed whole, and the
 *     OT lands in the period holding the hours past 40 (chronologically).
 *  3. companyStatements must honour the admin per-entry OT override.
 *  4. Job-cost labor must match pay: prevailing hours, daily-rate workers, unpaid.
 *  +  computeDailyPayCosts honours the company week_start.
 */

jest.mock('../db', () => ({ query: jest.fn() }));
const pool = require('../db');
const { buildPayStatement, workerStatement, companyStatements, workerPeriodStatements } = require('../utils/payStatement');
const { otThreshold, laborCostCents, computePaid } = require('../utils/paidHours');
const { computeDailyPayCosts } = require('../utils/payCalculations');

const entry = (over = {}) => ({
  id: Math.floor(Math.random() * 1e9), user_id: 1, work_date: '2026-07-06', wage_type: 'regular',
  start_time: '08:00:00', end_time: '16:00:00', break_minutes: 0, mileage: 0, project_id: null,
  overtime_hours_override: null, ...over,
});
const worker = (over = {}) => ({
  id: 1, hourly_rate: 20, rate_type: 'hourly', overtime_rule: null, role_id: null,
  guaranteed_weekly_hours: 0, worker_type: 'hourly', ...over,
});
const BASE = {
  week_start: 1, overtime_multiplier: 1.5, prevailing_wage_rate: 45, default_hourly_rate: 30,
  sick_pay_pct: 100, vacation_pay_pct: 100, regular_shift_hours: 8, deductions: null,
};
const MON_FRI = ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10'];

// ── A tiny fake DB: serves time_entries rows filtered by the query's date bounds
// ($2/$3) and — for an explicit column list — only the columns actually SELECTed,
// so a column missing from the SELECT is missing from the row (bug 3).
function installFakeDb(rows) {
  pool.query.mockReset();
  pool.query.mockImplementation(async (sql, params = []) => {
    if (/FROM time_entries/.test(sql) && /start_time/.test(sql)) {
      const from = params[1], to = params[2];
      const selected = rows.filter(r => (from == null || r.work_date >= from) && (to == null || r.work_date <= to));
      if (/te\.\*/.test(sql)) return { rows: selected.map(r => ({ ...r })) };
      const selectPart = sql.split(/FROM time_entries/)[0];
      const cols = [...selectPart.matchAll(/te\.([a-z_]+)/g)].map(m => m[1]);
      return { rows: selected.map(r => { const o = {}; for (const c of cols) o[c] = r[c]; return o; }) };
    }
    return { rows: [] };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
describe('bug 1 — a worker OT rule that differs from the company rule gets its own default threshold', () => {
  test('otThreshold: stored threshold applies only to the company rule', () => {
    const daily = { overtime_rule: 'daily', overtime_threshold: '8' };
    const weekly = { overtime_rule: 'weekly', overtime_threshold: '40' };
    expect(otThreshold(daily, 'daily')).toBe(8);
    expect(otThreshold(daily, 'weekly')).toBe(40);   // was 8
    expect(otThreshold(weekly, 'weekly')).toBe(40);
    expect(otThreshold(weekly, 'daily')).toBe(8);    // was 40
    // A customised company threshold still governs workers on the company rule.
    expect(otThreshold({ overtime_rule: 'weekly', overtime_threshold: '45' }, 'weekly')).toBe(45);
    expect(otThreshold({ overtime_rule: 'daily', overtime_threshold: '10' }, 'daily')).toBe(10);
    expect(otThreshold({ overtime_rule: 'daily', overtime_threshold: '10' }, 'weekly')).toBe(40);
    // No company rule stored → the company rule is the default 'daily'.
    expect(otThreshold({ overtime_threshold: '10' }, 'daily')).toBe(10);
    expect(otThreshold({ overtime_threshold: '10' }, 'weekly')).toBe(40);
  });

  test('weekly-rule worker in a daily company: 5×8h @ $20 = $800 (was $1120)', () => {
    const st = buildPayStatement({
      worker: worker({ overtime_rule: 'weekly' }),
      entries: MON_FRI.map(d => entry({ work_date: d })),
      settings: { ...BASE, overtime_rule: 'daily', overtime_threshold: '8' },
      from: '2026-07-06', to: '2026-07-12',
    });
    expect(st.hours.overtime).toBeCloseTo(0);
    expect(st.totals.grossWages).toBe(800);
  });

  test('daily-rule worker in a weekly company: a 10h day is 8 + 2 OT = $220 (was $200)', () => {
    const st = buildPayStatement({
      worker: worker({ overtime_rule: 'daily' }),
      entries: [entry({ end_time: '18:00:00' })],
      settings: { ...BASE, overtime_rule: 'weekly', overtime_threshold: '40' },
      from: '2026-07-06', to: '2026-07-06',
    });
    expect(st.hours.overtime).toBeCloseTo(2);
    expect(st.totals.grossWages).toBe(220);
  });

  test('computePaid (worker screens / exports) agrees', () => {
    const s = { ...BASE, overtime_rule: 'daily', overtime_threshold: '8' };
    const r = computePaid(MON_FRI.map(d => entry({ work_date: d })), s, { rule: 'weekly' });
    expect(r.overtimeHours).toBeCloseTo(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('bug 2 — weekly OT across a pay-period boundary', () => {
  const S = { ...BASE, overtime_rule: 'weekly', overtime_threshold: '40' };
  const tenHourWeek = MON_FRI.map(d => entry({ work_date: d, start_time: '08:00:00', end_time: '18:00:00' })); // 50h
  const A = { from: '2026-06-30', to: '2026-07-07' }; // ends Tue: holds Mon+Tue = 20h
  const B = { from: '2026-07-08', to: '2026-07-14' }; // Wed–Fri = 30h, of which the last 10h are week OT

  test('workerStatement: period A $400 / 0 OT, period B $700 / 10 OT, together the full-week $1100', async () => {
    installFakeDb(tenHourWeek);
    const a = await workerStatement({ companyId: 1, worker: worker(), settings: S, ...A });
    const b = await workerStatement({ companyId: 1, worker: worker(), settings: S, ...B });
    expect(a.hours.overtime).toBeCloseTo(0);
    expect(a.totals.grossWages).toBe(400);
    expect(b.hours.regular).toBeCloseTo(20);
    expect(b.hours.overtime).toBeCloseTo(10);
    expect(b.totals.grossWages).toBe(700);        // was 600 (0 OT)
    expect(a.totals.grossWages + b.totals.grossWages).toBe(1100);
    // Only in-period entries are shown on the statement.
    expect(b.entries.map(e => e.work_date)).toEqual(['2026-07-08', '2026-07-09', '2026-07-10']);
    expect(b.entries.reduce((s, e) => s + (e.overtime_hours || 0), 0)).toBeCloseTo(10);
  });

  test('companyStatements behaves identically', async () => {
    installFakeDb(tenHourWeek);
    const a = (await companyStatements({ companyId: 1, workers: [worker()], settings: S, ...A })).get(1);
    const b = (await companyStatements({ companyId: 1, workers: [worker()], settings: S, ...B })).get(1);
    expect(a.totals.grossWages).toBe(400);
    expect(b.hours.overtime).toBeCloseTo(10);
    expect(b.totals.grossWages).toBe(700);
  });

  test('workerPeriodStatements behaves identically (both periods in one call)', async () => {
    installFakeDb(tenHourWeek);
    const periods = [
      { id: 1, period_start: A.from, period_end: A.to },
      { id: 2, period_start: B.from, period_end: B.to },
    ];
    const out = await workerPeriodStatements({ companyId: 1, worker: worker(), settings: S, periods });
    expect(out.map(o => o.statement.totals.grossWages)).toEqual([400, 700]);
    // And one period on its own still sees the week's earlier hours.
    installFakeDb(tenHourWeek);
    const onlyB = await workerPeriodStatements({ companyId: 1, worker: worker(), settings: S, periods: [periods[1]] });
    expect(onlyB[0].statement.totals.grossWages).toBe(700);
  });

  test('boundary inside the OT: 12h days, period ends Thu → A 40 reg + 8 OT, B 12 OT; sums to the week', async () => {
    const twelve = MON_FRI.map(d => entry({ work_date: d, start_time: '06:00:00', end_time: '18:00:00' })); // 60h
    installFakeDb(twelve);
    const a = await workerStatement({ companyId: 1, worker: worker(), settings: S, from: '2026-07-01', to: '2026-07-09' });
    const b = await workerStatement({ companyId: 1, worker: worker(), settings: S, from: '2026-07-10', to: '2026-07-16' });
    expect(a.hours.regular).toBeCloseTo(40);
    expect(a.hours.overtime).toBeCloseTo(8);
    expect(a.totals.grossWages).toBe(1040);
    expect(b.hours.regular).toBeCloseTo(0);
    expect(b.hours.overtime).toBeCloseTo(12);
    expect(b.totals.grossWages).toBe(360);
    expect(a.totals.grossWages + b.totals.grossWages).toBe(1400); // 40×20 + 20×30
  });

  test('premium-config (per-band) path: weekly tier bands honour the rest of the week', () => {
    const otConfig = { weeklyBands: [{ afterHours: 40, mult: 1.5 }, { afterHours: 45, mult: 2 }] };
    const st = buildPayStatement({
      worker: worker({ overtime_rule: 'weekly' }),
      entries: tenHourWeek.slice(2).map(e => ({ ...e })),        // Wed–Fri in period
      weekContextEntries: tenHourWeek.slice(0, 2).map(e => ({ ...e })), // Mon–Tue before it
      otConfig, settings: S, ...B,
    });
    // Week: 50h. In-period 30h = 20 reg + 5h @1.5 + 5h @2.
    expect(st.hours.regular).toBeCloseTo(20);
    expect(st.hours.overtime).toBeCloseTo(10);
    expect(st.totals.grossWages).toBe(400 + 5 * 30 + 5 * 40);
    expect(st.entries.reduce((s, e) => s + (e.overtime_hours || 0), 0)).toBeCloseTo(10);
  });

  test('daily-rate worker on a weekly rule: OT follows the full week too', () => {
    const st = buildPayStatement({
      worker: worker({ overtime_rule: 'weekly', rate_type: 'daily', hourly_rate: 200 }),
      entries: tenHourWeek.slice(2).map(e => ({ ...e })),
      weekContextEntries: tenHourWeek.slice(0, 2).map(e => ({ ...e })),
      settings: S, ...B,
    });
    // 3 days × $200 + 10 OT × (200/8) × 1.5
    expect(st.totals.grossWages).toBe(600 + 375);
  });

  test('daily OT is unaffected by week context', () => {
    const D = { ...BASE, overtime_rule: 'daily', overtime_threshold: '8' };
    const withCtx = buildPayStatement({
      worker: worker(), entries: tenHourWeek.slice(2).map(e => ({ ...e })),
      weekContextEntries: tenHourWeek.slice(0, 2).map(e => ({ ...e })), settings: D, ...B,
    });
    const without = buildPayStatement({ worker: worker(), entries: tenHourWeek.slice(2).map(e => ({ ...e })), settings: D, ...B });
    expect(withCtx.totals).toEqual(without.totals);
    expect(withCtx.totals.grossWages).toBe(3 * (160 + 60));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('bug 3 — companyStatements honours the admin OT override', () => {
  test('10h entry with override 0: $200 on every surface (CSV/report was $220)', async () => {
    const rows = [entry({ end_time: '18:00:00', overtime_hours_override: 0 })];
    const S = { ...BASE, overtime_rule: 'daily', overtime_threshold: '8' };
    installFakeDb(rows);
    const inv = await workerStatement({ companyId: 1, worker: worker(), settings: S, from: '2026-07-06', to: '2026-07-06' });
    installFakeDb(rows);
    const csv = (await companyStatements({ companyId: 1, workers: [worker()], settings: S, from: '2026-07-06', to: '2026-07-06' })).get(1);
    expect(inv.totals.grossWages).toBe(200);
    expect(csv.totals.grossWages).toBe(200);
    expect(csv.hours.overtime).toBeCloseTo(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('bug 4 — job-cost labor matches what the worker is paid', () => {
  const S = { overtime_rule: 'daily', overtime_threshold: 8, overtime_multiplier: 1.5, week_start: 1, prevailing_wage_rate: 45 };
  const row = (over = {}) => ({
    user_id: 1, work_date: '2026-07-06', wage_type: 'regular', start_time: '08:00:00', end_time: '16:00:00',
    break_minutes: 0, rate: '20', rate_type: 'hourly', worker_type: 'hourly', ot_rule: 'daily', role_id: null,
    project_id: 7, prevailing_rate: null, overtime_hours_override: null, ...over,
  });

  test('prevailing hours are priced at the project prevailing rate (was $0)', () => {
    expect(laborCostCents([row({ wage_type: 'prevailing', prevailing_rate: '50' })], S)).toBe(40000); // 8 × 50
    // No project rate → the company prevailing rate, same as the pay engine.
    expect(laborCostCents([row({ wage_type: 'prevailing' })], S)).toBe(36000); // 8 × 45
  });

  test('a daily-rate worker costs the daily rate, not rate × hours (was $1600)', () => {
    expect(laborCostCents([row({ rate: '200', rate_type: 'daily' })], S)).toBe(20000);
  });

  test('an unpaid worker costs nothing', () => {
    expect(laborCostCents([row({ worker_type: 'unpaid' })], S)).toBe(0);
    expect(laborCostCents([row({ worker_type: 'unpaid', wage_type: 'prevailing', prevailing_rate: '50' })], S)).toBe(0);
  });

  test('equals the pay statement gross for the same entries', () => {
    const rows = [row({ end_time: '18:00:00' }), row({ work_date: '2026-07-07', wage_type: 'prevailing', prevailing_rate: '50' })];
    const st = buildPayStatement({
      worker: worker({ overtime_rule: 'daily' }), entries: rows.map(r => ({ ...r })),
      projectRateMap: { 7: 50 }, settings: S,
    });
    expect(laborCostCents(rows, S)).toBe(Math.round(st.totals.grossWages * 100));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('computeDailyPayCosts honours week_start', () => {
  // Sunday-start week: Sun 07-05 + Mon–Thu = 50h → 10h weekly OT. With a hardcoded
  // Monday start the Sunday fell in the previous week and the OT vanished.
  const days = ['2026-07-05', '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09']
    .map(d => entry({ work_date: d, start_time: '08:00:00', end_time: '18:00:00' }));

  test('direct call with weekStart 0', () => {
    const dc = computeDailyPayCosts(days, 'weekly', 40, 200, 1.5, null, 8, 0);
    expect(dc.overtimeCost).toBeCloseTo(10 * 25 * 1.5);
  });

  test('via the pay statement with settings.week_start = 0', () => {
    const st = buildPayStatement({
      worker: worker({ overtime_rule: 'weekly', rate_type: 'daily', hourly_rate: 200 }),
      entries: days.map(e => ({ ...e })),
      settings: { ...BASE, week_start: 0, overtime_rule: 'weekly', overtime_threshold: '40' },
      from: '2026-07-05', to: '2026-07-11',
    });
    expect(st.totals.grossWages).toBe(5 * 200 + 375);
  });
});
