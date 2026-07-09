const pool = require('../db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { seedBuiltinRoles } = require('../permissions');

// Manual or scheduled seed for visual QA. It creates/fills only the named
// fictional company. Dates roll forward so Demo Operations stays useful as a
// live demo; set DEMO_SEED_DATE=YYYY-MM-DD for a deterministic refresh.
const TARGET_COMPANY = process.env.DEMO_COMPANY_NAME || 'Demo Operations';
const DEMO_ADMIN_USERNAME = process.env.DEMO_ADMIN_USERNAME || 'Admin';
const DEMO_ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD || 'Admin123';
const DEMO_SEED_DATE = process.env.DEMO_SEED_DATE || new Date().toISOString().slice(0, 10);
const TODAY = new Date(`${DEMO_SEED_DATE}T12:00:00Z`);

if (Number.isNaN(TODAY.getTime())) {
  throw new Error('DEMO_SEED_DATE must be in YYYY-MM-DD format when provided.');
}

function slugify(value) {
  return String(value || 'demo-workspace')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'demo-workspace';
}

function isoDate(offsetDays = 0) {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function isoTimestamp(offsetDays = 0, hour = 10, minute = 0) {
  const d = new Date(`${isoDate(offsetDays)}T00:00:00Z`);
  d.setUTCHours(hour, minute, 0, 0);
  return d.toISOString();
}

async function one(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows[0] || null;
}

async function ensureBy(client, table, key, values, returning = '*') {
  const where = Object.keys(key).map((name, index) => `${name} = $${index + 1}`).join(' AND ');
  const existing = await one(client, `SELECT ${returning} FROM ${table} WHERE ${where} LIMIT 1`, Object.values(key));
  if (existing) return existing;

  const merged = { ...key, ...values };
  const cols = Object.keys(merged);
  const placeholders = cols.map((_, index) => `$${index + 1}`);
  return one(
    client,
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING ${returning}`,
    Object.values(merged)
  );
}

async function upsertBy(client, table, key, values, returning = '*') {
  const keyNames = Object.keys(key);
  const valueNames = Object.keys(values);
  const where = keyNames.map((name, index) => `${name} = $${index + 1}`).join(' AND ');
  const existing = await one(client, `SELECT id FROM ${table} WHERE ${where} LIMIT 1`, Object.values(key));

  if (!existing) {
    return ensureBy(client, table, key, values, returning);
  }

  if (valueNames.length === 0) {
    return one(client, `SELECT ${returning} FROM ${table} WHERE id = $1`, [existing.id]);
  }

  const setClause = valueNames.map((name, index) => `${name} = $${index + 1}`).join(', ');
  return one(
    client,
    `UPDATE ${table} SET ${setClause} WHERE id = $${valueNames.length + 1} RETURNING ${returning}`,
    [...Object.values(values), existing.id]
  );
}

async function upsertStock(client, stock) {
  await client.query(
    `INSERT INTO inventory_stock
       (company_id, item_id, location_id, quantity, area_id, rack_id, bay_id, compartment_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (item_id, location_id, (COALESCE(uom_id, 0)))
     DO UPDATE SET quantity = EXCLUDED.quantity,
                   area_id = EXCLUDED.area_id,
                   rack_id = EXCLUDED.rack_id,
                   bay_id = EXCLUDED.bay_id,
                   compartment_id = EXCLUDED.compartment_id,
                   updated_at = NOW()`,
    [
      stock.company_id,
      stock.item_id,
      stock.location_id,
      stock.quantity,
      stock.area_id || null,
      stock.rack_id || null,
      stock.bay_id || null,
      stock.compartment_id || null,
    ]
  );
}

async function upsertActiveClock(client, clock) {
  await client.query(
    `INSERT INTO active_clock
       (company_id, user_id, project_id, clock_in_time, clock_in_lat, clock_in_lng,
        work_date, notes, timezone, clock_source, current_lat, current_lng,
        location_updated_at, stale_alert_sent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL)
     ON CONFLICT (user_id)
     DO UPDATE SET project_id = EXCLUDED.project_id,
                   clock_in_time = EXCLUDED.clock_in_time,
                   clock_in_lat = EXCLUDED.clock_in_lat,
                   clock_in_lng = EXCLUDED.clock_in_lng,
                   work_date = EXCLUDED.work_date,
                   notes = EXCLUDED.notes,
                   timezone = EXCLUDED.timezone,
                   clock_source = EXCLUDED.clock_source,
                   current_lat = EXCLUDED.current_lat,
                   current_lng = EXCLUDED.current_lng,
                   location_updated_at = EXCLUDED.location_updated_at,
                   stale_alert_sent_at = NULL`,
    [
      clock.company_id,
      clock.user_id,
      clock.project_id,
      clock.clock_in_time,
      clock.clock_in_lat || null,
      clock.clock_in_lng || null,
      clock.work_date,
      clock.notes,
      clock.timezone,
      clock.clock_source,
      clock.current_lat || null,
      clock.current_lng || null,
      clock.location_updated_at,
    ]
  );
}

async function ensureChildRows(client, table, keyName, keyValue, rows) {
  const count = await one(client, `SELECT COUNT(*)::int AS count FROM ${table} WHERE ${keyName} = $1`, [keyValue]);
  if (count.count > 0) return;
  for (const row of rows) {
    const merged = { [keyName]: keyValue, ...row };
    const cols = Object.keys(merged);
    await client.query(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(merged)
    );
  }
}

async function replaceChildRows(client, table, keyName, keyValue, rows) {
  await client.query(`DELETE FROM ${table} WHERE ${keyName} = $1`, [keyValue]);
  for (const row of rows) {
    const merged = { [keyName]: keyValue, ...row };
    const cols = Object.keys(merged);
    await client.query(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(merged)
    );
  }
}

async function ensureDemoCompany(client) {
  // Hard-pin to a company whose subscription_status is 'exempt' — that's
  // a sentinel only the superadmin tools set on intentional demo/internal
  // tenants. Without this filter, a real customer happening to name their
  // company "Demo Operations" would have every subsequent seed write land
  // in their tenant. We'd rather fail loudly than touch real customer data.
  const existing = await one(
    client,
    "SELECT id, name FROM companies WHERE name = $1 AND subscription_status = 'exempt'",
    [TARGET_COMPANY]
  );
  if (existing) {
    // Ensure the demo flag is set (email-suppression + 200 MB storage cap
    // + nightly R2 wipe all key off it).
    await client.query('UPDATE companies SET is_demo = true WHERE id = $1 AND is_demo = false', [existing.id]);
    return existing;
  }

  // Refuse to create the demo company if a non-exempt company by the same
  // name already exists. Forces an admin to either rename theirs or pick a
  // different DEMO_COMPANY_NAME for this environment.
  const clash = await one(client, 'SELECT id FROM companies WHERE name = $1 LIMIT 1', [TARGET_COMPANY]);
  if (clash) {
    throw new Error(
      `A non-demo company already exists with name "${TARGET_COMPANY}". ` +
      'Set DEMO_COMPANY_NAME to a unique value for this environment, or mark ' +
      'the existing company subscription_status = exempt if it really is the demo.'
    );
  }

  const baseSlug = slugify(TARGET_COMPANY);
  let slug = baseSlug;
  for (let i = 2; i < 50; i++) {
    const taken = await one(client, 'SELECT id FROM companies WHERE slug = $1 LIMIT 1', [slug]);
    if (!taken) break;
    slug = `${baseSlug}-${i}`;
  }

  return one(
    client,
    `INSERT INTO companies
       (name, slug, subscription_status, plan, trial_ends_at, pro_addon, addon_qbo,
        addon_certified_payroll, accepts_service_requests, client_portal_pro_interest,
        registration_ip, is_demo)
     VALUES ($1,$2,'exempt','business',NOW() + INTERVAL '90 days',true,true,true,true,true,'127.0.0.1',true)
     RETURNING id, name`,
    [TARGET_COMPANY, slug]
  );
}

async function ensureDemoAdmin(client, companyId) {
  const { ownerId } = await seedBuiltinRoles(client, companyId);
  const username = DEMO_ADMIN_USERNAME;
  const existingUser = await one(
    client,
    'SELECT id, company_id FROM users WHERE username = $1 LIMIT 1',
    [username]
  );

  if (existingUser && existingUser.company_id !== companyId) {
    throw new Error(
      `Cannot seed demo admin "${username}" because that username belongs to another company. ` +
      'Set DEMO_ADMIN_USERNAME to a unique value for this environment.'
    );
  }

  const hash = await bcrypt.hash(DEMO_ADMIN_PASSWORD, 10);
  if (existingUser) {
    return one(
      client,
      `UPDATE users
       SET password_hash = $1,
           full_name = 'Admin',
           first_name = 'Admin',
           last_name = NULL,
           role = 'admin',
           role_id = $2,
           email = $3,
           email_confirmed = true,
           active = true,
           timezone = COALESCE(timezone, 'America/Phoenix')
       WHERE id = $4
       RETURNING id, full_name`,
      [hash, ownerId || null, `${username}@example.test`, existingUser.id]
    );
  }

  return one(
    client,
    `INSERT INTO users
       (company_id, username, password_hash, full_name, first_name, last_name, role,
        role_id, email, email_confirmed, hourly_rate, rate_type, overtime_rule,
        worker_type, welcomed_at, active, timezone)
     VALUES ($1,$2,$3,'Admin','Admin',NULL,'admin',$4,$5,true,72,'hourly','daily','employee',NOW(),true,'America/Phoenix')
     RETURNING id, full_name`,
    [companyId, username, hash, ownerId || null, `${username}@example.test`]
  );
}

async function ensureDemoSettings(client, companyId) {
  const settings = {
    module_timeclock: '1',
    module_field: '1',
    module_work: '1',
    module_inventory: '1',
    module_tools: '1',
    module_analytics: '1',
    module_team: '1',
    module_financial_reports: '1',
    feature_public: '1',
    feature_scheduling: '1',
    feature_analytics: '1',
    feature_chat: '1',
    feature_prevailing_wage: '1',
    feature_reimbursements: '1',
    feature_pto: '1',
    feature_project_integration: '1',
    feature_overtime: '1',
    feature_geolocation: '1',
    feature_overtime_alerts: '1',
    feature_media_gallery: '1',
    feature_admin_edit_time: '1',
    feature_worker_edit_time: '1',
    show_worker_wages: '1',
    company_timezone: 'America/Phoenix',
    setup_questionnaire_completed_at: new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(settings)) {
    await client.query(
      `INSERT INTO settings (company_id, key, value)
       VALUES ($1,$2,$3)
       ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [companyId, key, value]
    );
  }
}

async function ensureDemoPublicProfile(client, companyId) {
  await client.query(
    `INSERT INTO company_public_profiles
       (company_id, display_name, short_description, services_offered, service_areas,
        license_info, equipment_capabilities, project_types, quote_instructions,
        contact_info, faq_items, photos, is_public, published_at, updated_at)
     VALUES
       ($1, 'Demo Operations - OpsFloA Demo',
        'Demo Operations is a fictional public company profile built to show how OpsFloA helps teams run time, people, projects, field updates, inventory, public requests, and reporting from one simple operating system.',
        $2::jsonb, $3::jsonb, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9::jsonb, $10::jsonb, true, NOW(), NOW())
     ON CONFLICT (company_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        short_description = EXCLUDED.short_description,
        services_offered = EXCLUDED.services_offered,
        service_areas = EXCLUDED.service_areas,
        license_info = EXCLUDED.license_info,
        equipment_capabilities = EXCLUDED.equipment_capabilities,
        project_types = EXCLUDED.project_types,
        quote_instructions = EXCLUDED.quote_instructions,
        contact_info = EXCLUDED.contact_info,
        faq_items = EXCLUDED.faq_items,
        photos = EXCLUDED.photos,
        is_public = true,
        published_at = COALESCE(company_public_profiles.published_at, NOW()),
        updated_at = NOW()`,
    [
      companyId,
      JSON.stringify(['Time clock and approvals', 'People and role management', 'Project and customer tracking', 'Field notes, photos, punchlists, and safety', 'Inventory items, stock, counts, and purchase orders', 'Public request intake and company profile']),
      JSON.stringify(['Fictional Phoenix metro workspace', 'Office operations', 'Mobile field teams', 'Inventory rooms and service routes']),
      'Demo Operations is not a real service provider. Licenses, contacts, projects, POs, field records, and inventory records are sample data for showing OpsFloA capabilities.',
      JSON.stringify(['Daily demo data refresh', 'Mobile PWA workflows', 'Role-based admin controls', 'Public profile and request intake', 'Agent-readable business information', 'Reporting and operational dashboards']),
      JSON.stringify(['Facility service route demo', 'Retail refresh demo', 'Clinic room turnover demo', 'Inventory staging demo', 'Subcontractor PO demo', 'Public request demo']),
      'Use Request work to submit a sample request and see how OpsFloA can collect outside requests. This demo does not provide real services or dispatch a real crew.',
      JSON.stringify({
        name: 'OpsFloA Demo',
        email: 'info@opsfloa.com',
        phone: '(555) 010-0100',
        website: 'https://opsfloa.com',
        address: 'Demo data only',
      }),
      JSON.stringify([
        { question: 'What am I looking at?', answer: 'This is a fictional public profile for Demo Operations. It exists to show how OpsFloA can publish a clean company profile and request page without exposing internal app data.' },
        { question: 'What OpsFloA capabilities does the demo show?', answer: 'The demo workspace includes time clock, approvals, team management, projects, field work, photos, safety, inventory, public requests, subcontractor POs, and reporting examples.' },
        { question: 'Can I submit a request here?', answer: 'Yes, as a demonstration. The request form shows how an outside customer could ask for work, but Demo Operations is not a real service provider.' },
        { question: 'What should search engines and AI agents know?', answer: 'Demo Operations is a sample company profile for OpsFloA. It should be described as a product demonstration, not as an actual local business offering services.' },
        { question: 'What information is public?', answer: 'Only the profile fields intentionally published here are public. Internal workers, time entries, payroll, invoices, notes, private photos, and customer records are not exposed.' },
      ]),
      JSON.stringify([
        { url: '/opsfloa-operator-band.png', caption: 'OpsFloA brings office and field work into one operating system.', alt: 'A professional reviewing operations work in a field-ready setting' },
        { url: '/opsfloa-setup-ready-alt.png', caption: 'Admins choose which tools are visible so the day-to-day app stays simple.', alt: 'A business operator preparing setup decisions' },
        { url: '/opsfloa-field-hero.png', caption: 'Field notes, photos, safety, punchlists, and inventory can all appear in the demo workspace.', alt: 'A mobile field operations scene' },
      ]),
    ]
  );
}

async function main() {
  const client = await pool.connect();
  const summary = {};
  try {
    await client.query('BEGIN');

    const company = await ensureDemoCompany(client);
    const companyId = company.id;
    await ensureDemoSettings(client, companyId);
    await ensureDemoPublicProfile(client, companyId);

    const admin = await ensureDemoAdmin(client, companyId);

    const peopleSeed = [
      ['riley.brooks', 'Riley Brooks', 'worker', 'riley.brooks@example.test', 36],
      ['morgan.diaz', 'Morgan Diaz', 'worker', 'morgan.diaz@example.test', 33],
      ['casey.nguyen', 'Casey Nguyen', 'worker', 'casey.nguyen@example.test', 34],
      ['samira.patel', 'Samira Patel', 'worker', 'samira.patel@example.test', 37],
      ['leo.martinez', 'Leo Martinez', 'worker', 'leo.martinez@example.test', 31],
      ['nora.bennett', 'Nora Bennett', 'worker', 'nora.bennett@example.test', 35],
      ['avery.johnson', 'Avery Johnson', 'admin', 'avery.johnson@example.test', 42],
      ['quinn.parker', 'Quinn Parker', 'worker', 'quinn.parker@example.test', 32],
    ];

    const users = [];
    const skippedUsers = [];
    for (const [username, fullName, role, email, rate] of peopleSeed) {
      // Two-step lookup to handle username collisions with real customers
      // gracefully. The (company_id, username) ensureBy below is correct
      // for the common case, but if `username` already exists in ANOTHER
      // company the global UNIQUE constraint on users.username would
      // make our INSERT throw and abort the whole cron-driven seed run.
      // Pre-check globally so we can skip + warn instead of dying.
      const collision = await one(
        client,
        'SELECT company_id FROM users WHERE username = $1 LIMIT 1',
        [username]
      );
      if (collision && collision.company_id !== companyId) {
        skippedUsers.push(username);
        continue;
      }
      const row = await ensureBy(
        client,
        'users',
        { company_id: companyId, username },
        {
          password_hash: 'demo-disabled-password',
          role,
          full_name: fullName,
          email,
          hourly_rate: rate,
          active: true,
          first_name: fullName.split(' ')[0],
          last_name: fullName.split(' ').slice(1).join(' '),
          welcomed_at: isoTimestamp(-12, 9),
        },
        'id, full_name, role'
      );
      users.push(row);
    }
    if (skippedUsers.length > 0) {
      console.warn(
        `[demo-seed] skipped ${skippedUsers.length} demo user(s) due to username collision with another company: ${skippedUsers.join(', ')}. ` +
        'Demo will be missing these workers. Rename the demo usernames or move the colliding real account to clear.'
      );
    }
    const existingUsers = await client.query(
      `SELECT id, full_name, role FROM users WHERE company_id = $1 AND active = true ORDER BY id`,
      [companyId]
    );
    const workers = existingUsers.rows.filter(u => u.role === 'worker').slice(0, 10);
    const admins = existingUsers.rows.filter(u => u.role !== 'worker');
    summary.users = existingUsers.rowCount;

    const clientSeed = [
      ['Cedar Learning Center', 'Elaine Foster', 'elaine.foster@example.test', '(555) 010-4102', 'Multi-site education operations'],
      ['Harbor Clinic Network', 'Dr. Mina Rowe', 'mina.rowe@example.test', '(555) 010-7240', 'Healthcare facilities and room readiness'],
      ['Sunset Retail Group', 'Jonas Whitaker', 'jonas.whitaker@example.test', '(555) 010-8831', 'Retail refreshes and store support'],
      ['Atlas Fleet Services', 'Cam Lopez', 'cam.lopez@example.test', '(555) 010-1928', 'Fleet equipment and dispatch operations'],
      ['Pineview HOA', 'Rachel Kim', 'rachel.kim@example.test', '(555) 010-6722', 'Community maintenance and resident support'],
    ];
    const clients = [];
    for (const [name, contactName, contactEmail, contactPhone, notes] of clientSeed) {
      clients.push(await ensureBy(
        client,
        'clients',
        { company_id: companyId, name },
        { contact_name: contactName, contact_email: contactEmail, contact_phone: contactPhone, notes, active: true },
        '*'
      ));
    }
    const allClients = await client.query('SELECT * FROM clients WHERE company_id = $1 ORDER BY id', [companyId]);
    summary.clients = allClients.rowCount;

    const projectSeed = [
      ['Cedar Learning Center Rollout', 'CLC-204', 'Cedar Learning Center', 320, 48500, 34, 'in_progress', 'Room readiness, tablet carts, signage, and handoff support.', '810 E Learning Loop, Mesa, AZ'],
      ['Harbor Clinic Room Turnover', 'HCN-118', 'Harbor Clinic Network', 210, 39200, 48, 'in_progress', 'Exam room refresh, stock staging, and safety walkthroughs.', '2212 S Harbor Way, Phoenix, AZ'],
      ['Sunset Retail Refresh', 'SRG-552', 'Sunset Retail Group', 160, 27400, 62, 'in_progress', 'Fixture reset, backroom organization, and overnight closeout.', '455 W Sunset Ave, Tempe, AZ'],
      ['Atlas Fleet Maintenance Cycle', 'AFS-330', 'Atlas Fleet Services', 240, 31200, 28, 'in_progress', 'Vehicle kit replenishment, inspections, and work bay coordination.', '1200 N Industrial Rd, Phoenix, AZ'],
      ['Pineview HOA Service Queue', 'PVH-019', 'Pineview HOA', 145, 19800, 18, 'in_progress', 'Resident requests, common area upkeep, and punch follow-up.', '77 Pineview Pkwy, Chandler, AZ'],
      ['Cactus Office Onboarding', 'COO-047', 'Mesa Facilities Co-op', 90, 13600, 82, 'completed', 'Office move support and final checklist closeout.', '501 E Main St, Mesa, AZ'],
      ['Riverpoint Equipment Reset', 'RER-411', 'Atlas Fleet Services', 130, 22100, 11, 'planning', 'Upcoming staging and replacement cycle.', '1880 Riverpoint Dr, Glendale, AZ'],
    ];
    const projects = [];
    for (const [name, job, clientName, hours, dollars, progress, status, description, address] of projectSeed) {
      const clientRow = allClients.rows.find(c => c.name === clientName) || allClients.rows[0];
      projects.push(await upsertBy(
        client,
        'projects',
        { company_id: companyId, name },
        {
          client_id: clientRow?.id || null,
          client_name: clientName,
          job_number: job,
          address,
          start_date: isoDate(-28),
          end_date: isoDate(45),
          description,
          status,
          progress_pct: progress,
          budget_hours: hours,
          budget_dollars: dollars,
          active: true,
        },
        '*'
      ));
    }
    const allProjects = await client.query('SELECT * FROM projects WHERE company_id = $1 AND active = true ORDER BY id', [companyId]);
    summary.projects = allProjects.rowCount;

    const projectByIndex = index => allProjects.rows[index % allProjects.rows.length];
    const workerByIndex = index => workers[index % workers.length] || admin;

    const fieldNotes = [
      ['Morning site check', 'Walked the primary work areas, confirmed access, and photographed the items that need owner review.', 'submitted'],
      ['Delivery received', 'Received staged materials, checked counts against the packing slip, and flagged one damaged carton.', 'submitted'],
      ['Client walkthrough notes', 'Client approved the main work area. Remaining notes are cosmetic and assigned to punchlist.', 'reviewed'],
      ['Access issue', 'South entrance was unavailable for two hours. Crew shifted to interior tasks until access reopened.', 'submitted'],
      ['End of day closeout', 'Cleaned work zones, secured loose materials, and uploaded photos for the gallery.', 'draft'],
      ['Quality check', 'Verified installed labels, room layouts, and inventory kit placement. Two labels need replacement.', 'reviewed'],
    ];
    // The demo gallery should roll forward, not accumulate old dated media.
    // Seeded field notes always use this prefix.
    await client.query(
      `DELETE FROM field_reports
       WHERE company_id = $1
         AND title LIKE 'Demo note %'`,
      [companyId]
    );
    for (let i = 0; i < 14; i++) {
      const [title, notes, status] = fieldNotes[i % fieldNotes.length];
      const project = projectByIndex(i);
      const worker = workerByIndex(i);
      const dayOffset = -Math.floor(i / 2);
      const reportTitle = `Demo note ${String(i + 1).padStart(2, '0')} - ${title} - ${project.job_number || project.name}`;
      const report = await upsertBy(
        client,
        'field_reports',
        { company_id: companyId, title: reportTitle },
        {
          user_id: worker.id,
          project_id: project.id,
          notes,
          status,
          lat: 33.4484 + (i % 6) / 1000,
          lng: -112.0740 - (i % 6) / 1000,
          report_date: isoDate(dayOffset),
          reported_at: isoTimestamp(dayOffset, 8 + (i % 8), 15),
        },
        '*'
      );
      await client.query('DELETE FROM field_report_photos WHERE report_id = $1', [report.id]);
      for (let p = 0; p < (i % 4 === 0 ? 3 : i % 3 === 0 ? 2 : 1); p++) {
        await client.query(
          `INSERT INTO field_report_photos (report_id, url, caption, media_type, size_bytes)
           VALUES ($1,$2,$3,'photo',$4)`,
          [
            report.id,
            `https://picsum.photos/seed/opsfloa-field-note-${i}-${p}/1100/825`,
            ['Before view', 'Progress detail', 'Closeout photo', 'Material staging', 'Issue detail', 'Owner review'][p % 6],
            180000 + (i * 1000),
          ]
        );
      }
    }

    // Daily reports are also a rolling demo surface. These are recreated for
    // today and the prior days each seed run.
    await client.query(
      `DELETE FROM daily_reports
       WHERE company_id = $1
         AND created_by = $2`,
      [companyId, admin.id]
    );

    for (let i = 0; i < 18; i++) {
      const project = projectByIndex(i);
      const date = isoDate(-i);
      const report = await ensureBy(
        client,
        'daily_reports',
        { company_id: companyId, project_id: project.id, report_date: date },
        {
          superintendent: (admins[i % admins.length] || admin).full_name,
          weather_condition: ['Clear', 'Partly cloudy', 'Windy', 'Hot', 'Light rain'][i % 5],
          weather_temp: [74, 78, 81, 88, 92][i % 5],
          work_performed: [
            'Completed setup, inventory staging, and owner walk-through items.',
            'Advanced task list, verified material counts, and closed two open notes.',
            'Completed safety huddle, equipment check, and phase handoff.',
          ][i % 3],
          delays_issues: i % 4 === 0 ? 'Late delivery moved one task to the next workday.' : null,
          visitor_log: i % 3 === 0 ? 'Client representative visited for progress review.' : null,
          status: ['draft', 'submitted', 'reviewed'][i % 3],
          created_by: admin.id,
        },
        '*'
      );
      await ensureChildRows(client, 'daily_report_manpower', 'report_id', report.id, [
        { trade: 'Operations', worker_count: 3 + (i % 3), hours: 22 + (i % 6), notes: 'Task execution and closeout support' },
        { trade: 'Support', worker_count: 1 + (i % 2), hours: 8 + (i % 4), notes: 'Stock staging and documentation' },
      ]);
      await ensureChildRows(client, 'daily_report_equipment', 'report_id', report.id, [
        { name: ['Service Van', 'Lift Cart', 'Tablet Kit'][i % 3], quantity: 1, hours: 5 + (i % 4) },
      ]);
      await ensureChildRows(client, 'daily_report_materials', 'report_id', report.id, [
        { description: ['Labels', 'Mounting hardware', 'Gloves', 'Filter cartridges'][i % 4], quantity: `${4 + i} units` },
      ]);
    }

    const punchTitles = [
      'Replace missing room label',
      'Confirm final shelf count',
      'Retouch scuffed panel',
      'Re-check access badge packet',
      'Move spare kit to secure storage',
      'Photograph completed bay',
      'Update closeout notes',
      'Verify client sign-off item',
      'Clean staging corner',
      'Add warning label to service cart',
      'Confirm route van bin labels',
      'Repair loose bracket',
    ];
    for (let i = 0; i < 24; i++) {
      const item = await upsertBy(
        client,
        'punchlist_items',
        { company_id: companyId, title: `${punchTitles[i % punchTitles.length]} ${i + 1}` },
        {
          project_id: projectByIndex(i).id,
          description: 'Demo punch item with enough detail to exercise wrapping, status chips, assignment, and mobile spacing.',
          location: ['Lobby', 'Back room', 'Suite 204', 'Vehicle bay', 'Storage cage', 'Common area'][i % 6],
          status: ['open', 'in_progress', 'resolved', 'verified'][i % 4],
          priority: ['low', 'normal', 'high', 'urgent'][i % 4],
          assigned_to: workerByIndex(i).id,
          created_by: admin.id,
          phase: ['Intake', 'Execution', 'Closeout'][i % 3],
          resolved_at: i % 4 >= 2 ? isoTimestamp(-i, 15, 30) : null,
        },
        '*'
      );
      await ensureChildRows(client, 'punchlist_checklist_items', 'punchlist_id', item.id, [
        { text: 'Take photo after correction', checked: i % 2 === 0, order_index: 1 },
        { text: 'Confirm with client contact', checked: i % 3 === 0, order_index: 2 },
      ]);
    }

    const incidents = [
      ['near_miss', 'Cart rolled into marked walkway before being chocked.', 'open'],
      ['first_aid', 'Minor scrape during unpacking. Cleaned and bandaged on site.', 'closed'],
      ['property_damage', 'Small wall mark found during closeout walk.', 'under_review'],
      ['other', 'Unauthorized access door was found propped open.', 'open'],
      ['recordable', 'Worker reported shoulder strain after lifting carton.', 'under_review'],
      ['lost_time', 'Worker sent home after medical evaluation.', 'closed'],
      ['near_miss', 'Temporary cord crossed a doorway before a cover strip was placed.', 'closed'],
      ['property_damage', 'Service cart clipped a corner guard during staging.', 'open'],
      ['first_aid', 'Worker washed dust from eye and returned to duty.', 'closed'],
      ['other', 'Visitor entered the work area before check-in was completed.', 'under_review'],
      ['near_miss', 'Loose shelf pin was found before loading stock.', 'open'],
      ['property_damage', 'Scuffed cabinet face found during room reset.', 'closed'],
      ['first_aid', 'Minor pinch while closing a cart latch.', 'closed'],
      ['other', 'Incorrect access badge packet was issued and recovered.', 'open'],
    ];
    for (let i = 0; i < incidents.length; i++) {
      const [type, description, status] = incidents[i];
      await upsertBy(
        client,
        'incident_reports',
        { company_id: companyId, description },
        {
          user_id: workerByIndex(i).id,
          project_id: projectByIndex(i).id,
          incident_date: isoDate(-i * 3),
          incident_time: `${8 + i}:20`,
          type,
          injured_name: type === 'first_aid' || type === 'recordable' || type === 'lost_time' ? workerByIndex(i).full_name : null,
          body_part: type === 'recordable' ? 'Shoulder' : type === 'first_aid' ? 'Hand' : null,
          treatment: type === 'first_aid' ? 'First aid kit' : type === 'recordable' || type === 'lost_time' ? 'Clinic evaluation' : null,
          work_stopped: type === 'lost_time',
          witnesses: i % 2 === 0 ? workerByIndex(i + 1).full_name : null,
          corrective_action: 'Reviewed procedure, documented follow-up, and assigned a corrective action.',
          status,
        },
        '*'
      );
    }

    const subReportCompanies = ['Brightline Support', 'Mesa Specialty Services', 'Cedar Tech Group', 'Northstar Access', 'Valley Finish Crew'];
    await client.query(
      `DELETE FROM sub_reports
       WHERE company_id = $1
         AND sub_company = ANY($2::text[])`,
      [companyId, subReportCompanies]
    );
    for (let i = 0; i < 18; i++) {
      await ensureBy(
        client,
        'sub_reports',
        { company_id: companyId, project_id: projectByIndex(i).id, report_date: isoDate(-i - 1), sub_company: subReportCompanies[i % subReportCompanies.length] },
        {
          foreman_name: ['Jamie Cole', 'Drew Allen', 'Mia Torres', 'Rene Holt', 'Priya Shah'][i % 5],
          headcount: 2 + (i % 7),
          work_performed: [
            'Completed assigned support scope and uploaded closeout notes.',
            'Staged materials, verified access, and finished assigned room list.',
            'Assisted with stock movement, cleanup, and client-facing touch-ups.',
            'Finished inspection support and returned unused materials to storage.',
          ][i % 4],
          notes: i % 3 === 0 ? 'Waiting on final owner direction for one item.' : i % 5 === 0 ? 'Crew will return tomorrow for a short follow-up.' : null,
          created_by: admin.id,
        },
        '*'
      );
    }

    for (let i = 0; i < 20; i++) {
      await upsertBy(
        client,
        'rfis',
        { company_id: companyId, project_id: projectByIndex(i).id, rfi_number: 100 + i },
        {
          subject: [
            'Confirm alternate mounting location',
            'Clarify room naming convention',
            'Approve equivalent stock item',
            'Confirm after-hours access window',
            'Confirm preferred closeout photo standard',
            'Approve temporary storage location',
            'Clarify owner-provided equipment handoff',
            'Confirm sequence for occupied rooms',
          ][i % 8],
          description: [
            'Demo RFI used to show status, due dates, responses, and project context.',
            'Please confirm the preferred approach before the team proceeds with this work block.',
            'The field team needs a written direction so the daily report and closeout notes match the owner expectation.',
          ][i % 3],
          directed_to: ['Client PM', 'Facilities Lead', 'Operations Contact', 'Owner Rep'][i % 4],
          submitted_by: admin.full_name,
          date_submitted: isoDate(-i - 4),
          date_due: isoDate(i % 5 === 0 ? -1 : 3 + i),
          response: i % 3 === 0 ? 'Approved as proposed.' : i % 4 === 0 ? 'Use the alternate shown in the field note photo.' : null,
          status: ['open', 'answered', 'closed'][i % 3],
          created_by: admin.id,
        },
        '*'
      );
    }

    const talks = [
      ['Heat readiness', 'Hydration, shade breaks, and buddy checks for warm workdays.'],
      ['Manual handling', 'Team lifting, cart use, and stopping when loads are awkward.'],
      ['Vehicle staging', 'Safe loading zones, cone placement, and route van visibility.'],
      ['Client access', 'Badge control, locked doors, and visitor handoff expectations.'],
      ['Housekeeping', 'Clear walk paths, cord control, and end-of-day cleanup.'],
      ['Photo documentation', 'Privacy-safe photos, useful captions, and closeout evidence.'],
    ];
    for (let i = 0; i < talks.length; i++) {
      const [title, content] = talks[i];
      const talk = await upsertBy(
        client,
        'safety_talks',
        { company_id: companyId, title },
        {
          project_id: projectByIndex(i).id,
          content,
          given_by: (admins[i % admins.length] || admin).full_name,
          talk_date: isoDate(-i * 2),
          created_by: admin.id,
          pass_threshold: 80,
        },
        '*'
      );
      await client.query('DELETE FROM safety_talk_signoffs WHERE talk_id = $1', [talk.id]);
      for (const worker of workers.slice(0, 6)) {
        await client.query(
          `INSERT INTO safety_talk_signoffs (talk_id, worker_id, worker_name, signed_at, quiz_score, quiz_passed)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [talk.id, worker.id, worker.full_name, isoTimestamp(-i * 2, 9, 10), 82 + ((worker.id + i) % 18), true]
        );
      }
    }

    const safetyChecklistTemplates = [
      {
        name: 'Opening Readiness Check',
        description: 'Start-of-day readiness for active work areas.',
        scope: 'general',
        items: [
          { label: 'Access path is open and clear', type: 'check', required: true },
          { label: 'Required supplies are staged', type: 'check', required: true },
          { label: 'Team has reviewed special instructions', type: 'check', required: true },
          { label: 'Opening notes', type: 'text', required: false },
        ],
      },
      {
        name: 'Vehicle and Kit Check',
        description: 'Quick verification for route vehicles, mobile kits, and job carts.',
        scope: 'general',
        items: [
          { label: 'Vehicle or cart is clean and ready', type: 'check', required: true },
          { label: 'Stock kit is complete', type: 'check', required: true },
          { label: 'Emergency supplies are present', type: 'check', required: true },
          { label: 'Mileage or kit notes', type: 'text', required: false },
        ],
      },
      {
        name: 'Closeout Walkthrough',
        description: 'End-of-day check before leaving the work area.',
        scope: 'general',
        items: [
          { label: 'Walkways are clear', type: 'check', required: true },
          { label: 'Tools and stock are secured', type: 'check', required: true },
          { label: 'Photos or notes were uploaded where needed', type: 'check', required: false },
          { label: 'Closeout notes', type: 'text', required: false },
        ],
      },
    ];
    const checklistTemplates = [];
    for (const tmpl of safetyChecklistTemplates) {
      checklistTemplates.push(await ensureBy(
        client,
        'safety_checklist_templates',
        { company_id: companyId, name: tmpl.name },
        {
          description: tmpl.description,
          scope: tmpl.scope,
          items: JSON.stringify(tmpl.items),
          created_by: admin.id,
        },
        '*'
      ));
    }
    await client.query(
      'DELETE FROM safety_checklist_submissions WHERE template_id = ANY($1::int[])',
      [checklistTemplates.map(template => template.id)]
    );
    for (let i = 0; i < 24; i++) {
      const template = checklistTemplates[i % checklistTemplates.length];
      const worker = workerByIndex(i);
      const checkDate = isoDate(-Math.floor(i / 2));
      await ensureBy(
        client,
        'safety_checklist_submissions',
        {
          company_id: companyId,
          template_id: template.id,
          project_id: projectByIndex(i).id,
          submitted_by: worker.id,
          check_date: checkDate,
        },
        {
          template_name: template.name,
          submitted_by_name: worker.full_name,
          answers: JSON.stringify({
            0: true,
            1: i % 7 !== 0,
            2: true,
            3: [
              'Ready for dispatch.',
              'One item restocked before work started.',
              'Closeout photos added to the field log.',
              'Follow-up assigned for the next shift.',
            ][i % 4],
          }),
          notes: i % 5 === 0 ? 'Demo note: one follow-up item was flagged for visibility.' : null,
        },
        '*'
      );
    }

    const inspectionTemplates = [
      {
        name: 'Work Area Readiness',
        description: 'General work area inspection for access, housekeeping, supplies, and readiness.',
        items: [
          { id: 'access-clear', label: 'Access path is clear', type: 'pass_fail' },
          { id: 'walkways-safe', label: 'Walkways are safe and unobstructed', type: 'pass_fail' },
          { id: 'materials-staged', label: 'Materials are staged correctly', type: 'pass_fail' },
          { id: 'lighting-ok', label: 'Lighting is adequate', type: 'pass_fail' },
          { id: 'readiness-score', label: 'Readiness score', type: 'number' },
          { id: 'inspector-note', label: 'Inspector note', type: 'text' },
        ],
      },
      {
        name: 'Vehicle and Mobile Kit Inspection',
        description: 'Inspection for vehicles, mobile kits, carts, and route equipment.',
        items: [
          { id: 'vehicle-clean', label: 'Vehicle or cart is clean', type: 'pass_fail' },
          { id: 'kit-stocked', label: 'Required kit stock is present', type: 'pass_fail' },
          { id: 'documents-current', label: 'Documents and tags are current', type: 'pass_fail' },
          { id: 'damage-check', label: 'No new damage found', type: 'pass_fail' },
          { id: 'odometer', label: 'Mileage or hour reading', type: 'number' },
          { id: 'kit-note', label: 'Kit notes', type: 'text' },
        ],
      },
      {
        name: 'Closeout Quality Review',
        description: 'End-of-day quality review for photos, labels, cleanup, and client-facing items.',
        items: [
          { id: 'photos-complete', label: 'Photos or evidence are complete', type: 'pass_fail' },
          { id: 'labels-correct', label: 'Labels and signage are correct', type: 'pass_fail' },
          { id: 'cleanup-complete', label: 'Cleanup is complete', type: 'pass_fail' },
          { id: 'client-items-closed', label: 'Client-facing items are closed', type: 'pass_fail' },
          { id: 'open-count', label: 'Open follow-up count', type: 'number' },
          { id: 'closeout-note', label: 'Closeout note', type: 'text' },
        ],
      },
      {
        name: 'Inventory Location Audit',
        description: 'Spot audit for stock rooms, carts, shelves, bins, and labeled storage areas.',
        items: [
          { id: 'bins-labeled', label: 'Bins and compartments are labeled', type: 'pass_fail' },
          { id: 'counts-match', label: 'Spot counts match expected stock', type: 'pass_fail' },
          { id: 'no-damaged-stock', label: 'No damaged stock found', type: 'pass_fail' },
          { id: 'reorder-visible', label: 'Reorder needs are visible', type: 'pass_fail' },
          { id: 'variance-count', label: 'Variance count', type: 'number' },
          { id: 'audit-note', label: 'Audit note', type: 'text' },
        ],
      },
    ];
    const inspectionTemplateRows = [];
    for (const tmpl of inspectionTemplates) {
      inspectionTemplateRows.push(await ensureBy(
        client,
        'inspection_templates',
        { company_id: companyId, name: tmpl.name },
        {
          description: tmpl.description,
          items: JSON.stringify(tmpl.items),
          created_by: null,
        },
        '*'
      ));
    }
    await client.query(
      'DELETE FROM inspections WHERE company_id = $1 AND template_id = ANY($2::uuid[])',
      [companyId, inspectionTemplateRows.map(template => template.id)]
    );
    const templateItems = template => Array.isArray(template.items) ? template.items : JSON.parse(template.items || '[]');
    for (let i = 0; i < 32; i++) {
      const template = inspectionTemplateRows[i % inspectionTemplateRows.length];
      const items = templateItems(template);
      const project = projectByIndex(i);
      const hasFailure = i % 7 === 0;
      const pending = i % 11 === 0;
      const results = {};
      for (const item of items) {
        if (item.type === 'pass_fail') {
          results[item.id] = pending && item.id.includes('client')
            ? { value: null, note: 'Waiting on client contact.' }
            : hasFailure && Object.keys(results).length === 1
              ? { value: 'fail', note: 'Demo follow-up flagged for review.' }
              : { value: 'pass' };
        } else if (item.type === 'number') {
          results[item.id] = { value: String((i * 3) % 12) };
        } else {
          results[item.id] = {
            value: [
              'Looks ready for the next work block.',
              'Minor cleanup note added for visibility.',
              'Client-facing area reviewed and documented.',
              'Stock and labels checked during walkthrough.',
            ][i % 4],
          };
        }
      }
      await ensureBy(
        client,
        'inspections',
        { company_id: companyId, name: `${template.name} - ${project.job_number || project.name} ${isoDate(-Math.floor(i / 2))}` },
        {
          template_id: template.id,
          project_id: null,
          inspector: (admins[i % admins.length] || admin).full_name,
          location: `${project.name} - ${['Front area', 'Back room', 'Vehicle bay', 'Supply room', 'Suite 204', 'Common area'][i % 6]}`,
          notes: hasFailure
            ? 'One demo issue was left open so fail-state cards have realistic content.'
            : pending
              ? 'Inspection started; one response is pending confirmation.'
              : 'Inspection complete with no blocking issues.',
          results: JSON.stringify(results),
          status: pending ? 'pending' : hasFailure ? 'fail' : 'pass',
          inspected_at: isoDate(-Math.floor(i / 2)),
          created_by: null,
        },
        '*'
      );
    }

    const equipmentSeed = [
      ['Route Van 14', 'Vehicle', 'VAN-014', 500],
      ['Route Van 22', 'Vehicle', 'VAN-022', 500],
      ['Lift Cart A', 'Material handling', 'LC-A', 250],
      ['Portable Label Printer', 'Tooling', 'LBL-03', 300],
      ['Tablet Kit 5', 'Technology', 'TAB-05', 200],
      ['Service Trailer 2', 'Trailer', 'TRL-02', 750],
      ['Floor Scrubber', 'Cleaning', 'FS-01', 400],
      ['Inspection Camera', 'Technology', 'CAM-09', 150],
      ['Mobile Supply Cart', 'Material handling', 'MSC-04', 275],
      ['Portable Work Light Set', 'Tooling', 'LGT-02', 220],
      ['Route Van 31', 'Vehicle', 'VAN-031', 500],
      ['Inventory Scanner Pair', 'Technology', 'SCAN-02', 180],
    ];
    const equipment = [];
    for (const [name, type, unit, interval] of equipmentSeed) {
      equipment.push(await ensureBy(
        client,
        'equipment_items',
        { company_id: companyId, name },
        { type, unit_number: unit, maintenance_interval_hours: interval, notes: 'Seeded demo equipment for visual testing.', active: true },
        '*'
      ));
    }
    await client.query(
      `DELETE FROM equipment_hours h
       USING equipment_items e
       WHERE h.equipment_id = e.id
         AND h.company_id = $1
         AND e.company_id = $1
         AND e.name = ANY($2::text[])`,
      [companyId, equipmentSeed.map(([name]) => name)]
    );
    for (let i = 0; i < 60; i++) {
      const eq = equipment[i % equipment.length];
      await ensureBy(
        client,
        'equipment_hours',
        { company_id: companyId, equipment_id: eq.id, log_date: isoDate(-i), operator_name: workerByIndex(i).full_name },
        {
          project_id: projectByIndex(i).id,
          hours: 1.5 + (i % 7),
          notes: ['Delivery support', 'Inspection run', 'Material staging', 'Closeout support'][i % 4],
          created_by: admin.id,
        },
        '*'
      );
    }

    const locationSeed = [
      ['Mesa Job Closet', 'job_site', projectByIndex(1).id, 'On-site consumables and small equipment.'],
      ['Clinic North Supply Room', 'job_site', projectByIndex(4).id, 'Controlled room stock for clinic turnover.'],
      ['Retail Night Cart', 'truck', projectByIndex(5).id, 'Mobile cart for after-hours store work.'],
      ['Central Overflow', 'warehouse', null, 'Overflow and slow-moving inventory.'],
    ];
    const locations = [];
    for (const [name, type, projectId, notes] of locationSeed) {
      locations.push(await ensureBy(
        client,
        'inventory_locations',
        { company_id: companyId, name },
        { type, project_id: projectId, notes, active: true, address: 'Phoenix metro area' },
        '*'
      ));
    }
    const allLocations = await client.query('SELECT * FROM inventory_locations WHERE company_id = $1 AND active = true ORDER BY id', [companyId]);

    const binMap = [];
    for (const loc of allLocations.rows.slice(0, 5)) {
      const area = await ensureBy(client, 'inventory_areas', { company_id: companyId, location_id: loc.id, name: 'Main Area' }, { notes: 'Primary storage area.' }, '*');
      const rack = await ensureBy(client, 'inventory_racks', { company_id: companyId, area_id: area.id, name: 'Rack A' }, { notes: 'Fast-moving stock.' }, '*');
      const bay = await ensureBy(client, 'inventory_bays', { company_id: companyId, rack_id: rack.id, name: `Bay ${1 + (loc.id % 3)}` }, { notes: 'Seeded bay.' }, '*');
      const compartment = await ensureBy(client, 'inventory_compartments', { company_id: companyId, bay_id: bay.id, name: `Compartment ${String.fromCharCode(65 + (loc.id % 4))}` }, { notes: 'Seeded compartment.' }, '*');
      binMap.push({ location_id: loc.id, area_id: area.id, rack_id: rack.id, bay_id: bay.id, compartment_id: compartment.id });
    }

    const supplierSeed = [
      ['Apex Facilities Supply', 'Marin Gray', '(555) 010-3401', 'orders@apex.example.test'],
      ['Summit Safety Co.', 'Peter Shaw', '(555) 010-1180', 'sales@summit.example.test'],
      ['BlueLine Hardware', 'Ivy Chen', '(555) 010-5068', 'team@blueline.example.test'],
    ];
    const suppliers = [];
    for (const [name, contactName, phone, email] of supplierSeed) {
      suppliers.push(await ensureBy(
        client,
        'inventory_suppliers',
        { company_id: companyId, name },
        { contact_name: contactName, phone, email, notes: 'Demo supplier.', active: true },
        '*'
      ));
    }

    const inventorySeed = [
      ['Access Badge Sleeve', 'BADGE-SLV', 'Office', 'each', 1.2, 25, 100],
      ['Sanitizer Refill Pack', 'SAN-REF-1L', 'Healthcare', 'case', 42.5, 6, 12],
      ['Shelf Label Roll', 'LBL-ROLL', 'Retail', 'roll', 18.75, 10, 24],
      ['Cord Cover Strip', 'CORD-CVR-6', 'Safety', 'each', 9.85, 8, 20],
      ['Tablet Charging Cable', 'USB-C-10', 'Technology', 'each', 7.25, 20, 50],
      ['Work Order Clipboard', 'CLIP-WO', 'Office', 'each', 5.5, 10, 30],
      ['Caution Floor Sign', 'SIGN-WET', 'Safety', 'each', 14.2, 5, 12],
      ['Door Stop Kit', 'DOOR-STP', 'Hardware', 'kit', 12.95, 6, 18],
      ['Cleaning Cloth Bundle', 'CLOTH-MF', 'Cleaning', 'pack', 16.4, 12, 30],
      ['Exam Room Bin', 'BIN-EXAM', 'Healthcare', 'each', 22.75, 8, 16],
      ['Retail Fixture Hook', 'HOOK-FIX', 'Retail', 'box', 27.9, 7, 14],
      ['Route Van First Aid Refill', 'FA-REFILL', 'Safety', 'kit', 31.5, 4, 10],
      ['Battery Pack', 'BAT-10K', 'Technology', 'each', 24, 5, 12],
      ['Floor Tape Yellow', 'TAPE-YEL', 'Safety', 'roll', 11.2, 9, 24],
      ['Service Request Door Tag', 'TAG-SR', 'Office', 'pack', 8.4, 15, 40],
      ['Replacement Air Filter', 'AIR-FLT-20', 'Maintenance', 'each', 19.95, 10, 30],
      ['Small Parts Organizer', 'ORG-SM', 'Hardware', 'each', 13.6, 8, 20],
      ['Nitrile Gloves Large', 'GLV-NTR-L', 'Safety', 'box', 12.75, 10, 30],
      ['Desk Cable Tray', 'TRAY-CBL', 'Office', 'each', 17.35, 6, 18],
      ['Inspection Tag Green', 'TAG-INSP-G', 'Compliance', 'pack', 6.2, 12, 36],
    ];
    const invItems = [];
    for (const [name, sku, category, unit, cost, reorderPoint, reorderQty] of inventorySeed) {
      invItems.push(await ensureBy(
        client,
        'inventory_items',
        { company_id: companyId, sku },
        {
          name,
          description: `${category} demo item for inventory table density and filtering.`,
          category,
          unit,
          unit_cost: cost,
          reorder_point: reorderPoint,
          reorder_qty: reorderQty,
          active: true,
          created_by: admin.id,
        },
        '*'
      ));
    }
    const itemBySku = Object.fromEntries(invItems.map(item => [item.sku, item]));
    const uomSeed = [
      ['SAN-REF-1L', 'bottle', '1 liter', 0.25],
      ['LBL-ROLL', 'case', '12 rolls', 12],
      ['USB-C-10', 'pack', '10 cables', 10],
      ['CLOTH-MF', 'case', '6 packs', 6],
      ['GLV-NTR-L', 'case', '10 boxes', 10],
      ['TAG-SR', 'case', '20 packs', 20],
      ['TAPE-YEL', 'case', '24 rolls', 24],
      ['BADGE-SLV', 'pack', '100 sleeves', 100],
    ];
    for (const [sku, unit, unitSpec, factor] of uomSeed) {
      const item = itemBySku[sku];
      if (!item) continue;
      await ensureBy(
        client,
        'inventory_item_uoms',
        { company_id: companyId, item_id: item.id, unit, unit_spec: unitSpec },
        { factor, is_base: false, active: true },
        '*'
      );
    }
    if (itemBySku['SAN-REF-1L']) {
      await client.query(
        `UPDATE inventory_item_uoms
         SET active = false
         WHERE company_id = $1
           AND item_id = $2
           AND unit = 'each'
           AND unit_spec = '1 liter bottle'`,
        [companyId, itemBySku['SAN-REF-1L'].id]
      );
    }
    const allItems = await client.query('SELECT * FROM inventory_items WHERE company_id = $1 AND active = true ORDER BY id', [companyId]);
    for (let i = 0; i < allItems.rows.length; i++) {
      const item = allItems.rows[i];
      const primary = binMap[i % binMap.length];
      const secondary = binMap[(i + 2) % binMap.length];
      await upsertStock(client, { company_id: companyId, item_id: item.id, location_id: primary.location_id, quantity: 3 + ((i * 7) % 64), ...primary });
      if (i % 2 === 0) {
        await upsertStock(client, { company_id: companyId, item_id: item.id, location_id: secondary.location_id, quantity: 1 + ((i * 5) % 34), ...secondary });
      }
    }

    for (let i = 0; i < 70; i++) {
      const item = allItems.rows[i % allItems.rows.length];
      const locA = allLocations.rows[i % allLocations.rows.length];
      const locB = allLocations.rows[(i + 1) % allLocations.rows.length];
      const type = ['receive', 'issue', 'transfer', 'adjust'][i % 4];
      await upsertBy(
        client,
        'inventory_transactions',
        { company_id: companyId, reference_no: `DEMO-TXN-${String(i + 1).padStart(3, '0')}` },
        {
          type,
          item_id: item.id,
          quantity: type === 'issue' ? -(1 + (i % 6)) : 1 + (i % 12),
          from_location_id: type === 'receive' ? null : locA.id,
          to_location_id: type === 'issue' ? null : locB.id,
          project_id: type === 'issue' ? projectByIndex(i).id : null,
          performed_by: workerByIndex(i).id,
          notes: ['Cycle replenish', 'Project issue', 'Location transfer', 'Count adjustment'][i % 4],
          unit_cost: item.unit_cost || null,
          supplier_id: suppliers[i % suppliers.length]?.id || null,
          lot_number: i % 3 === 0 ? `LOT-${202600 + i}` : null,
          created_at: isoTimestamp(-Math.floor(i / 3), 9 + (i % 8), (i * 7) % 60),
        },
        '*'
      );
    }

    for (let i = 0; i < 5; i++) {
      const po = await upsertBy(
        client,
        'purchase_orders',
        { company_id: companyId, po_number: `DEMO-PO-${String(i + 1).padStart(3, '0')}` },
        {
          supplier_id: suppliers[i % suppliers.length]?.id || null,
          status: ['draft', 'submitted', 'partial', 'received', 'cancelled'][i % 5],
          order_date: isoDate(-12 + i),
          expected_date: isoDate(4 + i),
          to_location_id: allLocations.rows[i % allLocations.rows.length].id,
          notes: 'Seeded demo PO with multiple line states.',
          reference_no: `REF-${9000 + i}`,
          created_by: admin.id,
          submitted_at: i > 0 ? isoTimestamp(-10 + i, 11, 0) : null,
          received_at: i === 3 ? isoTimestamp(-2, 14, 30) : null,
        },
        '*'
      );
      await replaceChildRows(client, 'purchase_order_lines', 'po_id', po.id, [
        { item_id: allItems.rows[(i * 2) % allItems.rows.length].id, qty_ordered: 12 + i, qty_received: i >= 2 ? 8 + i : 0, unit_cost: allItems.rows[(i * 2) % allItems.rows.length].unit_cost || 10, notes: 'Primary replenishment' },
        { item_id: allItems.rows[(i * 2 + 1) % allItems.rows.length].id, qty_ordered: 6 + i, qty_received: i === 3 ? 6 + i : 0, unit_cost: allItems.rows[(i * 2 + 1) % allItems.rows.length].unit_cost || 10, notes: 'Secondary stock' },
      ]);
    }

    const countSeed = [
      { label: 'Phoenix depot cycle count', count_type: 'cycle', status: 'completed', location: 0, started: -9, completed: -8, counted: 7, total: 7 },
      { label: 'North route van audit', count_type: 'audit', status: 'in_progress', location: 1, started: -3, completed: null, counted: 4, total: 8 },
      { label: 'Clinic supply room reconcile', count_type: 'reconcile', status: 'draft', location: 2, started: -1, completed: null, counted: 0, total: 6 },
    ];
    for (let i = 0; i < countSeed.length; i++) {
      const seed = countSeed[i];
      const loc = allLocations.rows[seed.location % allLocations.rows.length];
      const count = await ensureBy(
        client,
        'inventory_cycle_counts',
        { company_id: companyId, notes: `Demo count: ${seed.label}` },
        {
          location_id: loc.id,
          count_type: seed.count_type,
          status: seed.status,
          started_by: admin.id,
          completed_by: seed.completed ? admin.id : null,
          started_at: isoTimestamp(seed.started, 8, 15 + i * 10),
          completed_at: seed.completed ? isoTimestamp(seed.completed, 15, 30) : null,
        },
        '*'
      );
      await client.query(
        `UPDATE inventory_cycle_counts
         SET location_id=$1, count_type=$2, status=$3, started_by=$4,
             completed_by=$5, started_at=$6, completed_at=$7
         WHERE id=$8`,
        [
          loc.id,
          seed.count_type,
          seed.status,
          admin.id,
          seed.completed ? admin.id : null,
          isoTimestamp(seed.started, 8, 15 + i * 10),
          seed.completed ? isoTimestamp(seed.completed, 15, 30) : null,
          count.id,
        ]
      );
      const stockRows = await client.query(
        `SELECT item_id, location_id, quantity, uom_id
         FROM inventory_stock
         WHERE company_id=$1 AND location_id=$2
         ORDER BY item_id
         LIMIT $3`,
        [companyId, loc.id, seed.total]
      );
      const lines = stockRows.rows.map((row, index) => {
        const expected = parseFloat(row.quantity || 0);
        const isCounted = index < seed.counted;
        const counted = isCounted ? expected + ([0, 1, -1, 0.5][index % 4]) : null;
        return {
          item_id: row.item_id,
          location_id: row.location_id,
          expected_qty: expected,
          counted_qty: counted,
          counted_by: isCounted ? workerByIndex(index).id : null,
          counted_at: isCounted ? isoTimestamp(seed.started + 1, 10 + (index % 4), (index * 9) % 60) : null,
          stock_uom_id: row.uom_id || null,
          counted_uom_id: row.uom_id || null,
          line_status: isCounted ? 'accepted' : 'pending',
          notes: isCounted ? 'Seeded demo count entry.' : null,
        };
      });
      await replaceChildRows(client, 'inventory_cycle_count_lines', 'cycle_count_id', count.id, lines);
      await client.query('DELETE FROM inventory_count_workers WHERE cycle_count_id = $1', [count.id]);
      await client.query(
        `INSERT INTO inventory_count_workers (cycle_count_id, user_id, roles)
         VALUES ($1,$2,$3),($1,$4,$5)
         ON CONFLICT (cycle_count_id, user_id) DO UPDATE SET roles=EXCLUDED.roles`,
        [count.id, workerByIndex(i).id, ['counter'], workerByIndex(i + 1).id, ['auditor', 'reconciler']]
      );
    }

    const demoTimeEntryNotes = ['Demo work block', 'Travel and staging', 'Closeout support', 'Field task execution'];
    await client.query(
      `DELETE FROM time_entries
       WHERE company_id = $1
         AND notes = ANY($2::text[])`,
      [companyId, demoTimeEntryNotes]
    );
    for (let day = -12; day <= -1; day++) {
      for (let i = 0; i < Math.min(8, workers.length); i++) {
        if ((day + i) % 5 === 0) continue;
        const startHour = 7 + (i % 3);
        const duration = 7 + ((i + Math.abs(day)) % 3);
        const status = (day + i) % 4 === 0 ? 'pending' : 'approved';
        await ensureBy(
          client,
          'time_entries',
          { company_id: companyId, user_id: workers[i].id, work_date: isoDate(day), start_time: `${String(startHour).padStart(2, '0')}:00:00` },
          {
            project_id: projectByIndex(i + Math.abs(day)).id,
            end_time: `${String(startHour + duration).padStart(2, '0')}:00:00`,
            wage_type: 'regular',
            rate: 30 + (i % 6),
            notes: ['Demo work block', 'Travel and staging', 'Closeout support', 'Field task execution'][i % 4],
            status,
            approved_by: status === 'approved' ? admin.id : null,
            approved_at: status === 'approved' ? isoTimestamp(day, 17, 20) : null,
            break_minutes: i % 2 === 0 ? 30 : 0,
            mileage: i % 3 === 0 ? 12 + i : null,
            clock_source: i % 4 === 0 ? 'admin' : 'worker',
            clocked_in_by: i % 4 === 0 ? admin.id : null,
            start_ts: isoTimestamp(day, startHour, 0),
            end_ts: isoTimestamp(day, startHour + duration, 0),
          },
          '*'
        );
      }
    }

    await client.query('DELETE FROM active_clock WHERE company_id = $1', [companyId]);
    for (let i = 0; i < Math.min(3, workers.length); i++) {
      const lat = 33.45 + (i / 100);
      const lng = -112.07 - (i / 100);
      await upsertActiveClock(client, {
        company_id: companyId,
        user_id: workers[i].id,
        project_id: projectByIndex(i).id,
        clock_in_time: isoTimestamp(0, 7 + i, 15),
        clock_in_lat: lat,
        clock_in_lng: lng,
        work_date: isoDate(0),
        notes: ['Route prep', 'Clinic turnover', 'Inventory staging'][i % 3],
        timezone: 'America/Phoenix',
        clock_source: 'worker',
        current_lat: lat,
        current_lng: lng,
        location_updated_at: isoTimestamp(0, 10 + i, 5),
      });
    }

    const bookingShiftType = await upsertBy(
      client,
      'shift_types',
      { company_id: companyId, name: 'Demo Booking Availability' },
      {
        color: '#2563eb',
        description: 'Seeded availability that lets the demo booking page show real openings.',
        active: true,
      },
      '*'
    );
    const bookableUsers = Array.from(
      new Map([admin, ...admins.slice(0, 2), ...workers.slice(0, 3)]
        .filter(Boolean)
        .map(user => [user.id, user]))
        .values()
    );
    const bookableIds = bookableUsers.map(user => user.id);
    await client.query('UPDATE users SET bookable = false WHERE company_id = $1', [companyId]);
    for (const user of bookableUsers) {
      await client.query(
        `UPDATE users
         SET bookable = true,
             bookable_role_label = $1,
             timezone = COALESCE(timezone, 'America/Phoenix')
         WHERE id = $2 AND company_id = $3`,
        [user.id === admin.id || admins.some(adminUser => adminUser.id === user.id) ? 'Demo coordinator' : 'Demo specialist', user.id, companyId]
      );
    }
    await client.query(
      'DELETE FROM bookable_windows WHERE user_id IN (SELECT id FROM users WHERE company_id = $1)',
      [companyId]
    );
    for (const user of bookableUsers) {
      for (const weekday of [1, 2, 3, 4, 5]) {
        await client.query(
          `INSERT INTO bookable_windows (user_id, weekday, start_time, end_time, active)
           VALUES ($1,$2,'08:30:00','16:30:00',true)`,
          [user.id, weekday]
        );
      }
      await client.query(
        `INSERT INTO bookable_windows (user_id, weekday, start_time, end_time, active)
         VALUES ($1,6,'09:00:00','12:00:00',true)`,
        [user.id]
      );
    }

    const demoShiftNotes = ['Demo scheduled shift', 'Route support', 'Closeout day', 'Inventory count'];
    await client.query(
      `DELETE FROM shifts
       WHERE company_id = $1
         AND notes = ANY($2::text[])`,
      [companyId, demoShiftNotes]
    );
    for (let i = 0; i < 18; i++) {
      await ensureBy(
        client,
        'shifts',
        { company_id: companyId, user_id: workerByIndex(i).id, shift_date: isoDate(i + 1), start_time: `${String(7 + (i % 3)).padStart(2, '0')}:00:00` },
        {
          project_id: projectByIndex(i).id,
          end_time: `${String(15 + (i % 3)).padStart(2, '0')}:30:00`,
          notes: ['Demo scheduled shift', 'Route support', 'Closeout day', 'Inventory count'][i % 4],
          shift_type_id: bookableIds.includes(workerByIndex(i).id) ? bookingShiftType.id : null,
          start_ts: isoTimestamp(i + 1, 7 + (i % 3), 0),
          end_ts: isoTimestamp(i + 1, 15 + (i % 3), 30),
        },
        '*'
      );
    }

    const timeOffSeed = [
      [0, 'vacation', 9, 11, 'Family trip'],
      [1, 'sick', -2, -2, 'Doctor visit'],
      [2, 'personal', 4, 4, 'Appointment'],
      [3, 'vacation', 18, 20, 'Long weekend'],
      [4, 'other', 6, 7, 'School event'],
      [5, 'sick', 13, 13, 'Medical follow-up'],
    ];
    await client.query(
      `DELETE FROM time_off_requests
       WHERE company_id = $1
         AND note = ANY($2::text[])`,
      [companyId, timeOffSeed.map(seed => seed[4])]
    );
    for (let i = 0; i < timeOffSeed.length; i++) {
      const [workerIndex, type, start, end, note] = timeOffSeed[i];
      await ensureBy(
        client,
        'time_off_requests',
        { company_id: companyId, user_id: workerByIndex(workerIndex).id, start_date: isoDate(start), end_date: isoDate(end) },
        {
          type,
          note,
          status: ['pending', 'approved', 'denied'][i % 3],
          reviewed_by: i % 3 === 0 ? null : admin.id,
          review_note: i % 3 === 1 ? 'Approved for demo schedule.' : i % 3 === 2 ? 'Coverage already committed.' : null,
          reviewed_at: i % 3 === 0 ? null : isoTimestamp(-1, 14, 0),
        },
        '*'
      );
    }

    const bookingTypes = [
      {
        slug: 'opsfloa-demo-overview',
        name: 'OpsFloA demo overview',
        description: 'See how time, people, field work, inventory, public requests, and reporting fit together.',
        duration_minutes: 45,
        buffer_before_min: 10,
        buffer_after_min: 10,
        advance_notice_hrs: 4,
        max_advance_days: 30,
        slot_interval_min: 30,
        location_kind: 'video',
        location_detail: 'Video call link sent after booking',
      },
      {
        slug: 'operations-fit-review',
        name: 'Operations fit review',
        description: 'Talk through your workflows and which OpsFloA modules should be on from day one.',
        duration_minutes: 60,
        buffer_before_min: 15,
        buffer_after_min: 15,
        advance_notice_hrs: 8,
        max_advance_days: 45,
        slot_interval_min: 30,
        location_kind: 'phone',
        location_detail: 'Phone consultation',
      },
      {
        slug: 'field-inventory-walkthrough',
        name: 'Field and inventory walkthrough',
        description: 'A practical demo focused on field notes, photos, counts, stock, purchase orders, and finding materials fast.',
        duration_minutes: 60,
        buffer_before_min: 10,
        buffer_after_min: 20,
        advance_notice_hrs: 8,
        max_advance_days: 45,
        slot_interval_min: 30,
        location_kind: 'video',
        location_detail: 'Video call link sent after booking',
      },
    ];
    const appointmentTypes = [];
    for (const type of bookingTypes) {
      const appointmentType = await upsertBy(
        client,
        'appointment_types',
        { company_id: companyId, slug: type.slug },
        {
          name: type.name,
          description: type.description,
          duration_minutes: type.duration_minutes,
          buffer_before_min: type.buffer_before_min,
          buffer_after_min: type.buffer_after_min,
          advance_notice_hrs: type.advance_notice_hrs,
          max_advance_days: type.max_advance_days,
          slot_interval_min: type.slot_interval_min,
          active: true,
          is_public: true,
          location_kind: type.location_kind,
          location_detail: type.location_detail,
        },
        '*'
      );
      appointmentTypes.push(appointmentType);
      await client.query('DELETE FROM appointment_type_users WHERE appointment_type_id = $1', [appointmentType.id]);
      for (const userId of bookableIds) {
        await client.query(
          'INSERT INTO appointment_type_users (appointment_type_id, user_id) VALUES ($1,$2)',
          [appointmentType.id, userId]
        );
      }
      await client.query('DELETE FROM appointment_type_shift_types WHERE appointment_type_id = $1', [appointmentType.id]);
      await client.query(
        'INSERT INTO appointment_type_shift_types (appointment_type_id, shift_type_id) VALUES ($1,$2)',
        [appointmentType.id, bookingShiftType.id]
      );
    }
    await client.query(
      `DELETE FROM appointments
       WHERE company_id = $1
         AND client_email LIKE '%@demo-booking.example.test'`,
      [companyId]
    );
    const appointmentSeed = [
      [0, 0, 'Jordan Visitor', 'jordan@demo-booking.example.test', 2, 17, 0, 'booked', 'Interested in seeing the overall workflow.'],
      [1, 1, 'Morgan Planner', 'morgan@demo-booking.example.test', 4, 20, 30, 'confirmed', 'Wants to compare setup options for a mixed office and field team.'],
      [2, 2, 'Sam Inventory', 'sam@demo-booking.example.test', 7, 16, 30, 'booked', 'Focused on stock visibility, POs, and count workflows.'],
      [1, 0, 'Alex Completed', 'alex@demo-booking.example.test', -3, 18, 0, 'completed', 'Completed demo call retained for history views.'],
      [0, 1, 'Casey Cancelled', 'casey@demo-booking.example.test', -1, 21, 0, 'cancelled', 'Cancelled demo appointment retained for status filters.'],
    ];
    for (let i = 0; i < appointmentSeed.length; i++) {
      const [typeIndex, userIndex, clientName, clientEmail, offset, hour, minute, status, notes] = appointmentSeed[i];
      const appointmentType = appointmentTypes[typeIndex % appointmentTypes.length];
      const assignedUser = bookableUsers[userIndex % bookableUsers.length];
      const scheduledAt = isoTimestamp(offset, hour, minute);
      const tokenHash = crypto.createHash('sha256').update(`demo-booking-${i}-${scheduledAt}`).digest('hex');
      await client.query(
        `INSERT INTO appointments
           (company_id, appointment_type_id, assigned_user_id, client_name, client_email,
            client_phone, client_notes, project_id, scheduled_at, duration_minutes,
            status, manage_token_hash, cancelled_at, cancelled_by, cancel_reason, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          companyId,
          appointmentType.id,
          assignedUser.id,
          clientName,
          clientEmail,
          `(555) 010-${8200 + i}`,
          notes,
          projectByIndex(i).id,
          scheduledAt,
          appointmentType.duration_minutes,
          status,
          tokenHash,
          status === 'cancelled' ? isoTimestamp(offset, hour - 2, 0) : null,
          status === 'cancelled' ? 'client' : null,
          status === 'cancelled' ? 'Demo cancellation example.' : null,
          status === 'completed' ? isoTimestamp(offset, hour + 1, minute) : null,
        ]
      );
    }

    const reimbursements = [
      ['Mileage to clinic pickup', 'mileage', 28.75, -1, 50],
      ['Parking for client walkthrough', 'travel', 16, -3, null],
      ['Replacement labels purchased locally', 'materials', 34.8, -5, null],
      ['After-hours meal during retail closeout', 'meal', 18.25, -7, null],
      ['Fuel for route van', 'fuel', 52.1, -8, null],
      ['Small hardware receipt', 'materials', 22.4, -10, null],
    ];
    for (let i = 0; i < reimbursements.length; i++) {
      const [description, category, amount, dateOffset, miles] = reimbursements[i];
      await upsertBy(
        client,
        'reimbursements',
        { company_id: companyId, user_id: workerByIndex(i).id, description },
        {
          amount,
          category,
          expense_date: isoDate(dateOffset),
          status: ['pending', 'approved', 'rejected'][i % 3],
          admin_notes: i % 3 === 1 ? 'Approved in demo review.' : null,
          project_id: projectByIndex(i).id,
          miles,
          mileage_rate: miles ? 0.575 : null,
        },
        '*'
      );
    }

    const requestSeed = [
      ['Amanda West', 'Facilities help', 'Need help reorganizing the supply area before staff training.', 'new'],
      ['Ben Ortega', 'Repair', 'Door hardware is sticking and needs service this week.', 'in_review'],
      ['Maya Reed', 'New work', 'Requesting a quote for room setup and signage.', 'converted'],
      ['Victor Hall', 'Maintenance', 'Common area lights need inspection after the weekend.', 'new'],
      ['Tessa Grant', 'Other', 'Please confirm options for recurring weekly support.', 'declined'],
    ];
    for (let i = 0; i < requestSeed.length; i++) {
      const [name, category, description, status] = requestSeed[i];
      await upsertBy(
        client,
        'service_requests',
        { company_id: companyId, requester_name: name, description },
        {
          client_id: allClients.rows[i % allClients.rows.length]?.id || null,
          requester_email: `${name.toLowerCase().replace(/ /g, '.')}@example.test`,
          requester_phone: `(555) 010-${7000 + i}`,
          requester_address: `${100 + i} Demo Ave, Phoenix, AZ`,
          category,
          status,
          admin_notes: i % 2 === 0 ? 'Seeded request for demo review.' : null,
          converted_project_id: status === 'converted' ? projectByIndex(i).id : null,
          reviewed_by: status !== 'new' ? admin.id : null,
          reviewed_at: status !== 'new' ? isoTimestamp(-i, 13, 15) : null,
        },
        '*'
      );
    }

    // ── Construction lifecycle ────────────────────────────────────────────────
    // Powers the Sales (estimates / change orders), Subs (POs), and
    // field-compliance (submittals / lien waivers) modules. Seeded with a
    // spread of statuses so the demo shows realistic pipelines. Totals are
    // computed here directly because the seeder bypasses the route layer
    // that normally recomputes them — the cascade mirrors
    // server/constants/projectMoneyEnums.js computeEstimateTotals.
    function lineTotalCents(qty, unitCostCents) {
      const q = Number.isFinite(qty) ? qty : 0;
      const u = Number.isFinite(unitCostCents) ? unitCostCents : 0;
      return Math.max(0, Math.round(q * u));
    }
    function moneyTotals(lines, { overhead = 0, margin = 0, contingency = 0, tax = 0 }) {
      const subtotal = lines.reduce((sum, l) => sum + lineTotalCents(l.qty, l.unit_cost_cents), 0);
      const oh = Math.round(subtotal * (overhead / 100));
      const marginBase = subtotal + oh;
      const mg = Math.round(marginBase * (margin / 100));
      const preCont = marginBase + mg;
      const ct = Math.round(preCont * (contingency / 100));
      const preTax = preCont + ct;
      const tx = Math.round(preTax * (tax / 100));
      return { subtotal, total: preTax + tx };
    }

    // Subcontractors
    const subSeed = [
      ['Copper State Electric', 'Dana Ruiz', 'dana.ruiz@example.test', '(555) 010-2210', 'ROC-118822', 'Electrical'],
      ['Granite Mechanical', 'Hal Briggs', 'hal.briggs@example.test', '(555) 010-3340', 'ROC-220199', 'HVAC & Mechanical'],
      ['Sonoran Drywall Co.', 'Pia Nava', 'pia.nava@example.test', '(555) 010-4451', 'ROC-330577', 'Drywall & Finishes'],
    ];
    const subs = [];
    for (const [name, contact, email, phone, license, scope] of subSeed) {
      subs.push(await ensureBy(client, 'subcontractors',
        { company_id: companyId, name },
        {
          contact_name: contact, contact_email: email, contact_phone: phone,
          license_number: license, scope_specialty: scope, created_by: admin.id, archived: false,
        },
        '*'));
    }

    // Sub purchase orders against in-progress projects, plus a payment on the partial one
    const poSeed = [
      // [subIndex, projectIndex, po_number, amount_cents, status, scope, retainage_pct]
      [0, 0, 'SP-2026-0001', 1850000, 'issued',  'Power distribution and lighting rough-in for the classroom wing.', 10],
      [1, 1, 'SP-2026-0002', 1240000, 'partial', 'RTU replacement and ductwork for exam rooms.', 5],
      [2, 2, 'SP-2026-0003', 680000,  'draft',   'Hang and finish drywall in the backroom reorganization area.', 0],
    ];
    const pos = [];
    for (const [si, pi, poNum, amount, status, scope, retainage] of poSeed) {
      pos.push(await ensureBy(client, 'subcontract_pos',
        { company_id: companyId, po_number: poNum },
        {
          project_id: projectByIndex(pi).id, subcontractor_id: subs[si].id,
          status, amount_cents: amount, scope_of_work: scope, retainage_pct: retainage,
          created_by: admin.id,
        },
        '*'));
    }
    // A recorded progress payment on the 'partial' PO (flagged as needing a waiver).
    await ensureChildRows(client, 'subcontract_po_payments', 'po_id', pos[1].id, [
      {
        amount_cents: 600000, paid_date: isoDate(-10), invoice_ref: 'INV-GM-0461',
        notes: 'Progress payment 1', created_by: admin.id, waiver_required: true, waiver_received: true,
      },
    ]);

    // Estimates — an accepted, a sent, and a draft, each with line items.
    const estSeed = [
      // [number, clientIndex, projectName, status, overhead, margin, contingency, tax, [[cat, desc, qty, unit, unitCostCents]]]
      ['EST-2026-0001', 0, 'Cedar Learning Center Rollout', 'accepted', 10, 12, 5, 8.6, [
        ['labor', 'Install tablet charging carts and secure mounts', 120, 'hr', 6500],
        ['materials', 'Cart hardware, cable management, and signage', 1, 'lot', 480000],
        ['equipment', 'Lift rental for high signage installation', 3, 'day', 38000],
      ]],
      ['EST-2026-0002', 1, 'Harbor Clinic Room Turnover', 'sent', 8, 15, 0, 8.6, [
        ['labor', 'Exam room refresh and stock staging', 90, 'hr', 6200],
        ['materials', 'Casework, fixtures, and safety signage', 1, 'lot', 265000],
        ['subs', 'HVAC balancing (Granite Mechanical)', 1, 'lot', 124000],
      ]],
      ['EST-2026-0003', 2, 'Sunset Retail Refresh', 'draft', 12, 10, 5, 8.1, [
        ['labor', 'Fixture reset and backroom organization', 64, 'hr', 5800],
        ['materials', 'Shelving, bins, and label system', 1, 'lot', 92000],
      ]],
    ];
    for (const [num, ci, projName, status, oh, mg, ct, tx, rawLines] of estSeed) {
      const clientRow = allClients.rows[ci % allClients.rows.length];
      const projRow = allProjects.rows.find(p => p.name === projName);
      const lines = rawLines.map((l, idx) => ({
        category: l[0], sort_order: idx, description: l[1],
        qty: l[2], unit: l[3], unit_cost_cents: l[4], total_cents: lineTotalCents(l[2], l[4]),
      }));
      const t = moneyTotals(lines, { overhead: oh, margin: mg, contingency: ct, tax: tx });
      const est = await ensureBy(client, 'estimates',
        { company_id: companyId, estimate_number: num },
        {
          client_id: clientRow?.id || null,
          client_name_snapshot: clientRow?.name || 'Demo Client',
          client_email: clientRow?.contact_email || null,
          project_name: projName,
          project_address: projRow?.address || null,
          scope_summary: 'Scope and pricing for the demo engagement.',
          overhead_pct: oh, margin_pct: mg, contingency_pct: ct, tax_pct: tx,
          subtotal_cents: t.subtotal, total_cents: t.total,
          status, valid_until: isoDate(30),
          exclusions: 'Permits, after-hours premium, and owner-furnished items are excluded.',
          terms: 'Net 30. 50% mobilization deposit due on acceptance.',
          accepted_signer_name: status === 'accepted' ? (clientRow?.contact_name || 'Authorized Signer') : null,
          responded_at: status === 'accepted' ? isoTimestamp(-5, 11) : null,
          created_by: admin.id,
        },
        '*');
      await ensureChildRows(client, 'estimate_lines', 'estimate_id', est.id, lines);
    }

    // Change order against the first in-progress project.
    const coLines = [
      { category: 'labor', sort_order: 0, description: 'Add second-floor data drops', qty: 24, unit: 'ea', unit_cost_cents: 8500 },
      { category: 'materials', sort_order: 1, description: 'Cabling, jacks, and faceplates', qty: 1, unit: 'lot', unit_cost_cents: 96000 },
    ].map(l => ({ ...l, total_cents: lineTotalCents(l.qty, l.unit_cost_cents) }));
    const coT = moneyTotals(coLines, { overhead: 10, margin: 12, tax: 8.6 });
    const co = await ensureBy(client, 'change_orders',
      { company_id: companyId, project_id: projectByIndex(0).id, co_number: 'CO-001' },
      {
        description: 'Owner-requested second-floor data drops added mid-project.',
        overhead_pct: 10, margin_pct: 12, tax_pct: 8.6,
        subtotal_cents: coT.subtotal, total_cents: coT.total,
        status: 'sent', created_by: admin.id,
      },
      '*');
    await ensureChildRows(client, 'change_order_lines', 'change_order_id', co.id, coLines);

    // Submittals across a few projects + statuses.
    const submittalSeed = [
      // [number, projectIndex, spec_section, title, status, required_by]
      ['SUB-A-001', 0, '26 05 00', 'Lighting fixtures — classroom wing', 'sent_to_reviewer', isoDate(14)],
      ['SUB-M-002', 1, '23 74 00', 'RTU equipment cut sheets', 'approved_as_noted', isoDate(7)],
      ['SUB-F-003', 2, '09 29 00', 'Gypsum board assembly submittal', 'draft', isoDate(21)],
    ];
    for (const [num, pi, spec, title, status, requiredBy] of submittalSeed) {
      await ensureBy(client, 'submittals',
        { company_id: companyId, project_id: projectByIndex(pi).id, submittal_number: num },
        {
          spec_section: spec, title, description: 'Demo submittal for owner / architect review.',
          status, reviewer_name: 'A/E Reviewer', reviewer_email: 'reviewer@example.test',
          reviewer_org: 'Demo Architects', required_by: requiredBy, revision: 0, created_by: admin.id,
        },
        '*');
    }

    // Lien waiver from a sub, tied to the partial PO and its payment.
    const lwPayment = await one(client,
      'SELECT id FROM subcontract_po_payments WHERE po_id = $1 ORDER BY id LIMIT 1', [pos[1].id]);
    await ensureBy(client, 'lien_waivers',
      {
        company_id: companyId, project_id: projectByIndex(1).id,
        direction: 'from_sub', subcontractor_id: subs[1].id, through_date: isoDate(-10),
      },
      {
        waiver_type: 'conditional_progress', amount_cents: 600000, state: 'AZ',
        signer_name: 'Hal Briggs', signer_title: 'President', signer_company: 'Granite Mechanical',
        subcontract_po_id: pos[1].id, sub_payment_id: lwPayment?.id || null,
        status: 'received', signature_method: 'typed', created_by: admin.id,
        notes: 'Conditional progress waiver covering payment 1.',
      },
      '*');

    await client.query('COMMIT');

    const countTables = [
      'users', 'clients', 'projects', 'field_reports', 'daily_reports', 'punchlist_items',
      'incident_reports', 'sub_reports', 'rfis', 'safety_talks', 'safety_checklist_templates',
      'safety_checklist_submissions', 'inspection_templates', 'inspections', 'equipment_items',
      'inventory_items', 'inventory_stock', 'inventory_transactions', 'purchase_orders', 'inventory_cycle_counts',
      'time_entries', 'active_clock', 'shifts', 'time_off_requests', 'reimbursements', 'service_requests',
      'subcontractors', 'subcontract_pos', 'estimates', 'change_orders', 'submittals', 'lien_waivers',
    ];
    for (const table of countTables) {
      const result = await pool.query(`SELECT COUNT(*)::int AS count FROM ${table} WHERE company_id = $1`, [companyId]);
      summary[table] = result.rows[0].count;
    }
    const photos = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM field_report_photos ph
       JOIN field_reports r ON r.id = ph.report_id
       WHERE r.company_id = $1`,
      [companyId]
    );
    summary.field_report_photos = photos.rows[0].count;
    console.log(JSON.stringify({ company: company.name, summary }, null, 2));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
