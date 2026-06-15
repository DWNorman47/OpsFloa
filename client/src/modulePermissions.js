/**
 * Maps each top-level module to the permissions that unlock it. A module
 * appears in the AppSwitcher iff:
 *   1. The company has its module_* feature toggle on (admin choice), AND
 *   2. The user has at least one of the perms in MODULE_PERMISSIONS[id], OR
 *   3. The module is in ALWAYS_VISIBLE_MODULES (Account).
 *
 * Why "any" rather than "all"? A user with just one relevant perm should
 * still get into the module — they'll see only the tabs/buttons they're
 * allowed to use (those are gated separately). Empty arrays mean "no
 * permissions can unlock this" (none currently use that, but defensive).
 *
 * Account is always visible regardless of perms — every authed user has a
 * profile, settings, password change.
 */

export const MODULE_PERMISSIONS = {
  // Time Clock = the participating page (clock-in, my timesheet, my schedule,
  // my time off, my expenses, messages). Both workers and admins use this.
  timeclock: [
    'clock_self', 'submit_time_entry_self',
    'edit_own_pending_entry', 'view_own_entries',
  ],
  // Workforce = the admin oversight page (Live, Approvals, Reports, etc.).
  // Admin-tier perms only — a user with no oversight perms doesn't see it.
  workforce: [
    'clock_in_others', 'edit_any_entry', 'approve_entries',
    'manage_pay_periods', 'view_workers_list',
  ],
  field: [
    'submit_field_reports', 'manage_punchlist', 'manage_rfis',
    'manage_safety_checklists', 'manage_equipment',
    'manage_incidents', 'manage_inspections',
  ],
  inventory: [
    'view_inventory', 'manage_inventory',
  ],
  team: [
    'view_workers_list', 'manage_workers', 'manage_roles', 'assign_roles',
  ],
  projects: [
    'view_projects', 'manage_projects', 'manage_project_visibility',
  ],
  administration: [
    'manage_settings', 'manage_advanced_settings', 'manage_integrations',
    'manage_billing', 'send_broadcast',
  ],
  analytics: [
    'view_analytics',
  ],
  // Sales = estimates + change orders + (eventually) templates + catalog picker.
  // Admin-tier: anyone authorised to manage projects can draft estimates;
  // sending and converting are gated server-side (and add stricter perms later).
  sales: [
    'manage_projects', 'manage_settings',
  ],
  // Subs = subcontractor directory + sub POs + payments. Procurement /
  // project management surface.
  subs: [
    'manage_projects', 'manage_settings',
  ],
  // Financial reports: P&L portfolio + WIP. Owner/admin reporting view.
  financial_reports: [
    'view_analytics', 'manage_settings',
  ],
};

// Modules every authenticated user can see in the app switcher, perms or not.
// /home remains routable, but is intentionally hidden until the home surface
// earns its place in the daily navigation again.
export const ALWAYS_VISIBLE_MODULES = new Set(['account']);

// Per-tab permission gates inside Administration (used by AdministrationPage).
// A tab is hidden if the user has none of its perms. Empty array = always visible.
export const ADMINISTRATION_TAB_PERMS = {
  company:      [], // company info — visible to everyone in the company
  account:      [], // own account — always
  settings:     ['manage_settings'],
  advanced:     ['manage_advanced_settings'],
  integrations: ['manage_integrations'],
  broadcast:    ['send_broadcast'],
};

/**
 * Determine the user's home/landing module — the first module in priority
 * order that they have access to. Always-available modules are last so a
 * user with any real access doesn't get dumped on Account by default.
 */
const LANDING_PRIORITY = [
  { id: 'timeclock',      path: '/timeclock' },      // participating (everyone starts here)
  { id: 'workforce',      path: '/workforce' },      // admin oversight
  { id: 'projects',       path: '/projects' },
  // 'sales' is intentionally not a landing target: it now lives as tabs inside
  // the Projects module (/sales redirects to /projects#estimates), and landing
  // there requires project perms — so routing a sales-only user to it would
  // bounce back here and loop.
  { id: 'subs',           path: '/subs' },
  { id: 'financial_reports', path: '/financial-reports' },
  { id: 'team',           path: '/team' },
  { id: 'field',          path: '/field' },
  { id: 'inventory',      path: '/inventory' },
  { id: 'analytics',      path: '/analytics' },
  { id: 'administration', path: '/administration' },
  { id: 'account',        path: '/account' },        // always-fallback
];

import { userHasAnyPerm } from './hooks/usePerm';

export function pickLandingPath(user) {
  if (!user) return '/login';
  for (const cand of LANDING_PRIORITY) {
    if (cand.id === 'account') return cand.path; // always-fallback
    const required = MODULE_PERMISSIONS[cand.id] || [];
    if (required.length === 0) continue;
    if (userHasAnyPerm(user, required)) return cand.path;
  }
  return '/account';
}

/**
 * Returns true iff the user can see the given module id, accounting for
 * always-visible modules and admin/worker role distinctions where the
 * AppSwitcher already filters (e.g. analytics is admin-only).
 */
export function userCanSeeModule(user, moduleId) {
  if (!user) return false;
  if (ALWAYS_VISIBLE_MODULES.has(moduleId)) return true;
  if (user.role === 'super_admin') return true;
  const required = MODULE_PERMISSIONS[moduleId];
  if (!required || required.length === 0) return false;
  return userHasAnyPerm(user, required);
}
