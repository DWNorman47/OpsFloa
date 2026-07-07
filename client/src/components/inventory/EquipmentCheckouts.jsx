import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api';
import { useAuth } from '../../contexts/AuthContext';
import { useT } from '../../hooks/useT';
import { labelSg } from '../../companyLabels';
import { langToLocale } from '../../utils';
import { silentError } from '../../errorReporter';
import QrScannerModal from './QrScannerModal';
import { parseAssetQR } from './AssetLabelModal';

function today() { return new Date().toLocaleDateString('en-CA'); }
function fmtDate(value, locale = 'en-US') {
  if (!value) return '';
  const raw = value.toString().substring(0, 10);
  const d = new Date(`${raw}T12:00:00`);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}
const isOverdue = due => due && due.toString().substring(0, 10) < today();

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/**
 * Equipment → Checked out. Lists open custody rows (who has which asset out, on
 * what job, due when) and drives the check-out / return actions. Availability
 * comes from GET /equipment (status === 'available'); the server's partial
 * unique index is the real guard against a double check-out.
 */
export default function EquipmentCheckouts({ projects = [], settings = null, onChange }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const workerLabel = labelSg(settings?.label_worker, 'worker', user?.language);
  const workLabel = labelSg(settings?.label_work, 'work', user?.language);

  const [checkouts, setCheckouts] = useState([]);
  const [assets, setAssets] = useState([]);
  const [team, setTeam] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [returningId, setReturningId] = useState(null);
  const [returnPhoto, setReturnPhoto] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanAssetId, setScanAssetId] = useState('');

  const load = useCallback(() => {
    Promise.all([
      api.get('/equipment/checkouts').then(r => r.data).catch(err => { silentError('equipmentcheckouts')(err); return []; }),
      api.get('/equipment').then(r => r.data).catch(() => []),
      api.get('/team').then(r => r.data.team || []).catch(() => []),
    ]).then(([c, a, tm]) => {
      setCheckouts(c);
      setAssets(a);
      setTeam(tm);
      setLoading(false);
    });
  }, []);
  useEffect(() => { load(); }, [load]);

  const available = assets.filter(a => a.status === 'available');

  const doCheckout = async (form) => {
    setBusy('checkout'); setError('');
    try {
      await api.post(`/equipment/${form.asset_id}/checkout`, {
        user_id: form.user_id || null,
        project_id: form.project_id || null,
        due_at: form.due_at || null,
        notes: form.notes?.trim() || null,
        checkout_photo: form.checkout_photo || null,
      });
      setShowForm(false);
      setScanAssetId('');
      load();
      onChange?.();
    } catch (err) {
      setError(err?.response?.data?.error || t.eqCheckoutFailed);
    } finally { setBusy(''); }
  };

  // Scanned an asset QR tag → validate and open the checkout form pre-filled.
  const onScan = (raw) => {
    setScanning(false);
    const parsed = parseAssetQR(raw);
    if (!parsed) { setError(t.eqScanNotRecognized); return; }
    const asset = assets.find(a => String(a.id) === String(parsed.id));
    if (!asset) { setError(t.eqScanNotFound); return; }
    if (asset.status !== 'available') { setError(`${asset.name}: ${t.eqScanUnavailable}`); return; }
    setError('');
    setScanAssetId(String(asset.id));
    setShowForm(true);
  };

  const doReturn = async (assetId, photo) => {
    setBusy(`return-${assetId}`); setError('');
    try {
      await api.post(`/equipment/${assetId}/return`, { return_photo: photo || null });
      setReturningId(null); setReturnPhoto(null);
      load();
      onChange?.();
    } catch (err) {
      setError(err?.response?.data?.error || t.eqReturnFailed);
    } finally { setBusy(''); }
  };

  if (loading) return <div className="ops-loading-state">{t.loading || 'Loading…'}</div>;

  return (
    <div>
      <div style={s.topRow}>
        <div>
          <h2 style={s.heading}>{t.invTabEqCheckedOut}</h2>
          <p style={s.summary}>{checkouts.length} {t.eqOutNow}</p>
        </div>
        <div style={s.headBtns}>
          <button style={s.scanBtn} onClick={() => { setScanning(true); setError(''); }}>📷 {t.eqScanBtn}</button>
          <button style={s.newBtn} onClick={() => { setShowForm(v => !v); setScanAssetId(''); setError(''); }}>
            {showForm ? t.cancel : `＋ ${t.eqCheckOutBtn}`}
          </button>
        </div>
      </div>

      {showForm && (
        <CheckoutForm
          t={t} available={available} team={team} projects={projects}
          workerLabel={workerLabel} workLabel={workLabel} initialAssetId={scanAssetId}
          busy={busy === 'checkout'} onSubmit={doCheckout} onCancel={() => { setShowForm(false); setScanAssetId(''); }}
        />
      )}
      {scanning && <QrScannerModal onDetect={onScan} onClose={() => setScanning(false)} />}
      {error && <p style={s.error} role="alert">{error}</p>}

      {checkouts.length === 0 ? (
        <div style={s.empty}>
          <div style={s.emptyIcon}>🧰</div>
          <div style={s.emptyTitle}>{t.eqNoneOut}</div>
          <div style={s.emptyText}>{t.eqNoneOutHint}</div>
        </div>
      ) : (
        <div style={s.list}>
          {checkouts.map(c => {
            const over = isOverdue(c.due_at);
            return (
              <div key={c.id} style={{ ...s.card, ...(over ? s.cardOverdue : {}) }}>
                <div style={s.cardLeft}>
                  <div style={s.itemName}>
                    {c.asset_name}
                    {c.unit_number && <span style={s.unitTag}>{c.unit_number}</span>}
                  </div>
                  <div style={s.itemMeta}>
                    <span>{t.eqCheckedOutTo}: <b>{c.holder_name || '—'}</b></span>
                    {c.project_name && <span>· {workLabel}: {c.project_name}</span>}
                    {c.due_at && (
                      <span style={over ? s.overdue : undefined}>
                        · {over ? t.eqOverdue : t.eqDueBack}: {fmtDate(c.due_at, locale)}
                      </span>
                    )}
                    <span>· {fmtDate(c.checked_out_at, locale)}</span>
                    {c.checkout_photo_url && <a href={c.checkout_photo_url} target="_blank" rel="noreferrer" style={s.photoLink} title={t.eqConditionPhoto}>📷</a>}
                  </div>
                </div>
                {returningId === c.id ? (
                  <div style={s.returnRow}>
                    <label style={s.photoPick}>
                      {returnPhoto ? `✓ ${t.eqPhotoAdded}` : `📷 ${t.eqAddPhoto}`}
                      <input type="file" accept="image/*" hidden onChange={async e => { const f = e.target.files?.[0]; if (f) setReturnPhoto(await fileToDataUrl(f)); }} />
                    </label>
                    <button style={s.returnConfirm} disabled={busy === `return-${c.asset_id}`} onClick={() => doReturn(c.asset_id, returnPhoto)}>
                      {busy === `return-${c.asset_id}` ? '…' : t.eqConfirmReturn}
                    </button>
                    <button style={s.cancelSmall} onClick={() => { setReturningId(null); setReturnPhoto(null); }}>{t.cancel}</button>
                  </div>
                ) : (
                  <button style={s.returnBtn} onClick={() => { setReturningId(c.id); setReturnPhoto(null); setError(''); }}>{t.eqReturnBtn}</button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CheckoutForm({ t, available, team, projects, workerLabel, workLabel, initialAssetId = '', busy, onSubmit, onCancel }) {
  const [form, setForm] = useState({ asset_id: initialAssetId || '', user_id: '', project_id: '', due_at: '', notes: '', checkout_photo: null });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const submit = e => { e.preventDefault(); if (form.asset_id) onSubmit(form); };

  return (
    <form style={s.formCard} onSubmit={submit}>
      <div style={s.formGrid}>
        <label style={s.field}>
          <span style={s.label}>{t.eqAsset}</span>
          <select style={s.input} value={form.asset_id} onChange={e => set('asset_id', e.target.value)} required>
            <option value="">{available.length ? t.eqSelectAsset : t.eqNoAvailable}</option>
            {available.map(a => <option key={a.id} value={a.id}>{a.name}{a.unit_number ? ` (${a.unit_number})` : ''}</option>)}
          </select>
        </label>
        <label style={s.field}>
          <span style={s.label}>{workerLabel}</span>
          <select style={s.input} value={form.user_id} onChange={e => set('user_id', e.target.value)}>
            <option value="">—</option>
            {team.map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}
          </select>
        </label>
        <label style={s.field}>
          <span style={s.label}>{workLabel}</span>
          <select style={s.input} value={form.project_id} onChange={e => set('project_id', e.target.value)}>
            <option value="">—</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label style={s.field}>
          <span style={s.label}>{t.eqDueBack}</span>
          <input style={s.input} type="date" value={form.due_at} onChange={e => set('due_at', e.target.value)} />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 12 }}>
        <label style={{ ...s.field, flex: 1, minWidth: 180 }}>
          <span style={s.label}>{t.notes}</span>
          <input style={s.input} value={form.notes} onChange={e => set('notes', e.target.value)} maxLength={1000} />
        </label>
        <label style={{ ...s.field, flex: 1, minWidth: 180 }}>
          <span style={s.label}>{t.eqConditionPhoto}</span>
          <input style={s.input} type="file" accept="image/*"
            onChange={async e => { const f = e.target.files?.[0]; if (f) set('checkout_photo', await fileToDataUrl(f)); }} />
        </label>
      </div>
      <div style={s.formActions}>
        <button type="button" style={s.cancelBtn} onClick={onCancel}>{t.cancel}</button>
        <button type="submit" style={{ ...s.saveBtn, ...(busy || !form.asset_id ? { opacity: 0.6 } : {}) }} disabled={busy || !form.asset_id}>
          {busy ? '…' : t.eqCheckOutBtn}
        </button>
      </div>
    </form>
  );
}

const s = {
  topRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' },
  heading: { fontSize: 22, fontWeight: 800, color: '#111827', margin: 0 },
  summary: { fontSize: 13, color: '#6b7280', margin: '4px 0 0' },
  headBtns: { display: 'flex', gap: 8, flexWrap: 'wrap', flexShrink: 0 },
  scanBtn: { background: '#fff', color: '#059669', border: '1px solid #059669', padding: '10px 16px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  newBtn: { background: '#059669', color: '#fff', border: 'none', padding: '10px 18px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer', flexShrink: 0 },
  formCard: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 20 },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14 },
  field: { display: 'flex', flexDirection: 'column', gap: 5 },
  label: { fontSize: 12, fontWeight: 600, color: '#6b7280' },
  input: { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 14 },
  formActions: { display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 },
  cancelBtn: { background: '#f3f4f6', border: 'none', color: '#374151', padding: '9px 18px', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  saveBtn: { background: '#059669', color: '#fff', border: 'none', padding: '9px 22px', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  error: { color: '#ef4444', fontSize: 13, margin: '0 0 12px' },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  card: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, background: '#fff', borderRadius: 12, boxShadow: '0 1px 6px rgba(0,0,0,0.07)', padding: '14px 16px' },
  cardOverdue: { boxShadow: '0 1px 6px rgba(0,0,0,0.07), inset 3px 0 0 #ef4444' },
  cardLeft: { flex: 1, minWidth: 0 },
  itemName: { fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 4, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  unitTag: { background: '#f3f4f6', padding: '1px 7px', borderRadius: 8, fontWeight: 600, fontSize: 12, color: '#6b7280' },
  itemMeta: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: '#6b7280' },
  overdue: { color: '#ef4444', fontWeight: 700 },
  returnBtn: { background: '#f3f4f6', border: '1px solid #d1d5db', color: '#374151', padding: '8px 16px', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer', flexShrink: 0 },
  returnRow: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' },
  photoPick: { fontSize: 12, color: '#374151', background: '#f3f4f6', border: '1px solid #d1d5db', padding: '7px 10px', borderRadius: 7, cursor: 'pointer', fontWeight: 600 },
  returnConfirm: { background: '#059669', color: '#fff', border: 'none', padding: '8px 14px', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  cancelSmall: { background: 'none', border: 'none', color: '#6b7280', fontSize: 12, cursor: 'pointer' },
  photoLink: { textDecoration: 'none', fontSize: 13 },
  empty: { textAlign: 'center', padding: '60px 20px' },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyTitle: { margin: '0 0 6px', fontSize: 18, fontWeight: 800, color: '#111827' },
  emptyText: { color: '#6b7280', fontSize: 15 },
};
