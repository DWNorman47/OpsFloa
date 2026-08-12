import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import ErrorBoundary from '../components/ErrorBoundary';
import { useAuth } from '../contexts/AuthContext';
import { usePlan } from '../hooks/usePlan';
import { useT } from '../hooks/useT';
import CompanyChat from '../components/CompanyChat';
import MemberReportRow from '../components/MemberReportRow';
import LiveKPIs from '../components/LiveKPIs';
import { SkeletonStatRow, SkeletonList } from '../components/Skeleton';
import BroadcastMessage from '../components/BroadcastMessage';
import { PageIntro } from '../components/PageShell';
import TabBar from '../components/TabBar';
import OnboardingChecklist from '../components/OnboardingChecklist';
import api from '../api';
import { labelSg, labelPl } from '../companyLabels';

import { silentError } from '../errorReporter';
import { safeLocal } from '../utils/safeStorage';
// Heavy components — lazy-loaded on first render to reduce initial bundle size
// LiveWorkers pulls in leaflet + react-leaflet (~200 kB), so lazy-load it
const LiveWorkers = lazy(() => import('../components/LiveWorkers'));
const WorkerMetrics = lazy(() => import('../components/WorkerMetrics'));
const ProjectReports = lazy(() => import('../components/ProjectReports'));
const ApprovalQueue = lazy(() => import('../components/ApprovalQueue'));
const ManagePayPeriods = lazy(() => import('../components/ManagePayPeriods'));
const ManageSchedule = lazy(() => import('../components/ManageSchedule'));
const ExportPanel = lazy(() => import('../components/ExportPanel'));
const OvertimeReport = lazy(() => import('../components/OvertimeReport'));
const CertifiedPayroll = lazy(() => import('../components/CertifiedPayroll'));
const PayrollRun = lazy(() => import('../components/PayrollRun'));
const PayrollHistory = lazy(() => import('../components/PayrollHistory'));
const AdminTimeOff = lazy(() => import('../components/AdminTimeOff'));
const ReimbursementsAdmin = lazy(() => import('../components/ReimbursementsAdmin'));

function TabLoader() {
  return <SkeletonList count={4} rows={2} />;
}


function UpgradePrompt({ requiredPlan, feature }) {
  const t = useT();
  const planName = requiredPlan === 'qbo' ? 'QuickBooks Online add-on' : requiredPlan === 'advanced_payroll' ? 'Advanced Payroll add-on' : requiredPlan === 'business' ? 'Business' : 'Starter';
  return (
    <div style={{ background: '#f9fafb', border: '2px dashed #d1d5db', borderRadius: 10, padding: '32px 24px', textAlign: 'center', marginBottom: 24 }}>
      <div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div>
      <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 6 }}>{feature} requires the {planName} plan</div>
      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>{t.upgradePlanPrompt}</div>
      <button style={{ background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '9px 20px', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}
        onClick={() => window.location.href = '/administration#billing'}>
        {t.viewPlans}
      </button>
    </div>
  );
}

const isPwa = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// Workforce is the admin "oversight" group of the Time Clock module (see
// Dashboard). This renders just its content (PageIntro + tabs); the host page
// supplies the shell, header, and the Personal/Workforce group switcher.
export function WorkforcePanel() {
  const { user } = useAuth();
  const plan = usePlan();
  const t = useT();
  const [workers, setWorkers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [settings, setSettings] = useState(null);
  const [companyInfo, setCompanyInfo] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [billing, setBilling] = useState(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingReimbursements, setPendingReimbursements] = useState(0);
  const [chatUnread, setChatUnread] = useState(false);
  const [liveKpiRefreshToken, setLiveKpiRefreshToken] = useState(0);
  const [collapsedSections, setCollapsedSections] = useState(() => {
    try { return JSON.parse(safeLocal.getItem('opsfloa_report_sections') || '{}'); } catch { return {}; }
  });

  // tab must be declared before any useEffect that references it (avoids TDZ in minified output)
  const ALL_TABS = ['live', 'approvals', 'reports', 'payroll', 'timeoff', 'expenses', 'manage'];
  // Workforce tabs use a 'wf-' hash prefix so they don't collide with the
  // Personal group's tabs in the shared Time Clock module.
  const getHashTab = () => {
    const hashSub = window.location.hash.replace('#wf-', '');
    return window.location.hash.startsWith('#wf-') && ALL_TABS.includes(hashSub) ? hashSub : null;
  };
  const [tab, setTab] = useState(() => getHashTab() || 'live');
  // Bumped when a payroll run is finalized so the history list below reloads.
  const [payrollHistoryKey, setPayrollHistoryKey] = useState(0);
  // Team Member Reports: each worker's report expands inline under their row.
  // A set (not a single id) so opening another worker doesn't collapse/reset the
  // ones already open — their generated entries and date range stay put.
  const [expandedReportWorkers, setExpandedReportWorkers] = useState(() => new Set());
  const [lastOpenedWorker, setLastOpenedWorker] = useState(null); // drives the scroll-into-view, so only the just-opened panel is targeted
  const toggleReportWorker = (id) => setExpandedReportWorkers(prev => {
    const next = new Set(prev);
    if (next.has(id)) { next.delete(id); }
    else { next.add(id); setLastOpenedWorker(id); }
    return next;
  });
  const [reportPage, setReportPage] = useState(0);

  // Report section headers, so opening one can scroll to it instead of the page top.
  const sectionRefs = useRef({});
  // Selecting a member drops the report panel in below the table; bounce the view down
  // to it so the detail isn't off-screen. Fires on a *new* selection, not on deselect.
  const reportPanelRef = useRef(null);
  useEffect(() => {
    if (!lastOpenedWorker) return;
    const id = setTimeout(() => reportPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    return () => clearTimeout(id);
  }, [lastOpenedWorker]);
  const toggleSection = key => {
    const opening = !!collapsedSections[key]; // was collapsed → this click opens it
    setCollapsedSections(s => {
      const next = { ...s, [key]: !s[key] };
      safeLocal.setItem('opsfloa_report_sections', JSON.stringify(next));
      return next;
    });
    // Bring the opened section's header to the top of the viewport. Each lazy
    // section has its own Suspense boundary, so the header stays mounted while
    // its body loads and this target is always present.
    if (opening) requestAnimationFrame(() => sectionRefs.current[key]?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };

  useEffect(() => {
    api.get('/stripe/status').then(r => setBilling(r.data)).catch(silentError('admindashboard'));
  }, []);

  useEffect(() => {
    const fetchPending = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      api.get('/admin/kpis').then(r => setPendingCount(r.data.pending_approvals ?? 0)).catch(silentError('admindashboard'));
      // Only poll reimbursements when the feature is enabled.
      if (settings?.feature_reimbursements !== false) {
        api.get('/reimbursements/admin?status=pending').then(r => setPendingReimbursements((r.data.items ?? r.data).length)).catch(silentError('admindashboard'));
      }
    };
    fetchPending();
    const interval = setInterval(fetchPending, 60000);
    document.addEventListener('visibilitychange', fetchPending);
    window.addEventListener('online', fetchPending);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', fetchPending);
      window.removeEventListener('online', fetchPending);
    };
  }, [settings?.feature_reimbursements]);

  // Background chat unread check — show dot on Live tab when workers have messaged
  useEffect(() => {
    if (tab === 'live') return; // CompanyChat handles read state when visible
    const check = () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine) return;
      api.get('/chat').then(r => {
        const hasUnread = r.data.some(thread => {
          const key = `chatLastRead_admin_${thread.worker_id}`;
          const lastRead = safeLocal.getItem(key);
          return !lastRead || new Date(thread.last_at) > new Date(lastRead);
        });
        setChatUnread(hasUnread);
      }).catch(silentError('admindashboard'));
    };
    check();
    const iv = setInterval(check, 60000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('online', check);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('online', check);
    };
  }, [tab]);

  // Permission helper — null admin_permissions means full access
  const canDo = key => !user?.admin_permissions || user.admin_permissions[key] === true;

  const switchTab = t => {
    setTab(t);
    history.replaceState(null, '', '#wf-' + t);
  };

  useEffect(() => {
    const syncFromHash = () => {
      const next = getHashTab();
      if (next) setTab(next);
    };
    syncFromHash();
    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, []);

  useEffect(() => {
    Promise.all([api.get('/admin/workers'), api.get('/admin/projects'), api.get('/admin/settings'), api.get('/company-info')])
      .then(([w, p, s, ci]) => { setWorkers(w.data); setProjects(p.data); setSettings(s.data); setCompanyInfo(ci.data || {}); })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }, []);

  const handleWorkerAdded    = w  => setWorkers(prev => [...prev, { ...w, total_entries: 0, total_hours: 0, regular_hours: 0, overtime_hours: 0, prevailing_hours: 0 }]);
  const handleWorkerDeleted  = id => setWorkers(prev => prev.filter(w => w.id !== id));
  const handleWorkerUpdated  = w  => setWorkers(prev => prev.map(x => x.id === w.id ? { ...x, ...w } : x));
  const handleWorkerRestored = w  => setWorkers(prev => [...prev, w]);
  const handleProjectAdded   = p  => setProjects(prev => [...prev, p]);
  const handleProjectDeleted = id => setProjects(prev => prev.filter(p => p.id !== id));
  const handleProjectUpdated = p  => setProjects(prev => prev.map(x => x.id === p.id ? p : x));
  const handleProjectRestored= p  => setProjects(prev => [...prev, p]);
  const refreshLiveMetrics = () => {
    setLiveKpiRefreshToken(token => token + 1);
    api.get('/admin/kpis')
      .then(r => setPendingCount(r.data.pending_approvals ?? 0))
      .catch(silentError('admindashboard'));
  };

  const workerLabel = labelSg(settings?.label_worker, 'worker', user?.language);
  const workerLabelPlural = labelPl(settings?.label_worker, 'worker', user?.language);

  return (
    <>
      {billing?.subscription_status === 'trial_expired' && (
        <div style={{ ...styles.trialBanner, background: '#fef2f2', borderColor: '#fecaca', color: '#991b1b' }}>
          ⚠ {t.trialEnded}
          {' '}<button style={styles.trialUpgradeBtn} onClick={() => window.location.href = '/administration#billing'}>{t.subscribeNow}</button>
        </div>
      )}
      {billing?.subscription_status === 'trial' && (() => {
        const days = Math.max(0, Math.ceil((new Date(billing.trial_ends_at) - new Date()) / 86400000));
        if (days > 7) return null;
        return (
          <div style={{ ...styles.trialBanner, background: days <= 2 ? '#fef2f2' : '#fffbeb', borderColor: days <= 2 ? '#fecaca' : '#fcd34d', color: days <= 2 ? '#991b1b' : '#92400e' }}>
            {`⏳ ${days} day${days !== 1 ? 's' : ''} left in your trial.`}
            {' '}<button style={styles.trialUpgradeBtn} onClick={() => window.location.href = '/administration#billing'}>{t.subscribeNow}</button>
          </div>
        );
      })()}

        <PageIntro
          introId="workforce"
          kicker="Workforce"
          title="Run the day from the exceptions first."
          description="Live status, approvals, reports, and scheduling stay together, while the tabs keep the daily view from feeling crowded."
          meta={
            <>
              <span className={`ops-pill ${pendingCount > 0 ? 'attention' : 'good'}`}>{pendingCount} approvals</span>
              {settings?.feature_reimbursements !== false && (
                <span className={`ops-pill ${pendingReimbursements > 0 ? 'attention' : ''}`}>{pendingReimbursements} expenses</span>
              )}
            </>
          }
        />
        <TabBar
          breakpoint={720}
          active={tab}
          onChange={switchTab}
          tabs={[
            { id: 'live', label: t.tabLive, dot: chatUnread && settings?.feature_chat !== false ? '#3b82f6' : null },
            ...(canDo('approve_entries') ? [{ id: 'approvals', label: t.tabApprovals, dot: pendingCount > 0 ? '#f59e0b' : null }] : []),
            ...(canDo('view_reports') ? [{ id: 'reports', label: t.tabReports }] : []),
            ...(canDo('view_reports') && canDo('view_worker_wages') ? [{ id: 'payroll', label: t.tabPayroll }] : []),
            ...(settings?.feature_pto !== false ? [{ id: 'timeoff', label: t.tabTimeOff }] : []),
            ...(settings?.feature_reimbursements !== false ? [{ id: 'expenses', label: t.tabExpenses, dot: pendingReimbursements > 0 ? '#f59e0b' : null }] : []),
            ...(settings?.feature_scheduling !== false ? [{ id: 'manage', label: t.tabManage }] : []),
          ]}
        />

        {loading ? (
          <>
            <SkeletonStatRow count={4} style={{ marginBottom: 20 }} />
            <SkeletonList count={4} />
          </>
        ) : loadError ? (
          <div style={styles.errorBanner}>
            <strong>{t.failedLoadDashboard}</strong> Check your connection and{' '}
            <button style={styles.retryBtn} onClick={() => window.location.reload()}>{t.tryAgain}</button>.
          </div>
        ) : (
          <ErrorBoundary key={tab} mode="inline" label={tab}>
          {tab === 'live' ? (
          <>
            {workers.filter(w => w.role === 'worker').length === 0 && (
              <OnboardingChecklist workers={workers} projects={projects} settings={settings} />
            )}
            <LiveKPIs refreshToken={liveKpiRefreshToken} />
            {plan.isBusiness && settings?.feature_broadcast !== false ? <BroadcastMessage /> : null}
            {settings?.feature_chat !== false ? (
              <div style={styles.liveLayout} className="live-layout">
                <div style={styles.liveMain}>
                  <Suspense fallback={<TabLoader />}>
                    <LiveWorkers timezone={settings?.company_timezone ?? ''} showInactiveAlerts={settings?.feature_inactive_alerts !== false} projects={projects} settings={settings} onWorkforceChange={refreshLiveMetrics} />
                  </Suspense>
                </div>
                <div style={styles.liveChat}><CompanyChat workers={workers} settings={settings} /></div>
              </div>
            ) : (
              <Suspense fallback={<TabLoader />}>
                <LiveWorkers timezone={settings?.company_timezone ?? ''} showInactiveAlerts={settings?.feature_inactive_alerts !== false} projects={projects} settings={settings} onWorkforceChange={refreshLiveMetrics} />
              </Suspense>
            )}
          </>
        ) : tab === 'approvals' ? (
          <Suspense fallback={<TabLoader />}>
            <h2 style={styles.heading}>{t.tabApprovals}</h2>
            <ApprovalQueue onCountChange={setPendingCount} settings={settings} />
            {canDo('approve_entries') && <ManagePayPeriods />}
          </Suspense>
        ) : tab === 'reports' ? (
          <Suspense fallback={<TabLoader />}>
            <h2 style={styles.heading}>{t.tabReports}</h2>
            <button ref={el => { sectionRefs.current.workers = el; }} type="button" style={styles.sectionToggle} onClick={() => toggleSection('workers')}>
              <span>{`${workerLabel} reports`}</span>
              <span style={styles.chevron}>{collapsedSections.workers ? '▶' : '▼'}</span>
            </button>
            {!collapsedSections.workers && (workers.length === 0
              ? <p style={{ color: '#666' }}>{`No ${workerLabelPlural.toLowerCase()} yet.`}</p>
              : (() => {
                  const PAGE = 8;
                  const pages = Math.max(1, Math.ceil(workers.length / PAGE));
                  const page = Math.min(reportPage, pages - 1);
                  const slice = workers.slice(page * PAGE, page * PAGE + PAGE);
                  return (
                    <>
                      <div style={styles.memberTable}>
                        {slice.map(w => (
                          <React.Fragment key={w.id}>
                            <MemberReportRow worker={w} overtimeEnabled={settings?.feature_overtime !== false}
                              selected={expandedReportWorkers.has(w.id)}
                              onSelect={() => toggleReportWorker(w.id)} />
                            {expandedReportWorkers.has(w.id) && (
                              <div ref={w.id === lastOpenedWorker ? reportPanelRef : undefined}>
                                <Suspense fallback={<TabLoader />}>
                                  <WorkerMetrics key={w.id} worker={w} embedded currency={settings?.currency ?? 'USD'} companyInfo={companyInfo} overtimeEnabled={settings?.feature_overtime !== false} projectsEnabled={settings?.feature_project_integration !== false} projects={projects} settings={settings} />
                                </Suspense>
                              </div>
                            )}
                          </React.Fragment>
                        ))}
                      </div>
                      {pages > 1 && (
                        <div style={styles.pager}>
                          <button style={{ ...styles.pagerBtn, ...(page === 0 ? styles.pagerBtnOff : {}) }} disabled={page === 0} onClick={() => setReportPage(p => Math.max(0, p - 1))}>‹ {t.paginationPrev}</button>
                          <span style={styles.pagerInfo}>{t.paginationPageOf.replace('{n}', page + 1).replace('{total}', pages)}</span>
                          <button style={{ ...styles.pagerBtn, ...(page >= pages - 1 ? styles.pagerBtnOff : {}) }} disabled={page >= pages - 1} onClick={() => setReportPage(p => Math.min(pages - 1, p + 1))}>{t.paginationNext} ›</button>
                        </div>
                      )}
                    </>
                  );
                })()
            )}
            {settings?.feature_project_integration !== false && <>
              <button ref={el => { sectionRefs.current.projects = el; }} type="button" style={styles.sectionToggle} onClick={() => toggleSection('projects')}>
                <span>{`Projects reports`}</span>
                <span style={styles.chevron}>{collapsedSections.projects ? '▶' : '▼'}</span>
              </button>
              {!collapsedSections.projects && <Suspense fallback={<TabLoader />}><ProjectReports currency={settings?.currency ?? 'USD'} settings={settings} /></Suspense>}
            </>}
            {/* Hours register + timesheet export are the free base-plan reporting (not the Advanced Payroll add-on). */}
            {settings?.feature_overtime !== false && <>
              <button ref={el => { sectionRefs.current.overtime = el; }} type="button" style={styles.sectionToggle} onClick={() => toggleSection('overtime')}>
                <span>{t.overtimeReport}</span>
                <span style={styles.chevron}>{collapsedSections.overtime ? '▶' : '▼'}</span>
              </button>
              {!collapsedSections.overtime && (plan.isStarter ? <Suspense fallback={<TabLoader />}><OvertimeReport currency={settings?.currency ?? 'USD'} /></Suspense> : <UpgradePrompt requiredPlan="starter" feature={t.overtimeReport} />)}
            </>}
            <button ref={el => { sectionRefs.current.export = el; }} type="button" style={styles.sectionToggle} onClick={() => toggleSection('export')}>
              <span>{t.export}</span>
              <span style={styles.chevron}>{collapsedSections.export ? '▶' : '▼'}</span>
            </button>
            {!collapsedSections.export && (plan.isStarter ? <Suspense fallback={<TabLoader />}><ExportPanel workers={workers} projects={projects} settings={settings} /></Suspense> : <UpgradePrompt requiredPlan="starter" feature={t.export} />)}
          </Suspense>
        ) : tab === 'payroll' ? (
          <Suspense fallback={<TabLoader />}>
            <h2 style={styles.heading}>{t.tabPayroll}</h2>
            {plan.hasAdvancedPayroll ? (
              <>
                <p style={styles.payrollIntro}>
                  {t.payrollTabIntro}{' '}
                  <button type="button" style={styles.payrollConfigLink} onClick={() => { window.location.href = '/administration#workspace'; }}>{t.payrollTabConfigure}</button>
                </p>
                <Suspense fallback={<TabLoader />}><PayrollRun currency={settings?.currency ?? 'USD'} onFinalized={() => setPayrollHistoryKey(k => k + 1)} /></Suspense>
                <Suspense fallback={<TabLoader />}><PayrollHistory currency={settings?.currency ?? 'USD'} refreshKey={payrollHistoryKey} /></Suspense>
                {canDo('view_certified_payroll') && (
                  <Suspense fallback={<TabLoader />}><CertifiedPayroll projects={projects} settings={settings} requireSignature={settings?.cp_require_signature !== false} wh347Format={settings?.cp_wh347_format !== false} /></Suspense>
                )}
              </>
            ) : (
              <UpgradePrompt requiredPlan="advanced_payroll" feature={t.tabPayroll} />
            )}
          </Suspense>
        ) : tab === 'timeoff' && settings?.feature_pto !== false ? (
          <Suspense fallback={<TabLoader />}>
            <AdminTimeOff settings={settings} />
          </Suspense>
        ) : tab === 'expenses' && settings?.feature_reimbursements !== false ? (
          <Suspense fallback={<TabLoader />}>
            <ReimbursementsAdmin settings={settings} />
          </Suspense>
        ) : tab === 'manage' ? (
          <Suspense fallback={<TabLoader />}>
            {settings?.feature_scheduling !== false && <ManageSchedule workers={workers} projects={projects} weekStart={settings?.week_start ?? 1} settings={settings} />}
          </Suspense>
        ) : null}
          </ErrorBoundary>
        )}
    </>
  );
}

const styles = {
  page: { minHeight: '100vh', background: '#f4f6f9', '--ops-page-accent': '#1d4ed8' },
  header: { background: 'var(--ops-page-accent)', color: '#fff', padding: '0 24px', paddingTop: 'env(safe-area-inset-top)', paddingBottom: 0, minHeight: 'calc(56px + env(safe-area-inset-top))', display: 'flex', flexDirection: 'column', justifyContent: 'center', position: 'sticky', top: 0, zIndex: 100 },
  headerTopRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', height: 56 },
  logoGroup: { display: 'flex', alignItems: 'center', gap: 10 },
  companyName: { fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)' },
  headerRight: { display: 'flex', gap: 10 },
  headerBtn: { background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', padding: '6px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  main: { maxWidth: 900, margin: '18px auto 32px', padding: '0 16px' },
  tabs: { display: 'flex', gap: 4, marginBottom: 24, background: '#e8edf5', borderRadius: 10, padding: 4, width: '100%', overflowX: 'auto', flexWrap: 'nowrap', scrollbarWidth: 'none' },
  tab: { flex: 1, padding: '9px 0', background: 'none', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 14, color: '#666', cursor: 'pointer', whiteSpace: 'nowrap', textAlign: 'center' },
  tabActive: { flex: 1, padding: '9px 0', background: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 14, color: 'var(--ops-page-accent)', cursor: 'pointer', boxShadow: '0 1px 4px rgba(0,0,0,0.1)', whiteSpace: 'nowrap', textAlign: 'center' },
  heading: { marginBottom: 20, fontSize: 22 },
  payrollIntro: { fontSize: 14, color: '#555', margin: '-8px 0 20px', lineHeight: 1.5, maxWidth: 640 },
  payrollConfigLink: { background: 'none', border: 'none', color: 'var(--ops-page-accent)', fontWeight: 600, cursor: 'pointer', padding: 0, fontSize: 14, textDecoration: 'underline' },
  subheading: { fontSize: 18, fontWeight: 600, margin: '32px 0 16px' },
  sectionToggle: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 16px', fontSize: 16, fontWeight: 600, color: '#111827', cursor: 'pointer', marginTop: 24, marginBottom: 4, textAlign: 'left', scrollMarginTop: 16 },
  chevron: { fontSize: 11, color: '#6b7280' },
  memberTable: { background: '#fff', borderRadius: 10, boxShadow: '0 1px 6px rgba(0,0,0,0.07)', overflow: 'hidden', marginTop: 4 },
  pager: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 12 },
  pagerBtn: { background: '#fff', border: '1px solid #d1d5db', borderRadius: 7, padding: '6px 14px', fontSize: 13, fontWeight: 600, color: '#374151', cursor: 'pointer' },
  pagerBtnOff: { opacity: 0.45, cursor: 'not-allowed' },
  pagerInfo: { fontSize: 13, color: '#6b7280', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  trialBanner: { padding: '10px 24px', border: '1px solid', fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 10 },
  trialUpgradeBtn: { background: 'none', border: 'none', fontWeight: 700, textDecoration: 'underline', cursor: 'pointer', fontSize: 14, color: 'inherit', padding: 0 },
  liveLayout: { display: 'grid', gridTemplateColumns: '1fr 340px', gap: 20, alignItems: 'start' },
  liveMain: {},
  liveChat: {},
  errorBanner: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', borderRadius: 8, padding: '16px 20px', fontSize: 14 },
  retryBtn: { background: 'none', border: 'none', color: '#991b1b', fontWeight: 700, textDecoration: 'underline', cursor: 'pointer', padding: 0, fontSize: 14 },
  accountCard: { background: '#fff', borderRadius: 12, padding: '14px 18px', boxShadow: '0 1px 6px rgba(0,0,0,0.06)', marginBottom: 24 },
  accountRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
  accountLabel: { fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 2 },
  accountSub: { fontSize: 12, color: '#6b7280' },
  accountBtn: { background: 'none', border: '1px solid #d1d5db', color: '#374151', padding: '7px 16px', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 },
  supportNote: { fontSize: 13, color: '#6b7280', textAlign: 'center', padding: '8px 0 4px' },
};
