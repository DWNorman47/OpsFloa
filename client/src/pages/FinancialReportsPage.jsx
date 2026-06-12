// Financial reports: P&L portfolio + WIP. Read-only aggregations over
// everything the money-flow modules have shipped. The backend endpoints
// guard cross-module reads with tableExists so this page renders cleanly
// even on environments where some optional modules aren't migrated yet.

import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import api from '../api';
import { PageShell } from '../components/PageShell';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import { silentError } from '../errorReporter';

function formatCents(cents) {
  const n = (parseInt(cents, 10) || 0) / 100;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}
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

// ── P&L portfolio ────────────────────────────────────────────────────────────

function PnLTab() {
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
        title="No P&L data yet"
        body="Once you have active projects with revenue (invoices) and spend (time entries, sub PO payments, expenses), they'll appear here."
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
            <th style={styles.th}>Project</th>
            <th style={{ ...styles.th, textAlign: 'right' }}>Contract</th>
            <th style={{ ...styles.th, textAlign: 'right' }}>Billed</th>
            <th style={{ ...styles.th, textAlign: 'right' }}>Spent</th>
            <th style={{ ...styles.th, textAlign: 'right' }}>Committed</th>
            <th style={{ ...styles.th, textAlign: 'right' }}>Gross profit</th>
            <th style={{ ...styles.th, textAlign: 'right' }}>Projected margin</th>
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
            <td style={{ ...styles.td, fontWeight: 700 }}>Total</td>
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
    const token = sessionStorage.getItem('tc_token') || localStorage.getItem('tc_token');
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
    return <EmptyState title="No active projects" body="Open at least one project to see WIP." />;
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 13, color: '#6b7280' }}>
          As of {new Date(report.as_of).toLocaleDateString()}
        </div>
        <button onClick={downloadCsv} style={styles.ghostBtn}>Download CSV</button>
      </div>
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr style={styles.tableHeader}>
              <th style={styles.th}>Project</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>Contract</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>Cost to date</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>% Complete</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>Earned revenue</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>Billed to date</th>
              <th style={{ ...styles.th, textAlign: 'right' }}>Over / Under</th>
              <th style={styles.th}>Status</th>
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
                  {p.status === 'over_billed'  && <span style={{ ...styles.chip, background: '#fef3c7', color: '#92400e' }}>Over-billed</span>}
                  {p.status === 'under_billed' && <span style={{ ...styles.chip, background: '#fee2e2', color: '#991b1b' }}>Under-billed</span>}
                  {p.status === 'on_target'    && <span style={{ ...styles.chip, background: '#d1fae5', color: '#065f46' }}>On target</span>}
                </td>
              </tr>
            ))}
            <tr style={{ background: '#f9fafb', borderTop: '2px solid #111827' }}>
              <td style={{ ...styles.td, fontWeight: 700 }}>Total</td>
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
  const [tab, setTab] = useState('pnl');

  return (
    <PageShell currentApp="analytics" maxWidth={1200} headerProps={{ userRole: user?.role }}>
      <div className="admin-page-shell">
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 16px', color: '#111827' }}>Financial Reports</h1>
        <div style={styles.tabRow}>
          <button
            onClick={() => setTab('pnl')}
            style={{ ...styles.tabBtn, ...(tab === 'pnl' ? styles.tabBtnActive : {}) }}
          >
            P&L by project
          </button>
          <button
            onClick={() => setTab('wip')}
            style={{ ...styles.tabBtn, ...(tab === 'wip' ? styles.tabBtnActive : {}) }}
          >
            WIP report
          </button>
        </div>
        {tab === 'pnl' && <PnLTab />}
        {tab === 'wip' && <WipTab />}
      </div>
    </PageShell>
  );
}

const styles = {
  tabRow: { display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #e5e7eb' },
  tabBtn: { background: 'transparent', border: 'none', borderBottom: '2px solid transparent', padding: '10px 16px', fontSize: 14, fontWeight: 600, color: '#6b7280', cursor: 'pointer' },
  tabBtnActive: { borderBottomColor: 'var(--ops-page-accent)', color: 'var(--ops-page-accent)' },
  ghostBtn: { background: '#fff', color: '#374151', border: '1px solid #d1d5db', padding: '8px 14px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  tableWrap: { background: '#fff', borderRadius: 8, boxShadow: '0 1px 2px rgba(0,0,0,0.04)', overflow: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 },
  tableHeader: { background: '#f9fafb', borderBottom: '1px solid #e5e7eb' },
  th: { textAlign: 'left', padding: '10px 14px', fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' },
  td: { padding: '12px 14px', color: '#111827' },
  chip: { fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.04em' },
};
