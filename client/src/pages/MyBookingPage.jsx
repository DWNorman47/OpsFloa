// Worker self-service for booking config. Lets a user manage their
// role label, timezone, and weekly windows without an admin.
// `bookable` is admin-only — display the current state but no toggle.

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import api from '../api';
import { PageShell } from '../components/PageShell';
import { SkeletonList } from '../components/Skeleton';
import { silentError } from '../errorReporter';

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function MyBookingPage() {
  const { user } = useAuth();
  const [me, setMe] = useState(null);
  const [windows, setWindows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [roleLabel, setRoleLabel] = useState('');
  const [timezone, setTimezone] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/me/booking');
      setMe(data.user);
      setRoleLabel(data.user?.bookable_role_label || '');
      setTimezone(data.user?.timezone || '');
      setWindows((data.windows || []).map(w => ({
        weekday: w.weekday,
        start_time: w.start_time?.slice(0, 5) || '09:00',
        end_time:   w.end_time?.slice(0, 5)   || '17:00',
        active: w.active,
      })));
    } catch (err) { silentError(err); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function addWindow() {
    setWindows(arr => [...arr, { weekday: 1, start_time: '09:00', end_time: '17:00', active: true }]);
  }
  function updateWindow(i, k, v) {
    setWindows(arr => arr.map((w, idx) => idx === i ? { ...w, [k]: v } : w));
  }
  function removeWindow(i) {
    setWindows(arr => arr.filter((_, idx) => idx !== i));
  }

  async function save() {
    setSaving(true); setError(null); setSaved(false);
    try {
      await api.put('/me/booking', {
        bookable_role_label: roleLabel || null,
        timezone: timezone || null,
        windows: windows.map(w => ({
          weekday: parseInt(w.weekday, 10),
          start_time: w.start_time,
          end_time: w.end_time,
          active: w.active,
        })),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) { setError(err.response?.data?.error || 'Save failed'); }
    finally { setSaving(false); }
  }

  return (
    <PageShell currentApp="timeclock" maxWidth={800} headerProps={{ userRole: user?.role }}>
      <div className="admin-page-shell">
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 16px', color: '#111827' }}>My Booking Settings</h1>
        <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 20 }}>
          Set your role label, timezone, and weekly windows. Once an admin marks you as bookable,
          clients can book appointments in any of these windows.
        </p>

        {loading ? <SkeletonList rows={4} /> : me && (
          <>
            <div style={styles.card}>
              <h3 style={styles.h3}>Bookable status</h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {me.bookable ? (
                  <span style={{ fontSize: 13, fontWeight: 700, padding: '4px 10px', borderRadius: 12, background: '#d1fae5', color: '#065f46' }}>
                    Bookable
                  </span>
                ) : (
                  <span style={{ fontSize: 13, color: '#6b7280' }}>Not bookable</span>
                )}
                <span style={{ fontSize: 12, color: '#6b7280' }}>
                  {me.bookable ? '— clients can book you' : '— ask an admin to enable bookings on your account'}
                </span>
              </div>
            </div>

            {error && <div style={styles.errorBox}>{error}</div>}
            {saved && <div style={styles.successBox}>Saved ✓</div>}

            <div style={styles.card}>
              <h3 style={styles.h3}>Display</h3>
              <Field label="Role label">
                <input
                  value={roleLabel}
                  onChange={e => setRoleLabel(e.target.value)}
                  placeholder="e.g. Estimator, Project Manager"
                  style={styles.input}
                />
              </Field>
              <Field label="Timezone">
                <input
                  value={timezone}
                  onChange={e => setTimezone(e.target.value)}
                  placeholder="e.g. America/Phoenix"
                  style={styles.input}
                />
              </Field>
            </div>

            <div style={styles.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={styles.h3}>Weekly windows ({windows.length})</h3>
                <button onClick={addWindow} style={styles.ghostBtn}>+ Add window</button>
              </div>
              {windows.length === 0 ? (
                <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>
                  No windows set. Add at least one to be reachable for bookings.
                </p>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Day</th>
                      <th style={styles.th}>Start</th>
                      <th style={styles.th}>End</th>
                      <th style={styles.th}>Active</th>
                      <th style={styles.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {windows.map((w, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                        <td style={styles.td}>
                          <select
                            value={w.weekday}
                            onChange={e => updateWindow(i, 'weekday', parseInt(e.target.value, 10))}
                            style={{ ...styles.input, padding: '4px 8px' }}
                          >
                            {WEEKDAY_LABELS.map((d, idx) => <option key={idx} value={idx}>{d}</option>)}
                          </select>
                        </td>
                        <td style={styles.td}>
                          <input
                            type="time"
                            value={w.start_time}
                            onChange={e => updateWindow(i, 'start_time', e.target.value)}
                            style={{ ...styles.input, padding: '4px 8px' }}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            type="time"
                            value={w.end_time}
                            onChange={e => updateWindow(i, 'end_time', e.target.value)}
                            style={{ ...styles.input, padding: '4px 8px' }}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            type="checkbox"
                            checked={w.active}
                            onChange={e => updateWindow(i, 'active', e.target.checked)}
                          />
                        </td>
                        <td style={styles.td}>
                          <button onClick={() => removeWindow(i)} style={styles.iconBtn}>×</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={save} disabled={saving} style={styles.primaryBtn}>
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </PageShell>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#6b7280', fontWeight: 600, marginBottom: 12 }}>
      {label}
      {children}
    </label>
  );
}

const styles = {
  h3: { fontSize: 13, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 14px' },
  card: { background: '#fff', borderRadius: 8, padding: 18, marginBottom: 14, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' },
  primaryBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '9px 16px', borderRadius: 8, fontSize: 14, fontWeight: 650, cursor: 'pointer' },
  ghostBtn: { background: '#fff', color: '#374151', border: '1px solid #d1d5db', padding: '6px 12px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  iconBtn: { background: 'transparent', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 18 },
  input: { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' },
  th: { textAlign: 'left', padding: '6px 8px', fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' },
  td: { padding: '6px 8px' },
  errorBox: { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 14 },
  successBox: { background: '#d1fae5', border: '1px solid #6ee7b7', color: '#065f46', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 14 },
};
