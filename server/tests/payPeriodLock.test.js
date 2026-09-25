/**
 * Pay-period locks — one helper (utils/payPeriodLock.assertNotLocked) enforced on
 * every write path that changes paid time for a date:
 *   - worker POST /time-entries
 *   - admin /entries/:id/times (+ approved-entry guard), /edit (source + destination,
 *     no OR-precedence bug), /split, admin-added entries, admin mark-day
 *   - approve / bulk-approve / approve-all carry the lock predicate INSIDE the UPDATE
 *   - reject (status guard: an approved entry needs unapprove first), unapprove, unlock
 *   - admin clock-out into a locked period keeps the shift (created, flagged)
 *   - the approvals queue flags entries sitting in a locked period
 */

let mockCurrentUser;
jest.mock('../middleware/auth', () => ({
  requireAuth:      (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin:     (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePermission: () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePerm:      () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePlan:      () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireProAddon:  (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireCertifiedPayrollAddon: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  hasAdminPermission: () => true,
  requireSuperAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToAllWorkers: jest.fn(), sendPushToCompanyAdmins: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../services/qbo', () => ({}));
jest.mock('../routes/inbox', () => ({ createInboxItem: jest.fn(), createInboxItemBatch: jest.fn() }));
jest.mock('../failureLog', () => ({ logFailure: jest.fn() }));
jest.mock('../utils/projectCost', () => ({ projectFrozen: jest.fn(async () => false) }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const adminRoute = require('../routes/admin');
const timeEntriesRoute = require('../routes/timeEntries');
const lock = require('../utils/payPeriodLock');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: () => {}, warn: () => {} }; next(); });
  app.use('/api/admin', adminRoute);
  app.use('/api/time-entries', timeEntriesRoute);
  return app;
}

const LOCK_RE = /FROM pay_periods pp\s+WHERE pp\.company_id = \$1\s+AND EXISTS \(SELECT 1 FROM unnest/;
const PERIOD = { id: 5, period_start: '2026-09-01', period_end: '2026-09-15', label: 'Sep A' };

// Shape-routed mock: handlers [[regex, fn]]; the lock query answers from `lockedDates`.
function mockDb(handlers = [], { lockedDates = [] } = {}) {
  const answer = async (sql, params) => {
    if (LOCK_RE.test(sql)) {
      const hit = (params[1] || []).some(d => lockedDates.includes(d));
      return hit ? { rowCount: 1, rows: [PERIOD] } : { rowCount: 0, rows: [] };
    }
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(sql, params);
    return { rowCount: 0, rows: [] };
  };
  pool.query.mockImplementation(answer);
  const client = { query: jest.fn(answer), release: jest.fn() };
  pool.connect.mockResolvedValue(client);
  return client;
}
const allSql = () => [
  ...pool.query.mock.calls.map(c => c[0]),
];
const ran = (re) => allSql().some(s => re.test(s));

beforeEach(() => {
  pool.query.mockReset();
  pool.connect.mockReset();
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Admin', worker_access_ids: null };
});

// ─── helper ────────────────────────────────────────────────────────────────
describe('utils/payPeriodLock', () => {
  test('no dates → no query, nothing locked', async () => {
    const db = { query: jest.fn() };
    expect(await lock.lockedPeriodsCovering(db, 'co-1', [])).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('normalizes pg DATE objects (local midnight) and strings, dedups, ONE query', async () => {
    const db = { query: jest.fn(async () => ({ rows: [] })) };
    await lock.lockedPeriodsCovering(db, 'co-1', [new Date(2026, 8, 3), '2026-09-03', '2026-09-04T00:00:00Z', null]);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][1]).toEqual(['co-1', ['2026-09-03', '2026-09-04']]);
  });

  test('assertNotLocked throws a 409 period_locked error listing the periods', async () => {
    const db = { query: jest.fn(async () => ({ rows: [{ id: 5, period_start: new Date(2026, 8, 1), period_end: new Date(2026, 8, 15), label: null }] })) };
    await expect(lock.assertNotLocked(db, 'co-1', 7, ['2026-09-03'])).rejects.toMatchObject({
      status: 409,
      body: { code: 'period_locked', periods: [{ id: 5, period_start: '2026-09-01', period_end: '2026-09-15', label: null }] },
    });
  });

  test('assertNotLocked resolves when nothing is locked', async () => {
    const db = { query: jest.fn(async () => ({ rows: [] })) };
    await expect(lock.assertNotLocked(db, 'co-1', 7, ['2026-09-03'])).resolves.toBeUndefined();
  });
});

// ─── worker POST /time-entries ─────────────────────────────────────────────
describe('POST /time-entries (worker manual entry)', () => {
  const body = { project_id: 3, work_date: '2026-09-03', start_time: '07:00', end_time: '15:00' };
  const handlers = [
    [/FROM companies/, () => ({ rows: [{ plan: 'business', subscription_status: 'active' }] })],
    [/SELECT wage_type FROM projects/, () => ({ rowCount: 1, rows: [{ wage_type: 'regular' }] })],
    [/INSERT INTO time_entries/, () => ({ rowCount: 1, rows: [{ id: 9 }] })],
  ];
  beforeEach(() => { mockCurrentUser = { id: 7, company_id: 'co-1', role: 'worker', full_name: 'W' }; });

  test('409 period_locked and no insert when the date is in a locked period', async () => {
    mockDb(handlers, { lockedDates: ['2026-09-03'] });
    const res = await request(makeApp()).post('/api/time-entries').send(body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('period_locked');
    expect(res.body.periods).toHaveLength(1);
    expect(ran(/INSERT INTO time_entries/)).toBe(false);
  });

  test('unlocked date inserts normally', async () => {
    mockDb(handlers);
    const res = await request(makeApp()).post('/api/time-entries').send(body);
    expect(res.status).toBe(201);
  });
});

// ─── admin edit paths ──────────────────────────────────────────────────────
describe('PATCH /admin/entries/:id/times', () => {
  const entry = (over = {}) => ({ work_date: '2026-09-03', timezone: 'UTC', status: 'pending', locked: false, ...over });

  test('409 period_locked in a locked period', async () => {
    mockDb([[/FROM time_entries WHERE id = \$1/, () => ({ rowCount: 1, rows: [entry()] })]], { lockedDates: ['2026-09-03'] });
    const res = await request(makeApp()).patch('/api/admin/entries/4/times').send({ start_time: '07:00', end_time: '15:00' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('period_locked');
    expect(ran(/UPDATE time_entries/)).toBe(false);
  });

  test('refuses to edit an approved entry', async () => {
    mockDb([[/FROM time_entries WHERE id = \$1/, () => ({ rowCount: 1, rows: [entry({ status: 'approved', locked: true })] })]]);
    const res = await request(makeApp()).patch('/api/admin/entries/4/times').send({ start_time: '07:00', end_time: '15:00' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('entry_approved');
    expect(ran(/UPDATE time_entries/)).toBe(false);
  });
});

describe('PATCH /admin/entries/:id/edit', () => {
  const row = { updated_at: new Date('2026-09-03T10:00:00Z'), work_date: '2026-09-03', timezone: 'UTC' };
  const handlers = [
    [/SELECT updated_at, work_date, timezone FROM time_entries/, () => ({ rows: [row] })],
    [/UPDATE time_entries/, () => ({ rowCount: 1, rows: [{ id: 42 }] })],
    [/SELECT te\.\*/, () => ({ rows: [{ id: 42 }] })],
  ];

  test('source date locked → 409 even without a date move', async () => {
    mockDb(handlers, { lockedDates: ['2026-09-03'] });
    const res = await request(makeApp()).patch('/api/admin/entries/42/edit').send({ start_time: '08:00', end_time: '16:00' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('period_locked');
    expect(ran(/UPDATE time_entries/)).toBe(false);
  });

  test('destination date locked → 409', async () => {
    mockDb(handlers, { lockedDates: ['2026-09-10'] });
    const res = await request(makeApp()).patch('/api/admin/entries/42/edit').send({ start_time: '08:00', end_time: '16:00', work_date: '2026-09-10' });
    expect(res.status).toBe(409);
    expect(ran(/UPDATE time_entries/)).toBe(false);
  });

  test('checks BOTH dates in one company-scoped query (no `A AND B OR C` precedence leak)', async () => {
    mockDb(handlers);
    const res = await request(makeApp()).patch('/api/admin/entries/42/edit').send({ start_time: '08:00', end_time: '16:00', work_date: '2026-09-10' });
    expect(res.status).toBe(200);
    const call = pool.query.mock.calls.find(c => LOCK_RE.test(c[0]));
    expect(call[1]).toEqual(['co-1', ['2026-09-03', '2026-09-10']]);
    expect(allSql().some(s => /\)\s*OR\s*\(period_start/.test(s))).toBe(false);
  });
});

describe('POST /admin/entries/:id/split', () => {
  test('409 period_locked, original untouched', async () => {
    const client = mockDb([[/SELECT \* FROM time_entries WHERE id=\$1/, () => ({ rowCount: 1, rows: [{ id: 4, user_id: 7, work_date: '2026-09-03', timezone: 'UTC' }] })]],
      { lockedDates: ['2026-09-03'] });
    const res = await request(makeApp()).post('/api/admin/entries/4/split').send({
      segments: [{ start_time: '07:00', end_time: '11:00' }, { start_time: '11:00', end_time: '15:00' }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('period_locked');
    expect(client.query.mock.calls.some(c => /DELETE FROM time_entries/.test(c[0]))).toBe(false);
  });
});

describe('admin-created entries', () => {
  test('POST /admin/workers/:id/entries → 409 in a locked period', async () => {
    mockDb([[/SELECT id, timezone FROM users/, () => ({ rowCount: 1, rows: [{ id: 7, timezone: 'UTC' }] })]], { lockedDates: ['2026-09-03'] });
    const res = await request(makeApp()).post('/api/admin/workers/7/entries').send({ work_date: '2026-09-03', start_time: '07:00', end_time: '15:00' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('period_locked');
    expect(ran(/INSERT INTO time_entries/)).toBe(false);
  });

  test('POST /admin/mark-day → 409 in a locked period', async () => {
    mockDb([[/FROM users WHERE id = \$1 AND company_id = \$2 AND active = true/, () => ({ rowCount: 1, rows: [{ id: 7, rate_type: 'daily', day_mark_mode: true, timezone: 'UTC' }] })]],
      { lockedDates: ['2026-09-03'] });
    const res = await request(makeApp()).post('/api/admin/mark-day').send({ user_id: 7, local_work_date: '2026-09-03' });
    expect(res.status).toBe(409);
    expect(ran(/INSERT INTO time_entries/)).toBe(false);
  });

  test('POST /admin/clock-out/:user_id into a locked period keeps the shift, flagged', async () => {
    const client = mockDb([
      [/FROM active_clock ac/, () => ({ rowCount: 1, rows: [{ user_id: 7, company_id: 'co-1', project_id: null, clock_in_time: new Date(Date.now() - 3600e3), work_date: '2026-09-03', timezone: 'UTC', clock_source: 'worker', clocked_in_by: null }] })],
      [/INSERT INTO time_entries/, () => ({ rowCount: 1, rows: [{ id: 77, status: 'pending' }] })],
    ], { lockedDates: ['2026-09-03'] });
    const res = await request(makeApp()).post('/api/admin/clock-out/7').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 77, locked_period: true });
    expect(client.query.mock.calls.some(c => /INSERT INTO time_entries/.test(c[0]))).toBe(true);
  });
});

// ─── approvals ─────────────────────────────────────────────────────────────
describe('approvals carry the lock inside the UPDATE', () => {
  const PRED = /NOT EXISTS \(SELECT 1 FROM pay_periods pp_lock/;

  test('PATCH /approve: predicate in the UPDATE; blocked by a lock → 409 period_locked', async () => {
    mockDb([
      [/UPDATE time_entries SET status = 'approved'/, () => ({ rowCount: 0, rows: [] })],
      [/SELECT id, status, end_ts, work_date FROM time_entries/, () => ({ rows: [{ id: 4, status: 'pending', end_ts: new Date(Date.now() - 3600e3), work_date: '2026-09-03' }] })],
    ], { lockedDates: ['2026-09-03'] });
    const res = await request(makeApp()).patch('/api/admin/entries/4/approve').send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('period_locked');
    const upd = allSql().find(s => /UPDATE time_entries SET status = 'approved'/.test(s));
    expect(upd).toMatch(PRED);
  });

  test('POST /bulk-approve: predicate in the UPDATE and the skipped count is reported', async () => {
    mockDb([
      [/SELECT COUNT\(\*\)::int AS count/, () => ({ rows: [{ count: 0 }] })],
      [/UPDATE time_entries SET status = 'approved'/, () => ({ rowCount: 1, rows: [{ id: 1, user_id: 7, work_date: '2026-09-20' }] })],
      [/AS locked_count/, () => ({ rows: [{ locked_count: 1 }] })],
    ]);
    const res = await request(makeApp()).post('/api/admin/entries/bulk-approve').send({ ids: [1, 2] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approved: 1, skipped_locked: 1 });
    expect(allSql().find(s => /UPDATE time_entries SET status = 'approved'/.test(s))).toMatch(PRED);
  });

  test('POST /bulk-approve with every entry locked → 409 period_locked', async () => {
    mockDb([
      [/SELECT COUNT\(\*\)::int AS count/, () => ({ rows: [{ count: 0 }] })],
      [/UPDATE time_entries SET status = 'approved'/, () => ({ rowCount: 0, rows: [] })],
      [/AS locked_count/, () => ({ rows: [{ locked_count: 2 }] })],
    ]);
    const res = await request(makeApp()).post('/api/admin/entries/bulk-approve').send({ ids: [1, 2] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('period_locked');
  });

  test('POST /approve-all: predicate in the UPDATE', async () => {
    mockDb([
      [/UPDATE time_entries SET status = 'approved'/, () => ({ rowCount: 3, rows: [] })],
      [/AS locked_count/, () => ({ rows: [{ locked_count: 2 }] })],
    ]);
    const res = await request(makeApp()).post('/api/admin/entries/approve-all').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approved: 3, skipped_locked: 2 });
    expect(allSql().find(s => /UPDATE time_entries SET status = 'approved'/.test(s))).toMatch(PRED);
  });
});

describe('reject / unapprove / unlock', () => {
  const entry = (over = {}) => ({ id: 4, user_id: 7, status: 'pending', work_date: '2026-09-03', qbo_activity_id: null, ...over });

  test('reject: an approved entry needs an explicit unapprove first', async () => {
    mockDb([[/SELECT id, user_id, status, work_date, qbo_activity_id FROM time_entries/, () => ({ rowCount: 1, rows: [entry({ status: 'approved' })] })]]);
    const res = await request(makeApp()).patch('/api/admin/entries/4/reject').send({ note: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('entry_approved');
    expect(ran(/SET status = 'rejected'/)).toBe(false);
  });

  test('reject: 409 period_locked', async () => {
    mockDb([[/SELECT id, user_id, status, work_date, qbo_activity_id FROM time_entries/, () => ({ rowCount: 1, rows: [entry()] })]], { lockedDates: ['2026-09-03'] });
    const res = await request(makeApp()).patch('/api/admin/entries/4/reject').send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('period_locked');
    expect(ran(/SET status = 'rejected'/)).toBe(false);
  });

  test('reject: the UPDATE only moves pending entries (race guard)', async () => {
    mockDb([
      [/SELECT id, user_id, status, work_date, qbo_activity_id FROM time_entries/, () => ({ rowCount: 1, rows: [entry()] })],
      [/SET status = 'rejected'/, () => ({ rowCount: 1, rows: [entry({ status: 'rejected' })] })],
      [/SELECT email, full_name FROM users/, () => ({ rows: [] })],
    ]);
    const res = await request(makeApp()).patch('/api/admin/entries/4/reject').send({});
    expect(res.status).toBe(200);
    expect(allSql().find(s => /SET status = 'rejected'/.test(s))).toMatch(/status = 'pending'/);
  });

  test('unapprove: 409 period_locked', async () => {
    mockDb([[/SELECT qbo_activity_id, work_date FROM time_entries/, () => ({ rowCount: 1, rows: [{ qbo_activity_id: null, work_date: '2026-09-03' }] })]], { lockedDates: ['2026-09-03'] });
    const res = await request(makeApp()).patch('/api/admin/entries/4/unapprove').send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('period_locked');
    expect(ran(/SET status = 'pending', locked = false/)).toBe(false);
  });

  test('unlock: 409 period_locked', async () => {
    mockDb([[/SELECT work_date FROM time_entries WHERE id = \$1/, () => ({ rowCount: 1, rows: [{ work_date: '2026-09-03' }] })]], { lockedDates: ['2026-09-03'] });
    const res = await request(makeApp()).patch('/api/admin/entries/4/unlock').send({});
    expect(res.status).toBe(409);
    expect(ran(/SET locked = false/)).toBe(false);
  });
});

describe('GET /admin/entries/pending flags entries in a locked period', () => {
  test('selects in_locked_period', async () => {
    mockDb([[/FROM time_entries te/, () => ({ rows: [] })]]);
    await request(makeApp()).get('/api/admin/entries/pending');
    expect(allSql().find(s => /FROM time_entries te/.test(s))).toMatch(/AS in_locked_period/);
  });
});

describe('worker PATCH / DELETE /time-entries/:id use the shared lock (409 period_locked)', () => {
  const recent = () => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toLocaleDateString('en-CA'); };
  beforeEach(() => { mockCurrentUser = { id: 7, company_id: 'co-1', role: 'worker', full_name: 'W' }; });

  test('PATCH', async () => {
    const wd = recent();
    mockDb([[/SELECT \* FROM time_entries WHERE id = \$1 AND user_id = \$2/, () => ({ rowCount: 1, rows: [{ id: 4, work_date: new Date(wd + 'T00:00:00'), locked: false, project_id: 3, timezone: 'UTC' }] })]],
      { lockedDates: [wd] });
    const res = await request(makeApp()).patch('/api/time-entries/4').send({ start_time: '07:00', end_time: '15:00' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('period_locked');
    expect(ran(/UPDATE time_entries/)).toBe(false);
  });

  test('DELETE', async () => {
    const wd = recent();
    mockDb([[/SELECT work_date, locked, project_id FROM time_entries/, () => ({ rowCount: 1, rows: [{ work_date: new Date(wd + 'T00:00:00'), locked: false, project_id: 3 }] })]],
      { lockedDates: [wd] });
    const res = await request(makeApp()).delete('/api/time-entries/4');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('period_locked');
    expect(ran(/DELETE FROM time_entries/)).toBe(false);
  });
});
