import React, { useState } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { formatCurrency } from '../utils';
import { silentError } from '../errorReporter';

/**
 * Payroll Run — the ruleset-driven register for a pay period. Each worker's
 * Paycheck ruleset is resolved from their role; a role matching zero or more than
 * one ruleset is a SETUP ERROR surfaced for the admin to fix (never guessed).
 * Ready workers show gross → deductions (company + role + personal, run through the
 * ruleset's exempt/cap/min-net) → net. Gated on the Advanced Payroll add-on server-side.
 */

const REASON_KEY = {
  no_role: 'pcrRunErrNoRole',
  no_ruleset: 'pcrRunErrNoRuleset',
  multiple_rulesets: 'pcrRunErrMultiple',
};

function today() { return new Date().toLocaleDateString('en-CA'); }
function monthStart() { const d = new Date(); d.setDate(1); return d.toLocaleDateString('en-CA'); }

export default function PayrollRun({ currency = 'USD' }) {
  const t = useT();
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const money = v => formatCurrency(v, currency);

  const run = async () => {
    setError(''); setLoading(true);
    try {
      const r = await api.get(`/admin/payroll-run?from=${from}&to=${to}`);
      setData(r.data);
    } catch (err) {
      setError(err?.response?.data?.error || t.pcrRunFailed);
      silentError('payroll-run')(err);
    } finally { setLoading(false); }
  };

  const totals = data
    ? data.rows.reduce((a, r) => ({ gross: a.gross + r.gross, ded: a.ded + r.deduction_total, net: a.net + r.net }), { gross: 0, ded: 0, net: 0 })
    : null;

  return (
    <div style={s.card}>
      <h3 style={s.title}>{t.pcrRunTitle}</h3>
      <p style={s.sub}>{t.pcrRunDesc}</p>

      <div style={s.controls}>
        <div style={s.field}><label style={s.label}>{t.pcrRunFrom}</label>
          <input type="date" style={s.input} value={from} onChange={e => { setFrom(e.target.value); setData(null); }} /></div>
        <div style={s.field}><label style={s.label}>{t.pcrRunTo}</label>
          <input type="date" style={s.input} value={to} onChange={e => { setTo(e.target.value); setData(null); }} /></div>
        <button style={{ ...s.runBtn, ...((loading || !from || !to) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
          onClick={run} disabled={loading || !from || !to}>{loading ? t.loading : t.pcrRunGo}</button>
      </div>

      {error && <p role="alert" style={s.error}>{error}</p>}

      {data && (
        <>
          {data.errors.length > 0 && (
            <div style={s.errorBox}>
              <div style={s.errorHead}>⚠ {t.pcrRunSetupErrors.replace('{n}', data.errors.length)}</div>
              <ul style={s.errorList}>
                {data.errors.map(e => (
                  <li key={e.worker_id} style={s.errorItem}>
                    <strong>{e.worker_name}</strong>{e.role_name ? ` · ${e.role_name}` : ''} — {t[REASON_KEY[e.reason]] || e.reason}
                    {e.reason === 'multiple_rulesets' && e.matches ? `: ${e.matches.join(', ')}` : ''}
                  </li>
                ))}
              </ul>
              <p style={s.errorHint}>{t.pcrRunSetupHint}</p>
            </div>
          )}

          {data.ruleset_count === 0 && <p style={s.note}>{t.pcrRunNoRulesets}</p>}

          {data.rows.length > 0 ? (
            <div style={s.tableWrap}>
              <table style={s.table}>
                <thead>
                  <tr>
                    <th style={s.th}>{t.pcrRunPayDate}</th>
                    <th style={s.th}>{t.pcrRunWorker}</th>
                    <th style={s.th}>{t.pcrRunRuleset}</th>
                    <th style={s.th}>{t.pcrRunPeriod}</th>
                    <th style={s.thNum}>{t.pcrRunGross}</th>
                    <th style={s.thNum}>{t.pcrRunDeductions}</th>
                    <th style={s.thNum}>{t.pcrRunNet}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => (
                    <tr key={`${r.worker_id}-${r.pay_date}-${i}`} style={s.tr}>
                      <td style={s.td}>{r.pay_date}</td>
                      <td style={s.tdName}>{r.worker_name}{r.role_name ? <span style={s.muted}> · {r.role_name}</span> : ''}</td>
                      <td style={s.td}>{r.ruleset_name || <span style={s.muted}>{t.pcrRunNoRule}</span>}</td>
                      <td style={s.td}>{r.period_start} – {r.period_end}</td>
                      <td style={s.tdNum}>{money(r.gross)}</td>
                      <td style={{ ...s.tdNum, color: r.deduction_total > 0 ? '#b91c1c' : undefined }}>{r.deduction_total > 0 ? `−${money(r.deduction_total)}` : '—'}</td>
                      <td style={{ ...s.tdNum, fontWeight: 700 }}>{money(r.net)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={s.totalRow}>
                    <td style={s.td} colSpan={4}><strong>{t.pcrRunTotals}</strong></td>
                    <td style={s.tdNum}><strong>{money(totals.gross)}</strong></td>
                    <td style={s.tdNum}><strong>{totals.ded > 0 ? `−${money(totals.ded)}` : '—'}</strong></td>
                    <td style={s.tdNum}><strong>{money(totals.net)}</strong></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : data.errors.length === 0 && <p style={s.note}>{t.pcrRunEmpty}</p>}

          <p style={s.footnote}>{t.pcrRunScopeNote}</p>
        </>
      )}
    </div>
  );
}

const s = {
  card: { background: '#fff', borderRadius: 12, padding: 28, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 24 },
  title: { fontSize: 17, fontWeight: 700, marginBottom: 6 },
  sub: { fontSize: 13, color: '#6b7280', marginBottom: 20, lineHeight: 1.5, maxWidth: 620 },
  controls: { display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' },
  input: { padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13 },
  runBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '8px 20px', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  error: { color: '#ef4444', fontSize: 13, marginBottom: 10 },
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '14px 16px', marginBottom: 16 },
  errorHead: { fontSize: 14, fontWeight: 700, color: '#991b1b', marginBottom: 8 },
  errorList: { margin: '0 0 8px', paddingLeft: 20 },
  errorItem: { fontSize: 13, color: '#7f1d1d', marginBottom: 3, lineHeight: 1.5 },
  errorHint: { fontSize: 12, color: '#b91c1c', margin: 0 },
  note: { fontSize: 13, color: '#6b7280', margin: '4px 0 12px' },
  muted: { color: '#9ca3af' },
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 640 },
  th: { background: '#f3f4f6', padding: '8px 10px', textAlign: 'left', borderBottom: '2px solid #e5e7eb', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6b7280', whiteSpace: 'nowrap' },
  thNum: { background: '#f3f4f6', padding: '8px 10px', textAlign: 'right', borderBottom: '2px solid #e5e7eb', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6b7280', whiteSpace: 'nowrap' },
  tr: { borderBottom: '1px solid #f3f4f6' },
  td: { padding: '7px 10px', textAlign: 'left', fontSize: 13, color: '#374151' },
  tdName: { padding: '7px 10px', textAlign: 'left', fontWeight: 600, fontSize: 13, color: '#111827', whiteSpace: 'nowrap' },
  tdNum: { padding: '7px 10px', textAlign: 'right', fontSize: 13, color: '#374151', whiteSpace: 'nowrap' },
  totalRow: { borderTop: '2px solid #e5e7eb', background: '#f9fafb' },
  footnote: { fontSize: 12, color: '#94a3b8', margin: '14px 0 0', lineHeight: 1.5, maxWidth: 640, background: '#f8fafc', border: '1px solid #eef0f2', borderRadius: 6, padding: '7px 11px' },
};
