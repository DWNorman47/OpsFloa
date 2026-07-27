-- Username uniqueness was GLOBAL across the whole users table (the inline
-- `username VARCHAR(100) UNIQUE` in schema.sql becomes constraint
-- users_username_key). That coupled otherwise-isolated tenants: two companies
-- could not each have a "leo.martinez", or even both have an "Admin". It is
-- stricter than the app's own model -- login is per-company
-- (auth.js: WHERE (username|email) = $1 AND company_id = $3), and every username
-- conflict check scopes by company_id. The global constraint only ever produced
-- FALSE collisions across tenants (e.g. the demo seed skipping workers whose
-- names a different exempt tenant already held). It leaks no data -- but it makes
-- one company's username choices silently constrain another's.
--
-- Scope uniqueness to the tenant: unique per (company_id, username), not globally.
-- Existing rows are already globally unique, so no two rows can share a username
-- within a single company today -- adding the per-company index needs no cleanup.

-- 1. Drop whatever single-column UNIQUE constraint sits on username. The inline
--    UNIQUE defaults to users_username_key, but resolve it by SHAPE (the one
--    unique constraint whose only column is username) so this is correct no
--    matter how a given environment named it. Idempotent: no-op if already gone.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'users'::regclass
    AND contype = 'u'
    AND array_length(conkey, 1) = 1
    AND conkey[1] = (
      SELECT attnum FROM pg_attribute
      WHERE attrelid = 'users'::regclass AND attname = 'username' AND NOT attisdropped
    );
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', cname);
  END IF;
END $$;

-- 2. Per-company uniqueness (case-sensitive, matching the constraint it replaces).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_company_username ON users (company_id, username);
