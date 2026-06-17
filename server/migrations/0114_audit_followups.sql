-- Audit follow-ups from the post-build hazard review.
--
-- 1. Stop project DELETE from cascading away signed/accepted legal +
--    financial records. Lien waivers are statutory documents; accepted
--    change orders are contractual amendments; signed submittals are
--    architect approvals; signed lien waivers are basically un-deletable
--    legal evidence. Letting `DELETE FROM projects WHERE id=$1` silently
--    wipe them is a real liability. We switch the FK behavior to
--    RESTRICT — the application route layer is responsible for guiding
--    admins through an archive flow when those rows exist.
--
-- 2. Bound tax_pct above as well as below on project_expenses. The
--    route layer rejects >100 but raw SQL / seeders / future endpoints
--    could write 1000% and overflow tax_cents.

-- ── project_expenses.tax_pct upper bound ────────────────────────────────────
ALTER TABLE project_expenses
  DROP CONSTRAINT IF EXISTS project_expenses_tax_pct_check;
ALTER TABLE project_expenses
  ADD CONSTRAINT chk_pe_tax_pct_bounded
  CHECK (tax_pct >= 0 AND tax_pct <= 100);

-- ── lien_waivers.project_id: CASCADE → RESTRICT ────────────────────────────
ALTER TABLE lien_waivers
  DROP CONSTRAINT IF EXISTS lien_waivers_project_id_fkey;
ALTER TABLE lien_waivers
  ADD CONSTRAINT lien_waivers_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;

-- ── change_orders.project_id: CASCADE → RESTRICT ───────────────────────────
ALTER TABLE change_orders
  DROP CONSTRAINT IF EXISTS change_orders_project_id_fkey;
ALTER TABLE change_orders
  ADD CONSTRAINT change_orders_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;

-- ── submittals.project_id: CASCADE → RESTRICT ──────────────────────────────
ALTER TABLE submittals
  DROP CONSTRAINT IF EXISTS submittals_project_id_fkey;
ALTER TABLE submittals
  ADD CONSTRAINT submittals_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;

-- ── project_closeouts.project_id: CASCADE → RESTRICT ───────────────────────
ALTER TABLE project_closeouts
  DROP CONSTRAINT IF EXISTS project_closeouts_project_id_fkey;
ALTER TABLE project_closeouts
  ADD CONSTRAINT project_closeouts_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;

-- ── project_expenses.project_id: CASCADE → RESTRICT ────────────────────────
ALTER TABLE project_expenses
  DROP CONSTRAINT IF EXISTS project_expenses_project_id_fkey;
ALTER TABLE project_expenses
  ADD CONSTRAINT project_expenses_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;

-- ── project_budget_categories.project_id: CASCADE → RESTRICT ───────────────
ALTER TABLE project_budget_categories
  DROP CONSTRAINT IF EXISTS project_budget_categories_project_id_fkey;
ALTER TABLE project_budget_categories
  ADD CONSTRAINT project_budget_categories_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;

-- estimates.converted_project_id keeps ON DELETE SET NULL — that's
-- intentional: deleting the project shouldn't delete the estimate,
-- and the estimate has no statutory-record value of its own (the
-- accepted state + signature lives in estimate_audit which is fine).

-- ── Email send tracking on the entities that auto-email on send ────────────
-- Fire-and-forget email sends today succeed silently if SendGrid is down;
-- the entity is marked sent and the token committed but the client never
-- sees it. These columns let the route layer post-update with the send
-- result so admins can spot failures.
ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS send_email_status VARCHAR(20)
    CONSTRAINT chk_estimates_send_email_status
    CHECK (send_email_status IS NULL OR send_email_status IN ('pending','sent','failed')),
  ADD COLUMN IF NOT EXISTS send_email_attempted_at TIMESTAMPTZ;

ALTER TABLE change_orders
  ADD COLUMN IF NOT EXISTS send_email_status VARCHAR(20)
    CONSTRAINT chk_change_orders_send_email_status
    CHECK (send_email_status IS NULL OR send_email_status IN ('pending','sent','failed')),
  ADD COLUMN IF NOT EXISTS send_email_attempted_at TIMESTAMPTZ;

ALTER TABLE lien_waivers
  ADD COLUMN IF NOT EXISTS send_email_status VARCHAR(20)
    CONSTRAINT chk_lien_waivers_send_email_status
    CHECK (send_email_status IS NULL OR send_email_status IN ('pending','sent','failed')),
  ADD COLUMN IF NOT EXISTS send_email_attempted_at TIMESTAMPTZ;

-- ── Cron dedup column for booking reminders ────────────────────────────────
-- Replaces the appointment_audit-based dedup which had a TOCTOU bug
-- (send first, then audit; if process dies between, next run double-sends).
-- These columns are populated BEFORE the email send via a conditional UPDATE
-- so a re-run finds the row already claimed.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS reminder_client_24h_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_assignee_1h_at TIMESTAMPTZ;
