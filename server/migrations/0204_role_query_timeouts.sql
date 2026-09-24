-- Server-side query guards for the app's DB role, as role-level defaults.
--
-- db.js passes statement_timeout / idle_in_transaction_session_timeout as
-- pg startup parameters on a direct connection, but Neon's `-pooler` endpoint
-- (PgBouncer, transaction mode) rejects unknown startup parameters and drops
-- session SETs between transactions. Role defaults are applied by Postgres
-- itself when each backend starts, so they hold behind the pooler too.
--
--   statement_timeout 30s                   — cancel runaway statements
--   idle_in_transaction_session_timeout 60s — kill leaked open transactions
--
-- Scoped to this database only. Code that needs longer overrides with
-- SET LOCAL inside its own transaction (db.js pool.queryLong, migrate.js).
-- Takes effect for NEW backends; pooled backends pick it up as they recycle.
-- Revert: ALTER ROLE <role> IN DATABASE <db> RESET statement_timeout; (same
-- for idle_in_transaction_session_timeout).
--
-- Wrapped so an environment whose role can't alter itself logs a notice
-- instead of failing the deploy.
DO $$
BEGIN
  EXECUTE format('ALTER ROLE %I IN DATABASE %I SET statement_timeout = %L',
                 current_user, current_database(), '30s');
  EXECUTE format('ALTER ROLE %I IN DATABASE %I SET idle_in_transaction_session_timeout = %L',
                 current_user, current_database(), '60s');
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'role query timeouts not set (insufficient privilege): %', SQLERRM;
END $$;
