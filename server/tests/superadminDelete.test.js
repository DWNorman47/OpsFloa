/**
 * Tests for DELETE /superadmin/companies/:id — the company wipe handler.
 * Verifies the Stripe guard, 404 handling, and that every expected table
 * gets a DELETE statement in the happy path.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-unit-tests-only';

jest.mock('../db', () => {
  const query = jest.fn();
  const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };
  return { query, connect: jest.fn(() => Promise.resolve(mockClient)), __mockClient: mockClient };
});
jest.mock('../r2', () => ({ deleteByUrl: jest.fn(() => Promise.resolve()) }));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const r2 = require('../r2');

const superAdminToken = jwt.sign(
  { id: 1, role: 'super_admin', company_id: null, username: 'root' },
  process.env.JWT_SECRET
);

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/superadmin', require('../routes/superadmin'));
  return app;
}

const COMPANY_ID = '9fccf20b-8150-4e35-8e62-01d3c341628a';

beforeEach(() => {
  pool.query.mockReset();
  pool.__mockClient.query.mockReset();
  pool.__mockClient.release.mockReset();
  r2.deleteByUrl.mockReset();
});

describe('DELETE /superadmin/companies/:id', () => {
  test('returns 404 when company does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const res = await request(makeApp())
      .delete(`/api/superadmin/companies/${COMPANY_ID}`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(404);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('refuses delete when Stripe subscription is live', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ name: 'Acme', stripe_subscription_id: 'sub_abc', subscription_status: 'active' }],
    });
    const res = await request(makeApp())
      .delete(`/api/superadmin/companies/${COMPANY_ID}`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Cancel the Stripe subscription/);
    expect(res.body.stripe_subscription_id).toBe('sub_abc');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('allows delete when stripe_subscription_id is null', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ name: 'Acme', stripe_subscription_id: null, subscription_status: 'trial' }],
    });
    pool.__mockClient.query.mockResolvedValue({ rowCount: 0, rows: [] });
    const res = await request(makeApp())
      .delete(`/api/superadmin/companies/${COMPANY_ID}`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, name: 'Acme', media_files: 0 });
  });

  test('allows delete when subscription is canceled', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ name: 'Acme', stripe_subscription_id: 'sub_abc', subscription_status: 'canceled' }],
    });
    pool.__mockClient.query.mockResolvedValue({ rowCount: 0, rows: [] });
    const res = await request(makeApp())
      .delete(`/api/superadmin/companies/${COMPANY_ID}`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);
  });

  test('happy path: deletes from all expected tables in a transaction', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ name: 'Acme', stripe_subscription_id: null, subscription_status: 'trial' }],
    });
    pool.__mockClient.query.mockResolvedValue({ rowCount: 0, rows: [] });

    const res = await request(makeApp())
      .delete(`/api/superadmin/companies/${COMPANY_ID}`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);

    const sqls = pool.__mockClient.query.mock.calls.map(c => c[0]);

    // BEGIN / COMMIT bookend
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');

    // Every table we care about gets a DELETE statement
    const expectedTables = [
      'field_report_photos', 'entry_messages', 'equipment_hours', 'company_chat',
      'incident_reports', 'sub_reports', 'rfis', 'inspections', 'inspection_templates',
      'safety_checklist_submissions', 'safety_checklist_templates',
      'field_reports', 'daily_reports', 'punchlist_items', 'safety_talks',
      'time_entries', 'active_clock', 'pay_periods', 'shifts',
      'worker_documents', 'worker_availability', 'worker_fringes',
      'certified_payroll_signatures', 'time_off_requests', 'reimbursements',
      'inventory_transactions', 'inventory_cycle_counts', 'purchase_orders',
      'inventory_items', 'inventory_locations', 'inventory_suppliers',
      'project_documents', 'invoices', 'project_invoices',
      // Project sub-ledgers with ON DELETE RESTRICT on project_id — must be wiped
      // before `DELETE FROM projects` (else the whole wipe 500s).
      'subcontract_pos', 'subcontractors', 'lien_waivers', 'change_orders',
      'submittals', 'project_closeouts', 'project_expenses',
      'project_budget_categories', 'estimates',
      'service_requests', 'qbo_sync_errors', 'client_errors',
      'inbox', 'push_subscriptions', 'audit_log', 'equipment_items',
      // Booking module (0113): appointments FK RESTRICT to both users and
      // appointment_types, so it must be wiped before either.
      'appointments', 'appointment_types', 'shift_types', 'bookable_windows',
      'impersonation_log',
      'clients', 'projects', 'advanced_settings', 'settings',
      'role_permissions', 'users', 'roles', 'companies',
    ];
    for (const table of expectedTables) {
      const hit = sqls.some(sql => sql.includes(`FROM ${table}`) || sql.includes(`FROM ${table} `) || new RegExp(`DELETE FROM ${table}\\b`).test(sql));
      expect({ table, hit }).toEqual({ table, hit: true });
    }

    // The old typo — 'time_entry_comments' — must NOT appear
    expect(sqls.some(sql => /time_entry_comments/.test(sql))).toBe(false);

    // Inventory RESTRICT ordering: transactions deleted BEFORE items
    const txnIdx   = sqls.findIndex(sql => /DELETE FROM inventory_transactions\b/.test(sql));
    const itemsIdx = sqls.findIndex(sql => /DELETE FROM inventory_items\b/.test(sql));
    expect(txnIdx).toBeGreaterThan(-1);
    expect(itemsIdx).toBeGreaterThan(-1);
    expect(txnIdx).toBeLessThan(itemsIdx);

    // projects RESTRICT ordering: the sub-ledgers (and subcontract_pos before
    // subcontractors) must be deleted BEFORE projects.
    const idxOf = re => sqls.findIndex(sql => re.test(sql));
    const projIdx = idxOf(/DELETE FROM projects\b/);
    const poIdx   = idxOf(/DELETE FROM subcontract_pos\b/);
    const subsIdx = idxOf(/DELETE FROM subcontractors\b/);
    expect(poIdx).toBeGreaterThan(-1);
    expect(poIdx).toBeLessThan(subsIdx);      // subcontract_pos before subcontractors
    for (const re of [/DELETE FROM subcontract_pos\b/, /DELETE FROM lien_waivers\b/, /DELETE FROM change_orders\b/, /DELETE FROM submittals\b/, /DELETE FROM project_closeouts\b/, /DELETE FROM project_expenses\b/, /DELETE FROM project_budget_categories\b/]) {
      expect(idxOf(re)).toBeLessThan(projIdx); // all RESTRICT sub-ledgers before projects
    }

    // cycle_counts before items (cycle_count_lines RESTRICT-ref items)
    const ccIdx = sqls.findIndex(sql => /DELETE FROM inventory_cycle_counts\b/.test(sql));
    expect(ccIdx).toBeLessThan(itemsIdx);

    // Booking RESTRICT ordering: appointments.assigned_user_id and
    // .appointment_type_id are both ON DELETE RESTRICT, so appointments must be
    // wiped before users AND before appointment_types.
    const apptIdx      = idxOf(/DELETE FROM appointments\b/);
    const apptTypesIdx = idxOf(/DELETE FROM appointment_types\b/);
    const usersIdx     = idxOf(/DELETE FROM users\b/);
    expect(apptIdx).toBeGreaterThan(-1);
    expect(apptIdx).toBeLessThan(usersIdx);
    expect(apptIdx).toBeLessThan(apptTypesIdx);

    // roles after users (users.role_id references roles)
    const rolesIdx = idxOf(/DELETE FROM roles\b/);
    expect(rolesIdx).toBeGreaterThan(-1);
    expect(usersIdx).toBeLessThan(rolesIdx);

    // companies last
    const compIdx = sqls.findIndex(sql => /DELETE FROM companies\b/.test(sql));
    expect(compIdx).toBeGreaterThan(itemsIdx);

    // Transaction released
    expect(pool.__mockClient.release).toHaveBeenCalled();
  });

  test('rolls back on mid-transaction failure and releases the client', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ name: 'Acme', stripe_subscription_id: null, subscription_status: 'trial' }],
    });
    // URL collection queries are wrapped in try/catch (so a missing table
    // doesn't abort the whole delete). Force the failure on a real DELETE —
    // e.g. DELETE FROM time_entries — to simulate a bad migration or
    // unexpected FK problem mid-transaction.
    pool.__mockClient.query.mockImplementation((sql) => {
      if (/DELETE FROM time_entries\b/.test(sql)) return Promise.reject(new Error('fake db failure'));
      return Promise.resolve({ rows: [] });
    });

    const res = await request(makeApp())
      .delete(`/api/superadmin/companies/${COMPANY_ID}`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(500);

    const sqls = pool.__mockClient.query.mock.calls.map(c => c[0]);
    expect(sqls).toContain('ROLLBACK');
    expect(pool.__mockClient.release).toHaveBeenCalled();
  });

  test('collects media URLs from both scalar and JSONB columns', async () => {
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ name: 'Acme', stripe_subscription_id: null, subscription_status: 'trial' }],
    });
    // Respond to every query with no rows except the URL harvests
    pool.__mockClient.query.mockImplementation((sql) => {
      if (/reimbursements.*receipt_url/.test(sql))  return Promise.resolve({ rows: [{ url: 'https://r2/receipt1.jpg' }] });
      if (/jsonb_array_elements_text.*inventory_locations/.test(sql))
        return Promise.resolve({ rows: [{ url: 'https://r2/loc1.jpg' }, { url: 'https://r2/loc2.jpg' }] });
      if (/jsonb_array_elements_text.*service_requests/.test(sql))
        return Promise.resolve({ rows: [{ url: 'https://r2/svc1.jpg' }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await request(makeApp())
      .delete(`/api/superadmin/companies/${COMPANY_ID}`)
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.media_files).toBe(4);
  });
});
