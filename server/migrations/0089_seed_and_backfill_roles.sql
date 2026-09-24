-- migrate:no-transaction (manages its own BEGIN/COMMIT)
-- Phase A backfill: seed built-in roles per company + assign role_id to
-- every user. Idempotent — safe to re-run. Runs after 0088 creates the tables.
--
-- Algorithm:
--   1. INSERT Worker / Admin / Owner built-ins for every company that
--      doesn't have them. Permissions inserted via ON CONFLICT DO NOTHING.
--   2. Workers → Worker role_id.
--   3. Admins with null admin_permissions: oldest admin per company → Owner,
--      the rest → Admin. ("Oldest" = lowest created_at.)
--   4. Admins with non-null admin_permissions: group by unique permission
--      signature, create one custom role per (company, signature), assign
--      the admin to it. The role's permissions match the legacy JSONB keys
--      (where value = true), mapped through the legacy→new translation.
--      Custom role name: 'Custom Admin 1', 'Custom Admin 2', ... per company.
--      Description records the original signature for audit.
--   5. super_admin users: left with role_id = NULL by design (system role,
--      not company-scoped).
--
-- This migration does NOT touch the existing users.role or users.admin_permissions
-- columns. Those stay populated so the legacy fallback in hasPerm() keeps
-- working for any code that still reads them. Phase C removes them.

BEGIN;

-- ── Step 1: Seed built-in roles per company ──────────────────────────────────

INSERT INTO roles (company_id, name, description, is_builtin, parent_role)
SELECT c.id, b.name, b.description, true, b.parent_role
FROM companies c
CROSS JOIN (VALUES
  ('Worker', 'Standard worker — can clock in/out, submit entries, field work.', 'worker'),
  ('Admin',  'Company admin — manages workers, projects, approvals, settings.', 'admin'),
  ('Owner',  'Company owner — full access including billing and role management.', 'admin')
) AS b(name, description, parent_role)
WHERE NOT EXISTS (
  SELECT 1 FROM roles r
  WHERE r.company_id = c.id AND r.is_builtin = true AND r.name = b.name
);

-- ── Step 2: Seed Worker role_permissions ─────────────────────────────────────

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, perm
FROM roles r
CROSS JOIN unnest(ARRAY[
  'clock_self','submit_time_entry_self','edit_own_pending_entry',
  'view_own_entries','view_projects','submit_reimbursement_self','view_own_reimbursements',
  'submit_field_reports','manage_punchlist','manage_rfis','manage_safety_checklists',
  'manage_equipment','manage_incidents','manage_inspections','view_inventory',
  'view_company_chat','send_company_chat'
]::text[]) AS perm
WHERE r.is_builtin = true AND r.name = 'Worker'
ON CONFLICT DO NOTHING;

-- ── Step 3: Seed Admin role_permissions (Worker's + admin-only) ──────────────

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, perm
FROM roles r
CROSS JOIN unnest(ARRAY[
  -- Worker's set
  'clock_self','submit_time_entry_self','edit_own_pending_entry',
  'view_own_entries','view_projects','submit_reimbursement_self','view_own_reimbursements',
  'submit_field_reports','manage_punchlist','manage_rfis','manage_safety_checklists',
  'manage_equipment','manage_incidents','manage_inspections','view_inventory',
  'view_company_chat','send_company_chat',
  -- Admin-only
  'clock_in_others','edit_any_entry','approve_entries','manage_pay_periods',
  'view_workers_list','view_worker_wages','manage_workers','assign_roles',
  'manage_projects','manage_project_visibility','view_reports','view_analytics',
  'view_certified_payroll','export_data','manage_reimbursements','manage_settings',
  'manage_advanced_settings','manage_integrations','send_broadcast','manage_inventory'
]::text[]) AS perm
WHERE r.is_builtin = true AND r.name = 'Admin'
ON CONFLICT DO NOTHING;

-- ── Step 4: Seed Owner role_permissions (Admin's + owner-only) ───────────────

INSERT INTO role_permissions (role_id, permission)
SELECT r.id, perm
FROM roles r
CROSS JOIN unnest(ARRAY[
  -- Admin's full set
  'clock_self','submit_time_entry_self','edit_own_pending_entry',
  'view_own_entries','view_projects','submit_reimbursement_self','view_own_reimbursements',
  'submit_field_reports','manage_punchlist','manage_rfis','manage_safety_checklists',
  'manage_equipment','manage_incidents','manage_inspections','view_inventory',
  'view_company_chat','send_company_chat',
  'clock_in_others','edit_any_entry','approve_entries','manage_pay_periods',
  'view_workers_list','view_worker_wages','manage_workers','assign_roles',
  'manage_projects','manage_project_visibility','view_reports','view_analytics',
  'view_certified_payroll','export_data','manage_reimbursements','manage_settings',
  'manage_advanced_settings','manage_integrations','send_broadcast','manage_inventory',
  -- Owner-only
  'manage_billing','manage_roles','delete_company'
]::text[]) AS perm
WHERE r.is_builtin = true AND r.name = 'Owner'
ON CONFLICT DO NOTHING;

-- ── Step 5: Assign Worker role_id to all worker users ────────────────────────

UPDATE users u
SET role_id = r.id
FROM roles r
WHERE r.company_id = u.company_id
  AND r.is_builtin = true
  AND r.name = 'Worker'
  AND u.role = 'worker'
  AND u.role_id IS NULL;

-- ── Step 6: Oldest UNRESTRICTED admin per company → Owner ───────────────────
-- The filter on admin_permissions IS NULL is critical: an admin with legacy
-- per-permission restrictions should never auto-promote to Owner. They fall
-- through to step 8 (custom role rebuilt from their signature) instead.
-- Without the filter, the oldest restricted admin in a company would silently
-- get full Owner perms, including manage_billing — a privilege escalation.

WITH oldest_admin AS (
  SELECT DISTINCT ON (company_id) id, company_id
  FROM users
  WHERE role = 'admin' AND role_id IS NULL AND admin_permissions IS NULL
  ORDER BY company_id, created_at, id
)
UPDATE users u
SET role_id = r.id
FROM roles r, oldest_admin oa
WHERE r.company_id = u.company_id
  AND r.is_builtin = true
  AND r.name = 'Owner'
  AND u.id = oa.id;

-- ── Step 7: Unrestricted admins (null admin_permissions) → Admin ─────────────

UPDATE users u
SET role_id = r.id
FROM roles r
WHERE r.company_id = u.company_id
  AND r.is_builtin = true
  AND r.name = 'Admin'
  AND u.role = 'admin'
  AND u.role_id IS NULL
  AND u.admin_permissions IS NULL;

-- ── Step 8: Backfill custom roles for admins with legacy tweaks ──────────────
-- One custom role per (company, unique signature). Admins with the same
-- enabled-keys signature share a role. Signature is a sorted jsonb array of
-- enabled keys so we can dedup by equality.

DO $$
DECLARE
  grp RECORD;
  new_role_id INTEGER;
  counter INTEGER;
  legacy_key TEXT;
BEGIN
  -- Iterate unique (company_id, signature) pairs among admins still unassigned.
  -- COALESCE on jsonb_agg handles the case where ALL keys are false (no
  -- permissions enabled) → empty array, still creates a "no-perms" custom role.
  FOR grp IN
    WITH admin_sigs AS (
      SELECT
        u.company_id,
        u.id AS user_id,
        COALESCE(
          (SELECT jsonb_agg(k ORDER BY k)
           FROM jsonb_object_keys(u.admin_permissions) k
           WHERE u.admin_permissions->k = 'true'::jsonb),
          '[]'::jsonb
        ) AS perms_array
      FROM users u
      WHERE u.role = 'admin' AND u.role_id IS NULL AND u.admin_permissions IS NOT NULL
    )
    SELECT company_id, perms_array,
           ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY perms_array::text) AS n
    FROM (SELECT DISTINCT company_id, perms_array FROM admin_sigs) uniq
  LOOP
    -- Name the role. If 'Custom Admin N' already exists in this company
    -- (from a prior run), append a suffix to avoid the UNIQUE(company_id,name)
    -- constraint. Idempotency: re-running should be a no-op — but if anything
    -- was committed between runs we want to tolerate it gracefully.
    counter := grp.n;
    LOOP
      BEGIN
        INSERT INTO roles (company_id, name, description, is_builtin, parent_role)
        VALUES (
          grp.company_id,
          'Custom Admin ' || counter,
          'Migrated from legacy admin_permissions. Original signature: ' || grp.perms_array::text,
          false,
          'admin'
        )
        RETURNING id INTO new_role_id;
        EXIT;  -- success
      EXCEPTION WHEN unique_violation THEN
        counter := counter + 1;
      END;
    END LOOP;

    -- Insert permissions for this custom role. Legacy keys map 1:1 to new keys.
    FOR legacy_key IN SELECT * FROM jsonb_array_elements_text(grp.perms_array)
    LOOP
      -- Only map recognized legacy keys; ignore any stale keys left over.
      IF legacy_key IN ('approve_entries','manage_workers','manage_projects','view_reports','manage_settings') THEN
        INSERT INTO role_permissions (role_id, permission)
        VALUES (new_role_id, legacy_key)
        ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;

    -- Assign every admin in this company with matching signature to this role.
    UPDATE users u
    SET role_id = new_role_id
    WHERE u.company_id = grp.company_id
      AND u.role = 'admin'
      AND u.role_id IS NULL
      AND u.admin_permissions IS NOT NULL
      AND COALESCE(
        (SELECT jsonb_agg(k ORDER BY k)
         FROM jsonb_object_keys(u.admin_permissions) k
         WHERE u.admin_permissions->k = 'true'::jsonb),
        '[]'::jsonb
      ) = grp.perms_array;
  END LOOP;
END $$;

COMMIT;
