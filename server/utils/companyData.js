// ONE registry of every table that holds a company's data — used by BOTH the
// super-admin company hard-delete (purge) and the company data export, so the
// two can't drift apart again (they did: the export was missing invoice_payments,
// work_orders, haul_tickets, payroll runs, rate history, direct messages, …, and
// the purge never touched haul_tickets — whose NO-ACTION created_by FK then made
// every delete of a company that used haul tickets 500).
//
// `tests/companyDataRegistry.test.js` scans schema.sql + every migration for a
// table with a company_id column and fails unless it is listed here (or in
// EXCLUDED_COMPANY_TABLES with a reason). Adding a company_id table without
// registering it breaks the build — on purpose.
//
// Entry shape:
//   { table, where?, export? }
//   - where:  SQL predicate selecting this company's rows; `$1` is the company id.
//             Defaults to `company_id = $1`. Child tables with no company_id of
//             their own select through their parent.
//   - export: false to leave a table out of the customer-facing export (platform
//             forensics / secrets); it is still purged.
//
// ORDER = purge order: children before parents, anything holding a RESTRICT /
// NO ACTION reference before the row it references, `companies` last. The purge
// additionally retries FK-blocked steps (see purgeCompanyRows), so a new
// ordering hazard degrades to an extra pass rather than a 500 — but keep the
// order right; the retry is a safety net, not the design.

const CO = 'company_id = $1';
const via = (fk, parent, parentKey = 'id', parentWhere = CO) =>
  `${fk} IN (SELECT ${parentKey} FROM ${parent} WHERE ${parentWhere})`;

const COMPANY_TABLES = [
  // ── Field / safety leaf records ──────────────────────────────────────────
  { table: 'field_report_photos',          where: via('report_id', 'field_reports') },
  { table: 'entry_messages' },
  { table: 'equipment_hours' },
  { table: 'company_chat_reads',           export: false }, // per-admin chat read markers (0216) — UI state, not customer data
  { table: 'company_chat' },
  { table: 'direct_messages' },
  { table: 'incident_reports' },
  { table: 'sub_reports' },
  { table: 'rfis' },
  { table: 'inspections' },
  { table: 'inspection_templates' },
  { table: 'safety_checklist_submissions' },
  { table: 'daily_checklist_item_user_state', where: via('item_id', 'daily_checklist_items', 'id', via('daily_checklist_id', 'daily_checklists')) },
  { table: 'daily_checklist_items',        where: via('daily_checklist_id', 'daily_checklists') },
  { table: 'daily_checklists' },
  { table: 'daily_checklist_recurring_items' },
  { table: 'daily_checklist_assignments' },
  { table: 'safety_checklist_templates' },
  { table: 'field_reports' },
  { table: 'daily_report_manpower',        where: via('report_id', 'daily_reports') },
  { table: 'daily_report_equipment',       where: via('report_id', 'daily_reports') },
  { table: 'daily_report_materials',       where: via('report_id', 'daily_reports') },
  { table: 'daily_reports' },
  { table: 'punchlist_checklist_items',    where: via('punchlist_id', 'punchlist_items') },
  { table: 'punchlist_items' },
  { table: 'safety_talk_signoffs',         where: via('talk_id', 'safety_talks') },
  { table: 'safety_talk_questions',        where: via('talk_id', 'safety_talks') },
  { table: 'safety_talk_attachments',      where: via('talk_id', 'safety_talks') },
  { table: 'safety_talks' },
  { table: 'haul_tickets' },               // created_by was NO ACTION → must precede users (0212 also makes it SET NULL)

  // ── Tools / plan room / recordings ───────────────────────────────────────
  { table: 'live_sessions' },
  { table: 'takeoff_projects' },
  { table: 'recording_utterances',         where: via('recording_id', 'recordings') },
  { table: 'recordings' },
  { table: 'recording_uploads' },
  { table: 'office_ai_usage' },
  { table: 'location_pings' },
  { table: 'legal_acceptances' },

  // ── Timekeeping / payroll ────────────────────────────────────────────────
  { table: 'time_entries' },
  { table: 'active_clock' },
  { table: 'pay_periods' },
  { table: 'shifts' },
  { table: 'project_work_days' },
  { table: 'payroll_run_checks' },
  { table: 'payroll_runs' },
  { table: 'qbo_payroll_journals' },
  { table: 'qbo_bill_range_pay' },
  { table: 'qbo_bill_pushes' },

  // ── Worker-level records ─────────────────────────────────────────────────
  { table: 'worker_documents' },
  { table: 'worker_availability' },
  { table: 'worker_fringes' },
  { table: 'worker_deductions' },
  { table: 'worker_rate_history' },
  { table: 'certified_payroll_signatures' },
  { table: 'time_off_requests' },
  { table: 'reimbursements' },

  // ── Inventory (transactions / counts / PO lines RESTRICT-ref items + uoms) ─
  { table: 'inventory_transactions' },
  { table: 'inventory_count_assignments',  where: via('cycle_count_id', 'inventory_cycle_counts') },
  { table: 'inventory_count_workers',      where: via('cycle_count_id', 'inventory_cycle_counts') },
  { table: 'inventory_cycle_count_lines',  where: via('cycle_count_id', 'inventory_cycle_counts') },
  { table: 'inventory_cycle_counts' },
  { table: 'purchase_order_lines',         where: via('po_id', 'purchase_orders') },
  { table: 'purchase_orders' },
  { table: 'estimate_assembly_items',      where: via('assembly_id', 'estimate_assemblies') },
  { table: 'estimate_assemblies' },
  { table: 'inventory_stock' },
  { table: 'inventory_item_uoms' },
  { table: 'inventory_items' },
  { table: 'inventory_compartments' },
  { table: 'inventory_bays' },
  { table: 'inventory_racks' },
  { table: 'inventory_areas' },
  { table: 'inventory_locations' },
  { table: 'inventory_suppliers' },

  // ── Project-level records (RESTRICT sub-ledgers before projects) ─────────
  { table: 'project_documents' },
  { table: 'invoice_lines',                where: via('invoice_id', 'invoices') },
  { table: 'invoice_audit',                where: via('invoice_id', 'invoices') },
  { table: 'invoice_payments' },
  { table: 'invoices' },
  { table: 'project_invoices' },
  { table: 'lien_waiver_documents',        where: via('waiver_id', 'lien_waivers') },
  { table: 'lien_waivers' },
  { table: 'subcontract_po_payments',      where: via('po_id', 'subcontract_pos') },
  { table: 'subcontract_pos' },
  { table: 'subcontractor_documents',      where: via('subcontractor_id', 'subcontractors') },
  { table: 'subcontractors' },
  { table: 'change_order_lines',           where: via('change_order_id', 'change_orders') },
  { table: 'change_orders' },
  { table: 'submittal_documents',          where: via('submittal_id', 'submittals') },
  { table: 'submittal_audit',              where: via('submittal_id', 'submittals') },
  { table: 'submittals' },
  { table: 'project_closeout_items',       where: via('closeout_id', 'project_closeouts') },
  { table: 'project_closeouts' },
  { table: 'closeout_checklist_template' },
  { table: 'project_expenses' },
  { table: 'project_budget_categories',    where: via('project_id', 'projects') },
  { table: 'project_prevailing_rate_history' },
  { table: 'estimate_lines',               where: via('estimate_id', 'estimates') },
  { table: 'estimate_audit',               where: via('estimate_id', 'estimates') },
  { table: 'estimates' },

  // ── Support / SaaS surfaces ──────────────────────────────────────────────
  { table: 'service_requests' },
  { table: 'work_orders' },
  { table: 'qbo_sync_errors' },
  { table: 'client_errors' },
  { table: 'inbox' },
  { table: 'push_subscriptions' },
  { table: 'audit_log' },
  { table: 'equipment_checkouts' },
  { table: 'equipment_maintenance_logs' },
  { table: 'equipment_items' },

  // ── Booking (appointments RESTRICT-ref users + appointment_types) ────────
  { table: 'appointment_audit',            where: via('appointment_id', 'appointments') },
  { table: 'appointments' },
  { table: 'appointment_type_users',       where: via('appointment_type_id', 'appointment_types') },
  { table: 'appointment_type_shift_types', where: via('appointment_type_id', 'appointment_types') },
  { table: 'appointment_types' },
  { table: 'shift_types' },
  { table: 'bookable_windows',             where: via('user_id', 'users') },

  // impersonation_log.super_admin_id is NOT NULL … ON DELETE SET NULL (a
  // contradiction), so rows pointing at this company's users must go before the
  // users do. Platform forensics — purged, never handed to the customer.
  { table: 'impersonation_log', where: `company_id = $1 OR super_admin_id IN (SELECT id FROM users WHERE company_id = $1)`, export: false },

  // ── Base entities ────────────────────────────────────────────────────────
  { table: 'company_public_profiles' },
  { table: 'company_default_rate_history' },
  { table: 'company_prevailing_rate_history' }, // 0210
  { table: 'client_documents' },
  { table: 'clients' },
  { table: 'projects' },
  { table: 'advanced_settings' },
  { table: 'settings' },
  { table: 'role_permissions',             where: via('role_id', 'roles') },
  { table: 'users' },
  { table: 'roles' },
  { table: 'companies',                    where: 'id = $1', export: false }, // exported separately as the header object
];

// Tables that carry a company_id column but are deliberately NOT company data.
// (Empty today — every company_id table is registered above.) Each entry needs a
// reason; the registry test enforces that nothing lands here silently.
const EXCLUDED_COMPANY_TABLES = {};

const whereOf = (entry) => entry.where || CO;

// Column names never handed out in an export (credentials, live link tokens,
// OAuth tokens, MFA seeds, push-subscription keys).
const SECRET_COLUMN_RE = /(password|secret|token|nonce|p256dh|^auth$)/i;
function scrubRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (SECRET_COLUMN_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

const EXPORT_TABLES = COMPANY_TABLES.filter(e => e.export !== false);

// R2 media referenced by company rows — collected BEFORE the purge so the objects
// can be deleted from the bucket once the DB delete commits. Each query returns
// rows with a `url` column; non-R2 / relative URLs are ignored by r2.deleteByUrl.
const MEDIA_URL_QUERIES = [
  `SELECT url FROM field_report_photos WHERE ${via('report_id', 'field_reports')} AND url IS NOT NULL`,
  `SELECT receipt_url AS url FROM reimbursements WHERE ${CO} AND receipt_url IS NOT NULL`,
  `SELECT receipt_url AS url FROM project_expenses WHERE ${CO} AND receipt_url IS NOT NULL`,
  `SELECT url FROM worker_documents   WHERE ${CO} AND url IS NOT NULL`,
  `SELECT url FROM project_documents  WHERE ${CO} AND url IS NOT NULL`,
  `SELECT url FROM client_documents   WHERE ${CO} AND url IS NOT NULL`,
  `SELECT url FROM safety_talk_attachments WHERE ${via('talk_id', 'safety_talks')} AND url IS NOT NULL`,
  `SELECT url FROM subcontractor_documents WHERE ${via('subcontractor_id', 'subcontractors')} AND url IS NOT NULL`,
  `SELECT url FROM submittal_documents WHERE ${via('submittal_id', 'submittals')} AND url IS NOT NULL`,
  `SELECT url FROM lien_waiver_documents WHERE ${via('waiver_id', 'lien_waivers')} AND url IS NOT NULL`,
  `SELECT pdf_url AS url FROM lien_waivers WHERE ${CO} AND pdf_url IS NOT NULL`,
  `SELECT audio_url AS url FROM recordings WHERE ${CO} AND audio_url IS NOT NULL`,
  `SELECT public_url AS url FROM recording_uploads WHERE ${CO} AND public_url IS NOT NULL`,
  `SELECT pdf_url AS url FROM takeoff_projects WHERE ${CO} AND pdf_url IS NOT NULL`,
  `SELECT pdf_url AS url FROM live_sessions WHERE ${CO} AND pdf_url IS NOT NULL`,
  `SELECT plan_pdf_url AS url FROM estimates WHERE ${CO} AND plan_pdf_url IS NOT NULL`,
  `SELECT photo_url AS url FROM equipment_items WHERE ${CO} AND photo_url IS NOT NULL`,
  `SELECT checkout_photo_url AS url FROM equipment_checkouts WHERE ${CO} AND checkout_photo_url IS NOT NULL`,
  `SELECT return_photo_url AS url FROM equipment_checkouts WHERE ${CO} AND return_photo_url IS NOT NULL`,
  `SELECT logo_url AS url FROM companies WHERE id = $1 AND logo_url IS NOT NULL`,
  // JSONB arrays of url strings
  ...['inventory_locations', 'inventory_areas', 'inventory_racks', 'inventory_bays', 'inventory_compartments', 'service_requests']
    .map(t => `SELECT jsonb_array_elements_text(photo_urls) AS url FROM ${t} WHERE ${CO} AND jsonb_array_length(photo_urls) > 0`),
  // company_public_profiles.photos: JSONB array of {url, caption, alt} objects (or bare strings)
  `SELECT COALESCE(e->>'url', e #>> '{}') AS url FROM company_public_profiles p, jsonb_array_elements(p.photos) e WHERE p.${CO}`,
];

// Delete every registered table's rows for this company, in registry order, inside
// the caller's transaction, ending with the company row itself.
//
// Each step runs under a SAVEPOINT. An FK violation (23503) rolls back just that
// step and retries it after the remaining steps (another pass) — so an ordering
// mistake costs a pass instead of 500-ing the whole wipe. A table that doesn't
// exist on this deployment (42P01) is skipped. Anything else aborts (caller rolls
// back). If a pass makes no progress the last FK error is thrown.
async function purgeCompanyRows(client, id, { logger } = {}) {
  let pending = COMPANY_TABLES.slice();
  for (let pass = 0; pending.length > 0; pass++) {
    const blocked = [];
    let lastFkErr = null;
    for (const entry of pending) {
      await client.query('SAVEPOINT sp_purge');
      try {
        await client.query(`DELETE FROM ${entry.table} WHERE ${whereOf(entry)}`, [id]);
        await client.query('RELEASE SAVEPOINT sp_purge');
      } catch (err) {
        if (err && (err.code === '23503' || err.code === '42P01')) {
          await client.query('ROLLBACK TO SAVEPOINT sp_purge');
          await client.query('RELEASE SAVEPOINT sp_purge');
          if (err.code === '23503') { blocked.push(entry); lastFkErr = err; }
          else if (logger) logger.warn({ table: entry.table }, 'company purge: table missing, skipped');
          continue;
        }
        throw err;
      }
    }
    if (blocked.length === 0) return;
    if (blocked.length === pending.length) throw lastFkErr;
    if (logger) logger.warn({ pass, blocked: blocked.map(e => e.table) }, 'company purge: FK-blocked steps retried');
    pending = blocked;
  }
}

module.exports = {
  COMPANY_TABLES,
  EXPORT_TABLES,
  EXCLUDED_COMPANY_TABLES,
  MEDIA_URL_QUERIES,
  purgeCompanyRows,
  scrubRow,
  whereOf,
};
