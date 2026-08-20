const router = require('express').Router();
const pool = require('../db');
const logger = require('../logger');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { sendPushToCompanyAdmins } = require('../push');
const { uploadBase64, getPresignedUploadUrl, deleteByUrl, getObjectMetadataByUrl } = require('../r2');
const { checkStorageLimit, incrementStorage, decrementStorage } = require('../storage');
const { logAudit } = require('../auditLog');
const { projectBelongsToCompany } = require('../utils/tenantRefs');
const { FIELD_REPORT_MEDIA_TYPES, FIELD_REPORT_MEDIA_TYPE_DEFAULT } = require('../constants/fieldReportEnums');
const mediaType = v => (FIELD_REPORT_MEDIA_TYPES.includes(v) ? v : FIELD_REPORT_MEDIA_TYPE_DEFAULT);

// A pass-through (already-hosted) media URL is only accepted if it points at THIS
// app's field-report media folders on R2. Without this, a client could store an
// arbitrary R2 URL — e.g. another tenant's submittal/COI/takeoff PDF — as a "photo",
// then delete it via the photo-delete route (deleteByUrl derives the key from the URL
// with no ownership check). Restricting to photos/ + videos/ keeps a field-report
// delete from ever reaching another subsystem's (or tenant's document) objects.
function isOwnFieldReportMediaUrl(u) {
  const base = process.env.R2_PUBLIC_URL;
  if (!base || typeof u !== 'string') return false;
  return u.startsWith(`${base}/photos/`) || u.startsWith(`${base}/videos/`);
}

// One report with its photos, worker + project names — the create response shape.
async function loadFullReport(reportId) {
  const full = await pool.query(
    `SELECT r.*, u.full_name as worker_name, p.name as project_name,
            COALESCE(json_agg(ph ORDER BY ph.created_at) FILTER (WHERE ph.id IS NOT NULL), '[]') as photos
     FROM field_reports r
     JOIN users u ON r.user_id = u.id
     LEFT JOIN projects p ON r.project_id = p.id
     LEFT JOIN field_report_photos ph ON ph.report_id = r.id
     WHERE r.id = $1
     GROUP BY r.id, u.full_name, p.name`,
    [reportId]
  );
  return full.rows[0];
}

// GET /field-reports — worker gets own; admin gets full company feed
router.get('/', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  const page  = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  try {
    const { project_id, worker_id, status, from, to } = req.query;
    const conditions = ['r.company_id = $1'];
    const params = [companyId];

    if (!isAdmin) {
      params.push(req.user.id);
      conditions.push(`r.user_id = $${params.length}`);
    } else if (worker_id) {
      params.push(worker_id);
      conditions.push(`r.user_id = $${params.length}`);
    }
    if (project_id) { params.push(project_id); conditions.push(`r.project_id = $${params.length}`); }
    if (status) {
      if (!['draft', 'submitted', 'reviewed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
      params.push(status); conditions.push(`r.status = $${params.length}`);
    }
    if (from) { params.push(from); conditions.push(`COALESCE(r.report_date, r.reported_at::date) >= $${params.length}::date`); }
    if (to) { params.push(to); conditions.push(`COALESCE(r.report_date, r.reported_at::date) <= $${params.length}::date`); }

    const where = conditions.join(' AND ');
    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(DISTINCT r.id) FROM field_reports r WHERE ${where}`, params),
      pool.query(
        `SELECT r.*, u.full_name as worker_name, p.name as project_name,
                COALESCE(json_agg(ph ORDER BY ph.created_at) FILTER (WHERE ph.id IS NOT NULL), '[]') as photos
         FROM field_reports r
         JOIN users u ON r.user_id = u.id
         LEFT JOIN projects p ON r.project_id = p.id
         LEFT JOIN field_report_photos ph ON ph.report_id = r.id
         WHERE ${where}
         GROUP BY r.id, u.full_name, p.name
         ORDER BY r.reported_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    const total = parseInt(countResult.rows[0].count);
    res.json({ items: dataResult.rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// POST /field-reports — create a report with photos
router.post('/', requireAuth, async (req, res) => {
  const { project_id, lat, lng, photos = [], report_date } = req.body;
  const title = req.body.title?.trim() || null;
  const notes = req.body.notes?.trim() || null;
  if (title && title.length > 500) return res.status(400).json({ error: 'title too long (max 500 characters)' });
  if (notes && notes.length > 2000) return res.status(400).json({ error: 'notes too long (max 2000 characters)' });
  const companyId = req.user.company_id;
  // Idempotency: a stable per-submission id so an offline-queued POST replayed on reconnect
  // returns the already-created report instead of inserting a duplicate (and re-uploading photos
  // + double-counting storage). See migration 0192.
  const clientRequestId = typeof req.body.client_request_id === 'string' && req.body.client_request_id.length <= 64
    ? req.body.client_request_id : null;
  try {
    if (!(await projectBelongsToCompany(pool, project_id, companyId))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (clientRequestId) {
      const dup = await pool.query('SELECT id FROM field_reports WHERE company_id = $1 AND client_request_id = $2', [companyId, clientRequestId]);
      if (dup.rowCount > 0) return res.status(200).json(await loadFullReport(dup.rows[0].id));
    }
    // Estimate total upload size from base64 payloads for limit check
    const estimatedBytes = photos.reduce((sum, p) => {
      if (p.url?.startsWith('data:')) {
        const b64 = p.url.split(',')[1] || '';
        return sum + Math.floor(b64.length * 3 / 4);
      }
      return sum;
    }, 0);

    if (estimatedBytes > 0) {
      const { allowed, used, limit } = await checkStorageLimit(companyId, estimatedBytes);
      if (!allowed) {
        return res.status(413).json({
          error: `Storage limit reached (${(used / (1024 * 1024)).toFixed(0)} MB of ${(limit / (1024 * 1024)).toFixed(0)} MB used). Upgrade your plan to upload more media.`,
          storage_limit: true,
        });
      }
    }

    let report;
    try {
      const result = await pool.query(
        `INSERT INTO field_reports (company_id, user_id, project_id, title, notes, lat, lng, report_date, client_request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [companyId, req.user.id, project_id || null, title || null, notes || null, lat || null, lng || null, report_date || null, clientRequestId]
      );
      report = result.rows[0];
    } catch (e) {
      // Two replays raced past the dedup check — the unique index caught the second. Return the winner.
      if (e.code === '23505' && clientRequestId) {
        const dup = await pool.query('SELECT id FROM field_reports WHERE company_id = $1 AND client_request_id = $2', [companyId, clientRequestId]);
        if (dup.rowCount > 0) return res.status(200).json(await loadFullReport(dup.rows[0].id));
      }
      throw e;
    }

    if (photos.length > 0) {
      // Upload base64 data URLs to R2; pass through any already-hosted URLs
      let uploaded;
      try {
        uploaded = await Promise.all(
          photos.map(p => {
            const caption = p.caption?.trim()?.slice(0, 500) || null;
            if (p.url?.startsWith('data:')) {
              return uploadBase64(p.url).then(({ url, sizeBytes }) => ({
                url,
                sizeBytes,
                caption,
                media_type: mediaType(p.media_type),
              }));
            }
            if (!isOwnFieldReportMediaUrl(p.url)) throw new Error('invalid media url');
            // Already uploaded to R2 (a presigned video). Count its REAL object size so
            // storage is accurate and refundable on delete — the old code stored 0, so
            // the video's bytes were never freed and the reservation-time count drifted.
            return getObjectMetadataByUrl(p.url)
              .then(meta => ({ url: p.url, sizeBytes: meta ? meta.contentLength : 0, caption, media_type: mediaType(p.media_type) }))
              .catch(() => ({ url: p.url, sizeBytes: 0, caption, media_type: mediaType(p.media_type) }));
          })
        );
      } catch (uploadErr) {
        await pool.query('DELETE FROM field_reports WHERE id = $1', [report.id]).catch(() => {});
        logger.error({ err: uploadErr }, 'R2 upload failed');
        return res.status(500).json({ error: 'Photo upload failed. Please try again.' });
      }
      const photoValues = uploaded.map((p, i) => `($1, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4}, $${i * 4 + 5})`).join(', ');
      const photoParams = [report.id];
      uploaded.forEach(p => { photoParams.push(p.url); photoParams.push(p.caption); photoParams.push(p.media_type); photoParams.push(p.sizeBytes || null); });
      await pool.query(
        `INSERT INTO field_report_photos (report_id, url, caption, media_type, size_bytes) VALUES ${photoValues}`,
        photoParams
      );

      // Track storage
      const totalBytes = uploaded.reduce((sum, p) => sum + (p.sizeBytes || 0), 0);
      if (totalBytes > 0) incrementStorage(companyId, totalBytes).catch(() => {});
    }

    logAudit(companyId, req.user.id, req.user.full_name, 'field_report.submitted', 'field_report', report.id, title || null,
      { project_id: project_id || null, photo_count: photos.length });

    // Notify admins of new field report
    sendPushToCompanyAdmins(companyId, {
      title: `Field report from ${req.user.full_name}`,
      body: title || notes?.substring(0, 80) || 'New field report submitted',
      url: '/field',
    });

    // Return with photos included
    res.status(201).json(await loadFullReport(report.id));
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /field-reports/:id — worker updates their own report (if not yet reviewed)
router.patch('/:id', requireAuth, async (req, res) => {
  const { project_id } = req.body;
  const title = req.body.title !== undefined ? (req.body.title?.trim() || null) : undefined;
  const notes = req.body.notes !== undefined ? (req.body.notes?.trim() || null) : undefined;
  if (title !== undefined && title && title.length > 500) return res.status(400).json({ error: 'title too long (max 500 characters)' });
  if (notes !== undefined && notes && notes.length > 2000) return res.status(400).json({ error: 'notes too long (max 2000 characters)' });
  const companyId = req.user.company_id;
  try {
    const existing = await pool.query(
      'SELECT * FROM field_reports WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Report not found' });
    const report = existing.rows[0];
    const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
    if (!isAdmin && report.user_id !== req.user.id) return res.status(403).json({ error: 'Not your report' });
    if (!isAdmin && report.status === 'reviewed') return res.status(403).json({ error: 'Reviewed reports cannot be edited' });
    if (project_id !== undefined && !(await projectBelongsToCompany(pool, project_id, companyId))) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const result = await pool.query(
      `UPDATE field_reports SET title = $1, notes = $2, project_id = $3 WHERE id = $4 RETURNING *`,
      [title ?? report.title, notes ?? report.notes, project_id ?? report.project_id, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// PATCH /field-reports/:id/review — admin marks reviewed
router.patch('/:id/review', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE field_reports SET status = 'reviewed' WHERE id = $1 AND company_id = $2 RETURNING *`,
      [req.params.id, req.user.company_id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Report not found' });
    logAudit(req.user.company_id, req.user.id, req.user.full_name, 'field_report.reviewed', 'field_report', req.params.id, null, null);
    res.json(result.rows[0]);
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// DELETE /field-reports/:id — worker deletes own unreviewed report
router.delete('/:id', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  try {
    const existing = await pool.query(
      'SELECT * FROM field_reports WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Report not found' });
    const report = existing.rows[0];
    const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
    if (!isAdmin && report.user_id !== req.user.id) return res.status(403).json({ error: 'Not your report' });
    if (!isAdmin && report.status === 'reviewed') return res.status(403).json({ error: 'Reviewed reports cannot be deleted' });

    // Sum photo sizes before deletion for storage decrement
    const photoSum = await pool.query(
      'SELECT COALESCE(SUM(size_bytes), 0) AS total FROM field_report_photos WHERE report_id = $1',
      [req.params.id]
    );
    const totalBytes = parseInt(photoSum.rows[0].total);

    await pool.query('DELETE FROM field_reports WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);

    if (totalBytes > 0) decrementStorage(companyId, totalBytes).catch(() => {});

    logAudit(companyId, req.user.id, req.user.full_name, 'field_report.deleted', 'field_report', req.params.id, null,
      { project_id: report.project_id, was_reviewed: report.status === 'reviewed' });

    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /field-reports/photos — aggregated photo gallery for the company
// DELETE /field-reports/photos/:photoId - delete one field report image/video
router.delete('/photos/:photoId', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  try {
    const existing = await pool.query(
      `SELECT ph.id, ph.url, ph.size_bytes, ph.media_type,
              r.id AS report_id, r.user_id, r.status, r.project_id
       FROM field_report_photos ph
       JOIN field_reports r ON ph.report_id = r.id
       WHERE ph.id = $1 AND r.company_id = $2`,
      [req.params.photoId, companyId]
    );
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Image not found' });

    const photo = existing.rows[0];
    if (!isAdmin && photo.user_id !== req.user.id) return res.status(403).json({ error: 'Not your image' });
    if (!isAdmin && photo.status === 'reviewed') return res.status(403).json({ error: 'Reviewed reports cannot be edited' });

    await pool.query('DELETE FROM field_report_photos WHERE id = $1', [photo.id]);

    // Only purge the R2 object when nothing else references the same URL. Belt-and-
    // suspenders with the store-time allowlist: if two rows ever point at one object
    // (e.g. a resubmitted URL), deleting one row must not orphan the other's media.
    const stillReferenced = await pool.query('SELECT 1 FROM field_report_photos WHERE url = $1 LIMIT 1', [photo.url]);
    if (stillReferenced.rowCount === 0) deleteByUrl(photo.url).catch(() => {});
    const sizeBytes = parseInt(photo.size_bytes || 0);
    if (sizeBytes > 0) decrementStorage(companyId, sizeBytes).catch(() => {});

    logAudit(companyId, req.user.id, req.user.full_name, 'field_report_photo.deleted', 'field_report_photo', photo.id, null,
      { report_id: photo.report_id, project_id: photo.project_id, media_type: photo.media_type });

    res.json({ deleted: true });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

router.get('/photos', requireAuth, async (req, res) => {
  const companyId = req.user.company_id;
  const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
  const { project_id, from, to } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 100));
  const offset = (page - 1) * limit;

  const conditions = ['r.company_id = $1'];
  const params = [companyId];

  if (!isAdmin) {
    params.push(req.user.id);
    conditions.push(`r.user_id = $${params.length}`);
  }
  if (project_id) { params.push(project_id); conditions.push(`r.project_id = $${params.length}`); }
  if (from) { params.push(from); conditions.push(`r.reported_at >= $${params.length}`); }
  if (to) { params.push(to); conditions.push(`r.reported_at < ($${params.length}::date + interval '1 day')`); }

  const where = conditions.join(' AND ');
  try {
    const [countResult, dataResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) FROM field_report_photos ph JOIN field_reports r ON ph.report_id = r.id WHERE ${where}`,
        params
      ),
      pool.query(
        `SELECT ph.id, ph.url, ph.caption, ph.media_type,
                r.id as report_id, r.reported_at, r.title as report_title,
                r.project_id, r.lat, r.lng,
                p.name as project_name, u.full_name as worker_name
         FROM field_report_photos ph
         JOIN field_reports r ON ph.report_id = r.id
         JOIN users u ON r.user_id = u.id
         LEFT JOIN projects p ON r.project_id = p.id
         WHERE ${where}
         ORDER BY r.reported_at DESC, ph.id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);
    const total = parseInt(countResult.rows[0].count);
    res.json({ items: dataResult.rows, total, page, pages: Math.ceil(total / limit) });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Server error' }); }
});

// GET /field-reports/upload-url — presigned URL for direct browser→R2 video upload
router.get('/upload-url', requireAuth, async (req, res) => {
  const { contentType = 'video/mp4', size } = req.query;
  const companyId = req.user.company_id;
  const sizeBytes = parseInt(size) || 0;
  try {
    if (sizeBytes > 0) {
      const { allowed, used, limit } = await checkStorageLimit(companyId, sizeBytes);
      if (!allowed) {
        return res.status(413).json({
          error: `Storage limit reached (${(used / (1024 * 1024)).toFixed(0)} MB of ${(limit / (1024 * 1024)).toFixed(0)} MB used). Upgrade your plan to upload more media.`,
          storage_limit: true,
        });
      }
    }
    // NB: do NOT increment here. This is a pre-flight check only — the client-supplied
    // `size` is unverified and the upload may never complete. Storage is counted when the
    // report is submitted, from the video's REAL R2 object size (HEAD-verified below), so
    // an abandoned upload isn't billed and a `size=0` request can't dodge the count.
    const ext = contentType.split('/')[1]?.split(';')[0] || 'mp4';
    const { uploadUrl, publicUrl } = await getPresignedUploadUrl('videos', ext, contentType);
    res.json({ uploadUrl, publicUrl });
  } catch (err) { req.log.error({ err }, 'route error'); res.status(500).json({ error: 'Failed to generate upload URL' }); }
});

module.exports = router;
