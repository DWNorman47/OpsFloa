-- Grant the Daily Checklist permissions to the built-in roles (see permissions.js).
-- start_day + check_items are worker-tier (crews start the day and check items);
-- manage_recurring + complete_day are admin-tier. Custom roles snapshot at creation
-- and do NOT auto-gain new permissions, by design. Idempotent via ON CONFLICT.

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.perm
FROM roles r
CROSS JOIN (VALUES ('daily_checklist_start_day'), ('daily_checklist_check_items')) AS p(perm)
WHERE r.is_builtin = true AND r.name IN ('Worker', 'Admin', 'Owner')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.perm
FROM roles r
CROSS JOIN (VALUES ('daily_checklist_manage_recurring'), ('daily_checklist_complete_day')) AS p(perm)
WHERE r.is_builtin = true AND r.name IN ('Admin', 'Owner')
ON CONFLICT DO NOTHING;
