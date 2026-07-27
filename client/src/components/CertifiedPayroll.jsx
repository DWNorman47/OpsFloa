import React, { useState } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { langToLocale } from '../utils';
import CertifiedPayrollSignature from './CertifiedPayrollSignature';

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function fmtH(h) {
  if (!h) return '—';
  const wh = Math.floor(h);
  const wm = Math.round((h - wh) * 60);
  return wm > 0 ? `${wh}h ${wm}m` : `${wh}h`;
}

function fmtDate(d, locale = 'en-US') {
  return new Date(d + 'T00:00:00').toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

function lastSunday() {
  const d = new Date();
  d.setDate(d.getDate() - (d.getDay() === 0 ? 0 : d.getDay()));
  return d.toLocaleDateString('en-CA');
}

export default function CertifiedPayroll({ projects, settings, requireSignature = false, wh347Format = false }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const workerLabel = settings?.label_worker || 'Team Member';
  const [showSignModal, setShowSignModal] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);

  const downloadWh347Pdf = async () => {
    if (!data) return;
    setPdfLoading(true);
    try {
      // Dynamically import @react-pdf/renderer and the template — keeps the
      // ~400KB dep out of the main bundle for non-CP customers.
      const [{ pdf }, { default: CertifiedPayrollPDF }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('./CertifiedPayrollPDF'),
      ]);
      const blob = await pdf(<CertifiedPayrollPDF report={data} settings={settings} />).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `WH-347_${data.week_end}${projectId ? `_proj-${projectId}` : ''}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[wh347-pdf]', err);
      alert('Failed to generate WH-347 PDF');
    } finally {
      setPdfLoading(false);
    }
  };
  const [weekEnd, setWeekEnd] = useState(lastSunday());
  const [projectId, setProjectId] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const generate = async () => {
    setError('');
    setLoading(true);
    try {
      const params = new URLSearchParams({ week_end: weekEnd });
      if (projectId) params.set('project_id', projectId);
      const r = await api.get(`/admin/certified-payroll?${params}`);
      setData(r.data);
    } catch {
      setError(t.failedLoadReport);
    } finally {
      setLoading(false);
    }
  };

  const printReport = () => {
    if (!data) return;
    const win = window.open('', '_blank');
    const headerRow = `<tr><th>${workerLabel}</th><th>Classification</th>${DAY_LABELS.map(d => `<th>${d}</th>`).join('')}<th>Total</th><th>Rate</th><th>Gross</th></tr>`;

    const workerRows = data.workers.flatMap(w => {
      const lines = [];
      if (w.regular_total > 0) lines.push({ label: t.regular, days: w.regular_days, total: w.regular_total, rate: `$${w.rate.toFixed(2)}/hr`, cost: w.regular_cost });
      if (w.prevailing_total > 0) lines.push({ label: t.prevailing, days: w.prevailing_days, total: w.prevailing_total, rate: `$${w.prevailing_rate.toFixed(2)}/hr`, cost: w.prevailing_cost });
      if (w.overtime_total > 0) lines.push({ label: t.overtime, days: w.ot_days, total: w.overtime_total, rate: `${w.overtime_multiplier}×`, cost: w.overtime_cost });
      return lines.map((ln, i) => `<tr>
        <td>${i === 0 ? w.worker_name : ''}</td>
        <td>${ln.label}</td>
        ${DAY_KEYS.map(d => `<td>${ln.days[d] || '—'}</td>`).join('')}
        <td><strong>${fmtH(ln.total)}</strong></td>
        <td>${ln.rate}</td>
        <td>$${(ln.cost || 0).toFixed(2)}</td>
      </tr>`);
    }).join('');

    win.document.write(`<!DOCTYPE html><html><head>
      <meta charset="utf-8">
      <title>Payroll — Week Ending ${data.week_end}</title>
      <style>
        body { font-family: system-ui, sans-serif; margin: 24px; color: #111; font-size: 12px; }
        h1 { font-size: 16px; margin: 0 0 4px; }
        .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; margin: 12px 0 20px; font-size: 12px; color: #444; }
        .meta strong { color: #111; }
        table { width: 100%; border-collapse: collapse; }
        th { background: #f3f4f6; padding: 7px 8px; text-align: center; border: 1px solid #e5e7eb; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; }
        th:first-child, th:nth-child(2) { text-align: left; }
        td { padding: 6px 8px; border: 1px solid #e5e7eb; text-align: center; }
        td:first-child, td:nth-child(2) { text-align: left; }
        tr:nth-child(even) { background: #fafafa; }
        .footer { margin-top: 28px; font-size: 11px; color: #9ca3af; }
        @media print { body { margin: 12px; } }
      </style>
    </head><body>
      <h1>Payroll Report</h1>
      <div class="meta">
        <div><strong>Contractor:</strong> ${data.contractor}</div>
        <div><strong>Week ending:</strong> ${fmtDate(data.week_end, locale)}</div>
        <div><strong>Project:</strong> ${data.project || `All project`}</div>
        <div><strong>Week starting:</strong> ${fmtDate(data.week_start, locale)}</div>
      </div>
      <table>
        <thead>${headerRow}</thead>
        <tbody>${workerRows || '<tr><td colspan="12" style="text-align:center;color:#9ca3af;padding:16px">No entries for this period</td></tr>'}</tbody>
      </table>
      <p class="footer">${new Date().toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' })}</p>
    </body></html>`);
    win.document.close();
    win.print();
  };

  const prevailingProjects = projects?.filter(p => p.wage_type === 'prevailing') || projects || [];

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>{t.certifiedPayrollTitle}</h3>
      <p style={styles.sub}>{t.certPayrollDesc}</p>

      <div style={styles.controls}>
        <div style={styles.field}>
          <label htmlFor="cp-week-end" style={styles.label}>{t.weekEnding}</label>
          <input id="cp-week-end" style={styles.input} type="date" value={weekEnd} onChange={e => { setWeekEnd(e.target.value); setData(null); }} />
        </div>
        <div style={styles.field}>
          <label htmlFor="cp-project" style={styles.label}>Project optional</label>
          <select id="cp-project" style={styles.input} value={projectId} onChange={e => { setProjectId(e.target.value); setData(null); }}>
            <option value="">All project</option>
            {(projects || []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <button style={{ ...styles.generateBtn, ...((loading || !weekEnd) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={generate} disabled={loading || !weekEnd}>
          {loading ? t.loading : t.generate}
        </button>
      </div>

      {error && <p role="alert" style={styles.error}>{error}</p>}

      {data && (
        <>
          <div style={styles.reportHeader}>
            <div>
              <div style={styles.metaLine}><strong>{t.contractorLabel}</strong> {data.contractor}</div>
              <div style={styles.metaLine}><strong>Project:</strong> {data.project || `All project`}</div>
              <div style={styles.metaLine}><strong>Period:</strong> {fmtDate(data.week_start, locale)} – {fmtDate(data.week_end, locale)}</div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {requireSignature && (
                <button style={styles.signBtn} onClick={() => setShowSignModal(true)}>
                  📝 Sign
                </button>
              )}
              {wh347Format && (
                <button
                  style={{ ...styles.pdfBtn, ...(pdfLoading ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                  onClick={downloadWh347Pdf}
                  disabled={pdfLoading}
                >
                  {pdfLoading ? 'Generating…' : '⬇ WH-347 PDF'}
                </button>
              )}
              <button style={styles.printBtn} onClick={printReport}>{t.printSavePDF}</button>
            </div>
          </div>
          {showSignModal && (
            <CertifiedPayrollSignature
              projectId={projectId || null}
              weekEnding={weekEnd}
              defaultName={user?.full_name || ''}
              onClose={() => setShowSignModal(false)}
            />
          )}

          {data.workers.length === 0 ? (
            <p style={styles.empty}>{t.noTimeEntriesFound}</p>
          ) : (
            <div style={styles.tableWrap}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>{workerLabel}</th>
                    <th style={styles.th}>{t.classLabel}</th>
                    {DAY_LABELS.map(d => <th key={d} style={{ ...styles.th, ...styles.dayTh }}>{d}</th>)}
                    <th style={styles.th}>Total</th>
                    <th style={styles.th}>Rate</th>
                    <th style={styles.th}>Gross</th>
                  </tr>
                </thead>
                <tbody>
                  {data.workers.flatMap(w => {
                    // Straight-time Regular + Prevailing rows, then a combined
                    // Overtime row. Costs come from the server (OT-aware) — the
                    // client no longer recomputes hours × rate flat.
                    const lines = [];
                    if (w.regular_total > 0) lines.push({ k: 'reg', label: t.regular, days: w.regular_days, total: w.regular_total, rate: `$${w.rate.toFixed(2)}`, cost: w.regular_cost });
                    if (w.prevailing_total > 0) lines.push({ k: 'prev', label: t.prevailing, days: w.prevailing_days, total: w.prevailing_total, rate: `$${w.prevailing_rate.toFixed(2)}`, cost: w.prevailing_cost, bg: '#fffbeb', color: '#92400e' });
                    if (w.overtime_total > 0) lines.push({ k: 'ot', label: t.overtime, days: w.ot_days, total: w.overtime_total, rate: `${w.overtime_multiplier}×`, cost: w.overtime_cost, bg: '#eef2ff', color: '#3730a3' });
                    return lines.map((ln, i) => (
                      <tr key={`${w.worker_id}-${ln.k}`} style={{ ...styles.tr, ...(ln.bg ? { background: ln.bg } : {}) }}>
                        <td style={styles.nameTd}>{i === 0 ? w.worker_name : ''}</td>
                        <td style={{ ...styles.td, ...styles.classTd, ...(ln.color ? { color: ln.color, fontWeight: 600 } : {}) }}>{ln.label}</td>
                        {DAY_KEYS.map(d => <td key={d} style={styles.dayTd}>{ln.days[d] || '—'}</td>)}
                        <td style={{ ...styles.td, fontWeight: 700 }}>{fmtH(ln.total)}</td>
                        <td style={styles.td}>{ln.rate}</td>
                        <td style={styles.td}>${(ln.cost || 0).toFixed(2)}</td>
                      </tr>
                    ));
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 12, padding: 28, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 24 },
  title: { fontSize: 17, fontWeight: 700, marginBottom: 6 },
  sub: { fontSize: 13, color: '#6b7280', marginBottom: 20, lineHeight: 1.5 },
  controls: { display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' },
  input: { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13 },
  generateBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '8px 20px', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  error: { color: '#ef4444', fontSize: 13, marginBottom: 10 },
  reportHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap', gap: 12 },
  metaLine: { fontSize: 13, color: '#374151', marginBottom: 4 },
  printBtn: { background: '#059669', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  signBtn:  { background: '#1f2937', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  pdfBtn:   { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  empty: { color: '#6b7280', fontSize: 13 },
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 700 },
  th: { background: '#f3f4f6', padding: '8px 10px', textAlign: 'left', borderBottom: '2px solid #e5e7eb', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6b7280', whiteSpace: 'nowrap' },
  dayTh: { textAlign: 'center', width: 46 },
  tr: { borderBottom: '1px solid #f3f4f6' },
  td: { padding: '7px 10px', textAlign: 'center', fontSize: 13, color: '#374151' },
  nameTd: { padding: '7px 10px', textAlign: 'left', fontWeight: 600, fontSize: 13, color: '#111827', whiteSpace: 'nowrap' },
  classTd: { textAlign: 'left', color: '#6b7280' },
  dayTd: { padding: '7px 6px', textAlign: 'center', fontSize: 12, color: '#374151' },
};
