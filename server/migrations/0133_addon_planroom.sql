-- Plan Room paid add-on (per-company). The $40/mo base tier of the plan-tools
-- product line: viewer + markup + measure + company library + export. Billed
-- monthly/annual via Stripe (STRIPE_PRICE_PLANROOM / STRIPE_PRICE_PLANROOM_ANNUAL).
-- Mirrors addon_takeoff: a boolean entitlement flipped by the Stripe webhook.
-- exempt/trial companies get it free until they pay. Idempotent.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS addon_planroom BOOLEAN NOT NULL DEFAULT false;
