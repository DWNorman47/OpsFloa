-- Bid workflow M2 — attach a plan PDF to an estimate (R2 URL), so the bid can be
-- taken off in Plan Room straight from the estimate. Idempotent.
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS plan_pdf_url TEXT;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS plan_pdf_name TEXT;
