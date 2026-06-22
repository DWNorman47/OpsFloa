/**
 * Fixed-value enums for the `companies` table. See `docs/db-enums.md`
 * for the full registry.
 *
 * subscription_status has two faces: the values OpsFloa uses internally
 * (defined here as COMPANY_SUBSCRIPTION_STATUSES) and the values Stripe
 * sends via webhooks. They overlap but aren't identical:
 *   - Stripe never sends 'trial_expired' or 'exempt' — those are set
 *     by our own cron (trial_expired) or by superadmin (exempt).
 *   - Stripe sends 'trialing' (with an 'ing'), 'incomplete',
 *     'incomplete_expired', 'unpaid', and 'paused' which we don't
 *     model directly.
 *
 * `mapStripeStatus` collapses Stripe's set down to ours so the
 * companies.subscription_status column can carry a CHECK constraint
 * without breaking the webhook on any future Stripe event.
 */

const COMPANY_SUBSCRIPTION_STATUSES = Object.freeze([
  'trial',
  'active',
  'past_due',
  'canceled',
  'trial_expired',
  'exempt',
]);

const COMPANY_PLANS = Object.freeze(['free', 'starter', 'business']);

// Stripe Subscription.status enum (current as of 2025) maps onto our
// internal set as follows. The mapping favours "needs admin attention"
// for ambiguous cases (incomplete / unpaid / paused) since those all
// represent broken billing the admin should resolve.
const STRIPE_STATUS_TO_APP = Object.freeze({
  trialing:           'trial',
  active:             'active',
  past_due:           'past_due',
  canceled:           'canceled',
  unpaid:             'past_due',
  incomplete:         'past_due',
  incomplete_expired: 'canceled',
  paused:             'past_due',
});

/**
 * Translate a Stripe `subscription.status` value to our app's set.
 * Unknown / unmappable values fall back to 'past_due' so the column
 * always carries a valid value the CHECK constraint accepts AND the
 * UI surfaces as "needs attention" — better than silently dropping
 * the update.
 *
 * @param {string} stripeStatus
 * @returns {'trial'|'active'|'past_due'|'canceled'}
 */
function mapStripeStatus(stripeStatus) {
  return STRIPE_STATUS_TO_APP[stripeStatus] || 'past_due';
}

module.exports = {
  COMPANY_SUBSCRIPTION_STATUSES,
  COMPANY_PLANS,
  STRIPE_STATUS_TO_APP,
  mapStripeStatus,
};
