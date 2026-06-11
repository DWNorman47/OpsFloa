// Nightly R2 / storage wipe for demo (companies.is_demo = true) tenants.
//
// The public demo login lets anyone upload files, which consume R2 and the
// storage counter. This script — run by the nightly demo-refresh workflow —
// deletes the demo tenant's R2 objects, clears their DB references, and
// resets the storage counter so the 200 MB cap starts fresh each day.
//
// R2 keys are random UUIDs (not company-prefixed), so objects can't be
// listed by prefix; we enumerate them from the DB tables that store R2
// URLs. Object deletion is best-effort and needs R2_* credentials; the DB
// cleanup + counter reset only need DATABASE_URL, so the script still
// bounds growth even when R2 creds aren't present in the job environment.

const pool = require('../db');
const { deleteByUrl } = require('../r2');

const hasR2 = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_PUBLIC_URL);

// Single-URL sources: a SELECT returning a `url` column for the company,
// and a DELETE/UPDATE that removes the reference afterwards.
const URL_SOURCES = [
  { name: 'field_report_photos',
    select: `SELECT ph.url FROM field_report_photos ph JOIN field_reports r ON r.id = ph.report_id WHERE r.company_id = $1 AND ph.url IS NOT NULL`,
    clear:  `DELETE FROM field_report_photos ph USING field_reports r WHERE r.id = ph.report_id AND r.company_id = $1` },
  { name: 'reimbursements',
    select: `SELECT receipt_url AS url FROM reimbursements WHERE company_id = $1 AND receipt_url IS NOT NULL`,
    clear:  `UPDATE reimbursements SET receipt_url = NULL WHERE company_id = $1` },
  { name: 'project_expenses',
    select: `SELECT receipt_url AS url FROM project_expenses WHERE company_id = $1 AND receipt_url IS NOT NULL`,
    clear:  `UPDATE project_expenses SET receipt_url = NULL WHERE company_id = $1` },
  { name: 'worker_documents',
    select: `SELECT url FROM worker_documents WHERE company_id = $1 AND url IS NOT NULL`,
    clear:  `DELETE FROM worker_documents WHERE company_id = $1` },
  { name: 'client_documents',
    select: `SELECT d.url FROM client_documents d JOIN clients c ON c.id = d.client_id WHERE c.company_id = $1 AND d.url IS NOT NULL`,
    clear:  `DELETE FROM client_documents d USING clients c WHERE c.id = d.client_id AND c.company_id = $1` },
  { name: 'subcontractor_documents',
    select: `SELECT d.url FROM subcontractor_documents d JOIN subcontractors s ON s.id = d.subcontractor_id WHERE s.company_id = $1 AND d.url IS NOT NULL`,
    clear:  `DELETE FROM subcontractor_documents d USING subcontractors s WHERE s.id = d.subcontractor_id AND s.company_id = $1` },
  { name: 'submittal_documents',
    select: `SELECT d.url FROM submittal_documents d JOIN submittals sb ON sb.id = d.submittal_id WHERE sb.company_id = $1 AND d.url IS NOT NULL`,
    clear:  `DELETE FROM submittal_documents d USING submittals sb WHERE sb.id = d.submittal_id AND sb.company_id = $1` },
  { name: 'lien_waiver_documents',
    select: `SELECT d.url FROM lien_waiver_documents d JOIN lien_waivers lw ON lw.id = d.waiver_id WHERE lw.company_id = $1 AND d.url IS NOT NULL`,
    clear:  `DELETE FROM lien_waiver_documents d USING lien_waivers lw WHERE lw.id = d.waiver_id AND lw.company_id = $1` },
  { name: 'safety_talk_attachments',
    select: `SELECT a.url FROM safety_talk_attachments a JOIN safety_talks t ON t.id = a.talk_id WHERE t.company_id = $1 AND a.url IS NOT NULL`,
    clear:  `DELETE FROM safety_talk_attachments a USING safety_talks t WHERE t.id = a.talk_id AND t.company_id = $1` },
];

// JSONB array-of-URLs sources (photo_urls).
const JSON_SOURCES = [
  { name: 'inventory_items',
    select: `SELECT jsonb_array_elements_text(photo_urls) AS url FROM inventory_items WHERE company_id = $1`,
    clear:  `UPDATE inventory_items SET photo_urls = '[]'::jsonb WHERE company_id = $1` },
  { name: 'service_requests',
    select: `SELECT jsonb_array_elements_text(photo_urls) AS url FROM service_requests WHERE company_id = $1`,
    clear:  `UPDATE service_requests SET photo_urls = '[]'::jsonb WHERE company_id = $1` },
];

async function safeQuery(sql, params) {
  // Some tables may not exist in every environment (e.g. a module not yet
  // migrated). Don't let one missing table abort the whole wipe.
  try { return await pool.query(sql, params); }
  catch (err) {
    if (err.code === '42P01') return { rows: [], rowCount: 0 }; // undefined_table
    throw err;
  }
}

async function wipeCompany(companyId) {
  let urlsFound = 0, objectsDeleted = 0, rowsCleared = 0;
  const allSources = [...URL_SOURCES, ...JSON_SOURCES];

  for (const src of allSources) {
    const { rows } = await safeQuery(src.select, [companyId]);
    for (const { url } of rows) {
      if (!url) continue;
      urlsFound++;
      if (hasR2) {
        try { await deleteByUrl(url); objectsDeleted++; }
        catch (err) { console.warn(`[wipe] failed to delete object: ${err.message}`); }
      }
    }
    const res = await safeQuery(src.clear, [companyId]);
    rowsCleared += res.rowCount || 0;
  }

  await pool.query('UPDATE companies SET storage_bytes_used = 0 WHERE id = $1', [companyId]);
  return { urlsFound, objectsDeleted, rowsCleared };
}

async function main() {
  const { rows } = await pool.query('SELECT id, name FROM companies WHERE is_demo = true');
  if (rows.length === 0) {
    console.log('[wipe] no demo companies found — nothing to do');
    return;
  }
  if (!hasR2) {
    console.warn('[wipe] R2 credentials not set — clearing DB references + storage counter only (objects not deleted)');
  }
  for (const company of rows) {
    const summary = await wipeCompany(company.id);
    console.log(JSON.stringify({ company: company.name, ...summary }));
  }
}

main()
  .then(() => pool.end())
  .catch(err => { console.error(err); pool.end(); process.exit(1); });
