import React, { useState } from 'react';
import api from '../api';
import { fmtHours, formatCurrency } from '../utils';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { handlePdfError } from '../pdfError';
import { labelSg } from '../companyLabels';

function downloadCSV(rows, filename) {
  const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function defaultDates() {
  const today = new Date();
  const fmt = d => d.toLocaleDateString('en-CA');
  // Last full week: Sunday through Saturday
  // daysToLastSat: how many days back to reach the most recent Saturday
  const day = today.getDay(); // 0=Sun, 1=Mon, … 6=Sat
  const daysToLastSat = day === 6 ? 7 : day + 1; // if today is Sat, go back a full week
  const sat = new Date(today);
  sat.setDate(today.getDate() - daysToLastSat);
  const sun = new Date(sat);
  sun.setDate(sat.getDate() - 6);
  return { from: fmt(sun), to: fmt(sat) };
}

export default function WorkerMetrics({ worker, currency = 'USD', companyInfo = {}, overtimeEnabled = true, projectsEnabled = true, projects = [], settings = null }) {
  const t = useT();
  const { user } = useAuth();
  const workLabel = labelSg(settings?.label_work, 'work', user?.language);
  const workLabelLower = workLabel.toLowerCase();
  const [expanded, setExpanded] = useState(false);
  const [from, setFrom] = useState(defaultDates().from);
  const [to, setTo] = useState(defaultDates().to);
  const [billData, setBillData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [pdfGenerating, setPdfGenerating] = useState(false);
  const [showAddEntry, setShowAddEntry] = useState(false);
  const [addForm, setAddForm] = useState({ work_date: defaultDates().to, start_time: '08:00', end_time: '17:00', project_id: '', notes: '', break_minutes: '0' });
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState('');
  const [addSuccess, setAddSuccess] = useState(false);

  const handleAddEntry = async e => {
    e.preventDefault();
    setAddSaving(true); setAddError(''); setAddSuccess(false);
    try {
      await api.post(`/admin/workers/${worker.id}/entries`, {
        work_date: addForm.work_date,
        start_time: addForm.start_time,
        end_time: addForm.end_time,
        project_id: addForm.project_id || null,
        notes: addForm.notes || null,
        break_minutes: parseInt(addForm.break_minutes) || 0,
      });
      setAddSuccess(true);
      setTimeout(() => setAddSuccess(false), 3000);
      setShowAddEntry(false);
      setAddForm({ work_date: defaultDates().to, start_time: '08:00', end_time: '17:00', project_id: '', notes: '', break_minutes: '0' });
      if (billData) fetchBill();
    } catch (err) {
      setAddError(err.response?.data?.error || t.failedAddEntry);
    } finally {
      setAddSaving(false);
    }
  };

  const fetchBill = async () => {
    setLoading(true);
    try {
      const params = {};
      if (from) params.from = from;
      if (to) params.to = to;
      const r = await api.get(`/admin/workers/${worker.id}/entries`, { params });
      setBillData(r.data);
    } finally {
      setLoading(false);
    }
  };

  const makeBillElement = async () => {
    const [{ pdf }, { default: BillPDF }] = await Promise.all([
      import('@react-pdf/renderer'),
      import('./BillPDF'),
    ]);
    const el = React.createElement(BillPDF, { data: billData, currency, companyInfo, overtimeEnabled, showProject: projectsEnabled, showRateType: (companyInfo?.prevailing_wage_rate ?? 0) > 0, t, language: user?.language, settings });
    return { pdf, el };
  };

  const downloadPDF = async () => {
    setPdfGenerating(true);
    try {
      const { pdf, el } = await makeBillElement();
      const blob = await pdf(el).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `bill-${worker.username}-${from || 'all'}-to-${to || 'all'}.pdf`; a.click();
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
      <div style={styles.summary} onClick={() => setExpanded(e => !e)} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setExpanded(prev => !prev)}>
        <div>
          <span style={styles.name}>{worker.full_name}</span>
          <span style={styles.username}>@{worker.username}</span>
        </div>
        <div style={styles.metrics}>
          <Metric label={t.totalMetric} value={fmtHours(parseFloat(worker.total_hours))} />
          {parseFloat(worker.regular_hours) > 0 && <Metric label={t.regularMetric} value={fmtHours(parseFloat(worker.regular_hours))} color="#2563eb" />}
          {overtimeEnabled && parseFloat(worker.overtime_hours) > 0 && <Metric label={t.overtimeMetric} value={fmtHours(parseFloat(worker.overtime_hours))} color="#dc2626" />}
          {parseFloat(worker.prevailing_hours) > 0 && <Metric label={t.prevailingMetric} value={fmtHours(parseFloat(worker.prevailing_hours))} color="#d97706" />}
          <Metric label={t.entriesMetric} value={worker.total_entries} />
        </div>
        <button style={styles.expandBtn}>{expanded ? '▲' : '▼'}</button>
      </div>

      {expanded && (
        <div style={styles.billSection}>
          <div style={styles.sectionHeader}>
            <h4 style={styles.billHeading}>{t.generateBill}</h4>
            <button style={styles.addEntryBtn} onClick={() => { setShowAddEntry(v => !v); setAddError(''); setAddSuccess(false); }}>
              {showAddEntry ? `✕ ${t.cancel}` : `+ ${t.addEntry}`}
            </button>
          </div>
          {addSuccess && <div style={styles.addSuccess}>{t.entryAddedSuccess}</div>}
          {showAddEntry && (
            <form onSubmit={handleAddEntry} style={styles.addForm}>
              <div style={styles.addRow}>
                <div style={styles.addField}>
                  <label style={styles.label}>{t.date}</label>
                  <input style={styles.input} type="date" value={addForm.work_date} onChange={e => setAddForm(f => ({ ...f, work_date: e.target.value }))} required disabled={addSaving} />
                </div>
                <div style={styles.addField}>
                  <label style={styles.label}>{t.startTime}</label>
                  <input style={styles.input} type="time" value={addForm.start_time} onChange={e => setAddForm(f => ({ ...f, start_time: e.target.value }))} required disabled={addSaving} />
                </div>
                <div style={styles.addField}>
                  <label style={styles.label}>{t.endTime}</label>
                  <input style={styles.input} type="time" value={addForm.end_time} onChange={e => setAddForm(f => ({ ...f, end_time: e.target.value }))} required disabled={addSaving} />
                </div>
                <div style={styles.addField}>
                  <label style={styles.label}>{t.breakMin}</label>
                  <input style={{ ...styles.input, width: 70 }} type="number" min="0" value={addForm.break_minutes} onChange={e => setAddForm(f => ({ ...f, break_minutes: e.target.value }))} disabled={addSaving} />
                </div>
              </div>
              {projectsEnabled && projects.length > 0 && (
                <div style={styles.addField}>
                  <label style={styles.label}>{workLabel}</label>
                  <select style={styles.input} value={addForm.project_id} onChange={e => setAddForm(f => ({ ...f, project_id: e.target.value }))} disabled={addSaving}>
                    <option value="">{`No ${workLabelLower}`}</option>
                    {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              )}
              <div style={styles.addField}>
                <label style={styles.label}>{t.notes}</label>
                <input style={{ ...styles.input, width: '100%' }} type="text" maxLength={500} value={addForm.notes} onChange={e => setAddForm(f => ({ ...f, notes: e.target.value }))} placeholder={t.optional} disabled={addSaving} />
              </div>
              {addError && <div style={styles.addError}>{addError}</div>}
              <button style={{ ...styles.fetchBtn, ...(addSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={addSaving}>{addSaving ? t.saving : t.addEntry}</button>
            </form>
          )}
          <div style={styles.dateRow}>
            <div style={styles.dateField}>
              <label style={styles.label}>{t.from}</label>
              <input style={styles.input} type="date" value={from} onChange={e => setFrom(e.target.value)} />
            </div>
            <div style={styles.dateField}>
              <label style={styles.label}>{t.to}</label>
              <input style={styles.input} type="date" value={to} onChange={e => setTo(e.target.value)} />
            </div>
            <button style={{ ...styles.fetchBtn, ...(loading ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={fetchBill} disabled={loading}>
              {loading ? t.loading : t.loadEntries}
            </button>
          </div>

          {billData && billData.entries.length === 0 && (billData.reimbursements || []).length === 0 && (
            <div style={{ marginTop: 12, color: '#6b7280', fontSize: 14 }}>{t.noEntriesPeriod}</div>
          )}
          {billData && (billData.entries.length > 0 || (billData.reimbursements || []).length > 0) && (
            <div style={{ marginTop: 16 }}>
              <div style={styles.billSummary}>
                <span>{t.entriesLabel} <b>{billData.entries.length}</b></span>
                <span>{t.totalLabel} <b>{fmtHours((billData.summary.total_hours || 0) + (billData.summary.guarantee_shortfall_hours || 0))}</b></span>
                {billData.summary.regular_hours > 0 && <span style={{ color: '#2563eb' }}>{t.regularLabel} <b>{fmtHours(billData.summary.regular_hours)} · {formatCurrency(billData.summary.regular_cost, currency)}</b></span>}
                {overtimeEnabled && billData.summary.overtime_hours > 0 && <span style={{ color: '#dc2626' }}>{t.overtimeLabel} <b>{fmtHours(billData.summary.overtime_hours)} · {formatCurrency(billData.summary.overtime_cost, currency)}</b></span>}
                {billData.summary.prevailing_hours > 0 && <span style={{ color: '#d97706' }}>{t.prevailingLabel} <b>{fmtHours(billData.summary.prevailing_hours)} · {formatCurrency(billData.summary.prevailing_cost, currency)}</b></span>}
                {billData.summary.guarantee_shortfall_hours > 0 && (
                  <span style={{ color: '#2563eb' }}>Min. Guarantee <b>+{fmtHours(billData.summary.guarantee_shortfall_hours)} · {formatCurrency(billData.summary.guarantee_cost, currency)}</b></span>
                )}
                {billData.summary.reimbursement_total > 0 && (
                  <span style={{ color: '#7c3aed' }}>Expenses <b>{formatCurrency(billData.summary.reimbursement_total, currency)}</b></span>
                )}
                <span style={{ fontWeight: 700 }}>{t.totalCostLabel} <b>{formatCurrency(billData.summary.total_cost, currency)}</b></span>
              </div>
              <div style={styles.btnRow}>
                <button style={{ ...styles.previewBtn, ...(pdfGenerating ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={togglePreview} disabled={pdfGenerating}>
                  {pdfGenerating ? t.preparing : showPreview ? t.hideBill : t.previewBill}
                </button>
                <button style={styles.csvBtn} onClick={() => {
                  const headers = ['Date', 'Type', workLabel, 'Category / Wage Type', 'Start', 'End', 'Hours', 'Amount'];
                  const timeRows = billData.entries.map(e => {
                    const h = ((new Date(`1970-01-01T${e.end_time}`) - new Date(`1970-01-01T${e.start_time}`)) / 3600000).toFixed(2);
                    return [e.work_date?.toString().substring(0,10), 'Time', e.project_name || '', e.wage_type, e.start_time, e.end_time, h, ''];
                  });
                  const reimbRows = (billData.reimbursements || []).map(r => [
                    r.expense_date?.toString().substring(0,10), 'Expense', r.project_name || '', r.category || r.description || '', '', '', '', r.amount,
                  ]);
                  downloadCSV([headers, ...timeRows, ...reimbRows], `${worker.username}-${from||'all'}-to-${to||'all'}.csv`);
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

const styles = {
  card: { background: '#fff', borderRadius: 12, marginBottom: 16, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', overflow: 'hidden' },
  summary: { padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 20, cursor: 'pointer', flexWrap: 'wrap' },
  name: { fontWeight: 700, fontSize: 17, marginRight: 8 },
  username: { color: '#6b7280', fontSize: 13 },
  metrics: { display: 'flex', gap: 20, flex: 1, flexWrap: 'wrap' },
  metric: { display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 60 },
  metricVal: { fontWeight: 700, fontSize: 18 },
  metricLabel: { fontSize: 11, color: '#999', textTransform: 'uppercase', letterSpacing: 0.5 },
  expandBtn: { background: 'none', border: 'none', fontSize: 14, color: '#6b7280', marginLeft: 'auto' },
  billSection: { padding: '16px 20px', borderTop: '1px solid #f0f0f0', background: '#fafafa' },
  sectionHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  billHeading: { margin: 0, fontSize: 15, fontWeight: 600 },
  addEntryBtn: { padding: '5px 14px', background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  addForm: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 9, padding: '14px 16px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 10 },
  addRow: { display: 'flex', gap: 10, flexWrap: 'wrap' },
  addField: { display: 'flex', flexDirection: 'column', gap: 4 },
  addError: { color: '#dc2626', fontSize: 13 },
  addSuccess: { color: '#059669', fontSize: 13, fontWeight: 600, marginBottom: 8 },
  dateRow: { display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' },
  dateField: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 12, fontWeight: 600, color: '#666' },
  input: { padding: '8px 10px', border: '1px solid #ddd', borderRadius: 7, fontSize: 14 },
  fetchBtn: { padding: '8px 18px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 14 },
  billSummary: { display: 'flex', gap: 20, fontSize: 14, flexWrap: 'wrap', marginBottom: 12 },
  btnRow: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  previewBtn: { padding: '10px 20px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer' },
  csvBtn: { padding: '10px 20px', background: '#0f766e', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer' },
  pdfBtn: { display: 'inline-block', padding: '10px 20px', background: '#059669', color: '#fff', borderRadius: 8, fontWeight: 600, fontSize: 14, textDecoration: 'none' },
  pdfViewer: { width: '100%', height: 600, marginTop: 16, borderRadius: 8, border: '1px solid #e5e7eb' },
};
