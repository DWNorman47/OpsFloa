-- Sitework Takeoff paid add-on (per-company). Billed monthly/annual via Stripe
-- (STRIPE_PRICE_TAKEOFF / STRIPE_PRICE_TAKEOFF_ANNUAL). Mirrors addon_qbo and
-- addon_certified_payroll: a boolean entitlement flipped by the Stripe webhook.
-- exempt/trial companies get it free until they pay. Idempotent.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS addon_takeoff BOOLEAN NOT NULL DEFAULT false;
