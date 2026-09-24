/**
 * POST /time-entries/copy-last-week — a day with several entries last week (split
 * shift, two jobs) must copy ALL of them. The skip-if-day-has-entries check is
 * against the days that had entries BEFORE the copy, not days the copy itself
 * just filled (that used to copy only the first entry of each day).
 */

let mockUser;
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = mockUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToCompanyAdmins: jest.fn() }));
jest.mock('../routes/inbox', () => ({ createInboxItem: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../failureLog', () => ({ logFailure: jest.fn() }));
jest.mock('../utils/projectCost', () => ({ projectFrozen: jest.fn(async () => false) }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const timeEntries = require('../routes/timeEntries');
const { weekRange } = require('../utils/weekBounds');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: jest.fn() }; next(); });
  app.use('/api/time-entries', timeEntries);
  return app;
}

const lastWk = weekRange(1, -1);
const thisWk = weekRange(1, 0);
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };

function mockDb({ lastWeek, existingThisWeek = [] }) {
  pool.query.mockImplementation(async (sql, params) => {
    if (/key = 'week_start'/.test(sql)) return { rows: [{ value: '1' }] };
    if (/SELECT start_time, end_time, break_minutes, project_id/.test(sql)) return { rowCount: lastWeek.length, rows: lastWeek };
    if (/SELECT DISTINCT work_date FROM time_entries/.test(sql)) {
      return { rowCount: existingThisWeek.length, rows: existingThisWeek.map(d => ({ work_date: new Date(d + 'T00:00:00') })) };
    }
    if (/FROM pay_periods/.test(sql)) return { rowCount: 0, rows: [] };
    if (/SELECT wage_type FROM projects/.test(sql)) return { rowCount: 1, rows: [{ wage_type: 'regular' }] };
    if (/INSERT INTO time_entries/.test(sql)) return { rowCount: 1, rows: [{ id: Math.random(), work_date: params[2] }] };
    return { rowCount: 0, rows: [] };
  });
}
const inserts = () => pool.query.mock.calls.filter(c => /INSERT INTO time_entries/.test(c[0]));
const row = (dayOffset, start, end, project_id = 3) => ({
  start_time: start, end_time: end, break_minutes: 0, project_id, notes: null,
  wage_type: 'regular', work_date: new Date(addDays(lastWk.from, dayOffset) + 'T00:00:00'), timezone: 'America/Chicago',
});

beforeEach(() => {
  pool.query.mockReset();
  mockUser = { id: 7, company_id: 'co-1', full_name: 'Worker Seven', role: 'worker' };
});

test('copies every entry of a multi-entry day (split shift)', async () => {
  mockDb({ lastWeek: [row(0, '07:00', '11:00', 3), row(0, '12:00', '16:00', 4), row(1, '07:00', '15:00')] });
  const res = await request(makeApp()).post('/api/time-entries/copy-last-week');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ created: 3, skipped: 0 });
  const ins = inserts().map(c => [c[1][2], c[1][3]]);
  expect(ins).toEqual([
    [addDays(thisWk.from, 0), '07:00'],
    [addDays(thisWk.from, 0), '12:00'],
    [addDays(thisWk.from, 1), '07:00'],
  ]);
});

test('still skips days that already had entries before the copy', async () => {
  mockDb({
    lastWeek: [row(0, '07:00', '11:00'), row(0, '12:00', '16:00'), row(1, '07:00', '15:00')],
    existingThisWeek: [addDays(thisWk.from, 0)],
  });
  const res = await request(makeApp()).post('/api/time-entries/copy-last-week');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ created: 1, skipped: 2 });
  expect(inserts()[0][1][2]).toBe(addDays(thisWk.from, 1));
});
