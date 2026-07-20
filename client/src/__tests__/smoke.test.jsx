/**
 * Smoke tests — mount every page with a mocked provider stack and assert
 * the initial render doesn't throw. Catches ReferenceErrors, missing props,
 * bad imports, and "useHook called at top level but context is null" bugs
 * that slip past the type checker and manual QA (e.g. ProjectCard forgot
 * useT, Thread referenced locale that was out of scope).
 *
 * Not meant to verify behavior — just that each page boots without crashing
 * with a reasonable user + mocked API. For behavior tests, add focused
 * tests next to the component.
 *
 * When a page has meaningfully different worker vs admin rendering, render
 * both. When a page hits APIs on mount, those are stubbed to return empty
 * arrays / objects so the page reaches a stable initial state.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { renderWithProviders, makeUser, DEFAULT_SETTINGS, OFFLINE_VALUE } from './test-helpers';

// ── Global mocks ──────────────────────────────────────────────────────────────
// Every page hits the network on mount. Return benign empty responses so
// render completes without effect-thrown errors. Individual tests can
// override if a specific page needs populated data.

vi.mock('../api', () => {
  const ok = (data) => Promise.resolve({ data, status: 200 });
  const api = {
    get: vi.fn(() => ok([])),
    post: vi.fn(() => ok({})),
    patch: vi.fn(() => ok({})),
    put: vi.fn(() => ok({})),
    delete: vi.fn(() => ok({})),
  };
  return {
    default: api,
    setApiToastHandler: vi.fn(),
  };
});

vi.mock('../offlineDb', () => ({
  getOrFetch: vi.fn((_key, fetchFn) => (fetchFn ? fetchFn() : Promise.resolve(null))),
  setCached: vi.fn(),
  getCached: vi.fn(() => Promise.resolve(null)),
  clearCache: vi.fn(() => Promise.resolve()),
  invalidateCache: vi.fn(() => Promise.resolve()),
}));

// errorReporter uses navigator.sendBeacon which jsdom may not implement
vi.mock('../errorReporter', () => ({
  reportClientError: vi.fn(),
  silentError: () => () => {},
}));

// ── Per-test setup ────────────────────────────────────────────────────────────

beforeEach(() => {
  // Reset URL between tests so hash-based tab selection doesn't bleed
  window.history.replaceState(null, '', '/');
});

/**
 * Render a page and let initial effects settle. Any synchronous render
 * throw or error-boundary trip is caught by Vitest and fails the test.
 * A separate check for the ErrorBoundary fallback text catches cases where
 * the component throws inside an effect that's synchronously awaited.
 */
async function smokeRender(ui, opts) {
  let view;
  await act(async () => {
    view = renderWithProviders(ui, opts);
  });
  // If ErrorBoundary caught something, surface as a failure with any stack
  // detail. Covers both:
  //  - top-level fallback ("Something went wrong" / "Algo salió mal")
  //  - inline fallback ("{label} crashed" / "Section crashed" / "... crashed")
  // Inline fallbacks silently hide a child crash behind a small card; without
  // this assertion, a page-level smoke test would pass even though a whole
  // tab of the UI is broken.
  const topLevelFallback = view.queryByText(/Something went wrong|Algo salió mal/i);
  const inlineFallback = view.queryByText(/\bcrashed\b|\bse bloqueó\b/i);
  if (topLevelFallback || inlineFallback) {
    const details = view.container.querySelector('pre')?.textContent || '(no stack visible)';
    const which = topLevelFallback ? 'Top-level' : 'Inline';
    throw new Error(`${which} ErrorBoundary tripped during render:\n${details}`);
  }
  return view;
}

// ── Unauthenticated pages ─────────────────────────────────────────────────────

describe('smoke: unauthenticated pages', () => {
  test('Login', async () => {
    const { default: Login } = await import('../pages/Login');
    await smokeRender(<Login />);
  });

  test('Register', async () => {
    const { default: Register } = await import('../pages/Register');
    await smokeRender(<Register />);
  });

  test('ForgotPassword', async () => {
    const { default: ForgotPassword } = await import('../pages/ForgotPassword');
    await smokeRender(<ForgotPassword />);
  });

  test('ResetPassword', async () => {
    const { default: ResetPassword } = await import('../pages/ResetPassword');
    await smokeRender(<ResetPassword />);
  });

  test('AcceptInvite', async () => {
    const { default: AcceptInvite } = await import('../pages/AcceptInvite');
    await smokeRender(<AcceptInvite />);
  });

  test('ConfirmEmail', async () => {
    const { default: ConfirmEmail } = await import('../pages/ConfirmEmail');
    await smokeRender(<ConfirmEmail />);
  });

  test('Landing', async () => {
    const { default: Landing } = await import('../pages/Landing');
    await smokeRender(<Landing />);
  });

  test('PrivacyPolicy', async () => {
    const { default: PrivacyPolicy } = await import('../pages/PrivacyPolicy');
    await smokeRender(<PrivacyPolicy />);
  });

  test('EULA', async () => {
    const { default: EULA } = await import('../pages/EULA');
    await smokeRender(<EULA />);
  });

  test('Changelog', async () => {
    const { default: Changelog } = await import('../pages/Changelog');
    await smokeRender(<Changelog />);
  });

  test('ServiceRequest', async () => {
    const { default: ServiceRequest } = await import('../pages/ServiceRequest');
    await smokeRender(<ServiceRequest />);
  });
});

// ── Worker-facing pages (per language) ───────────────────────────────────────
// Loop over English + Spanish so missing i18n keys (t.foo === undefined) are
// caught here. A missing key often renders as blank in JSX but crashes when
// concatenated into a string, used as a prop, or passed to .replace/.split.

describe.each([['English'], ['Spanish']])('smoke: worker pages (%s)', (language) => {
  const worker = makeUser('worker', { language });

  test('Dashboard', async () => {
    const { default: Dashboard } = await import('../pages/Dashboard');
    await smokeRender(<Dashboard />, { user: worker });
  });

  test('AccountPage', async () => {
    const { default: AccountPage } = await import('../pages/AccountPage');
    await smokeRender(<AccountPage />, { user: worker });
  });

  test('FieldPage', async () => {
    const { default: FieldPage } = await import('../pages/FieldPage');
    await smokeRender(<FieldPage />, { user: worker });
  });

  test('InventoryPage', async () => {
    const { default: InventoryPage } = await import('../pages/InventoryPage');
    await smokeRender(<InventoryPage />, { user: worker });
  });

  test('TeamPage', async () => {
    const { default: TeamPage } = await import('../pages/TeamPage');
    await smokeRender(<TeamPage />, { user: worker });
  });
});

// ── Admin-facing pages (per language) ────────────────────────────────────────

describe.each([['English'], ['Spanish']])('smoke: admin pages (%s)', (language) => {
  const admin = makeUser('admin', { language });

  test('AdminDashboard', async () => {
    const { WorkforcePanel } = await import('../pages/AdminDashboard');
    await smokeRender(<WorkforcePanel />, { user: admin });
  });

  test('AdministrationPage', async () => {
    const { default: AdministrationPage } = await import('../pages/AdministrationPage');
    await smokeRender(<AdministrationPage />, { user: admin });
  });

  test('Reports — Performance tab (Analytics)', async () => {
    const api = (await import('../api')).default;
    // Analytics dashboard destructures { summary, daily_hours, ... } from the
    // response — a bare [] would crash it. Return a minimal valid shape.
    api.get.mockImplementation((url) => {
      if (url.startsWith('/admin/analytics') || url.startsWith('/analytics')) {
        return Promise.resolve({ data: {
          summary: {
            hours_this_week: 0, hours_this_month: 0,
            active_workers_this_week: 0, active_workers_this_month: 0,
            pending_entries: 0, overtime_hours_this_week: 0,
          },
          daily_hours: [],
          weekly_hours: [],
          project_hours: [],
          worker_hours: [],
        }});
      }
      return Promise.resolve({ data: [] });
    });
    // Analytics lives as the Performance tab of the Reports module now.
    // Business plan so the dashboard (not the upgrade prompt) renders.
    const { default: FinancialReportsPage } = await import('../pages/FinancialReportsPage');
    await smokeRender(<FinancialReportsPage />, { user: makeUser('admin', { plan: 'business' }) });
  });

  test('ProjectsPage', async () => {
    const { default: ProjectsPage } = await import('../pages/ProjectsPage');
    await smokeRender(<ProjectsPage />, { user: admin });
  });

  test('TeamPage', async () => {
    const { default: TeamPage } = await import('../pages/TeamPage');
    await smokeRender(<TeamPage />, { user: admin });
  });

  test('FieldPage', async () => {
    const { default: FieldPage } = await import('../pages/FieldPage');
    await smokeRender(<FieldPage />, { user: admin });
  });

  test('InventoryPage', async () => {
    const { default: InventoryPage } = await import('../pages/InventoryPage');
    await smokeRender(<InventoryPage />, { user: admin });
  });
});

// ── Dashboard variants with populated data ────────────────────────────────────
// The empty-response mocks above catch top-level import/render errors but
// miss bugs inside conditionally-rendered sub-components (e.g. ProjectCard
// only renders when there are projects). These targeted tests feed each
// list view enough data to exercise the item-renderer path.

describe('smoke: FieldPage hash routes', () => {
  const fieldSettings = {
    ...DEFAULT_SETTINGS,
    feature_media_gallery: true,
    module_inventory: true,
    label_worker: 'Team Member',
  };
  const projects = [{ id: 1, name: 'Demo Work', job_number: 'DW-1' }];
  const pagedEmpty = { items: [], pages: 1, total: 0 };

  test.each([
    'notes',
    'daily',
    'reports',
    'gallery',
    'punchlist',
    'incidents',
    'incident',
    'rfi',
    'rfis',
    'safety',
    'checklists',
    'inspect',
    'equipment',
    'equip',
    'subs',
  ])('FieldPage boots at #%s', async (hash) => {
    const api = (await import('../api')).default;
    api.get.mockImplementation((url) => {
      if (url.startsWith('/settings')) return Promise.resolve({ data: fieldSettings });
      if (url === '/work' || url.startsWith('/projects')) return Promise.resolve({ data: projects });
      if (url.startsWith('/field-reports/photos')) return Promise.resolve({ data: pagedEmpty });
      if (url.startsWith('/field-reports')) return Promise.resolve({ data: pagedEmpty });
      if (url.startsWith('/daily-reports')) return Promise.resolve({ data: pagedEmpty });
      if (url.startsWith('/incidents')) return Promise.resolve({ data: pagedEmpty });
      if (url.startsWith('/rfis')) return Promise.resolve({ data: pagedEmpty });
      if (url.startsWith('/sub-reports')) return Promise.resolve({ data: pagedEmpty });
      if (url.startsWith('/equipment')) return Promise.resolve({ data: [] });
      if (url.startsWith('/safety-talks')) return Promise.resolve({ data: pagedEmpty });
      if (url.startsWith('/safety-checklists')) return Promise.resolve({ data: [] });
      if (url.startsWith('/inspections')) return Promise.resolve({ data: pagedEmpty });
      if (url.startsWith('/company-info')) return Promise.resolve({ data: { name: 'Test Co' } });
      return Promise.resolve({ data: [] });
    });
    window.history.replaceState(null, '', `/field#${hash}`);
    const { default: FieldPage } = await import('../pages/FieldPage');
    await smokeRender(<FieldPage />, { user: makeUser('admin') });
  });
});

describe('smoke: populated list views (catches sub-component bugs)', () => {
  test('TeamPage Directory renders with multiple members', async () => {
    const api = (await import('../api')).default;
    const team = [
      { id: 1, full_name: 'Alice Admin', username: 'alice', role: 'admin', worker_type: null, classification: null, must_change_password: false },
      { id: 2, full_name: 'Bob Worker', username: 'bob', role: 'worker', worker_type: 'employee', classification: 'Electrician', must_change_password: false },
      { id: 3, full_name: 'Carol Contractor', username: 'carol', role: 'worker', worker_type: 'contractor', classification: null, must_change_password: true },
    ];
    api.get.mockImplementation((url) => {
      if (url.startsWith('/team')) return Promise.resolve({ data: { team } });
      return Promise.resolve({ data: [] });
    });
    const { default: TeamPage } = await import('../pages/TeamPage');
    await smokeRender(<TeamPage />, { user: makeUser('worker') });
  });

  test('Dashboard (worker) renders with entries + projects populated', async () => {
    const api = (await import('../api')).default;
    const projects = [
      { id: 10, name: 'Main Site', active: true, wage_type: 'regular' },
      { id: 11, name: 'Annex', active: true, wage_type: 'prevailing' },
    ];
    const entries = [
      { id: 1, project_id: 10, project_name: 'Main Site', work_date: '2026-04-22', start_time: '08:00:00', end_time: '16:30:00', break_minutes: 30, status: 'pending', wage_type: 'regular', notes: '' },
      { id: 2, project_id: 11, project_name: 'Annex', work_date: '2026-04-21', start_time: '09:00:00', end_time: '17:00:00', break_minutes: 30, status: 'approved', wage_type: 'prevailing', notes: 'Footings' },
    ];
    api.get.mockImplementation((url) => {
      if (url.startsWith('/time-entries')) return Promise.resolve({ data: entries });
      if (url === '/work' || url.startsWith('/projects')) return Promise.resolve({ data: projects });
      if (url.startsWith('/settings')) return Promise.resolve({ data: DEFAULT_SETTINGS });
      if (url.startsWith('/clock/status')) return Promise.resolve({ data: null });
      return Promise.resolve({ data: [] });
    });
    const { default: Dashboard } = await import('../pages/Dashboard');
    await smokeRender(<Dashboard />, { user: makeUser('worker') });
  });

  test('TeamPage Roles tab (admin) renders with built-in roles populated', async () => {
    const api = (await import('../api')).default;
    const builtins = [
      { id: 1, name: 'Worker', is_builtin: true, parent_role: 'worker', user_count: 5, permission_count: 18, description: 'Standard worker' },
      { id: 2, name: 'Admin',  is_builtin: true, parent_role: 'admin',  user_count: 2, permission_count: 38, description: 'Company admin' },
      { id: 3, name: 'Owner',  is_builtin: true, parent_role: 'admin',  user_count: 1, permission_count: 41, description: 'Company owner' },
    ];
    api.get.mockImplementation((url) => {
      if (url.startsWith('/admin/roles') && !url.match(/\/admin\/roles\/\d/)) return Promise.resolve({ data: builtins });
      if (url.startsWith('/admin/permissions/catalog')) return Promise.resolve({ data: [
        { key: 'approve_entries', group: 'time', label: 'Approve entries' },
        { key: 'manage_billing',  group: 'money', label: 'Manage billing' },
      ]});
      if (url.startsWith('/team')) return Promise.resolve({ data: { team: [] } });
      return Promise.resolve({ data: [] });
    });
    window.location.hash = '#roles';
    const { default: TeamPage } = await import('../pages/TeamPage');
    await smokeRender(<TeamPage />, { user: makeUser('admin') });
  });

  test('AdminDashboard renders with KPIs + active clocks + pending entries', async () => {
    const api = (await import('../api')).default;
    const workers = [
      { id: 20, full_name: 'Alice Admin', username: 'alice', role: 'admin', active: true, hourly_rate: 40, rate_type: 'hourly' },
      { id: 21, full_name: 'Bob Worker', username: 'bob', role: 'worker', active: true, hourly_rate: 25, rate_type: 'hourly', worker_type: 'employee' },
    ];
    const projects = [{ id: 30, name: 'Main Site', active: true, wage_type: 'regular' }];
    const activeClocks = [{ user_id: 21, full_name: 'Bob Worker', project_id: 30, project_name: 'Main Site', clock_in_time: '2026-04-22T14:00:00Z' }];
    const pendingEntries = [
      { id: 100, user_id: 21, user_name: 'Bob Worker', project_id: 30, project_name: 'Main Site', work_date: '2026-04-21', start_time: '08:00:00', end_time: '16:00:00', break_minutes: 30, status: 'pending', wage_type: 'regular' },
    ];
    api.get.mockImplementation((url) => {
      if (url.startsWith('/admin/kpis')) return Promise.resolve({ data: { pending_entries: 1, clocked_in: 1, hours_this_week: 40 } });
      if (url.startsWith('/admin/workers')) return Promise.resolve({ data: workers });
      if (url.startsWith('/admin/projects')) return Promise.resolve({ data: projects });
      if (url === '/work' || url.startsWith('/projects')) return Promise.resolve({ data: projects });
      if (url.startsWith('/admin/entries/pending') || url.startsWith('/admin/entries/recently-approved')) return Promise.resolve({ data: pendingEntries });
      if (url.startsWith('/admin/active-clocks')) return Promise.resolve({ data: activeClocks });
      if (url.startsWith('/admin/settings')) return Promise.resolve({ data: DEFAULT_SETTINGS });
      if (url.startsWith('/settings')) return Promise.resolve({ data: DEFAULT_SETTINGS });
      return Promise.resolve({ data: [] });
    });
    const { WorkforcePanel } = await import('../pages/AdminDashboard');
    await smokeRender(<WorkforcePanel />, { user: makeUser('admin') });
  });

  test('ProjectsPage renders at least one ProjectCard (admin)', async () => {
    const api = (await import('../api')).default;
    const project = {
      id: 1,
      name: 'Test Project',
      client_name: 'ACME',
      job_number: 'J-1',
      status: 'in_progress',
      wage_type: 'regular',
      budget_hours: 100,
      budget_dollars: 10000,
      progress_pct: 50,
      active: true,
      start_date: '2026-01-01',
      end_date: '2026-06-01',
    };
    const metrics = { [project.id]: { total_hours: 40, worker_count: 3, overtime_hours: 0 } };
    api.get.mockImplementation((url) => {
      if (url === '/work' || url.startsWith('/projects')) return Promise.resolve({ data: [project] });
      if (url.startsWith('/project-metrics')) return Promise.resolve({ data: metrics });
      if (url.startsWith('/settings')) return Promise.resolve({ data: DEFAULT_SETTINGS });
      return Promise.resolve({ data: [] });
    });
    const { default: ProjectsPage } = await import('../pages/ProjectsPage');
    const view = await smokeRender(<ProjectsPage />, { user: makeUser('admin') });
    // Force an extra tick so the project list effect resolves and ProjectCard renders
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(view).toBeTruthy();
  });
});

// ── Offline mode ─────────────────────────────────────────────────────────────
// Render core pages with isOffline=true so the OfflineBanner / queued-state
// UI paths are exercised. These paths are easy to break — e.g. a component
// reading queueCount could TypeError if it expected a number but got
// undefined when destructuring useOffline().

describe('smoke: offline mode', () => {
  test('Dashboard (worker, offline)', async () => {
    const { default: Dashboard } = await import('../pages/Dashboard');
    await smokeRender(<Dashboard />, { user: makeUser('worker'), offlineValue: OFFLINE_VALUE });
  });

  test('AdminDashboard (admin, offline)', async () => {
    const { WorkforcePanel } = await import('../pages/AdminDashboard');
    await smokeRender(<WorkforcePanel />, { user: makeUser('admin'), offlineValue: OFFLINE_VALUE });
  });

  test('FieldPage (worker, offline)', async () => {
    const { default: FieldPage } = await import('../pages/FieldPage');
    await smokeRender(<FieldPage />, { user: makeUser('worker'), offlineValue: OFFLINE_VALUE });
  });
});

// ── API error states ─────────────────────────────────────────────────────────
// When the API rejects (500, network error, timeout), pages should show an
// error UI instead of crashing. These tests reject every request and assert
// the page still renders without tripping the ErrorBoundary. Catches
// missing try/catch around .then chains, components that assume responses
// always resolve, and silently-thrown promises.

describe('smoke: API error states', () => {
  beforeEach(async () => {
    const api = (await import('../api')).default;
    const fail = () => Promise.reject(Object.assign(new Error('mock 500'), {
      response: { status: 500, data: { error: 'mock 500' } },
    }));
    api.get.mockImplementation(fail);
    api.post.mockImplementation(fail);
    api.patch.mockImplementation(fail);
    api.put.mockImplementation(fail);
    api.delete.mockImplementation(fail);
  });

  test('Dashboard (worker, all requests reject)', async () => {
    const { default: Dashboard } = await import('../pages/Dashboard');
    await smokeRender(<Dashboard />, { user: makeUser('worker') });
  });

  test('AdminDashboard (admin, all requests reject)', async () => {
    const { WorkforcePanel } = await import('../pages/AdminDashboard');
    await smokeRender(<WorkforcePanel />, { user: makeUser('admin') });
  });

  test('ProjectsPage (admin, all requests reject)', async () => {
    const { default: ProjectsPage } = await import('../pages/ProjectsPage');
    await smokeRender(<ProjectsPage />, { user: makeUser('admin') });
  });

  test('TeamPage (admin, all requests reject)', async () => {
    const { default: TeamPage } = await import('../pages/TeamPage');
    await smokeRender(<TeamPage />, { user: makeUser('admin') });
  });

  test('Reports (admin, all requests reject)', async () => {
    const { default: FinancialReportsPage } = await import('../pages/FinancialReportsPage');
    await smokeRender(<FinancialReportsPage />, { user: makeUser('admin') });
  });
});

// ── Phase D: zero-permission user ────────────────────────────────────────────
// A worker assigned to a custom role with NO permissions should still be
// able to render their AccountPage (always-visible) and the AppHeader
// (which contains the AppSwitcher) without crashing. Modules they have
// no perms for must not appear in the switcher.

describe('smoke: zero-permission user', () => {
  test('AccountPage renders for a user with no permissions', async () => {
    const { default: AccountPage } = await import('../pages/AccountPage');
    await smokeRender(<AccountPage />, {
      user: makeUser('worker', { permissions: [] }),
    });
  });

  test('AdministrationPage renders with only Company + Account tabs visible', async () => {
    // Admin role but every admin perm stripped — should fall through to
    // just the always-visible tabs (Company info + own Account).
    const { default: AdministrationPage } = await import('../pages/AdministrationPage');
    await smokeRender(<AdministrationPage />, {
      user: makeUser('admin', { permissions: [] }),
    });
  });
});

// ── Subscription status variants ─────────────────────────────────────────────
// BLOCKED_STATUSES = ['trial_expired', 'canceled']. Workers see
// WorkerSubscriptionWall; admins are redirected to /administration (billing).
// 'exempt' companies bypass all plan gates. Render key pages in each state
// to catch crashes in banner/warning paths that only appear under these
// statuses (e.g. AdminDashboard's trial-expired banner, Dashboard's "plan
// required" messaging, AdministrationPage's billing section).

describe.each([
  ['trial', 'starter'],
  ['trial_expired', 'free'],
  ['canceled', 'free'],
  ['exempt', 'business'],
])('smoke: subscription status = %s', (subscription_status, plan) => {
  test('AdminDashboard renders', async () => {
    const api = (await import('../api')).default;
    api.get.mockImplementation((url) => {
      if (url.startsWith('/admin/kpis')) return Promise.resolve({ data: { pending_entries: 0, clocked_in: 0, hours_this_week: 0 } });
      if (url.startsWith('/stripe/status') || url.startsWith('/stripe/billing'))
        return Promise.resolve({ data: { subscription_status, plan, trial_ends_at: null } });
      if (url.startsWith('/admin/settings') || url.startsWith('/settings'))
        return Promise.resolve({ data: { ...DEFAULT_SETTINGS, subscription_status, plan } });
      return Promise.resolve({ data: [] });
    });
    const { WorkforcePanel } = await import('../pages/AdminDashboard');
    await smokeRender(<WorkforcePanel />, {
      user: makeUser('admin', { subscription_status, plan }),
    });
  });

  test('Dashboard (worker) renders', async () => {
    const api = (await import('../api')).default;
    api.get.mockImplementation((url) => {
      if (url.startsWith('/settings'))
        return Promise.resolve({ data: { ...DEFAULT_SETTINGS, subscription_status, plan } });
      if (url.startsWith('/clock/status')) return Promise.resolve({ data: null });
      return Promise.resolve({ data: [] });
    });
    const { default: Dashboard } = await import('../pages/Dashboard');
    await smokeRender(<Dashboard />, {
      user: makeUser('worker', { subscription_status, plan }),
    });
  });

  test('AdministrationPage renders (billing tab visible for blocked admins)', async () => {
    const api = (await import('../api')).default;
    api.get.mockImplementation((url) => {
      if (url.startsWith('/stripe/status') || url.startsWith('/stripe/plans'))
        return Promise.resolve({ data: { subscription_status, plan, trial_ends_at: null, plans: [] } });
      if (url.startsWith('/admin/settings') || url.startsWith('/settings'))
        return Promise.resolve({ data: { ...DEFAULT_SETTINGS, subscription_status, plan } });
      return Promise.resolve({ data: [] });
    });
    const { default: AdministrationPage } = await import('../pages/AdministrationPage');
    await smokeRender(<AdministrationPage />, {
      user: makeUser('admin', { subscription_status, plan }),
    });
  });
});
