import React, { useState, useEffect } from 'react';
import api from '../api';
import { fmtHours, formatCurrency } from '../utils';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { SkeletonList } from './Skeleton';
import { handlePdfError } from '../pdfError';
import { labelSg, labelPl } from '../companyLabels';
import { downloadCsv } from '../utils/csv';

function defaultDates() {
  const today = new Date();
  const fmt = d => d.toLocaleDateString('en-CA');
  // Last full week: Sunday through Saturday
  const day = today.getDay(); // 0=Sun, 1=Mon, … 6=Sat
  const daysToLastSat = day === 6 ? 7 : day + 1;
  const sat = new Date(today);
  sat.setDate(today.getDate() - daysToLastSat);
  const sun = new Date(sat);
  sun.setDate(sat.getDate() - 6);
  return { from: fmt(sun), to: fmt(sat) };
}

export default function ProjectReports({ currency = 'USD', settings = null }) {
  const t = useT();
  const { user } = useAuth();
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const workerLabel = labelSg(settings?.label_worker, 'worker', user?.language);
  const workerLabelLower = workerLabel.toLowerCase();
  const workerLabelPluralLower = labelPl(settings?.label_worker, 'worker', user?.language).toLowerCase();

  useEffect(() => {
    api.get('/admin/projects/metrics')
      .then(r => setProjects(r.data))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <SkeletonList count={4} rows={3} />;
  if (projects.length === 0) return <p style={{ color: '#666' }}>{`No projects yet.`}</p>;

  return (
    <div style={styles.list}>
      {projects.map(p => <ProjectCard key={p.id} project={p} currency={currency} workerLabel={workerLabel} workerLabelLower={workerLabelLower} workerLabelPluralLower={workerLabelPluralLower} settings={settings} />)}
    </div>
  );
}

function ProjectCard({ project: p, currency = 'USD', workerLabel = 'Worker', workerLabelLower = 'worker', workerLabelPluralLower = 'workers', settings = null }) {
  const t = useT();
  const { user } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [from, setFrom] = useState(defaultDates().from);
  const [to, setTo] = useState(defaultDates().to);
  const [billData, setBillData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [pdfGenerating, setPdfGenerating] = useState(false);

  const fetchBill = async () => {
    setLoading(true);
    try {
      const params = {};
      if (from) params.from = from;
      if (to) params.to = to;
      const r = await api.get(`/admin/projects/${p.id}/entries`, { params });
      setBillData(r.data);
    } finally {
      setLoading(false);
    }
  };

  const makeBillElement = async () => {
    const [{ pdf }, { default: ProjectBillPDF }] = await Promise.all([
      import('@react-pdf/renderer'),
      import('./ProjectBillPDF'),
    ]);
    const el = React.createElement(ProjectBillPDF, { data: billData, currency, t, language: user?.language, settings });
    return { pdf, el };
  };

  const downloadPDF = async () => {
    setPdfGenerating(true);
    try {
      const { pdf, el } = await makeBillElement();
      const blob = await pdf(el).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `bill-${p.name.replace(/\s+/g, '-')}-${from || 'all'}-to-${to || 'all'}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      handlePdfError(err, t.pdfFailed);
    } finally { setPdfGenerating(false); }
  };

  const togglePreview = async () => {
    if (showPreview) {
      setShowPreview(false);
      return;
    }
    setPdfGenerating(true);
    try {
      const { pdf, el } = await makeBillElement();
      const blob = await pdf(el).toBlob();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
      setShowPreview(true);
    } catch (err) {
      handlePdfError(err, t.pdfFailed);
    } finally { setPdfGenerating(false); }
  };

  return (
    <div style={styles.card}>
      <div style={styles.cardTop} onClick={() => setExpanded(e => !e)} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setExpanded(prev => !prev)}>
        <div style={styles.cardHeader}>
          <span style={styles.name}>{p.name}</span>
          <div style={styles.headerRight}>
            <span style={styles.sub}>{p.worker_count} {p.worker_count === 1 ? workerLabelLower : workerLabelPluralLower} · {p.total_entries} entr{p.total_entries !== 1 ? 'ies' : 'y'}</span>
            <span style={styles.expandBtn}>{expanded ? '▲' : '▼'}</span>
          </div>
        </div>
        <div style={styles.metrics}>
          <Metric label={t.totalLabel} value={fmtHours(parseFloat(p.total_hours))} />
          {parseFloat(p.regular_hours) > 0 && <Metric label={t.regularLabel} value={fmtHours(parseFloat(p.regular_hours))} color="#2563eb" />}
          {parseFloat(p.overtime_hours) > 0 && <Metric label={t.overtimeLabel} value={fmtHours(parseFloat(p.overtime_hours))} color="#dc2626" />}
          {parseFloat(p.prevailing_hours) > 0 && <Metric label={t.prevailingLabel} value={fmtHours(parseFloat(p.prevailing_hours))} color="#d97706" />}
          {parseFloat(p.estimated_cost) > 0 && <Metric label={t.projEstCost} value={formatCurrency(parseFloat(p.estimated_cost), currency)} color="#059669" />}
        </div>
        <div style={styles.barContainer}>
          <HoursBar regular={parseFloat(p.regular_hours)} overtime={parseFloat(p.overtime_hours)} prevailing={parseFloat(p.prevailing_hours)} />
        </div>
        {p.budget_hours && (
          <BudgetBar used={parseFloat(p.total_hours)} budget={parseFloat(p.budget_hours)} label="hrs" />
        )}
        {p.budget_dollars && parseFloat(p.estimated_cost) >= 0 && (
          <BudgetBar used={parseFloat(p.estimated_cost)} budget={parseFloat(p.budget_dollars)} label="$" money currency={currency} />
        )}
      </div>

      {expanded && (
        <div style={styles.billSection}>
          <h4 style={styles.billHeading}>{t.generateBillHeading}</h4>
          <div style={styles.dateRow}>
            <div style={styles.dateField}>
              <label style={styles.label}>{t.qboFrom}</label>
              <input style={styles.input} type="date" value={from} onChange={e => setFrom(e.target.value)} />
            </div>
            <div style={styles.dateField}>
              <label style={styles.label}>{t.qboTo}</label>
              <input style={styles.input} type="date" value={to} onChange={e => setTo(e.target.value)} />
            </div>
            <button style={{ ...styles.fetchBtn, ...(loading ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={fetchBill} disabled={loading}>
              {loading ? t.loading : t.loadEntries}
            </button>
          </div>

          {billData && (
            <div style={{ marginTop: 16 }}>
              <div style={styles.billSummary}>
                <span>{t.entriesLabel}: <b>{billData.entries.length}</b></span>
                <span>{t.totalLabel}: <b>{fmtHours(billData.summary.total_hours)}</b></span>
                {billData.summary.regular_hours > 0 && <span style={{ color: '#2563eb' }}>{t.regularLabel}: <b>{fmtHours(billData.summary.regular_hours)} · {formatCurrency(billData.summary.regular_cost, currency)}</b></span>}
                {billData.summary.overtime_hours > 0 && <span style={{ color: '#dc2626' }}>{t.overtimeLabel}: <b>{fmtHours(billData.summary.overtime_hours)} · {formatCurrency(billData.summary.overtime_cost, currency)}</b></span>}
                {billData.summary.prevailing_hours > 0 && <span style={{ color: '#d97706' }}>{t.prevailingLabel}: <b>{fmtHours(billData.summary.prevailing_hours)} · {formatCurrency(billData.summary.prevailing_cost, currency)}</b></span>}
                <span style={{ fontWeight: 700 }}>{t.totalCostLabel}: <b>{formatCurrency(billData.summary.total_cost, currency)}</b></span>
              </div>
              <div style={styles.btnRow}>
                <button style={{ ...styles.previewBtn, ...(pdfGenerating ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={togglePreview} disabled={pdfGenerating}>
                  {pdfGenerating ? t.preparing : showPreview ? t.hidePreview : t.previewBill}
                </button>
                <button style={styles.csvBtn} onClick={() => {
                  const headers = ['Date', workerLabel, 'Wage Type', 'Start', 'End', 'Hours'];
                  const rows = billData.entries.map(e => {
                    const h = ((new Date(`1970-01-01T${e.end_time}`) - new Date(`1970-01-01T${e.start_time}`)) / 3600000).toFixed(2);
                    return [e.work_date?.toString().substring(0,10), e.worker_name, e.wage_type, e.start_time, e.end_time, h];
                  });
                  downloadCsv([headers, ...rows], `${p.name.replace(/\s+/g,'-')}-${from||'all'}-to-${to||'all'}.csv`);
                }}>{t.exportCSV}</button>
                <button style={{ ...styles.pdfBtn, ...(pdfGenerating ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={downloadPDF} disabled={pdfGenerating}>
                  {pdfGenerating ? t.preparingPDF : t.downloadPDF}
                </button>
              </div>
              {showPreview && previewUrl && (
                <iframe src={previewUrl} style={styles.pdfViewer} title="Bill Preview" />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, color }) {
  return (
    <div style={styles.metric}>
      <span style={{ ...styles.metricVal, color: color || '#222' }}>{value}</span>
      <span style={styles.metricLabel}>{label}</span>
    </div>
  );
}

function BudgetBar({ used, budget, label, money, currency = 'USD' }) {
  const t = useT();
  const pct = Math.min((used / budget) * 100, 100);
  const over = used > budget;
  const color = pct >= 90 ? '#dc2626' : pct >= 70 ? '#d97706' : '#059669';
  const fmt = v => money ? formatCurrency(v, currency) : `${v.toFixed(1)}`;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6b7280', marginBottom: 3 }}>
        <span>{t.budgetLabel} ({label})</span>
        <span style={{ color: over ? '#dc2626' : '#374151', fontWeight: 600 }}>
          {fmt(used)} / {fmt(budget)}{over ? ` — ${t.overBudget}` : ''}
        </span>
      </div>
      <div style={{ height: 6, background: '#f0f0f0', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width 0.3s' }} />
      </div>
    </div>
  );
}

function HoursBar({ regular, overtime, prevailing }) {
  const total = regular + overtime + prevailing;
  if (total === 0) return null;
  const pct = v => `${((v / total) * 100).toFixed(1)}%`;
  return (
    <div style={styles.bar}>
      {regular > 0 && <div style={{ ...styles.barSegment, width: pct(regular), background: '#2563eb' }} title={`Regular: ${fmtHours(regular)}`} />}
      {overtime > 0 && <div style={{ ...styles.barSegment, width: pct(overtime), background: '#dc2626' }} title={`Overtime: ${fmtHours(overtime)}`} />}
      {prevailing > 0 && <div style={{ ...styles.barSegment, width: pct(prevailing), background: '#d97706' }} title={`Prevailing: ${fmtHours(prevailing)}`} />}
    </div>
  );
}

const styles = {
  list: { display: 'flex', flexDirection: 'column', gap: 16 },
  card: { background: '#fff', borderRadius: 12, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', overflow: 'hidden' },
  cardTop: { padding: '18px 20px', cursor: 'pointer' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  headerRight: { display: 'flex', alignItems: 'center', gap: 10 },
  name: { fontWeight: 700, fontSize: 17 },
  sub: { color: '#6b7280', fontSize: 13 },
  metrics: { display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12 },
  metric: { display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 60 },
  metricVal: { fontWeight: 700, fontSize: 20 },
  metricLabel: { fontSize: 11, color: '#999', textTransform: 'uppercase', letterSpacing: 0.5 },
  barContainer: { marginTop: 4 },
  bar: { display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: '#f0f0f0' },
  barSegment: { height: '100%', transition: 'width 0.3s' },
  expandBtn: { color: '#aaa', fontSize: 12 },
  billSection: { padding: '16px 20px', borderTop: '1px solid #f0f0f0', background: '#fafafa' },
  billHeading: { marginBottom: 12, fontSize: 15, fontWeight: 600 },
  dateRow: { display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' },
  dateField: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 12, fontWeight: 600, color: '#666' },
  input: { padding: '8px 10px', border: '1px solid #ddd', borderRadius: 7, fontSize: 14 },
  fetchBtn: { padding: '8px 18px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 14, cursor: 'pointer' },
  billSummary: { display: 'flex', gap: 20, fontSize: 14, flexWrap: 'wrap', marginBottom: 12 },
  btnRow: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  previewBtn: { padding: '10px 20px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer' },
  csvBtn: { padding: '10px 20px', background: '#0f766e', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer' },
  pdfBtn: { display: 'inline-block', padding: '10px 20px', background: '#059669', color: '#fff', borderRadius: 8, fontWeight: 600, fontSize: 14, textDecoration: 'none' },
  pdfViewer: { width: '100%', height: 600, marginTop: 16, borderRadius: 8, border: '1px solid #e5e7eb' },
};
