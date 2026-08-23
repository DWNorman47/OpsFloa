/**
 * Auth middleware tests — these cover the most security-critical code path
 * in the app. A regression here could silently let unauthenticated or
 * wrong-role users through, or lock everyone out.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests-only';

jest.mock('../db', () => ({ query: jest.fn() }));

const jwt  = require('jsonwebtoken');
const pool = require('../db');
const {
  requireAuth, requireAdmin, requireSuperAdmin,
  hasAdminPermission, requirePermission,
} = require('../middleware/auth');

function makeReq(token, overrides = {}) {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...overrides,
  };
}

function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json   = (body) => { res.body = body; return res; };
  return res;
}

const sign = (payload) => jwt.sign(payload, process.env.JWT_SECRET);

// ───────────────────────────────────────────────────────────────────────────
// requireAuth
// ───────────────────────────────────────────────────────────────────────────

describe('requireAuth', () => {
  beforeEach(() => pool.query.mockReset());

  test('401 when Authorization header is missing', async () => {
    const res = makeRes();
    const next = jest.fn();
    await requireAuth(makeReq(null), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('401 when header does not start with "Bearer "', async () => {
    const res = makeRes();
    const next = jest.fn();
    const req = { headers: { authorization: 'Token abc' } };
    await requireAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('401 on invalid signature', async () => {
    const badToken = jwt.sign({ id: 1 }, 'wrong-secret');
    const res = makeRes();
    const next = jest.fn();
    await requireAuth(makeReq(badToken), res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Invalid token');
    expect(next).not.toHaveBeenCalled();
  });

  test('401 on expired token', async () => {
    const expired = jwt.sign({ id: 1 }, process.env.JWT_SECRET, { expiresIn: -10 });
    const res = makeRes();
    const next = jest.fn();
    await requireAuth(makeReq(expired), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('401 for an mfa-pending challenge token (no tv, no imp) — must not authenticate a normal request', async () => {
    // Issued from just a password, BEFORE the second factor. Accepting it here let it
    // reach /auth/me and /auth/mfa/disable and bypass MFA. It is only valid at
    // /auth/mfa/confirm, which verifies it explicitly.
    const token = sign({ id: 1, mfa_pending: true });
    const req = makeReq(token);
    const res = makeRes();
    const next = jest.fn();
    await requireAuth(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('401 for a setup-pending token (no tv, no imp)', async () => {
    const token = sign({ id: 1, setup_pending: true });
    const res = makeRes();
    const next = jest.fn();
    await requireAuth(makeReq(token), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('impersonation token (imp, no tv) still passes when target is active', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ target_active: true, imp_active: true, imp_role: 'super_admin' }] });
    const token = sign({ id: 1, role: 'worker', imp: true, imp_by: 9 });
    const req = makeReq(token);
    const res = makeRes();
    const next = jest.fn();
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.id).toBe(1);
  });

  test('passes when tv matches DB token_version', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ token_version: 7 }] });
    const token = sign({ id: 1, role: 'worker', tv: 7 });
    const req = makeReq(token);
    const res = makeRes();
    const next = jest.fn();
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });

  test('401 when tv does not match (password was changed since token issued)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ token_version: 8 }] });
    const token = sign({ id: 1, role: 'worker', tv: 7 });
    const res = makeRes();
    const next = jest.fn();
    await requireAuth(makeReq(token), res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/Session invalidated/);
    expect(next).not.toHaveBeenCalled();
  });

  test('401 when user no longer exists', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const token = sign({ id: 999, role: 'worker', tv: 1 });
    const res = makeRes();
    const next = jest.fn();
    await requireAuth(makeReq(token), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('503 (fail closed) when DB errors during tv lookup', async () => {
    pool.query.mockRejectedValueOnce(new Error('connection refused'));
    const token = sign({ id: 1, role: 'worker', tv: 1 });
    const res = makeRes();
    const next = jest.fn();
    await requireAuth(makeReq(token), res, next);
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// requireAdmin / requireSuperAdmin
// ───────────────────────────────────────────────────────────────────────────

describe('requireAdmin', () => {
  // requireAuth (chained first) now requires a real session token (tv) + live DB check.
  beforeEach(() => { pool.query.mockReset(); pool.query.mockResolvedValue({ rows: [{ token_version: 1, active: true }] }); });

  test('403 when role is worker', async () => {
    const token = sign({ id: 1, role: 'worker', tv: 1 });
    const res = makeRes();
    const next = jest.fn();
    await requireAdmin(makeReq(token), res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('passes when role is admin', async () => {
    const token = sign({ id: 1, role: 'admin', tv: 1 });
    const res = makeRes();
    const next = jest.fn();
    await requireAdmin(makeReq(token), res, next);
    expect(next).toHaveBeenCalled();
  });

  test('passes when role is super_admin', async () => {
    const token = sign({ id: 1, role: 'super_admin', tv: 1 });
    const res = makeRes();
    const next = jest.fn();
    await requireAdmin(makeReq(token), res, next);
    expect(next).toHaveBeenCalled();
  });

  test('401 still fires for bad token (doesn\'t leak 403 past auth)', async () => {
    const res = makeRes();
    const next = jest.fn();
    await requireAdmin(makeReq(null), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireSuperAdmin', () => {
  beforeEach(() => { pool.query.mockReset(); pool.query.mockResolvedValue({ rows: [{ token_version: 1, active: true }] }); });

  test('403 for admin role', async () => {
    const token = sign({ id: 1, role: 'admin', tv: 1 });
    const res = makeRes();
    const next = jest.fn();
    await requireSuperAdmin(makeReq(token), res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('passes for super_admin', async () => {
    const token = sign({ id: 1, role: 'super_admin', tv: 1 });
    const res = makeRes();
    const next = jest.fn();
    await requireSuperAdmin(makeReq(token), res, next);
    expect(next).toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// hasAdminPermission / requirePermission
// ───────────────────────────────────────────────────────────────────────────

describe('hasAdminPermission', () => {
  test('super_admin always true', () => {
    expect(hasAdminPermission({ role: 'super_admin' }, 'anything')).toBe(true);
    expect(hasAdminPermission({ role: 'super_admin', admin_permissions: { anything: false } }, 'anything')).toBe(true);
  });

  test('null admin_permissions = full access (legacy admins / founder)', () => {
    expect(hasAdminPermission({ role: 'admin', admin_permissions: null }, 'billing')).toBe(true);
  });

  test('missing admin_permissions key = full access', () => {
    expect(hasAdminPermission({ role: 'admin' }, 'billing')).toBe(true);
  });

  test('specific permission true = allowed', () => {
    expect(hasAdminPermission({ role: 'admin', admin_permissions: { billing: true } }, 'billing')).toBe(true);
  });

  test('specific permission false = denied', () => {
    expect(hasAdminPermission({ role: 'admin', admin_permissions: { billing: false } }, 'billing')).toBe(false);
  });

  test('missing key in a populated admin_permissions map = denied (safe default)', () => {
    expect(hasAdminPermission({ role: 'admin', admin_permissions: { billing: true } }, 'payroll')).toBe(false);
  });
});

describe('requirePermission', () => {
  test('403 with specific code when permission denied', () => {
    const req = { user: { role: 'admin', admin_permissions: { billing: false } } };
    const res = makeRes();
    const next = jest.fn();
    requirePermission('billing')(req, res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('permission_denied');
    expect(res.body.required).toBe('billing');
    expect(next).not.toHaveBeenCalled();
  });

  test('passes when permission granted', () => {
    const req = { user: { role: 'admin', admin_permissions: { billing: true } } };
    const res = makeRes();
    const next = jest.fn();
    requirePermission('billing')(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
