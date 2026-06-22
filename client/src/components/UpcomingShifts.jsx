import React, { useState, useEffect } from 'react';
import api from '../api';
import { getOrFetch } from '../offlineDb';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { langToLocale } from '../utils';

import { silentError } from '../errorReporter';
function fmtTime(t) {
  const [h, m] = t.split(':');
  const hr = parseInt(h);
  return `${hr % 12 || 12}:${m} ${hr < 12 ? 'AM' : 'PM'}`;
}

function fmtDate(str, t, locale = 'en-US') {
  const d = new Date(str.substring(0, 10) + 'T00:00:00');
  const today = new Date(); today.setHours(0,0,0,0);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  if (d.getTime() === today.getTime()) return t.shiftToday;
  if (d.getTime() === tomorrow.getTime()) return t.shiftTomorrow;
  return d.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function UpcomingShifts({ onFillEntry }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getOrFetch('shifts', () => api.get('/shifts/mine').then(r => r.data))
      .then(data => setShifts(data))
      .catch(silentError('upcomingshifts'))
      .finally(() => setLoading(false));
  }, []);

  if (loading || shifts.length === 0) return null;

  return (
    <div style={styles.card}>
      <h2 style={styles.heading}>{t.upcomingShifts}</h2>
      <div style={styles.list}>
        {shifts.map(s => (
          <div key={s.id} style={styles.row}>
            <div style={styles.dateBadge}>
              <div style={styles.dateDay}>{new Date(s.shift_date.substring(0,10)+'T00:00:00').toLocaleDateString(locale,{weekday:'short'})}</div>
              <div style={styles.dateNum}>{new Date(s.shift_date.substring(0,10)+'T00:00:00').getDate()}</div>
            </div>
            <div style={styles.info}>
              <div style={styles.label}>{fmtDate(s.shift_date, t, locale)}</div>
              <div style={styles.times}>{fmtTime(s.start_time)} – {fmtTime(s.end_time)}</div>
              {s.project_name && <div style={styles.project}>{s.project_name}</div>}
              {s.notes && <div style={styles.notes}>{s.notes}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)' },
  heading: { fontSize: 18, fontWeight: 700, marginBottom: 14 },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  row: { display: 'flex', gap: 14, alignItems: 'flex-start', padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8 },
  dateBadge: { background: '#eff6ff', borderRadius: 8, padding: '6px 10px', textAlign: 'center', minWidth: 44, flexShrink: 0 },
  dateDay: { fontSize: 10, fontWeight: 700, color: 'var(--ops-page-accent)', textTransform: 'uppercase' },
  dateNum: { fontSize: 20, fontWeight: 800, color: 'var(--ops-page-accent)', lineHeight: 1 },
  info: { flex: 1 },
  label: { fontWeight: 700, fontSize: 14, color: '#111827' },
  times: { fontSize: 13, color: '#6b7280', marginTop: 2 },
  project: { fontSize: 12, color: '#2563eb', fontWeight: 600, marginTop: 2 },
  notes: { fontSize: 12, color: '#6b7280', fontStyle: 'italic', marginTop: 2 },
  fillBtn: { background: '#eff6ff', border: '1px solid #bfdbfe', color: 'var(--ops-page-accent)', padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', flexShrink: 0, alignSelf: 'center' },
};
