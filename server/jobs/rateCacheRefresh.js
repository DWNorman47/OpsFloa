const cron = require('node-cron');
const logger = require('../logger');
const { runJob } = require('./runJob');
const { refreshAllCaches } = require('../utils/rateHistoryStore');

/**
 * Current-rate cache refresh (effective-dated rates, migration 0209).
 *
 * users.hourly_rate / users.rate_type, projects.prevailing_wage_rate and the
 * default_hourly_rate setting are a CACHE of the rate-history row in effect
 * today. Every history write refreshes it immediately, but a FUTURE-dated change
 * only takes effect when its day arrives — this job flips the cache that day.
 *
 * "Today" is each company's local date (company_timezone), and zones cross
 * midnight at different UTC hours, so it runs hourly (not once a day): the cache
 * turns over within the hour after local midnight. Idempotent and cheap — only
 * companies with a real dated change are visited and only differing rows are
 * written. Pay itself never reads the cache for dated history (the engine
 * resolves per entry date), so a late run only delays what screens display.
 */
async function refreshRateCaches() {
  const { companies, updated } = await refreshAllCaches();
  if (updated) logger.info({ companies, updated }, 'rate caches refreshed');
}

function startRateCacheRefreshJob() {
  cron.schedule('7 * * * *', () => runJob('rateCacheRefresh', refreshRateCaches));
  // Catch anything that took effect while the server was down.
  runJob('rateCacheRefresh', refreshRateCaches);
}

module.exports = { startRateCacheRefreshJob, refreshRateCaches };
