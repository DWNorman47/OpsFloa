-- Fill the public/demo surfaces for the existing Demo Operations account.
-- This is intentionally scoped to the fictional demo company only.

WITH demo_company AS (
  SELECT id
    FROM companies
   WHERE slug = 'demo-operations' OR name = 'Demo Operations'
   ORDER BY CASE WHEN slug = 'demo-operations' THEN 0 ELSE 1 END
   LIMIT 1
)
UPDATE companies c
   SET accepts_service_requests = true
  FROM demo_company d
 WHERE c.id = d.id;

WITH demo_company AS (
  SELECT id
    FROM companies
   WHERE slug = 'demo-operations' OR name = 'Demo Operations'
   ORDER BY CASE WHEN slug = 'demo-operations' THEN 0 ELSE 1 END
   LIMIT 1
),
demo_settings(key, value) AS (
  VALUES
    ('module_inventory', '1'),
    ('feature_public', '1')
)
INSERT INTO settings (company_id, key, value)
SELECT d.id, s.key, s.value
  FROM demo_company d
 CROSS JOIN demo_settings s
ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value;

WITH demo_company AS (
  SELECT id
    FROM companies
   WHERE slug = 'demo-operations' OR name = 'Demo Operations'
   ORDER BY CASE WHEN slug = 'demo-operations' THEN 0 ELSE 1 END
   LIMIT 1
)
INSERT INTO company_public_profiles
  (company_id, display_name, short_description, services_offered, service_areas,
   license_info, equipment_capabilities, project_types, quote_instructions,
   contact_info, faq_items, photos, is_public, published_at, updated_at)
SELECT d.id,
       'Demo Operations - OpsFloA Demo',
       'Demo Operations is a fictional public company profile built to show how OpsFloA helps teams run time, people, projects, field updates, inventory, public requests, and reporting from one simple operating system.',
       '["Time clock and approvals","People and role management","Project and customer tracking","Field notes, photos, punchlists, and safety","Inventory items, stock, counts, and purchase orders","Public request intake and company profile"]'::jsonb,
       '["Fictional Phoenix metro workspace","Office operations","Mobile field teams","Inventory rooms and service routes"]'::jsonb,
       'Demo Operations is not a real service provider. Licenses, contacts, projects, POs, field records, and inventory records are sample data for showing OpsFloA capabilities.',
       '["Daily demo data refresh","Mobile PWA workflows","Role-based admin controls","Public profile and request intake","Agent-readable business information","Reporting and operational dashboards"]'::jsonb,
       '["Facility service route demo","Retail refresh demo","Clinic room turnover demo","Inventory staging demo","Subcontractor PO demo","Public request demo"]'::jsonb,
       'Use Request work to submit a sample request and see how OpsFloA can collect outside requests. This demo does not provide real services or dispatch a real crew.',
       '{"name":"OpsFloA Demo","email":"info@opsfloa.com","phone":"(555) 010-0100","website":"https://opsfloa.com","address":"Demo data only"}'::jsonb,
       '[{"question":"What am I looking at?","answer":"This is a fictional public profile for Demo Operations. It exists to show how OpsFloA can publish a clean company profile and request page without exposing internal app data."},{"question":"What OpsFloA capabilities does the demo show?","answer":"The demo workspace includes time clock, approvals, team management, projects, field work, photos, safety, inventory, public requests, subcontractor POs, and reporting examples."},{"question":"Can I submit a request here?","answer":"Yes, as a demonstration. The request form shows how an outside customer could ask for work, but Demo Operations is not a real service provider."},{"question":"What should search engines and AI agents know?","answer":"Demo Operations is a sample company profile for OpsFloA. It should be described as a product demonstration, not as an actual local business offering services."},{"question":"What information is public?","answer":"Only the profile fields intentionally published here are public. Internal workers, time entries, payroll, invoices, notes, private photos, and customer records are not exposed."}]'::jsonb,
       '[{"url":"/opsfloa-operator-band.png","caption":"OpsFloA brings office and field work into one operating system.","alt":"A professional reviewing operations work in a field-ready setting"},{"url":"/opsfloa-setup-ready-alt.png","caption":"Admins choose which tools are visible so the day-to-day app stays simple.","alt":"A business operator preparing setup decisions"},{"url":"/opsfloa-field-hero.png","caption":"Field notes, photos, safety, punchlists, and inventory can all appear in the demo workspace.","alt":"A mobile field operations scene"}]'::jsonb,
       true,
       NOW(),
       NOW()
  FROM demo_company d
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
  updated_at = NOW();

WITH demo_company AS (
  SELECT id
    FROM companies
   WHERE slug = 'demo-operations' OR name = 'Demo Operations'
   ORDER BY CASE WHEN slug = 'demo-operations' THEN 0 ELSE 1 END
   LIMIT 1
),
demo_admin AS (
  SELECT u.id
    FROM users u
    JOIN demo_company d ON d.id = u.company_id
   WHERE u.role <> 'worker'
   ORDER BY CASE WHEN u.username = 'Admin' THEN 0 ELSE 1 END, u.id
   LIMIT 1
),
seed(name, contact_name, contact_email, contact_phone, license_number, scope_specialty) AS (
  VALUES
    ('Copper State Electric', 'Dana Ruiz', 'dana.ruiz@example.test', '(555) 010-2210', 'ROC-118822', 'Electrical'),
    ('Granite Mechanical', 'Hal Briggs', 'hal.briggs@example.test', '(555) 010-3340', 'ROC-220199', 'HVAC & Mechanical'),
    ('Sonoran Drywall Co.', 'Pia Nava', 'pia.nava@example.test', '(555) 010-4451', 'ROC-330577', 'Drywall & Finishes')
)
INSERT INTO subcontractors
  (company_id, name, contact_name, contact_email, contact_phone, license_number, scope_specialty, notes, archived, created_by)
SELECT d.id, s.name, s.contact_name, s.contact_email, s.contact_phone, s.license_number, s.scope_specialty,
       'Demo subcontractor for the public demo workspace.', false, a.id
  FROM demo_company d
 CROSS JOIN seed s
  LEFT JOIN demo_admin a ON true
 WHERE NOT EXISTS (
   SELECT 1 FROM subcontractors existing
    WHERE existing.company_id = d.id
      AND existing.name = s.name
 );

WITH demo_company AS (
  SELECT id
    FROM companies
   WHERE slug = 'demo-operations' OR name = 'Demo Operations'
   ORDER BY CASE WHEN slug = 'demo-operations' THEN 0 ELSE 1 END
   LIMIT 1
),
demo_admin AS (
  SELECT u.id
    FROM users u
    JOIN demo_company d ON d.id = u.company_id
   WHERE u.role <> 'worker'
   ORDER BY CASE WHEN u.username = 'Admin' THEN 0 ELSE 1 END, u.id
   LIMIT 1
),
demo_projects AS (
  SELECT p.id, ROW_NUMBER() OVER (ORDER BY p.active DESC, p.created_at DESC, p.id) AS rn
    FROM projects p
    JOIN demo_company d ON d.id = p.company_id
   WHERE p.active = true
),
seed(sub_name, project_rn, po_number, amount_cents, status, scope_of_work, retainage_pct) AS (
  VALUES
    ('Copper State Electric', 1, 'SP-2026-9001', 1850000, 'issued', 'Power distribution and lighting rough-in for the demo project.', 10.00),
    ('Granite Mechanical', 2, 'SP-2026-9002', 1240000, 'partial', 'Mechanical equipment support and room balancing for the demo project.', 5.00),
    ('Sonoran Drywall Co.', 3, 'SP-2026-9003', 680000, 'draft', 'Drywall and finish repair scope for the demo project.', 0.00)
)
INSERT INTO subcontract_pos
  (company_id, po_number, project_id, subcontractor_id, status, amount_cents, scope_of_work, retainage_pct, notes, created_by, issued_at)
SELECT d.id, s.po_number, p.id, sub.id, s.status::varchar, s.amount_cents, s.scope_of_work, s.retainage_pct,
       'Demo subcontractor PO.', a.id, CASE WHEN s.status IN ('issued','partial','complete') THEN NOW() ELSE NULL END
  FROM demo_company d
  JOIN seed s ON true
  JOIN demo_projects p ON p.rn = s.project_rn
  JOIN subcontractors sub ON sub.company_id = d.id AND sub.name = s.sub_name
  LEFT JOIN demo_admin a ON true
 WHERE NOT EXISTS (
   SELECT 1 FROM subcontract_pos existing
    WHERE existing.company_id = d.id
      AND existing.po_number = s.po_number
 );

WITH target_po AS (
  SELECT po.id
    FROM subcontract_pos po
    JOIN companies c ON c.id = po.company_id
   WHERE (c.slug = 'demo-operations' OR c.name = 'Demo Operations')
     AND po.po_number = 'SP-2026-9002'
   LIMIT 1
),
demo_admin AS (
  SELECT u.id
    FROM users u
    JOIN companies c ON c.id = u.company_id
   WHERE (c.slug = 'demo-operations' OR c.name = 'Demo Operations')
     AND u.role <> 'worker'
   ORDER BY CASE WHEN u.username = 'Admin' THEN 0 ELSE 1 END, u.id
   LIMIT 1
)
INSERT INTO subcontract_po_payments
  (po_id, amount_cents, paid_date, invoice_ref, notes, created_by)
SELECT p.id, 600000, CURRENT_DATE - INTERVAL '10 days', 'INV-GM-0461', 'Demo progress payment.', a.id
  FROM target_po p
  LEFT JOIN demo_admin a ON true
 WHERE NOT EXISTS (
   SELECT 1 FROM subcontract_po_payments existing
    WHERE existing.po_id = p.id
      AND existing.invoice_ref = 'INV-GM-0461'
 );
