/**
 * Roles & permissions — source of truth for the permission catalog, the
 * built-in role defaults, and the server-side permission resolver.
 *
 * Phase A: this module is additive. Existing routes still use
 * `requirePermission` (legacy 5-key admin_permissions check) from
 * middleware/auth.js. New code can use `requirePerm` here, which falls back
 * to the legacy check when the user has no role_id yet (pre-backfill or
 * super_admin). Phase C will switch all routes and drop the legacy path.
 *
 * Permission design:
 *  - Rows in role_permissions represent GRANTED permissions; absence = denied.
 *  - Every gateable action is a single permission key here.
 *  - Legacy admin_permissions keys map one-to-one to new permission keys
 *    (approve_entries, manage_workers, manage_projects, view_reports,
 *    manage_settings). This lets hasPerm fall back when role_id is null.
 *  - super_admin always passes regardless of role_id.
 */

const pool = require('./db');

// ── Permission catalog ────────────────────────────────────────────────────────
// Grouped for future UI layout. Each entry: { key, group, label }.
// Adding a permission: append here AND add to any built-in role that should
// grant it AND add a migration that inserts it into existing role_permissions
// rows for that built-in (custom roles snapshot at creation — they do NOT
// auto-gain new permissions, by design).

const PERMISSIONS = [
  // Time & attendance
  { key: 'clock_self', group: 'time', label: 'Clock self in/out' },
  { key: 'submit_time_entry_self', group: 'time', label: 'Submit own time entry' },
  { key: 'edit_own_pending_entry', group: 'time', label: 'Edit own pending entry' },
  { key: 'view_own_entries', group: 'time', label: 'View own time history' },
  { key: 'clock_in_others', group: 'time', label: 'Clock workers in/out on their behalf' },
  { key: 'edit_any_entry', group: 'time', label: 'Edit any time entry' },
  { key: 'approve_entries', group: 'time', label: 'Approve / reject / unlock entries' },
  { key: 'manage_pay_periods', group: 'time', label: 'Lock pay periods' },

  // Workers & roles
  { key: 'view_workers_list', group: 'workers', label: 'See company directory' },
  { key: 'view_worker_wages', group: 'workers', label: 'See other workers\' pay rates' },
  { key: 'manage_workers', group: 'workers', label: 'Invite / edit / remove workers' },
  { key: 'manage_roles', group: 'workers', label: 'Create / edit / delete roles' },
  { key: 'manage_admin_roles', group: 'workers', label: 'Create / edit / delete admin roles' },
  { key: 'assign_roles', group: 'workers', label: 'Assign a role to a user' },

  // Projects
  { key: 'view_projects', group: 'projects', label: 'See project list' },
  { key: 'manage_projects', group: 'projects', label: 'Create / edit / archive / merge projects' },
  { key: 'manage_project_visibility', group: 'projects', label: 'Change project visibility' },

  // Reports & analytics
  { key: 'view_reports', group: 'reports', label: 'Dashboards, exports, overtime' },
  { key: 'view_analytics', group: 'reports', label: 'Analytics dashboard' },
  { key: 'view_certified_payroll', group: 'reports', label: 'WH-347 certified payroll' },
  { key: 'export_data', group: 'reports', label: 'CSV / ZIP exports' },

  // Reimbursements & billing
  { key: 'submit_reimbursement_self', group: 'money', label: 'Submit own expense' },
  { key: 'view_own_reimbursements', group: 'money', label: 'Own expense history' },
  { key: 'manage_reimbursements', group: 'money', label: 'Approve / categorize reimbursements' },
  { key: 'manage_billing', group: 'money', label: 'Stripe checkout / portal / plan changes' },

  // Field modules
  { key: 'submit_field_reports', group: 'field', label: 'Submit field reports' },
  { key: 'manage_punchlist', group: 'field', label: 'Punchlist items' },
  { key: 'manage_rfis', group: 'field', label: 'RFIs' },
  { key: 'manage_safety_checklists', group: 'field', label: 'Safety checklists' },
  { key: 'manage_incidents', group: 'field', label: 'Incident reports' },
  { key: 'manage_inspections', group: 'field', label: 'Inspections' },
  { key: 'manage_haul_tickets', group: 'field', label: 'Production / haul tickets' },
  { key: 'daily_checklist_start_day', group: 'field', label: 'Daily checklist — start a day' },
  { key: 'daily_checklist_check_items', group: 'field', label: 'Daily checklist — check items' },
  { key: 'daily_checklist_manage_recurring', group: 'field', label: 'Daily checklist — recurring setup' },
  { key: 'daily_checklist_complete_day', group: 'field', label: 'Daily checklist — complete a day' },

  // Inventory
  { key: 'view_inventory', group: 'inventory', label: 'View inventory' },
  { key: 'manage_inventory', group: 'inventory', label: 'Manage inventory' },
  // Equipment tracking moved from Field into the Inventory module.
  { key: 'manage_equipment', group: 'inventory', label: 'Equipment' },

  // Company
  { key: 'manage_settings', group: 'company', label: 'Edit company settings' },
  { key: 'manage_advanced_settings', group: 'company', label: 'Advanced settings (categories, etc.)' },
  { key: 'manage_integrations', group: 'company', label: 'QBO, email, etc.' },
  { key: 'send_broadcast', group: 'company', label: 'Send broadcast messages' },
  { key: 'delete_company', group: 'company', label: 'Delete the company' },

  // Communication
  { key: 'view_company_chat', group: 'chat', label: 'Read company chat' },
  { key: 'send_company_chat', group: 'chat', label: 'Post to company chat' },
];

const PERMISSION_KEYS = new Set(PERMISSIONS.map(p => p.key));

// ── Built-in role defaults ────────────────────────────────────────────────────
// These are seeded per company at migration time and when a company is
// created via the register flow. `parent_role` is what a custom role derived
// from this role will fall back to on deletion (must be 'worker' or 'admin').

const WORKER_PERMISSIONS = [
  'clock_self',
  'submit_time_entry_self',
  'edit_own_pending_entry',
  'view_own_entries',
  'view_projects',
  'submit_reimbursement_self',
  'view_own_reimbursements',
  'submit_field_reports',
  'manage_punchlist',
  'manage_rfis',
  'manage_safety_checklists',
  'manage_equipment',
  'manage_incidents',
  'manage_inspections',
  'manage_haul_tickets',
  'daily_checklist_start_day',
  'daily_checklist_check_items',
  'view_inventory',
  'view_company_chat',
  'send_company_chat',
];

// Admin: Worker's set plus admin-specific, minus Owner-only
// (manage_billing, manage_admin_roles, delete_company). Admin CAN create/edit/delete
// non-admin (worker-tier) roles via manage_roles; managing ADMIN-tier roles is gated
// separately by manage_admin_roles (Owner-only) at the /roles endpoints.
const ADMIN_PERMISSIONS = [
  ...WORKER_PERMISSIONS,
  'clock_in_others',
  'edit_any_entry',
  'approve_entries',
  'manage_pay_periods',
  'view_workers_list',
  'view_worker_wages',
  'manage_workers',
  'manage_roles',
  'assign_roles',
  'manage_projects',
  'manage_project_visibility',
  'view_reports',
  'view_analytics',
  'view_certified_payroll',
  'export_data',
  'manage_reimbursements',
  'manage_settings',
  'manage_advanced_settings',
  'manage_integrations',
  'send_broadcast',
  'manage_inventory',
  'daily_checklist_manage_recurring',
  'daily_checklist_complete_day',
];

// Owner: everything. manage_roles is inherited from ADMIN; Owner additionally gets
// manage_admin_roles (create/edit/delete ADMIN-tier roles), manage_billing, delete_company.
const OWNER_PERMISSIONS = [
  ...ADMIN_PERMISSIONS,
  'manage_billing',
  'manage_admin_roles',
  'delete_company',
];

const BUILTIN_ROLES = {
  worker: {
    name: 'Worker',
    description: 'Standard worker — can clock in/out, submit entries, field work.',
    parent_role: 'worker',
    permissions: WORKER_PERMISSIONS,
  },
  admin: {
    name: 'Admin',
    description: 'Company admin — manages workers, projects, approvals, settings.',
    parent_role: 'admin',
    permissions: ADMIN_PERMISSIONS,
  },
  owner: {
    name: 'Owner',
    description: 'Company owner — full access including billing and role management.',
    parent_role: 'admin',
    permissions: OWNER_PERMISSIONS,
  },
};

// Mapping from the legacy 5-key admin_permissions object to new permission keys.
// Used by the fallback in hasPerm and the Phase B UI when migrating legacy
// tweaks to custom roles.
const LEGACY_TO_NEW = {
  approve_entries: 'approve_entries',
  manage_workers: 'manage_workers',
  manage_projects: 'manage_projects',
  view_reports: 'view_reports',
  manage_settings: 'manage_settings',
};

// ── Permission resolver ───────────────────────────────────────────────────────

/**
 * Returns true if the user has the given permission.
 *
 * Resolution order:
 *  1. super_admin: always true.
 *  2. user.role_id set: look up role_permissions for that role.
 *     Cached per-request on req._permissions once computed.
 *  3. role_id null + legacy mapping exists: fall back to admin_permissions
 *     JSONB check (null = full access if user is admin).
 *  4. Otherwise: deny.
 *
 * Accepts either a plain user object (from JWT) or a req so it can cache.
 */
async function hasPerm(userOrReq, key) {
  if (!PERMISSION_KEYS.has(key)) {
    // Typo guard — refuse unknown keys instead of silently denying.
    throw new Error(`Unknown permission: ${key}`);
  }
  const isReq = userOrReq && userOrReq.user && userOrReq.headers;
  const user = isReq ? userOrReq.user : userOrReq;
  if (!user) return false;
  if (user.role === 'super_admin') return true;

  // Per-request cache to avoid re-querying on every check in a single request.
  if (isReq && userOrReq._permissions) {
    return userOrReq._permissions.has(key);
  }

  if (user.role_id) {
    const { rows } = await pool.query(
      'SELECT permission FROM role_permissions WHERE role_id = $1',
      [user.role_id]
    );
    const set = new Set(rows.map(r => r.permission));
    if (isReq) userOrReq._permissions = set;
    return set.has(key);
  }

  // Legacy fallback — user predates the roles rollout (or was created by an
  // older endpoint that didn't set role_id). Map their legacy admin_permissions
  // to the new permission catalog:
  //   - admin with NULL admin_permissions = full admin (matches the historical
  //     "null = full access" contract). Granted: every key in ADMIN_PERMISSIONS.
  //   - admin with restricted admin_permissions = legacy 5 keys + worker baseline.
  //   - worker = baseline worker permissions.
  if (user.role === 'admin') {
    if (!user.admin_permissions) {
      return ADMIN_PERMISSIONS.includes(key);
    }
    const legacyKey = Object.keys(LEGACY_TO_NEW).find(lk => LEGACY_TO_NEW[lk] === key);
    if (legacyKey) return user.admin_permissions[legacyKey] === true;
    // Non-legacy perm for a restricted admin: grant if it's a worker-tier
    // perm (everyone has those by virtue of being in the company), otherwise deny.
    return WORKER_PERMISSIONS.includes(key);
  }
  if (user.role === 'worker') {
    return WORKER_PERMISSIONS.includes(key);
  }
  return false;
}

/**
 * Middleware factory — require a specific permission.
 * 403 with `{ error, required }` on deny.
 */
function requirePerm(key) {
  return async (req, res, next) => {
    try {
      const ok = await hasPerm(req, key);
      if (!ok) {
        return res.status(403).json({
          error: 'Insufficient permissions',
          code: 'permission_denied',
          required: key,
        });
      }
      next();
    } catch (err) {
      // Unknown key or DB error — fail closed for safety.
      return res.status(500).json({ error: 'Permission check failed' });
    }
  };
}

/**
 * Return the user's full effective permission set as a Set<string>.
 * Used by the roles management endpoints to (a) display what permissions
 * a role grants and (b) prevent a non-Owner with manage_roles from
 * escalating by granting permissions they don't themselves hold.
 *
 * super_admin gets the entire catalog (matches hasPerm's short-circuit).
 * Falls back to the legacy admin_permissions translation when role_id
 * is null, same as hasPerm.
 */
async function getUserPermissions(user) {
  if (!user) return new Set();
  if (user.role === 'super_admin') return new Set(PERMISSIONS.map(p => p.key));
  if (user.role_id) {
    const { rows } = await pool.query(
      'SELECT permission FROM role_permissions WHERE role_id = $1',
      [user.role_id]
    );
    return new Set(rows.map(r => r.permission));
  }
  // Legacy: admin with null admin_permissions → all legacy keys are granted
  // (which translates to the new keys via LEGACY_TO_NEW).
  if (user.role === 'admin') {
    if (!user.admin_permissions) {
      return new Set(ADMIN_PERMISSIONS);
    }
    const granted = new Set(WORKER_PERMISSIONS);
    for (const [legacyKey, newKey] of Object.entries(LEGACY_TO_NEW)) {
      if (user.admin_permissions[legacyKey] === true) granted.add(newKey);
    }
    return granted;
  }
  if (user.role === 'worker') return new Set(WORKER_PERMISSIONS);
  return new Set();
}

/**
 * Seed the three built-in roles (Worker / Admin / Owner) and their
 * permissions for a newly-created company. Idempotent — safe to call on a
 * company that already has them. Runs in whatever client/transaction is
 * passed in so the caller controls atomicity.
 *
 * Returns { workerId, adminId, ownerId } so the caller can immediately
 * assign role_id to the first user.
 */
async function seedBuiltinRoles(client, companyId) {
  const ids = {};
  for (const [slug, spec] of Object.entries(BUILTIN_ROLES)) {
    const r = await client.query(
      `INSERT INTO roles (company_id, name, description, is_builtin, parent_role)
       VALUES ($1, $2, $3, true, $4)
       ON CONFLICT (company_id, name) DO UPDATE
         SET description = EXCLUDED.description
       RETURNING id`,
      [companyId, spec.name, spec.description, spec.parent_role]
    );
    const roleId = r.rows[0].id;
    ids[`${slug}Id`] = roleId;
    // Seed permissions (idempotent via PK).
    for (const perm of spec.permissions) {
      await client.query(
        `INSERT INTO role_permissions (role_id, permission)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [roleId, perm]
      );
    }
  }
  return ids;
}

module.exports = {
  PERMISSIONS,
  PERMISSION_KEYS,
  BUILTIN_ROLES,
  WORKER_PERMISSIONS,
  ADMIN_PERMISSIONS,
  OWNER_PERMISSIONS,
  LEGACY_TO_NEW,
  hasPerm,
  requirePerm,
  seedBuiltinRoles,
  getUserPermissions,
};
