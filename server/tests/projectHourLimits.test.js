/**
 * Per-project hour limits engine (server/utils/projectHourLimits.js).
 *
 * Pure math: calcH / numOrNull / computeLimitTs / evaluateGate.
 * DB-backed: validateHourLimitInput + the money-critical reconcileUserActiveClock
 * (stop/switch AS OF the limit instant, loop-guard termination).
 */

jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));

const pool = require('../db');
const {
  numOrNull, calcH, computeLimitTs, evaluateGate, validateHourLimitInput,
  reconcileUserActiveClock,
} = require('../utils/projectHourLimits');

beforeEach(() => { pool.query.mockReset(); pool.connect.mockReset(); });

describe('calcH', () => {
  test('basic span', () => { expect(calcH('08:00:00', '12:00:00', 0)).toBe(4); });
  test('subtracts break minutes', () => { expect(calcH('08:00:00', '12:00:00', 30)).toBe(3.5); });
  test('crosses midnight', () => { expect(calcH('22:00:00', '02:00:00', 0)).toBe(4); });
  test('never negative', () => { expect(calcH('08:00:00', '08:00:00', 60)).toBe(0); });
});

describe('numOrNull', () => {
  test('coerces', () => { expect(numOrNull('8.5')).toBe(8.5); });
  test('blank/nullish → null', () => {
    expect(numOrNull('')).toBeNull();
    expect(numOrNull(null)).toBeNull();
    expect(numOrNull(undefined)).toBeNull();
    expect(numOrNull('abc')).toBeNull();
  });
});

describe('computeLimitTs', () => {
  const t0 = new Date('2026-01-01T08:00:00Z');
  test('daily only', () => {
    const { limitTs, reason } = computeLimitTs({ clockInTime: t0, prior: { daily: 6, weekly: 0 }, project: { daily_hour_limit: 8, weekly_hour_limit: null } });
    expect(reason).toBe('daily');
    expect(limitTs.toISOString()).toBe('2026-01-01T10:00:00.000Z'); // +2h remaining
  });
  test('weekly only', () => {
    const { limitTs, reason } = computeLimitTs({ clockInTime: t0, prior: { daily: 0, weekly: 38 }, project: { daily_hour_limit: null, weekly_hour_limit: 40 } });
    expect(reason).toBe('weekly');
    expect(limitTs.toISOString()).toBe('2026-01-01T10:00:00.000Z');
  });
  test('earlier of both wins', () => {
    const { limitTs, reason } = computeLimitTs({ clockInTime: t0, prior: { daily: 6, weekly: 39 }, project: { daily_hour_limit: 8, weekly_hour_limit: 40 } });
    expect(reason).toBe('weekly'); // +1h beats daily's +2h
    expect(limitTs.toISOString()).toBe('2026-01-01T09:00:00.000Z');
  });
  test('no limits → null', () => {
    expect(computeLimitTs({ clockInTime: t0, prior: { daily: 0, weekly: 0 }, project: {} }).limitTs).toBeNull();
  });
  test('already over → limit is the clock-in instant (clamped, never before)', () => {
    const { limitTs } = computeLimitTs({ clockInTime: t0, prior: { daily: 10, weekly: 0 }, project: { daily_hour_limit: 8 } });
    expect(limitTs.getTime()).toBe(t0.getTime());
  });
});

describe('evaluateGate', () => {
  test('off project is never gated', () => {
    expect(evaluateGate({ hour_limit_mode: 'off' }, { daily: 99, weekly: 99 }).atLimit).toBe(false);
  });
  test('warn at/over the daily cap', () => {
    const g = evaluateGate({ hour_limit_mode: 'warn', daily_hour_limit: 8 }, { daily: 8, weekly: 0 });
    expect(g).toMatchObject({ mode: 'warn', atLimit: true, reason: 'daily', limit: 8 });
  });
  test('hard under the cap is not gated', () => {
    expect(evaluateGate({ hour_limit_mode: 'hard', daily_hour_limit: 8 }, { daily: 5, weekly: 0 }).atLimit).toBe(false);
  });
});

describe('validateHourLimitInput', () => {
  const db = { query: jest.fn() };
  beforeEach(() => db.query.mockReset());

  test('rejects an unknown mode', async () => {
    const r = await validateHourLimitInput(db, { companyId: 1, projectId: 1, mode: 'sometimes' });
    expect(r.error).toMatch(/hour_limit_mode/);
  });
  test('warn/hard requires at least one limit', async () => {
    const r = await validateHourLimitInput(db, { companyId: 1, projectId: 1, mode: 'hard', daily: null, weekly: null });
    expect(r.error).toMatch(/daily or weekly/);
  });
  test('rejects a negative limit', async () => {
    const r = await validateHourLimitInput(db, { companyId: 1, projectId: 1, mode: 'warn', daily: -1 });
    expect(r.error).toMatch(/non-negative/);
  });
  test('rejects an overflow pointing at itself', async () => {
    const r = await validateHourLimitInput(db, { companyId: 1, projectId: 7, mode: 'hard', daily: 8, overflowProjectId: 7 });
    expect(r.error).toMatch(/different from this project/);
  });
  test('rejects an inactive overflow project', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ active: false }] });
    const r = await validateHourLimitInput(db, { companyId: 1, projectId: 7, mode: 'hard', daily: 8, overflowProjectId: 9 });
    expect(r.error).toMatch(/active/);
  });
  test('accepts a valid hard config', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ active: true }] });
    const r = await validateHourLimitInput(db, { companyId: 1, projectId: 7, mode: 'hard', daily: 8, overflowProjectId: 9 });
    expect(r).toEqual({ ok: true });
  });
});

describe('reconcileUserActiveClock', () => {
  // A worker clocked into project A 3h ago; they've already logged 6h on A today
  // and A has an 8h daily hard cap → limit is 2h after clock-in = 1h ago (past).
  const clockInTime = new Date(Date.now() - 3 * 3600 * 1000);
  const expectedLimitTs = new Date(clockInTime.getTime() + 2 * 3600 * 1000); // +2h remaining of the 8h cap
  const priorRows = { rows: [{ start_time: '06:00:00', end_time: '12:00:00', break_minutes: 0 }] }; // 6h

  function makeClient(forUpdateRows) {
    let forUpdateCall = 0;
    const calls = [];
    const query = jest.fn(async (sql, params) => {
      calls.push([sql, params]);
      if (/^BEGIN|COMMIT|ROLLBACK/.test(sql.trim())) return {};
      if (/FROM active_clock ac\s+JOIN projects/.test(sql)) return forUpdateRows[forUpdateCall++] || { rowCount: 0, rows: [] };
      if (/FROM settings WHERE company_id/.test(sql)) return { rows: [{ value: '1' }] };
      if (/SELECT start_time, end_time, break_minutes FROM time_entries/.test(sql)) return priorRows;
      if (/FROM projects WHERE id = \$1 AND company_id = \$2/.test(sql)) {
        return { rows: [{ id: 20, name: 'Overflow B', wage_type: 'regular', active: true, hour_limit_mode: 'off', daily_hour_limit: null, weekly_hour_limit: null, hour_limit_overflow_project_id: null }] };
      }
      if (/INSERT INTO time_entries/.test(sql)) return { rows: [{ id: 500 }] };
      if (/UPDATE active_clock/.test(sql)) return { rows: [{}] };
      if (/DELETE FROM active_clock/.test(sql)) return { rowCount: 1 };
      return { rows: [] };
    });
    return { query, release: jest.fn(), calls: () => calls };
  }

  const activeA = (overflow) => ({
    rows: [{
      user_id: 5, company_id: 1, project_id: 10, clock_in_time: clockInTime, work_date: '2026-01-01',
      timezone: 'UTC', notes: null, clock_in_lat: null, clock_in_lng: null, clock_source: 'worker', clocked_in_by: null,
      wage_type: 'regular', hour_limit_mode: 'hard', daily_hour_limit: 8, weekly_hour_limit: null,
      hour_limit_overflow_project_id: overflow, project_name: 'Project A',
    }],
  });

  test('no overflow → clocks out AS OF the limit instant', async () => {
    const client = makeClient([activeA(null)]);
    pool.connect.mockResolvedValue(client);
    const { actions } = await reconcileUserActiveClock(5);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('clock_out');
    expect(actions[0].at.getTime()).toBe(expectedLimitTs.getTime());
    // The closing entry ends exactly at the limit instant, not "now".
    const insert = client.calls().find(c => /INSERT INTO time_entries/.test(c[0]));
    expect(new Date(insert[1][7]).getTime()).toBe(expectedLimitTs.getTime()); // end_ts param
    // And the active clock was deleted (not switched).
    expect(client.calls().some(c => /DELETE FROM active_clock/.test(c[0]))).toBe(true);
  });

  test('overflow with capacity → switches AS OF the limit instant, then terminates', async () => {
    // First FOR UPDATE returns A (hard, past limit); after the switch the loop
    // re-reads and gets B (mode off) → terminates.
    const bRow = { rows: [{ project_id: 20, hour_limit_mode: 'off', clock_in_time: expectedLimitTs, work_date: '2026-01-01', company_id: 1, user_id: 5, timezone: 'UTC' }] };
    const client = makeClient([activeA(20), bRow]);
    pool.connect.mockResolvedValue(client);
    const { actions } = await reconcileUserActiveClock(5);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'switch', to: 20 });
    expect(actions[0].at.getTime()).toBe(expectedLimitTs.getTime());
    const upd = client.calls().find(c => /UPDATE active_clock/.test(c[0]));
    expect(upd[1]).toEqual([5, 20, expectedLimitTs]); // moved to project 20 at the limit instant
    expect(client.calls().some(c => /DELETE FROM active_clock/.test(c[0]))).toBe(false);
  });

  test('no-op when the project has no hard limit', async () => {
    const off = { rows: [{ user_id: 5, company_id: 1, project_id: 10, clock_in_time: clockInTime, work_date: '2026-01-01', timezone: 'UTC', hour_limit_mode: 'off', project_name: 'A' }] };
    const client = makeClient([off]);
    pool.connect.mockResolvedValue(client);
    const { actions } = await reconcileUserActiveClock(5);
    expect(actions).toHaveLength(0);
  });
});
