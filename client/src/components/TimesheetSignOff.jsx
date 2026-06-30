import React, { useState, useEffect } from 'react';
import api from '../api';
import { fmtHours, langToLocale } from '../utils';
import { useAuth } from '../contexts/AuthContext';

function weekBounds() {
  const today = new Date();
  const day = today.getDay(); // 0=Sun
  const mon = new Date(today); mon.setDate(today.getDate() - ((day + 6) % 7));
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const fmt = d => d.toLocaleDateString('en-CA');
  return { from: fmt(mon), to: fmt(sun) };
}

export default function TimesheetSignOff({ t, refreshKey = 0 }) {
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const [from, setFrom] = useState(weekBounds().from);
  const [to, setTo] = useState(weekBounds().to);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signed, setSigned] = useState(false);
  const [confirmSign, setConfirmSign] = useState(false);
  const [count, setCount] = useState(0);

  const load = async () => {
    setLoading(true);
    setSigned(false);
    try {
      const r = await api.get('/time-entries', { params: { from, to } });
      const pending = r.data.filter(e => e.status === 'pending');
      const alreadySigned = pending.length > 0 && pending.every(e => e.worker_signed_at);
      setEntries(pending);
      setSigned(alreadySigned);
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [refreshKey]);

  const signOff = async () => {
    setSigning(true);
    setConfirmSign(false);
    try {
      const r = await api.post('/time-entries/sign-off', { from, to });
      setCount(r.data.signed);
      setSigned(true);
      await load();
    } finally { setSigning(false); }
  };

  const unsigned = entries.filter(e => !e.worker_signed_at);
  const alreadySigned = entries.filter(e => e.worker_signed_at);

  const fmtDate = s => new Date(s.substring(0, 10) + 'T00:00:00').toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
  const fmtTime = t => { const [h, m] = t.split(':'); const hr = parseInt(h); return `${hr % 12 || 12}:${m} ${hr < 12 ? 'AM' : 'PM'}`; };
  const calcHours = (s, e, brk) => fmtHours((new Date(`1970-01-01T${e}`) - new Date(`1970-01-01T${s}`)) / 3600000 - (brk || 0) / 60);

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <h3 style={styles.title}>{t.signTimesheetTitle}</h3>
        <p style={styles.sub}>{t.signTimesheetSub}</p>
      </div>

      <div style={styles.rangeRow}>
        <div style={styles.fieldGroup}>
          <label style={styles.label}>{t.weekFrom}</label>
          <input style={styles.input} type="date" value={from} onChange={e => setFrom(e.target.value)} disabled={loading} />
        </div>
        <div style={styles.fieldGroup}>
          <label style={styles.label}>{t.to}</label>
          <input style={styles.input} type="date" value={to} onChange={e => setTo(e.target.value)} disabled={loading} />
        </div>
        <button style={{ ...styles.loadBtn, ...(loading ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={load} disabled={loading}>{loading ? t.loading : t.load}</button>
      </div>

      {!loading && entries.length === 0 && (
        <p style={styles.empty}>{t.noPendingForPeriod}</p>
      )}

      {!loading && entries.length > 0 && (
        <>
          <div style={styles.list}>
            {entries.map(e => (
              <div key={e.id} style={{ ...styles.row, opacity: e.worker_signed_at ? 0.6 : 1 }}>
                <div style={styles.rowLeft}>
                  <span style={styles.date}>{fmtDate(e.work_date.toString())}</span>
                  <span style={styles.project}>{e.project_name || '—'}</span>
                  <span style={styles.hours}>{fmtTime(e.start_time)} – {fmtTime(e.end_time)} · {calcHours(e.start_time, e.end_time, e.break_minutes)}</span>
                </div>
                <div style={styles.rowRight}>
                  {e.worker_signed_at
                    ? <span style={styles.signedBadge}>{t.signedBadge}</span>
                    : <span style={styles.pendingBadge}>{t.unsignedBadge}</span>}
                </div>
              </div>
            ))}
          </div>

          {unsigned.length > 0 ? (
            <div style={styles.signArea}>
              {confirmSign ? (
                <>
                  <span style={styles.signHint}>{`${t.signAndSubmit} ${unsigned.length} ${unsigned.length === 1 ? t.entry : t.entries}? ${t.confirmSignHint}`}</span>
                  <button style={{ ...styles.signBtn, ...(signing ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={signOff} disabled={signing}>
                    {signing ? t.signingLabel : t.confirm}
                  </button>
                  <button style={styles.cancelSignBtn} onClick={() => setConfirmSign(false)}>{t.cancel}</button>
                </>
              ) : (
                <>
                  <button style={{ ...styles.signBtn, ...(signing ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => setConfirmSign(true)} disabled={signing}>
                    {`${t.signAndSubmit} ${unsigned.length} ${unsigned.length === 1 ? t.entry : t.entries}`}
                  </button>
                  <span style={styles.signHint}>{t.confirmSignHint}</span>
                </>
              )}
            </div>
          ) : (
            <div style={styles.allSignedMsg}>
              {t.allSignedMsg}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 20 },
  header: { marginBottom: 16 },
  title: { fontSize: 16, fontWeight: 700, marginBottom: 4 },
  sub: { fontSize: 13, color: '#6b7280', margin: 0 },
  rangeRow: { display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 3 },
  label: { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' },
  input: { padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 },
  loadBtn: { padding: '7px 16px', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  empty: { color: '#6b7280', fontSize: 13 },
  list: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 12px', background: '#f9fafb', borderRadius: 7, gap: 8 },
  rowLeft: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 },
  rowRight: { flexShrink: 0 },
  date: { fontWeight: 600, color: '#374151' },
  project: { color: '#6b7280' },
  hours: { color: '#374151' },
  signedBadge: { background: '#d1fae5', color: '#065f46', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10 },
  pendingBadge: { background: '#fef3c7', color: '#92400e', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10 },
  signArea: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' },
  signBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '10px 22px', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  cancelSignBtn: { background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', padding: '10px 16px', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  signHint: { fontSize: 12, color: '#6b7280' },
  allSignedMsg: { background: '#f0fdf4', color: '#065f46', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 14px', fontSize: 14, fontWeight: 600 },
};
