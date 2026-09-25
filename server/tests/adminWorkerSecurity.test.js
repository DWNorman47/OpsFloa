/**
 * Worker-management security (review findings):
 *   - PATCH /admin/workers/:id is a manage_workers route; it must not change a
 *     role without assign_roles (and then only through the shared role path with
 *     its escalation / Owner / last-Owner guards), nor re-point the email of a
 *     user who outranks the caller (Owner takeover via forgot-password). An email
 *     change notifies the old address.
 *   - Re-sent invites store sha256(token) so /auth/accept-invite (which looks up
 *     the hash) actually accepts them — full resend → accept path.
 *   - Invite emails escape user-controlled names.
 *   - PATCH /admin/workers/:id/role: only an Owner-tier caller may demote an
 *     Owner; a super_admin account's role is never changed from a tenant screen.
 */

let mockCurrentUser;
let mockPerms;

jest.mock('../middleware/auth', () => ({
  ...jest.requireActual('../middleware/auth'),
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
jest.mock('../permissions', () => {
  const actual = jest.requireActual('../permissions');
  return {
    ...actual,
    // Caller perms are driven by the test; a TARGET's perms (no `id`) resolve
    // from its role_id via the helper below.
    getUserPermissions: jest.fn(async (u) => (u && u.id != null ? mockPerms : mockTargetPerms(u))),
  };
});
jest.mock('../db', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../auditLog', () => ({ logAudit: jest.fn() }));
jest.mock('../push', () => ({ sendPushToUser: jest.fn(), sendPushToAllWorkers: jest.fn(), sendPushToCompanyAdmins: jest.fn() }));
jest.mock('../email', () => ({ sendEmail: jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock('../services/qbo', () => ({}));
jest.mock('../routes/inbox', () => ({ createInboxItem: jest.fn(), createInboxItemBatch: jest.fn() }));
jest.mock('../r2', () => ({ getPresignedUploadUrl: jest.fn() }));
jest.mock('bcryptjs', () => ({ hash: jest.fn().mockResolvedValue('hashed-pw'), compare: jest.fn() }));

const OWNER_ROLE_ID = 200;
const CUSTOM_BOSS_ROLE_ID = 300; // custom role (not named Owner) carrying owner-level perms
function mockTargetPerms(u) {
  const { OWNER_PERMISSIONS, BUILTIN_ROLES } = jest.requireActual('../permissions');
  if (u && u.role_id === OWNER_ROLE_ID) return new Set(OWNER_PERMISSIONS);
  if (u && u.role_id === CUSTOM_BOSS_ROLE_ID) return new Set([...BUILTIN_ROLES.admin.permissions, 'manage_billing', 'delete_company']);
  return new Set(BUILTIN_ROLES.worker.permissions);
}

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const pool = require('../db');
const { sendEmail } = require('../email');
const { OWNER_PERMISSIONS, BUILTIN_ROLES } = require('../permissions');
const adminRoute = require('../routes/admin');
const authRoute = require('../routes/auth');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.log = { error: jest.fn(), warn: jest.fn() }; next(); });
  app.use('/api/admin', adminRoute);
  app.use('/api/auth', authRoute);
  return app;
}

const ADMIN_PERMS = new Set(BUILTIN_ROLES.admin.permissions);                           // has assign_roles
const MANAGER_PERMS = new Set([...ADMIN_PERMS].filter(p => p !== 'assign_roles'));        // manage_workers only

beforeEach(() => {
  pool.query.mockReset();
  sendEmail.mockClear();
  mockCurrentUser = { id: 1, company_id: 'co-1', role: 'admin', role_id: 100, full_name: 'Mallory <script>', company_name: 'Acme' };
  mockPerms = MANAGER_PERMS;
});

const sqlCalls = re => pool.query.mock.calls.filter(([sql]) => re.test(sql));

describe('PATCH /admin/workers/:id — role field', () => {
  test('a real role change without assign_roles → 403, nothing written', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 9, role: 'worker', role_id: 75, email: 'w@x.co' }] });
    const res = await request(makeApp()).patch('/api/admin/workers/9').send({ role: 'admin' });
    expect(res.status).toBe(403);
    expect(res.body.required).toBe('assign_roles');
    expect(sqlCalls(/^UPDATE users/)).toHaveLength(0);
  });

  test('re-sending the CURRENT role (whole-form save) is a no-op and needs no assign_roles', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 9, role: 'worker', role_id: 75, email: 'w@x.co' }] })
      .mockResolvedValue({ rows: [{ id: 9, full_name: 'W' }], rowCount: 1 });
    const res = await request(makeApp()).patch('/api/admin/workers/9').send({ role: 'worker', full_name: 'W' });
    expect(res.status).toBe(200);
    const upd = sqlCalls(/^UPDATE users SET/)[0][0];
    expect(upd).not.toMatch(/\brole\s*=/);
    expect(upd).not.toMatch(/token_version/);
  });

  test('with assign_roles the change goes through the shared role path (builtin role + guards)', async () => {
    mockPerms = ADMIN_PERMS;
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 9, role: 'worker', role_id: 75, email: 'w@x.co' }] })                     // target
      .mockResolvedValueOnce({ rows: [{ id: 100 }] })                                                                  // builtin Admin role id
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 100, name: 'Admin', parent_role: 'admin', is_builtin: true }] }) // assignRoleToUser: role
      .mockResolvedValueOnce({ rows: BUILTIN_ROLES.admin.permissions.map(permission => ({ permission })) })             // role perms
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 9, current_legacy_role: 'worker', current_role_name: 'Worker', current_role_builtin: true }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })                                                                // role UPDATE
      .mockResolvedValue({ rows: [{ id: 9, full_name: 'W' }], rowCount: 1 });                                           // field UPDATE
    const res = await request(makeApp()).patch('/api/admin/workers/9').send({ role: 'admin' });
    expect(res.status).toBe(200);
    const roleUpd = sqlCalls(/^UPDATE users SET role_id = \$1, role = \$2, token_version/);
    expect(roleUpd).toHaveLength(1);
    expect(roleUpd[0][1]).toEqual([100, 'admin', 9]);
  });

  test('an Admin (assign_roles, not Owner-tier) cannot demote an Owner via the legacy field', async () => {
    mockPerms = ADMIN_PERMS;
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 2, role: 'admin', role_id: OWNER_ROLE_ID, email: 'o@x.co' }] })
      .mockResolvedValueOnce({ rows: [{ id: 50 }] })                                                                   // builtin Worker role
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 50, name: 'Worker', parent_role: 'worker', is_builtin: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 2, current_legacy_role: 'admin', current_role_name: 'Owner', current_role_builtin: true }] });
    const res = await request(makeApp()).patch('/api/admin/workers/2').send({ role: 'worker' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('owner_protected');
    expect(sqlCalls(/^UPDATE users/)).toHaveLength(0);
  });
});

describe('PATCH /admin/workers/:id — email field', () => {
  test("a manage_workers admin cannot re-point an Owner's email (reset-link takeover)", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 2, role: 'admin', role_id: OWNER_ROLE_ID, email: 'owner@acme.co' }] });
    const res = await request(makeApp()).patch('/api/admin/workers/2').send({ email: 'attacker@evil.co' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('email_change_forbidden');
    expect(sqlCalls(/^UPDATE users/)).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test("nobody but a super_admin can change a super_admin's email", async () => {
    mockPerms = new Set(OWNER_PERMISSIONS);
    pool.query.mockResolvedValueOnce({ rows: [{ id: 3, role: 'super_admin', email: 'root@opsfloa.com' }] });
    const res = await request(makeApp()).patch('/api/admin/workers/3').send({ email: 'x@evil.co' });
    expect(res.status).toBe(403);
  });

  test('an Owner may change it, and the OLD address is notified (escaped)', async () => {
    mockPerms = new Set(OWNER_PERMISSIONS);
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 2, role: 'admin', role_id: OWNER_ROLE_ID, email: 'owner@acme.co', full_name: 'Olive', username: 'olive' }] })
      .mockResolvedValue({ rows: [{ id: 2, full_name: 'Olive' }], rowCount: 1 });
    const res = await request(makeApp()).patch('/api/admin/workers/2').send({ email: 'olive@new.co' });
    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [to, , html] = sendEmail.mock.calls[0];
    expect(to).toBe('owner@acme.co');
    expect(html).toContain('Mallory &lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  test("changing a plain worker's email is still allowed for manage_workers (and notifies)", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 9, role: 'worker', role_id: 75, email: 'old@x.co' }] })
      .mockResolvedValue({ rows: [{ id: 9 }], rowCount: 1 });
    const res = await request(makeApp()).patch('/api/admin/workers/9').send({ email: 'new@x.co' });
    expect(res.status).toBe(200);
    expect(sendEmail.mock.calls[0][0]).toBe('old@x.co');
  });

  test('unchanged email (whole-form save) sends nothing', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 2, role: 'admin', role_id: OWNER_ROLE_ID, email: 'Owner@Acme.co' }] })
      .mockResolvedValue({ rows: [{ id: 2 }], rowCount: 1 });
    const res = await request(makeApp()).patch('/api/admin/workers/2').send({ email: 'owner@acme.co', full_name: 'Olive' });
    expect(res.status).toBe(200);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('re-sent invite → accept', () => {
  test('send-invite stores sha256(token) and the emailed link is accepted by /auth/accept-invite', async () => {
    let stored = null;
    pool.query.mockImplementation(async (sql, params) => {
      if (/^SELECT id, full_name, username, email, must_change_password, invite_pending FROM users/.test(sql)) {
        return { rowCount: 1, rows: [{ id: 9, full_name: 'Ann <b>', username: 'ann', email: 'ann@x.co', must_change_password: true }] };
      }
      if (/^UPDATE users SET invite_token = \$1/.test(sql)) { stored = params[0]; return { rowCount: 1, rows: [] }; }
      if (/WHERE u\.invite_token = \$1/.test(sql)) {
        return params[0] === stored
          ? { rowCount: 1, rows: [{ id: 9, username: 'ann', company_id: 'co-1', company_name: 'Acme' }] }
          : { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    });
    const app = makeApp();
    const sent = await request(app).post('/api/admin/workers/9/send-invite');
    expect(sent.status).toBe(200);
    expect(sent.body.email_sent).toBe(true);

    const html = sendEmail.mock.calls[0][2];
    const raw = /accept-invite\?token=([0-9a-f]{64})/.exec(html)[1];
    expect(stored).toBe(crypto.createHash('sha256').update(raw).digest('hex'));
    expect(stored).not.toBe(raw);
    expect(html).toContain('Ann &lt;b&gt;');
    expect(html).toContain('Mallory &lt;script&gt;');

    const accepted = await request(app).post('/api/auth/accept-invite').send({ token: raw, password: 'totally-fine-password' });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ success: true, username: 'ann', company_name: 'Acme' });
  });
});

describe('POST /admin/workers/invite — email escaping', () => {
  test('full_name and inviter name are escaped', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ plan: 'business', subscription_status: 'active', trial_ends_at: null }] }) // worker limit
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })                                                          // username free
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 35 }] })                                                // default role
      .mockResolvedValue({ rowCount: 1, rows: [{ id: 22, username: 'aevil' }] });
    const res = await request(makeApp()).post('/api/admin/workers/invite')
      .send({ full_name: 'A <img src=x onerror=alert(1)> Evil', email: 'a@x.co', role: 'worker' });
    expect(res.status).toBe(201);
    const html = sendEmail.mock.calls[0][2];
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('Mallory &lt;script&gt;');
  });
});

describe('PATCH /admin/workers/:id/role — protected targets', () => {
  test('non-Owner-tier caller cannot move an Owner off the Owner role', async () => {
    mockPerms = ADMIN_PERMS;
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 100, name: 'Admin', parent_role: 'admin', is_builtin: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 2, current_legacy_role: 'admin', current_role_name: 'Owner', current_role_builtin: true }] });
    const res = await request(makeApp()).patch('/api/admin/workers/2/role').send({ role_id: 100 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('owner_protected');
  });

  test("a super_admin account's role can't be changed by a tenant admin", async () => {
    mockPerms = new Set(OWNER_PERMISSIONS);
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 50, name: 'Worker', parent_role: 'worker', is_builtin: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 3, current_legacy_role: 'super_admin', current_role_name: null }] });
    const res = await request(makeApp()).patch('/api/admin/workers/3/role').send({ role_id: 50 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('protected_account');
    expect(sqlCalls(/^UPDATE users/)).toHaveLength(0);
  });
});

describe('role changes — outranks guard (by permissions, not role name)', () => {
  test('an Admin with assign_roles cannot demote a CUSTOM role holding owner-level perms', async () => {
    mockPerms = ADMIN_PERMS;
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 50, name: 'Worker', parent_role: 'worker', is_builtin: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 4, current_legacy_role: 'admin', current_role_id: CUSTOM_BOSS_ROLE_ID, current_role_name: 'Partner', current_role_builtin: false }] });
    const res = await request(makeApp()).patch('/api/admin/workers/4/role').send({ role_id: 50 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('owner_protected');
    expect(sqlCalls(/^UPDATE users/)).toHaveLength(0);
  });

  test('an Owner-tier caller may change that custom role', async () => {
    mockPerms = new Set(OWNER_PERMISSIONS);
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 50, name: 'Worker', parent_role: 'worker', is_builtin: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 4, current_legacy_role: 'admin', current_role_id: CUSTOM_BOSS_ROLE_ID, current_role_name: 'Partner', current_role_builtin: false }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const res = await request(makeApp()).patch('/api/admin/workers/4/role').send({ role_id: 50 });
    expect(res.status).toBe(200);
    expect(sqlCalls(/^UPDATE users SET role_id/)).toHaveLength(1);
  });
});

describe('PATCH /admin/workers/:id — rate + rejected role change', () => {
  const rateStore = require('../utils/rateHistoryStore');
  afterEach(() => jest.restoreAllMocks());

  test('the role guard runs BEFORE the rate-history write: rejected role → no rate row', async () => {
    mockPerms = ADMIN_PERMS;
    jest.spyOn(rateStore, 'readCache').mockResolvedValue({ rate: 20, rate_type: 'hourly' });
    jest.spyOn(rateStore, 'companyToday').mockResolvedValue('2026-09-24');
    const addChange = jest.spyOn(rateStore, 'addChange').mockResolvedValue({ previous: null, lockedPeriods: [] });
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 2, role: 'admin', role_id: OWNER_ROLE_ID, email: 'o@x.co' }] })            // target
      .mockResolvedValueOnce({ rows: [{ id: 50 }] })                                                                   // builtin Worker role
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 50, name: 'Worker', parent_role: 'worker', is_builtin: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 2, current_legacy_role: 'admin', current_role_id: OWNER_ROLE_ID, current_role_name: 'Owner', current_role_builtin: true }] });
    const res = await request(makeApp()).patch('/api/admin/workers/2').send({ role: 'worker', hourly_rate: 35 });
    expect(res.status).toBe(403);
    expect(addChange).not.toHaveBeenCalled();
    expect(sqlCalls(/^UPDATE users/)).toHaveLength(0);
  });
});

describe('PATCH /admin/workers/:id/role — worker-tier perms added later do not "outrank"', () => {
  // A custom admin role created before manage_haul_tickets / daily_checklist_* existed
  // lacks them; every built-in Worker has them. Only admin-tier / owner-only perms
  // count for the outranks + escalation subset tests.
  const LATER_WORKER_PERMS = ['manage_haul_tickets', 'daily_checklist_start_day', 'daily_checklist_check_items'];
  const OLD_CUSTOM_ADMIN = new Set([...ADMIN_PERMS].filter(p => !LATER_WORKER_PERMS.includes(p)));

  test('can move a Worker to a custom Foreman role', async () => {
    mockPerms = OLD_CUSTOM_ADMIN;
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 400, name: 'Foreman', parent_role: 'worker', is_builtin: false }] })
      .mockResolvedValueOnce({ rows: [{ permission: 'clock_self' }, { permission: 'view_projects' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 9, current_legacy_role: 'worker', current_role_id: 75, current_role_name: 'Worker', current_role_builtin: true }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const res = await request(makeApp()).patch('/api/admin/workers/9/role').send({ role_id: 400 });
    expect(res.status).toBe(200);
    expect(sqlCalls(/^UPDATE users SET role_id/)).toHaveLength(1);
  });

  test('can assign the built-in Worker role (its later-added worker perms are not escalation)', async () => {
    mockPerms = OLD_CUSTOM_ADMIN;
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 50, name: 'Worker', parent_role: 'worker', is_builtin: true }] })
      .mockResolvedValueOnce({ rows: BUILTIN_ROLES.worker.permissions.map(permission => ({ permission })) })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 9, current_legacy_role: 'worker', current_role_id: 400, current_role_name: 'Foreman', current_role_builtin: false }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const res = await request(makeApp()).patch('/api/admin/workers/9/role').send({ role_id: 50 });
    expect(res.status).toBe(200);
  });

  test('an admin-tier perm the caller lacks still outranks', async () => {
    mockPerms = new Set([...OLD_CUSTOM_ADMIN].filter(p => p !== 'manage_pay_periods'));
    pool.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 400, name: 'Foreman', parent_role: 'worker', is_builtin: false }] })
      .mockResolvedValueOnce({ rows: [{ permission: 'clock_self' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 4, current_legacy_role: 'admin', current_role_id: 100, current_role_name: 'Admin', current_role_builtin: true }] });
    // target resolves to the worker set by default — give it the admin set:
    const perms = require('../permissions');
    perms.getUserPermissions.mockImplementationOnce(async () => mockPerms)                      // caller
      .mockImplementationOnce(async () => new Set(BUILTIN_ROLES.admin.permissions));            // target
    const res = await request(makeApp()).patch('/api/admin/workers/4/role').send({ role_id: 400 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('owner_protected');
  });
});
