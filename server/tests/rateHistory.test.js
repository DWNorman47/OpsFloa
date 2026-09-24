/**
 * Effective-dated rate resolver (utils/rateHistory.js). The rule: the rate for a
 * date is the history row with the greatest effective_date <= that date.
 */
jest.mock('../db', () => ({ query: jest.fn() }));
const pool = require('../db');
const fs = require('fs');
const path = require('path');
const {
  rowInEffect, makeRateBook, workerRateOn, defaultRateOn, prevailingRateOn,
  governedSpan, lockedPeriodsInSpan, isValidDate, loadRateBook, loadRateBookForEntries, dayKey,
} = require('../utils/rateHistory');

const rows = (...list) => makeRateBook({ workerRows: list.map(([d, r, t = 'hourly']) => ({ user_id: 1, effective_date: d, hourly_rate: r, rate_type: t })) });
const W = { id: 1, hourly_rate: 99, rate_type: 'hourly' }; // the (current) cache — ignored when history exists

describe('rowInEffect', () => {
  const sorted = makeRateBook({ defaultRows: [
    { effective_date: '2026-03-01', rate: 25 },
    { effective_date: '1900-01-01', rate: 20 },
    { effective_date: '2026-06-15', rate: 30 },
  ] }).defaults;

  test('greatest effective_date <= date', () => {
    expect(rowInEffect(sorted, '2026-04-10').rate).toBe(25);
    expect(rowInEffect(sorted, '2025-12-31').rate).toBe(20);
    expect(rowInEffect(sorted, '2027-01-01').rate).toBe(30);
  });
  test('a change dated ON the entry date applies to that entry', () => {
    expect(rowInEffect(sorted, '2026-03-01').rate).toBe(25);
    expect(rowInEffect(sorted, '2026-02-28').rate).toBe(20);
    expect(rowInEffect(sorted, '2026-06-15').rate).toBe(30);
  });
  test('rows are sorted regardless of input order', () => {
    expect(sorted.map(r => r.effective_date)).toEqual(['1900-01-01', '2026-03-01', '2026-06-15']);
  });
  test('a date before every row → the earliest row (no older rate on record)', () => {
    const late = makeRateBook({ defaultRows: [{ effective_date: '2026-05-01', rate: 40 }] }).defaults;
    expect(rowInEffect(late, '2026-01-01').rate).toBe(40);
  });
  test('no rows → null', () => {
    expect(rowInEffect([], '2026-01-01')).toBeNull();
    expect(rowInEffect(null, '2026-01-01')).toBeNull();
  });
  test('accepts Date objects (pg DATE) for both sides', () => {
    const b = makeRateBook({ defaultRows: [{ effective_date: new Date(2026, 2, 1), rate: 25 }, { effective_date: '1900-01-01', rate: 20 }] }).defaults;
    expect(rowInEffect(b, new Date(2026, 2, 1)).rate).toBe(25);
    expect(rowInEffect(b, new Date(2026, 1, 28)).rate).toBe(20);
  });
});

describe('workerRateOn', () => {
  test('raise mid-period: before at the old rate, on/after at the new', () => {
    const b = rows(['1900-01-01', 20], ['2026-07-08', 22]);
    expect(workerRateOn(b, W, '2026-07-06').rate).toBe(20); // Mon
    expect(workerRateOn(b, W, '2026-07-07').rate).toBe(20); // Tue
    expect(workerRateOn(b, W, '2026-07-08').rate).toBe(22); // Wed — change day applies
    expect(workerRateOn(b, W, '2026-07-10').rate).toBe(22); // Fri
  });
  test('multiple changes in one period each apply from their own date', () => {
    const b = rows(['1900-01-01', 20], ['2026-07-07', 21], ['2026-07-09', 23]);
    expect(['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10'].map(d => workerRateOn(b, W, d).rate))
      .toEqual([20, 21, 21, 23, 23]);
  });
  test('a future-dated change is not applied to earlier dates', () => {
    const b = rows(['1900-01-01', 20], ['2027-01-01', 30]);
    expect(workerRateOn(b, W, '2026-12-31').rate).toBe(20);
    expect(workerRateOn(b, W, '2027-01-01').rate).toBe(30);
  });
  test('rate_type switch hourly → daily mid-period', () => {
    const b = rows(['1900-01-01', 25, 'hourly'], ['2026-07-08', 200, 'daily']);
    expect(workerRateOn(b, W, '2026-07-07')).toMatchObject({ rate: 25, rateType: 'hourly' });
    expect(workerRateOn(b, W, '2026-07-08')).toMatchObject({ rate: 200, rateType: 'daily' });
  });
  test('own rate missing / 0 → company default in effect THAT day', () => {
    const b = makeRateBook({
      workerRows: [{ user_id: 1, effective_date: '1900-01-01', hourly_rate: null, rate_type: 'hourly' }, { user_id: 1, effective_date: '2026-08-01', hourly_rate: 0, rate_type: 'hourly' }],
      defaultRows: [{ effective_date: '1900-01-01', rate: 30 }, { effective_date: '2026-07-08', rate: 32 }],
    });
    expect(workerRateOn(b, W, '2026-07-07').rate).toBe(30);
    expect(workerRateOn(b, W, '2026-07-08').rate).toBe(32);
    expect(workerRateOn(b, W, '2026-08-02').rate).toBe(32);
  });
  test('no history for the worker → the current cache (old behaviour)', () => {
    const b = makeRateBook({ defaultRows: [{ effective_date: '1900-01-01', rate: 30 }] });
    expect(workerRateOn(b, { id: 7, hourly_rate: 18, rate_type: 'daily' }, '2026-01-01')).toMatchObject({ rate: 18, rateType: 'daily' });
    expect(workerRateOn(b, { id: 7, hourly_rate: null }, '2026-01-01').rate).toBe(30);
    expect(workerRateOn(null, { id: 7, hourly_rate: null }, '2026-01-01', { default_hourly_rate: 31 }).rate).toBe(31);
  });
  test('ids match whether numeric or string', () => {
    const b = makeRateBook({ workerRows: [{ user_id: '5', effective_date: '1900-01-01', hourly_rate: '44.50', rate_type: 'hourly' }] });
    expect(workerRateOn(b, { id: 5 }, '2026-01-01').rate).toBe(44.5);
  });
});

describe('defaultRateOn / prevailingRateOn', () => {
  test('default: history, else setting', () => {
    const b = makeRateBook({ defaultRows: [{ effective_date: '1900-01-01', rate: 30 }, { effective_date: '2026-07-01', rate: 35 }] });
    expect(defaultRateOn(b, '2026-06-30', { default_hourly_rate: 99 })).toBe(30);
    expect(defaultRateOn(b, '2026-07-01', { default_hourly_rate: 99 })).toBe(35);
    expect(defaultRateOn(makeRateBook(), '2026-07-01', { default_hourly_rate: 99 })).toBe(99);
  });
  test('prevailing change mid-job; NULL row = no project rate', () => {
    const b = makeRateBook({ projectRows: [
      { project_id: 3, effective_date: '1900-01-01', rate: 45 },
      { project_id: 3, effective_date: '2026-07-08', rate: 52.5 },
      { project_id: 3, effective_date: '2026-09-01', rate: null },
    ] });
    expect(prevailingRateOn(b, 3, '2026-07-07')).toBe(45);
    expect(prevailingRateOn(b, 3, '2026-07-08')).toBe(52.5);
    expect(prevailingRateOn(b, 3, '2026-09-02')).toBeNull();
  });
  test('project without history → current map value', () => {
    expect(prevailingRateOn(makeRateBook(), 9, '2026-01-01', { 9: 61 })).toBe(61);
    expect(prevailingRateOn(makeRateBook(), 9, '2026-01-01', {})).toBeNull();
    expect(prevailingRateOn(makeRateBook(), null, '2026-01-01', {})).toBeNull();
  });
});

describe('governedSpan / lockedPeriodsInSpan', () => {
  test('a row governs until the day before the next row', () => {
    const others = [{ effective_date: '1900-01-01' }, { effective_date: '2026-08-01' }];
    expect(governedSpan(others, '2026-07-08')).toEqual({ from: '2026-07-08', to: '2026-07-31' });
    expect(governedSpan([{ effective_date: '1900-01-01' }], '2026-07-08')).toEqual({ from: '2026-07-08', to: null });
  });
  test('locked periods overlapping the span', () => {
    const periods = [
      { id: 1, period_start: '2026-06-01', period_end: '2026-06-14' },
      { id: 2, period_start: '2026-06-15', period_end: '2026-06-28' },
      { id: 3, period_start: '2026-06-29', period_end: '2026-07-12' },
      { id: 4, period_start: '2026-08-01', period_end: '2026-08-14' },
    ];
    expect(lockedPeriodsInSpan(periods, { from: '2026-06-20', to: null }).map(p => p.id)).toEqual([2, 3, 4]);
    expect(lockedPeriodsInSpan(periods, { from: '2026-06-20', to: '2026-07-31' }).map(p => p.id)).toEqual([2, 3]);
    expect(lockedPeriodsInSpan(periods, { from: '2026-09-01', to: null })).toEqual([]);
  });
});

describe('isValidDate / dayKey', () => {
  test('calendar-valid YYYY-MM-DD only', () => {
    expect(isValidDate('2026-07-08')).toBe(true);
    expect(isValidDate('2020-02-29')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2026-7-8')).toBe(false);
    expect(isValidDate('')).toBe(false);
    expect(isValidDate(null)).toBe(false);
  });
  test('dayKey normalizes', () => {
    expect(dayKey('2026-07-08T00:00:00Z')).toBe('2026-07-08');
    expect(dayKey(new Date(2026, 6, 8))).toBe('2026-07-08');
    expect(dayKey(null)).toBeNull();
  });
});

describe('loadRateBook — batched, one query per history', () => {
  beforeEach(() => pool.query.mockReset());
  test('three queries, scoped by company + ids + upper date bound', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ user_id: 1, hourly_rate: '20', rate_type: 'hourly', effective_date: '1900-01-01' }] })
      .mockResolvedValueOnce({ rows: [{ project_id: 3, rate: '45', effective_date: '1900-01-01' }] })
      .mockResolvedValueOnce({ rows: [{ rate: '30', effective_date: '1900-01-01' }] });
    const b = await loadRateBookForEntries('co', [
      { user_id: 1, project_id: 3, work_date: '2026-07-06' },
      { user_id: 1, project_id: null, work_date: '2026-07-10' },
    ]);
    expect(pool.query).toHaveBeenCalledTimes(3);
    const [wSql, wArgs] = pool.query.mock.calls[0];
    expect(wSql).toMatch(/FROM worker_rate_history/);
    expect(wArgs).toEqual(['co', [1], '2026-07-10']);
    expect(pool.query.mock.calls[1][1]).toEqual(['co', [3], '2026-07-10']);
    expect(pool.query.mock.calls[2][1]).toEqual(['co', '2026-07-10']);
    expect(workerRateOn(b, { id: 1 }, '2026-07-06').rate).toBe(20);
    expect(prevailingRateOn(b, 3, '2026-07-06')).toBe(45);
  });
  test('empty id lists skip their query', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await loadRateBook({ companyId: 'co', userIds: [], projectIds: [], to: null });
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toMatch(/company_default_rate_history/);
  });
});

describe('migration 0209 — static sanity', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0209_rate_history.sql'), 'utf8');
  test('creates the three history tables', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS worker_rate_history/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS project_prevailing_rate_history/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS company_default_rate_history/);
  });
  test('rate_type CHECK matches the enum', () => {
    expect(sql).toMatch(/CHECK \(rate_type IN \('hourly', 'daily'\)\)/);
  });
  test('uniqueness per owner + date', () => {
    expect(sql).toMatch(/UNIQUE \(user_id, effective_date\)/);
    expect(sql).toMatch(/UNIQUE \(project_id, effective_date\)/);
    expect(sql).toMatch(/UNIQUE \(company_id, effective_date\)/);
  });
  test('backfill is idempotent and dated 1900-01-01 with the CURRENT values', () => {
    const inserts = sql.match(/INSERT INTO \w+[\s\S]*?;/g) || [];
    expect(inserts).toHaveLength(3);
    for (const ins of inserts) {
      expect(ins).toMatch(/DATE '1900-01-01'/);
      expect(ins).toMatch(/ON CONFLICT \([a-z_]+, effective_date\) DO NOTHING/);
    }
    expect(inserts[0]).toMatch(/FROM users u/);
    expect(inserts[0]).toMatch(/u\.hourly_rate/);
    expect(inserts[0]).toMatch(/u\.rate_type/);
    expect(inserts[1]).toMatch(/FROM projects p/);
    expect(inserts[1]).toMatch(/prevailing_wage_rate IS NOT NULL/);
    expect(inserts[2]).toMatch(/key = 'default_hourly_rate'/);
    // Non-numeric settings text must not abort the boot migration on ::numeric.
    expect(inserts[2]).toMatch(/s\.value ~ /);
  });
  test('0209 is the only migration with that number', () => {
    const files = fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter(f => f.startsWith('0209_'));
    expect(files).toEqual(['0209_rate_history.sql']);
  });
});
