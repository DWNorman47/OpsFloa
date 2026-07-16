/**
 * GET /subcontractors/compliance — the sub COI / license lapse feed.
 *
 * The first version of this route was declared AFTER '/subcontractors/:id'.
 * Express matches in declaration order, so :id swallowed it and tried to load a
 * subcontractor whose id was the literal string 'compliance' — a 500 from
 * Postgres on an INTEGER column, not a 404, and completely invisible until
 * someone opened the page. These tests pin the ordering and the scoping.
 */

let mockCurrentUser;

jest.mock('../middleware/auth', () => ({
  requireAuth:                  (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin:                 (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePermission:            () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePerm:                  () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePlan:                  () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireProAddon:              (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireCertifiedPayrollAddon: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  hasAdminPermission:           () => true,
  requireSuperAdmin:            (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToCompanyAdmins: jest.fn(), sendPushToAllWorkers: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../routes/inbox', () => ({ createInboxItem: jest.fn(), createInboxItemBatch: jest.fn(), router: require('express').Router() }));
jest.mock('../r2', () => ({ getPresignedUploadUrl: jest.fn(), deleteByUrl: jest.fn() }));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const router = require('../routes/subcontractors');

function app() {
  const a = express();
  a.use(express.json());
  // pino-http gives every request a req.log in the real app; the route's catch
  // calls req.log.error, so without this the 500 path throws inside its own
  // catch and never sends a response.
  a.use((req, _res, next) => { req.log = { error: jest.fn(), warn: jest.fn(), info: jest.fn() }; next(); });
  a.use('/api', router);
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCurrentUser = { id: 1, company_id: 10, role: 'admin', full_name: 'Admin' };
});

describe('GET /subcontractors/compliance', () => {
  test('is NOT shadowed by /subcontractors/:id', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app()).get('/api/subcontractors/compliance');

    expect(res.status).toBe(200);
    // the give-away that :id caught it would be a query filtering on a sub id
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain('subcontractor_documents');
    expect(sql).not.toMatch(/WHERE\s+id\s*=/i);
    // and it must never have been handed 'compliance' as an id
    const params = pool.query.mock.calls[0][1];
    expect(params).not.toContain('compliance');
  });

  test('scopes to the caller company and splits expired vs expiring', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 1, subcontractor_id: 5, doc_type: 'coi', name: 'COI.pdf', expires_on: '2020-01-01', subcontractor_name: 'Ace', is_expired: true },
        { id: 2, subcontractor_id: 6, doc_type: 'license', name: 'Lic.pdf', expires_on: '2099-01-01', subcontractor_name: 'Bolt', is_expired: false },
      ],
      rowCount: 2,
    });

    const res = await request(app()).get('/api/subcontractors/compliance');

    expect(res.status).toBe(200);
    expect(res.body.expired).toBe(1);
    expect(res.body.expiring).toBe(1);
    expect(res.body.items).toHaveLength(2);
    expect(pool.query.mock.calls[0][1][0]).toBe(10); // company_id from the token, not the URL
  });

  test('within_days is clamped, so a huge value cannot scan everything', async () => {
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app()).get('/api/subcontractors/compliance?within_days=99999');
    expect(res.status).toBe(200);
    expect(res.body.within_days).toBe(365);
    expect(pool.query.mock.calls[0][1][1]).toBe(365);
  });

  test('within_days defaults to 30 for missing / garbage / zero', async () => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    for (const q of ['', '?within_days=abc', '?within_days=0']) {
      pool.query.mockClear();
      const res = await request(app()).get(`/api/subcontractors/compliance${q}`);
      expect(res.status).toBe(200);
      expect(res.body.within_days).toBe(30);
    }
  });

  test('a negative within_days clamps to 1, it does not scan backwards', async () => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(app()).get('/api/subcontractors/compliance?within_days=-5');
    expect(res.status).toBe(200);
    expect(res.body.within_days).toBe(1);
  });

  test('a DB failure is a 500, not a leak', async () => {
    pool.query.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app()).get('/api/subcontractors/compliance');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Server error');
  });
});
