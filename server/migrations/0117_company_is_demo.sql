-- Marks a company as a demo / test tenant. Demo companies:
--   * never send real email (suppressed at the email layer; the UI shows
--     a "would have sent" popup instead) — prevents the public demo login
--     from being abused to spam arbitrary addresses via SendGrid;
--   * are capped at a 200 MB R2 storage limit regardless of plan;
--   * have their R2 objects + storage counter wiped by the nightly job.
--
-- A dedicated flag (rather than reusing subscription_status='exempt',
-- which also covers real comped/internal tenants) so these behaviours
-- can never accidentally apply to a paying customer.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT false;

-- Backfill the known demo tenant: the seeder pins it to name +
-- subscription_status='exempt'. Only flip the row that matches BOTH so a
-- real company merely named "Demo Operations" is never affected.
UPDATE companies
   SET is_demo = true
 WHERE name = 'Demo Operations'
   AND subscription_status = 'exempt';
