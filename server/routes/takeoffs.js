/**
 * Company-shared takeoff projects (sitework takeoff tool).
 *
 * Single source of truth per takeoff; teammates open / edit / save it one at a
 * time. `version` gives optimistic-concurrency conflict detection so a stale
 * save doesn't silently overwrite a teammate's work. Company-scoped; mounted
 * with requireAuth (req.user set on every route). The plan PDF lives in R2.
 */

const router = require('express').Router();
const pool = require('../db');
const { uploadBase64, deleteByUrl, getBytesByUrl, getPresignedUploadUrl, keyFromPublicUrl } = require('../r2');

const isAdmin = req => req.user.role === 'admin' || req.user.role === 'super_admin';

// GET /  — this company's shared projects (metadata only, newest edit first).
// The table serves every plan tool; rows carry a data.app marker. ?app=<marker>
// filters to one tool's library. No param = the sitework takeoff tool (its
// shipped client predates the marker filter and must keep working unchanged),
// so the default excludes other tools' rows rather than requiring the param.
router.get('/', async (req, res) => {
  try {
    const app = req.query.app ? String(req.query.app) : null;
    const { rows } = await pool.query(
      `SELECT t.id, t.name, t.pdf_name, t.version, t.updated_at, t.created_by,
              u.full_name AS updated_by_name
         FROM takeoff_projects t
         LEFT JOIN users u ON u.id = t.updated_by
        WHERE t.company_id = $1
          AND ${app ? `t.data->>'app' = $2`
                    : `COALESCE(t.data->>'app', 'excavation-bid-calculator') = 'excavation-bid-calculator'`}
        ORDER BY t.updated_at DESC`,
      app ? [req.user.company_id, app] : [req.user.company_id]);
    res.json(rows);
  } catch (err) { req.log && req.log.error({ err }, 'takeoffs list'); res.status(500).json({ error: 'server error' }); }
});

// POST /upload-url — presigned direct-to-R2 PUT for large plan documents
// (full plan sets run 50–200 MB, far past the JSON-body path). The browser
// PUTs the file straight to R2, then POSTs the returned publicUrl as pdfUrl.
// Requires CORS on the R2 bucket (browser PUT to the S3 endpoint).
const UPLOAD_TYPES = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', webp: 'image/webp',
};
router.post('/upload-url', async (req, res) => {
  try {
    const ext = String((req.body || {}).ext || '').toLowerCase();
    if (!UPLOAD_TYPES[ext]) return res.status(400).json({ error: 'unsupported file type' });
    const out = await getPresignedUploadUrl('takeoffs', ext, UPLOAD_TYPES[ext]);
    res.json(out); // { uploadUrl, publicUrl, key }
  } catch (err) { req.log && req.log.error({ err }, 'takeoffs upload-url'); res.status(500).json({ error: 'server error' }); }
});

// GET /:id  — full takeoff: data + PDF url + current version
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, data, pdf_url, pdf_name, version
         FROM takeoff_projects WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (err) { req.log && req.log.error({ err }, 'takeoffs get'); res.status(500).json({ error: 'server error' }); }
});

// GET /:id/pdf  — the plan PDF, proxied from R2 as base64 (avoids R2 CORS)
router.get('/:id/pdf', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT pdf_url, pdf_name FROM takeoff_projects WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]);
    if (!rows.length || !rows[0].pdf_url) return res.status(404).json({ error: 'no pdf' });
    const bytes = await getBytesByUrl(rows[0].pdf_url);
    if (!bytes) return res.status(404).json({ error: 'no pdf' });
    res.json({ name: rows[0].pdf_name || 'plan.pdf', b64: bytes.toString('base64') });
  } catch (err) { req.log && req.log.error({ err }, 'takeoffs pdf'); res.status(500).json({ error: 'server error' }); }
});

// POST /  — create a new shared project.
// { name, data, pdfName?, pdfBase64? }        — small docs, through the API
// { name, data, pdfName?, pdfUrl? }           — big docs, presigned direct upload
router.post('/', async (req, res) => {
  try {
    const { name, data, pdfBase64, pdfName } = req.body || {};
    let pdfUrl = null;
    if (req.body && req.body.pdfUrl) {
      // must be an object in OUR bucket (from /upload-url), not an arbitrary URL
      if (!keyFromPublicUrl(String(req.body.pdfUrl))) return res.status(400).json({ error: 'bad pdfUrl' });
      pdfUrl = String(req.body.pdfUrl);
    } else if (pdfBase64) {
      const up = await uploadBase64(`data:application/pdf;base64,${pdfBase64}`, 'takeoffs');
      pdfUrl = up.url;
    }
    const { rows } = await pool.query(
      `INSERT INTO takeoff_projects (company_id, name, data, pdf_url, pdf_name, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       RETURNING id, version`,
      [req.user.company_id, String(name || 'Takeoff').slice(0, 200),
       JSON.stringify(data || {}), pdfUrl, pdfName || null, req.user.id]);
    res.json(rows[0]);
  } catch (err) { req.log && req.log.error({ err }, 'takeoffs create'); res.status(500).json({ error: 'server error' }); }
});

// PUT /:id  — save changes with optimistic concurrency.  { name?, data?, version }
router.put('/:id', async (req, res) => {
  try {
    const { name, data, version } = req.body || {};
    const cur = await pool.query(
      `SELECT t.version, t.updated_at, u.full_name AS updated_by_name
         FROM takeoff_projects t LEFT JOIN users u ON u.id = t.updated_by
        WHERE t.id = $1 AND t.company_id = $2`,
      [req.params.id, req.user.company_id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'not found' });
    if (version != null && Number(version) !== cur.rows[0].version) {
      return res.status(409).json({
        error: 'conflict', currentVersion: cur.rows[0].version,
        updatedByName: cur.rows[0].updated_by_name, updatedAt: cur.rows[0].updated_at,
      });
    }
    const { rows } = await pool.query(
      `UPDATE takeoff_projects
          SET name = COALESCE($3, name), data = COALESCE($4, data),
              version = version + 1, updated_by = $5, updated_at = now()
        WHERE id = $1 AND company_id = $2
        RETURNING version`,
      [req.params.id, req.user.company_id,
       name != null ? String(name).slice(0, 200) : null,
       data != null ? JSON.stringify(data) : null, req.user.id]);
    res.json(rows[0]);
  } catch (err) { req.log && req.log.error({ err }, 'takeoffs update'); res.status(500).json({ error: 'server error' }); }
});

// DELETE /:id  — creator or an admin
router.delete('/:id', async (req, res) => {
  try {
    const cur = await pool.query(
      `SELECT created_by, pdf_url FROM takeoff_projects WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'not found' });
    if (cur.rows[0].created_by !== req.user.id && !isAdmin(req)) return res.status(403).json({ error: 'forbidden' });
    await pool.query(`DELETE FROM takeoff_projects WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.company_id]);
    if (cur.rows[0].pdf_url) deleteByUrl(cur.rows[0].pdf_url).catch(() => {});
    res.json({ ok: true });
  } catch (err) { req.log && req.log.error({ err }, 'takeoffs delete'); res.status(500).json({ error: 'server error' }); }
});

module.exports = router;
