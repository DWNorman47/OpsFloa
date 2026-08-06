-- Grant the Daily Checklist "schedule days ahead" permission (the day manager) to the
-- admin-tier built-in roles. Worker crews start/check the day; preparing days ahead is an
-- admin action. Custom roles snapshot at creation and don't auto-gain it. Idempotent.

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, 'daily_checklist_schedule_days'
FROM roles r
WHERE r.is_builtin = true AND r.name IN ('Admin', 'Owner')
ON CONFLICT DO NOTHING;
