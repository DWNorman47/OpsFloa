/**
 * WH-347 certified payroll report (GET /admin/certified-payroll) + signatures.
 *
 *  - Filtered to ONE project, weekly OT is classified from ALL of the worker's approved
 *    hours in the week (every project); only that project's rows are shown, with the
 *    correct straight/OT split for them.
 *  - week_end must be the company's week-end day (per week_start) → else 400.
 *  - 29 CFR 5.5(a)(3)(i): deductions (FICA / withholding / other, from the pay statement's
 *    deductions engine) and net wages per worker, and the gross earned for ALL work
 *    alongside this project's gross.
 *  - Each signature stores a SHA-256 of the canonical report JSON; the report says when
 *    the data changed since it was signed. The all-projects signature upserts on the
 *    partial unique index (project_id IS NULL), and a stale report hash can't be signed.
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
jest.mock('../utils/payStatement', () => ({
  ...jest.requireActual('../utils/payStatement'),
  companyStatements: jest.fn(async () => new Map()),
}));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const { companyStatements } = require('../utils/payStatement');
const adminRoute = require('../routes/admin');
const cpRoute = require('../routes/certifiedPayroll');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: () => {}, warn: () => {} }; next(); });
  app.use('/api/admin', adminRoute);
  app.use('/api/certified-payroll', cpRoute);
  return app;
}

// Week Mon 2026-09-14 … Sun 2026-09-20 (week_start = 1 → week ends Sunday).
const WEEK_END = '2026-09-20';
const entry = (project_id, work_date, start = '07:00:00', end = '17:00:00') => ({
  user_id: 7, project_id, worker_name: 'Ana', hourly_rate: '30', rate_type: 'hourly', classification: 'Laborer',
  role_id: null, overtime_rule: null, work_date, start_time: start, end_time: end, break_minutes: 0,
  wage_type: 'regular', overtime_hours_override: null, start_ts: null, end_ts: null, timezone: null,
  entry_classification: null, project_prevailing_wage_rate: null,
});
// 40h on project 1 Mon–Thu, then 8h on project 2 Friday → those 8h are overtime.
const ENTRIES = [
  entry(1, '2026-09-14'), entry(1, '2026-09-15'), entry(1, '2026-09-16'), entry(1, '2026-09-17'),
  entry(2, '2026-09-18', '07:00:00', '15:00:00'),
];

let signatureRow = null;
let sigWrites = [];
function mockDb({ entries = ENTRIES } = {}) {
  sigWrites = [];
  const answer = async (sql, params) => {
    if (/SELECT key, value FROM settings/.test(sql)) {
      return { rows: [{ key: 'overtime_rule', value: 'weekly' }, { key: 'overtime_threshold', value: '40' }, { key: 'week_start', value: '1' }] };
    }
    if (/SELECT name FROM companies/.test(sql)) return { rows: [{ name: 'Acme' }] };
    if (/SELECT name, prevailing_wage_rate FROM projects/.test(sql)) return { rowCount: 1, rows: [{ name: `Project ${params[0]}`, prevailing_wage_rate: null }] };
    if (/SELECT name FROM projects WHERE id/.test(sql)) return { rowCount: 1, rows: [{ name: `Project ${params[0]}` }] };
    if (/FROM time_entries te\s+JOIN users u/.test(sql)) {
      // The OLD query filtered the rows to the project directly (te.project_id = $4).
      const direct = /te\.project_id = \$4/.test(sql);
      return { rows: direct ? entries.filter(e => e.project_id === Number(params[3])) : entries };
    }
    if (/FROM users WHERE id = ANY/.test(sql) && /guaranteed_weekly_hours/.test(sql)) {
      return { rows: [{ id: 7, full_name: 'Ana', invoice_name: null, hourly_rate: '30', rate_type: 'hourly', overtime_rule: null, role_id: null, guaranteed_weekly_hours: null, worker_type: 'employee' }] };
    }
    if (/FROM certified_payroll_signatures/.test(sql) && /^\s*SELECT/.test(sql)) return { rowCount: signatureRow ? 1 : 0, rows: signatureRow ? [signatureRow] : [] };
    if (/INSERT INTO certified_payroll_signatures/.test(sql)) {
      sigWrites.push({ sql, params });
      return { rows: [{ id: 1, signer_name: params[4], report_hash: params.find(p => typeof p === 'string' && /^[0-9a-f]{64}$/.test(p)) }] };
    }
    return { rowCount: 0, rows: [] };
  };
  pool.query.mockImplementation(answer);
}

beforeEach(() => {
  pool.query.mockReset();
  companyStatements.mockReset();
  companyStatements.mockResolvedValue(new Map([[7, {
    totals: { grossWages: 1560, deductionsTotal: 360, netWages: 1200, netPay: 1200 },
    deductions: [
      { name: 'FICA (Social Security + Medicare)', amount: 119.34 },
      { name: 'Federal income tax withholding', amount: 200 },
      { name: 'Union dues', amount: 40.66 },
    ],
  }]]));
  signatureRow = null;
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', full_name: 'Admin' };
});

const get = (q) => request(makeApp()).get(`/api/admin/certified-payroll?${q}`);

describe('project-filtered WH-347 overtime', () => {
  test('OT is classified from ALL projects: project 2\'s 8h (after 40h on project 1) are overtime', async () => {
    mockDb();
    const res = await get(`week_end=${WEEK_END}&project_id=2`);
    expect(res.status).toBe(200);
    expect(res.body.workers).toHaveLength(1);
    const w = res.body.workers[0];
    expect(w.regular_total).toBe(0);
    expect(w.overtime_total).toBe(8);
    expect(w.ot_days.fri).toBe(8);
    expect(w.gross_pay).toBe(360); // 8h × $30 × 1.5
  });

  test('only the filtered project\'s rows are shown (project 1: 40h straight, no OT)', async () => {
    mockDb();
    const res = await get(`week_end=${WEEK_END}&project_id=1`);
    const w = res.body.workers[0];
    expect(w.regular_total).toBe(40);
    expect(w.overtime_total).toBe(0);
    expect(w.regular_days.fri).toBe(0);
  });

  test('a worker with no hours on the project is not listed', async () => {
    mockDb({ entries: ENTRIES.filter(e => e.project_id === 1) });
    const res = await get(`week_end=${WEEK_END}&project_id=2`);
    expect(res.status).toBe(200);
    expect(res.body.workers).toHaveLength(0);
  });

  test('week_end that is not the company week-end day → 400', async () => {
    mockDb();
    const res = await get('week_end=2026-09-19');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_week_end');
  });
});

describe('WH-347 required fields — deductions, net, gross for all work', () => {
  test('worker summary on the worker\'s first row', async () => {
    mockDb();
    const res = await get(`week_end=${WEEK_END}&project_id=2`);
    const w = res.body.workers[0];
    expect(w.worker_summary).toMatchObject({
      gross_this_project: 360,
      gross_all_work: 1560,
      deductions: { fica: 119.34, withholding: 200, other: 40.66, total: 360 },
      net_wages: 1200,
    });
    // statements are loaded for the WH-347 week, all projects
    expect(companyStatements).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'co-1', from: '2026-09-14', to: WEEK_END }));
  });
});

describe('signature report hash', () => {
  test('report carries a stable SHA-256 report_hash', async () => {
    mockDb();
    const a = await get(`week_end=${WEEK_END}`);
    const b = await get(`week_end=${WEEK_END}`);
    expect(a.body.report_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.body.report_hash).toBe(b.body.report_hash);
  });

  test('signature whose hash matches → data_changed false; mismatch → true', async () => {
    mockDb();
    const { body } = await get(`week_end=${WEEK_END}`);
    signatureRow = { signer_name: 'Ana Boss', signed_at: '2026-09-21T10:00:00Z', report_hash: body.report_hash };
    expect((await get(`week_end=${WEEK_END}`)).body.signature.data_changed).toBe(false);
    signatureRow = { ...signatureRow, report_hash: 'f'.repeat(64) };
    expect((await get(`week_end=${WEEK_END}`)).body.signature.data_changed).toBe(true);
  });

  test('POST /signatures (all projects) stores the server-computed hash on the partial unique index', async () => {
    mockDb();
    const { body } = await get(`week_end=${WEEK_END}`);
    const res = await request(makeApp()).post('/api/certified-payroll/signatures')
      .send({ week_ending: WEEK_END, signer_name: 'Ana Boss', signature_data: 'Ana Boss', report_hash: body.report_hash });
    expect(res.status).toBe(200);
    expect(sigWrites).toHaveLength(1);
    expect(sigWrites[0].sql).toMatch(/ON CONFLICT \(company_id, week_ending\) WHERE project_id IS NULL/);
    expect(sigWrites[0].params).toContain(body.report_hash);
  });

  test('POST /signatures for a project snapshots the project name', async () => {
    mockDb();
    const res = await request(makeApp()).post('/api/certified-payroll/signatures')
      .send({ week_ending: WEEK_END, project_id: 2, signer_name: 'Ana Boss', signature_data: 'Ana Boss' });
    expect(res.status).toBe(200);
    expect(sigWrites[0].sql).toMatch(/ON CONFLICT \(company_id, project_id, week_ending\) DO UPDATE/);
    expect(sigWrites[0].params).toContain('Project 2');
  });

  test('signing a stale report (data changed since it was viewed) → 409 report_changed', async () => {
    mockDb();
    const res = await request(makeApp()).post('/api/certified-payroll/signatures')
      .send({ week_ending: WEEK_END, signer_name: 'Ana Boss', signature_data: 'Ana Boss', report_hash: 'a'.repeat(64) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('report_changed');
    expect(sigWrites).toHaveLength(0);
  });
});
