-- Freeze a job's final cost/profit when it's closed out. Live P&L recomputes
-- from time entries / expenses / invoices forever, so a "closed" job's profit
-- silently moves if anyone edits a past entry. On transition to
-- final_complete / closed we snapshot the full P&L here as the audit-stable
-- final number; the live figures stay available for comparison. Idempotent.

ALTER TABLE project_closeouts
  ADD COLUMN IF NOT EXISTS final_financials       JSONB,
  ADD COLUMN IF NOT EXISTS financials_snapshot_at TIMESTAMPTZ;
