const {
  COMPANY_SUBSCRIPTION_STATUSES,
  COMPANY_PLANS,
  STRIPE_STATUS_TO_APP,
  mapStripeStatus,
} = require('../constants/companyEnums');

describe('COMPANY_SUBSCRIPTION_STATUSES', () => {
  test('matches the migration 0103 CHECK constraint', () => {
    // Keep this assertion in lockstep with the CHECK in
    // server/migrations/0103_constrain_companies_status_plan.sql.
    expect([...COMPANY_SUBSCRIPTION_STATUSES].sort()).toEqual(
      ['active', 'canceled', 'exempt', 'past_due', 'trial', 'trial_expired']
    );
  });

  test('is frozen so a caller can\'t accidentally mutate it', () => {
    expect(Object.isFrozen(COMPANY_SUBSCRIPTION_STATUSES)).toBe(true);
  });
});

describe('COMPANY_PLANS', () => {
  test('matches the migration 0103 CHECK constraint', () => {
    expect([...COMPANY_PLANS].sort()).toEqual(['business', 'free', 'starter']);
  });

  test('is frozen', () => {
    expect(Object.isFrozen(COMPANY_PLANS)).toBe(true);
  });
});

describe('mapStripeStatus', () => {
  test('translates every known Stripe status into an app value', () => {
    // Snapshot every Stripe → app mapping. If a new Stripe status is
    // ever added without an entry in STRIPE_STATUS_TO_APP, this test
    // fails because the new key wouldn't be in the expected set.
    expect(STRIPE_STATUS_TO_APP).toEqual({
      trialing:           'trial',
      active:             'active',
      past_due:           'past_due',
      canceled:           'canceled',
      unpaid:             'past_due',
      incomplete:         'past_due',
      incomplete_expired: 'canceled',
      paused:             'past_due',
    });
  });

  test('every output is a valid app subscription_status', () => {
    // Defence-in-depth — the CHECK constraint should never reject a
    // mapper output. If someone edits STRIPE_STATUS_TO_APP to add a
    // value not in COMPANY_SUBSCRIPTION_STATUSES, this test catches it.
    for (const appValue of Object.values(STRIPE_STATUS_TO_APP)) {
      expect(COMPANY_SUBSCRIPTION_STATUSES).toContain(appValue);
    }
  });

  test('round-trips each known Stripe status through the mapper', () => {
    for (const [stripeValue, expectedAppValue] of Object.entries(STRIPE_STATUS_TO_APP)) {
      expect(mapStripeStatus(stripeValue)).toBe(expectedAppValue);
    }
  });

  test('unknown Stripe status falls back to past_due', () => {
    // The webhook should never crash on a status Stripe adds in the
    // future. Surfacing as "needs attention" is the safest fallback.
    expect(mapStripeStatus('some_future_stripe_value')).toBe('past_due');
    expect(mapStripeStatus('')).toBe('past_due');
    expect(mapStripeStatus(undefined)).toBe('past_due');
    expect(mapStripeStatus(null)).toBe('past_due');
  });

  test('fallback value is itself a valid app status', () => {
    // If the fallback ever drifted from the CHECK constraint, the
    // webhook would 500 instead of silently bucketing unknown statuses.
    expect(COMPANY_SUBSCRIPTION_STATUSES).toContain(mapStripeStatus('garbage'));
  });
});
