/**
 * Clock punch integrity:
 *  - /in keeps a client clock_in_time but flags it (clock_in_late_minutes) when
 *    it's well before the server received it, so a backdated punch can't pass
 *    as a normal one; a future time is clamped to now.
 *  - /out builds the entry from the row it LOCKED, not its unlocked pre-read,
 *    so a /switch landing in between can't make it re-pay the first segment.
 *  - /switch closes the old segment and opens the new one at the SAME instant
 *    (an offline-replayed switch used to overlap them = overlap paid twice).
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

// A tx client whose query() answers by SQL shape.
function txClient(handlers) {
  const calls = [];
  return {
    calls,
    release: jest.fn(),
    query: jest.fn(async (sql, params) => {
      calls.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(sql, params);
      return { rowCount: 0, rows: [] };
    }),
  };
}

beforeEach(() => {
  pool.query.mockReset();
  pool.connect.mockReset();
  // Post-response setImmediate work (alerts, hour limits) — answer harmlessly.
  pool.query.mockResolvedValue({ rowCount: 0, rows: [] });
});

describe('POST /api/clock/in — late / future clock_in_time', () => {
  function insertParams() {
    const call = pool.query.mock.calls.find(c => /INSERT INTO active_clock/.test(c[0]));
    return call && call[1];
  }

  beforeEach(() => {
    pool.query.mockReset();
    pool.query.mockImplementation(async (sql) => {
      if (/FROM settings/.test(sql)) return { rows: [{ key: 'feature_project_integration', value: '0' }] };
      if (/INSERT INTO active_clock/.test(sql)) return { rowCount: 1, rows: [{ user_id: 7, project_id: null }] };
      return { rowCount: 0, rows: [] };
    });
  });

  test('a clock-in claimed 10 hours ago is stored with its time and flagged ~600 min late', async () => {
    const claimed = new Date(Date.now() - 600 * 60000).toISOString();
    const res = await request(makeApp()).post('/api/clock/in').send({ clock_in_time: claimed });
    expect(res.status).toBe(201);
    const p = insertParams();
    expect(new Date(p[3]).toISOString()).toBe(claimed); // clock_in_time kept
    expect(p[11]).toBeGreaterThanOrEqual(599);           // clock_in_late_minutes
    expect(p[11]).toBeLessThanOrEqual(601);
  });

  test('a normal press (seconds ago) is not flagged', async () => {
    const res = await request(makeApp()).post('/api/clock/in').send({ clock_in_time: new Date(Date.now() - 5000).toISOString() });
    expect(res.status).toBe(201);
    expect(insertParams()[11]).toBeNull();
  });

  test('a future clock_in_time is clamped to now', async () => {
    const before = Date.now();
    const res = await request(makeApp()).post('/api/clock/in').send({ clock_in_time: new Date(before + 3 * 3600000).toISOString() });
    expect(res.status).toBe(201);
    const ts = new Date(insertParams()[3]).getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('POST /api/clock/out — closes the LOCKED row', () => {
  test('if a /switch replaced the segment after the pre-read, the entry uses the new segment', async () => {
    const preRead = { user_id: 7, company_id: 'co-1', project_id: 1, clock_in_time: '2026-09-24T08:00:00.000Z', work_date: '2026-09-24', timezone: 'UTC', clock_source: 'worker', clocked_in_by: null };
    const afterSwitch = { ...preRead, project_id: 2, clock_in_time: '2026-09-24T12:00:00.000Z', clock_in_late_minutes: null };

    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [preRead] }); // unlocked pre-read
    const tx = txClient([
      [/FOR UPDATE/, () => ({ rowCount: 1, rows: [afterSwitch] })],
      [/FROM settings/, () => ({ rowCount: 0, rows: [] })],
      [/FROM projects/, () => ({ rowCount: 1, rows: [{ wage_type: 'regular', name: 'Project Two' }] })],
      [/INSERT INTO time_entries/, (_s, p) => ({ rowCount: 1, rows: [{ id: 99, project_id: p[2], start_ts: p[6] }] })],
    ]);
    pool.connect.mockResolvedValueOnce(tx);

    const res = await request(makeApp()).post('/api/clock/out').send({ local_clock_in: '08:00', local_clock_out: '17:00' });
    expect(res.status).toBe(200);
    const ins = tx.calls.find(c => /INSERT INTO time_entries/.test(c.sql)).params;
    expect(ins[2]).toBe(2);                                                   // project from the locked row
    expect(new Date(ins[6]).toISOString()).toBe(afterSwitch.clock_in_time);  // start_ts from the locked row
    expect(ins[4]).not.toBe('08:00');                                         // stale client local_clock_in ignored
    expect(res.body.project_name).toBe('Project Two');
  });

  test('the late-clock-in flag is carried from active_clock onto the time entry', async () => {
    const row = { user_id: 7, company_id: 'co-1', project_id: null, clock_in_time: '2026-09-24T08:00:00.000Z', work_date: '2026-09-24', timezone: 'UTC', clock_source: 'worker', clocked_in_by: null, clock_in_late_minutes: 240 };
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [row] });
    const tx = txClient([
      [/FOR UPDATE/, () => ({ rowCount: 1, rows: [row] })],
      [/INSERT INTO time_entries/, () => ({ rowCount: 1, rows: [{ id: 1 }] })],
    ]);
    pool.connect.mockResolvedValueOnce(tx);

    const res = await request(makeApp()).post('/api/clock/out').send({});
    expect(res.status).toBe(200);
    const ins = tx.calls.find(c => /INSERT INTO time_entries/.test(c.sql)).params;
    expect(ins[20]).toBe(240);
  });
});

describe('POST /api/clock/out — end_ts is the client-tapped clock_out_time', () => {
  function setup(row) {
    pool.query.mockResolvedValueOnce({ rowCount: 1, rows: [row] });
    const tx = txClient([
      [/FOR UPDATE/, () => ({ rowCount: 1, rows: [row] })],
      [/INSERT INTO time_entries/, () => ({ rowCount: 1, rows: [{ id: 1 }] })],
    ]);
    pool.connect.mockResolvedValueOnce(tx);
    return tx;
  }
  const insertOf = tx => tx.calls.find(c => /INSERT INTO time_entries/.test(c.sql)).params;
  const row = (clockIn) => ({ user_id: 7, company_id: 'co-1', project_id: null, clock_in_time: clockIn, work_date: '2026-11-01', timezone: 'America/Chicago', clock_source: 'worker', clocked_in_by: null, clock_in_late_minutes: null });

  test('an offline clock-out synced hours later (across a DST change) keeps the tap instant', async () => {
    // Shift 2025-11-01 22:00 CDT → tapped out 2025-11-02 06:00 CST (DST ended at 02:00), synced now.
    const clockIn = '2025-11-02T03:00:00.000Z';
    const tapped = '2025-11-02T12:00:00.000Z';
    const tx = setup(row(clockIn));
    const res = await request(makeApp()).post('/api/clock/out')
      .send({ local_clock_in: '22:00', local_clock_out: '06:00', clock_out_time: tapped });
    expect(res.status).toBe(200);
    const ins = insertOf(tx);
    expect(new Date(ins[7]).toISOString()).toBe(tapped); // end_ts = tap, not the (much later) receive time
    expect(ins[5]).toMatch(/^06:00/);                       // end_time agrees with end_ts
  });

  test('a future clock_out_time is clamped to now (and the wall time derived from it)', async () => {
    const before = Date.now();
    const tx = setup(row(new Date(before - 3600e3).toISOString()));
    await request(makeApp()).post('/api/clock/out')
      .send({ local_clock_out: '23:59', clock_out_time: new Date(before + 6 * 3600e3).toISOString() });
    const end = new Date(insertOf(tx)[7]).getTime();
    expect(end).toBeGreaterThanOrEqual(before - 1000);
    expect(end).toBeLessThanOrEqual(Date.now() + 1000);
    expect(insertOf(tx)[5]).not.toMatch(/^23:59/);
  });

  test('a clock_out_time before the shift start is not accepted — server now instead', async () => {
    const before = Date.now();
    const clockIn = new Date(before - 3600e3).toISOString();
    const tx = setup(row(clockIn));
    await request(makeApp()).post('/api/clock/out')
      .send({ clock_out_time: new Date(before - 5 * 3600e3).toISOString() });
    const end = new Date(insertOf(tx)[7]).getTime();
    expect(end).toBeGreaterThanOrEqual(before - 1000);
  });

  test('an old client without clock_out_time falls back to server now', async () => {
    const before = Date.now();
    const tx = setup(row(new Date(before - 3600e3).toISOString()));
    await request(makeApp()).post('/api/clock/out').send({ local_clock_out: '17:00' });
    const ins = insertOf(tx);
    expect(new Date(ins[7]).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(ins[5]).toMatch(/^17:00/);
  });
});
