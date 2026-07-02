/**
 * Shared helpers for the smoke test suite.
 *
 * Provides:
 *  - renderWithProviders(ui, { user, route }) — wraps a component in the
 *    same provider stack the real app uses (Router + Auth + Toast + Offline),
 *    with fakeable auth so tests can render as worker / admin / super_admin.
 *  - makeUser(role) — small factories for common user shapes.
 *  - DEFAULT_SETTINGS — a complete settings object that satisfies every
 *    settings?.feature_* / settings?.module_* check in the app.
 *
 * The api module and offlineDb are mocked globally inside smoke.test.jsx
 * (vi.mock hoists, so can't live here).
 */

import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext } from '../contexts/AuthContext';
import { ToastProvider } from '../contexts/ToastContext';
import { OfflineContext } from '../contexts/OfflineContext';

// Default permission sets for each role so tests don't have to spell them
// out every time. Pass `permissions: [...]` in overrides to test specific
// permission combos (notably the empty-set "zero-perm user" case).
const DEFAULT_PERMS_BY_ROLE = {
  worker: [
    'clock_self', 'submit_time_entry_self',
    'edit_own_pending_entry', 'view_own_entries', 'view_projects',
    'submit_reimbursement_self', 'view_own_reimbursements',
    'submit_field_reports', 'manage_punchlist', 'manage_rfis',
    'manage_safety_checklists', 'manage_equipment', 'manage_incidents',
    'manage_inspections', 'view_inventory',
    'view_company_chat', 'send_company_chat',
  ],
  admin: [
    // Worker baseline + admin tier minus Owner-only
    'clock_self', 'submit_time_entry_self',
    'edit_own_pending_entry', 'view_own_entries', 'view_projects',
    'submit_reimbursement_self', 'view_own_reimbursements',
    'submit_field_reports', 'manage_punchlist', 'manage_rfis',
    'manage_safety_checklists', 'manage_equipment', 'manage_incidents',
    'manage_inspections', 'view_inventory', 'view_company_chat',
    'send_company_chat',
    'clock_in_others', 'edit_any_entry', 'approve_entries',
    'manage_pay_periods', 'view_workers_list', 'view_worker_wages',
    'manage_workers', 'assign_roles',
    'manage_projects', 'manage_project_visibility',
    'view_reports', 'view_analytics', 'view_certified_payroll', 'export_data',
    'manage_reimbursements', 'manage_settings', 'manage_advanced_settings',
    'manage_integrations', 'send_broadcast', 'manage_inventory',
  ],
  super_admin: [], // unused — useAuth short-circuits on role === 'super_admin'
};

export function makeUser(role = 'worker', overrides = {}) {
  return {
    id: 1,
    full_name: 'Test User',
    username: 'test',
    email: 'test@example.com',
    language: 'English',
    role,
    company_id: 1,
    company_name: 'Test Co',
    subscription_status: 'trial',
    plan: 'starter',
    admin_permissions: null,
    worker_access_ids: null,
    role_id: role === 'worker' ? 1 : role === 'admin' ? 2 : null,
    permissions: DEFAULT_PERMS_BY_ROLE[role] || [],
    ...overrides,
  };
}

const FAKE_AUTH_VALUE = {
  user: null,
  loading: false,
  login: () => Promise.resolve(null),
  loginWithToken: () => Promise.resolve(null),
  confirmMfa: () => Promise.resolve(null),
  logout: () => {},
  updateUser: () => {},
  firstLogin: false,
  clearFirstLogin: () => {},
};

const FAKE_OFFLINE_VALUE = {
  isOffline: false,
  queueCount: 0,
  sendToSW: () => {},
  onSync: () => () => {},
};

// Variant for the offline-mode smoke tests — flips isOffline true and
// reports a queued count so OfflineBanner / queued-state UI is exercised.
export const OFFLINE_VALUE = {
  isOffline: true,
  queueCount: 3,
  sendToSW: () => {},
  onSync: () => () => {},
};

export const DEFAULT_SETTINGS = {
  module_timeclock: true,
  module_field: true,
  module_projects: true,
  module_inventory: false,
  module_tools: true,
  module_analytics: true,
  module_team: true,
  feature_scheduling: true,
  feature_analytics: true,
  feature_chat: true,
  feature_prevailing_wage: true,
  feature_reimbursements: true,
  feature_pto: true,
  feature_project_integration: true,
  feature_overtime: true,
  feature_geolocation: false,
  feature_inactive_alerts: true,
  feature_overtime_alerts: true,
  feature_broadcast: true,
  feature_media_gallery: false,
  show_worker_wages: true,
  currency: 'USD',
  overtime_threshold: 8,
  overtime_rule: 'daily',
  overtime_multiplier: 1.5,
  week_start: 0,
  default_hourly_rate: 20,
  prevailing_wage_rate: 30,
  notification_use_work_hours: false,
  notification_start_hour: 6,
  notification_end_hour: 20,
  company_timezone: 'America/Los_Angeles',
};

export function renderWithProviders(ui, { user = null, route = '/', offlineValue } = {}) {
  const authValue = { ...FAKE_AUTH_VALUE, user };
  const offline = offlineValue || FAKE_OFFLINE_VALUE;
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthContext.Provider value={authValue}>
        <ToastProvider>
          <OfflineContext.Provider value={offline}>
            {ui}
          </OfflineContext.Provider>
        </ToastProvider>
      </AuthContext.Provider>
    </MemoryRouter>
  );
}
