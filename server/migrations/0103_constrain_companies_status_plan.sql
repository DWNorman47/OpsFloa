-- Add CHECK constraints to companies.subscription_status and companies.plan.
--
-- Why this was deferred until now: the Stripe webhook
-- (server/routes/stripe.js) used to write obj.status directly from
-- Stripe events. Stripe's status enum includes values we don't model
-- internally (`trialing`, `incomplete`, `unpaid`, `paused`, etc.), so
-- a CHECK would have crashed the webhook on the next subscription
-- event. The same commit that adds these constraints adds a
-- mapStripeStatus() shim in server/constants/companyEnums.js and
-- wires the webhook through it. Now we can safely enforce.
--
-- Each block: drop any pre-existing CHECK, normalise rows that would
-- violate the new one, add the CHECK. Idempotent.

-- ── companies.subscription_status ───────────────────────────────────────────
-- Internal set: trial, active, past_due, canceled, trial_expired, exempt.
-- Any pre-existing row with a Stripe-only value (likely 'trialing' or
-- 'unpaid' from before the mapper landed) collapses to 'past_due' so
-- the row carries a valid status AND surfaces as "needs admin attention"
-- in the UI — better than silently changing it to 'active'.
ALTER TABLE companies DROP CONSTRAINT IF EXISTS chk_companies_subscription_status;
UPDATE companies SET subscription_status = 'past_due'
  WHERE subscription_status NOT IN ('trial', 'active', 'past_due', 'canceled', 'trial_expired', 'exempt');
ALTER TABLE companies
  ADD CONSTRAINT chk_companies_subscription_status
  CHECK (subscription_status IN ('trial', 'active', 'past_due', 'canceled', 'trial_expired', 'exempt'));

-- ── companies.plan ──────────────────────────────────────────────────────────
-- NULL is allowed (trial / free companies often have no plan set until
-- they pick one). Constraint matches planFromPrice()'s output set in
-- server/routes/stripe.js.
ALTER TABLE companies DROP CONSTRAINT IF EXISTS chk_companies_plan;
UPDATE companies SET plan = NULL
  WHERE plan IS NOT NULL AND plan NOT IN ('free', 'starter', 'business');
ALTER TABLE companies
  ADD CONSTRAINT chk_companies_plan
  CHECK (plan IS NULL OR plan IN ('free', 'starter', 'business'));
