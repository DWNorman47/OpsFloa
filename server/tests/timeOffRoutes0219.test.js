/**
 * routes/timeOff — review fixes (0219):
 *   - overlapping pending/approved requests are refused on submit and on approve (409)
 *   - bad dates are a 400, not a Postgres 500
 *   - approve/deny/list/revoke need approve_entries and respect worker_access_ids
 *   - approving vacation past pto_annual_days → 409 with details unless confirm
 *   - admin revoke: approved → revoked with a reason, audit-logged, shifts un-flagged
 */
let mockCurrentUser;
jest.mock('../middleware/auth', () => ({
  requireAuth:  (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin: (req, res, next) => {
    req.user = mockCurrentUser;
    if (!['admin', 'super_admin'].includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  },
}));
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToCompanyAdmins: jest.fn() }));
jest.mock('../routes/inbox', () => ({ createInboxItem: jest.fn(), createInboxItemBatch: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const { logAudit } = require('../auditLog');
const timeOffRoute = require('../routes/timeOff');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: () => {} }; next(); });
  app.use('/time-off', timeOffRoute);
  return app;
}
const ADMIN = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Boss' };
const WORKER = { id: 5, company_id: 'co-1', role: 'worker', full_name: 'Wendy' };

// SQL-routed mock. `h` maps a regex source → handler(sql, params) → result.
let calls;
function route(handlers) {
  calls = [];
  pool.query.mockImplementation(async (sql, params) => {
    calls.push({ sql, params });
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(sql, params);
    return { rowCount: 0, rows: [] };
  });
}
const sqlCalls = re => calls.filter(c => re.test(c.sql));

beforeEach(() => { pool.query.mockReset(); logAudit.mockClear(); mockCurrentUser = ADMIN; });

describe('POST /time-off — overlap + date validation', () => {
  beforeEach(() => { mockCurrentUser = WORKER; });

  test('an overlapping pending/approved request → 409 overlap with the conflict', async () => {
    route([
      [/INSERT INTO time_off_requests/, () => ({ rowCount: 0, rows: [] })],
      [/SELECT id, type, status, start_date, end_date, hours FROM time_off_requests/, () => ({ rows: [{ id: 7, type: 'sick', status: 'approved', start_date: '2026-09-08', end_date: '2026-09-08', hours: null }] })],
    ]);
    const res = await request(makeApp()).post('/time-off').send({ type: 'vacation', start_date: '2026-09-08', end_date: '2026-09-09' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('overlap');
    expect(res.body.conflicts[0]).toMatchObject({ id: 7, status: 'approved' });
    const ins = sqlCalls(/INSERT INTO time_off_requests/)[0];
    expect(ins.sql).toMatch(/WHERE NOT EXISTS/);
    expect(ins.sql).toMatch(/status IN \('pending', 'approved'\)/);
  });

  test('no overlap → 201', async () => {
    route([[/INSERT INTO time_off_requests/, () => ({ rowCount: 1, rows: [{ id: 8 }] })]]);
    const res = await request(makeApp()).post('/time-off').send({ type: 'vacation', start_date: '2026-09-08', end_date: '2026-09-09' });
    expect(res.status).toBe(201);
  });

  test.each([['2026-02-30'], ['2026-9-1'], ['nope']])('invalid date %s → 400 (was a 500)', async (d) => {
    route([]);
    const res = await request(makeApp()).post('/time-off').send({ start_date: d, end_date: '2026-12-01' });
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

function pendingRow(over = {}) {
  return { id: 9, user_id: 5, type: 'vacation', status: 'pending', start_date: '2026-09-07', end_date: '2026-09-11', hours: null, ...over };
}

describe('PATCH /:id/approve', () => {
  test('an already-approved overlapping request → 409 overlap', async () => {
    route([
      [/SELECT \* FROM time_off_requests WHERE id/, () => ({ rows: [pendingRow({ type: 'sick' })] })],
      [/SELECT id, type, status, start_date, end_date, hours FROM time_off_requests/, (sql) => {
        expect(sql).toMatch(/status IN \('approved'\)/);
        return { rows: [{ id: 3, type: 'vacation', status: 'approved', start_date: '2026-09-08', end_date: '2026-09-08' }] };
      }],
    ]);
    const res = await request(makeApp()).patch('/time-off/9/approve').send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('overlap');
    expect(sqlCalls(/UPDATE time_off_requests/)).toHaveLength(0);
  });

  test('the UPDATE re-checks overlap (race-safe)', async () => {
    route([
      [/SELECT \* FROM time_off_requests WHERE id/, () => ({ rows: [pendingRow({ type: 'sick' })] })],
      [/UPDATE time_off_requests r SET status = 'approved'/, () => ({ rowCount: 0, rows: [] })],
    ]);
    const res = await request(makeApp()).patch('/time-off/9/approve').send({});
    expect(res.status).toBe(409);
    expect(sqlCalls(/UPDATE time_off_requests/)[0].sql).toMatch(/NOT EXISTS/);
  });

  const allowanceHandlers = (annual, usedRows) => [
    [/SELECT \* FROM time_off_requests WHERE id/, () => ({ rows: [pendingRow()] })],
    [/FROM settings/, () => ({ rows: [{ key: 'pto_annual_days', value: String(annual) }, { key: 'regular_shift_hours', value: '8' }] })],
    [/SELECT id, start_date, end_date, hours FROM time_off_requests/, () => ({ rows: usedRows })],
    [/UPDATE time_off_requests r SET status = 'approved'/, () => ({ rowCount: 1, rows: [pendingRow({ status: 'approved' })] })],
  ];

  test('exceeding the annual allowance → 409 with details', async () => {
    // 5 working days requested, 7 of 10 already used
    route(allowanceHandlers(10, [{ start_date: '2026-03-02', end_date: '2026-03-10', hours: null }]));
    const res = await request(makeApp()).patch('/time-off/9/approve').send({});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'exceeds_allowance', year: 2026, annual_days: 10, used_days: 7, request_days: 5, remaining_days: 3 });
    expect(sqlCalls(/UPDATE time_off_requests/)).toHaveLength(0);
  });

  test('…and approves with confirm:true, recording the override in the audit log', async () => {
    route(allowanceHandlers(10, [{ start_date: '2026-03-02', end_date: '2026-03-10', hours: null }]));
    const res = await request(makeApp()).patch('/time-off/9/approve').send({ confirm: true });
    expect(res.status).toBe(200);
    const meta = logAudit.mock.calls.find(c => c[3] === 'timeoff.approved')[7];
    expect(meta.allowance_override).toMatchObject({ used_days: 7, request_days: 5 });
  });

  test('within the allowance → approved without confirm', async () => {
    route(allowanceHandlers(10, []));
    const res = await request(makeApp()).patch('/time-off/9/approve').send({});
    expect(res.status).toBe(200);
  });
});

describe('permissions + worker scope', () => {
  test('an admin whose role lacks approve_entries → 403 on approve/deny/list/revoke', async () => {
    mockCurrentUser = { ...ADMIN, role_id: 44 };
    route([[/FROM role_permissions/, () => ({ rows: [{ permission: 'view_reports' }] })]]);
    for (const [m, p] of [['patch', '/time-off/9/approve'], ['patch', '/time-off/9/deny'], ['get', '/time-off'], ['patch', '/time-off/9/revoke']]) {
      const res = await request(makeApp())[m](p).send({ reason: 'x' });
      expect(res.status).toBe(403);
      expect(res.body.required).toBe('approve_entries');
    }
    expect(sqlCalls(/time_off_requests/)).toHaveLength(0);
  });

  test('a partial admin cannot approve / deny a worker outside their scope', async () => {
    mockCurrentUser = { ...ADMIN, worker_access_ids: [2, 3] };
    route([[/SELECT \* FROM time_off_requests WHERE id/, () => ({ rows: [pendingRow()] })]]);
    for (const a of ['approve', 'deny']) {
      const res = await request(makeApp()).patch(`/time-off/9/${a}`).send({});
      expect(res.status).toBe(403);
    }
    expect(sqlCalls(/UPDATE/)).toHaveLength(0);
  });

  test('the admin list is scoped to worker_access_ids', async () => {
    mockCurrentUser = { ...ADMIN, worker_access_ids: [2, 3] };
    route([[/FROM time_off_requests r/, () => ({ rows: [] })]]);
    await request(makeApp()).get('/time-off?status=pending');
    const q = sqlCalls(/FROM time_off_requests r/)[0];
    expect(q.sql).toMatch(/r\.user_id = ANY\(\$3::int\[\]\)/);
    expect(q.params).toEqual(['co-1', 'pending', [2, 3]]);
  });
});

describe('PATCH /:id/revoke', () => {
  const approved = () => pendingRow({ status: 'approved' });

  test('requires a reason', async () => {
    route([]);
    const res = await request(makeApp()).patch('/time-off/9/revoke').send({});
    expect(res.status).toBe(400);
  });

  test('only approved requests', async () => {
    route([[/SELECT \* FROM time_off_requests WHERE id/, () => ({ rows: [pendingRow()] })]]);
    const res = await request(makeApp()).patch('/time-off/9/revoke').send({ reason: 'changed plans' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_approved');
  });

  test('refused inside a locked pay period', async () => {
    route([
      [/SELECT \* FROM time_off_requests WHERE id/, () => ({ rows: [approved()] })],
      [/FROM pay_periods/, () => ({ rows: [{ period_start: '2026-09-01', period_end: '2026-09-15' }] })],
    ]);
    const res = await request(makeApp()).patch('/time-off/9/revoke').send({ reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('period_locked');
  });

  test('approved → revoked, audit-logged with the reason, the approval\'s shift flags reversed', async () => {
    route([
      [/SELECT \* FROM time_off_requests WHERE id/, () => ({ rows: [approved()] })],
      [/UPDATE time_off_requests\s+SET status = 'revoked'/, () => ({ rowCount: 1, rows: [{ ...approved(), status: 'revoked', revoke_reason: 'worker came in' }] })],
      [/UPDATE shifts s SET cant_make_it = false/, () => ({ rowCount: 2, rows: [{ id: 1 }, { id: 2 }] })],
    ]);
    const res = await request(makeApp()).patch('/time-off/9/revoke').send({ reason: 'worker came in' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'revoked', shifts_restored: 2 });
    const shiftSql = sqlCalls(/UPDATE shifts s/)[0];
    expect(shiftSql.sql).toMatch(/cant_make_it_note = 'Time off approved'/);
    expect(shiftSql.sql).toMatch(/NOT EXISTS/);
    expect(shiftSql.params).toEqual([5, 'co-1', '2026-09-07', '2026-09-11', 9]);
    const audit = logAudit.mock.calls.find(c => c[3] === 'timeoff.revoked');
    expect(audit[7]).toMatchObject({ reason: 'worker came in', shifts_restored: 2 });
  });
});

describe('countLeaveDays', () => {
  const { countLeaveDays } = timeOffRoute;
  const opts = { workDays: new Set([1, 2, 3, 4, 5]), dayHours: 8, from: '2026-01-01', to: '2026-12-31' };
  test('full days count working days only; partials as a fraction; clipped to the range', () => {
    expect(countLeaveDays([{ start_date: '2026-09-04', end_date: '2026-09-07', hours: null }], opts)).toBe(2);
    expect(countLeaveDays([{ start_date: '2026-09-04', end_date: '2026-09-04', hours: 2 }], opts)).toBe(0.25);
    expect(countLeaveDays([{ start_date: '2025-12-29', end_date: '2026-01-02', hours: null }], opts)).toBe(2);
  });
});
