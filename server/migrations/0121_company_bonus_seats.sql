-- Complimentary worker seats a super_admin can grant a company on top of its
-- plan limit, without going through Stripe. checkWorkerLimit() adds this to
-- WORKER_LIMITS[plan] when enforcing the cap. No effect on the business plan
-- (already uncapped) or active trials (already unlimited).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS bonus_seats INTEGER NOT NULL DEFAULT 0;
