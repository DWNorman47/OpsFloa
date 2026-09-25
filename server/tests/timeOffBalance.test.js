/**
 * GET /time-off/balance — the PTO balance counts APPROVED VACATION only, only the
 * company's WORKING days, and every request OVERLAPPING the year (not just those
 * starting in it). Partial-day requests count as a FRACTION of a day (hours /
 * company day length), with the day-length denominator guarded against a
 * 0/missing setting.
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

// The balance route runs two queries: settings (key/value rows) and the approved
// vacation requests overlapping the year. Route by SQL, capture the request SQL.
let reqSql;
function mockBalance({ settings = [], requests = [] } = {}) {
  reqSql = null;
  pool.query.mockImplementation(async (sql, params) => {
    if (/FROM settings/.test(sql)) return { rows: settings };
    if (/FROM time_off_requests/.test(sql)) { reqSql = { sql, params }; return { rows: requests }; }
    return { rows: [] };
  });
}
const S = (annual, day) => [
  ...(annual != null ? [{ key: 'pto_annual_days', value: String(annual) }] : []),
  ...(day != null ? [{ key: 'regular_shift_hours', value: String(day) }] : []),
];
const full = (s, e) => ({ start_date: s, end_date: e, hours: null });
const part = (d, h) => ({ start_date: d, end_date: d, hours: h });

test('a 4h partial day on an 8h shift counts as half a day', async () => {
  // Mon 2026-09-07 + Tue 2026-09-08 full + a 4h partial
  mockBalance({ settings: S(10, 8), requests: [full('2026-09-07', '2026-09-08'), part('2026-09-09', 4)] });
  const res = await request(makeApp()).get('/time-off/balance?year=2026');
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ annual_days: 10, used_days: 2.5, remaining_days: 7.5 });
});

test('weekends inside a full-day request are not charged (Fri–Mon = 2 days, was 4)', async () => {
  mockBalance({ settings: S(10, 8), requests: [full('2026-09-04', '2026-09-07')] });
  const res = await request(makeApp()).get('/time-off/balance?year=2026');
  expect(res.body).toEqual({ annual_days: 10, used_days: 2, remaining_days: 8 });
});

test('working days follow the Hours & Rules standard hours (Mon–Sat company)', async () => {
  const day = { start: '07:00', end: '16:00' };
  const hours_rules = JSON.stringify({ enabled: true, standardHours: { 1: day, 2: day, 3: day, 4: day, 5: day, 6: day } });
  mockBalance({ settings: [...S(10, 8), { key: 'hours_rules', value: hours_rules }], requests: [full('2026-09-04', '2026-09-07')] });
  const res = await request(makeApp()).get('/time-off/balance?year=2026');
  expect(res.body.used_days).toBe(3); // Fri + Sat + Mon
});

test('a request straddling New Year charges only the days inside the year', async () => {
  // Wed 2025-12-31 → Fri 2026-01-02: 2026 gets Thu + Fri
  mockBalance({ settings: S(10, 8), requests: [full('2025-12-31', '2026-01-02')] });
  const res = await request(makeApp()).get('/time-off/balance?year=2026');
  expect(res.body.used_days).toBe(2);
});

test('the query selects approved VACATION overlapping the year', async () => {
  mockBalance({ settings: S(10, 8) });
  await request(makeApp()).get('/time-off/balance?year=2026');
  expect(reqSql.sql).toMatch(/status = 'approved'/);
  expect(reqSql.sql).toMatch(/type = 'vacation'/);
  expect(reqSql.sql).toMatch(/start_date <= \$4::date AND end_date >= \$3::date/);
  expect(reqSql.params).toEqual([3, 'co-1', '2026-01-01', '2026-12-31']);
});

test('missing regular_shift_hours falls back to an 8h day (no divide-by-zero)', async () => {
  mockBalance({ settings: S(5, null), requests: [part('2026-09-09', 6)] });
  const res = await request(makeApp()).get('/time-off/balance?year=2026');
  expect(res.body.used_days).toBe(0.75); // 6 / 8
  expect(res.body.remaining_days).toBe(4.25);
});

test('a 0 regular_shift_hours setting also falls back to 8 (guarded)', async () => {
  mockBalance({ settings: S(5, 0), requests: [part('2026-09-09', 4)] });
  const res = await request(makeApp()).get('/time-off/balance?year=2026');
  expect(res.body.used_days).toBe(0.5); // 4 / 8, not NaN/Infinity
});

test('remaining never goes negative', async () => {
  mockBalance({ settings: S(2, 8), requests: [full('2026-09-07', '2026-09-11')] });
  const res = await request(makeApp()).get('/time-off/balance?year=2026');
  expect(res.body.used_days).toBe(5);
  expect(res.body.remaining_days).toBe(0);
});

test('an invalid year is a 400', async () => {
  mockBalance({});
  const res = await request(makeApp()).get('/time-off/balance?year=abc');
  expect(res.status).toBe(400);
});
