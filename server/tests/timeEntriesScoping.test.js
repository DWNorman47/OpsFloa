/**
 * Worker time-entry integrity:
 *  - DELETE honors the same self-service guards as PATCH (company edit toggle + 7-day window);
 *    admins deleting their own entries are unaffected.
 *  - copy-last-week applies the create-time checks (project in company, not frozen) plus the
 *    locked-pay-period check, and records the copies as manual entries (clock_source log_entry,
 *    status pending).
 *  - GET / with no range defaults to the last 90 days; ?all=1 keeps the unbounded history.
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
const { projectFrozen } = require('../utils/projectCost');
const timeEntries = require('../routes/timeEntries');
const { weekRange } = require('../utils/weekBounds');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: jest.fn() }; next(); });
  app.use('/api/time-entries', timeEntries);
  return app;
}

const isoDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString('en-CA'); };

beforeEach(() => {
  jest.clearAllMocks();
  pool.query.mockReset();
  projectFrozen.mockResolvedValue(false);
  mockUser = { id: 7, company_id: 'co-1', full_name: 'Worker Seven', role: 'worker' };
});

describe('DELETE /time-entries/:id', () => {
  function mockDb({ editAllowed = true, workDate = isoDaysAgo(1) } = {}) {
    pool.query.mockImplementation(async (sql) => {
      if (/feature_worker_edit_time/.test(sql)) {
        return { rows: editAllowed ? [] : [{ key: 'feature_worker_edit_time', value: 'false' }] };
      }
      if (/SELECT work_date, locked, project_id FROM time_entries/.test(sql)) {
        return { rowCount: 1, rows: [{ work_date: new Date(workDate + 'T00:00:00'), locked: false, project_id: 3 }] };
      }
      if (/FROM pay_periods/.test(sql)) return { rowCount: 0, rows: [] };
      if (/DELETE FROM time_entries/.test(sql)) return { rowCount: 1, rows: [{ id: 5, work_date: workDate }] };
      return { rowCount: 0, rows: [] };
    });
  }
  const deleted = () => pool.query.mock.calls.some(c => /DELETE FROM time_entries/.test(c[0]));

  test('worker is blocked when the company disabled self-editing', async () => {
    mockDb({ editAllowed: false });
    const res = await request(makeApp()).delete('/api/time-entries/5');
    expect(res.status).toBe(403);
    expect(deleted()).toBe(false);
  });

  test('worker cannot delete an entry older than 7 days', async () => {
    mockDb({ workDate: isoDaysAgo(20) });
    const res = await request(makeApp()).delete('/api/time-entries/5');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/older than 7 days/);
    expect(deleted()).toBe(false);
  });

  test('worker can delete a recent entry when editing is allowed', async () => {
    mockDb();
    const res = await request(makeApp()).delete('/api/time-entries/5');
    expect(res.status).toBe(200);
    expect(deleted()).toBe(true);
  });

  test('admin is unaffected by the toggle and the 7-day window', async () => {
    mockUser = { ...mockUser, role: 'admin' };
    mockDb({ editAllowed: false, workDate: isoDaysAgo(30) });
    const res = await request(makeApp()).delete('/api/time-entries/5');
    expect(res.status).toBe(200);
    expect(deleted()).toBe(true);
    expect(pool.query.mock.calls.some(c => /feature_worker_edit_time/.test(c[0]))).toBe(false);
  });
});

describe('POST /time-entries/copy-last-week', () => {
  const lastWk = weekRange(1, -1);
  const thisWk = weekRange(1, 0);
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('en-CA'); };

  function mockDb({ lastWeek, lockedPeriods = [], projects = { 3: 'regular' } }) {
    pool.query.mockImplementation(async (sql, params) => {
      if (/key = 'week_start'/.test(sql)) return { rows: [{ value: '1' }] };
      if (/SELECT start_time, end_time, break_minutes, project_id/.test(sql)) return { rowCount: lastWeek.length, rows: lastWeek };
      if (/SELECT DISTINCT work_date FROM time_entries/.test(sql)) return { rowCount: 0, rows: [] };
      if (/FROM pay_periods/.test(sql)) return { rowCount: lockedPeriods.length, rows: lockedPeriods };
      if (/SELECT wage_type FROM projects WHERE id = \$1 AND company_id = \$2/.test(sql)) {
        const wt = projects[params[0]];
        return wt ? { rowCount: 1, rows: [{ wage_type: wt }] } : { rowCount: 0, rows: [] };
      }
      if (/INSERT INTO time_entries/.test(sql)) return { rowCount: 1, rows: [{ id: 100 + params[2].length, work_date: params[2] }] };
      return { rowCount: 0, rows: [] };
    });
  }
  const inserts = () => pool.query.mock.calls.filter(c => /INSERT INTO time_entries/.test(c[0]));
  const row = (dayOffset, project_id = 3) => ({
    start_time: '07:00', end_time: '15:00', break_minutes: 30, project_id, notes: null,
    wage_type: 'regular', work_date: new Date(addDays(lastWk.from, dayOffset) + 'T00:00:00'), timezone: 'America/Chicago',
  });

  test('copies are manual entries: clock_source log_entry, status pending', async () => {
    mockDb({ lastWeek: [row(0)] });
    const res = await request(makeApp()).post('/api/time-entries/copy-last-week');
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    const [sql, params] = inserts()[0];
    expect(sql).toMatch(/clock_source/);
    expect(sql).toMatch(/'pending',\$12,'log_entry'/);
    expect(sql).not.toMatch(/'submitted'/);
    expect(params[2]).toBe(addDays(thisWk.from, 0));
  });

  test('skips days that fall in a locked pay period', async () => {
    mockDb({
      lastWeek: [row(0), row(1)],
      lockedPeriods: [{ period_start: new Date(thisWk.from + 'T00:00:00'), period_end: new Date(thisWk.from + 'T00:00:00') }],
    });
    const res = await request(makeApp()).post('/api/time-entries/copy-last-week');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, skipped: 1 });
    expect(inserts()[0][1][2]).toBe(addDays(thisWk.from, 1));
  });

  test('skips entries on a frozen (closed-out) project or one outside the company', async () => {
    projectFrozen.mockImplementation(async (pid) => pid === 4);
    mockDb({ lastWeek: [row(0, 3), row(1, 4), row(2, 99)], projects: { 3: 'regular', 4: 'regular' } });
    const res = await request(makeApp()).post('/api/time-entries/copy-last-week');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, skipped: 2 });
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0][1][8]).toBe(3);
  });
});

describe('GET /time-entries default window', () => {
  function mockDb() {
    pool.query.mockImplementation(async (sql) => {
      if (/FROM companies/.test(sql)) return { rows: [{ plan: 'business', subscription_status: 'active' }] };
      return { rowCount: 0, rows: [] };
    });
  }
  const listSql = () => pool.query.mock.calls.find(c => /FROM time_entries te/.test(c[0]));

  test('no range → last 90 days only', async () => {
    mockDb();
    const res = await request(makeApp()).get('/api/time-entries');
    expect(res.status).toBe(200);
    const [sql, params] = listSql();
    expect(sql).toMatch(/te\.work_date >= CURRENT_DATE - INTERVAL '90 days'/);
    expect(params).toEqual([7]);
  });

  test('?all=1 keeps the unbounded history', async () => {
    mockDb();
    const res = await request(makeApp()).get('/api/time-entries?all=1');
    expect(res.status).toBe(200);
    expect(listSql()[0]).not.toMatch(/INTERVAL/);
  });

  test('an explicit range is used as-is', async () => {
    mockDb();
    await request(makeApp()).get('/api/time-entries?from=2026-01-01&to=2026-01-31');
    const [sql, params] = listSql();
    expect(sql).toMatch(/BETWEEN \$2 AND \$3/);
    expect(sql).not.toMatch(/INTERVAL '90 days'/);
    expect(params).toEqual([7, '2026-01-01', '2026-01-31']);
  });
});
