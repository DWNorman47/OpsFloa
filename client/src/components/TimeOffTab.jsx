import React, { useState, useEffect } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { SkeletonList } from './Skeleton';
import { langToLocale } from '../utils';

const TYPE_LABELS_EN = { vacation: 'Vacation', sick: 'Sick', personal: 'Personal', other: 'Other' };
const TYPE_COLORS = { vacation: '#1d4ed8', sick: '#dc2626', personal: '#8b5cf6', other: '#6b7280' };
const STATUS_COLORS = { pending: '#d97706', approved: '#059669', denied: '#ef4444' };

function fmt(d, locale = 'en-US') {
  if (!d) return '';
  return new Date(d.toString().substring(0, 10) + 'T00:00:00').toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

function days(start, end) {
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  return Math.round((e - s) / 86400000) + 1;
}

export default function TimeOffTab() {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const toast = useToast();
  const TYPE_LABELS = { vacation: t.typeVacation, sick: t.typeSick, personal: t.typePersonal, other: t.typeOther };
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ type: 'vacation', start_date: '', end_date: '', note: '', hours: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [pendingCancelId, setPendingCancelId] = useState(null);
  const [cancelError, setCancelError] = useState('');
  const [balance, setBalance] = useState(null);
  const [loadError, setLoadError] = useState('');

  const load = () => {
    setLoading(true); setLoadError('');
    Promise.all([
      api.get('/time-off/mine'),
      api.get('/time-off/balance'),
    ])
      .then(([r, b]) => { setRequests(r.data); setBalance(b.data); })
      .catch(() => setLoadError(t.failedLoadTimeOff || 'Failed to load time off requests.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async e => {
    e.preventDefault();
    if (!form.start_date || !form.end_date) { setError(t.dateRangeRequired); return; }
    if (form.end_date < form.start_date) { setError(t.endDateAfterStart); return; }
    setSaving(true); setError('');
    try {
      // Partial hours only apply to a single-day sick/vacation request; drop otherwise.
      const singleDay = form.start_date === form.end_date;
      const paidType = form.type === 'sick' || form.type === 'vacation';
      const payload = { ...form, hours: (singleDay && paidType) ? form.hours : '' };
      const r = await api.post('/time-off', payload);
      setRequests(prev => [r.data, ...prev]);
      setForm({ type: 'vacation', start_date: '', end_date: '', note: '', hours: '' });
      setShowForm(false);
      toast(t.requestSubmitted, 'success');
    } catch (err) {
      setError(err.response?.data?.error || t.failedSubmitRequest);
    } finally { setSaving(false); }
  };

  const handleCancel = async (id) => {
    setPendingCancelId(null);
    setCancelError('');
    try {
      await api.delete(`/time-off/${id}`);
      setRequests(prev => prev.filter(r => r.id !== id));
    } catch (err) {
      setCancelError(err.response?.data?.error || t.couldNotCancel);
    }
  };

  return (
    <div style={s.wrap}>
      {loadError && <p style={{ color: '#dc2626', fontSize: 13, marginBottom: 12 }}>{loadError}</p>}
      <div style={s.headerRow}>
        <h2 style={s.title}>{t.timeOffRequests}</h2>
        <button style={s.addBtn} onClick={() => setShowForm(o => !o)}>
          {showForm ? t.cancel : t.newRequest}
        </button>
      </div>
      {balance && balance.annual_days > 0 && (
        <div style={s.balanceBar}>
          <span style={s.balanceLabel}>{t.ptoBalance}:</span>
          <span style={s.balanceUsed}>{balance.used_days} {t.ptoUsed}</span>
          <span style={s.balanceSep}>·</span>
          <span style={s.balanceRemaining}>{balance.remaining_days} {t.ptoRemaining}</span>
          <span style={s.balanceSep}>{t.ptoOf} {balance.annual_days} {t.days}</span>
          <div style={s.balanceBar2}>
            <div style={{ ...s.balanceFill, width: `${Math.min(100, (balance.used_days / balance.annual_days) * 100)}%` }} />
          </div>
        </div>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} style={s.form}>
          <div style={s.row}>
            <div style={s.fieldGroup}>
              <label style={s.label} htmlFor="timeoff-type">{t.typeLabel}</label>
              <select id="timeoff-type" style={s.input} value={form.type} onChange={e => set('type', e.target.value)} disabled={saving}>
                <option value="vacation">{t.typeVacation}</option>
                <option value="sick">{t.typeSick}</option>
                <option value="personal">{t.typePersonal}</option>
                <option value="other">{t.typeOther}</option>
              </select>
            </div>
            <div style={s.fieldGroup}>
              <label style={s.label} htmlFor="timeoff-start-date">{t.startDate}</label>
              <input id="timeoff-start-date" style={s.input} type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} required disabled={saving} />
            </div>
            <div style={s.fieldGroup}>
              <label style={s.label} htmlFor="timeoff-end-date">{t.endDate}</label>
              <input id="timeoff-end-date" style={s.input} type="date" value={form.end_date} min={form.start_date} onChange={e => set('end_date', e.target.value)} required disabled={saving} />
            </div>
          </div>
          {form.start_date && form.start_date === form.end_date && (form.type === 'sick' || form.type === 'vacation') && (
            <div style={s.fieldGroup}>
              <label style={s.label} htmlFor="timeoff-hours">{t.timeOffHoursLabel}</label>
              <input id="timeoff-hours" style={{ ...s.input, maxWidth: 160 }} type="number" min="0" max="24" step="0.25"
                value={form.hours} onChange={e => set('hours', e.target.value)} placeholder={t.timeOffHoursPlaceholder} disabled={saving} />
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{t.timeOffHoursHint}</div>
            </div>
          )}
          <div style={s.fieldGroup}>
            <label style={s.label} htmlFor="timeoff-note">{t.noteOptionalLabel}</label>
            <textarea id="timeoff-note" style={{ ...s.input, resize: 'vertical', minHeight: 56 }} maxLength={500} value={form.note} onChange={e => set('note', e.target.value)} placeholder={t.noteDetailsPlaceholder} disabled={saving} />
            <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{(form.note || '').length}/500</div>
          </div>
          {error && <p style={s.error}>{error}</p>}
          <button style={{ ...s.submitBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={saving}>
            {saving ? t.submitting : t.submitRequest}
          </button>
        </form>
      )}

      {loading ? (
        <SkeletonList count={3} rows={2} />
      ) : requests.length === 0 ? (
        <p style={s.empty}>{t.noTimeOffYet}</p>
      ) : (
        <div style={s.list}>
          {requests.map(r => (
            <div key={r.id} style={s.card}>
              <div style={s.cardTop}>
                <span style={{ ...s.typeBadge, background: TYPE_COLORS[r.type] + '22', color: TYPE_COLORS[r.type] }}>
                  {TYPE_LABELS[r.type] || r.type}
                </span>
                <span style={{ ...s.statusBadge, color: STATUS_COLORS[r.status] || '#6b7280' }}>
                  {({ pending: t.pending, approved: t.approved, denied: t.filterDenied }[r.status] || r.status)}
                </span>
              </div>
              <div style={s.dates}>
                {fmt(r.start_date, locale)} – {fmt(r.end_date, locale)}
                {r.hours != null
                  ? <span style={s.dayCount}>{(+r.hours)} {t.hoursShort}</span>
                  : (() => { const d = days(r.start_date?.toString().substring(0,10), r.end_date?.toString().substring(0,10)); return <span style={s.dayCount}>{d} {d !== 1 ? t.days : t.day}</span>; })()}
              </div>
              {r.note && <p style={s.note}>{r.note}</p>}
              {r.review_note && (
                <p style={{ ...s.note, color: STATUS_COLORS[r.status] || '#6b7280' }}>
                  {t.adminNotePrefix}{r.review_note}
                </p>
              )}
              <div style={s.meta}>
                {t.submitted} {fmt(r.created_at, locale)}
                {r.status === 'pending' && (
                  pendingCancelId === r.id ? (
                    <>
                      <button style={s.confirmCancelBtn} onClick={() => handleCancel(r.id)}>{t.confirm}</button>
                      <button style={s.cancelBtn} onClick={() => setPendingCancelId(null)}>{t.cancel}</button>
                    </>
                  ) : (
                    <button style={s.cancelBtn} onClick={() => setPendingCancelId(r.id)}>{t.cancel}</button>
                  )
                )}
                {cancelError && <span style={s.cancelError}>{cancelError}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const s = {
  wrap: { padding: '16px 16px 32px' },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  title: { fontSize: 18, fontWeight: 700, color: '#111827', margin: 0 },
  addBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer' },
  form: { background: '#fff', borderRadius: 12, padding: 16, boxShadow: '0 1px 6px rgba(0,0,0,0.07)', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 10 },
  row: { display: 'flex', gap: 10, flexWrap: 'wrap' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 120 },
  label: { fontSize: 12, fontWeight: 600, color: '#374151' },
  input: { padding: '9px 11px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 14, background: '#fafafa' },
  error: { color: '#ef4444', fontSize: 13, margin: 0 },
  submitBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer', alignSelf: 'flex-start' },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  card: { background: '#fff', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 6px rgba(0,0,0,0.07)' },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  typeBadge: { fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.04em' },
  statusBadge: { fontSize: 12, fontWeight: 700 },
  dates: { fontSize: 15, fontWeight: 600, color: '#111827', display: 'flex', alignItems: 'center', gap: 8 },
  dayCount: { fontSize: 12, color: '#6b7280', fontWeight: 400 },
  note: { fontSize: 13, color: '#6b7280', margin: '6px 0 0' },
  meta: { fontSize: 12, color: '#6b7280', marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  cancelBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '3px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  confirmCancelBtn: { background: '#ef4444', color: '#fff', border: 'none', padding: '3px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  cancelError: { fontSize: 11, color: '#ef4444', marginLeft: 8 },
  empty: { color: '#6b7280', fontSize: 14, textAlign: 'center', padding: '32px 0' },
  balanceBar: { display: 'flex', alignItems: 'center', gap: 8, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '8px 14px', marginBottom: 14, flexWrap: 'wrap' },
  balanceLabel: { fontSize: 13, fontWeight: 700, color: '#166534' },
  balanceUsed: { fontSize: 13, color: '#374151', fontWeight: 600 },
  balanceSep: { fontSize: 12, color: '#6b7280' },
  balanceRemaining: { fontSize: 13, color: '#059669', fontWeight: 700 },
  balanceBar2: { flex: '1 1 100%', height: 4, background: '#d1fae5', borderRadius: 4, marginTop: 4, overflow: 'hidden' },
  balanceFill: { height: '100%', background: '#059669', borderRadius: 4, transition: 'width 0.3s' },
};
