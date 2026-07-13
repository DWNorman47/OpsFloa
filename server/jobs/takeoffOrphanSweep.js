/**
 * Orphaned plan-document sweep for the shared plan-tools library.
 *
 * The presigned upload flow is three steps (get URL → browser PUTs to R2 →
 * POST the row). If the final POST never happens (tab closed, network drop),
 * the object sits in R2 with no takeoff_projects row pointing at it — leaked
 * storage. This job deletes objects under takeoffs/ that are older than 24h
 * and referenced by no row.
 *
 * SAFETY: opt-in via R2_ORPHAN_SWEEP=1. Only enable where this environment's
 * database is the ONLY one writing to this bucket — if stage and prod share a
 * bucket, one environment's sweep would delete the other's documents.
 */

const cron = require('node-cron');
const pool = require('../db');
const { listByPrefix, deleteByKey, keyFromPublicUrl } = require('../r2');
const { runJob } = require('./runJob');

const MIN_AGE_MS = 24 * 60 * 60 * 1000; // never touch fresh uploads mid-flow

async function sweepOrphanedTakeoffDocs() {
  const objects = await listByPrefix('takeoffs/');
  if (!objects.length) return;

  const { rows } = await pool.query(
    `SELECT pdf_url FROM takeoff_projects WHERE pdf_url IS NOT NULL`);
  const referenced = new Set(rows.map(r => keyFromPublicUrl(r.pdf_url)).filter(Boolean));

  const cutoff = Date.now() - MIN_AGE_MS;
  let removed = 0;
  for (const o of objects) {
    if (referenced.has(o.key)) continue;
    if (!o.lastModified || new Date(o.lastModified).getTime() > cutoff) continue;
    await deleteByKey(o.key);
    removed++;
  }
  if (removed) console.log(`takeoffOrphanSweep: removed ${removed} orphaned object(s)`);
}

function startTakeoffOrphanSweepJob() {
  if (process.env.R2_ORPHAN_SWEEP !== '1') return; // opt-in (see SAFETY above)
  // 4:30 AM server time daily, offset from the other overnight jobs
  cron.schedule('30 4 * * *', () => runJob('takeoffOrphanSweep', sweepOrphanedTakeoffDocs));
}

module.exports = { startTakeoffOrphanSweepJob };
