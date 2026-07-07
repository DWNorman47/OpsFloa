import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api';
import { useAuth } from '../../contexts/AuthContext';
import { useT } from '../../hooks/useT';
import { langToLocale } from '../../utils';
import { silentError } from '../../errorReporter';

function today() { return new Date().toLocaleDateString('en-CA'); }
function fmtDate(value, locale = 'en-US') {
  if (!value) return '';
  const raw = value.toString().substring(0, 10);
  const d = new Date(`${raw}T12:00:00`);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}
const dayStr = v => (v ? v.toString().substring(0, 10) : '');
function dueState(due) {
  if (!due) return 'none';
  const d = dayStr(due), now = today();
  if (d < now) return 'overdue';
  const soon = new Date(); soon.setDate(soon.getDate() + 3);
  return d <= soon.toLocaleDateString('en-CA') ? 'soon' : 'ok';
}

// Only the fields the equipment PATCH validator (parseItemBody) reads. PATCH is
// a full replace, so we send the whole asset and override the rental bits.
function assetToBody(a) {
  return {
    name: a.name, type: a.type || '', unit_number: a.unit_number || '',
    maintenance_interval_hours: a.maintenance_interval_hours ?? '',
    notes: a.notes || '', kind: a.kind || '', serial_number: a.serial_number || '',
    purchase_date: dayStr(a.purchase_date) || '', purchase_cost: a.purchase_cost ?? '',
    photo_url: a.photo_url || '',
    is_rental: a.is_rental, rental_vendor: a.rental_vendor || '',
    rental_rate: a.rental_rate ?? '', rental_rate_unit: a.rental_rate_unit || '',
    rental_return_due: dayStr(a.rental_return_due) || '',
    updated_at: a.updated_at,
  };
}

/**
 * Equipment → Rentals. Assets flagged is_rental, with vendor / rate / return-due
 * and overdue-or-soon highlighting. Editing (admin) sends a full PATCH with the
 * rental fields overridden; the server re-arms the return reminder when the due
 * date changes.
 */
export default function EquipmentRentals({ settings = null, onChange }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';

  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);   // asset id being edited, or 'new'
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.get('/equipment').then(r => { setAssets(r.data); setLoading(false); })
      .catch(err => { silentError('equipmentrentals')(err); setLoading(false); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const rentals = assets.filter(a => a.is_rental);
  const nonRentals = assets.filter(a => !a.is_rental);

  const save = async (asset, fields) => {
    setError('');
    try {
      await api.patch(`/equipment/${asset.id}`, { ...assetToBody(asset), ...fields });
      setEditing(null);
      load();
      onChange?.();
    } catch (err) {
      setError(err?.response?.data?.error || t.eqRentalSaveFailed);
    }
  };

  if (loading) return <div className="ops-loading-state">{t.loading || 'Loading…'}</div>;

  return (
    <div>
      <div style={s.topRow}>
        <div>
          <h2 style={s.heading}>{t.invTabEqRentals}</h2>
          <p style={s.summary}>{rentals.length} {t.eqRentalsActive}</p>
        </div>
        {isAdmin && nonRentals.length > 0 && (
          <button style={s.newBtn} onClick={() => { setEditing(editing === 'new' ? null : 'new'); setError(''); }}>
            {editing === 'new' ? t.cancel : `＋ ${t.eqMarkRental}`}
          </button>
        )}
      </div>

      {editing === 'new' && (
        <RentalForm t={t} assets={nonRentals} onSave={(assetId, fields) => {
          const a = assets.find(x => String(x.id) === String(assetId));
          if (a) save(a, { ...fields, is_rental: true });
        }} onCancel={() => setEditing(null)} />
      )}
      {error && <p style={s.error} role="alert">{error}</p>}

      {rentals.length === 0 ? (
        <div style={s.empty}>
          <div style={s.emptyIcon}>📋</div>
          <div style={s.emptyTitle}>{t.eqRentalsNone}</div>
          <div style={s.emptyText}>{t.eqRentalsNoneHint}</div>
        </div>
      ) : (
        <div style={s.list}>
          {rentals.map(a => {
            const st = dueState(a.rental_return_due);
            const card = st === 'overdue' ? s.cardOverdue : st === 'soon' ? s.cardSoon : {};
            return (
              <div key={a.id} style={{ ...s.card, ...card }}>
                {editing === a.id ? (
                  <RentalEditFields t={t} asset={a}
                    onSave={fields => save(a, fields)} onCancel={() => setEditing(null)} isAdmin={isAdmin} />
                ) : (
                  <>
                    <div style={s.cardLeft}>
                      <div style={s.itemName}>
                        {a.name}{a.unit_number && <span style={s.unitTag}>{a.unit_number}</span>}
                      </div>
                      <div style={s.itemMeta}>
                        {a.rental_vendor && <span>{t.eqVendor}: <b>{a.rental_vendor}</b></span>}
                        {a.rental_rate != null && a.rental_rate !== '' && (
                          <span>· {a.rental_rate}/{a.rental_rate_unit || t.eqUnitDay}</span>
                        )}
                        {a.rental_return_due && (
                          <span style={st === 'overdue' ? s.overdue : st === 'soon' ? s.soon : undefined}>
                            · {st === 'overdue' ? t.eqOverdue : t.eqReturnDue}: {fmtDate(a.rental_return_due, locale)}
                          </span>
                        )}
                      </div>
                    </div>
                    {isAdmin && (
                      <button style={s.editBtn} onClick={() => { setEditing(a.id); setError(''); }}>{t.edit || 'Edit'}</button>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Pick an existing (non-rental) asset and set its rental fields.
function RentalForm({ t, assets, onSave, onCancel }) {
  const [assetId, setAssetId] = useState('');
  const [f, setF] = useState({ rental_vendor: '', rental_rate: '', rental_rate_unit: 'day', rental_return_due: '' });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  return (
    <form style={s.formCard} onSubmit={e => { e.preventDefault(); if (assetId) onSave(assetId, f); }}>
      <div style={s.formGrid}>
        <label style={s.field}>
          <span style={s.label}>{t.eqAsset}</span>
          <select style={s.input} value={assetId} onChange={e => setAssetId(e.target.value)} required>
            <option value="">{t.eqSelectAsset}</option>
            {assets.map(a => <option key={a.id} value={a.id}>{a.name}{a.unit_number ? ` (${a.unit_number})` : ''}</option>)}
          </select>
        </label>
        <RentalFieldInputs t={t} f={f} set={set} />
      </div>
      <div style={s.formActions}>
        <button type="button" style={s.cancelBtn} onClick={onCancel}>{t.cancel}</button>
        <button type="submit" style={{ ...s.saveBtn, ...(assetId ? {} : { opacity: 0.6 }) }} disabled={!assetId}>{t.save || 'Save'}</button>
      </div>
    </form>
  );
}

// Inline edit of a rental's fields, plus "End rental".
function RentalEditFields({ t, asset, onSave, onCancel, isAdmin }) {
  const [f, setF] = useState({
    rental_vendor: asset.rental_vendor || '', rental_rate: asset.rental_rate ?? '',
    rental_rate_unit: asset.rental_rate_unit || 'day', rental_return_due: dayStr(asset.rental_return_due),
  });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  return (
    <div style={{ width: '100%' }}>
      <div style={s.formGrid}><RentalFieldInputs t={t} f={f} set={set} /></div>
      <div style={s.formActions}>
        {isAdmin && (
          <button type="button" style={s.endBtn} onClick={() => onSave({ is_rental: false })}>{t.eqEndRental}</button>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" style={s.cancelBtn} onClick={onCancel}>{t.cancel}</button>
        <button type="button" style={s.saveBtn} onClick={() => onSave(f)}>{t.save || 'Save'}</button>
      </div>
    </div>
  );
}

function RentalFieldInputs({ t, f, set }) {
  return (
    <>
      <label style={s.field}>
        <span style={s.label}>{t.eqVendor}</span>
        <input style={s.input} value={f.rental_vendor} onChange={e => set('rental_vendor', e.target.value)} maxLength={255} />
      </label>
      <label style={s.field}>
        <span style={s.label}>{t.eqRate}</span>
        <input style={s.input} type="number" min="0" step="0.01" value={f.rental_rate} onChange={e => set('rental_rate', e.target.value)} />
      </label>
      <label style={s.field}>
        <span style={s.label}>{t.eqRateUnit}</span>
        <select style={s.input} value={f.rental_rate_unit} onChange={e => set('rental_rate_unit', e.target.value)}>
          <option value="day">{t.eqUnitDay}</option>
          <option value="week">{t.eqUnitWeek}</option>
          <option value="month">{t.eqUnitMonth}</option>
        </select>
      </label>
      <label style={s.field}>
        <span style={s.label}>{t.eqReturnDue}</span>
        <input style={s.input} type="date" value={f.rental_return_due} onChange={e => set('rental_return_due', e.target.value)} />
      </label>
    </>
  );
}

const s = {
  topRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' },
  heading: { fontSize: 22, fontWeight: 800, color: '#111827', margin: 0 },
  summary: { fontSize: 13, color: '#6b7280', margin: '4px 0 0' },
  newBtn: { background: '#059669', color: '#fff', border: 'none', padding: '10px 18px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer', flexShrink: 0 },
  formCard: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 20 },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, width: '100%' },
  field: { display: 'flex', flexDirection: 'column', gap: 5 },
  label: { fontSize: 12, fontWeight: 600, color: '#6b7280' },
  input: { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 14 },
  formActions: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginTop: 16 },
  cancelBtn: { background: '#f3f4f6', border: 'none', color: '#374151', padding: '9px 18px', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  saveBtn: { background: '#059669', color: '#fff', border: 'none', padding: '9px 22px', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  endBtn: { background: 'none', border: '1px solid #fca5a5', color: '#ef4444', padding: '9px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  editBtn: { background: '#f3f4f6', border: 'none', color: '#374151', padding: '8px 16px', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 },
  error: { color: '#ef4444', fontSize: 13, margin: '0 0 12px' },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  card: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, background: '#fff', borderRadius: 12, boxShadow: '0 1px 6px rgba(0,0,0,0.07)', padding: '14px 16px' },
  cardOverdue: { boxShadow: '0 1px 6px rgba(0,0,0,0.07), inset 3px 0 0 #ef4444' },
  cardSoon: { boxShadow: '0 1px 6px rgba(0,0,0,0.07), inset 3px 0 0 #f59e0b' },
  cardLeft: { flex: 1, minWidth: 0 },
  itemName: { fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 4, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  unitTag: { background: '#f3f4f6', padding: '1px 7px', borderRadius: 8, fontWeight: 600, fontSize: 12, color: '#6b7280' },
  itemMeta: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: '#6b7280' },
  overdue: { color: '#ef4444', fontWeight: 700 },
  soon: { color: '#b45309', fontWeight: 700 },
  empty: { textAlign: 'center', padding: '60px 20px' },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyTitle: { margin: '0 0 6px', fontSize: 18, fontWeight: 800, color: '#111827' },
  emptyText: { color: '#6b7280', fontSize: 15 },
};
