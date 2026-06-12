import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { usePlan } from '../hooks/usePlan';
import { useT } from '../hooks/useT';
import api from '../api';
import { getOrFetch } from '../offlineDb';
import { PageIntro, PageShell } from '../components/PageShell';
import AnalyticsDashboard from '../components/AnalyticsDashboard';
import { SkeletonStatRow, SkeletonList } from '../components/Skeleton';

import { silentError } from '../errorReporter';
function UpgradePrompt() {
  const t = useT();
  return (
    <div style={{ background: '#f9fafb', border: '2px dashed #d1d5db', borderRadius: 10, padding: '32px 24px', textAlign: 'center' }}>
      <div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div>
      <div style={{ fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 6 }}>{t.analyticsUpgradeTitle}</div>
      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 16 }}>{t.analyticsUpgradeDesc}</div>
      <button
        style={{ background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '9px 20px', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}
        onClick={() => window.location.href = '/administration#billing'}
      >
        {t.viewPlans}
      </button>
    </div>
  );
}

export default function AnalyticsPage() {
  const { user } = useAuth();
  const t = useT();
  const plan = usePlan();
  const [features, setFeatures] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getOrFetch('settings', () => api.get('/settings').then(r => r.data))
      .then(s => setFeatures(s))
      .catch(silentError('analyticspage'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <PageShell currentApp="analytics" features={features} maxWidth={1100} mainClassName="admin-main">
        <PageIntro
          introId="analytics"
          kicker="Analytics"
          title={t.analyticsTitle}
          description="Trends and reports stay here so everyday screens can stay focused on the next action."
        />
        {loading ? (
          <><SkeletonStatRow count={4} style={{ marginBottom: 16 }} /><SkeletonList count={4} /></>
        ) : plan.isBusiness ? (
          <AnalyticsDashboard weekStart={features?.week_start ?? 1} settings={features} />
        ) : (
          <UpgradePrompt />
        )}
    </PageShell>
  );
}

const HEADER_BG = '#0891b2';

const styles = {
  page: { minHeight: '100vh', background: '#f4f6f9' },
  header: {
    background: HEADER_BG, color: '#fff', padding: '0 24px',
    paddingTop: 'env(safe-area-inset-top)', paddingBottom: 0,
    display: 'flex', flexDirection: 'column', justifyContent: 'center',
    minHeight: 'calc(56px + env(safe-area-inset-top))',
    position: 'sticky', top: 0, zIndex: 100,
  },
  headerTopRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', height: 56 },
  logoGroup: { display: 'flex', alignItems: 'center', gap: 10 },
  companyName: { fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)' },
  headerBtn: { background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', padding: '6px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  main: { maxWidth: 1100, margin: '32px auto', padding: '0 20px' },
  pageHeader: { marginBottom: 24 },
  pageTitle: { fontSize: 28, fontWeight: 800, color: '#111827', margin: 0 },
  loadingText: { color: '#6b7280', fontSize: 14 },
};
