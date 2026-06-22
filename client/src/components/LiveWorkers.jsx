import React, { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import api from '../api';
import { SkeletonList } from './Skeleton';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { formatInTz, langToLocale } from '../utils';
import ModalShell from './ModalShell';
import EmptyState from './EmptyState';

import { silentError } from '../errorReporter';
// SVG divIcon — avoids all CDN/bundler PNG loading issues
function makePinIcon(color) {
  return L.divIcon({
    className: '',
    html: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="36" viewBox="0 0 24 36">
      <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 24 12 24s12-15 12-24C24 5.4 18.6 0 12 0z" fill="${color}" stroke="#fff" stroke-width="1.5"/>
      <circle cx="12" cy="12" r="5" fill="#fff" opacity="0.9"/>
    </svg>`,
    iconSize: [24, 36],
    iconAnchor: [12, 36],
    popupAnchor: [0, -36],
  });
}

const workerIcon = makePinIcon('var(--ops-page-accent)');

function formatElapsed(clockInTime) {
  const seconds = Math.floor((Date.now() - new Date(clockInTime)) / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function ElapsedTimer({ clockInTime }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return <span style={styles.elapsed}>{formatElapsed(clockInTime)}</span>;
}

export default function LiveWorkers({ timezone = '', showInactiveAlerts = true, projects = [], settings = null }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const workerLabel = settings?.label_worker || 'Team Member';
  const workerLabelPlural = workerLabel.endsWith('s') ? workerLabel : `${workerLabel}s`;
  const workerLabelLower = workerLabel.toLowerCase();
  const workerLabelPluralLower = workerLabelPlural.toLowerCase();
  const workLabel = settings?.label_work || 'Project';
  const workLabelLower = workLabel.toLowerCase();
  const workLabelPlural = workLabel.endsWith('s') ? workLabel : `${workLabel}s`;
  const [workers, setWorkers] = useState([]);
  const [inactiveWorkers, setInactiveWorkers] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Brief visual ping right after a refresh resolves, so a click that
  // returns the same data still has a visible "I did something" beat.
  const [justRefreshed, setJustRefreshed] = useState(false);
  const [selectedProject, setSelectedProject] = useState('');
  const [selectedWorker, setSelectedWorker] = useState('');
  const [dismissedInactive, setDismissedInactive] = useState(false);
  const intervalRef = useRef(null);

  // Admin clock-in modal state
  const [showClockInModal, setShowClockInModal] = useState(false);
  const [clockInUserId, setClockInUserId] = useState('');
  const [clockInProjectId, setClockInProjectId] = useState('');
  const [clockInNotes, setClockInNotes] = useState('');
  const [clockInSaving, setClockInSaving] = useState(false);
  const [allWorkers, setAllWorkers] = useState([]);
  const [todayShifts, setTodayShifts] = useState([]);

  const fetchActive = (opts = {}) => {
    // Distinguish three callers: the initial mount (show skeleton),
    // the polling tick (silent), and a manual click (show a "Refreshing…"
    // state on the button so the user gets feedback even when the data
    // hasn't changed). `opts` is an object so an event handler that
    // hands us a synthetic event as the first arg doesn't accidentally
    // flip these flags.
    const isInitial = opts.isInitial === true;
    const isManual = opts.isManual === true;
    if (isManual) setRefreshing(true);
    api.get('/admin/active-clocks')
      .then(r => { setWorkers(r.data); setLastUpdated(new Date()); })
      .catch(silentError('liveworkers'))
      .finally(() => {
        if (isInitial) setInitialLoading(false);
        if (isManual) {
          setRefreshing(false);
          setJustRefreshed(true);
          setTimeout(() => setJustRefreshed(false), 900);
        }
      });
  };

  const fetchTodayShifts = () => {
    const today = new Date().toLocaleDateString('en-CA');
    api.get('/shifts/admin', { params: { from: today, to: today } })
      .then(r => setTodayShifts(r.data))
      .catch(silentError('liveworkers'));
  };

  const fetchInactive = () => {
    api.get('/admin/notifications')
      .then(r => { setInactiveWorkers(r.data); setDismissedInactive(false); })
      .catch(silentError('liveworkers'));
  };

  useEffect(() => {
    fetchActive({ isInitial: true });
    fetchInactive();
    fetchTodayShifts();

    // This component is lazy-loaded + only mounted when the admin is on the
    // Live tab, so we can poll aggressively without worrying about wasting
    // requests elsewhere. Pause the interval entirely when the tab is
    // backgrounded — no point polling a screen nobody is looking at.
    const POLL_MS = 10 * 1000;
    const tick = () => { fetchActive(); fetchTodayShifts(); };

    const startPolling = () => {
      clearInterval(intervalRef.current);
      intervalRef.current = setInterval(tick, POLL_MS);
    };

    if (document.visibilityState === 'visible') startPolling();

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        tick();           // catch up immediately after returning
        startPolling();
      } else {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(intervalRef.current); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  useEffect(() => {
    api.get('/admin/workers')
      .then(r => setAllWorkers(r.data))
      .catch(silentError('liveworkers'));
  }, []);

  const [actionError, setActionError] = useState('');
  const [clockingOutId, setClockingOutId] = useState(null);
  const [editingClockInId, setEditingClockInId] = useState(null); // user_id being edited
  const [editClockInValue, setEditClockInValue] = useState('');   // datetime-local string
  const [editClockInSaving, setEditClockInSaving] = useState(false);

  // Convert a UTC ISO string to a datetime-local string (in local browser time)
  const toDatetimeLocal = iso => {
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const startEditClockIn = (w) => {
    setEditingClockInId(w.user_id);
    setEditClockInValue(toDatetimeLocal(w.clock_in_time));
  };

  const handleSaveClockIn = async (userId) => {
    setEditClockInSaving(true);
    try {
      await api.patch(`/admin/active-clock/${userId}`, { clock_in_time: new Date(editClockInValue).toISOString() });
      setEditingClockInId(null);
      setActionError('');
      fetchActive();
    } catch {
      setActionError(t.actionFailed);
    } finally {
      setEditClockInSaving(false);
    }
  };

  const handleAdminClockOut = async (userId) => {
    setClockingOutId(userId);
    try {
      await api.post(`/admin/clock-out/${userId}`, {});
      setActionError('');
      fetchActive();
    } catch {
      setActionError(t.actionFailed);
    } finally {
      setClockingOutId(null);
    }
  };

  // Day-mark workers don't clock in/out — they get a separate "Mark Day"
  // action that creates a finished pending entry. Detect and route to the
  // right endpoint based on the selected worker's day_mark_mode flag.
  const selectedClockInWorker = allWorkers.find(w => String(w.id) === String(clockInUserId));
  const isDayMarkSelected = selectedClockInWorker?.rate_type === 'daily' && !!selectedClockInWorker?.day_mark_mode;

  const handleAdminClockIn = async () => {
    if (!clockInUserId) return;
    setClockInSaving(true);
    try {
      if (isDayMarkSelected) {
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        await api.post('/admin/mark-day', {
          user_id: clockInUserId,
          local_work_date: now.toLocaleDateString('en-CA'),
          local_time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
        });
      } else {
        await api.post('/admin/clock-in', { user_id: clockInUserId, project_id: clockInProjectId || null, notes: clockInNotes || null });
      }
      setShowClockInModal(false);
      setClockInUserId(''); setClockInProjectId(''); setClockInNotes('');
      setActionError('');
      fetchActive();
    } catch (err) {
      setActionError(err?.response?.data?.error || t.actionFailed);
    } finally {
      setClockInSaving(false);
    }
  };

  // Unique projects from currently clocked-in workers
  const activeProjects = [...new Map(
    workers.filter(w => w.project_name).map(w => [w.project_name, w.project_name])
  ).values()].sort();

  const handleWorkerSelect = e => {
    const userId = e.target.value;
    setSelectedWorker(userId);
    if (userId) {
      const w = workers.find(w => String(w.user_id) === userId);
      setSelectedProject(w?.project_name || '');
    }
  };

  const handleProjectSelect = e => {
    setSelectedProject(e.target.value);
    setSelectedWorker('');
  };

  const filtered = selectedProject
    ? workers.filter(w => w.project_name === selectedProject)
    : workers;

  // Prefer current live position; fall back to clock-in location
  const livePos = w => w.current_lat && w.current_lng
    ? { lat: parseFloat(w.current_lat), lng: parseFloat(w.current_lng), isLive: true, updatedAt: w.location_updated_at }
    : w.clock_in_lat && w.clock_in_lng
      ? { lat: parseFloat(w.clock_in_lat), lng: parseFloat(w.clock_in_lng), isLive: false, updatedAt: w.clock_in_time }
      : null;

  const mapped = filtered.map(w => ({ ...w, _pos: livePos(w) })).filter(w => w._pos);
  const center = mapped.length > 0
    ? [mapped[0]._pos.lat, mapped[0]._pos.lng]
    : [39.5, -98.35];

  const locationAge = updatedAt => {
    if (!updatedAt) return null;
    const mins = Math.floor((Date.now() - new Date(updatedAt)) / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
  };

  if (initialLoading) return <SkeletonList count={3} rows={2} />;

  return (
    <div style={styles.wrap}>
      {showInactiveAlerts && inactiveWorkers.length > 0 && !dismissedInactive && (
        <div style={styles.inactiveBanner}>
          <div style={styles.inactiveBannerLeft}>
            <span style={styles.inactiveIcon}>⚠️</span>
            <div>
              <div style={styles.inactiveBannerTitle}>Inactive {workerLabelPluralLower}</div>
              <div style={styles.inactiveBannerList}>
                {inactiveWorkers.map((w, i) => (
                  <React.Fragment key={w.id}>
                    {i > 0 && <span style={styles.inactiveSep}>, </span>}
                    <span style={styles.inactiveName}>
                      {w.full_name} <span style={styles.inactiveDays}>({w.days_inactive}d)</span>
                    </span>
                  </React.Fragment>
                ))}
              </div>
            </div>
          </div>
          <button style={styles.dismissBtn} aria-label={t.dismissAlert} onClick={() => setDismissedInactive(true)}>✕</button>
        </div>
      )}
      {actionError && (
        <div style={{ padding: '8px 14px', background: '#fef2f2', color: '#b91c1c', borderRadius: 8, marginBottom: 10, fontSize: 14 }}>
          {actionError}
        </div>
      )}
      <div style={styles.header} className="live-workers-header">
        <h2 style={styles.title}>Live {workerLabelPlural}</h2>
        <div style={styles.liveIndicator} className="live-workers-actions">
          <span style={styles.liveDot} />
          <span style={styles.liveText}>{t.liveLabel}</span>
          {lastUpdated && (
            <span style={{ ...styles.updated, ...(justRefreshed ? styles.updatedFlash : null) }}>
              Updated {formatInTz(lastUpdated.toISOString(), timezone, undefined, locale)}
            </span>
          )}
          <button
            style={{ ...styles.refreshBtn, ...(refreshing ? styles.refreshBtnBusy : null) }}
            onClick={() => fetchActive({ isManual: true })}
            disabled={refreshing}
            aria-busy={refreshing}
          >
            {refreshing ? t.refreshing : t.refresh}
          </button>
          <button style={styles.clockInWorkerBtn} onClick={() => setShowClockInModal(true)}>+ Clock In {workerLabel}</button>
        </div>
      </div>

      {workers.length > 0 && (
        <div style={styles.filters} className="live-worker-filters">
          <select style={styles.filterSelect} value={selectedProject} onChange={handleProjectSelect}>
            <option value="">All {workLabelPlural} ({workers.length})</option>
            {activeProjects.map(p => (
              <option key={p} value={p}>
                {p} ({workers.filter(w => w.project_name === p).length})
              </option>
            ))}
          </select>
          <select style={styles.filterSelect} value={selectedWorker} onChange={handleWorkerSelect}>
            <option value="">Find {workerLabelLower}...</option>
            {workers.map(w => (
              <option key={w.user_id} value={w.user_id}>{w.full_name}</option>
            ))}
          </select>
        </div>
      )}

      {workers.length === 0 ? (
        <EmptyState mark="L" title={`No ${workerLabelPluralLower} currently clocked in`} body={`Active ${workerLabelPluralLower} will appear here as they start their day.`} tone="good" />
      ) : filtered.length === 0 ? (
        <EmptyState mark="L" title={`No ${workerLabelPluralLower} on this ${workLabelLower} right now`} body={`Try another ${workLabelLower} or clear the filter.`} />
      ) : (
        <>
          {(() => {
            const clockedInIds = new Set(workers.map(w => String(w.user_id)));
            const expected = todayShifts.filter(s => !clockedInIds.has(String(s.user_id)) && !s.cant_make_it);
            if (expected.length === 0) return null;
            return (
              <div style={styles.expectedSection}>
                <div style={styles.expectedTitle}>{t.msExpectedToday}</div>
                <div style={styles.expectedList}>
                  {expected.map(s => (
                    <div key={s.id} style={styles.expectedPill}>
                      <span style={styles.expectedName}>{s.worker_name}</span>
                      <span style={styles.expectedTime}>
                        {s.start_time.substring(0, 5)}–{s.end_time.substring(0, 5)}
                        {s.project_name ? ` · ${s.project_name}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
          <div style={styles.workerList}>
            {filtered.map(w => (
              <div key={w.user_id} style={styles.workerCard} className="live-worker-card">
                <div style={styles.workerTop} className="live-worker-card-top">
                  <div>
                    <div style={styles.workerName}>{w.full_name}</div>
                    <div style={styles.workerProject}>{w.project_name}</div>
                  </div>
                  <ElapsedTimer clockInTime={w.clock_in_time} />
                </div>
                {w.notes && <div style={styles.workerNotes}>{w.notes}</div>}
                <div style={styles.workerMeta}>
                  <span>{t.clockedIn} {formatInTz(w.clock_in_time, timezone, undefined, locale)}</span>
                  {w.current_lat
                    ? <span style={styles.locationTag}>📍 Live · {locationAge(w.location_updated_at)}</span>
                    : w.clock_in_lat
                      ? <span style={styles.locationTagStale}>📍 Clock-in location</span>
                      : <span style={styles.noLocation}>{t.noLocation}</span>
                  }
                  {w.clock_source === 'admin' && w.clocked_in_by_name && (
                    <span style={styles.adminBadge}>{t.lwClockedInBy} {w.clocked_in_by_name}</span>
                  )}
                </div>
                <div style={styles.cardActions} className="live-worker-card-actions">
                  {editingClockInId === w.user_id ? (
                    <>
                      <input
                        type="datetime-local"
                        style={styles.editTimeInput}
                        value={editClockInValue}
                        onChange={e => setEditClockInValue(e.target.value)}
                      />
                      <button style={{ ...styles.saveTimeBtn, ...(editClockInSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => handleSaveClockIn(w.user_id)} disabled={editClockInSaving}>
                        {editClockInSaving ? t.saving : t.save}
                      </button>
                      <button style={styles.cancelTimeBtn} onClick={() => setEditingClockInId(null)}>{t.cancel}</button>
                    </>
                  ) : (
                    <button style={styles.editTimeBtn} onClick={() => startEditClockIn(w)}>{t.lwEditClockInTime}</button>
                  )}
                  <button
                    style={{ ...styles.clockOutBtn, ...(clockingOutId === w.user_id ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                    onClick={() => handleAdminClockOut(w.user_id)}
                    disabled={clockingOutId === w.user_id}
                  >
                    {clockingOutId === w.user_id ? t.lwClockingOut : t.lwClockOut}
                  </button>
                </div>
              </div>
            ))}
          </div>

          {mapped.length > 0 && (
            <div style={styles.mapWrap}>
              <h3 style={styles.mapTitle}>{workerLabel} locations</h3>
              <MapContainer center={center} zoom={mapped.length === 1 ? 13 : 5} style={styles.map}>
                <TileLayer
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                />
                {mapped.map(w => (
                  <Marker key={w.user_id} position={[w._pos.lat, w._pos.lng]} icon={workerIcon}>
                    <Popup>
                      <strong>{w.full_name}</strong><br />
                      {w.project_name && <>{w.project_name}<br /></>}
                      {w._pos.isLive
                        ? <>📍 Live · {locationAge(w._pos.updatedAt)}<br /></>
                        : <>📍 Clock-in location<br /></>
                      }
                      In: {formatInTz(w.clock_in_time, timezone, undefined, locale)}
                    </Popup>
                  </Marker>
                ))}
              </MapContainer>
            </div>
          )}
        </>
      )}
      {showClockInModal && (
        <div style={styles.modalOverlay}>
            <ModalShell
              onClose={() => { setShowClockInModal(false); setClockInUserId(''); setClockInProjectId(''); setClockInNotes(''); }}
              titleId="lw-clockin-title"
              className="live-worker-clockin-modal"
              style={styles.modal}
            >
            <h3 id="lw-clockin-title" style={styles.modalTitle}>Clock In {workerLabel}</h3>
            <div style={styles.modalField}>
              <label style={styles.modalLabel}>{workerLabel}</label>
              <select
                style={styles.modalSelect}
                value={clockInUserId}
                onChange={e => setClockInUserId(e.target.value)}
              >
                <option value="">Select a {workerLabelLower}...</option>
                {allWorkers
                  .filter(w => !workers.some(aw => String(aw.user_id) === String(w.id)))
                  .map(w => (
                    <option key={w.id} value={w.id}>{w.full_name}</option>
                  ))}
              </select>
            </div>
            {isDayMarkSelected ? (
              <div style={{ ...styles.modalField, padding: '12px 14px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8 }}>
                <div style={{ fontSize: 13, color: '#166534', fontWeight: 600, marginBottom: 4 }}>
                  {t.lwDayMarkInfoTitle ? t.lwDayMarkInfoTitle.replace(/worker/gi, workerLabelLower) : `This ${workerLabelLower} uses Mark Day mode`}
                </div>
                <div style={{ fontSize: 12, color: '#166534' }}>
                  {t.lwDayMarkInfoBody ? t.lwDayMarkInfoBody.replace(/project/gi, workLabelLower) : `Marking will create a pending day entry — no clock-out, no ${workLabelLower} required.`}
                </div>
              </div>
            ) : (
              <>
                <div style={styles.modalField}>
                  <label style={styles.modalLabel}>{workLabel} (optional)</label>
                  <select
                    style={styles.modalSelect}
                    value={clockInProjectId}
                    onChange={e => setClockInProjectId(e.target.value)}
                  >
                    <option value="">No {workLabelLower}</option>
                    {projects.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div style={styles.modalField}>
                  <label style={styles.modalLabel}>{t.notesOptional}</label>
                  <textarea
                    style={styles.modalTextarea}
                    value={clockInNotes}
                    onChange={e => setClockInNotes(e.target.value)}
                    rows={3}
                    placeholder={t.lwAddNotePlaceholder}
                    maxLength={500}
                  />
                  <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{clockInNotes.length}/500</div>
                </div>
              </>
            )}
            <div style={styles.modalActions} className="ops-modal-actions">
              <button
                style={{ ...styles.modalClockInBtn, ...((!clockInUserId || clockInSaving) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                onClick={handleAdminClockIn}
                disabled={!clockInUserId || clockInSaving}
              >
                {clockInSaving
                  ? (isDayMarkSelected ? (t.saving || 'Saving…') : t.clockingIn)
                  : (isDayMarkSelected ? (t.lwMarkDayBtn || 'Mark Day') : t.clockIn)}
              </button>
              <button
                style={styles.modalCancelBtn}
                onClick={() => { setShowClockInModal(false); setClockInUserId(''); setClockInProjectId(''); setClockInNotes(''); }}
              >
                {t.cancel}
              </button>
            </div>
          </ModalShell>
        </div>
      )}
    </div>
  );
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 20 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  title: { fontSize: 22, fontWeight: 700 },
  liveIndicator: { display: 'flex', alignItems: 'center', gap: 8 },
  liveDot: { width: 10, height: 10, borderRadius: '50%', background: '#16a34a', animation: 'pulse 2s infinite' },
  liveText: { fontWeight: 700, color: '#16a34a', fontSize: 14 },
  updated: { fontSize: 12, color: '#6b7280', transition: 'background 0.3s, color 0.3s', borderRadius: 4, padding: '1px 4px' },
  updatedFlash: { background: '#dcfce7', color: '#166534', fontWeight: 600 },
  refreshBtn: { background: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '4px 10px', fontSize: 12, color: '#6b7280', cursor: 'pointer' },
  refreshBtnBusy: { opacity: 0.6, cursor: 'wait' },
  filters: { display: 'flex', gap: 10, flexWrap: 'wrap' },
  filterSelect: { padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, color: '#374151', background: '#fff', cursor: 'pointer', minWidth: 200 },
  empty: { background: '#fff', borderRadius: 12, padding: 32, textAlign: 'center', color: '#6b7280', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' },
  workerList: { display: 'flex', flexDirection: 'column', gap: 12 },
  workerCard: { background: '#fff', borderRadius: 12, padding: '16px 20px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)', borderLeft: '4px solid var(--ops-page-accent)' },
  workerTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  workerName: { fontWeight: 700, fontSize: 16 },
  workerProject: { fontSize: 13, color: '#6b7280', marginTop: 2 },
  elapsed: { fontSize: 22, fontWeight: 800, color: 'var(--ops-page-accent)', fontVariantNumeric: 'tabular-nums' },
  workerNotes: { fontSize: 13, color: '#555', fontStyle: 'italic', marginBottom: 6 },
  workerMeta: { display: 'flex', gap: 16, fontSize: 12, color: '#6b7280', flexWrap: 'wrap' },
  locationTag: { color: '#16a34a' },
  locationTagStale: { color: '#6b7280' },
  noLocation: { color: '#d1d5db' },
  mapWrap: { background: '#fff', borderRadius: 12, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.07)' },
  mapTitle: { fontSize: 15, fontWeight: 600, marginBottom: 12, color: '#374151' },
  map: { height: 380, width: '100%', borderRadius: 8 },
  inactiveBanner: { background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  inactiveBannerLeft: { display: 'flex', alignItems: 'flex-start', gap: 10 },
  inactiveIcon: { fontSize: 18, lineHeight: 1.4 },
  inactiveBannerTitle: { fontWeight: 700, fontSize: 14, color: '#92400e', marginBottom: 6 },
  // Flat comma-separated text — earlier rendering used pill-shaped chips
  // that read as buttons, so admins kept tapping the names expecting a
  // drilldown.
  inactiveBannerList: { fontSize: 13, color: '#78350f', lineHeight: 1.5 },
  inactiveName: { fontWeight: 600 },
  inactiveSep: { color: '#b45309' },
  inactiveDays: { color: '#b45309', fontWeight: 700 },
  dismissBtn: { background: 'none', border: 'none', color: '#6b7280', fontSize: 16, cursor: 'pointer', padding: '0 4px', lineHeight: 1 },
  clockInWorkerBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  expectedSection: { background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10, padding: '12px 16px' },
  expectedTitle: { fontSize: 13, fontWeight: 700, color: '#92400e', marginBottom: 8 },
  expectedList: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  expectedPill: { background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, padding: '5px 12px', fontSize: 12 },
  expectedName: { fontWeight: 700, color: '#78350f', marginRight: 6 },
  expectedTime: { color: '#92400e' },
  adminBadge: { fontSize: 11, color: '#92400e', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 4, padding: '2px 7px', fontWeight: 600 },
  cardActions: { marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  clockOutBtn: { padding: '5px 14px', background: '#fee2e2', color: '#b91c1c', border: '1px solid #fca5a5', borderRadius: 7, fontWeight: 600, fontSize: 12, cursor: 'pointer' },
  editTimeBtn: { padding: '5px 14px', background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', borderRadius: 7, fontWeight: 600, fontSize: 12, cursor: 'pointer' },
  editTimeInput: { padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13 },
  saveTimeBtn: { padding: '5px 12px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 12, cursor: 'pointer' },
  cancelTimeBtn: { padding: '5px 12px', background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', borderRadius: 7, fontSize: 12, cursor: 'pointer' },
  modalOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  modal: { background: '#fff', borderRadius: 12, padding: 28, minWidth: 340, maxWidth: 440, width: '100%', boxShadow: '0 8px 32px rgba(0,0,0,0.18)', display: 'flex', flexDirection: 'column', gap: 16 },
  modalTitle: { fontSize: 18, fontWeight: 700, margin: 0 },
  modalField: { display: 'flex', flexDirection: 'column', gap: 4 },
  modalLabel: { fontSize: 13, fontWeight: 600, color: '#374151' },
  modalSelect: { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 14, color: '#374151', background: '#fff' },
  modalTextarea: { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 14, color: '#374151', resize: 'vertical' },
  modalActions: { display: 'flex', gap: 10, justifyContent: 'flex-end' },
  modalClockInBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 7, padding: '8px 18px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  modalCancelBtn: { background: 'none', border: '1px solid #d1d5db', color: '#6b7280', borderRadius: 7, padding: '8px 18px', fontSize: 14, cursor: 'pointer' },
};
