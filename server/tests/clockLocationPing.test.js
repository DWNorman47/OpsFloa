/**
 * POST /api/clock/location — besides updating the "last known" point on
 * active_clock, it writes a throttled breadcrumb row to location_pings
 * (migration 0168) so a worker's path during a shift is retained.
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

const flush = () => new Promise(r => setImmediate(r)); // let the fire-and-forget insert run

beforeEach(() => { pool.query.mockReset(); pool.connect.mockReset(); });

test('updates active_clock and writes a throttled breadcrumb ping', async () => {
  pool.query
    .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1 }] }) // active_clock UPDATE (clocked in)
    .mockResolvedValueOnce({ rowCount: 1 });                    // location_pings INSERT
  const res = await request(makeApp()).post('/api/clock/location').send({ lat: 30.1, lng: -97.7 });
  expect(res.status).toBe(200);
  await flush();
  const insert = pool.query.mock.calls.find(c => /INSERT INTO location_pings/.test(c[0]));
  expect(insert).toBeTruthy();
  expect(insert[0]).toMatch(/NOT EXISTS/);                      // throttle guard present
  expect(insert[1]).toEqual(['co-1', 7, 30.1, -97.7]);
});

test('not clocked in → 400 and no ping is written', async () => {
  pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // active_clock UPDATE hits nothing
  const res = await request(makeApp()).post('/api/clock/location').send({ lat: 30.1, lng: -97.7 });
  expect(res.status).toBe(400);
  await flush();
  const insert = pool.query.mock.calls.find(c => /INSERT INTO location_pings/.test(c[0]));
  expect(insert).toBeFalsy();
});

test('invalid coordinates → 400 and no DB writes', async () => {
  const res = await request(makeApp()).post('/api/clock/location').send({ lat: 999, lng: -97.7 });
  expect(res.status).toBe(400);
  await flush();
  expect(pool.query).not.toHaveBeenCalled();
});
