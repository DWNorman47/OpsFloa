/**
 * POST /api/clock/in idempotency against a RESURRECTED shift.
 *
 * A clock-in queued offline can replay after the shift has already been clocked out
 * (a double queue-replay, or an out that outran the queued in). Before the fix, that
 * replay re-inserted a fresh active_clock and the closed shift looked "undone." Now, if
 * a completed time entry already exists for the same clock-in instant, /in returns a
 * no-op and never resurrects the shift.
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

beforeEach(() => { pool.query.mockReset(); pool.connect.mockReset(); });

test('a replayed clock-in for an already-closed shift is a no-op (no active_clock re-inserted)', async () => {
  pool.query
    // settings: projects disabled so no project is required (keeps the path short)
    .mockResolvedValueOnce({ rows: [{ key: 'feature_project_integration', value: '0' }] })
    // the resurrection guard: a completed time entry already exists for this instant
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ ok: 1 }] });

  const res = await request(makeApp())
    .post('/api/clock/in')
    .send({ clock_in_time: '2026-08-05T14:00:00.000Z' });

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ already_clocked_out: true });
  // Only the settings read + the closed-shift check ran — no INSERT into active_clock.
  expect(pool.query).toHaveBeenCalledTimes(2);
  const sql = pool.query.mock.calls.map(c => c[0]).join('\n');
  expect(sql).not.toMatch(/INSERT INTO active_clock/);
});

test('with no matching closed entry, the guard does not short-circuit (proceeds to insert)', async () => {
  pool.query
    .mockResolvedValueOnce({ rows: [{ key: 'feature_project_integration', value: '0' }] }) // settings
    .mockResolvedValueOnce({ rowCount: 0, rows: [] })                                       // no closed entry
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1, user_id: 7, clock_in_time: '2026-08-05T14:00:00.000Z', project_id: null }] }); // INSERT active_clock

  const res = await request(makeApp())
    .post('/api/clock/in')
    .send({ clock_in_time: '2026-08-05T14:00:00.000Z' });

  expect(res.status).toBe(201);
  const sql = pool.query.mock.calls.map(c => c[0]).join('\n');
  expect(sql).toMatch(/INSERT INTO active_clock/);
});

describe('POST /api/clock/out — recover a shift whose offline clock-in never synced', () => {
  test('no active_clock + a clock_in_time in the payload → rebuild the entry instead of 400', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // SELECT active_clock → none
    const tx = {
      query: jest.fn()
        .mockResolvedValueOnce({})                                    // BEGIN
        .mockResolvedValueOnce({})                                    // advisory lock
        .mockResolvedValueOnce({ rowCount: 0, rows: [] })             // dedup: no existing entry
        .mockResolvedValueOnce({})                                    // DELETE any stray active_clock
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 99, start_ts: '2026-08-05T14:00:00.000Z' }] }) // INSERT time_entries
        .mockResolvedValueOnce({}),                                   // COMMIT
      release: jest.fn(),
    };
    pool.connect.mockResolvedValueOnce(tx);

    const res = await request(makeApp())
      .post('/api/clock/out')
      .send({ clock_in_time: '2026-08-05T14:00:00.000Z', local_clock_in: '07:00:00', local_clock_out: '15:00:00' });

    expect(res.status).toBe(200);
    expect(res.body.recovered).toBe(true);
    expect(tx.query.mock.calls.map(c => c[0]).join('\n')).toMatch(/INSERT INTO time_entries/);
    expect(tx.release).toHaveBeenCalledTimes(1);
  });

  test('no active_clock + a shift already recorded for that instant → no duplicate, returns it', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // SELECT active_clock → none
    const tx = {
      query: jest.fn()
        .mockResolvedValueOnce({})                                    // BEGIN
        .mockResolvedValueOnce({})                                    // advisory lock
        .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42 }] })   // dedup: already recorded
        .mockResolvedValueOnce({}),                                   // COMMIT
      release: jest.fn(),
    };
    pool.connect.mockResolvedValueOnce(tx);

    const res = await request(makeApp())
      .post('/api/clock/out')
      .send({ clock_in_time: '2026-08-05T14:00:00.000Z', local_clock_in: '07:00:00', local_clock_out: '15:00:00' });

    expect(res.status).toBe(200);
    expect(res.body.already_recorded).toBe(true);
    expect(tx.query.mock.calls.map(c => c[0]).join('\n')).not.toMatch(/INSERT INTO time_entries/);
  });

  test('no active_clock and nothing to rebuild from → still 400', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // SELECT active_clock → none
    const res = await request(makeApp())
      .post('/api/clock/out')
      .send({ local_clock_in: '07:00:00', local_clock_out: '15:00:00' }); // no clock_in_time
    expect(res.status).toBe(400);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
