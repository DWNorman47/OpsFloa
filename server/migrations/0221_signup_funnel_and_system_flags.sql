-- 0221: signup funnel + environment-wide flags.
--
-- 1. public_visits.registered — a welcome-page visit that went on to submit the
--    sign-up form is now KEPT and flagged (it used to be deleted on sign-up, so
--    visit → sign-up conversion could not be measured). Logged-in users' visits
--    are still excluded (deleted) as before.
ALTER TABLE public_visits ADD COLUMN IF NOT EXISTS registered BOOLEAN NOT NULL DEFAULT false;

-- 2. system_flags — tiny key/value store for flags that describe the DATABASE
--    rather than one company. Written only by ops tooling (e.g. the stage sync
--    workflow sets email_mode='suppress' after scrubbing a prod copy, so a stage
--    server never emails anyone even with NODE_ENV=production). Empty on prod.
--    Read by server/email.js. Allowed keys/values: see docs/db-enums.md.
CREATE TABLE IF NOT EXISTS system_flags (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_system_flags_key CHECK (key IN ('email_mode')),
  CONSTRAINT chk_system_flags_email_mode CHECK (key <> 'email_mode' OR value IN ('real', 'redirect', 'suppress'))
);
