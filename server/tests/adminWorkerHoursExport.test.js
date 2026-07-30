/**
 * Tests for GET /admin/export/worker-hours — the per-worker approved-hours CSV
 * summary. Verifies the Regular/OT/Total math (Regular = Total − OT), the
 * totals row, the 400 guard, and worker_access_ids scoping.
 */

let mockCurrentUser;

jest.mock('../middleware/auth', () => ({
  requireAuth:  (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePerm:  () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePlan:  () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireProAddon: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireCertifiedPayrollAddon: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  hasAdminPermission: () => true,
  requireSuperAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));
jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToAllWorkers: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../services/qbo', () => ({}));
jest.mock('../routes/inbox', () => ({ createInboxItem: jest.fn(), createInboxItemBatch: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const adminRoute = require('../routes/admin');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoute);
  return app;
}
function setUser(over = {}) {
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Test Admin', worker_access_ids: null, ...over };
}

beforeEach(() => { pool.query.mockReset(); setUser(); });

describe('GET /admin/export/worker-hours', () => {
  test('400 when from/to are missing', async () => {
    const res = await request(makeApp()).get('/api/admin/export/worker-hours');
    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('computes Regular/OT/Total + days per worker (approved, daily OT@8)', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ key: 'overtime_threshold', value: '8' }] }) // getSettings
      .mockResolvedValueOnce({ rows: [{ id: 5, full_name: 'Alex Rivera', invoice_name: null, overtime_rule: 'daily' }] }) // workers
      .mockResolvedValueOnce({ rows: [ // approved entries
        { user_id: 5, wage_type: 'regular', start_time: '08:00', end_time: '18:00', work_date: '2026-06-01', break_minutes: 0 }, // 10h → 8 reg + 2 OT
        { user_id: 5, wage_type: 'regular', start_time: '08:00', end_time: '14:00', work_date: '2026-06-02', break_minutes: 0 }, // 6h → 6 reg
      ] });

    const res = await request(makeApp()).get('/api/admin/export/worker-hours?from=2026-06-01&to=2026-06-30');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.split(/\r?\n/);
    expect(lines[0]).toBe('Worker,Regular Hrs,OT Hrs,Total Hrs,Days Worked');
    expect(lines).toContain('"Alex Rivera",14.00,2.00,16.00,2');
    expect(lines[lines.length - 1]).toBe('"TOTAL",14.00,2.00,16.00,2');
    // approved-only filter present
    expect(pool.query.mock.calls[2][0]).toMatch(/status = 'approved'/);
  });

  test('honors worker_access_ids scope in both queries', async () => {
    setUser({ worker_access_ids: [5, 6] });
    pool.query
      .mockResolvedValueOnce({ rows: [] })  // settings
      .mockResolvedValueOnce({ rows: [] })  // workers
      .mockResolvedValueOnce({ rows: [] }); // entries
    const res = await request(makeApp()).get('/api/admin/export/worker-hours?from=2026-06-01&to=2026-06-30');
    expect(res.status).toBe(200);
    const [workersSql, workersParams] = pool.query.mock.calls[1];
    const [entriesSql, entriesParams] = pool.query.mock.calls[2];
    expect(workersSql).toMatch(/id = ANY\(/);
    expect(entriesSql).toMatch(/user_id = ANY\(/);
    expect(workersParams).toContainEqual([5, 6]);
    expect(entriesParams).toContainEqual([5, 6]);
  });
});

describe('GET /admin/certified-payroll classification attribution', () => {
  test('emits separate rows when one worker performs multiple classifications', async () => {
    const base = {
      user_id: 5,
      project_id: 10,
      worker_name: 'Alex Rivera',
      hourly_rate: '30',
      rate_type: 'hourly',
      classification: 'Laborer',
      role_id: 4,
      overtime_rule: 'daily',
      start_time: '08:00',
      end_time: '12:00',
      break_minutes: 0,
      wage_type: 'regular',
      overtime_hours_override: null,
      project_prevailing_wage_rate: null,
    };
    pool.query
      .mockResolvedValueOnce({ rows: [{ name: 'Builder Co' }] })
      .mockResolvedValueOnce({ rows: [
        { ...base, work_date: '2026-07-20', entry_classification: 'Operator' },
        { ...base, work_date: '2026-07-21', entry_classification: 'Laborer' },
      ] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp())
      .get('/api/admin/certified-payroll?week_end=2026-07-26');

    expect(res.status).toBe(200);
    expect(res.body.workers).toHaveLength(2);
    expect(res.body.workers.map(row => row.classification).sort()).toEqual(['Laborer', 'Operator']);
    expect(res.body.workers.reduce((sum, row) => sum + row.total, 0)).toBe(8);
    expect(new Set(res.body.workers.map(row => row.worker_key)).size).toBe(2);
  });
});

describe('PATCH /admin/workers/:id/permissions', () => {
  test('refuses legacy permission edits for a role-backed admin', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ '?column?': 1 }] });

    const res = await request(makeApp())
      .patch('/api/admin/workers/9/permissions')
      .send({ admin_permissions: { view_reports: false } });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('role_managed_permissions');
    expect(pool.query.mock.calls[0][0]).toContain('role_id IS NULL');
  });
});

describe('payroll date validation', () => {
  test.each([
    '/api/admin/payroll-run?from=not-a-date&to=2026-06-30',
    '/api/admin/payroll-run?from=2026-07-01&to=2026-06-30',
    '/api/admin/payroll-export?from=2026-02-30&to=2026-03-01',
    '/api/admin/overtime-report?from=2026-07-01&to=2026-06-30',
    '/api/admin/certified-payroll?week_end=2026-02-30',
  ])('rejects invalid dates before querying the database: %s', async path => {
    const res = await request(makeApp()).get(path);
    expect(res.status).toBe(400);
    expect(res.body.code).toMatch(/^invalid_date/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('finalize rejects an invalid range before computing payroll', async () => {
    const res = await request(makeApp())
      .post('/api/admin/payroll-run/finalize')
      .send({ from: '2026-07-01', to: '2026-06-30' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_date_range');
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('finalize rejects a run when no paycheck rulesets are configured', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // settings
      .mockResolvedValueOnce({ rows: [] }) // workers
      .mockResolvedValueOnce({ rows: [] }); // worker deductions

    const res = await request(makeApp())
      .post('/api/admin/payroll-run/finalize')
      .send({ from: '2026-07-01', to: '2026-07-31' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ruleset_required');
    expect(res.body.error).toMatch(/Configure a paycheck ruleset/);
  });

  test.each([
    '/api/admin/payroll-run?from=2020-01-01&to=2026-06-30',
    '/api/admin/payroll-export?from=2020-01-01&to=2026-06-30',
    '/api/admin/overtime-report?from=2020-01-01&to=2026-06-30',
  ])('rejects excessive payroll/report ranges: %s', async path => {
    const res = await request(makeApp()).get(path);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('date_range_too_large');
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('payroll settings optimistic concurrency', () => {
  test('rejects a stale deduction-policy save instead of overwriting another admin', async () => {
    const current = '{"version":1,"items":[{"id":"new","name":"New","kind":"fixed","value":10}]}';
    const stale = '{"version":1,"items":[]}';
    pool.query
      .mockResolvedValueOnce({ rows: [{ key: 'deductions', value: current }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(makeApp())
      .patch('/api/admin/settings')
      .send({
        deductions: '{"version":1,"items":[{"id":"mine","name":"Mine","kind":"fixed","value":5}]}',
        expected_settings: { deductions: stale },
      });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'settings_conflict', key: 'deductions' });
    expect(pool.query.mock.calls[1][0]).toMatch(/WHERE settings\.value = \$4/);
  });

  test('rejects a mixed CAS batch before any partial setting can be written', async () => {
    const res = await request(makeApp())
      .patch('/api/admin/settings')
      .send({
        deductions: '{"version":1,"items":[]}',
        overtime_threshold: 9,
        expected_settings: { deductions: '' },
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_settings_batch');
    expect(pool.query).not.toHaveBeenCalled();
  });
});
