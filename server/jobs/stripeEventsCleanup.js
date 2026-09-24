const cron = require('node-cron');
const pool = require('../db');
const { runJob } = require('./runJob');

// stripe_webhook_events is the webhook de-dupe ledger (migrations 0212/0215).
// Stripe only retries an event for ~3 days, so rows past the retention window
// can never de-dupe anything again — prune them daily so the table stays small.
// Started from cron.js startCron(), i.e. only in production and only when
// DISABLE_BACKGROUND_JOBS isn't set (index.js gates startCron with the others).
const RETENTION_DAYS = 90;

function cleanupStripeEvents() {
  return pool.query(
    "DELETE FROM stripe_webhook_events WHERE received_at < NOW() - ($1 || ' days')::INTERVAL",
    [String(RETENTION_DAYS)]
  );
}

function startStripeEventsCleanupJob() {
  cron.schedule('45 3 * * *', () => runJob('stripeEventsCleanup', cleanupStripeEvents));
}

module.exports = { startStripeEventsCleanupJob, cleanupStripeEvents, RETENTION_DAYS };
