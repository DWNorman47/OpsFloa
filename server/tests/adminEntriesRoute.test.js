/**
 * Tier 2 route tests — cover the two hardest-to-spot bug classes in
 * admin.js:
 *   1. Optimistic-lock on /admin/entries/:id/edit (updated_at mismatch → 409)
 *   2. worker_access_ids scoping on /admin/entries/pending — a restricted
 *      admin should only see entries for users in their access list.
 */

// Shared mutable user the auth middleware injects into req.
// Name must start with "mock" so Jest's hoisting check allows the factory to reference it.
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

jest.mock('../db', () => ({ query: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToAllWorkers: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../services/qbo', () => ({}));
jest.mock('./inbox', () => ({
  createInboxItem: jest.fn(), createInboxItemBatch: jest.fn(),
}), { virtual: true });
// The inbox module lives at server/routes/inbox.js — when admin.js does
// require('./inbox') at module load we need to intercept it relative to the
// actual module, not this test file.
jest.mock('../routes/inbox', () => ({
  createInboxItem: jest.fn(), createInboxItemBatch: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const adminRoute = require('../routes/admin');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/admin', adminRoute);
  return app;
}

// eslint-disable-next-line no-global-assign
function setUser({ id = 1, company_id = 'co-1', role = 'admin', worker_access_ids = null, admin_permissions = null } = {}) {
  mockCurrentUser = { id, company_id, role, full_name: 'Test Admin', worker_access_ids, admin_permissions };
}

// ───────────────────────────────────────────────────────────────────────────
// Optimistic lock — PATCH /admin/entries/:id/edit
// ───────────────────────────────────────────────────────────────────────────

describe('PATCH /admin/entries/:id/edit — optimistic lock', () => {
  beforeEach(() => {
    pool.query.mockReset();
    setUser();
    // The route calls getSettings(companyId) first to gate on
    // feature_admin_edit_time. Empty rows → default true → handler proceeds.
    pool.query.mockResolvedValueOnce({ rows: [] });
  });

  // Phase 2 dual-write changed the route flow: the entry row is now ALWAYS
  // fetched up-front (for work_date + timezone, used to derive start_ts /
  // end_ts), so the SELECT always runs whether or not the client sent
  // updated_at. The optimistic-lock check just becomes a no-op when the
  // client didn't send a timestamp.
  const FETCH_ROW = {
    updated_at: new Date('2026-04-10T10:00:00.000Z'),
    work_date:  new Date('2026-04-10T00:00:00.000Z'),
    timezone:   'America/New_York',
  };

  test('accepts edit when client updated_at matches DB', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [FETCH_ROW] })                          // entry fetch
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42 }] })            // UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 42, worker_name: 'X', project_name: 'P' }] }); // joined return

    const res = await request(makeApp())
      .patch('/api/admin/entries/42/edit')
      .send({ start_time: '08:00', end_time: '16:00', updated_at: FETCH_ROW.updated_at.toISOString() });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(42);
  });

  test('returns 409 when client updated_at is stale', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...FETCH_ROW, updated_at: '2026-04-10T10:05:00.000Z' }] });

    const res = await request(makeApp())
      .patch('/api/admin/entries/42/edit')
      .send({ start_time: '08:00', end_time: '16:00', updated_at: '2026-04-10T10:00:00.000Z' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('conflict');
    // settings + entry fetch; UPDATE must NOT have run
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  test('returns 404 when entry does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp())
      .patch('/api/admin/entries/999/edit')
      .send({ start_time: '08:00', end_time: '16:00', updated_at: '2026-04-10T10:00:00.000Z' });

    expect(res.status).toBe(404);
  });

  test('returns 400 when start_time or end_time missing', async () => {
    const res = await request(makeApp())
      .patch('/api/admin/entries/42/edit')
      .send({ start_time: '08:00' }); // missing end_time

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('skips optimistic-lock check when updated_at is absent (legacy client)', async () => {
    // Old clients that don't send updated_at don't get the version check,
    // but the entry fetch still runs (we need work_date + timezone for
    // dual-write).
    pool.query
      .mockResolvedValueOnce({ rows: [FETCH_ROW] })                          // entry fetch
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42 }] })            // UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 42, worker_name: 'X', project_name: 'P' }] });

    const res = await request(makeApp())
      .patch('/api/admin/entries/42/edit')
      .send({ start_time: '08:00', end_time: '16:00' });

    expect(res.status).toBe(200);
  });

  test('treats equal timestamps expressed in different formats as a match', async () => {
    // Postgres returns Date objects, clients send ISO strings — both should
    // normalize via .getTime() to the same millisecond value.
    pool.query
      .mockResolvedValueOnce({ rows: [FETCH_ROW] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 42 }] })
      .mockResolvedValueOnce({ rows: [{ id: 42, worker_name: 'X', project_name: 'P' }] });

    const res = await request(makeApp())
      .patch('/api/admin/entries/42/edit')
      .send({ start_time: '08:00', end_time: '16:00', updated_at: '2026-04-10T10:00:00.000Z' });

    expect(res.status).toBe(200);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Permission scoping — GET /admin/entries/pending with worker_access_ids
// ───────────────────────────────────────────────────────────────────────────

describe('GET /admin/entries/pending — worker_access_ids scoping', () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  test('full-access admin (worker_access_ids=null) queries without user filter', async () => {
    setUser({ worker_access_ids: null });
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(makeApp()).get('/api/admin/entries/pending');

    const [, params] = pool.query.mock.calls[0];
    // First param is companyId; no ANY($N) filter should be added for users
    expect(params[0]).toBe('co-1');
    // LIMIT and OFFSET follow companyId — only 3 params total
    expect(params).toHaveLength(3);
  });

  test('restricted admin passes their access list into the user filter', async () => {
    setUser({ worker_access_ids: [7, 9] });
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(makeApp()).get('/api/admin/entries/pending');

    const [sql, params] = pool.query.mock.calls[0];
    // Should contain a `te.user_id = ANY($2)` filter referencing the access list
    expect(sql).toMatch(/te\.user_id = ANY\(\$2\)/);
    expect(params[1]).toEqual([7, 9]);
  });

  test('restricted admin with empty list falls back to no user filter (no SQL breakage)', async () => {
    // Edge case: admin has worker_access_ids = [] — the check `accessIds && accessIds.length`
    // gates correctly so no ANY($N) clause is emitted with an empty array.
    setUser({ worker_access_ids: [] });
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(makeApp()).get('/api/admin/entries/pending');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toMatch(/te\.user_id = ANY/);
    expect(params).toHaveLength(3);
  });

  test('from/to date params are applied alongside worker scoping', async () => {
    setUser({ worker_access_ids: [7] });
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(makeApp())
      .get('/api/admin/entries/pending')
      .query({ from: '2026-04-01', to: '2026-04-30' });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/te\.user_id = ANY/);
    expect(sql).toMatch(/te\.work_date >= /);
    expect(sql).toMatch(/te\.work_date <= /);
    expect(params).toContain('2026-04-01');
    expect(params).toContain('2026-04-30');
  });

  test('has_more=true when 201 rows returned (page size + 1)', async () => {
    setUser({ worker_access_ids: null });
    const rows = Array.from({ length: 201 }, (_, i) => ({ id: i, user_id: 1 }));
    pool.query.mockResolvedValueOnce({ rows });

    const res = await request(makeApp()).get('/api/admin/entries/pending');

    expect(res.body.has_more).toBe(true);
    expect(res.body.entries).toHaveLength(200);
  });

  test('has_more=false when 100 rows returned', async () => {
    setUser({ worker_access_ids: null });
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    pool.query.mockResolvedValueOnce({ rows });

    const res = await request(makeApp()).get('/api/admin/entries/pending');

    expect(res.body.has_more).toBe(false);
    expect(res.body.entries).toHaveLength(100);
  });
});
