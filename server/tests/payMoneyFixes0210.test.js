/**
 * Money-bug fixes (rate history follow-ups, migration 0210):
 *   1. weighted-average OT must not treat a DAILY rate as an hourly rate when a
 *      daily day sits in the same week (type switch / week context)
 *   2. job cost: a daily-rate worker splitting a day across projects costs ONE day
 *   3. locked-period check widens to the week containing the change
 *   4. the company prevailing fallback is effective-dated
 *   5. a row that is / becomes the earliest reaches back to 1900-01-01
 *   7. sick and vacation leave are priced at their own day's rate
 *   8. companyToday: empty company_timezone ≠ UTC
 */
jest.mock('../db', () => ({ query: jest.fn() }));
const pool = require('../db');
const { buildPayStatement } = require('../utils/payStatement');
const { laborCostCents } = require('../utils/paidHours');
const { makeRateBook, loadRateBook } = require('../utils/rateHistory');
const { computeLeaveHours } = require('../utils/payCalculations');
const store = require('../utils/rateHistoryStore');
const { wallDateInTZ } = require('../utils/timeFormat');

const SETTINGS = {
  overtime_rule: 'weekly', overtime_threshold: 40, week_start: 1, overtime_multiplier: 1.5,
  prevailing_wage_rate: 45, default_hourly_rate: 30, overtime_rate_method: 'weighted_average',
  sick_pay_pct: 100, vacation_pay_pct: 100, regular_shift_hours: 8, deductions: null,
};
// Week of Mon 2026-07-06 .. Sun 2026-07-12.
const WEEK = ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10'];
const worker = (over = {}) => ({ id: 1, hourly_rate: 25, rate_type: 'hourly', overtime_rule: 'weekly', role_id: null, guaranteed_weekly_hours: 0, ...over });
const entry = (over = {}) => ({ user_id: 1, work_date: '2026-07-06', wage_type: 'regular', start_time: '08:00:00', end_time: '18:00:00', break_minutes: 0, mileage: 0, project_id: null, ...over });
const wRows = (...list) => list.map(([d, r, t = 'hourly', uid = 1]) => ({ user_id: uid, effective_date: d, hourly_rate: r, rate_type: t }));
const build = (opts = {}) => buildPayStatement({
  worker: worker(), entries: [], reimbursements: [], leave: { sick: 0, vacation: 0 },
  deductions: [], otConfig: null, projectRateMap: {}, settings: SETTINGS,
  from: '2026-07-06', to: '2026-07-12', explain: false, ...opts,
});
// Daily $200 Mon–Wed, hourly $25 from Thursday.
const SWITCH = makeRateBook({ workerRows: wRows(['1900-01-01', 200, 'daily'], ['2026-07-09', 25, 'hourly']) });

describe('#1 weighted-average OT across a daily → hourly switch', () => {
  // 10h × 5 = 50h, weekly 40 → 10h OT (Friday). Regular rate (FLSA) =
  // (3 × $200 + 20h × $25) / 50h = $22/h → Friday: 10 × 25 + 10 × 22 × 0.5 = $360.
  test('type switch inside the period: the daily days blend at day pay ÷ day hours', () => {
    const st = build({ entries: WEEK.map(d => entry({ work_date: d })), rateBook: SWITCH });
    expect(st.hours.overtime).toBeCloseTo(10);
    expect(st.cost.overtime).toBeCloseTo(360, 2); // was $900 (daily $200 blended as $200/h)
    expect(st.cost.regular).toBeCloseTo(600 + 250, 2);
  });

  test('daily days only in the WEEK CONTEXT (period = Thu–Fri) price the same', () => {
    const ctx = WEEK.slice(0, 3).map(d => entry({ work_date: d }));
    const st = build({ entries: WEEK.slice(3).map(d => entry({ work_date: d })), weekContextEntries: ctx, from: '2026-07-09', to: '2026-07-12', rateBook: SWITCH });
    expect(st.cost.overtime).toBeCloseTo(360, 2);
    expect(st.cost.regular).toBeCloseTo(250, 2);
  });
});

describe('#2 job cost: a daily-rate worker splitting a day across projects', () => {
  const row = (project, start, end) => ({ ...entry({ project_id: project, start_time: start, end_time: end }), id: project, company_id: 'co', rate: 200, rate_type: 'daily', worker_type: 'employee', ot_rule: null, role_id: null, prevailing_rate: null });
  const S = { ...SETTINGS, overtime_rule: 'daily', overtime_threshold: 8, overtime_rate_method: 'rate_when_worked' };
  const A = [row(1, '08:00:00', '12:00:00')], B = [row(2, '12:00:00', '16:00:00')];

  test('4h on A + 4h on B costs $100 + $100, not $200 + $200', () => {
    const dayContext = [...A, ...B];
    expect(laborCostCents(A, S, { dayContext })).toBe(10000);
    expect(laborCostCents(B, S, { dayContext })).toBe(10000);
  });

  test('allocation by hours (6h/2h) and the whole day when there is no other project', () => {
    const A6 = [row(1, '08:00:00', '14:00:00')], B2 = [row(2, '14:00:00', '16:00:00')];
    expect(laborCostCents(A6, S, { dayContext: [...A6, ...B2] })).toBe(15000);
    expect(laborCostCents(B2, S, { dayContext: [...A6, ...B2] })).toBe(5000);
    expect(laborCostCents(A, S, { dayContext: A })).toBe(20000);
  });

  test('hourly workers are unaffected by day context', () => {
    const h = r => ({ ...r, rate: 25, rate_type: 'hourly' });
    expect(laborCostCents(A.map(h), S, { dayContext: [...A, ...B].map(h) })).toBe(4 * 25 * 100);
  });
});

describe('#3/#5 locked-period reach', () => {
  const mockPeriods = periods => pool.query.mockImplementation(async (sql, p) => {
    if (/FROM pay_periods/.test(sql)) return { rows: periods.filter(x => x.period_end >= p[1]) };
    if (/key = 'week_start'/.test(sql)) return { rows: [{ value: '1' }] };
    return { rows: [] };
  });
  beforeEach(() => pool.query.mockReset());

  test('#3 a change dated Thursday reaches a locked period ending the Wednesday before (same week)', async () => {
    mockPeriods([{ id: 7, period_start: '2026-06-01', period_end: '2026-06-10', label: null }]); // Mon 06-01 .. Wed 06-10
    const out = await store.lockedImpact('co', [{ effective_date: '1900-01-01' }], '2026-06-11');
    expect(out.map(p => p.id)).toEqual([7]);
  });

  test('#3 a period ending the week before is still out of reach', async () => {
    mockPeriods([{ id: 7, period_start: '2026-05-25', period_end: '2026-06-07', label: null }]); // ends Sun
    const out = await store.lockedImpact('co', [{ effective_date: '1900-01-01' }], '2026-06-11');
    expect(out).toEqual([]);
  });

  test('#5 a row that BECOMES the earliest reaches every earlier date', async () => {
    mockPeriods([{ id: 3, period_start: '2025-03-01', period_end: '2025-03-14', label: null }]);
    const out = await store.lockedImpact('co', [{ effective_date: '2026-06-01' }], '2026-05-01');
    expect(out.map(p => p.id)).toEqual([3]);
  });

  test('#5 deleting the earliest row reaches every earlier date', async () => {
    mockPeriods([{ id: 3, period_start: '2025-03-01', period_end: '2025-03-14', label: null }]);
    pool.query.mockImplementation(async (sql, p) => {
      if (/FROM pay_periods/.test(sql)) return { rows: [{ id: 3, period_start: '2025-03-01', period_end: '2025-03-14', label: null }].filter(x => x.period_end >= p[1]) };
      if (/FROM worker_rate_history h LEFT JOIN users/.test(sql.replace(/\s+/g, ' '))) return { rows: [
        { id: 1, rate: '20', rate_type: 'hourly', effective_date: '2026-05-01' },
        { id: 2, rate: '22', rate_type: 'hourly', effective_date: '2026-06-01' },
      ] };
      return { rows: [] };
    });
    const out = await store.deleteChange('worker', { companyId: 'co', ownerId: 5, rowId: 1, today: '2026-09-24' });
    expect(out.conflict).toBeDefined();
    expect(out.conflict.locked_periods.map(p => p.id)).toEqual([3]);
  });
});

describe('#4 company prevailing fallback is effective-dated', () => {
  const E = entry({ work_date: '2026-07-06', start_time: '08:00:00', end_time: '16:00:00', wage_type: 'prevailing', project_id: 9 });
  test('raising the company prevailing rate today does not re-price last week', () => {
    const book = makeRateBook({
      workerRows: wRows(['1900-01-01', 25]),
      prevailingDefaultRows: [{ effective_date: '1900-01-01', rate: 45 }, { effective_date: '2026-09-01', rate: 60 }],
    });
    const st = build({ entries: [E], settings: { ...SETTINGS, prevailing_wage_rate: 60 }, rateBook: book });
    expect(st.cost.prevailing).toBe(360); // 8 × 45, was 8 × 60 = 480
    expect(st.rates.prevailingWageRate).toBe(45);
  });

  test('no company prevailing history → the setting, exactly as before', () => {
    const book = makeRateBook({ workerRows: wRows(['1900-01-01', 25]) });
    const st = build({ entries: [E], settings: { ...SETTINGS, prevailing_wage_rate: 60 }, rateBook: book });
    expect(st.cost.prevailing).toBe(480);
  });

  test('loadRateBook reads company_prevailing_rate_history', async () => {
    pool.query.mockReset();
    pool.query.mockImplementation(async sql => (/FROM company_prevailing_rate_history/.test(sql)
      ? { rows: [{ rate: '45', effective_date: '1900-01-01' }] } : { rows: [] }));
    const book = await loadRateBook({ companyId: 'co', userIds: [1], projectIds: [9], to: '2026-07-12' });
    expect(book.prevailingDefaults).toHaveLength(1);
  });

  test('store: company_prevailing kind validates non-negative and is mounted', () => {
    expect(store.KINDS.company_prevailing.table).toBe('company_prevailing_rate_history');
    expect(store.validateChange('company_prevailing', { rate: -1 }, '2026-09-24').error).toBeTruthy();
    expect(store.validateChange('company_prevailing', { rate: 0 }, '2026-09-24').value.rate).toBe(0);
    expect(store.validateChange('company_prevailing', { rate: null }, '2026-09-24').error).toBeTruthy();
  });
});

describe('#7 sick and vacation priced separately', () => {
  test('sick 100% on a $20 day + vacation 50% on a $30 day = $280', () => {
    const book = makeRateBook({ workerRows: wRows(['1900-01-01', 20], ['2026-07-08', 30]) });
    const leave = computeLeaveHours([
      { type: 'sick', hours: null, start_date: '2026-07-06', end_date: '2026-07-06' },
      { type: 'vacation', hours: null, start_date: '2026-07-08', end_date: '2026-07-08' },
    ], new Map(), [], 8, '2026-07-06', '2026-07-12');
    const st = build({ leave, settings: { ...SETTINGS, sick_pay_pct: 100, vacation_pay_pct: 50 }, rateBook: book });
    expect(st.cost.sick).toBe(160);
    expect(st.cost.vacation).toBe(120);
  });
});

describe('#8 companyToday without a company_timezone', () => {
  beforeEach(() => pool.query.mockReset());
  test('falls back to the most common worker time zone, not UTC', async () => {
    pool.query.mockImplementation(async sql => {
      if (/key = 'company_timezone'/.test(sql)) return { rows: [{ value: '' }] };
      if (/FROM users/.test(sql)) return { rows: [{ timezone: 'Pacific/Kiritimati' }] };
      return { rows: [] };
    });
    expect(await store.companyToday('co')).toBe(wallDateInTZ(new Date(), 'Pacific/Kiritimati'));
  });
  test('no active user time zone → the company owner\'s time zone', async () => {
    pool.query.mockImplementation(async sql => {
      if (/key = 'company_timezone'/.test(sql)) return { rows: [] };
      if (/GROUP BY timezone/.test(sql)) return { rows: [] };
      if (/owner/.test(sql) && /FROM users/.test(sql)) return { rows: [{ timezone: 'Pacific/Kiritimati' }] };
      return { rows: [] };
    });
    expect(await store.companyToday('co-owner')).toBe(wallDateInTZ(new Date(), 'Pacific/Kiritimati'));
  });
  test('nothing on file → UTC, logged once per company (not a silent Phoenix guess)', async () => {
    const logger = require('../logger');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    pool.query.mockImplementation(async () => ({ rows: [] }));
    expect(store.FALLBACK_TIMEZONE).toBe('UTC');
    expect(await store.companyToday('co-none')).toBe(wallDateInTZ(new Date(), 'UTC'));
    await store.companyToday('co-none');
    await store.companyToday('co-none-2');
    const calls = warn.mock.calls.filter(c => JSON.stringify(c).includes('co-none'));
    expect(calls).toHaveLength(2); // once for co-none, once for co-none-2
    warn.mockRestore();
  });
});
