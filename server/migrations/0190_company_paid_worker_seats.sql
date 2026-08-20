-- Paid per-worker seats a Business company purchased above the 15 included in the base
-- plan (= the quantity on the Stripe per-worker seat item). Synced from Stripe by the
-- billing webhook and change-plan. The Business seat cap enforced in admin.js is
-- BUSINESS_INCLUDED_WORKERS (15) + paid_worker_seats + bonus_seats.
--
-- Nullable on purpose: NULL means "not yet synced from Stripe". checkWorkerLimit treats
-- NULL as a grace (unlimited) so an EXISTING Business subscription isn't retroactively
-- blocked the moment this ships — enforcement kicks in once the next billing webhook
-- (or a change-plan) populates the real seat count.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS paid_worker_seats INTEGER;
