import React, { lazy, Suspense, useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { safeLocal } from '../utils/safeStorage';
import { useT } from '../hooks/useT';
import api from '../api';
import { getOrFetch } from '../offlineDb';
import { PageIntro, PageShell } from '../components/PageShell';
import TabBar from '../components/TabBar';
import FieldDayLog from '../components/FieldDayLog';
import { reportClientError } from '../errorReporter';
import RetryBanner from '../components/RetryBanner';
import ErrorBoundary from '../components/ErrorBoundary';

const FIELD_TABS = ['notes', 'checklist-daily', 'daily', 'haul', 'punchlist', 'safety', 'checklist-builder', 'checklist-reports', 'incident', 'gallery', 'subs', 'rfi', 'inspect'];
const FIELD_HASH_ALIASES = {
  today: 'notes',
  'work-notes': 'notes',
  reports: 'daily',
  'daily-reports': 'daily',
  report: 'daily',
  'haul-tickets': 'haul',
  hauls: 'haul',
  production: 'haul',
  punch: 'punchlist',
  incidents: 'incident',
  media: 'gallery',
  photos: 'gallery',
  'sub-reports': 'subs',
  rfis: 'rfi',
  inspections: 'inspect',
  inspection: 'inspect',
  talks: 'safety',
  checklists: 'checklist-builder',
  checklist: 'checklist-builder',
  builder: 'checklist-builder',
  'checklist-report': 'checklist-reports',
};
const FIELD_GROUP_DEFAULTS = { log: 'checklist-daily', issues: 'punchlist', manage: 'checklist-builder' };

function resolveFieldTab(rawHash) {
  const hash = String(rawHash || '').replace('#', '').trim().toLowerCase();
  return FIELD_TABS.includes(hash)
    ? hash
    : FIELD_HASH_ALIASES[hash] || FIELD_GROUP_DEFAULTS[hash] || 'notes';
}

// Tab components — lazy-loaded on first visit since only one tab is visible at a time
const DailyReports        = lazy(() => import('../components/DailyReports'));
const HaulTickets         = lazy(() => import('../components/HaulTickets'));
const Punchlist           = lazy(() => import('../components/Punchlist'));
const SafetyTalks         = lazy(() => import('../components/SafetyTalks'));
const ChecklistBuilder    = lazy(() => import('../components/ChecklistManager').then(m => ({ default: m.ChecklistBuilder })));
const ChecklistReports    = lazy(() => import('../components/ChecklistManager').then(m => ({ default: m.ChecklistReports })));
const IncidentReports     = lazy(() => import('../components/IncidentReports'));
const PhotoGallery        = lazy(() => import('../components/PhotoGallery'));
const SubReports          = lazy(() => import('../components/SubReports'));
const InspectionChecklists = lazy(() => import('../components/InspectionChecklists'));
const DailyChecklist      = lazy(() => import('../components/DailyChecklist'));

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
  const [clockedInPid, setClockedInPid] = useState(undefined); // undefined = clock status not resolved yet
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
        getOrFetch('projects', () => api.get('/work').then(r => r.data)),
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

  // The worker's currently clocked-in project — screens below default their
  // project picker to it (a real job only; see defaultProjectId). Not cached; it
  // changes as they clock in/out.
  useEffect(() => {
    api.get('/clock/status').then(r => setClockedInPid(r.data?.project_id || null)).catch(() => setClockedInPid(null));
  }, []);

  // The clocked-in project, but only when it's a real job (active, not overhead).
  // `undefined` = still resolving; `null` = no clocked-in real job.
  const clockedInDefault = React.useMemo(() => {
    if (clockedInPid === undefined) return undefined;
    if (!clockedInPid || !projects?.length) return null;
    const p = projects.find(pr => String(pr.id) === String(clockedInPid));
    return (p && p.active !== false && !p.is_overhead) ? p.id : null;
  }, [clockedInPid, projects]);

  // ── Shared "active project" for the whole Field section ─────────────────────
  // One value that every tab's project selector reads and writes, so choosing a
  // project on any tab carries to all the others. `undefined` until seeded.
  // Seed order: clocked-in real job → last-used (localStorage) → none/All.
  // The URL ?project= (Daily Checklist deep link) still overrides on that tab.
  const [activeProject, setActiveProject] = useState(undefined); // '' = All / none
  const seededRef = useRef(false);
  const onProjectChange = useCallback((val) => {
    const s = val == null ? '' : String(val);
    setActiveProject(s);
    try { safeLocal.setItem('field_active_project', s); } catch { /* private mode */ }
  }, []);
  // Company settings (default ON): share one project across tabs; show overhead
  // codes in the Field pickers.
  const sharedProject = features?.field_shared_project !== false;
  const showOverhead = features?.field_show_overhead_projects !== false;
  const fieldProjects = showOverhead ? projects : projects.filter(p => !p.is_overhead);
  // When sharing is off, tabs still get the same seeded default but don't write
  // back — so each tab is independent (no cross-tab sync).
  const projectChange = sharedProject ? onProjectChange : undefined;
  useEffect(() => {
    if (seededRef.current) return;
    if (loading || clockedInDefault === undefined) return; // wait for data + clock (projects may legitimately be empty)
    seededRef.current = true;
    if (clockedInDefault) { setActiveProject(String(clockedInDefault)); return; }
    let last = '';
    try { last = safeLocal.getItem('field_active_project') || ''; } catch { /* ignore */ }
    const visible = p => String(p.id) === last && (showOverhead || !p.is_overhead);
    setActiveProject(last && projects.some(visible) ? last : '');
  }, [loading, clockedInDefault, projects, showOverhead]);

  const fieldGroups = [
    {
      id: 'log',
      label: t.fldGroupLog,
      items: [
        { id: 'checklist-daily', label: t.fieldTabDailyChecklist },
        { id: 'notes', label: t.fieldTabNotes },
        ...(isAdmin ? [{ id: 'daily', label: t.fieldTabDaily }] : []),
        ...(isAdmin ? [{ id: 'subs', label: t.fieldTabSubs }] : []),
        { id: 'haul', label: t.fieldTabHaul },
      ],
    },
    {
      id: 'issues',
      label: t.fldGroupIssues,
      items: [
        { id: 'punchlist', label: t.fieldTabPunch },
        { id: 'incident', label: t.fieldTabIncidents },
        { id: 'safety', label: t.fldTabTalks },
        ...(isAdmin ? [{ id: 'inspect', label: t.fieldTabInspect }] : []),
      ],
    },
    // Manage — admin-only back-office bucket: checklist templates + submissions
    // and the media library. Worker-completed safety checklist results surface via
    // the Daily Checklist tab, not here.
    {
      id: 'manage',
      label: t.fldGroupManage,
      items: [
        ...(isAdmin ? [{ id: 'checklist-builder', label: t.fieldTabChecklistBuilder }] : []),
        ...(isAdmin ? [{ id: 'checklist-reports', label: t.fieldTabChecklistReports }] : []),
        ...(isAdmin && features.feature_media_gallery ? [{ id: 'gallery', label: t.fieldTabMedia }] : []),
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
            {activeProject === undefined ? (
              <TabLoader />
            ) : activeFieldTab === 'checklist-daily' ? (
              <DailyChecklist projects={fieldProjects} settings={features} loading={loading} activeProject={activeProject} onProjectChange={projectChange} />
            ) : activeFieldTab === 'daily' ? (
              <DailyReports projects={fieldProjects} settings={features} activeProject={activeProject} onProjectChange={projectChange} />
            ) : activeFieldTab === 'haul' ? (
              <HaulTickets projects={fieldProjects} settings={features} activeProject={activeProject} onProjectChange={projectChange} />
            ) : activeFieldTab === 'punchlist' ? (
              <Punchlist projects={fieldProjects} settings={features} activeProject={activeProject} onProjectChange={projectChange} />
            ) : activeFieldTab === 'safety' ? (
              <SafetyTalks projects={fieldProjects} settings={features} activeProject={activeProject} onProjectChange={projectChange} />
            ) : activeFieldTab === 'checklist-builder' ? (
              <ChecklistBuilder projects={fieldProjects} settings={features} activeProject={activeProject} onProjectChange={projectChange} />
            ) : activeFieldTab === 'checklist-reports' ? (
              <ChecklistReports projects={fieldProjects} settings={features} activeProject={activeProject} onProjectChange={projectChange} />
            ) : activeFieldTab === 'incident' ? (
              <IncidentReports projects={fieldProjects} settings={features} activeProject={activeProject} />
            ) : activeFieldTab === 'gallery' ? (
              <PhotoGallery projects={fieldProjects} settings={features} activeProject={activeProject} onProjectChange={projectChange} />
            ) : activeFieldTab === 'subs' ? (
              <SubReports projects={fieldProjects} settings={features} activeProject={activeProject} onProjectChange={projectChange} />
            ) : activeFieldTab === 'inspect' ? (
              <InspectionChecklists projects={fieldProjects} settings={features} activeProject={activeProject} onProjectChange={projectChange} />
            ) : (
              <FieldDayLog projects={fieldProjects} isAdmin={isAdmin} settings={features} activeProject={activeProject} onProjectChange={projectChange} />
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
