// Effective-dated pay rates (server: routes/rateHistory.js, migration 0209).
//
// <RateHistory kind="worker|project|company" ownerId=… /> shows the compact
// history list (from, rate, type, who, note) with delete-for-mistakes, and —
// with `allowAdd` — its own small "add a change" row. `withLockedConfirm`
// wraps any save that may be backdated into LOCKED pay periods: the server
// answers 409 { code: 'locked_periods' } and we ask for an explicit confirm
// before resending with confirm_locked: true.
//
// Each day is paid at the rate in effect on that day, so changing a rate never
// rewrites earlier pay — the copy below says so.

import React, { useCallback, useEffect, useState } from 'react';
import api from '../api';
import { formatCurrency } from '../utils';
import { useT } from '../hooks/useT';
import { useConfirm } from './ConfirmDialog';

const PATHS = {
  worker: id => `/admin/workers/${id}/rate-history`,
  project: id => `/admin/projects/${id}/prevailing-rate-history`,
  company: () => '/admin/company/default-rate-history',
};

const fill = (s, vars) => String(s || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));

/** Today's date as 'YYYY-MM-DD' in the browser's zone (the server's company-tz date wins when loaded). */
export function localToday() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Run `send(confirmLocked)`; on a 409 locked_periods answer, ask the admin to
 * confirm (naming the locked periods) and resend with confirmLocked = true.
 * Resolves to the response, or null when the admin cancelled.
 */
export async function withLockedConfirm(send, confirm, t) {
  try {
    return await send(false);
  } catch (err) {
    const d = err?.response?.data;
    if (err?.response?.status !== 409 || d?.code !== 'locked_periods') throw err;
    const list = (d.locked_periods || []).map(p => p.label || `${p.period_start} – ${p.period_end}`);
    const ok = await confirm({
      title: t.rhLockedTitle,
      body: fill(t.rhLockedBody, { n: d.locked_count ?? list.length, periods: list.join(', ') }),
      confirmLabel: t.rhLockedConfirm,
      tone: 'danger',
    });
    if (!ok) return null;
    return send(true);
  }
}

/** The "Effective from" date input used next to every rate field. */
export function EffectiveDateField({ id, value, onChange, today, style }) {
  const t = useT();
  const backdated = value && today && value < today;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, ...style }}>
      <label htmlFor={id} style={st.label}>{t.rhEffectiveFrom}</label>
      <input id={id} type="date" style={st.input} value={value || ''} onChange={e => onChange(e.target.value)} />
      <span style={{ ...st.hint, ...(backdated ? { color: '#b45309' } : {}) }}>
        {backdated ? t.rhBackdatedHint : t.rhEffectiveHint}
      </span>
    </div>
  );
}

export default function RateHistory({ kind, ownerId, currency, allowAdd = false, reloadKey = 0, onChanged }) {
  const t = useT();
  const { confirm, dialog } = useConfirm();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ rate: '', rate_type: '', effective_date: '', note: '' });
  const path = PATHS[kind](ownerId);

  const load = useCallback(async () => {
    try {
      const r = await api.get(path);
      setData(r.data);
      setError('');
      setForm(f => ({ ...f, effective_date: f.effective_date || r.data.today || localToday() }));
    } catch (err) {
      setError(err?.response?.data?.error || t.rhLoadFailed);
    }
  }, [path, t.rhLoadFailed]);

  useEffect(() => { load(); }, [load, reloadKey]);

  const apply = res => {
    if (!res) return;
    setData(d => ({ ...(d || {}), history: res.data.history, current: res.data.current, today: res.data.today || d?.today }));
    onChanged?.(res.data.current);
  };

  const add = async () => {
    setBusy(true); setError('');
    try {
      const body = {
        rate: form.rate === '' ? null : parseFloat(form.rate),
        effective_date: form.effective_date || undefined,
        note: form.note || undefined,
        ...(kind === 'worker' && form.rate_type ? { rate_type: form.rate_type } : {}),
      };
      const res = await withLockedConfirm(c => api.post(path, { ...body, confirm_locked: c }), confirm, t);
      if (res) { apply(res); setForm(f => ({ ...f, rate: '', note: '' })); }
    } catch (err) {
      setError(err?.response?.data?.error || t.failedSave);
    } finally { setBusy(false); }
  };

  const remove = async row => {
    const label = row.initial ? t.rhInitial : row.effective_date;
    if (!await confirm({ title: t.rhDeleteTitle, body: fill(t.rhDeleteBody, { date: label }), confirmLabel: t.delete, tone: 'danger' })) return;
    setBusy(true); setError('');
    try {
      const res = await withLockedConfirm(c => api.delete(`${path}/${row.id}`, { data: { confirm_locked: c } }), confirm, t);
      apply(res);
    } catch (err) {
      setError(err?.response?.data?.error || t.failedSave);
    } finally { setBusy(false); }
  };

  const rows = (data?.history || []).slice().reverse(); // newest first
  const today = data?.today || localToday();
  const inEffect = (() => {
    const past = (data?.history || []).filter(r => r.effective_date <= today);
    return past.length ? past[past.length - 1].id : null;
  })();
  const fmtRate = r => {
    if (r.rate == null) return kind === 'project' ? t.rhNoProjectRate : t.rhUsesDefault;
    return formatCurrency(r.rate, currency);
  };

  return (
    <div style={st.wrap}>
      <div style={st.head}>
        <span style={st.title}>{t.rhTitle}</span>
        <span style={st.hint}>{t.rhPastPayNote}</span>
      </div>
      {error && <div style={st.error} role="alert">{error}</div>}
      {!data && !error && <div style={st.hint}>{t.loading}</div>}
      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={st.table}>
            <thead>
              <tr>
                <th style={st.th}>{t.rhDate}</th>
                <th style={st.th}>{t.rhRate}</th>
                {kind === 'worker' && <th style={st.th}>{t.rhType}</th>}
                <th style={st.th}>{t.rhBy}</th>
                <th style={st.th}>{t.rhNote}</th>
                <th style={st.th} aria-label={t.delete} />
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td style={st.td}>
                    {r.initial ? t.rhInitial : r.effective_date}
                    {r.id === inEffect && <span style={st.badgeNow}>{t.rhCurrent}</span>}
                    {r.effective_date > today && <span style={st.badgeLater}>{t.rhScheduled}</span>}
                  </td>
                  <td style={st.td}>{fmtRate(r)}</td>
                  {kind === 'worker' && <td style={st.td}>{r.rate_type === 'daily' ? t.rhDaily : t.rhHourly}</td>}
                  <td style={st.td}>{r.created_by_name || '—'}</td>
                  <td style={{ ...st.td, color: '#6b7280' }}>{r.note || ''}</td>
                  <td style={st.td}>
                    {(data.history || []).length > 1 && (
                      <button type="button" style={st.del} disabled={busy} onClick={() => remove(r)} title={t.rhDeleteTitle} aria-label={t.rhDeleteTitle}>×</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {allowAdd && data && (
        <div style={st.addRow}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label htmlFor={`rh-${kind}-rate`} style={st.label}>{t.rhRate}</label>
            <input id={`rh-${kind}-rate`} type="number" min="0" step="0.01" style={{ ...st.input, maxWidth: 110 }} value={form.rate}
              placeholder={kind === 'project' ? t.rhNoProjectRate : ''} onChange={e => setForm(f => ({ ...f, rate: e.target.value }))} />
          </div>
          {kind === 'worker' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label htmlFor={`rh-${kind}-type`} style={st.label}>{t.rhType}</label>
              <select id={`rh-${kind}-type`} style={st.input} value={form.rate_type} onChange={e => setForm(f => ({ ...f, rate_type: e.target.value }))}>
                <option value="">—</option>
                <option value="hourly">{t.rhHourly}</option>
                <option value="daily">{t.rhDaily}</option>
              </select>
            </div>
          )}
          <EffectiveDateField id={`rh-${kind}-eff`} value={form.effective_date} today={today} onChange={v => setForm(f => ({ ...f, effective_date: v }))} style={{ maxWidth: 260 }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 140 }}>
            <label htmlFor={`rh-${kind}-note`} style={st.label}>{t.rhNote}</label>
            <input id={`rh-${kind}-note`} style={st.input} value={form.note} maxLength={500} placeholder={t.rhNotePh} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
          </div>
          <button type="button" style={st.addBtn} disabled={busy || (kind === 'company' && form.rate === '')} onClick={add}>{busy ? t.saving : t.rhAdd}</button>
        </div>
      )}
      {dialog}
    </div>
  );
}

const st = {
  wrap: { marginTop: 12, padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fafafa' },
  head: { display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 8 },
  title: { fontSize: 13, fontWeight: 700, color: '#374151' },
  hint: { fontSize: 12, color: '#6b7280', lineHeight: 1.4 },
  label: { fontSize: 12, fontWeight: 600, color: '#374151' },
  input: { padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', minWidth: 0 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: { textAlign: 'left', padding: '4px 6px', color: '#6b7280', fontWeight: 600, borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' },
  td: { padding: '4px 6px', borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' },
  badgeNow: { marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#047857', background: '#d1fae5', padding: '1px 6px', borderRadius: 8 },
  badgeLater: { marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#1d4ed8', background: '#dbeafe', padding: '1px 6px', borderRadius: 8 },
  del: { border: 'none', background: 'transparent', color: '#dc2626', fontSize: 16, lineHeight: 1, cursor: 'pointer', padding: '0 4px' },
  addRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10, marginTop: 10 },
  addBtn: { padding: '7px 12px', border: 'none', borderRadius: 6, background: '#1a56db', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  error: { fontSize: 12, color: '#b91c1c', marginBottom: 6 },
};
