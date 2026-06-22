-- A client's preferred document language. Drives which language the
-- estimate / change-order PDFs render in, so a Spanish-speaking client
-- receives a Spanish document even when the admin who generated it works
-- in English. Values mirror users.language ('English' | 'Spanish') so
-- the same getT() dictionary lookup applies — see
-- server/constants/userEnums.js USER_LANGUAGES.
--
-- NOT NULL with a DEFAULT so the column is safe to add to a populated
-- table; existing clients default to English. CHECK is the unbypassable
-- backstop (raw SQL / seeder / future endpoint) alongside the route-layer
-- validation in admin.js.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS language VARCHAR(20) NOT NULL DEFAULT 'English';

ALTER TABLE clients
  DROP CONSTRAINT IF EXISTS chk_clients_language;

ALTER TABLE clients
  ADD CONSTRAINT chk_clients_language
    CHECK (language IN ('English', 'Spanish'));
