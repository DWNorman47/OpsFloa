-- migrate:no-transaction (manages its own BEGIN/COMMIT)
-- Merge clock_in_self + clock_out_self into a single clock_self permission.
-- Original design split them by mistake — a worker who can clock in but not
-- out gets stuck clocked in forever, which is worse than not being able to
-- clock at all.
--
-- For every role that had EITHER of the old keys, grant clock_self. Then
-- delete the old rows. Idempotent: if the keys aren't present (fresh
-- install via the updated 0089), the migration is a no-op.

BEGIN;

INSERT INTO role_permissions (role_id, permission)
SELECT DISTINCT role_id, 'clock_self'
FROM role_permissions
WHERE permission IN ('clock_in_self', 'clock_out_self')
ON CONFLICT DO NOTHING;

DELETE FROM role_permissions
WHERE permission IN ('clock_in_self', 'clock_out_self');

COMMIT;
