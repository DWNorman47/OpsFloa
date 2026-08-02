-- Split role management into two permissions:
--   manage_roles        — create/edit/delete NON-admin (worker-tier) roles  → Admin + Owner
--   manage_admin_roles  — create/edit/delete ADMIN-tier roles               → Owner only
-- Previously manage_roles was Owner-only. Grant the new defaults to the built-in roles on
-- existing companies (new companies seed from server/permissions.js). Custom roles snapshot
-- at creation and do NOT auto-gain new permissions, by design. Idempotent via ON CONFLICT.

-- Admin (and Owner, harmlessly) gains manage_roles — manage non-admin roles.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'manage_roles'
FROM roles r
WHERE r.is_builtin = true AND r.name IN ('Admin', 'Owner')
ON CONFLICT DO NOTHING;

-- Owner gains manage_admin_roles — manage admin-tier roles.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'manage_admin_roles'
FROM roles r
WHERE r.is_builtin = true AND r.name = 'Owner'
ON CONFLICT DO NOTHING;
