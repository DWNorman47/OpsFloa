// Financial reports: P&L portfolio + WIP. Read-only aggregations over
// everything the money-flow modules have shipped. The backend endpoints
// guard cross-module reads with tableExists so this page renders cleanly
// even on environments where some optional modules aren't migrated yet.

import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';
import { langToLocale, formatDate } from '../utils';
import api from '../api';
import { getOrFetch } from '../offlineDb';
import { PageShell } from '../components/PageShell';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import TabBar from '../components/TabBar';
import { AnalyticsPanel } from './AnalyticsPage';
import { silentError } from '../errorReporter';
import { useCents } from '../hooks/useMoney';
import { safeLocal, safeSession } from '../utils/safeStorage';

function marginColor(pct) {
  if (pct == null) return '#6b7280';
  if (pct >= 25)  return '#059669';
  if (pct >= 15)  return '#d97706';
  if (pct >= 0)   return '#dc2626';
  return '#991b1b';
}
function deltaColor(cents) {
  if (cents == null) return '#6b7280';
  if (Math.abs(cents) < 50000) return '#059669'; // within ±$500 → green
  return cents > 0 ? '#d97706' : '#dc2626';
}

const REPORT_TABS = ['performance', 'pnl', 'wip'];
const REPORT_TAB_ALIASES = {
  analytics: 'performance',
  profit: 'pnl',
  'p-and-l': 'pnl',
};

function normalizeReportHash(rawHash) {
  const hash = String(rawHash || '').replace('#', '').trim().toLowerCase();
  return REPORT_TAB_ALIASES[hash] || hash;
}

// ── P&L portfolio ────────────────────────────────────────────────────────────

function PnLTab() {
  const formatCents = useCents({ showCents: false });
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/projects/pnl-summary')
      .then(({ data }) => setRows(data.projects || []))
      .catch(silentError)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <SkeletonList rows={4} />;
  if (!rows.length) {
    return (
      <EmptyState
        title={t.frPnlEmptyTitle}
        body={t.frPnlEmptyBody}
      />
    );
  }

  const totals = rows.reduce((acc, r) => ({
    contract:  acc.contract  + (parseInt(r.contract_value_cents, 10) || 0),
    billed:    acc.billed    + (parseInt(r.revenue_billed_cents, 10) || 0),
    spent:     acc.spent     + (parseInt(r.cost_spent_cents, 10) || 0),
    committed: acc.committed + (parseInt(r.cost_committed_cents, 10) || 0),
    gross:     acc.gross     + (parseInt(r.gross_profit_cents, 10) || 0),
    projected: acc.projected + (parseInt(r.projected_profit_cents, 10) || 0),
  }), { contract: 0, billed: 0, spent: 0, committed: 0, gross: 0, projected: 0 });

  return (
    <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead>
          <tr style={styles.tableHeader}>
            <th style={styles.th}>{t.frColProject}</th>
            <th style={{ ...styles.th, textAlign: 'right' }}>{t.frColContract}</th>
            <th style={{ ...styles.th, textAlign: 'right' }}>{t.frColBilled}</th>
            <th style={{ ...styles.th, textAlign: 'right' }}>{t.frColSpent}</th>
            <th style={{ ...styles.th, textAlign: 'right' }}>{t.frColCommitted}</th>
            <th style={{ ...styles.th, textAlign: 'right' }}>{t.frColGrossProfit}</th>
            <th style={{ ...styles.th, textAlign: 'right' }}>{t.frColProjectedMargin}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.project_id} style={{ borderBottom: '1px solid #f3f4f6' }}>
              <td style={styles.td}><strong>{r.name}</strong></td>
              <td style={{ ...styles.td, textAlign: 'right' }}>{formatCents(r.contract_value_cents)}</td>
              <td style={{ ...styles.td, textAlign: 'right' }}>{formatCents(r.revenue_billed_cents)}</td>
              <td style={{ ...styles.td, textAlign: 'right' }}>{formatCents(r.cost_spent_cents)}</td>
              <td style={{ ...styles.td, textAlign: 'right', color: '#6b7280' }}>{formatCents(r.cost_committed_cents)}</td>
              <td style={{ ...styles.td, textAlign: 'right', fontWeight: 600, color: r.gross_profit_cents < 0 ? '#dc2626' : '#111827' }}>{formatCents(r.gross_profit_cents)}</td>
              <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700, color: marginColor(r.projected_margin_pct) }}>
                {r.projected_margin_pct == null ? '—' : `${r.projected_margin_pct.toFixed(1)}%`}
              </td>
            </tr>
          ))}
          <tr style={{ background: '#f9fafb', borderTop: '2px solid #111827' }}>
            <td style={{ ...styles.td, fontWeight: 700 }}>{t.frTotal}</td>
            <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{formatCents(totals.contract)}</td>
            <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{formatCents(totals.billed)}</td>
            <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{formatCents(totals.spent)}</td>
            <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{formatCents(totals.committed)}</td>
            <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{formatCents(totals.gross)}</td>
            <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>—</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ── WIP report ───────────────────────────────────────────────────────────────

function WipTab() {
  const formatCents = useCents({ showCents: false });
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/wip-report')
      .then(({ data }) => setReport(data))
      .catch(silentError)
      .finally(() => setLoading(false));
  }, []);

  function downloadCsv() {
    const url = `${api.defaults.baseURL}/wip-report/export`;
    // Authenticated download — open via fetch with header so the API
    // Authorization cookie isn't required.
    const token = safeSession.getItem('tc_token') || safeLocal.getItem('tc_token');
    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.blob())
      .then(blob => {
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = `wip-report-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(objectUrl);
      })
      .catch(silentError);
  }

  if (loading) return <SkeletonList rows={4} />;
  if (!report?.projects?.length) {
    return <EmptyState title={t.frWipEmptyTitle} body={t.frWipEmptyBody} />;
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 13, color: '#6b7280' }}>
          {t.frAsOf} {formatDate(report.as_of, user?.language)}
        </div>
        <button onClick={downloadCsv} style={styles.ghostBtn}>{t.frDownloadCsv}</button>
      </div>
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr style={styles.tableHeader}>
              <th style={styles.th}>{t.frColProject}</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>{t.frColContract}</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>{t.frColCostToDate}</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>{t.frColPctComplete}</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>{t.frColEarnedRevenue}</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>{t.frColBilledToDate}</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>{t.frColOverUnder}</th>
              <th style={styles.th}>{t.frColStatus}</th>
            </tr>
          </thead>
          <tbody>
            {report.projects.map(p => (
              <tr key={p.project_id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={styles.td}><strong>{p.name}</strong></td>
                <td style={{ ...styles.td, textAlign: 'right' }}>{formatCents(p.contract_value_cents)}</td>
                <td style={{ ...styles.td, textAlign: 'right' }}>{formatCents(p.cost_to_date_cents)}</td>
                <td style={{ ...styles.td, textAlign: 'right' }}>{p.pct_complete == null ? '—' : `${p.pct_complete.toFixed(1)}%`}</td>
                <td style={{ ...styles.td, textAlign: 'right' }}>{formatCents(p.earned_revenue_cents)}</td>
                <td style={{ ...styles.td, textAlign: 'right' }}>{formatCents(p.billed_to_date_cents)}</td>
                <td style={{ ...styles.td, textAlign: 'right', fontWeight: 600, color: deltaColor(p.over_under_billed_cents) }}>
                  {formatCents(p.over_under_billed_cents)}
                </td>
                <td style={styles.td}>
                  {p.status === 'over_billed'  && <span style={{ ...styles.chip, background: '#fef3c7', color: '#92400e' }}>{t.frStatusOverBilled}</span>}
                  {p.status === 'under_billed' && <span style={{ ...styles.chip, background: '#fee2e2', color: '#991b1b' }}>{t.frStatusUnderBilled}</span>}
                  {p.status === 'on_target'    && <span style={{ ...styles.chip, background: '#d1fae5', color: '#065f46' }}>{t.frStatusOnTarget}</span>}
                </td>
              </tr>
            ))}
            <tr style={{ background: '#f9fafb', borderTop: '2px solid #111827' }}>
              <td style={{ ...styles.td, fontWeight: 700 }}>{t.frTotal}</td>
              <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{formatCents(report.totals.contract_value_cents)}</td>
              <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{formatCents(report.totals.cost_to_date_cents)}</td>
              <td style={{ ...styles.td, textAlign: 'right' }}>—</td>
              <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{formatCents(report.totals.earned_revenue_cents)}</td>
              <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>{formatCents(report.totals.billed_to_date_cents)}</td>
              <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700, color: deltaColor(report.totals.over_under_billed_cents) }}>
                {formatCents(report.totals.over_under_billed_cents)}
              </td>
              <td style={styles.td}></td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── Page shell ───────────────────────────────────────────────────────────────

export default function FinancialReportsPage() {
  const { user } = useAuth();
  const t = useT();
  const [settings, setSettings] = useState(null);
  const [settingsLoading, setSettingsLoading] = useState(true);

  useEffect(() => {
    getOrFetch('settings', () => api.get('/settings').then(r => r.data))
      .then(setSettings)
      .catch(silentError('reports-settings'))
      .finally(() => setSettingsLoading(false));
  }, []);

  // Performance (Analytics) follows module_analytics; P&L/WIP follow
  // module_financial_reports. Before settings load, undefined !== false keeps
  // everything visible so deep links resolve.
  const showPerformance = settings?.module_analytics !== false;
  const showFinancial = settings?.module_financial_reports !== false;

  const tabs = [
    ...(showPerformance ? [{ id: 'performance', label: t.frTabPerformance }] : []),
    ...(showFinancial ? [{ id: 'pnl', label: t.frTabPnl }] : []),
    ...(showFinancial ? [{ id: 'wip', label: t.frTabWip }] : []),
  ];
  const tabIds = tabs.map(tb => tb.id);
  const [tab, setTab] = useState(() => {
    const hashTab = normalizeReportHash(window.location.hash);
    return REPORT_TABS.includes(hashTab) ? hashTab : 'performance';
  });
  const switchTab = id => { setTab(id); history.replaceState(null, '', '#' + id); };
  const activeTab = tabIds.includes(tab) ? tab : (tabIds[0] || 'performance');

  useEffect(() => {
    const syncFromHash = () => {
      const hashTab = normalizeReportHash(window.location.hash);
      if (REPORT_TABS.includes(hashTab)) setTab(hashTab);
    };
    syncFromHash();
    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, []);

  return (
    <PageShell currentApp="financial_reports" features={settings || {}} maxWidth={1200} headerProps={{ userRole: user?.role }}>
      <div className="admin-page-shell">
        {tabs.length > 1 && <TabBar active={activeTab} onChange={switchTab} tabs={tabs} />}
        {activeTab === 'performance' && <AnalyticsPanel settings={settings} loading={settingsLoading} />}
        {activeTab === 'pnl' && <PnLTab />}
        {activeTab === 'wip' && <WipTab />}
      </div>
    </PageShell>
  );
}

const styles = {
  ghostBtn: { background: '#fff', color: '#374151', border: '1px solid #d1d5db', padding: '8px 14px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  tableWrap: { background: '#fff', borderRadius: 8, boxShadow: '0 1px 2px rgba(0,0,0,0.04)', overflow: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 },
  tableHeader: { background: '#f9fafb', borderBottom: '1px solid #e5e7eb' },
  th: { textAlign: 'left', padding: '10px 14px', fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' },
  td: { padding: '12px 14px', color: '#111827' },
  chip: { fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.04em' },
};
