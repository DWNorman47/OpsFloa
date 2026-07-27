import React, { useState } from 'react';
import api from '../api';
import { fmtHours, formatCurrency } from '../utils';
import { useT } from '../hooks/useT';

import { silentError } from '../errorReporter';
function monthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function today() { return new Date().toLocaleDateString('en-CA'); }
function fmt(n) { return n == null ? '—' : fmtHours(n); }

export default function OvertimeReport({ currency = 'USD' }) {
  const t = useT();
  const money = n => n == null ? '—' : formatCurrency(n, currency);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sortKey, setSortKey] = useState('worker_name');
  const [sortDir, setSortDir] = useState(1);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get(`/admin/overtime-report?from=${from}&to=${to}`);
      setRows(r.data);
    } finally { setLoading(false); }
  };

  const sort = key => {
    if (sortKey === key) setSortDir(d => -d);
    else { setSortKey(key); setSortDir(1); }
  };

  const sorted = rows ? [...rows].sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (typeof av === 'string') return av.localeCompare(bv) * sortDir;
    return (av - bv) * sortDir;
  }) : [];

  const totals = sorted.reduce((acc, r) => ({
    regular_hours: acc.regular_hours + r.regular_hours,
    overtime_hours: acc.overtime_hours + r.overtime_hours,
    prevailing_hours: acc.prevailing_hours + r.prevailing_hours,
    total_hours: acc.total_hours + r.total_hours,
    mileage: acc.mileage + r.mileage,
    regular_cost: acc.regular_cost + r.regular_cost,
    overtime_cost: acc.overtime_cost + r.overtime_cost,
    prevailing_cost: acc.prevailing_cost + r.prevailing_cost,
    guarantee_cost: acc.guarantee_cost + (r.guarantee_cost || 0),
    total_cost: acc.total_cost + r.total_cost,
    net_pay: acc.net_pay + (r.net_pay || 0),
  }), { regular_hours: 0, overtime_hours: 0, prevailing_hours: 0, total_hours: 0, mileage: 0, regular_cost: 0, overtime_cost: 0, prevailing_cost: 0, guarantee_cost: 0, total_cost: 0, net_pay: 0 });

  const downloadPayroll = async () => {
    try {
      const r = await api.get(`/admin/payroll-export?from=${from}&to=${to}`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([r.data], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url; a.download = `payroll-${from}-to-${to}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch (err) { silentError('overtime-csv')(err); }
  };

  const Col = ({ k, label }) => (
    <th style={{ ...styles.th, cursor: 'pointer', userSelect: 'none' }} onClick={() => sort(k)}>
      {label}{sortKey === k ? (sortDir === 1 ? ' ↑' : ' ↓') : ''}
    </th>
  );

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <h3 style={styles.title}>{t.overtimeReport}</h3>
        <div style={styles.controls}>
          <div style={styles.filterGroup}>
            <label htmlFor="ot-from" style={styles.label}>{t.qboFrom}</label>
            <input id="ot-from" style={styles.input} type="date" value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div style={styles.filterGroup}>
            <label htmlFor="ot-to" style={styles.label}>{t.qboTo}</label>
            <input id="ot-to" style={styles.input} type="date" value={to} onChange={e => setTo(e.target.value)} />
          </div>
          <button style={{ ...styles.runBtn, ...(loading || !from || !to ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={load} disabled={loading || !from || !to}>
            {loading ? t.loading : t.runReport}
          </button>
          {rows && rows.length > 0 && (
            <button style={styles.exportBtn} onClick={downloadPayroll}>⬇ {t.payrollCSV}</button>
          )}
        </div>
      </div>

      {rows === null ? (
        <p style={styles.hint}>{t.selectDateRange}</p>
      ) : rows.length === 0 ? (
        <p style={styles.empty}>{t.noApprovedEntries}</p>
      ) : (
        <div style={styles.tableWrap} className="table-scroll">
          <table style={styles.table}>
            <thead>
              <tr>
                <Col k="worker_name" label={t.workerCol} />
                <Col k="rate" label={t.rateCol} />
                <Col k="regular_hours" label={t.regHrs} />
                <Col k="overtime_hours" label={t.otHrs} />
                <Col k="prevailing_hours" label={t.prevHrs} />
                <Col k="total_hours" label={t.totalHrs} />
                <Col k="mileage" label={t.milesCol} />
                <Col k="regular_cost" label={t.regPay} />
                <Col k="overtime_cost" label={t.otPay} />
                <Col k="prevailing_cost" label={t.prevPay} />
                <Col k="guarantee_cost" label={t.guaranteeCol} />
                <Col k="total_cost" label={t.totalPayCol} />
                <Col k="net_pay" label={t.netPayCol} />
              </tr>
            </thead>
            <tbody>
              {sorted.map(r => (
                <tr key={r.worker_id} style={r.overtime_hours > 0 ? styles.rowOT : {}}>
                  <td style={styles.td}><strong>{r.worker_name}</strong></td>
                  <td style={styles.tdNum}>{money(r.rate)}</td>
                  <td style={styles.tdNum}>{fmt(r.regular_hours)}</td>
                  <td style={{ ...styles.tdNum, color: r.overtime_hours > 0 ? '#d97706' : undefined, fontWeight: r.overtime_hours > 0 ? 700 : undefined }}>
                    {fmt(r.overtime_hours)}
                  </td>
                  <td style={styles.tdNum}>{fmt(r.prevailing_hours)}</td>
                  <td style={{ ...styles.tdNum, fontWeight: 600 }}>{fmt(r.total_hours)}</td>
                  <td style={styles.tdNum}>{r.mileage > 0 ? r.mileage.toFixed(1) : '—'}</td>
                  <td style={styles.tdNum}>{money(r.regular_cost)}</td>
                  <td style={{ ...styles.tdNum, color: r.overtime_cost > 0 ? '#d97706' : undefined }}>{money(r.overtime_cost)}</td>
                  <td style={styles.tdNum}>{money(r.prevailing_cost)}</td>
                  <td style={{ ...styles.tdNum, color: (r.guarantee_cost || 0) > 0 ? '#2563eb' : undefined }}>{(r.guarantee_cost || 0) > 0 ? money(r.guarantee_cost) : '—'}</td>
                  <td style={{ ...styles.tdNum, fontWeight: 700 }}>{money(r.total_cost)}</td>
                  <td style={{ ...styles.tdNum, fontWeight: 700 }}>{money(r.net_pay)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={styles.totalRow}>
                <td style={styles.td} colSpan={2}><strong>{t.totalsRow}</strong></td>
                <td style={styles.tdNum}><strong>{fmt(totals.regular_hours)}</strong></td>
                <td style={styles.tdNum}><strong>{fmt(totals.overtime_hours)}</strong></td>
                <td style={styles.tdNum}><strong>{fmt(totals.prevailing_hours)}</strong></td>
                <td style={styles.tdNum}><strong>{fmt(totals.total_hours)}</strong></td>
                <td style={styles.tdNum}><strong>{totals.mileage.toFixed(1)}</strong></td>
                <td style={styles.tdNum}><strong>{money(totals.regular_cost)}</strong></td>
                <td style={styles.tdNum}><strong>{money(totals.overtime_cost)}</strong></td>
                <td style={styles.tdNum}><strong>{money(totals.prevailing_cost)}</strong></td>
                <td style={styles.tdNum}><strong>{totals.guarantee_cost > 0 ? money(totals.guarantee_cost) : '—'}</strong></td>
                <td style={styles.tdNum}><strong>{money(totals.total_cost)}</strong></td>
                <td style={styles.tdNum}><strong>{money(totals.net_pay)}</strong></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 24 },
  header: { marginBottom: 16 },
  title: { fontSize: 17, fontWeight: 700, marginBottom: 12 },
  controls: { display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' },
  filterGroup: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' },
  input: { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13 },
  runBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  exportBtn: { background: '#059669', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  hint: { color: '#6b7280', fontSize: 14 },
  empty: { color: '#6b7280', fontSize: 14 },
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: { background: '#f9fafb', padding: '8px 12px', textAlign: 'left', fontWeight: 600, fontSize: 12, color: '#374151', borderBottom: '2px solid #e5e7eb', whiteSpace: 'nowrap' },
  td: { padding: '8px 12px', borderBottom: '1px solid #f3f4f6', verticalAlign: 'middle' },
  tdNum: { padding: '8px 12px', borderBottom: '1px solid #f3f4f6', textAlign: 'right', verticalAlign: 'middle', whiteSpace: 'nowrap' },
  rowOT: { background: '#fffbeb' },
  totalRow: { background: '#f0fdf4', borderTop: '2px solid #d1fae5' },
};
