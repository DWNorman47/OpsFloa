import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { formatCurrency } from '../utils';
import { silentError } from '../errorReporter';
import PayStub from './PayStub';

/**
 * Payroll History — finalized runs (locked snapshots). Each run expands to its
 * checks; checks can be marked paid (one or all) and a whole run can be voided.
 * Money comes back in CENTS from the snapshot, so we divide by 100 for display.
 * A check's `detail` JSONB restores the original stub via <PayStub>. Gated on the
 * Advanced Payroll add-on server-side (same as the live run).
 */
export default function PayrollHistory({ currency = 'USD', refreshKey }) {
  const t = useT();
  const money = cents => formatCurrency((Number(cents) || 0) / 100, currency);
  const [runs, setRuns] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null); // { run, checks }
  const [openCheck, setOpenCheck] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get('/admin/payroll-runs').then(r => setRuns(r.data || [])).catch(silentError('payroll-history'));
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  const loadDetail = async (id) => {
    try { const r = await api.get(`/admin/payroll-runs/${id}`); setDetail(r.data); }
    catch (e) { silentError('payroll-history')(e); }
  };

  const openRun = (id) => {
    setOpenCheck(null);
    if (openId === id) { setOpenId(null); setDetail(null); return; }
    setOpenId(id); setDetail(null); loadDetail(id);
  };

  const markAllPaid = async (id) => {
    setBusy(true);
    try { await api.post(`/admin/payroll-runs/${id}/paid`, { all: true }); await loadDetail(id); load(); }
    catch (e) { silentError('payroll-history')(e); } finally { setBusy(false); }
  };
  const markOnePaid = async (id, checkId) => {
    setBusy(true);
    try { await api.post(`/admin/payroll-runs/${id}/paid`, { check_ids: [checkId] }); await loadDetail(id); load(); }
    catch (e) { silentError('payroll-history')(e); } finally { setBusy(false); }
  };
  const voidRun = async (id) => {
    if (!window.confirm(t.pcrHistVoidConfirm)) return;
    setBusy(true);
    try { await api.post(`/admin/payroll-runs/${id}/void`, {}); load(); if (openId === id) { setOpenId(null); setDetail(null); } }
    catch (e) { silentError('payroll-history')(e); } finally { setBusy(false); }
  };

  // Rebuild a PayStub-shaped check from the snapshot row.
  const stubOf = (c) => {
    const d = c.detail || {};
    return {
      worker_name: c.worker_name, role_name: c.role_name, ruleset_name: c.ruleset_name,
      pay_date: c.pay_date, period_start: c.period_start, period_end: c.period_end,
      gross: (Number(c.gross_cents) || 0) / 100, deduction_total: (Number(c.deduction_cents) || 0) / 100,
      net: (Number(c.net_cents) || 0) / 100,
      hours: d.hours, cost: d.cost, deduction_lines: d.deduction_lines || [],
      exempt: d.exempt, combined_gross: d.combined_gross, rate: d.rate, deducts: d.deducts,
    };
  };

  if (runs.length === 0) return null; // nothing finalized yet → hide the section entirely

  return (
    <div style={s.card}>
      <h3 style={s.title}>{t.pcrHistTitle}</h3>
      <p style={s.sub}>{t.pcrHistDesc}</p>
      {runs.map(run => {
        const open = openId === run.id;
        const voided = run.status === 'void';
        const allPaid = run.paid_count >= run.check_count;
        return (
          <div key={run.id} style={{ ...s.runCard, ...(voided ? { opacity: 0.62 } : {}) }}>
            <div style={s.runHead} onClick={() => openRun(run.id)}>
              <span style={s.runPeriod}>{open ? '▾' : '▸'} <strong>{run.period_from} – {run.period_to}</strong></span>
              <span style={s.runMeta}>{run.check_count} {t.pcrHistChecks} · {run.paid_count}/{run.check_count} {t.pcrHistPaidWord}</span>
              <span style={s.runNet}>{money(run.net_cents)}</span>
              {voided
                ? <span style={s.voidBadge}>{t.pcrHistVoided}</span>
                : allPaid
                  ? <span style={s.paidBadge}>{t.pcrHistAllPaid}</span>
                  : <span style={s.pendBadge}>{t.pcrHistPending}</span>}
            </div>

            {open && detail && detail.run.id === run.id && (
              <div style={s.runBody}>
                <div style={s.actions}>
                  {!voided && detail.checks.some(c => c.status !== 'paid') && (
                    <button style={s.actBtn} disabled={busy} onClick={() => markAllPaid(run.id)}>{t.pcrHistMarkAllPaid}</button>
                  )}
                  {!voided && (
                    <button style={{ ...s.actBtn, color: '#b91c1c', borderColor: '#fecaca', background: '#fff' }} disabled={busy} onClick={() => voidRun(run.id)}>{t.pcrHistVoid}</button>
                  )}
                </div>
                <div style={s.tableWrap}>
                  <table style={s.table}>
                    <thead>
                      <tr>
                        <th style={s.th}>{t.pcrRunPayDate}</th>
                        <th style={s.th}>{t.pcrRunWorker}</th>
                        <th style={s.thNum}>{t.pcrRunGross}</th>
                        <th style={s.thNum}>{t.pcrRunDeductions}</th>
                        <th style={s.thNum}>{t.pcrRunNet}</th>
                        <th style={s.th}>{t.pcrHistStatusCol}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.checks.map(c => {
                        const co = openCheck === c.id;
                        return (
                          <React.Fragment key={c.id}>
                            <tr style={{ ...s.tr, cursor: 'pointer', ...(co ? { background: '#f0f9ff' } : {}) }}
                              onClick={() => setOpenCheck(co ? null : c.id)} title={t.pcrRunViewStub}>
                              <td style={s.td}>{co ? '▾ ' : '▸ '}{c.pay_date}</td>
                              <td style={s.tdName}>{c.worker_name}{c.role_name ? <span style={s.muted}> · {c.role_name}</span> : ''}</td>
                              <td style={s.tdNum}>{money(c.gross_cents)}</td>
                              <td style={{ ...s.tdNum, color: c.deduction_cents > 0 ? '#b91c1c' : undefined }}>{c.deduction_cents > 0 ? `−${money(c.deduction_cents)}` : '—'}</td>
                              <td style={{ ...s.tdNum, fontWeight: 700 }}>{money(c.net_cents)}</td>
                              <td style={s.td} onClick={e => e.stopPropagation()}>
                                {c.status === 'paid'
                                  ? <span style={s.paidChip}>{t.pcrHistPaidBadge}</span>
                                  : voided
                                    ? <span style={s.muted}>—</span>
                                    : <button style={s.tinyBtn} disabled={busy} onClick={() => markOnePaid(run.id, c.id)}>{t.pcrHistMarkPaid}</button>}
                              </td>
                            </tr>
                            {co && (
                              <tr>
                                <td colSpan={6} style={{ padding: '10px 14px', background: '#f8fafc' }}>
                                  <PayStub check={stubOf(c)} currency={currency} />
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const s = {
  card: { background: '#fff', borderRadius: 12, padding: 28, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 24 },
  title: { fontSize: 17, fontWeight: 700, marginBottom: 6 },
  sub: { fontSize: 13, color: '#6b7280', marginBottom: 18, lineHeight: 1.5, maxWidth: 620 },
  runCard: { border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 10, overflow: 'hidden' },
  runHead: { display: 'flex', gap: 14, alignItems: 'center', padding: '11px 14px', cursor: 'pointer', flexWrap: 'wrap' },
  runPeriod: { fontSize: 14, color: '#111827', flex: '1 1 200px' },
  runMeta: { fontSize: 12, color: '#6b7280' },
  runNet: { fontSize: 14, fontWeight: 700, color: '#111827', minWidth: 90, textAlign: 'right' },
  voidBadge: { fontSize: 11, fontWeight: 700, color: '#6b7280', background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 20, padding: '2px 10px' },
  paidBadge: { fontSize: 11, fontWeight: 700, color: '#065f46', background: '#d1fae5', borderRadius: 20, padding: '2px 10px' },
  pendBadge: { fontSize: 11, fontWeight: 700, color: '#92400e', background: '#fef3c7', borderRadius: 20, padding: '2px 10px' },
  runBody: { borderTop: '1px solid #f3f4f6', padding: '12px 14px', background: '#fcfcfd' },
  actions: { display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' },
  actBtn: { background: '#0f766e', color: '#fff', border: '1px solid transparent', padding: '6px 14px', borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  tableWrap: { overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 600 },
  th: { background: '#f3f4f6', padding: '7px 10px', textAlign: 'left', borderBottom: '2px solid #e5e7eb', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6b7280', whiteSpace: 'nowrap' },
  thNum: { background: '#f3f4f6', padding: '7px 10px', textAlign: 'right', borderBottom: '2px solid #e5e7eb', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.4px', color: '#6b7280', whiteSpace: 'nowrap' },
  tr: { borderBottom: '1px solid #f3f4f6' },
  td: { padding: '7px 10px', textAlign: 'left', fontSize: 13, color: '#374151' },
  tdName: { padding: '7px 10px', textAlign: 'left', fontWeight: 600, fontSize: 13, color: '#111827', whiteSpace: 'nowrap' },
  tdNum: { padding: '7px 10px', textAlign: 'right', fontSize: 13, color: '#374151', whiteSpace: 'nowrap' },
  muted: { color: '#9ca3af' },
  paidChip: { fontSize: 11, fontWeight: 700, color: '#065f46', background: '#d1fae5', borderRadius: 20, padding: '2px 10px' },
  tinyBtn: { background: '#fff', color: '#0f766e', border: '1px solid #99f6e4', padding: '3px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer' },
};
