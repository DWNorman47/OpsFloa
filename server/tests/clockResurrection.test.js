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
