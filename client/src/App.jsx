import React, { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { safeSession } from './utils/safeStorage';
import InstallPrompt from './components/InstallPrompt';
import UpdatePrompt from './components/UpdatePrompt';
import WelcomeModal from './components/WelcomeModal';
import TermsGate from './components/TermsGate';
import SkipLink from './components/SkipLink';
import { ToastProvider } from './contexts/ToastContext';
import { OfflineProvider } from './contexts/OfflineContext';
import { SettingsProvider } from './contexts/SettingsContext';
import { clearCache } from './offlineDb';
import { userCanSeeModule, pickLandingPath } from './modulePermissions';

const Login             = lazy(() => import('./pages/Login'));
const Register          = lazy(() => import('./pages/Register'));
const Landing           = lazy(() => import('./pages/Landing'));
const ForgotPassword    = lazy(() => import('./pages/ForgotPassword'));
const ResetPassword     = lazy(() => import('./pages/ResetPassword'));
const AcceptInvite      = lazy(() => import('./pages/AcceptInvite'));
const ConfirmEmail      = lazy(() => import('./pages/ConfirmEmail'));
const ServiceRequest    = lazy(() => import('./pages/ServiceRequest'));
const PublicCompanyProfilePage = lazy(() => import('./pages/PublicCompanyProfilePage'));
const TeamPage          = lazy(() => import('./pages/TeamPage'));
const HomePage          = lazy(() => import('./pages/HomePage'));
const Dashboard         = lazy(() => import('./pages/Dashboard'));
const FieldPage         = lazy(() => import('./pages/FieldPage'));
const ProjectsPage      = lazy(() => import('./pages/ProjectsPage'));
const AdministrationPage = lazy(() => import('./pages/AdministrationPage'));
const SuperAdmin        = lazy(() => import('./pages/SuperAdmin'));
const InventoryPage     = lazy(() => import('./pages/InventoryPage'));
const ToolsPage         = lazy(() => import('./pages/ToolsPage'));
const AccountPage       = lazy(() => import('./pages/AccountPage'));
const PrivacyPolicy     = lazy(() => import('./pages/PrivacyPolicy'));
const EULA              = lazy(() => import('./pages/EULA'));
const Tests             = lazy(() => import('./pages/Tests'));
const Changelog         = lazy(() => import('./pages/Changelog'));
const HelpPage          = lazy(() => import('./pages/HelpPage'));
const PublicEstimatePage = lazy(() => import('./pages/PublicEstimatePage'));
const FinancialReportsPage = lazy(() => import('./pages/FinancialReportsPage'));
const PublicChangeOrderPage = lazy(() => import('./pages/PublicChangeOrderPage'));
const SubmittalsPage    = lazy(() => import('./pages/SubmittalsPage'));
const CloseoutPage      = lazy(() => import('./pages/CloseoutPage'));
const LienWaiversPage   = lazy(() => import('./pages/LienWaiversPage'));
const PublicLienWaiverSignPage = lazy(() => import('./pages/PublicLienWaiverSignPage'));
const CatalogPage       = lazy(() => import('./pages/CatalogPage'));
const BookingPage       = lazy(() => import('./pages/BookingPage'));
const MyBookingPage     = lazy(() => import('./pages/MyBookingPage'));
const PublicBookingPage = lazy(() => import('./pages/PublicBookingPage'));
const PublicBookingManagePage = lazy(() => import('./pages/PublicBookingPage').then(m => ({ default: m.PublicBookingManagePage })));

function PageLoader() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f4f6f9', color: '#6b7280', fontSize: 15 }}>
      Loading…
    </div>
  );
}

const BLOCKED_STATUSES = ['trial_expired', 'canceled'];

function WorkerSubscriptionWall() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f4f6f9', padding: 24 }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: '40px 32px', maxWidth: 400, textAlign: 'center', boxShadow: '0 2px 16px rgba(0,0,0,0.08)' }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: '#111827', marginBottom: 8 }}>Subscription ended</h2>
        <p style={{ fontSize: 14, color: '#6b7280', lineHeight: 1.6 }}>
          Your company's subscription has ended. Please contact your administrator to restore access.
        </p>
      </div>
    </div>
  );
}

function PrivateRoute({ children, adminOnly = false, superAdminOnly = false, moduleId = null }) {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f4f6f9', color: '#6b7280', fontSize: 15 }}>Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (superAdminOnly && user.role !== 'super_admin') return <Navigate to="/" replace />;
  // Send a bounced non-admin to a page they can actually load (never a fixed
  // admin-only path, which could ping-pong with the module guard below).
  if (adminOnly && user.role !== 'admin' && user.role !== 'super_admin') return <Navigate to={pickLandingPath(user)} replace />;

  // Subscription gate — block access when trial expired or canceled
  if (BLOCKED_STATUSES.includes(user.subscription_status)) {
    const isAdmin = user.role === 'admin' || user.role === 'super_admin';
    if (isAdmin) {
      // Admins can only reach /administration (billing) — redirect everything else
      if (window.location.pathname !== '/administration') {
        return <Navigate to="/administration" replace />;
      }
    } else {
      return <WorkerSubscriptionWall />;
    }
  }

  // Phase D: per-module permission guard. Deep-linking to a module you have
  // no permissions for bounces you to your landing page (the first module
  // you DO have access to, or /account if none).
  if (moduleId) {
    // moduleId may be an array — the user passes if they can see ANY of them
    // (e.g. /timeclock admits both the personal Time Clock and the Workforce
    // oversight group, which have disjoint permission sets).
    const ids = Array.isArray(moduleId) ? moduleId : [moduleId];
    if (!ids.some(id => userCanSeeModule(user, id))) {
      const landing = pickLandingPath(user);
      // Avoid redirect loops if the landing itself fails the check.
      if (landing !== window.location.pathname) {
        return <Navigate to={landing} replace />;
      }
    }
  }

  return children;
}

// Preserves the URL hash (and search) when redirecting from a renamed legacy
// path. The default `<Navigate>` strips both, which would break tab deep
// links like `/dashboard#schedule` or `/admin#approvals` that show up in
// stored push notifications and inbox rows.
function HashRedirect({ to }) {
  const { hash, search } = useLocation();
  return <Navigate to={`${to}${search}${hash}`} replace />;
}

// Workforce folded into Time Clock as the "Workforce" group. Map old
// /workforce#<tab> and /admin#<tab> links to /timeclock#wf-<tab> so stored
// push/inbox deep links keep landing on the right oversight tab.
function WorkforceRedirect() {
  const { search, hash } = useLocation();
  const sub = (hash || '').replace('#', '') || 'live';
  return <Navigate to={`/timeclock${search}#wf-${sub}`} replace />;
}

// Phase D: choose where a logged-in user lands when they hit / or *.
// super_admin keeps the /superadmin tools page (cross-tenant). Everyone else
// starts on Time Clock, while /home remains available as a direct URL.
//
// Pure — only reads localStorage, never writes. The "I've welcomed this
// admin" mark is set inside AdministrationPage via useEffect when the page
// actually mounts. Writing it here meant the flag flipped during a render
// pass, which React strict-mode can call twice and which makes the function
// non-idempotent during route resolution.
function landingFor(user) {
  if (user.role === 'super_admin') return '/superadmin';
  return '/timeclock';
}

function AppRoutes() {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f4f6f9', color: '#6b7280', fontSize: 15 }}>Loading…</div>;
  return (
    <Suspense fallback={<PageLoader />}>
    <Routes>
      <Route path="/login" element={user ? <Navigate to={landingFor(user)} replace /> : <Login />} />
      <Route path="/register" element={user ? <Navigate to={landingFor(user)} replace /> : <Register />} />
      <Route path="/privacy" element={<PrivacyPolicy />} />
      <Route path="/eula" element={<EULA />} />
      <Route path="/changelog" element={<Changelog />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route path="/confirm-email" element={<ConfirmEmail />} />
      <Route path="/r/:slug" element={<ServiceRequest />} />
      <Route path="/companies/:slug" element={<PublicCompanyProfilePage />} />
      <Route path="/e/:token" element={<PublicEstimatePage />} />
      <Route path="/co/:token" element={<PublicChangeOrderPage />} />
      <Route path="/lien-waiver-sign/:token" element={<PublicLienWaiverSignPage />} />
      <Route path="/book/:companySlug" element={<PublicBookingPage />} />
      <Route path="/book/:companySlug/:typeSlug" element={<PublicBookingPage />} />
      <Route path="/book/manage/:token" element={<PublicBookingManagePage />} />
      <Route path="/team" element={<PrivateRoute moduleId="team"><TeamPage /></PrivateRoute>} />
      <Route path="/home" element={<PrivateRoute><HomePage /></PrivateRoute>} />
      <Route path="/__tests__" element={<Tests />} />
      {/* Time Clock holds both the personal participating view and the admin
          Workforce oversight group (a tab within it). */}
      <Route path="/timeclock" element={<PrivateRoute moduleId={['timeclock', 'workforce']}><Dashboard /></PrivateRoute>} />
      {/* Workforce is now the Workforce group of Time Clock. Map old links
          (incl. push/inbox #tab deep links) to /timeclock#wf-<tab>. */}
      <Route path="/workforce" element={<WorkforceRedirect />} />
      <Route path="/admin" element={<WorkforceRedirect />} />
      {/* Legacy redirects — keep indefinitely so stored push/inbox URLs and
          old PWA bookmarks still work. HashRedirect preserves the #tab. */}
      <Route path="/dashboard" element={<HashRedirect to="/timeclock" />} />
      <Route path="/field" element={<PrivateRoute moduleId="field"><FieldPage /></PrivateRoute>} />
      <Route path="/work" element={<PrivateRoute adminOnly moduleId="projects"><ProjectsPage /></PrivateRoute>} />
      <Route path="/projects" element={<HashRedirect to="/work" />} />
      <Route path="/administration" element={<PrivateRoute adminOnly moduleId="administration"><AdministrationPage /></PrivateRoute>} />
      {/* Analytics is now the Performance tab of the Reports module. */}
      <Route path="/analytics" element={<Navigate to="/financial-reports#performance" replace />} />
      <Route path="/inventory" element={<PrivateRoute moduleId="inventory"><InventoryPage /></PrivateRoute>} />
      <Route path="/tools" element={<PrivateRoute moduleId="tools"><ToolsPage /></PrivateRoute>} />
      {/* Sales is now a tab set inside the Projects module. Keep the old paths
          working by deep-linking to the matching Projects tab. */}
      <Route path="/sales" element={<Navigate to="/work#estimates" replace />} />
      <Route path="/change-orders" element={<Navigate to="/work#change_orders" replace />} />
      <Route path="/submittals" element={<PrivateRoute adminOnly moduleId="field"><SubmittalsPage /></PrivateRoute>} />
      <Route path="/closeout" element={<PrivateRoute adminOnly moduleId="workforce"><CloseoutPage /></PrivateRoute>} />
      <Route path="/lien-waivers" element={<PrivateRoute adminOnly moduleId="workforce"><LienWaiversPage /></PrivateRoute>} />
      <Route path="/catalog" element={<PrivateRoute moduleId="inventory"><CatalogPage /></PrivateRoute>} />
      <Route path="/booking" element={<PrivateRoute adminOnly moduleId="booking"><BookingPage /></PrivateRoute>} />
      <Route path="/me/booking" element={<PrivateRoute><MyBookingPage /></PrivateRoute>} />
      {/* Subcontractors split: the firm directory is now a tab of the Directory
          module; purchase orders moved to Projects. Keep the old path working. */}
      <Route path="/subs" element={<Navigate to="/team#subs" replace />} />
      <Route path="/financial-reports" element={<PrivateRoute adminOnly moduleId="financial_reports"><FinancialReportsPage /></PrivateRoute>} />
      <Route path="/account" element={<PrivateRoute><AccountPage /></PrivateRoute>} />
      <Route path="/help" element={<PrivateRoute><HelpPage /></PrivateRoute>} />
      <Route path="/superadmin" element={<PrivateRoute superAdminOnly><SuperAdmin /></PrivateRoute>} />
      <Route path="/" element={user ? <Navigate to={landingFor(user)} replace /> : <Landing />} />
      <Route path="*" element={<Navigate to={user ? landingFor(user) : '/'} replace />} />
    </Routes>
    </Suspense>
  );
}

// If this tab was opened via "Login as" from SuperAdmin, swap in the impersonate token
// before React even mounts so AuthProvider picks it up on first render.
// Drop the API cache on every online page load.
//
// The cache exists so the PWA keeps working in dead zones — it is *not*
// meant to silently outlive a refresh when the network is available. Before
// this, refreshing the page re-read stale data from IndexedDB because the
// cache-first code ran again on the persisted store. Now: refresh while
// online = fresh data, same as any normal website. When offline we keep
// the cache, because it's the only thing we have.
//
// The clear is async but fire-and-forget: the clear transaction is queued
// on the same IDB connection that getOrFetch will use, so the first reads
// see an empty store.
(function dropCacheOnOnlineLoad() {
  if (navigator.onLine === false) return;
  clearCache();
})();

// Clear the cache when the user returns to the tab after a meaningful
// absence. Covers "admin created a project in another tab, worker tabbed
// back — why haven't I seen it yet?" Threshold kept at 30s so momentary
// tab flips don't force a full refetch.
(function dropCacheOnTabRefocus() {
  let hiddenAt = null;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    if (document.visibilityState === 'visible' && navigator.onLine !== false) {
      const elapsed = hiddenAt ? Date.now() - hiddenAt : Infinity;
      if (elapsed > 30 * 1000) clearCache();
      hiddenAt = null;
    }
  });
})();

(function applyImpersonateToken() {
  if (!window.location.search.includes('impersonate=1')) return;
  const token = safeSession.getItem('impersonate_token');
  if (!token) return;
  safeSession.removeItem('impersonate_token');
  // Store the impersonation token in sessionStorage (tab-scoped), NOT
  // localStorage (origin-scoped). Otherwise the impersonation tab would
  // overwrite the super admin's tc_token in their original SuperAdmin tab,
  // and the next /superadmin/* request from there would 403.
  safeSession.setItem('tc_token', token);
  // Intentionally do NOT clear the IndexedDB cache here — the super admin
  // impersonating a user wants to reproduce exactly what the user sees,
  // including stale-cache artifacts. Clearing it would mask diagnostic bugs.
  // Strip the query param so normal auth flow runs from here
  window.history.replaceState({}, '', window.location.pathname);
})();

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ToastProvider>
          <OfflineProvider>
            <SettingsProvider>
              <SkipLink />
              <WelcomeModal />
              <TermsGate />
              <AppRoutes />
              <InstallPrompt />
              <UpdatePrompt />
            </SettingsProvider>
          </OfflineProvider>
        </ToastProvider>
      </BrowserRouter>
    </AuthProvider>
  );
}
