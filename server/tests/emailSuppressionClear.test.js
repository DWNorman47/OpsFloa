/**
 * The clear side of email suppression.
 *
 * A suppression stops ALL mail to a worker — invite and password reset
 * included — and there is no user-visible symptom; mail simply stops. Before
 * this, nothing in the app could lift one: the column had a writer and no
 * eraser, so a worker whose mailbox was full once was unreachable forever.
 *
 * Two ways back, tested here:
 *   1. correct the address  → the flag must not follow the row to the new one
 *   2. clear it explicitly  → when the address was right all along
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
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToAllWorkers: jest.fn(), sendPushToCompanyAdmins: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../services/qbo', () => ({}));
jest.mock('../routes/inbox', () => ({ createInboxItem: jest.fn(), createInboxItemBatch: jest.fn() }));
jest.mock('../r2', () => ({ getPresignedUploadUrl: jest.fn() }));

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

// The UPDATE the worker PATCH runs (skipping any updated_at conflict SELECT).
function updateCall() {
  return pool.query.mock.calls.find(([sql]) => /^UPDATE users SET/.test(sql.trim()));
}

// Just the assignments. RETURNING now names the bounce columns on every edit
// (that's the visibility fix), so a naive search of the whole statement can't
// tell "we assigned this" from "we read it back".
function setClause(sql) {
  return sql.trim().slice('UPDATE users SET'.length, sql.indexOf(' WHERE '));
}

beforeEach(() => {
  pool.query.mockReset();
  mockCurrentUser = { id: 1, company_id: 'c1', full_name: 'Admin', role: 'admin', admin_permissions: null };
});

describe('PATCH /admin/workers/:id — suppression must not survive an address change', () => {
  test('changing the email clears the flag, keyed off the OLD address', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 9, email: 'new@example.com' }], rowCount: 1 });

    await request(makeApp())
      .patch('/api/admin/workers/9')
      .send({ email: 'new@example.com' });

    const [sql, params] = updateCall();
    expect(sql).toMatch(/email_bounced_at\s*=\s*CASE WHEN LOWER\(email\) IS DISTINCT FROM LOWER\(\$\d+\)/);
    expect(sql).toMatch(/email_bounce_reason\s*=\s*CASE WHEN LOWER\(email\) IS DISTINCT FROM LOWER\(\$\d+\)/);
    expect(params).toContain('new@example.com');
  });

  test('the address and both CASE guards share ONE placeholder', async () => {
    // A drifting index here would compare the address against some unrelated
    // field — silently clearing, or silently never clearing.
    pool.query.mockResolvedValue({ rows: [{ id: 9 }], rowCount: 1 });

    await request(makeApp())
      .patch('/api/admin/workers/9')
      .send({ full_name: 'Ann', email: 'new@example.com', hourly_rate: 30 });

    const [sql, params] = updateCall();
    const emailIdx = sql.match(/email = \$(\d+)/)[1];
    const guards = [...sql.matchAll(/IS DISTINCT FROM LOWER\(\$(\d+)\)/g)].map(m => m[1]);

    expect(guards).toEqual([emailIdx, emailIdx]);
    expect(params[Number(emailIdx) - 1]).toBe('new@example.com');
  });

  test('an empty email is stored as NULL and still drives the guards', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 9 }], rowCount: 1 });

    await request(makeApp())
      .patch('/api/admin/workers/9')
      .send({ email: '' });

    const [sql, params] = updateCall();
    const emailIdx = Number(sql.match(/email = \$(\d+)/)[1]);
    expect(params[emailIdx - 1]).toBeNull();
  });

  test('an edit that does not touch email leaves the flag alone entirely', async () => {
    // This PATCH carries the whole form. If a rate change cleared suppression,
    // the feature would effectively not exist.
    pool.query.mockResolvedValue({ rows: [{ id: 9 }], rowCount: 1 });

    await request(makeApp())
      .patch('/api/admin/workers/9')
      .send({ hourly_rate: 42 });

    const [sql] = updateCall();
    expect(setClause(sql)).not.toMatch(/email_bounced_at/);
    expect(setClause(sql)).not.toMatch(/email_bounce_reason/);
  });

  test('the worker payload exposes the flag so an admin can see it at all', async () => {
    // The 0075 migration said its "primary use is visibility"; the columns were
    // never actually returned to any client, which is why this stayed silent.
    pool.query.mockResolvedValue({ rows: [{ id: 9 }], rowCount: 1 });

    await request(makeApp()).patch('/api/admin/workers/9').send({ hourly_rate: 42 });

    const [sql] = updateCall();
    expect(sql).toMatch(/RETURNING[^`]*email_bounced_at/);
    expect(sql).toMatch(/RETURNING[^`]*email_bounce_reason/);
  });
});

describe('POST /admin/workers/:id/clear-email-bounce', () => {
  test('clears the flag and writes an audit row', async () => {
    const { logAudit } = require('../auditLog');
    pool.query.mockResolvedValue({ rows: [{ id: 9, email: 'fixed@example.com' }], rowCount: 1 });

    const res = await request(makeApp()).post('/api/admin/workers/9/clear-email-bounce');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, id: 9, email: 'fixed@example.com' });
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/email_bounced_at = NULL/);
    expect(sql).toMatch(/email_bounce_reason = NULL/);
    expect(logAudit).toHaveBeenCalledWith('c1', 1, 'Admin', 'worker.email_bounce_cleared', 'worker', 9, 'fixed@example.com');
  });

  test('is scoped to the caller company — one tenant cannot clear another', async () => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await request(makeApp()).post('/api/admin/workers/9/clear-email-bounce');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/company_id = \$2/);
    expect(params).toEqual(['9', 'c1']);
  });

  test('404s when the worker is not suppressed (nothing to undo)', async () => {
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(makeApp()).post('/api/admin/workers/9/clear-email-bounce');

    expect(res.status).toBe(404);
  });

  test('the literal route is not swallowed by PATCH /workers/:id', async () => {
    // /workers/:id/permissions and friends live next door; a POST to this path
    // must reach this handler and not some :id route.
    pool.query.mockResolvedValue({ rows: [{ id: 9, email: 'a@b.c' }], rowCount: 1 });

    const res = await request(makeApp()).post('/api/admin/workers/9/clear-email-bounce');

    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][0]).toMatch(/email_bounced_at = NULL/);
  });
});
