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
  // Booking is admin scheduling/configuration. It reuses workforce-style
  // oversight permissions plus settings access for companies where office
  // staff manage availability without approving time.
  booking: [
    'clock_in_others', 'edit_any_entry', 'approve_entries',
    'manage_pay_periods', 'view_workers_list', 'manage_settings',
  ],
  field: [
    'submit_field_reports', 'manage_punchlist', 'manage_rfis',
    'manage_safety_checklists', 'manage_equipment',
    'manage_incidents', 'manage_inspections',
  ],
  inventory: [
    'view_inventory', 'manage_inventory',
  ],
  // Directory (module id stays 'team') now hosts Team, Subs, Customers, and
  // Roles. Unlock it for anyone who can manage ANY of those, so a customer/sub
  // manager isn't locked out just because they lack worker perms. (Sub and
  // customer writes are admin-gated server-side; manage_projects/manage_settings
  // are the closest proxies a non-default admin role would carry.)
  team: [
    'view_workers_list', 'manage_workers', 'manage_roles', 'assign_roles',
    'manage_projects', 'manage_settings',
  ],
  projects: [
    'view_projects', 'manage_projects', 'manage_project_visibility',
  ],
  // Tools = standalone utility calculators and helpers. Start with the
  // excavation takeoff tool, so project/settings access is the right gate.
  tools: [
    'view_projects', 'manage_projects', 'manage_settings',
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
export const ALWAYS_VISIBLE_MODULES = new Set(['account', 'help']);

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
// `adminOnly` marks a candidate whose ROUTE is admin-gated (App.jsx). Landing a
// non-admin there would bounce off the route guard — and could loop — so
// pickLandingPath skips those for non-admins even if they hold a matching perm.
const LANDING_PRIORITY = [
  { id: 'timeclock',      path: '/timeclock' },      // participating + Workforce group (everyone starts here)
  // 'workforce' is the Workforce group of Time Clock now (/workforce redirects),
  // so it's not a separate landing target. Its perm set still gates that group.
  { id: 'projects',       path: '/work', adminOnly: true },
  // 'sales' and 'subs' are intentionally not landing targets: they now live as
  // tabs inside other modules (Projects / Directory) and their old routes
  // redirect there, so landing on them directly could bounce and loop.
  { id: 'financial_reports', path: '/financial-reports', adminOnly: true },
  { id: 'team',           path: '/team' },
  { id: 'field',          path: '/field' },
  { id: 'inventory',      path: '/inventory' },
  // 'analytics' folded into Reports (Performance tab); /analytics redirects there.
  { id: 'administration', path: '/administration', adminOnly: true },
  { id: 'account',        path: '/account' },        // always-fallback
];

import { userHasAnyPerm } from './hooks/usePerm';

export function pickLandingPath(user) {
  if (!user) return '/login';
  const isAdmin = user.role === 'admin' || user.role === 'super_admin';
  for (const cand of LANDING_PRIORITY) {
    if (cand.id === 'account') return cand.path; // always-fallback
    // Never route a non-admin to an admin-only page — its guard would bounce
    // them straight back here, and with a cross-path bounce that loops forever.
    if (cand.adminOnly && !isAdmin) continue;
    // Time Clock also lands an oversight-only user (workforce perms, no personal
    // clock perms) — the page hosts the Workforce group.
    const required = cand.id === 'timeclock'
      ? [...MODULE_PERMISSIONS.timeclock, ...MODULE_PERMISSIONS.workforce]
      : (MODULE_PERMISSIONS[cand.id] || []);
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

/**
 * Whether the Time Clock APP (switcher entry / landing target) is reachable.
 * Time Clock now hosts the Workforce oversight group, so it must stay visible
 * for anyone with participating time perms OR workforce perms — otherwise an
 * oversight-only role (no personal clock perms) loses access to Workforce.
 * (userCanSeeModule stays scoped to a single module's own perms because the
 * Dashboard relies on that to tell the Personal vs Workforce groups apart.)
 */
export function canSeeTimeclockApp(user) {
  return userCanSeeModule(user, 'timeclock') || userCanSeeModule(user, 'workforce');
}
