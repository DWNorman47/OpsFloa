import React, { useState, useEffect } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { SkeletonList } from './Skeleton';
import { langToLocale } from '../utils';

function fmtDate(d, t, locale = 'en-US') {
  const date = new Date(d + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  if (date.getTime() === today.getTime()) return t.wsToday;
  if (date.getTime() === tomorrow.getTime()) return t.wsTomorrow;
  return date.toLocaleDateString(locale, { weekday: 'long', month: 'short', day: 'numeric' });
}

function fmtTime(ts) {
  if (!ts) return '';
  const [h, m] = ts.split(':');
  const hour = parseInt(h);
  return `${hour % 12 || 12}:${m} ${hour < 12 ? 'AM' : 'PM'}`;
}

function isToday(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(dateStr + 'T00:00:00').getTime() === today.getTime();
}

export default function WorkerSchedule() {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flagging, setFlagging] = useState(null);
  const [pendingFlag, setPendingFlag] = useState(null); // { id, note }

  useEffect(() => {
    api.get('/shifts/mine')
      .then(r => setShifts(r.data))
      .catch(() => setError(t.couldNotLoadSchedule))
      .finally(() => setLoading(false));
  }, []);

  const confirmCantMakeIt = async () => {
    if (!pendingFlag) return;
    const { id, note } = pendingFlag;
    setFlagging(id);
    setPendingFlag(null);
    try {
      const r = await api.patch(`/shifts/${id}/cant-make-it`, { cant_make_it: true, note: note || '' });
      setShifts(prev => prev.map(s => s.id === id ? { ...s, cant_make_it: r.data.cant_make_it, cant_make_it_note: r.data.cant_make_it_note } : s));
    } catch {
      setError(t.failedSave || 'Failed to update. Please try again.');
    } finally {
      setFlagging(null);
    }
  };

  const undoCantMakeIt = async (shift) => {
    setFlagging(shift.id);
    try {
      const r = await api.patch(`/shifts/${shift.id}/cant-make-it`, { cant_make_it: false });
      setShifts(prev => prev.map(s => s.id === shift.id ? { ...s, cant_make_it: r.data.cant_make_it, cant_make_it_note: null } : s));
    } catch {
      setError(t.failedSave || 'Failed to update. Please try again.');
    } finally {
      setFlagging(null);
    }
  };

  if (loading) return <SkeletonList count={4} rows={2} />;
  if (error) return <p style={styles.empty}>{error}</p>;
  if (shifts.length === 0) return (
    <div style={styles.emptyBox}>
      <div style={styles.emptyIcon}>📅</div>
      <p style={styles.emptyText}>{t.wsNoShifts}</p>
    </div>
  );

  const byDate = {};
  shifts.forEach(s => {
    const key = s.shift_date.toString().substring(0, 10);
    if (!byDate[key]) byDate[key] = [];
    byDate[key].push(s);
  });

  return (
    <div style={styles.wrap}>
      <h2 style={styles.heading}>{t.wsYourSchedule}</h2>
      <div style={styles.list}>
        {Object.entries(byDate).map(([date, dayShifts]) => (
          <div key={date} style={styles.dayGroup}>
            <div style={styles.dateLabel}>
              <span style={{ ...styles.dateName, color: isToday(date) ? 'var(--ops-page-accent)' : '#374151' }}>
                {fmtDate(date, t, locale)}
              </span>
              {isToday(date) && <span style={styles.todayBadge}>{t.wsToday}</span>}
            </div>
            {dayShifts.map(s => (
              <div key={s.id} style={{
                ...styles.shiftCard,
                borderLeftColor: s.cant_make_it ? '#ef4444' : isToday(date) ? 'var(--ops-page-accent)' : '#e5e7eb',
                opacity: s.cant_make_it ? 0.75 : 1,
              }}>
                <div style={styles.shiftTime}>
                  {fmtTime(s.start_time)} – {fmtTime(s.end_time)}
                </div>
                {s.project_name && (
                  <div style={styles.shiftProject}>{s.project_name}</div>
                )}
                {s.notes && (
                  <div style={styles.shiftNotes}>{s.notes}</div>
                )}
                <div style={styles.shiftFooter}>
                  {s.cant_make_it && (
                    <span style={styles.cantBadge}>{t.wsCantMakeIt}</span>
                  )}
                  {s.cant_make_it ? (
                    <button
                      style={{ ...styles.undoBtn, ...(flagging === s.id ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                      onClick={() => undoCantMakeIt(s)}
                      disabled={flagging === s.id}
                    >
                      {flagging === s.id ? '…' : t.wsUndo}
                    </button>
                  ) : pendingFlag?.id === s.id ? null : (
                    <button
                      style={{ ...styles.cantBtn, ...(flagging === s.id ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                      onClick={() => setPendingFlag({ id: s.id, note: '' })}
                      disabled={flagging === s.id}
                    >
                      {flagging === s.id ? '…' : t.wsCantMakeIt}
                    </button>
                  )}
                </div>
                {pendingFlag?.id === s.id && (
                  <div style={styles.noteBox}>
                    <input
                      style={styles.noteInput}
                      placeholder={t.wsAddNote}
                      value={pendingFlag.note}
                      onChange={e => setPendingFlag(p => ({ ...p, note: e.target.value }))}
                      maxLength={200}
                      autoFocus
                    />
                    <div style={styles.charCount}>{(pendingFlag.note || '').length}/200</div>
                    <div style={styles.noteActions}>
                      <button style={styles.confirmBtn} onClick={confirmCantMakeIt}>{t.wsConfirm}</button>
                      <button style={styles.cancelNoteBtn} onClick={() => setPendingFlag(null)}>{t.cancel || 'Cancel'}</button>
                    </div>
                  </div>
                )}
                {s.cant_make_it && s.cant_make_it_note && (
                  <div style={styles.cantNote}>{s.cant_make_it_note}</div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

const styles = {
  wrap: { maxWidth: 520, margin: '0 auto' },
  heading: { fontSize: 20, fontWeight: 800, color: '#111827', margin: '0 0 16px' },
  list: { display: 'flex', flexDirection: 'column', gap: 16 },
  dayGroup: {},
  dateLabel: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  dateName: { fontSize: 14, fontWeight: 700 },
  todayBadge: { fontSize: 11, fontWeight: 700, background: '#dbeafe', color: 'var(--ops-page-accent)', padding: '2px 8px', borderRadius: 10 },
  shiftCard: { background: '#fff', borderRadius: 10, padding: '14px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)', borderLeft: '4px solid #e5e7eb' },
  shiftTime: { fontSize: 18, fontWeight: 800, color: '#111827', marginBottom: 4 },
  shiftProject: { fontSize: 13, fontWeight: 600, color: 'var(--ops-page-accent)', marginBottom: 2 },
  shiftNotes: { fontSize: 12, color: '#6b7280', marginTop: 4, lineHeight: 1.4 },
  shiftFooter: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, gap: 8 },
  cantBadge: { fontSize: 11, fontWeight: 700, color: '#dc2626', background: '#fee2e2', padding: '2px 8px', borderRadius: 10 },
  cantBtn: { marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: '#dc2626', background: 'none', border: '1px solid #fca5a5', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' },
  undoBtn: { marginLeft: 'auto', fontSize: 12, fontWeight: 600, color: '#6b7280', background: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '4px 10px', cursor: 'pointer' },
  noteBox: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 },
  noteInput: { fontSize: 12, padding: '6px 10px', border: '1px solid #fca5a5', borderRadius: 6, outline: 'none', color: '#374151' },
  charCount: { fontSize: 11, color: '#6b7280', marginTop: 2 },
  noteActions: { display: 'flex', gap: 6 },
  confirmBtn: { fontSize: 12, fontWeight: 700, background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 12px', cursor: 'pointer' },
  cancelNoteBtn: { fontSize: 12, fontWeight: 600, background: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', color: '#6b7280' },
  cantNote: { fontSize: 11, color: '#dc2626', fontStyle: 'italic', marginTop: 4 },
  emptyBox: { textAlign: 'center', padding: '48px 20px' },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyText: { color: '#6b7280', fontSize: 15 },
  empty: { color: '#6b7280', fontSize: 14 },
};
