const cron = require('node-cron');
const pool = require('../db');
const { runJob } = require('./runJob');

function startPublicVisitRetentionJob() {
  // queryLong: a bulk DELETE on the visit log may exceed the pool's 30s
  // statement_timeout after a traffic spike.
  cron.schedule('15 3 * * *', () => runJob('publicVisitRetention', () =>
    pool.queryLong("DELETE FROM public_visits WHERE first_seen < NOW() - INTERVAL '30 days'", [], 300000)));
}

module.exports = { startPublicVisitRetentionJob };
