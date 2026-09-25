/**
 * Worker clock paths and locked pay periods.
 *
 * Decision: a worker clocking out (or switching, or the offline-recovery path, or
 * marking a day) must NEVER lose the shift. When the work date is in a locked pay
 * period the entry is still created — status 'pending' — and the response carries
 * `locked_period: true` + the periods. The approvals queue flags it
 * (in_locked_period) and approval is refused until an admin unlocks the period.
 *
 * mark-day also validates local_work_date (YYYY-MM-DD, within a day of server today).
 */

const mockUser = { id: 7, company_id: 'co-1', full_name: 'Worker', role: 'worker' };
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockUser; next(); },
  requirePerm: () => (_req, _res, next) => next(),
}));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../logger', () => {
  const noop = () => {};
  const l = { info: noop, warn: noop, error: noop, debug: noop };
  l.child = () => l;
  return l;
});
jest.mock('../push', () => ({ sendPushToCompanyAdmins: jest.fn() }));
jest.mock('../routes/inbox', () => ({ createInboxItem: jest.fn(), createInboxItemBatch: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../failureLog', () => ({ logFailure: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const clockRoute = require('../routes/clock');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: () => {}, warn: () => {} }; next(); });
  app.use('/api/clock', clockRoute);
  return app;
}

const LOCK_RE = /FROM pay_periods pp\s+WHERE pp\.company_id = \$1/;
const PERIOD = { id: 5, period_start: '2026-09-01', period_end: '2026-09-15', label: null };
const today = () => new Date().toISOString().slice(0, 10);

function answerer(handlers, lockedDates) {
  return async (sql, params) => {
    if (LOCK_RE.test(sql)) {
      const hit = (params[1] || []).some(d => lockedDates.includes(d));
      return hit ? { rowCount: 1, rows: [PERIOD] } : { rowCount: 0, rows: [] };
    }
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(sql, params);
    return { rowCount: 0, rows: [] };
  };
}
function setup(handlers, lockedDates = []) {
  const fn = answerer(handlers, lockedDates);
  pool.query.mockImplementation(fn);
  const client = { query: jest.fn(fn), release: jest.fn() };
  pool.connect.mockResolvedValue(client);
  return client;
}
const inserted = (client) => client.query.mock.calls.some(c => /INSERT INTO time_entries/.test(c[0]));

beforeEach(() => { pool.query.mockReset(); pool.connect.mockReset(); });

const clockRow = (wd) => ({ user_id: 7, company_id: 'co-1', project_id: null, clock_in_time: new Date(Date.now() - 3600e3).toISOString(), work_date: wd, timezone: 'UTC', clock_source: 'worker', clocked_in_by: null, clock_in_late_minutes: null });

describe('POST /clock/out', () => {
  test('into a locked period: entry still created, flagged locked_period', async () => {
    const client = setup([
      [/FROM active_clock WHERE user_id = \$1/, () => ({ rowCount: 1, rows: [clockRow('2026-09-03')] })],
      [/INSERT INTO time_entries/, () => ({ rowCount: 1, rows: [{ id: 1, status: 'pending' }] })],
    ], ['2026-09-03']);
    const res = await request(makeApp()).post('/api/clock/out').send({});
    expect(res.status).toBe(200);
    expect(inserted(client)).toBe(true);
    expect(res.body.locked_period).toBe(true);
    expect(res.body.locked_periods).toHaveLength(1);
  });

  test('unlocked: no flag', async () => {
    setup([
      [/FROM active_clock WHERE user_id = \$1/, () => ({ rowCount: 1, rows: [clockRow('2026-09-20')] })],
      [/INSERT INTO time_entries/, () => ({ rowCount: 1, rows: [{ id: 1 }] })],
    ], ['2026-09-03']);
    const res = await request(makeApp()).post('/api/clock/out').send({});
    expect(res.status).toBe(200);
    expect(res.body.locked_period).toBeFalsy();
  });

  test('recovery path (no active clock) into a locked period is kept and flagged', async () => {
    const client = setup([
      [/INSERT INTO time_entries/, () => ({ rowCount: 1, rows: [{ id: 2 }] })],
    ], ['2026-09-03']);
    const res = await request(makeApp()).post('/api/clock/out').send({
      clock_in_time: new Date(Date.now() - 3 * 3600e3).toISOString(), work_date: '2026-09-03', timezone: 'UTC',
    });
    expect(res.status).toBe(200);
    expect(res.body.recovered).toBe(true);
    expect(res.body.locked_period).toBe(true);
    expect(inserted(client)).toBe(true);
  });
});

describe('POST /clock/switch', () => {
  test('closing a segment into a locked period keeps it and flags it', async () => {
    const client = setup([
      [/FROM settings/, () => ({ rows: [] })],
      [/FROM projects WHERE id = \$1 AND company_id = \$2 AND active = true/, () => ({ rowCount: 1, rows: [{ id: 2, name: 'B', wage_type: 'regular', hour_limit_mode: 'off' }] })],
      [/FROM active_clock WHERE user_id = \$1 FOR UPDATE/, () => ({ rowCount: 1, rows: [{ ...clockRow('2026-09-03'), project_id: 1 }] })],
      [/SELECT wage_type, name FROM projects/, () => ({ rowCount: 1, rows: [{ wage_type: 'regular', name: 'A' }] })],
      [/INSERT INTO time_entries/, () => ({ rowCount: 1, rows: [{ id: 3 }] })],
      [/UPDATE active_clock/, () => ({ rowCount: 1, rows: [{ user_id: 7, project_id: 2 }] })],
    ], ['2026-09-03']);
    const res = await request(makeApp()).post('/api/clock/switch').send({ project_id: 2 });
    expect(res.status).toBe(201);
    expect(inserted(client)).toBe(true);
    expect(res.body.closed_entry.locked_period).toBe(true);
  });
});

describe('POST /clock/mark-day', () => {
  const handlers = [
    [/SELECT rate_type, day_mark_mode FROM users/, () => ({ rowCount: 1, rows: [{ rate_type: 'daily', day_mark_mode: true }] })],
    [/INSERT INTO time_entries/, (_s, p) => ({ rowCount: 1, rows: [{ id: 4, work_date: p[2] }] })],
  ];

  test('rejects a malformed local_work_date', async () => {
    setup(handlers);
    const res = await request(makeApp()).post('/api/clock/mark-day').send({ local_work_date: '09/03/2026' });
    expect(res.status).toBe(400);
    expect(pool.query.mock.calls.some(c => /INSERT INTO time_entries/.test(c[0]))).toBe(false);
  });

  test('rejects a date far from today (no marking arbitrary past/future days)', async () => {
    setup(handlers);
    const res = await request(makeApp()).post('/api/clock/mark-day').send({ local_work_date: '2020-01-01' });
    expect(res.status).toBe(400);
  });

  test('today in a locked period: recorded and flagged', async () => {
    setup(handlers, [today()]);
    const res = await request(makeApp()).post('/api/clock/mark-day').send({ local_work_date: today() });
    expect(res.status).toBe(201);
    expect(res.body.locked_period).toBe(true);
  });
});
