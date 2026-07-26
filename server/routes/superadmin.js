const router = require('express').Router();
const pool = require('../db');
const logger = require('../logger');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { requireSuperAdmin } = require('../middleware/auth');
const { seedBuiltinRoles } = require('../permissions');
const { COMPANY_SUBSCRIPTION_STATUSES, COMPANY_PLANS } = require('../constants/companyEnums');
const { validatePassword } = require('../passwordPolicy');
const { logAudit } = require('../auditLog');

const DEMO_COMPANY_NAME = 'OpsFloa Demo Workspace';
const DEMO_COMPANY_SLUG = 'opsfloa-demo-workspace';
const DEMO_PASSWORD = 'DemoPass!2026';

async function insertDemoUser(client, companyId, roleId, role, username, fullName, email, rate = 34, workerType = 'employee') {
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const [firstName, ...rest] = fullName.split(' ');
  const { rows } = await client.query(
    `INSERT INTO users
      (company_id, username, password_hash, full_name, first_name, last_name, role, role_id, email,
       email_confirmed, hourly_rate, rate_type, overtime_rule, worker_type, welcomed_at, active, timezone)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,'hourly','daily',$11,NOW(),true,'America/Phoenix')
     RETURNING id, username, full_name, role`,
    [companyId, username, hash, fullName, firstName, rest.join(' ') || null, role, roleId, email, rate, workerType]
  );
  return rows[0];
}

// The full company-data delete, in parent-correct order so no FK RESTRICT fires,
// ending with the company row itself. Runs inside the caller's transaction.
//
// Shared by the superadmin company wipe and the demo-workspace reset so the two
// can't drift. A divergence is exactly how the demo reset ended up missing the
// booking tables (0113): its own short list deleted `users` while seeded
// `appointments` still pointed at them (assigned_user_id ON DELETE RESTRICT), so
// the next reset would 500. Deleting 0 rows is a harmless no-op for any table a
// given company never used, so running the full sequence against the demo is safe.
async function purgeCompanyRows(client, id) {
  // ── Leaf tables (children of things we're about to delete) ──────────────
  await client.query(`DELETE FROM field_report_photos WHERE report_id IN (SELECT id FROM field_reports WHERE company_id = $1)`, [id]);
  await client.query(`DELETE FROM entry_messages              WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM equipment_hours             WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM company_chat                WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM incident_reports            WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM sub_reports                 WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM rfis                        WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM inspections                 WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM inspection_templates        WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM safety_checklist_submissions WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM safety_checklist_templates  WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM field_reports               WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM daily_reports               WHERE company_id = $1`, [id]); // cascades report_manpower/equipment/materials
  await client.query(`DELETE FROM punchlist_items             WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM safety_talks                WHERE company_id = $1`, [id]); // cascades signoffs/attachments/quiz

  // ── Timekeeping ─────────────────────────────────────────────────────────
  await client.query(`DELETE FROM time_entries                WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM active_clock                WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM pay_periods                 WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM shifts                      WHERE company_id = $1`, [id]);

  // ── Worker-level records ────────────────────────────────────────────────
  await client.query(`DELETE FROM worker_documents            WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM worker_availability         WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM worker_fringes              WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM certified_payroll_signatures WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM time_off_requests           WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM reimbursements              WHERE company_id = $1`, [id]);

  // ── Inventory (order matters: transactions & cycle counts reference items/locations via RESTRICT) ──
  await client.query(`DELETE FROM inventory_transactions      WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM inventory_cycle_counts      WHERE company_id = $1`, [id]); // cascades cycle_count_lines + worker assignments
  await client.query(`DELETE FROM purchase_orders             WHERE company_id = $1`, [id]); // cascades purchase_order_lines
  await client.query(`DELETE FROM inventory_items             WHERE company_id = $1`, [id]); // cascades stock, item_uoms
  await client.query(`DELETE FROM inventory_locations         WHERE company_id = $1`, [id]); // cascades areas → racks → bays → compartments
  await client.query(`DELETE FROM inventory_suppliers         WHERE company_id = $1`, [id]);

  // ── Project-level records ───────────────────────────────────────────────
  await client.query(`DELETE FROM project_documents           WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM invoices                    WHERE company_id = $1`, [id]); // cascades invoice_lines/payments/audit
  await client.query(`DELETE FROM project_invoices            WHERE company_id = $1`, [id]); // dormant QBO mirror (retired; kept as backup)

  // Project sub-ledgers whose project_id FK is ON DELETE RESTRICT (subcontract
  // POs from 0107 + the 0114 audit-followup tables). These MUST be deleted
  // before `DELETE FROM projects` below, or that delete raises an FK violation
  // and the whole wipe rolls back (500 — the company can never be deleted).
  // subcontract_pos first (subcontractors' subcontractor_id is also RESTRICT);
  // each parent CASCADEs its own children.
  await client.query(`DELETE FROM subcontract_pos            WHERE company_id = $1`, [id]); // cascades subcontract_po_payments
  await client.query(`DELETE FROM subcontractors            WHERE company_id = $1`, [id]); // cascades subcontractor_documents
  await client.query(`DELETE FROM lien_waivers              WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM change_orders             WHERE company_id = $1`, [id]); // cascades change_order_lines
  await client.query(`DELETE FROM submittals                WHERE company_id = $1`, [id]); // cascades submittal children
  await client.query(`DELETE FROM project_closeouts         WHERE company_id = $1`, [id]); // cascades project_closeout_items
  await client.query(`DELETE FROM project_expenses          WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM project_budget_categories WHERE project_id IN (SELECT id FROM projects WHERE company_id = $1)`, [id]); // no company_id column
  await client.query(`DELETE FROM estimates                 WHERE company_id = $1`, [id]); // cascades estimate_lines/audit; frees converted_project_id

  // ── Support / SaaS surfaces ─────────────────────────────────────────────
  await client.query(`DELETE FROM service_requests            WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM qbo_sync_errors             WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM client_errors               WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM inbox                       WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM push_subscriptions          WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM audit_log                   WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM equipment_items             WHERE company_id = $1`, [id]);

  // ── Booking module (0113) ───────────────────────────────────────────────
  // appointments.assigned_user_id AND .appointment_type_id are both ON DELETE
  // RESTRICT, so appointments must go before users (below) and appointment_types.
  await client.query(`DELETE FROM appointments                WHERE company_id = $1`, [id]); // cascades appointment_audit
  await client.query(`DELETE FROM appointment_types           WHERE company_id = $1`, [id]); // cascades appointment_type_users/_shift_types
  await client.query(`DELETE FROM shift_types                 WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM bookable_windows            WHERE user_id IN (SELECT id FROM users WHERE company_id = $1)`, [id]); // no company_id; also CASCADEs from users

  // impersonation_log has a constraint bug: super_admin_id is NOT NULL
  // REFERENCES users(id) ON DELETE SET NULL, which is contradictory. If
  // any user in this company is referenced as super_admin_id, the
  // DELETE FROM users below would fail. Clear out any rows referencing
  // users in this company — and any rows where this company was the
  // impersonation target — before the user delete fires.
  await client.query(
    `DELETE FROM impersonation_log
      WHERE company_id = $1
         OR super_admin_id IN (SELECT id FROM users WHERE company_id = $1)`,
    [id]
  );

  // ── Base entities ───────────────────────────────────────────────────────
  await client.query(`DELETE FROM clients                     WHERE company_id = $1`, [id]); // cascades client_documents
  await client.query(`DELETE FROM projects                    WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM advanced_settings           WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM settings                    WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM role_permissions            WHERE role_id IN (SELECT id FROM roles WHERE company_id = $1)`, [id]);
  await client.query(`DELETE FROM users                       WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM roles                       WHERE company_id = $1`, [id]);
  await client.query(`DELETE FROM companies                   WHERE id = $1`, [id]);
}

async function deleteDemoWorkspace(client) {
  const { rows } = await client.query('SELECT id FROM companies WHERE slug = $1', [DEMO_COMPANY_SLUG]);
  for (const { id } of rows) {
    await purgeCompanyRows(client, id);
  }
}

async function createDemoWorkspace(client) {
  const { rows } = await client.query(
    `INSERT INTO companies
      (name, slug, subscription_status, plan, trial_ends_at, pro_addon, addon_qbo, addon_certified_payroll, addon_takeoff, addon_planroom,
       address, phone, contact_email, accepts_service_requests, client_portal_pro_interest, registration_ip)
     VALUES ($1,$2,'exempt','business',NOW() + INTERVAL '90 days',true,true,true,true,true,
       '7427 Innovation Loop, Phoenix, AZ 85004','(602) 555-0198','ops@example.com',true,true,'127.0.0.1')
     RETURNING id, name, slug, plan, subscription_status, created_at`,
    [DEMO_COMPANY_NAME, DEMO_COMPANY_SLUG]
  );
  const company = rows[0];
  const { workerId, ownerId } = await seedBuiltinRoles(client, company.id);
  const admin = await insertDemoUser(client, company.id, ownerId, 'admin', 'demo.admin', 'Taylor Morgan', 'taylor.morgan@example.com', 72);
  const workers = [
    await insertDemoUser(client, company.id, workerId, 'worker', 'alex.rivera', 'Alex Rivera', 'alex.rivera@example.com', 32),
    await insertDemoUser(client, company.id, workerId, 'worker', 'jordan.lee', 'Jordan Lee', 'jordan.lee@example.com', 34),
    await insertDemoUser(client, company.id, workerId, 'worker', 'priya.singh', 'Priya Singh', 'priya.singh@example.com', 38),
    await insertDemoUser(client, company.id, workerId, 'worker', 'marcus.chen', 'Marcus Chen', 'marcus.chen@example.com', 36, 'contractor'),
  ];

  const settings = {
    prevailing_wage_rate: '45', default_hourly_rate: '34', overtime_multiplier: '1.5',
    overtime_rule: 'daily', overtime_threshold: '8',
    module_timeclock: '1', module_field: '1', module_work: '1', module_inventory: '1', module_tools: '1', module_analytics: '1', module_team: '1',
    module_financial_reports: '1',
    feature_scheduling: '1', feature_analytics: '1', feature_chat: '1', feature_prevailing_wage: '1',
    feature_reimbursements: '1', feature_pto: '1', feature_project_integration: '1', feature_overtime: '1',
    feature_geolocation: '1', feature_overtime_alerts: '1', feature_media_gallery: '1',
    feature_admin_edit_time: '1', feature_worker_edit_time: '1', show_worker_wages: '1',
    company_timezone: 'America/Phoenix', setup_questionnaire_completed_at: new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(settings)) {
    await client.query(
      `INSERT INTO settings (company_id, key, value) VALUES ($1,$2,$3)
       ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [company.id, key, value]
    );
  }

  const clients = [];
  for (const row of [
    ['North Valley Property Group', 'Mia Carter', 'mia.carter@example.com', '(602) 555-0141', '1200 N Central Ave, Phoenix, AZ'],
    ['Mesa Facilities Co-op', 'Owen Brooks', 'owen.brooks@example.com', '(480) 555-0182', '88 S Center St, Mesa, AZ'],
    ['Desert Bloom Hospitality', 'Nina Patel', 'nina.patel@example.com', '(623) 555-0166', '515 W Roosevelt St, Phoenix, AZ'],
  ]) {
    const r = await client.query(
      `INSERT INTO clients (company_id, name, contact_name, contact_email, contact_phone, address, notes)
       VALUES ($1,$2,$3,$4,$5,$6,'Fake demo client for local development') RETURNING id, name`,
      [company.id, ...row]
    );
    clients.push(r.rows[0]);
  }

  const projects = [];
  for (const p of [
    ['North Valley Route', clients[0].id, clients[0].name, 'NV-2401', 'Phoenix, AZ', 'Recurring service route across three properties', 320, 27500, 42],
    ['Mesa Service Hub', clients[1].id, clients[1].name, 'MSH-101', 'Mesa, AZ', 'Facility maintenance and inventory staging', 180, 16400, 68],
    ['Desert Bloom Refresh', clients[2].id, clients[2].name, 'DBH-77', 'Phoenix, AZ', 'Guest-area refresh and checklist-driven closeout', 260, 31800, 35],
  ]) {
    const r = await client.query(
      `INSERT INTO projects
        (company_id, name, client_id, client_name, job_number, address, description, wage_type, status,
         budget_hours, budget_dollars, progress_pct, start_date, end_date, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'regular','in_progress',$8,$9,$10,
         CURRENT_DATE - INTERVAL '21 days',CURRENT_DATE + INTERVAL '45 days',true)
       RETURNING id, name`,
      [company.id, ...p]
    );
    projects.push(r.rows[0]);
  }

  for (const e of [
    [workers[0].id, projects[0].id, -4, '07:00', '15:30', 'Completed north route inspections and uploaded closeout notes.', 'approved', admin.id, 30],
    [workers[1].id, projects[0].id, -3, '08:00', '16:45', 'Replaced filters and documented access issue at Gate B.', 'approved', admin.id, 30],
    [workers[2].id, projects[1].id, -2, '06:30', '14:30', 'Cycle count prep and staging area labels.', 'pending', null, 20],
    [workers[3].id, projects[2].id, -1, '09:00', '17:15', 'Punch items reviewed with client contact.', 'pending', null, 30],
    [workers[0].id, projects[1].id, 0, '07:15', '11:45', 'Morning dispatch support and parts transfer.', 'pending', null, 0],
  ]) {
    await client.query(
      `INSERT INTO time_entries
        (company_id, user_id, project_id, work_date, start_time, end_time, start_ts, end_ts, wage_type, rate,
         notes, status, approved_by, approved_at, break_minutes, timezone, clock_source)
       VALUES ($1,$2,$3,CURRENT_DATE + ($4 || ' days')::INTERVAL,$5::time,$6::time,
         (CURRENT_DATE + ($4 || ' days')::INTERVAL + $5::time) AT TIME ZONE 'America/Phoenix',
         (CURRENT_DATE + ($4 || ' days')::INTERVAL + $6::time) AT TIME ZONE 'America/Phoenix',
         'regular',34,$7,$8::varchar,$9,CASE WHEN $8::varchar='approved' THEN NOW() - INTERVAL '1 day' ELSE NULL END,$10,'America/Phoenix','worker')`,
      [company.id, ...e]
    );
  }

  await client.query(
    `INSERT INTO active_clock (company_id, user_id, project_id, clock_in_time, work_date, notes, timezone, clock_source, current_lat, current_lng, location_updated_at)
     VALUES ($1,$2,$3,NOW() - INTERVAL '2 hours',CURRENT_DATE,'Live fake shift for local testing','America/Phoenix','worker',33.4484,-112.0740,NOW() - INTERVAL '8 minutes')`,
    [company.id, workers[1].id, projects[0].id]
  );

  await client.query(
    `INSERT INTO daily_reports (company_id, project_id, report_date, superintendent, weather_condition, weather_temp, work_performed, delays_issues, visitor_log, status, created_by)
     VALUES ($1,$2,CURRENT_DATE,'Taylor Morgan','Sunny',83,'Completed route checks, staged replacement parts, and reviewed open work notes.','One access delay at Gate B; follow-up assigned.','Client contact visited at 10:30 AM.','submitted',$3)`,
    [company.id, projects[0].id, admin.id]
  );

  const template = await client.query(
    `INSERT INTO safety_checklist_templates (company_id, name, description, scope, created_by, items)
     VALUES ($1,'Daily Readiness Check','General daily checklist for fake demo teams','general',$2,$3::jsonb) RETURNING id`,
    [company.id, admin.id, JSON.stringify([
      { id: 'gear', text: 'Required gear checked', type: 'checkbox' },
      { id: 'kit', text: 'Vehicle or kit inspected', type: 'checkbox' },
      { id: 'hazards', text: 'Hazards reviewed before work starts', type: 'checkbox' },
    ])]
  );
  await client.query(
    `INSERT INTO safety_checklist_submissions (company_id, template_id, template_name, project_id, submitted_by, submitted_by_name, check_date, answers, notes)
     VALUES ($1,$2,'Daily Readiness Check',$3,$4,'Alex Rivera',CURRENT_DATE,$5::jsonb,'Fake checklist submission for local demo data')`,
    [company.id, template.rows[0].id, projects[0].id, workers[0].id, JSON.stringify({ gear: true, kit: true, hazards: true })]
  );

  const depot = await client.query(`INSERT INTO inventory_locations (company_id, name, type, notes, address) VALUES ($1,'Phoenix Depot','warehouse','Main fake stock room','7427 Innovation Loop, Phoenix, AZ') RETURNING id`, [company.id]);
  const van = await client.query(`INSERT INTO inventory_locations (company_id, name, type, project_id, notes, address) VALUES ($1,'North Valley Route Van','vehicle',$2,'Rolling inventory for active route','Phoenix, AZ') RETURNING id`, [company.id, projects[0].id]);
  const itemRows = [];
  for (const item of [
    ['Tablet Mount Kit','TMK-100','Hardware','each',48.50,6,12,18,4],
    ['Service Gloves','GLV-NTR-M','Safety','box',12.75,10,20,26,8],
    ['Filter Cartridge','FLT-22A','Maintenance','each',31.20,8,16,14,3],
    ['Traffic Cones','CONE-28','Safety','each',18.00,12,24,40,10],
  ]) {
    const r = await client.query(
      `INSERT INTO inventory_items (company_id, name, sku, category, unit, unit_cost, reorder_point, reorder_qty, created_by, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Fake inventory item for local development') RETURNING id, name`,
      [company.id, ...item.slice(0, 7), admin.id]
    );
    itemRows.push(r.rows[0]);
    await client.query(`INSERT INTO inventory_stock (company_id, item_id, location_id, quantity) VALUES ($1,$2,$3,$4)`, [company.id, r.rows[0].id, depot.rows[0].id, item[7]]);
    await client.query(`INSERT INTO inventory_stock (company_id, item_id, location_id, quantity) VALUES ($1,$2,$3,$4)`, [company.id, r.rows[0].id, van.rows[0].id, item[8]]);
  }

  const count = await client.query(
    `INSERT INTO inventory_cycle_counts (company_id, location_id, status, started_by, notes, count_type)
     VALUES ($1,$2,'in_progress',$3,'Demo count assignment for worker testing','cycle') RETURNING id`,
    [company.id, depot.rows[0].id, admin.id]
  );
  await client.query(
    `INSERT INTO inventory_count_workers (cycle_count_id, user_id, roles) VALUES ($1,$2,$3)`,
    [count.rows[0].id, workers[0].id, ['counter']]
  );
  const line = await client.query(
    `INSERT INTO inventory_cycle_count_lines (cycle_count_id, item_id, expected_qty, location_id)
     VALUES ($1,$2,18,$3) RETURNING id`,
    [count.rows[0].id, itemRows[0].id, depot.rows[0].id]
  );
  await client.query(
    `INSERT INTO inventory_count_assignments (line_id, cycle_count_id, user_id, role)
     VALUES ($1,$2,$3,'counter')`,
    [line.rows[0].id, count.rows[0].id, workers[0].id]
  );

  return { company, admin, workers };
}

// GET /superadmin/client-errors — browser-reported errors, newest first
router.get('/client-errors', requireSuperAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const since = req.query.since; // ISO date string, optional
    const params = [];
    let where = '';
    if (since) {
      params.push(since);
      where = `WHERE ce.created_at >= $${params.length}`;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT ce.id, ce.created_at, ce.company_id, ce.user_id, ce.kind, ce.message,
              ce.stack, ce.url, ce.user_agent, ce.app_version, ce.ip,
              u.full_name AS user_name, c.name AS company_name
       FROM client_errors ce
       LEFT JOIN users u ON u.id = ce.user_id
       LEFT JOIN companies c ON c.id = ce.company_id
       ${where}
       ORDER BY ce.created_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /superadmin/companies — all companies with usage stats
router.get('/companies', requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.slug, c.active, c.created_at, c.plan, c.subscription_status,
              c.trial_ends_at, c.mrr_cents, c.affiliate_id, c.addon_qbo, c.addon_certified_payroll, c.addon_takeoff, c.addon_planroom, c.addon_storm, c.addon_roof, c.bonus_seats,
              a.name AS affiliate_name,
              COUNT(DISTINCT u.id) FILTER (WHERE u.role = 'worker' AND u.active = true) AS worker_count,
              COUNT(DISTINCT u.id) FILTER (WHERE u.role = 'admin' AND u.active = true) AS admin_count,
              COUNT(DISTINCT te.id) AS entry_count,
              MAX(te.created_at) AS last_entry_at
       FROM companies c
       LEFT JOIN users u ON u.company_id = c.id
       LEFT JOIN time_entries te ON te.company_id = c.id
       LEFT JOIN affiliates a ON c.affiliate_id = a.id
       GROUP BY c.id, c.name, c.slug, c.active, c.created_at, c.plan, c.subscription_status,
                c.trial_ends_at, c.mrr_cents, c.affiliate_id, c.addon_qbo, c.addon_certified_payroll, c.addon_takeoff, c.addon_planroom, c.addon_storm, c.addon_roof, c.bonus_seats, a.name
       ORDER BY c.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /superadmin/demo-workspace — create or reset a realistic demo tenant.
// This is intentionally super-admin only and uses fake, deterministic login
// credentials so design/support testing never touches a real customer tenant.
router.post('/demo-workspace', requireSuperAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await deleteDemoWorkspace(client);
    const demo = await createDemoWorkspace(client);
    await client.query('COMMIT');
    res.status(201).json({
      company: demo.company,
      credentials: {
        company_name: DEMO_COMPANY_NAME,
        admin_username: 'demo.admin',
        worker_username: 'alex.rivera',
        password: DEMO_PASSWORD,
      },
      seeded: {
        admins: 1,
        workers: demo.workers.length,
        clients: 3,
        work_items: 3,
        inventory_items: 4,
        pending_count_assignments: 1,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, 'demo workspace seed failed');
    res.status(500).json({ error: 'Demo workspace seed failed' });
  } finally {
    client.release();
  }
});

// PATCH /superadmin/companies/:id — update any combination of fields
router.patch('/companies/:id', requireSuperAdmin, async (req, res) => {
  const { active, affiliate_id, subscription_status, plan, name, trial_ends_at, addon_qbo, addon_certified_payroll, addon_takeoff, addon_planroom, addon_storm, addon_roof, bonus_seats } = req.body;
  if (
    active === undefined && affiliate_id === undefined &&
    subscription_status === undefined && plan === undefined &&
    name === undefined && trial_ends_at === undefined &&
    addon_qbo === undefined && addon_certified_payroll === undefined &&
    addon_takeoff === undefined && addon_planroom === undefined && addon_storm === undefined && addon_roof === undefined && bonus_seats === undefined
  ) return res.status(400).json({ error: 'No fields to update' });

  const VALID_STATUSES = COMPANY_SUBSCRIPTION_STATUSES;
  const VALID_PLANS = COMPANY_PLANS;
  if (subscription_status !== undefined && !VALID_STATUSES.includes(subscription_status))
    return res.status(400).json({ error: 'Invalid subscription_status' });
  if (plan !== undefined && !VALID_PLANS.includes(plan))
    return res.status(400).json({ error: 'Invalid plan' });
  if (name !== undefined && !name?.trim())
    return res.status(400).json({ error: 'Name cannot be empty' });
  let bonusSeatsVal;
  if (bonus_seats !== undefined) {
    bonusSeatsVal = Number(bonus_seats);
    if (!Number.isInteger(bonusSeatsVal) || bonusSeatsVal < 0 || bonusSeatsVal > 100000)
      return res.status(400).json({ error: 'bonus_seats must be a whole number between 0 and 100000' });
  }

  try {
    const fields = [];
    const values = [];
    let idx = 1;
    if (active !== undefined)              { fields.push(`active = $${idx++}`);               values.push(active); }
    if (affiliate_id !== undefined)        { fields.push(`affiliate_id = $${idx++}`);         values.push(affiliate_id || null); }
    if (subscription_status !== undefined) { fields.push(`subscription_status = $${idx++}`);  values.push(subscription_status); }
    if (plan !== undefined)                { fields.push(`plan = $${idx++}`);                 values.push(plan); }
    if (name !== undefined)                { fields.push(`name = $${idx++}`);                 values.push(name.trim()); }
    if (trial_ends_at !== undefined)       { fields.push(`trial_ends_at = $${idx++}`);        values.push(trial_ends_at || null); }
    if (addon_qbo !== undefined)           { fields.push(`addon_qbo = $${idx++}`);            values.push(!!addon_qbo); }
    if (addon_certified_payroll !== undefined) { fields.push(`addon_certified_payroll = $${idx++}`); values.push(!!addon_certified_payroll); }
    if (addon_takeoff !== undefined)       { fields.push(`addon_takeoff = $${idx++}`);        values.push(!!addon_takeoff); }
    if (addon_planroom !== undefined)      { fields.push(`addon_planroom = $${idx++}`);       values.push(!!addon_planroom); }
    if (addon_storm !== undefined)         { fields.push(`addon_storm = $${idx++}`);          values.push(!!addon_storm); }
    if (addon_roof !== undefined)          { fields.push(`addon_roof = $${idx++}`);           values.push(!!addon_roof); }
    if (bonus_seats !== undefined)         { fields.push(`bonus_seats = $${idx++}`);          values.push(bonusSeatsVal); }
    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE companies SET ${fields.join(', ')} WHERE id = $${idx}
       RETURNING id, name, slug, active, affiliate_id, subscription_status, plan, trial_ends_at, addon_qbo, addon_certified_payroll, addon_takeoff, addon_planroom, addon_storm, addon_roof, bonus_seats`,
      values
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Company not found' });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /superadmin/companies/:id — hard delete all company data in a transaction.
// Also collects R2 media URLs and deletes them from object storage after the
// DB commit succeeds, so a rolled-back transaction never leaves the bucket
// missing files that are still referenced.
//
// Note: this does NOT cancel Stripe subscriptions automatically. If the company
// has an active subscription, deleting the row here would leave Stripe charging
// a card for a company that no longer exists. The handler refuses to delete
// in that case; the super_admin must cancel the subscription (or mark the
// company canceled) before proceeding.
router.delete('/companies/:id', requireSuperAdmin, async (req, res) => {
  const { id } = req.params;
  const check = await pool.query(
    'SELECT name, stripe_subscription_id, subscription_status FROM companies WHERE id = $1',
    [id]
  );
  if (check.rowCount === 0) return res.status(404).json({ error: 'Company not found' });
  const company = check.rows[0];
  if (company.stripe_subscription_id && company.subscription_status !== 'canceled') {
    return res.status(409).json({
      error: 'Cancel the Stripe subscription (or set subscription_status to canceled) before deleting this company.',
      stripe_subscription_id: company.stripe_subscription_id,
    });
  }

  const client = await pool.connect();
  let mediaUrls = [];
  try {
    await client.query('BEGIN');

    // ── Collect R2 URLs before we drop the rows that point to them.
    // Fire deletes against R2 only after the DB commit succeeds.

    // Scalar URL columns
    const scalarUrlQueries = [
      `SELECT url FROM field_report_photos WHERE report_id IN (SELECT id FROM field_reports WHERE company_id = $1) AND url IS NOT NULL`,
      `SELECT receipt_url AS url FROM reimbursements WHERE company_id = $1 AND receipt_url IS NOT NULL`,
      `SELECT url FROM worker_documents   WHERE company_id = $1 AND url IS NOT NULL`,
      `SELECT url FROM project_documents  WHERE company_id = $1 AND url IS NOT NULL`,
      `SELECT url FROM client_documents   WHERE company_id = $1 AND url IS NOT NULL`,
      `SELECT url FROM safety_talk_attachments WHERE talk_id IN (SELECT id FROM safety_talks WHERE company_id = $1) AND url IS NOT NULL`,
    ];
    // Wrap each optional query in a savepoint. Without it, a single
    // failing query (e.g. a table that doesn't exist on this deployment
    // or a schema mismatch) poisons the whole transaction with Postgres
    // 25P02 "current transaction is aborted, commands ignored until end
    // of transaction block" — every subsequent DELETE then fails too.
    // Savepoints let us roll back just the failing read without losing
    // the outer transaction.
    for (const q of scalarUrlQueries) {
      await client.query('SAVEPOINT sp_url');
      try {
        const r = await client.query(q, [id]);
        for (const row of r.rows) if (row.url) mediaUrls.push(row.url);
        await client.query('RELEASE SAVEPOINT sp_url');
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_url');
      }
    }

    // JSONB array columns — photo_urls is a JSONB array of strings. Use
    // jsonb_array_elements_text to flatten and union across all tables.
    const jsonbArrayQueries = [
      `SELECT jsonb_array_elements_text(photo_urls) AS url FROM inventory_locations   WHERE company_id = $1 AND jsonb_array_length(photo_urls) > 0`,
      `SELECT jsonb_array_elements_text(photo_urls) AS url FROM inventory_areas       WHERE company_id = $1 AND jsonb_array_length(photo_urls) > 0`,
      `SELECT jsonb_array_elements_text(photo_urls) AS url FROM inventory_racks       WHERE company_id = $1 AND jsonb_array_length(photo_urls) > 0`,
      `SELECT jsonb_array_elements_text(photo_urls) AS url FROM inventory_bays        WHERE company_id = $1 AND jsonb_array_length(photo_urls) > 0`,
      `SELECT jsonb_array_elements_text(photo_urls) AS url FROM inventory_compartments WHERE company_id = $1 AND jsonb_array_length(photo_urls) > 0`,
      `SELECT jsonb_array_elements_text(photo_urls) AS url FROM service_requests     WHERE company_id = $1 AND jsonb_array_length(photo_urls) > 0`,
    ];
    for (const q of jsonbArrayQueries) {
      await client.query('SAVEPOINT sp_url');
      try {
        const r = await client.query(q, [id]);
        for (const row of r.rows) if (row.url) mediaUrls.push(row.url);
        await client.query('RELEASE SAVEPOINT sp_url');
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT sp_url');
      }
    }

    // Delete every company-rooted table in FK-safe order (shared with the demo
    // reset so the two lists can't drift), ending with the company row itself.
    await purgeCompanyRows(client, id);

    await client.query('COMMIT');

    // After commit: best-effort R2 cleanup. Failures here don't undo the
    // delete — they just leave orphaned blobs the R2 lifecycle can reap later.
    if (mediaUrls.length > 0) {
      const { deleteByUrl } = require('../r2');
      Promise.allSettled(mediaUrls.map(u => deleteByUrl(u))).then(results => {
        const failed = results.filter(r => r.status === 'rejected').length;
        if (failed > 0) {
          logger.warn({ company_id: id, failed, total: mediaUrls.length }, 'r2 cleanup had failures after company delete');
        }
      });
    }

    res.json({ deleted: true, name: company.name, media_files: mediaUrls.length });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// POST /superadmin/companies/:id/impersonate — return a short-lived JWT for a
// user of this company. When { user_id } is provided in the body, impersonate
// that specific user (any role). Otherwise default to the first active admin
// so existing "Login as" buttons keep working.
router.post('/companies/:id/impersonate', requireSuperAdmin, async (req, res) => {
  try {
    const targetUserId = req.body?.user_id ? parseInt(req.body.user_id) : null;
    const r = targetUserId
      ? await pool.query(
          `SELECT u.*, c.name AS company_name
           FROM users u
           JOIN companies c ON c.id = u.company_id
           WHERE u.company_id = $1 AND u.id = $2 AND u.active = true`,
          [req.params.id, targetUserId]
        )
      : await pool.query(
          `SELECT u.*, c.name AS company_name
           FROM users u
           JOIN companies c ON c.id = u.company_id
           WHERE u.company_id = $1 AND u.role IN ('admin','super_admin') AND u.active = true
           ORDER BY u.created_at ASC LIMIT 1`,
          [req.params.id]
        );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: targetUserId ? 'User not found in this company' : 'No active admin found for this company' });
    }
    const user = r.rows[0];
    const token = jwt.sign(
      {
        id: user.id, username: user.username, role: user.role,
        full_name: user.full_name, invoice_name: user.invoice_name || null,
        language: user.language, company_id: user.company_id,
        company_name: user.company_name,
        admin_permissions: user.admin_permissions || null,
        worker_access_ids: null,
        // Include role_id so requirePerm middleware resolves the user's
        // permissions against their assigned role during impersonation.
        // Without this the server falls back to the legacy role-based
        // check and misses any custom-role-only perms the user has.
        role_id: user.role_id ?? null,
        // Marks this as a "Login as" session. Consumed by routes that would
        // otherwise write to the impersonated user's own profile (e.g. the
        // language switcher) so a super-admin's view changes never persist to
        // the real user's saved preferences.
        imp: true,
      },
      process.env.JWT_SECRET,
      { expiresIn: '4h' }
    );

    // Forensic trail — every "Login as" leaves a row so we can answer
    // "did someone log in as me on that date?" without reconstructing
    // from logs. Never let this fail the request.
    pool.query(
      `INSERT INTO impersonation_log
         (super_admin_id, super_admin_name, target_user_id, target_user_name,
          target_role, company_id, company_name, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [req.user.id, req.user.full_name || req.user.username,
       user.id, user.full_name, user.role,
       user.company_id, user.company_name,
       (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || null),
       (req.headers['user-agent'] || null)?.slice(0, 500)]
    ).catch(err => logger.warn({ err }, 'impersonation_log insert failed'));

    res.json({ token, full_name: user.full_name, company_name: user.company_name });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /superadmin/impersonation-log — recent "Login as" events, newest first
router.get('/impersonation-log', requireSuperAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const { rows } = await pool.query(
      `SELECT id, super_admin_name, target_user_name, target_role,
              company_name, ip, created_at
         FROM impersonation_log
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit]
    );
    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /superadmin/companies/:id/export — dump every row belonging to this
// company as a single JSON blob. Useful for support investigations and for
// giving churned customers their data back. Same company-rooted tables the
// delete handler targets — kept in sync by structure.
router.get('/companies/:id/export', requireSuperAdmin, async (req, res) => {
  const id = req.params.id;
  const companyRes = await pool.query('SELECT * FROM companies WHERE id = $1', [id]);
  if (companyRes.rowCount === 0) return res.status(404).json({ error: 'Company not found' });

  // Same list as the delete handler. If you add a new company_id table,
  // add it both places. Tables are listed parent-first so the JSON reads
  // in a natural order.
  const tables = [
    'users', 'settings', 'advanced_settings',
    'clients', 'projects', 'shifts', 'pay_periods',
    'time_entries', 'active_clock', 'entry_messages',
    'reimbursements', 'time_off_requests',
    'worker_documents', 'worker_availability', 'worker_fringes',
    'certified_payroll_signatures',
    'equipment_items', 'equipment_hours',
    'field_reports', 'field_report_photos',
    'daily_reports', 'punchlist_items', 'safety_talks',
    'safety_checklist_templates', 'safety_checklist_submissions',
    'incident_reports', 'sub_reports', 'rfis',
    'inspection_templates', 'inspections',
    'inventory_locations', 'inventory_areas', 'inventory_racks', 'inventory_bays', 'inventory_compartments',
    'inventory_items', 'inventory_item_uoms', 'inventory_stock',
    'inventory_transactions', 'inventory_cycle_counts', 'inventory_cycle_count_lines',
    'inventory_suppliers', 'purchase_orders', 'purchase_order_lines',
    'project_documents', 'project_invoices', 'invoices', 'service_requests',
    'estimates',
    'subcontract_pos', 'subcontractors', 'lien_waivers', 'change_orders',
    'submittals', 'project_closeouts', 'project_expenses',
    'appointments', 'appointment_types', 'shift_types',
    'roles', 'qbo_sync_errors', 'client_errors',
    'audit_log', 'inbox', 'push_subscriptions', 'company_chat',
  ];

  // Stream the JSON one table at a time. The previous implementation
  // buffered every row from every company-rooted table into a single
  // object before calling res.send() — for a customer with months of
  // time_entries / inbox / audit_log, that could be hundreds of MB
  // resident at once and risked OOM-ing the export. Now we hold at
  // most one table's rows in memory, write them as a fragment of the
  // larger JSON document, and let Node back-pressure the rest into
  // the response stream.
  const filename = `opsfloa-company-${id}-${Date.now()}.json`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  // Strip secrets out of user rows before they leave the server.
  const scrubUser = u => {
    const { password_hash, reset_token, reset_token_expires,
            invite_token, invite_token_expires,
            email_confirm_token, email_confirm_token_expires,
            mfa_secret, ...safe } = u;
    return safe;
  };

  try {
    res.write('{\n');
    res.write(`  "exported_at": ${JSON.stringify(new Date().toISOString())},\n`);
    res.write(`  "company": ${JSON.stringify(companyRes.rows[0], null, 2).replace(/\n/g, '\n  ')},\n`);
    res.write('  "tables": {\n');

    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      let value;
      try {
        // Most tables have company_id directly. A handful don't — skip
        // them gracefully so a refactor elsewhere doesn't break export.
        const r = await pool.query(`SELECT * FROM ${table} WHERE company_id = $1 ORDER BY id`, [id]);
        const rows = table === 'users' ? r.rows.map(scrubUser) : r.rows;
        value = JSON.stringify(rows, null, 2);
      } catch (err) {
        value = JSON.stringify({ error: err.message }, null, 2);
      }
      const indented = value.replace(/\n/g, '\n    ');
      const trailing = i < tables.length - 1 ? ',' : '';
      res.write(`    ${JSON.stringify(table)}: ${indented}${trailing}\n`);
    }

    res.write('  }\n}\n');
    res.end();
  } catch (err) {
    logger.error({ err }, 'company export failed');
    // If headers / body have already started flowing we can't change to
    // 500; just terminate the response so the client sees truncated JSON
    // and can retry.
    if (!res.headersSent) {
      res.status(500).json({ error: 'Export failed' });
    } else {
      res.end();
    }
  }
});

// POST /superadmin/users/:id/revoke-sessions — invalidate every JWT for this
// user by bumping their token_version. Their next API call 401s and they're
// bounced to /login. Useful for "a user lost their device" and similar.
router.post('/users/:id/revoke-sessions', requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE users
          SET token_version = COALESCE(token_version, 0) + 1
        WHERE id = $1
        RETURNING id, username, full_name, token_version`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ revoked: true, user: result.rows[0] });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /superadmin/users/:id/set-password — directly set a user's password.
// For recovering locked-out accounts. Sets an exact working password (no
// forced change), clears any pending reset token, and bumps token_version so
// existing sessions are logged out — same session semantics as any password
// change. Every use leaves an audit_log row.
router.post('/users/:id/set-password', requireSuperAdmin, async (req, res) => {
  try {
    const password = req.body?.password;
    const userRes = await pool.query(
      'SELECT id, username, full_name, company_id, role FROM users WHERE id = $1',
      [req.params.id]
    );
    if (userRes.rowCount === 0) return res.status(404).json({ error: 'User not found' });
    const user = userRes.rows[0];

    const invalid = validatePassword(password, user.username);
    if (invalid) return res.status(400).json({ error: invalid });

    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      `UPDATE users
          SET password_hash = $1,
              must_change_password = false,
              reset_token = NULL,
              reset_token_expires = NULL,
              token_version = COALESCE(token_version, 0) + 1
        WHERE id = $2`,
      [hash, user.id]
    );

    // Sensitive action — leave a trail (best-effort; never fails the request).
    logAudit(
      user.company_id, req.user.id, req.user.full_name || req.user.username,
      'user.password_set_by_superadmin', 'user', user.id, user.full_name,
      { target_username: user.username, target_role: user.role }
    );

    res.json({ ok: true, user: { id: user.id, username: user.username, full_name: user.full_name } });
  } catch (err) {
    logger.error({ err }, 'superadmin set-password error');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /superadmin/companies/:id/users — all users for a company
router.get('/companies/:id/users', requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, full_name, email, role, active, created_at
       FROM users WHERE company_id = $1 ORDER BY role, full_name`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Affiliates ──────────────────────────────────────────────────────────────

// GET /superadmin/affiliates — list with commission summary
router.get('/affiliates', requireSuperAdmin, async (req, res) => {
  try {
    const [affiliateRows, companyRows] = await Promise.all([
      pool.query(`
        SELECT a.*,
               COUNT(c.id) AS company_count,
               COALESCE(SUM(c.mrr_cents) FILTER (WHERE c.subscription_status = 'active'), 0) AS active_mrr_cents
        FROM affiliates a
        LEFT JOIN companies c ON c.affiliate_id = a.id
        GROUP BY a.id
        ORDER BY a.name
      `),
      pool.query(`
        SELECT c.id, c.name, c.slug, c.plan, c.subscription_status, c.mrr_cents, c.affiliate_id, c.created_at
        FROM companies c
        WHERE c.affiliate_id IS NOT NULL
        ORDER BY c.created_at DESC
      `),
    ]);
    const companiesByAffiliate = {};
    companyRows.rows.forEach(c => {
      if (!companiesByAffiliate[c.affiliate_id]) companiesByAffiliate[c.affiliate_id] = [];
      companiesByAffiliate[c.affiliate_id].push(c);
    });
    const affiliates = affiliateRows.rows.map(a => ({
      ...a,
      companies: companiesByAffiliate[a.id] || [],
    }));
    res.json(affiliates);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /superadmin/affiliates
router.post('/affiliates', requireSuperAdmin, async (req, res) => {
  const name  = req.body.name?.trim();
  const email = req.body.email?.trim() || null;
  const phone = req.body.phone?.trim() || null;
  const notes = req.body.notes?.trim() || null;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const result = await pool.query(
      `INSERT INTO affiliates (name, email, phone, notes) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, email, phone, notes]
    );
    res.status(201).json({ ...result.rows[0], company_count: 0, active_mrr_cents: 0, companies: [] });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /superadmin/affiliates/:id
router.patch('/affiliates/:id', requireSuperAdmin, async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM affiliates WHERE id = $1', [req.params.id]);
    if (existing.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    const a = existing.rows[0];
    const result = await pool.query(
      `UPDATE affiliates SET name=$1, email=$2, phone=$3, notes=$4 WHERE id=$5 RETURNING *`,
      [
        req.body.name !== undefined ? (req.body.name?.trim() || a.name) : a.name,
        req.body.email !== undefined ? (req.body.email?.trim() || null) : a.email,
        req.body.phone !== undefined ? (req.body.phone?.trim() || null) : a.phone,
        req.body.notes !== undefined ? (req.body.notes?.trim() || null) : a.notes,
        req.params.id,
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /superadmin/affiliates/:id
router.delete('/affiliates/:id', requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM affiliates WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) {
    logger.error({ err }, 'catch block error');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
