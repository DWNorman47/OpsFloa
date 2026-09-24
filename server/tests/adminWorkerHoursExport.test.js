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

  // The export prices hours through the SAME loader as payroll (companyStatements):
  // SQL-dispatching fake, date-filtered by the query's own bounds.
  function mockExportDb({ settings = [], workers = [], entries = [] }) {
    pool.query.mockImplementation(async (sql, p = []) => {
      if (/FROM settings/.test(sql)) return { rows: settings };
      if (/FROM users/.test(sql)) return { rows: workers };
      if (/FROM time_entries/.test(sql) && /start_time/.test(sql)) {
        return { rows: entries.filter(e => e.work_date >= p[1] && e.work_date <= p[2]) };
      }
      return { rows: [] };
    });
  }
  const W5 = { id: 5, full_name: 'Alex Rivera', invoice_name: null, overtime_rule: 'daily', role_id: null, hourly_rate: '20', rate_type: 'hourly', guaranteed_weekly_hours: 0, worker_type: 'employee' };
  const E = (d, start, end, over = {}) => ({ id: d + start, user_id: 5, project_id: null, wage_type: 'regular', start_time: start, end_time: end, work_date: d, break_minutes: 0, overtime_hours_override: null, ...over });

  test('computes Regular/OT/Total + days per worker (approved, daily OT@8)', async () => {
    mockExportDb({
      settings: [{ key: 'overtime_threshold', value: '8' }],
      workers: [W5],
      entries: [E('2026-06-01', '08:00', '18:00'), E('2026-06-02', '08:00', '14:00')], // 10h → 8+2 OT; 6h
    });
    const res = await request(makeApp()).get('/api/admin/export/worker-hours?from=2026-06-01&to=2026-06-30');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.split(/\r?\n/);
    expect(lines[0]).toBe('Worker,Regular Hrs,OT Hrs,Total Hrs,Days Worked');
    expect(lines).toContain('"Alex Rivera",14.00,2.00,16.00,2');
    expect(lines[lines.length - 1]).toBe('"TOTAL",14.00,2.00,16.00,2');
    // approved-only filter present on the entries query
    const entriesSql = pool.query.mock.calls.map(c => c[0]).find(q => /FROM time_entries te/.test(q) && /start_time/.test(q));
    expect(entriesSql).toMatch(/status = 'approved'/);
  });

  test('weekly OT sees the whole week (full-week loading), like payroll', async () => {
    // Weekly 40h. Mon–Tue 06-01/02 are OUTSIDE the range but in the same week;
    // Wed–Fri are in range. Week = 50h → Friday's 10h are OT and fall in range.
    mockExportDb({
      settings: [{ key: 'overtime_rule', value: 'weekly' }, { key: 'overtime_threshold', value: '40' }],
      workers: [{ ...W5, overtime_rule: 'weekly' }],
      entries: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05'].map(d => E(d, '08:00', '18:00')),
    });
    const res = await request(makeApp()).get('/api/admin/export/worker-hours?from=2026-06-03&to=2026-06-09');
    expect(res.status).toBe(200);
    expect(res.text.split(/\r?\n/)).toContain('"Alex Rivera",20.00,10.00,30.00,3'); // was 30.00,0.00
  });

  test('honors overtime_hours_override (loads it, like payroll)', async () => {
    mockExportDb({
      settings: [{ key: 'overtime_threshold', value: '8' }],
      workers: [W5],
      entries: [E('2026-06-01', '08:00', '16:00', { overtime_hours_override: 3 })],
    });
    const res = await request(makeApp()).get('/api/admin/export/worker-hours?from=2026-06-01&to=2026-06-07');
    expect(res.status).toBe(200);
    expect(res.text.split(/\r?\n/)).toContain('"Alex Rivera",5.00,3.00,8.00,1');
    const entriesSql = pool.query.mock.calls.map(c => c[0]).find(q => /FROM time_entries te/.test(q) && /start_time/.test(q));
    expect(entriesSql).toMatch(/overtime_hours_override/);
    expect(entriesSql).toMatch(/wage_type/);
  });

  test('honors worker_access_ids scope', async () => {
    setUser({ worker_access_ids: [5, 6] });
    mockExportDb({ workers: [W5], entries: [E('2026-06-01', '08:00', '12:00'), E('2026-06-01', '13:00', '17:00', { user_id: 9 })] });
    const res = await request(makeApp()).get('/api/admin/export/worker-hours?from=2026-06-01&to=2026-06-30');
    expect(res.status).toBe(200);
    const workersCall = pool.query.mock.calls.find(c => /FROM users/.test(c[0]));
    expect(workersCall[0]).toMatch(/id = ANY\(/);
    expect(workersCall[1]).toContainEqual([5, 6]);
    // Only in-scope workers are priced / listed.
    expect(res.text.split(/\r?\n/)[res.text.split(/\r?\n/).length - 1]).toBe('"TOTAL",4.00,0.00,4.00,1');
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
      .mockResolvedValueOnce({ rows: [] }) // settings
      .mockResolvedValueOnce({ rows: [] }) // worker_rate_history
      .mockResolvedValueOnce({ rows: [] }) // project_prevailing_rate_history
      .mockResolvedValueOnce({ rows: [] }) // company_default_rate_history
      .mockResolvedValueOnce({ rows: [] }) // company_prevailing_rate_history (0210)
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
