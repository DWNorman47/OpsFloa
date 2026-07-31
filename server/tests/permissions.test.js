/**
 * Phase A permissions tests — hasPerm() resolver covering the three paths:
 *   1. super_admin short-circuit
 *   2. role_id lookup against role_permissions
 *   3. legacy fallback to admin_permissions JSONB when role_id is null
 *
 * The actual backfill migration (0089) is exercised by the migrations-lint
 * CI job, which applies it against a throwaway Postgres on every push.
 */

jest.mock('../db', () => ({ query: jest.fn() }));

const pool = require('../db');
const {
  PERMISSIONS, PERMISSION_KEYS, BUILTIN_ROLES,
  WORKER_PERMISSIONS, ADMIN_PERMISSIONS, OWNER_PERMISSIONS,
  hasPerm, requirePerm, getUserPermissions,
} = require('../permissions');

describe('permission catalog', () => {
  test('every key is unique', () => {
    const keys = PERMISSIONS.map(p => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every key has a group and label', () => {
    for (const p of PERMISSIONS) {
      expect(p.group).toBeTruthy();
      expect(p.label).toBeTruthy();
    }
  });

  test('every built-in role only references valid permissions', () => {
    for (const role of Object.values(BUILTIN_ROLES)) {
      for (const perm of role.permissions) {
        expect(PERMISSION_KEYS.has(perm)).toBe(true);
      }
    }
  });

  test('Admin is a strict superset of Worker', () => {
    for (const p of WORKER_PERMISSIONS) {
      expect(ADMIN_PERMISSIONS).toContain(p);
    }
  });

  test('Owner is a strict superset of Admin', () => {
    for (const p of ADMIN_PERMISSIONS) {
      expect(OWNER_PERMISSIONS).toContain(p);
    }
  });

  test('Owner-only perms exist: manage_billing, manage_admin_roles, delete_company', () => {
    expect(OWNER_PERMISSIONS).toContain('manage_billing');
    expect(OWNER_PERMISSIONS).toContain('manage_admin_roles');
    expect(OWNER_PERMISSIONS).toContain('delete_company');
    expect(ADMIN_PERMISSIONS).not.toContain('manage_billing');
    expect(ADMIN_PERMISSIONS).not.toContain('manage_admin_roles');
    expect(ADMIN_PERMISSIONS).not.toContain('delete_company');
  });

  test('Admin manages non-admin roles (manage_roles); managing admin roles is Owner-only', () => {
    expect(ADMIN_PERMISSIONS).toContain('manage_roles');       // Admin can create/edit/delete non-admin roles
    expect(OWNER_PERMISSIONS).toContain('manage_roles');       // inherited by Owner
    expect(ADMIN_PERMISSIONS).not.toContain('manage_admin_roles');
    expect(OWNER_PERMISSIONS).toContain('manage_admin_roles'); // only Owner manages admin-tier roles
  });
});

describe('hasPerm — super_admin', () => {
  beforeEach(() => pool.query.mockReset());

  test('always true, even for never-granted perms', async () => {
    const user = { id: 1, role: 'super_admin', role_id: null, admin_permissions: null };
    expect(await hasPerm(user, 'manage_billing')).toBe(true);
    expect(await hasPerm(user, 'delete_company')).toBe(true);
    expect(await hasPerm(user, 'clock_self')).toBe(true);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('hasPerm — role_id lookup', () => {
  beforeEach(() => pool.query.mockReset());

  test('returns true when perm is in role_permissions', async () => {
    pool.query.mockResolvedValueOnce({ rows: [
      { permission: 'approve_entries' },
      { permission: 'view_reports' },
    ]});
    const user = { id: 1, role: 'admin', role_id: 42, admin_permissions: null };
    expect(await hasPerm(user, 'approve_entries')).toBe(true);
  });

  test('returns false when perm is not in role_permissions', async () => {
    pool.query.mockResolvedValueOnce({ rows: [
      { permission: 'approve_entries' },
    ]});
    const user = { id: 1, role: 'admin', role_id: 42, admin_permissions: null };
    expect(await hasPerm(user, 'manage_billing')).toBe(false);
  });
});

describe('hasPerm — legacy fallback', () => {
  beforeEach(() => pool.query.mockReset());

  test('admin with null admin_permissions and no role_id → full access for legacy keys', async () => {
    const user = { id: 1, role: 'admin', role_id: null, admin_permissions: null };
    expect(await hasPerm(user, 'approve_entries')).toBe(true);
    expect(await hasPerm(user, 'manage_workers')).toBe(true);
    expect(await hasPerm(user, 'manage_projects')).toBe(true);
    expect(await hasPerm(user, 'view_reports')).toBe(true);
    expect(await hasPerm(user, 'manage_settings')).toBe(true);
  });

  test('admin with legacy JSONB tweak respects enabled keys', async () => {
    const user = {
      id: 1, role: 'admin', role_id: null,
      admin_permissions: { approve_entries: true, manage_workers: false, view_reports: true },
    };
    expect(await hasPerm(user, 'approve_entries')).toBe(true);
    expect(await hasPerm(user, 'manage_workers')).toBe(false);
    expect(await hasPerm(user, 'view_reports')).toBe(true);
  });

  test('null admin_permissions grants every Admin-tier permission, including new ones', async () => {
    // The historical "null = full access" contract means a legacy admin
    // should be able to do anything an Admin can — including new perms like
    // assign_roles and clock_self that didn't exist when their account
    // was created.
    const user = { id: 1, role: 'admin', role_id: null, admin_permissions: null };
    expect(await hasPerm(user, 'assign_roles')).toBe(true);
    expect(await hasPerm(user, 'clock_self')).toBe(true);
    expect(await hasPerm(user, 'view_workers_list')).toBe(true);
    expect(await hasPerm(user, 'manage_roles')).toBe(true); // Admin-tier now — manages non-admin roles
    // Owner-only perms still denied — those weren't part of the legacy admin.
    expect(await hasPerm(user, 'manage_billing')).toBe(false);
    expect(await hasPerm(user, 'delete_company')).toBe(false);
    expect(await hasPerm(user, 'manage_admin_roles')).toBe(false);
  });

  test('restricted legacy admin: legacy 5 + worker baseline, nothing else admin-tier', async () => {
    const user = {
      id: 1, role: 'admin', role_id: null,
      admin_permissions: { approve_entries: true },
    };
    expect(await hasPerm(user, 'approve_entries')).toBe(true);
    expect(await hasPerm(user, 'clock_self')).toBe(true); // worker baseline
    expect(await hasPerm(user, 'assign_roles')).toBe(false); // not a legacy key, not worker-tier
  });

  test('worker with no role_id has the standard Worker permissions', async () => {
    // Pre-backfill workers should be able to clock in / submit entries.
    const user = { id: 1, role: 'worker', role_id: null, admin_permissions: null };
    expect(await hasPerm(user, 'clock_self')).toBe(true);
    expect(await hasPerm(user, 'submit_time_entry_self')).toBe(true);
    expect(await hasPerm(user, 'view_projects')).toBe(true);
    // No admin-tier access
    expect(await hasPerm(user, 'manage_workers')).toBe(false);
    expect(await hasPerm(user, 'approve_entries')).toBe(false);
  });
});

describe('getUserPermissions — legacy fallback', () => {
  test('unrestricted legacy admin receives the complete Admin permission set', async () => {
    const user = { id: 1, role: 'admin', role_id: null, admin_permissions: null };
    expect(await getUserPermissions(user)).toEqual(new Set(ADMIN_PERMISSIONS));
  });

  test('restricted legacy admin receives worker baseline plus enabled legacy permissions', async () => {
    const user = {
      id: 1,
      role: 'admin',
      role_id: null,
      admin_permissions: { approve_entries: true, manage_workers: false },
    };
    const permissions = await getUserPermissions(user);
    expect(permissions.has('clock_self')).toBe(true);
    expect(permissions.has('approve_entries')).toBe(true);
    expect(permissions.has('manage_workers')).toBe(false);
  });

  test('legacy worker receives the Worker permission set', async () => {
    const user = { id: 2, role: 'worker', role_id: null };
    expect(await getUserPermissions(user)).toEqual(new Set(WORKER_PERMISSIONS));
  });
});

describe('hasPerm — unknown key', () => {
  beforeEach(() => pool.query.mockReset());

  test('throws on unknown permission key (typo guard)', async () => {
    const user = { id: 1, role: 'admin', role_id: null };
    await expect(hasPerm(user, 'definitely_not_a_real_permission')).rejects.toThrow(/Unknown permission/);
  });
});

describe('hasPerm — per-request cache', () => {
  beforeEach(() => pool.query.mockReset());

  test('two checks on the same req hit the DB once', async () => {
    pool.query.mockResolvedValueOnce({ rows: [
      { permission: 'approve_entries' },
      { permission: 'view_reports' },
    ]});
    const req = {
      user: { id: 1, role: 'admin', role_id: 42, admin_permissions: null },
      headers: { authorization: 'Bearer x' },
    };
    await hasPerm(req, 'approve_entries');
    await hasPerm(req, 'view_reports');
    await hasPerm(req, 'manage_billing');
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

describe('requirePerm middleware', () => {
  beforeEach(() => pool.query.mockReset());

  function makeRes() {
    const res = { statusCode: null, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
  }

  test('calls next() when permission granted', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ permission: 'approve_entries' }] });
    const req = {
      user: { id: 1, role: 'admin', role_id: 1, admin_permissions: null },
      headers: { authorization: 'Bearer x' },
    };
    const res = makeRes();
    const next = jest.fn();
    await requirePerm('approve_entries')(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });

  test('returns 403 with required key when denied', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const req = {
      user: { id: 1, role: 'admin', role_id: 1, admin_permissions: null },
      headers: { authorization: 'Bearer x' },
    };
    const res = makeRes();
    const next = jest.fn();
    await requirePerm('manage_billing')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.required).toBe('manage_billing');
    expect(res.body.code).toBe('permission_denied');
  });

  test('returns 500 on unknown permission key', async () => {
    const req = {
      user: { id: 1, role: 'admin', role_id: 1 },
      headers: { authorization: 'Bearer x' },
    };
    const res = makeRes();
    const next = jest.fn();
    await requirePerm('not_a_real_perm')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
  });
});
