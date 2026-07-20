-- Storm/Utility takeoff pack — deep underground-utility takeoff add-on (~$50/mo),
-- sold on top of the Takeoff layer: pipe schedule (Ø × material), structure depth
-- (VF pricing), invert-driven per-segment trench depth, and spoil/backfill netting.
-- Billed monthly/annual via Stripe (STRIPE_PRICE_STORM / STRIPE_PRICE_STORM_ANNUAL).
-- Mirrors addon_takeoff / addon_planroom: a boolean entitlement flipped by the
-- Stripe webhook. exempt/trial companies get it free until they pay. Idempotent.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS addon_storm BOOLEAN NOT NULL DEFAULT false;
