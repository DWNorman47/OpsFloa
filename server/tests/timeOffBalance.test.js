/**
 * GET /time-off/balance — PTO balance counts partial-day requests as a FRACTION of a
 * day (hours / company day length), not a whole day. Full-day requests still count as
 * whole calendar days. Guards the day-length denominator against a 0/missing setting.
 */

let mockCurrentUser;

jest.mock('../middleware/auth', () => ({
  requireAuth:  (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToCompanyAdmins: jest.fn() }));
jest.mock('../routes/inbox', () => ({ createInboxItem: jest.fn(), createInboxItemBatch: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const timeOffRoute = require('../routes/timeOff');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: () => {} }; next(); });
  app.use('/time-off', timeOffRoute);
  return app;
}

beforeEach(() => { pool.query.mockReset(); mockCurrentUser = { id: 3, company_id: 'co-1', role: 'worker' }; });

// The balance route fires two queries in parallel: [0] settings (key/value rows),
// [1] the used aggregate ({ full_days, partial_hours }). Mock both.
function mockBalance({ settings = [], full_days = 0, partial_hours = 0 } = {}) {
  pool.query
    .mockResolvedValueOnce({ rows: settings })
    .mockResolvedValueOnce({ rows: [{ full_days, partial_hours }] });
}

test('a 4h partial day on an 8h shift counts as half a day', async () => {
  mockBalance({
    settings: [{ key: 'pto_annual_days', value: '10' }, { key: 'regular_shift_hours', value: '8' }],
    full_days: 2, partial_hours: 4,
  });
  const res = await request(makeApp()).get('/time-off/balance');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ annual_days: 10, used_days: 2.5, remaining_days: 7.5 });
});

test('full days only → whole-day count unchanged', async () => {
  mockBalance({
    settings: [{ key: 'pto_annual_days', value: '10' }, { key: 'regular_shift_hours', value: '8' }],
    full_days: 3, partial_hours: 0,
  });
  const res = await request(makeApp()).get('/time-off/balance');
  expect(res.body).toEqual({ annual_days: 10, used_days: 3, remaining_days: 7 });
});

test('missing regular_shift_hours falls back to an 8h day (no divide-by-zero)', async () => {
  mockBalance({
    settings: [{ key: 'pto_annual_days', value: '5' }], // no regular_shift_hours
    full_days: 0, partial_hours: 6,
  });
  const res = await request(makeApp()).get('/time-off/balance');
  expect(res.body.used_days).toBe(0.75); // 6 / 8
  expect(res.body.remaining_days).toBe(4.25);
});

test('a 0 regular_shift_hours setting also falls back to 8 (guarded)', async () => {
  mockBalance({
    settings: [{ key: 'pto_annual_days', value: '5' }, { key: 'regular_shift_hours', value: '0' }],
    full_days: 0, partial_hours: 4,
  });
  const res = await request(makeApp()).get('/time-off/balance');
  expect(res.body.used_days).toBe(0.5); // 4 / 8, not NaN/Infinity
});

test('remaining never goes negative', async () => {
  mockBalance({
    settings: [{ key: 'pto_annual_days', value: '2' }, { key: 'regular_shift_hours', value: '8' }],
    full_days: 5, partial_hours: 0,
  });
  const res = await request(makeApp()).get('/time-off/balance');
  expect(res.body.remaining_days).toBe(0);
});
