const cron = require('node-cron');
const pool = require('../db');
const { runJob } = require('./runJob');

function startPublicVisitRetentionJob() {
  cron.schedule('15 3 * * *', () => runJob('publicVisitRetention', () =>
    pool.query("DELETE FROM public_visits WHERE first_seen < NOW() - INTERVAL '30 days'")));
}

module.exports = { startPublicVisitRetentionJob };
