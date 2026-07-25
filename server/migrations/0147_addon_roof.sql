-- Roof Measurement — aerial roof measurement report add-on ($40/mo), sold on top
-- of Plan Room (the tracing lives in the Plan Room tool-app). Reuses the roofing
-- geometry; the deliverable is a branded measurement report rather than a bid.
-- Billed monthly/annual via Stripe (STRIPE_PRICE_ROOF / STRIPE_PRICE_ROOF_ANNUAL).
-- Mirrors addon_takeoff / addon_planroom / addon_storm: a boolean entitlement
-- flipped by the Stripe webhook. exempt/trial companies get it free until they
-- pay. Idempotent. See docs/plans/roof-measurement.md.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS addon_roof BOOLEAN NOT NULL DEFAULT false;
