import React from 'react';
import { usePlan } from '../hooks/usePlan';
import { useT } from '../hooks/useT';
import AnalyticsDashboard from '../components/AnalyticsDashboard';
import { SkeletonStatRow, SkeletonList } from '../components/Skeleton';

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

// Analytics is the "Performance" tab of the Reports module (see
// FinancialReportsPage). It renders just the dashboard / plan gate; the host
// page provides the shell, header, and module TabBar, and loads `settings`.
export function AnalyticsPanel({ settings, loading }) {
  const plan = usePlan();
  if (loading) {
    return <><SkeletonStatRow count={4} style={{ marginBottom: 16 }} /><SkeletonList count={4} /></>;
  }
  if (!plan.isBusiness) return <UpgradePrompt />;
  return <AnalyticsDashboard weekStart={settings?.week_start ?? 1} settings={settings} />;
}
