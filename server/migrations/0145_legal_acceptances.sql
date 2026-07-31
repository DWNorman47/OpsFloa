-- Clickwrap acceptance audit trail: who agreed to the Terms (EULA) + Privacy
-- Policy, which version, when, and from what IP. One row per acceptance event
-- (signup today; re-acceptance on a version bump later). user_id SET NULL on
-- delete so the record survives the user; company_id UUID with no FK (staging
-- companies.id may still be INTEGER — same posture as worker_deductions).

CREATE TABLE IF NOT EXISTS legal_acceptances (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  company_id  UUID,
  version     VARCHAR(40)  NOT NULL,               -- legal-docs version accepted, e.g. '2025-03-21'
  context     VARCHAR(40)  NOT NULL DEFAULT 'signup', -- where acceptance happened
  ip          VARCHAR(64),
  accepted_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_legal_acceptances_user    ON legal_acceptances(user_id);
CREATE INDEX IF NOT EXISTS idx_legal_acceptances_company ON legal_acceptances(company_id);
