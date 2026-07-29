import React, { useState, useEffect, useRef } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { formatCurrency } from '../utils';
import { silentError } from '../errorReporter';
import { usePerm } from '../hooks/usePerm';
import PayStub from './PayStub';
import { downloadCsv as saveCsv } from '../utils/csv';

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
// A period entry is a whole GROUP now; run_from/run_to is the pay-date window that
// spans it (so a grouped ruleset's exempt combines across the group instead of
// applying per-check). Fall back to the pay date for older payloads / lone checks.
const runWin = p => ({ f: p.run_from || p.pay_date, tt: p.run_to || p.pay_date });
const periodKeyOf = p => { const { f, tt } = runWin(p); return `${p.ruleset_id || ''}|${f}|${tt}`; };
// Dates are UTC-midnight ISO strings; format them in UTC too, or a viewer west of
// UTC sees every date shifted a day earlier than the run actually uses.
const fmtDay = iso => { const [y, m, d] = iso.split('-'); return new Date(Date.UTC(+y, +m - 1, +d)).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric' }); };
const fmtFull = iso => { const [y, m, d] = iso.split('-'); return new Date(Date.UTC(+y, +m - 1, +d)).toLocaleDateString(undefined, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }); };

export default function PayrollRun({ currency = 'USD', onFinalized }) {
  const t = useT();
  const canManagePayroll = usePerm('manage_pay_periods');
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [openRow, setOpenRow] = useState(null);
  const [finalizing, setFinalizing] = useState(false);
  const [finalizeMsg, setFinalizeMsg] = useState('');
  // Pay periods from the ruleset schedule(s). null = still loading; [] = none
  // configured → fall back to a custom date range.
  const [periods, setPeriods] = useState(null);
  const [periodKey, setPeriodKey] = useState('');
  const [rulesetId, setRulesetId] = useState(null);
  const [rulesetOptions, setRulesetOptions] = useState([]);
  const [customRange, setCustomRange] = useState(false);
  const runRequest = useRef(0);
  const money = v => formatCurrency(v, currency);

  const finalize = async () => {
    if (!data || !data.rows.length || data.errors.length) return;
    setFinalizing(true); setFinalizeMsg('');
    try {
      await api.post('/admin/payroll-run/finalize', {
        from: data.from,
        to: data.to,
        ruleset_id: data.ruleset_id,
      }, { suppressToast: true }); // shown inline as finalizeMsg
      setFinalizeMsg(t.pcrRunFinalized);
      onFinalized && onFinalized();
    } catch (err) {
      setFinalizeMsg(err?.response?.data?.error || t.pcrRunFailed);
    } finally { setFinalizing(false); }
  };

  // Explicit args so a just-picked period runs without waiting for state to settle.
  const run = async (f = from, tt = to, rs = rulesetId) => {
    if (!f || !tt) return;
    const requestId = ++runRequest.current;
    setError(''); setFinalizeMsg(''); setData(null); setLoading(true);
    try {
      const rsParam = rs ? `&ruleset_id=${encodeURIComponent(rs)}` : '';
      const r = await api.get(`/admin/payroll-run?from=${f}&to=${tt}${rsParam}`, { suppressToast: true }); // shown inline as `error`
      if (requestId === runRequest.current) setData(r.data);
    } catch (err) {
      if (requestId === runRequest.current) {
        setError(err?.response?.data?.error || t.pcrRunFailed);
        silentError('payroll-run')(err);
      }
    } finally {
      if (requestId === runRequest.current) setLoading(false);
    }
  };

  const selectPeriod = (key) => {
    setPeriodKey(key);
    const p = (periods || []).find(x => periodKeyOf(x) === key);
    // Run the group's whole pay-date window so grouped deductions combine correctly;
    // the run resolves each check's actual period (arrears bases start before the pay
    // date) from the schedule itself.
    if (p) {
      const { f, tt } = runWin(p);
      setFrom(f); setTo(tt); setRulesetId(p.ruleset_id || null);
      run(f, tt, p.ruleset_id || null);
    }
  };

  // Load the schedule's pay periods once; auto-select + run the latest.
  useEffect(() => {
    let alive = true;
    api.get('/admin/payroll-periods').then(r => {
      if (!alive) return;
      const list = r.data?.periods || [];
      setPeriods(list);
      setRulesetOptions(r.data?.rulesets || []);
      if (list.length) {
        const p = list[0];
        setPeriodKey(periodKeyOf(p));
        setRulesetId(p.ruleset_id || null);
        const { f, tt } = runWin(p);
        setFrom(f); setTo(tt);
        run(f, tt, p.ruleset_id || null);
      } else {
        setCustomRange(true);
      }
    }).catch(err => { if (alive) { setPeriods([]); setCustomRange(true); silentError('payroll-periods')(err); } });
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const totals = data
    ? data.rows.reduce((a, r) => ({ gross: a.gross + r.gross, ded: a.ded + r.deduction_total, net: a.net + r.net }), { gross: 0, ded: 0, net: 0 })
    : null;

  const downloadCsv = () => {
    if (!data || !data.rows.length) return;
    const cols = ['Pay date', 'Worker', 'Role', 'Ruleset', 'Period start', 'Period end', 'Regular hrs', 'OT hrs', 'Prevailing hrs', 'Gross', 'Deductions', 'Net'];
    const rows = data.rows.map(r => {
      const h = r.hours || {};
      return [r.pay_date, r.worker_name, r.role_name || '', r.ruleset_name || '', r.period_start, r.period_end,
        h.regular || 0, h.overtime || 0, h.prevailing || 0, r.gross, r.deduction_total, r.net];
    });
    saveCsv([cols, ...rows], `payroll_${from}_${to}.csv`);
  };

  return (
    <div style={s.card}>
      <h3 style={s.title}>{t.pcrRunTitle}</h3>
      <p style={s.sub}>{t.pcrRunDesc}</p>

      <div style={s.controls}>
        {!customRange && periods && periods.length > 0 ? (
          <div style={{ ...s.field, flex: '1 1 320px' }}><label style={s.label}>{t.pcrRunPayPeriod}</label>
            <select style={s.input} value={periodKey} onChange={e => selectPeriod(e.target.value)}>
              {periods.map(p => {
                const k = periodKeyOf(p);
                // A grouped run covers >1 check; mark it (×N) so the span is obvious.
                const grp = p.check_count > 1 ? `  ×${p.check_count}` : '';
                const ruleset = p.ruleset_name ? `${p.ruleset_name} · ` : '';
                return <option key={k} value={k}>{`${ruleset}${t.pcrRunPayLabel} ${fmtFull(p.pay_date)}  ·  ${fmtDay(p.period_start)} – ${fmtDay(p.period_end)}${grp}`}</option>;
              })}
            </select>
          </div>
        ) : (
          <>
            <div style={s.field}><label style={s.label}>{t.pcrRunFrom}</label>
              <input type="date" style={s.input} value={from} onChange={e => { setFrom(e.target.value); setData(null); }} /></div>
            <div style={s.field}><label style={s.label}>{t.pcrRunTo}</label>
              <input type="date" style={s.input} value={to} onChange={e => { setTo(e.target.value); setData(null); }} /></div>
            {rulesetOptions.length > 0 && (
              <div style={s.field}><label style={s.label}>{t.pcrRuleset}</label>
                <select style={s.input} value={rulesetId || ''} onChange={e => { setRulesetId(e.target.value || null); setData(null); }}>
                  {rulesetOptions.length > 1 && <option value="">{t.pcrChooseRuleset}</option>}
                  {rulesetOptions.map(rs => <option key={rs.id} value={rs.id}>{rs.name || t.pcrUnnamed}</option>)}
                </select>
              </div>
            )}
          </>
        )}
        <button style={{ ...s.runBtn, ...((loading || !from || !to || (rulesetOptions.length > 1 && !rulesetId)) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
          onClick={() => run()} disabled={loading || !from || !to || (rulesetOptions.length > 1 && !rulesetId)}>{loading ? t.loading : t.pcrRunGo}</button>
        <button style={{ ...s.csvBtn, ...((!data || !data.rows.length) ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
          onClick={downloadCsv} disabled={!data || !data.rows.length}>{t.pcrRunCsv}</button>
      </div>
      {periods && periods.length > 0 && (
        <button type="button" style={s.modeToggle}
          onClick={() => { setCustomRange(v => !v); setData(null); }}>
          {customRange ? `← ${t.pcrRunUsePeriods}` : t.pcrRunCustomRange}
        </button>
      )}

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

          {data.notices?.length > 0 && (
            <div style={s.noticeBox}>
              <div style={s.noticeHead}>⚠ {t.pcrRunNoticeHead}</div>
              <ul style={s.errorList}>
                {data.notices.map(n => (
                  <li key={n.ruleset_id} style={s.noticeItem}>
                    <strong>{n.ruleset_name || t.pcrRunUnnamedRuleset}</strong> — {n.reason === 'schedule_incomplete' ? t.pcrRunNoticeIncomplete : t.pcrRunNoticeOutOfRange}
                  </li>
                ))}
              </ul>
            </div>
          )}

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
                  {data.rows.map((r, i) => {
                    const key = `${r.worker_id}-${r.pay_date}-${i}`;
                    const open = openRow === key;
                    return (
                      <React.Fragment key={key}>
                        <tr style={{ ...s.tr, cursor: 'pointer', ...(open ? { background: '#f0f9ff' } : {}) }}
                          onClick={() => setOpenRow(open ? null : key)} title={t.pcrRunViewStub}>
                          <td style={s.td}>{open ? '▾ ' : '▸ '}{r.pay_date}</td>
                          <td style={s.tdName}>{r.worker_name}{r.role_name ? <span style={s.muted}> · {r.role_name}</span> : ''}</td>
                          <td style={s.td}>{r.ruleset_name || <span style={s.muted}>{r.has_ruleset ? t.pcrRunUnnamedRuleset : t.pcrRunNoRule}</span>}</td>
                          <td style={s.td}>{r.period_start} – {r.period_end}</td>
                          <td style={s.tdNum}>{money(r.gross)}</td>
                          <td style={{ ...s.tdNum, color: r.deduction_total > 0 ? '#b91c1c' : undefined }}>{r.deduction_total > 0 ? `−${money(r.deduction_total)}` : '—'}</td>
                          <td style={{ ...s.tdNum, fontWeight: 700 }}>{money(r.net)}</td>
                        </tr>
                        {open && (
                          <tr>
                            <td colSpan={7} style={{ padding: '10px 14px', background: '#f8fafc' }}>
                              <PayStub check={r} currency={currency} />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
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
          ) : (data.errors.length === 0 && !(data.notices?.length) && <p style={s.note}>{t.pcrRunEmpty}</p>)}

          {canManagePayroll && !loading && data.rows.length > 0 && (
            <div style={s.finalizeRow}>
              <button
                style={{ ...s.finalizeBtn, ...((finalizing || data.errors.length > 0) ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
                onClick={finalize} disabled={finalizing || data.errors.length > 0}
                title={data.errors.length > 0 ? t.pcrRunFinalizeBlocked : undefined}>
                {finalizing ? t.pcrRunFinalizing : t.pcrRunFinalize}
              </button>
              <span style={s.finalizeHint}>{data.errors.length > 0 ? t.pcrRunFinalizeBlocked : t.pcrRunFinalizeHint}</span>
              {finalizeMsg && <span style={s.finalizeMsg}>{finalizeMsg}</span>}
            </div>
          )}

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
  csvBtn: { background: '#059669', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  modeToggle: { background: 'none', border: 'none', color: 'var(--ops-page-accent)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0, margin: '-6px 0 14px' },
  error: { color: '#ef4444', fontSize: 13, marginBottom: 10 },
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '14px 16px', marginBottom: 16 },
  errorHead: { fontSize: 14, fontWeight: 700, color: '#991b1b', marginBottom: 8 },
  errorList: { margin: '0 0 8px', paddingLeft: 20 },
  errorItem: { fontSize: 13, color: '#7f1d1d', marginBottom: 3, lineHeight: 1.5 },
  errorHint: { fontSize: 12, color: '#b91c1c', margin: 0 },
  noticeBox: { background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '14px 16px', marginBottom: 16 },
  noticeHead: { fontSize: 14, fontWeight: 700, color: '#92400e', marginBottom: 8 },
  noticeItem: { fontSize: 13, color: '#78350f', marginBottom: 3, lineHeight: 1.5 },
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
  finalizeRow: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 16 },
  finalizeBtn: { background: '#0f766e', color: '#fff', border: 'none', padding: '9px 22px', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  finalizeHint: { fontSize: 12, color: '#6b7280', maxWidth: 380, lineHeight: 1.4 },
  finalizeMsg: { fontSize: 13, fontWeight: 600, color: '#0f766e' },
  footnote: { fontSize: 12, color: '#94a3b8', margin: '14px 0 0', lineHeight: 1.5, maxWidth: 640, background: '#f8fafc', border: '1px solid #eef0f2', borderRadius: 6, padding: '7px 11px' },
};
