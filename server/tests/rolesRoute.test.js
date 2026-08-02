/**
 * Phase B roles management endpoints — covers the guardrails and the most
 * security-relevant paths:
 *   1. Privilege escalation: a non-Owner with delegated manage_roles can't
 *      grant manage_billing/etc to a role.
 *   2. Last-Owner protection: can't reassign the only Owner away from Owner.
 *   3. Built-in role rules: can't rename, can't delete, can edit perms.
 *   4. Custom role delete: users fall back to the parent built-in.
 *   5. Permission catalog endpoint returns the catalog.
 */

let mockCurrentUser;
let mockUserPermissions;

jest.mock('../middleware/auth', () => ({
  requireAuth:       (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireAdmin:      (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePermission: () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePerm:       () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requirePlan:       () => (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireProAddon:   (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireCertifiedPayrollAddon: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  requireSuperAdmin: (req, _res, next) => { req.user = mockCurrentUser; next(); },
  hasAdminPermission: () => true,
}));

jest.mock('../permissions', () => {
  const actual = jest.requireActual('../permissions');
  return {
    ...actual,
    // Override the DB-touching helper so tests can drive the requester's
    // effective permissions without seeding role_permissions rows.
    getUserPermissions: jest.fn(async () => mockUserPermissions),
  };
});

jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToAllWorkers: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn() }));
jest.mock('../services/qbo', () => ({}));
jest.mock('../routes/inbox', () => ({
  createInboxItem: jest.fn(), createInboxItemBatch: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const pool = require('../db');
const adminRoute = require('../routes/admin');
const { PERMISSIONS, OWNER_PERMISSIONS } = require('../permissions');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/admin', adminRoute);
  return app;
}

function setUser(overrides = {}) {
  mockCurrentUser = {
    id: 1, company_id: 'co-1', role: 'admin',
    role_id: 100, full_name: 'Test Admin',
    admin_permissions: null, worker_access_ids: null,
    ...overrides,
  };
}

// Mock pool.connect() so transactional routes work. Returns a fake client
// whose query() delegates to pool.query (already mocked) so tests can drive
// it with mockResolvedValueOnce as usual.
function mockTxClient() {
  const client = {
    query: pool.query,
    release: jest.fn(),
  };
  pool.connect.mockResolvedValue(client);
}

beforeEach(() => {
  pool.query.mockReset();
  pool.connect.mockReset();
  mockUserPermissions = new Set(OWNER_PERMISSIONS);
  setUser();
  mockTxClient();
});

// ── GET /admin/permissions/catalog ───────────────────────────────────────────

describe('GET /admin/permissions/catalog', () => {
  test('returns the full permission catalog', async () => {
    const res = await request(makeApp()).get('/api/admin/permissions/catalog');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(PERMISSIONS.length);
    // Spot check: known keys are present
    const keys = res.body.map(p => p.key);
    expect(keys).toContain('manage_billing');
    expect(keys).toContain('clock_self');
  });
});

// ── POST /admin/roles ────────────────────────────────────────────────────────

describe('POST /admin/roles', () => {
  test('creates a custom role with valid permissions', async () => {
    pool.query
      .mockResolvedValueOnce({})                              // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 200 }] })         // INSERT INTO roles
      .mockResolvedValueOnce({})                              // INSERT permission #1
      .mockResolvedValueOnce({})                              // COMMIT

    const res = await request(makeApp())
      .post('/api/admin/roles')
      .send({ name: 'Foreman', parent_role: 'admin', permissions: ['approve_entries'] });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(200);
  });

  test('rejects unknown permission keys', async () => {
    const res = await request(makeApp())
      .post('/api/admin/roles')
      .send({ name: 'X', parent_role: 'admin', permissions: ['definitely_not_a_perm'] });
    expect(res.status).toBe(400);
  });

  test('rejects empty name', async () => {
    const res = await request(makeApp())
      .post('/api/admin/roles')
      .send({ name: '   ', parent_role: 'admin', permissions: [] });
    expect(res.status).toBe(400);
  });

  test('rejects invalid parent_role', async () => {
    const res = await request(makeApp())
      .post('/api/admin/roles')
      .send({ name: 'Foreman', parent_role: 'wizard', permissions: [] });
    expect(res.status).toBe(400);
  });

  test('PRIVILEGE ESCALATION: manage_roles user cannot grant manage_billing (worker-tier role)', async () => {
    mockUserPermissions = new Set(['manage_roles', 'approve_entries']); // No manage_billing
    const res = await request(makeApp())
      .post('/api/admin/roles')
      .send({
        name: 'BillingHelper',
        parent_role: 'worker', // worker-tier so the escalation guard (not the tier gate) is what blocks
        permissions: ['manage_billing'],
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('permission_escalation');
    expect(res.body.required).toBe('manage_billing');
  });

  test('TIER GATE: manage_roles (non-Owner) cannot CREATE an admin-tier role', async () => {
    mockUserPermissions = new Set(['manage_roles', 'approve_entries']); // no manage_admin_roles
    const res = await request(makeApp())
      .post('/api/admin/roles')
      .send({ name: 'Foreman', parent_role: 'admin', permissions: ['approve_entries'] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('admin_role_forbidden');
  });

  test('TIER GATE: manage_roles (non-Owner) CAN create a worker-tier role', async () => {
    mockUserPermissions = new Set(['manage_roles', 'approve_entries']);
    pool.query
      .mockResolvedValueOnce({})                      // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 202 }] }) // INSERT INTO roles
      .mockResolvedValueOnce({})                      // INSERT permission
      .mockResolvedValueOnce({});                     // COMMIT
    const res = await request(makeApp())
      .post('/api/admin/roles')
      .send({ name: 'Lead', parent_role: 'worker', permissions: ['approve_entries'] });
    expect(res.status).toBe(201);
  });

  test('Owner can grant manage_billing (has it themselves)', async () => {
    mockUserPermissions = new Set(OWNER_PERMISSIONS);
    pool.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: 201 }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const res = await request(makeApp())
      .post('/api/admin/roles')
      .send({
        name: 'Bookkeeper',
        parent_role: 'admin',
        permissions: ['manage_billing', 'view_reports'],
      });
    expect(res.status).toBe(201);
  });

  test('returns 409 on duplicate name', async () => {
    pool.query
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    const res = await request(makeApp())
      .post('/api/admin/roles')
      .send({ name: 'Admin', parent_role: 'admin', permissions: [] });
    expect(res.status).toBe(409);
  });
});

// ── PATCH /admin/roles/:id ──────────────────────────────────────────────────

describe('PATCH /admin/roles/:id', () => {
  test('cannot rename a built-in role', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 50, is_builtin: true, name: 'Owner' }],
    });
    const res = await request(makeApp())
      .patch('/api/admin/roles/50')
      .send({ name: 'NewOwner' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/built-in/i);
  });

  test('can edit permissions on a built-in role', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 50, is_builtin: true, name: 'Admin' }] }) // existing lookup
      .mockResolvedValueOnce({})                                                    // BEGIN
      .mockResolvedValueOnce({})                                                    // DELETE old perms
      .mockResolvedValueOnce({})                                                    // INSERT perm #1
      .mockResolvedValueOnce({})                                                    // updated_at bump
      .mockResolvedValueOnce({});                                                   // COMMIT
    const res = await request(makeApp())
      .patch('/api/admin/roles/50')
      .send({ permissions: ['view_reports'] });
    expect(res.status).toBe(200);
  });

  test('editing permissions while sending the unchanged name is not a rename', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 50, is_builtin: true, name: 'Admin' }] }) // existing lookup
      .mockResolvedValueOnce({})                                                    // BEGIN
      .mockResolvedValueOnce({})                                                    // DELETE old perms
      .mockResolvedValueOnce({})                                                    // INSERT perm #1
      .mockResolvedValueOnce({})                                                    // updated_at bump
      .mockResolvedValueOnce({});                                                   // COMMIT
    const res = await request(makeApp())
      .patch('/api/admin/roles/50')
      .send({ name: 'Admin', permissions: ['view_reports'] });
    expect(res.status).toBe(200);
  });

  test('PRIVILEGE ESCALATION blocked on edit', async () => {
    mockUserPermissions = new Set(['manage_roles']); // no view_reports
    pool.query.mockResolvedValueOnce({
      rowCount: 1, rows: [{ id: 50, is_builtin: false }],
    });
    const res = await request(makeApp())
      .patch('/api/admin/roles/50')
      .send({ permissions: ['view_reports'] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('permission_escalation');
  });

  test('404 when role belongs to a different company', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp())
      .patch('/api/admin/roles/9999')
      .send({ name: 'X' });
    expect(res.status).toBe(404);
  });

  test('TIER GATE: manage_roles (non-Owner) cannot EDIT an admin-tier role', async () => {
    mockUserPermissions = new Set(['manage_roles']); // no manage_admin_roles
    pool.query.mockResolvedValueOnce({
      rowCount: 1, rows: [{ id: 60, is_builtin: true, name: 'Admin', parent_role: 'admin' }],
    });
    const res = await request(makeApp())
      .patch('/api/admin/roles/60')
      .send({ permissions: ['view_reports'] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('admin_role_forbidden');
  });
});

// ── DELETE /admin/roles/:id ─────────────────────────────────────────────────

describe('DELETE /admin/roles/:id', () => {
  test('cannot delete a built-in role', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1, rows: [{ id: 50, is_builtin: true, parent_role: 'admin' }],
    });
    const res = await request(makeApp()).delete('/api/admin/roles/50');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/built-in/i);
  });

  test('deletes custom role and falls users back to parent built-in', async () => {
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 200, is_builtin: false, parent_role: 'admin' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 50 }] })  // fallback lookup (Admin role)
      .mockResolvedValueOnce({})                                    // BEGIN
      .mockResolvedValueOnce({})                                    // UPDATE users
      .mockResolvedValueOnce({})                                    // DELETE roles
      .mockResolvedValueOnce({});                                   // COMMIT
    const res = await request(makeApp()).delete('/api/admin/roles/200');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.fallback_role_id).toBe(50);
  });

  test('TIER GATE: manage_roles (non-Owner) cannot DELETE an admin-tier custom role', async () => {
    mockUserPermissions = new Set(['manage_roles']); // no manage_admin_roles
    pool.query.mockResolvedValueOnce({
      rowCount: 1, rows: [{ id: 205, is_builtin: false, parent_role: 'admin' }],
    });
    const res = await request(makeApp()).delete('/api/admin/roles/205');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('admin_role_forbidden');
  });
});

// ── PATCH /admin/workers/:id/role ───────────────────────────────────────────

describe('PATCH /admin/workers/:id/role', () => {
  test('reassigns role and updates legacy users.role', async () => {
    pool.query
      .mockResolvedValueOnce({                    // target role lookup
        rowCount: 1,
        rows: [{ id: 100, name: 'Admin', parent_role: 'admin', is_builtin: true }],
      })
      .mockResolvedValueOnce({ rows: [] })        // target role permissions (escalation check)
      .mockResolvedValueOnce({                    // target user lookup
        rowCount: 1,
        rows: [{ id: 99, full_name: 'Bob', current_role_id: 75, current_role_name: 'Worker' }],
      })
      .mockResolvedValueOnce({});                 // UPDATE users
    const res = await request(makeApp())
      .patch('/api/admin/workers/99/role')
      .send({ role_id: 100 });
    expect(res.status).toBe(200);
  });

  test('LAST OWNER blocked: cannot reassign the only Owner away', async () => {
    pool.query
      .mockResolvedValueOnce({                    // target role lookup (Admin)
        rowCount: 1,
        rows: [{ id: 100, name: 'Admin', parent_role: 'admin', is_builtin: true }],
      })
      .mockResolvedValueOnce({ rows: [] })        // target role permissions (escalation check)
      .mockResolvedValueOnce({                    // target user lookup (currently Owner)
        rowCount: 1,
        rows: [{ id: 99, full_name: 'Last Owner', current_role_id: 200, current_role_name: 'Owner' }],
      })
      .mockResolvedValueOnce({                    // count other owners → 0
        rowCount: 1,
        rows: [{ cnt: 0 }],
      });
    const res = await request(makeApp())
      .patch('/api/admin/workers/99/role')
      .send({ role_id: 100 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('last_owner');
  });

  test('Owner reassignment allowed when another Owner exists', async () => {
    pool.query
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 100, name: 'Admin', parent_role: 'admin', is_builtin: true }],
      })
      .mockResolvedValueOnce({ rows: [] })        // target role permissions (escalation check)
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 99, full_name: 'Demoted Owner', current_role_id: 200, current_role_name: 'Owner' }],
      })
      .mockResolvedValueOnce({                    // count other owners → 1
        rowCount: 1, rows: [{ cnt: 1 }],
      })
      .mockResolvedValueOnce({});                 // UPDATE users
    const res = await request(makeApp())
      .patch('/api/admin/workers/99/role')
      .send({ role_id: 100 });
    expect(res.status).toBe(200);
  });

  test('400 without role_id', async () => {
    const res = await request(makeApp())
      .patch('/api/admin/workers/99/role')
      .send({});
    expect(res.status).toBe(400);
  });

  test('ESCALATION blocked: cannot grant a role with a permission the granter lacks', async () => {
    // Granter (an Admin) lacks manage_billing; the target role has it.
    mockUserPermissions = new Set(['approve_entries']);
    pool.query
      .mockResolvedValueOnce({                    // target role lookup
        rowCount: 1,
        rows: [{ id: 200, name: 'Bookkeeper', parent_role: 'admin', is_builtin: false }],
      })
      .mockResolvedValueOnce({ rows: [{ permission: 'manage_billing' }] }); // target role perms
    const res = await request(makeApp())
      .patch('/api/admin/workers/99/role')
      .send({ role_id: 200 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('role_exceeds_granter');
  });
});
