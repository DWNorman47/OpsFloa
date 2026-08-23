const cron = require('node-cron');
const pool = require('../db');
const { deleteByUrl } = require('../r2');
const { decrementStorage } = require('../storage');
const { applySettingsRows, ADMIN_SETTINGS_DEFAULTS } = require('../settingsDefaults');
const logger = require('../logger');
const { runJob } = require('./runJob');

// Purge R2 objects for already-DELETED rows, but only when no surviving row in the
// same table still points at the URL — a shared/resubmitted URL must not be orphaned
// out from under a row that's still live. Mirrors the interactive delete guard in
// fieldReports.js. `table` is one of two fixed internal literals (never user input).
// Returns the total size_bytes to refund.
async function purgeUnreferenced(table, rows) {
  let totalBytes = 0;
  const purged = new Set();
  for (const r of rows) {
    totalBytes += parseInt(r.size_bytes || 0) || 0;
    if (!r.url || purged.has(r.url)) continue;
    purged.add(r.url);
    const still = await pool.query(`SELECT 1 FROM ${table} WHERE url = $1 LIMIT 1`, [r.url]);
    if (still.rowCount === 0) await deleteByUrl(r.url).catch(() => {});
  }
  return totalBytes;
}

async function deleteMediaForProject(companyId, projectId) {
  const photos = await pool.query(
    `SELECT p.id, p.url, p.size_bytes
     FROM field_report_photos p
     JOIN field_reports r ON p.report_id = r.id
     WHERE r.company_id = $1 AND r.project_id = $2`,
    [companyId, projectId]
  );
  if (photos.rowCount === 0) return 0;

  const ids = photos.rows.map(p => p.id);
  await pool.query(`DELETE FROM field_report_photos WHERE id = ANY($1)`, [ids]);
  const totalBytes = await purgeUnreferenced('field_report_photos', photos.rows);
  if (totalBytes > 0) await decrementStorage(companyId, totalBytes).catch(() => {});
  return photos.rowCount;
}

async function runMediaRetention() {
  const companies = await pool.query(
      `SELECT c.id FROM companies c WHERE c.subscription_status IN ('trial', 'active')`
    );

    for (const { id: companyId } of companies.rows) {
      const settingsRows = await pool.query(
        'SELECT key, value FROM settings WHERE company_id = $1', [companyId]
      );
      const s = applySettingsRows(settingsRows.rows, ADMIN_SETTINGS_DEFAULTS);
      const retentionDays = parseInt(s.media_retention_days) || 0;
      if (retentionDays <= 0) continue;

      // Delete field report photos older than retention_days
      const oldPhotos = await pool.query(
        `SELECT p.id, p.url, p.size_bytes
         FROM field_report_photos p
         JOIN field_reports r ON p.report_id = r.id
         WHERE r.company_id = $1
           AND r.reported_at < NOW() - ($2 || ' days')::interval`,
        [companyId, retentionDays]
      );

      if (oldPhotos.rowCount > 0) {
        const ids = oldPhotos.rows.map(p => p.id);
        await pool.query(`DELETE FROM field_report_photos WHERE id = ANY($1)`, [ids]);
        const totalBytes = await purgeUnreferenced('field_report_photos', oldPhotos.rows);
        if (totalBytes > 0) await decrementStorage(companyId, totalBytes).catch(() => {});
        logger.info({ companyId, photos: oldPhotos.rowCount, bytes: totalBytes }, 'mediaRetention: deleted photos');
      }

      // Delete safety talk attachments older than retention_days
      const oldAttachments = await pool.query(
        `SELECT a.id, a.url, a.size_bytes
         FROM safety_talk_attachments a
         JOIN safety_talks t ON a.talk_id = t.id
         WHERE t.company_id = $1
           AND a.created_at < NOW() - ($2 || ' days')::interval`,
        [companyId, retentionDays]
      );

      if (oldAttachments.rowCount > 0) {
        const ids = oldAttachments.rows.map(a => a.id);
        await pool.query(`DELETE FROM safety_talk_attachments WHERE id = ANY($1)`, [ids]);
        const attBytes = await purgeUnreferenced('safety_talk_attachments', oldAttachments.rows);
        if (attBytes > 0) await decrementStorage(companyId, attBytes).catch(() => {});
        logger.info({ companyId, attachments: oldAttachments.rowCount, bytes: attBytes }, 'mediaRetention: deleted attachments');
      }
    }
}

function startMediaRetentionJob() {
  cron.schedule('0 2 * * *', () => runJob('mediaRetention', runMediaRetention)); // 2 AM daily
}

module.exports = { startMediaRetentionJob, deleteMediaForProject };
