-- Stripe delivers webhook events with NO ordering guarantee: a stale
-- customer.subscription.updated can arrive after the customer.subscription.deleted
-- that superseded it, resurrecting a canceled company; a late
-- checkout.session.completed can re-activate a sub the admin already cancelled.
--
-- Record the Stripe `event.created` (epoch seconds) of the last APPLIED
-- subscription-lifecycle event per company. The webhook folds a
-- "last_stripe_event_at IS NULL OR last_stripe_event_at <= $created" guard into
-- each lifecycle UPDATE so an out-of-order older event updates 0 rows (is
-- skipped) instead of clobbering newer state. Nullable: existing rows have no
-- watermark and accept the next event unconditionally.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS last_stripe_event_at BIGINT;
