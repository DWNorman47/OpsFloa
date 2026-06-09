import React, { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import InstallPrompt from './components/InstallPrompt';
import UpdatePrompt from './components/UpdatePrompt';
import WelcomeModal from './components/WelcomeModal';
import SkipLink from './components/SkipLink';
import { ToastProvider } from './contexts/ToastContext';
import { OfflineProvider } from './contexts/OfflineContext';
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
const TeamPage          = lazy(() => import('./pages/TeamPage'));
const HomePage          = lazy(() => import('./pages/HomePage'));
const Dashboard         = lazy(() => import('./pages/Dashboard'));
const AdminDashboard    = lazy(() => import('./pages/AdminDashboard'));
const FieldPage         = lazy(() => import('./pages/FieldPage'));
const ProjectsPage      = lazy(() => import('./pages/ProjectsPage'));
const AdministrationPage = lazy(() => import('./pages/AdministrationPage'));
const AnalyticsPage     = lazy(() => import('./pages/AnalyticsPage'));
const SuperAdmin        = lazy(() => import('./pages/SuperAdmin'));
const InventoryPage     = lazy(() => import('./pages/InventoryPage'));
const AccountPage       = lazy(() => import('./pages/AccountPage'));
const PrivacyPolicy     = lazy(() => import('./pages/PrivacyPolicy'));
const EULA              = lazy(() => import('./pages/EULA'));
const Tests             = lazy(() => import('./pages/Tests'));
const Changelog         = lazy(() => import('./pages/Changelog'));
const HelpPage          = lazy(() => import('./pages/HelpPage'));
const EstimatesPage     = lazy(() => import('./pages/EstimatesPage'));
const PublicEstimatePage = lazy(() => import('./pages/PublicEstimatePage'));
const SubsPage          = lazy(() => import('./pages/SubsPage'));
const FinancialReportsPage = lazy(() => import('./pages/FinancialReportsPage'));

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
  if (adminOnly && user.role !== 'admin' && user.role !== 'super_admin') return <Navigate to="/timeclock" replace />;

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
    if (!userCanSeeModule(user, moduleId)) {
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
      <Route path="/e/:token" element={<PublicEstimatePage />} />
      <Route path="/team" element={<PrivateRoute moduleId="team"><TeamPage /></PrivateRoute>} />
      <Route path="/home" element={<PrivateRoute><HomePage /></PrivateRoute>} />
      <Route path="/__tests__" element={<Tests />} />
      {/* New canonical routes: /timeclock = the participating page (worker
          and admin self-time), /workforce = the admin oversight page. */}
      <Route path="/timeclock" element={<PrivateRoute moduleId="timeclock"><Dashboard /></PrivateRoute>} />
      <Route path="/workforce" element={<PrivateRoute adminOnly moduleId="workforce"><AdminDashboard /></PrivateRoute>} />
      {/* Legacy redirects — keep indefinitely so stored push/inbox URLs and
          old PWA bookmarks still work. HashRedirect preserves the #tab. */}
      <Route path="/dashboard" element={<HashRedirect to="/timeclock" />} />
      <Route path="/admin" element={<HashRedirect to="/workforce" />} />
      <Route path="/field" element={<PrivateRoute moduleId="field"><FieldPage /></PrivateRoute>} />
      <Route path="/projects" element={<PrivateRoute adminOnly moduleId="projects"><ProjectsPage /></PrivateRoute>} />
      <Route path="/administration" element={<PrivateRoute adminOnly moduleId="administration"><AdministrationPage /></PrivateRoute>} />
      <Route path="/analytics" element={<PrivateRoute adminOnly moduleId="analytics"><AnalyticsPage /></PrivateRoute>} />
      <Route path="/inventory" element={<PrivateRoute moduleId="inventory"><InventoryPage /></PrivateRoute>} />
      <Route path="/sales" element={<PrivateRoute adminOnly moduleId="sales"><EstimatesPage /></PrivateRoute>} />
      <Route path="/subs" element={<PrivateRoute adminOnly moduleId="subs"><SubsPage /></PrivateRoute>} />
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
  const token = sessionStorage.getItem('impersonate_token');
  if (!token) return;
  sessionStorage.removeItem('impersonate_token');
  // Store the impersonation token in sessionStorage (tab-scoped), NOT
  // localStorage (origin-scoped). Otherwise the impersonation tab would
  // overwrite the super admin's tc_token in their original SuperAdmin tab,
  // and the next /superadmin/* request from there would 403.
  sessionStorage.setItem('tc_token', token);
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
            <SkipLink />
            <WelcomeModal />
            <AppRoutes />
            <InstallPrompt />
            <UpdatePrompt />
          </OfflineProvider>
        </ToastProvider>
      </BrowserRouter>
    </AuthProvider>
  );
}
