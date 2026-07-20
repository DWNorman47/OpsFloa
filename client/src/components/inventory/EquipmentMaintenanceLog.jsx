import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api';
import { useAuth } from '../../contexts/AuthContext';
import { useT } from '../../hooks/useT';
import { formatCurrency, langToLocale } from '../../utils';
import { useCurrency } from '../../contexts/SettingsContext';
import { silentError } from '../../errorReporter';

function today() { return new Date().toLocaleDateString('en-CA'); }
function fmtDate(value, locale = 'en-US') {
  if (!value) return '';
  const raw = value.toString().substring(0, 10);
  const d = new Date(`${raw}T12:00:00`);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Equipment → Maintenance. Per-asset service/repair/inspection records (distinct
 * from the engine-hours usage log on the Assets tab). Pick an asset to see its
 * history and, as an admin, add or remove records.
 */
export default function EquipmentMaintenanceLog() {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const currency = useCurrency();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';

  const [assets, setAssets] = useState([]);
  const [assetId, setAssetId] = useState('');
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [confirmDel, setConfirmDel] = useState(null);

  const kindLabel = k => ({ service: t.eqMaintService, repair: t.eqMaintRepair, inspection: t.eqMaintInspection, other: t.eqMaintOther }[k] || k);

  useEffect(() => {
    api.get('/equipment').then(r => {
      setAssets(r.data);
      if (r.data.length && !assetId) setAssetId(String(r.data[0].id));
      setLoading(false);
    }).catch(err => { silentError('equipmentmaint')(err); setLoading(false); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadLogs = useCallback(() => {
    if (!assetId) { setLogs([]); return; }
    api.get(`/equipment/${assetId}/maintenance`).then(r => setLogs(r.data)).catch(silentError('equipmentmaint'));
  }, [assetId]);
  useEffect(() => { loadLogs(); }, [loadLogs]);

  const addLog = async (form) => {
    setError('');
    try {
      await api.post(`/equipment/${assetId}/maintenance`, {
        log_date: form.log_date, kind: form.kind,
        cost: form.cost, performed_by: form.performed_by?.trim() || null, notes: form.notes?.trim() || null,
      });
      setAdding(false);
      loadLogs();
    } catch (err) {
      setError(err?.response?.data?.error || t.eqMaintSaveFailed);
    }
  };

  const delLog = async (id) => {
    try { await api.delete(`/equipment/maintenance/${id}`); setConfirmDel(null); loadLogs(); }
    catch (err) { setError(err?.response?.data?.error || t.eqMaintSaveFailed); }
  };

  if (loading) return <div className="ops-loading-state">{t.loading || 'Loading…'}</div>;

  if (!assets.length) {
    return (
      <div style={s.empty}>
        <div style={s.emptyIcon}>🛠️</div>
        <div style={s.emptyTitle}>{t.eqMaintNoAssets}</div>
        <div style={s.emptyText}>{t.eqMaintNoAssetsHint}</div>
      </div>
    );
  }

  return (
    <div>
      <div style={s.topRow}>
        <label style={s.field}>
          <span style={s.label}>{t.eqAsset}</span>
          <select style={s.input} value={assetId} onChange={e => { setAssetId(e.target.value); setAdding(false); }}>
            {assets.map(a => <option key={a.id} value={a.id}>{a.name}{a.unit_number ? ` (${a.unit_number})` : ''}</option>)}
          </select>
        </label>
        {isAdmin && (
          <button style={s.newBtn} onClick={() => { setAdding(v => !v); setError(''); }}>
            {adding ? t.cancel : `＋ ${t.eqMaintAdd}`}
          </button>
        )}
      </div>

      {adding && <MaintForm t={t} onSubmit={addLog} onCancel={() => setAdding(false)} />}
      {error && <p style={s.error} role="alert">{error}</p>}

      {logs.length === 0 ? (
        <div style={s.emptyText}>{t.eqMaintNone}</div>
      ) : (
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>{t.eqMaintDate}</th>
              <th style={s.th}>{t.eqMaintKind}</th>
              <th style={s.th}>{t.notes}</th>
              <th style={{ ...s.th, textAlign: 'right' }}>{t.eqMaintCost}</th>
              <th style={s.th}></th>
            </tr>
          </thead>
          <tbody>
            {logs.map(m => (
              <tr key={m.id}>
                <td style={s.td}>{fmtDate(m.log_date, locale)}</td>
                <td style={s.td}><span style={s.kindTag}>{kindLabel(m.kind)}</span></td>
                <td style={{ ...s.td, color: '#6b7280' }}>{m.notes || ''}{m.performed_by ? ` — ${m.performed_by}` : ''}</td>
                <td style={{ ...s.td, textAlign: 'right' }}>{m.cost != null ? formatCurrency(Number(m.cost), currency) : ''}</td>
                <td style={{ ...s.td, textAlign: 'right' }}>
                  {(isAdmin || m.created_by === user?.id) && (
                    confirmDel === m.id ? (
                      <>
                        <button style={s.confirmDel} onClick={() => delLog(m.id)}>{t.delete || 'Delete'}</button>
                        <button style={s.cancelSmall} onClick={() => setConfirmDel(null)}>{t.cancel}</button>
                      </>
                    ) : (
                      <button style={s.delSmall} onClick={() => setConfirmDel(m.id)}>✕</button>
                    )
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function MaintForm({ t, onSubmit, onCancel }) {
  const [f, setF] = useState({ log_date: today(), kind: 'service', cost: '', performed_by: '', notes: '' });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  return (
    <form style={s.formCard} onSubmit={e => { e.preventDefault(); onSubmit(f); }}>
      <div style={s.formGrid}>
        <label style={s.field}><span style={s.label}>{t.eqMaintDate}</span>
          <input style={s.input} type="date" value={f.log_date} onChange={e => set('log_date', e.target.value)} required /></label>
        <label style={s.field}><span style={s.label}>{t.eqMaintKind}</span>
          <select style={s.input} value={f.kind} onChange={e => set('kind', e.target.value)}>
            <option value="service">{t.eqMaintService}</option>
            <option value="repair">{t.eqMaintRepair}</option>
            <option value="inspection">{t.eqMaintInspection}</option>
            <option value="other">{t.eqMaintOther}</option>
          </select></label>
        <label style={s.field}><span style={s.label}>{t.eqMaintCost}</span>
          <input style={s.input} type="number" min="0" step="0.01" value={f.cost} onChange={e => set('cost', e.target.value)} /></label>
        <label style={s.field}><span style={s.label}>{t.eqMaintBy}</span>
          <input style={s.input} value={f.performed_by} onChange={e => set('performed_by', e.target.value)} maxLength={255} /></label>
      </div>
      <label style={{ ...s.field, marginTop: 12 }}><span style={s.label}>{t.notes}</span>
        <input style={s.input} value={f.notes} onChange={e => set('notes', e.target.value)} maxLength={1000} /></label>
      <div style={s.formActions}>
        <button type="button" style={s.cancelBtn} onClick={onCancel}>{t.cancel}</button>
        <button type="submit" style={s.saveBtn}>{t.save || 'Save'}</button>
      </div>
    </form>
  );
}

const s = {
  topRow: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' },
  newBtn: { background: '#059669', color: '#fff', border: 'none', padding: '10px 18px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer', flexShrink: 0 },
  formCard: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 20 },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 180 },
  label: { fontSize: 12, fontWeight: 600, color: '#6b7280' },
  input: { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 14 },
  formActions: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 },
  cancelBtn: { background: '#f3f4f6', border: 'none', color: '#374151', padding: '9px 18px', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  saveBtn: { background: '#059669', color: '#fff', border: 'none', padding: '9px 22px', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  error: { color: '#ef4444', fontSize: 13, margin: '0 0 12px' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13, background: '#fff', borderRadius: 12, overflow: 'hidden', boxShadow: '0 1px 6px rgba(0,0,0,0.07)' },
  th: { textAlign: 'left', fontWeight: 700, color: '#6b7280', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', padding: '10px 12px', borderBottom: '2px solid #e5e7eb', background: '#f9fafb' },
  td: { padding: '10px 12px', borderBottom: '1px solid #f3f4f6', color: '#374151', verticalAlign: 'middle' },
  kindTag: { background: '#eef2ff', color: '#4338ca', padding: '2px 8px', borderRadius: 8, fontWeight: 600, fontSize: 12 },
  delSmall: { background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 14 },
  confirmDel: { background: '#ef4444', color: '#fff', border: 'none', padding: '3px 8px', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer', marginRight: 6 },
  cancelSmall: { background: 'none', border: 'none', color: '#6b7280', fontSize: 12, cursor: 'pointer' },
  empty: { textAlign: 'center', padding: '60px 20px' },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyTitle: { margin: '0 0 6px', fontSize: 18, fontWeight: 800, color: '#111827' },
  emptyText: { color: '#6b7280', fontSize: 15, textAlign: 'center', padding: '20px 0' },
};
