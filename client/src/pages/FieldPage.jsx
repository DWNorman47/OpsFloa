import React, { lazy, Suspense, useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';
import api from '../api';
import { getOrFetch } from '../offlineDb';
import { PageIntro, PageShell } from '../components/PageShell';
import TabBar from '../components/TabBar';
import FieldDayLog from '../components/FieldDayLog';
import { reportClientError } from '../errorReporter';
import RetryBanner from '../components/RetryBanner';
import ErrorBoundary from '../components/ErrorBoundary';

const FIELD_TABS = ['notes', 'daily', 'punchlist', 'safety', 'checklists', 'incident', 'gallery', 'subs', 'rfi', 'inspect'];
const FIELD_HASH_ALIASES = {
  today: 'notes',
  'work-notes': 'notes',
  reports: 'daily',
  'daily-reports': 'daily',
  report: 'daily',
  punch: 'punchlist',
  incidents: 'incident',
  media: 'gallery',
  photos: 'gallery',
  'sub-reports': 'subs',
  rfis: 'rfi',
  inspections: 'inspect',
  inspection: 'inspect',
  talks: 'safety',
  checklist: 'checklists',
};
const FIELD_GROUP_DEFAULTS = { daily: 'notes', issues: 'punchlist', safety: 'safety', resources: 'subs' };

function resolveFieldTab(rawHash) {
  const hash = String(rawHash || '').replace('#', '').trim().toLowerCase();
  return FIELD_TABS.includes(hash)
    ? hash
    : FIELD_HASH_ALIASES[hash] || FIELD_GROUP_DEFAULTS[hash] || 'notes';
}

// Tab components — lazy-loaded on first visit since only one tab is visible at a time
const DailyReports        = lazy(() => import('../components/DailyReports'));
const Punchlist           = lazy(() => import('../components/Punchlist'));
const SafetyTalks         = lazy(() => import('../components/SafetyTalks'));
const SafetyChecklists    = lazy(() => import('../components/SafetyChecklists'));
const IncidentReports     = lazy(() => import('../components/IncidentReports'));
const PhotoGallery        = lazy(() => import('../components/PhotoGallery'));
const SubReports          = lazy(() => import('../components/SubReports'));
const RFITracking         = lazy(() => import('../components/RFITracking'));
const InspectionChecklists = lazy(() => import('../components/InspectionChecklists'));

function TabLoader() {
  return <div className="ops-loading-state">Loading...</div>;
}

function pageLoadMessage(err) {
  const status = err?.response?.status;
  if (status === 502 || status === 503 || status === 504) {
    return 'Service temporarily unavailable. Please try again shortly.';
  }
  if (!err?.response && err?.message === 'Offline and no cached data') {
    return 'No connection and no saved field data yet.';
  }
  return err?.response?.data?.error || err?.message || 'Failed to load page data';
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FieldPage() {
  const { user } = useAuth();
  const t = useT();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';

  const [projects, setProjects] = useState([]);
  const [features, setFeatures] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const hashTab = window.location.hash.replace('#', '');
  const [fieldTab, setFieldTab] = useState(resolveFieldTab(hashTab));
  const switchTab = t => { setFieldTab(t); history.replaceState(null, '', '#' + t); };

  useEffect(() => {
    const syncFromHash = () => {
      const nextHashTab = window.location.hash.replace('#', '');
      const nextTab = resolveFieldTab(nextHashTab);
      setFieldTab(prev => (prev === nextTab ? prev : nextTab));
    };
    window.addEventListener('hashchange', syncFromHash);
    syncFromHash();
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, []);

  // The Equipment Log moved to Inventory → Equipment. Bounce any old #equip
  // deep links / bookmarks / push URLs so they don't dead-end on Notes.
  useEffect(() => {
    const bounce = () => {
      if (['equip', 'equipment'].includes(window.location.hash.replace('#', '').toLowerCase()))
        window.location.replace('/inventory#eq-assets');
    };
    bounce();
    window.addEventListener('hashchange', bounce);
    return () => window.removeEventListener('hashchange', bounce);
  }, []);

  const init = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [p, s] = await Promise.all([
        getOrFetch('projects', () => api.get('/projects').then(r => r.data)),
        getOrFetch('settings', () => api.get('/settings').then(r => r.data)),
      ]);
      setFeatures(s);
      setProjects(p);
    } catch (err) {
      // Surface to the user AND to Sentry — the page is unusable without these.
      setLoadError(pageLoadMessage(err));
      reportClientError({ kind: 'unhandled', message: `FieldPage init: ${err?.message || err}`, stack: err?.stack });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { init(); }, [init]);

  const fieldGroups = [
    {
      id: 'daily',
      label: isAdmin ? t.fldGroupDaily : t.fldGroupToday,
      items: [
        { id: 'notes', label: t.fieldTabNotes },
        ...(isAdmin ? [{ id: 'daily', label: t.fieldTabDaily }] : []),
        ...(isAdmin && features.feature_media_gallery ? [{ id: 'gallery', label: t.fieldTabMedia }] : []),
      ],
    },
    {
      id: 'issues',
      label: t.fldGroupIssues,
      items: [
        { id: 'punchlist', label: t.fieldTabPunch },
        { id: 'incident', label: t.fieldTabIncidents },
        ...(isAdmin ? [{ id: 'rfi', label: t.fieldTabRFI }] : []),
      ],
    },
    {
      id: 'safety',
      label: t.fieldTabSafety,
      items: [
        { id: 'safety', label: t.fldTabTalks },
        { id: 'checklists', label: t.fieldTabChecklists },
        ...(isAdmin ? [{ id: 'inspect', label: t.fieldTabInspect }] : []),
      ],
    },
    {
      id: 'resources',
      label: isAdmin ? t.fldGroupResources : t.fldGroupMore,
      items: [
        ...(isAdmin ? [{ id: 'subs', label: t.fieldTabSubs }] : []),
      ],
    },
  ].filter(group => group.items.length > 0);
  const activeGroup = fieldGroups.find(group => group.items.some(item => item.id === fieldTab)) || fieldGroups[0];
  const activeFieldTab = activeGroup.items.some(item => item.id === fieldTab) ? fieldTab : activeGroup.items[0].id;
  const switchGroup = groupId => {
    const nextGroup = fieldGroups.find(group => group.id === groupId);
    switchTab(nextGroup?.items[0]?.id || 'notes');
  };

  return (
    <PageShell currentApp="field" features={features} maxWidth={980} mainClassName="field-main">
        <PageIntro
          introId="field"
          kicker={features?.label_field || t.fldKicker}
          title={isAdmin ? t.fldTitle : t.fldTitleWorker}
          description={isAdmin ? t.fldDescription : t.fldDescriptionWorker}
        />
        <RetryBanner message={loadError} onRetry={init} />

        <div className="ops-workflow-tabs" role="tablist" aria-label="Field work groups">
          {fieldGroups.map(group => (
            <button
              key={group.id}
              type="button"
              role="tab"
              aria-selected={activeGroup.id === group.id}
              aria-current={activeGroup.id === group.id ? 'page' : undefined}
              className={`ops-workflow-tab ${activeGroup.id === group.id ? 'is-active' : ''}`.trim()}
              onClick={() => switchGroup(group.id)}
            >
              {group.label}
            </button>
          ))}
        </div>
        {activeGroup.items.length > 1 && (
          <div className="ops-subtabs">
            <TabBar
              active={activeFieldTab}
              onChange={switchTab}
              tabs={activeGroup.items}
              breakpoint={420}
            />
          </div>
        )}

        {/* Per-tab error boundary — a crash in one tab doesn't take down the page.
            Keyed on fieldTab so switching tabs resets the boundary if the user
            recovered by navigating away from the broken tab. */}
        <ErrorBoundary key={activeFieldTab} mode="inline" label={activeFieldTab}>
          <Suspense fallback={<TabLoader />}>
            {activeFieldTab === 'daily' ? (
              <DailyReports projects={projects} settings={features} />
            ) : activeFieldTab === 'punchlist' ? (
              <Punchlist projects={projects} settings={features} />
            ) : activeFieldTab === 'safety' ? (
              <SafetyTalks projects={projects} settings={features} />
            ) : activeFieldTab === 'checklists' ? (
              <SafetyChecklists projects={projects} settings={features} />
            ) : activeFieldTab === 'incident' ? (
              <IncidentReports projects={projects} settings={features} />
            ) : activeFieldTab === 'gallery' ? (
              <PhotoGallery projects={projects} settings={features} />
            ) : activeFieldTab === 'subs' ? (
              <SubReports projects={projects} settings={features} />
            ) : activeFieldTab === 'rfi' ? (
              <RFITracking projects={projects} settings={features} />
            ) : activeFieldTab === 'inspect' ? (
              <InspectionChecklists projects={projects} settings={features} />
            ) : (
              <FieldDayLog projects={projects} isAdmin={isAdmin} settings={features} />
            )}
          </Suspense>
        </ErrorBoundary>
    </PageShell>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  page: { minHeight: '100vh', background: '#f4f6f9' },
  header: { background: '#059669', color: '#fff', padding: '0 24px', paddingTop: 'env(safe-area-inset-top)', paddingBottom: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: 'calc(56px + env(safe-area-inset-top))', position: 'sticky', top: 0, zIndex: 100 },
  headerTopRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', height: 56 },
  logoGroup: { display: 'flex', alignItems: 'center', gap: 10 },
  companyName: { fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)' },
  headerRight: { display: 'flex', alignItems: 'center', gap: 10 },
  userName: { fontSize: 14, opacity: 0.85 },
  headerBtn: { background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', padding: '6px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  main: { maxWidth: 860, margin: '0 auto', padding: '24px 16px' },
};
