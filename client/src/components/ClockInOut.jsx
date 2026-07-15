import React, { useState, useEffect, useRef } from 'react';
import api from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useOffline } from '../contexts/OfflineContext';
import { useFormPersist } from '../hooks/useFormPersist';

import { silentError } from '../errorReporter';
function getLocation(options = {}) {
  const {
    timeout = 2500,
    maximumAge = 60000,
    enableHighAccuracy = false,
  } = options;
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve({ lat: null, lng: null });
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      err => resolve({ lat: null, lng: null, permissionDenied: err.code === 1 }),
      { timeout, maximumAge, enableHighAccuracy }
    );
  });
}

function formatElapsed(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const HINT_DISMISSED_KEY = 'opsfloa_clockin_hint_dismissed';

function readProjectHistory(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}') || {};
  } catch {
    return {};
  }
}

function rememberProjectChoice(key, projectId) {
  if (!projectId) return;
  try {
    const id = String(projectId);
    const history = readProjectHistory(key);
    const current = history[id] || {};
    history[id] = {
      count: (parseInt(current.count, 10) || 0) + 1,
      lastUsed: Date.now(),
    };
    localStorage.setItem(key, JSON.stringify(history));
    localStorage.setItem('lastProjectId', id);
  } catch {
    // Browser storage can be unavailable in private/restricted modes.
  }
}

function ProjectWheelPicker({
  label,
  placeholder,
  value,
  options,
  onChange,
  getMeta,
  tone = 'light',
}) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef(null);
  const selected = options.find(p => String(p.id) === String(value));
  const isDark = tone === 'dark';

  useEffect(() => {
    const handler = e => {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={pickerRef} className={`project-wheel-picker ${isDark ? 'project-wheel-picker-dark' : ''}`}>
      {label && <label style={isDark ? styles.labelDark : styles.label}>{label}</label>}
      <button
        type="button"
        className={`project-wheel-trigger ${isDark ? 'project-wheel-trigger-dark' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="project-wheel-trigger-text">{selected?.name || placeholder}</span>
        <span className="project-wheel-chevron" aria-hidden="true">▼</span>
      </button>
      {open && (
        <div className={`project-wheel-menu ${isDark ? 'project-wheel-menu-dark' : ''}`}>
          <div className="project-wheel-list" role="listbox">
            {options.length === 0 ? (
              <div className="project-wheel-empty">{placeholder}</div>
            ) : options.map(p => {
              const selectedOption = String(p.id) === String(value);
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`project-wheel-option ${selectedOption ? 'project-wheel-option-selected' : ''}`}
                  onClick={() => {
                    onChange(p.id);
                    setOpen(false);
                  }}
                  role="option"
                  aria-selected={selectedOption}
                >
                  <span className="project-wheel-option-main">{p.name}</span>
                  {getMeta && <span className="project-wheel-option-meta">{getMeta(p)}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ClockInOut({ projects, onEntryAdded, onClockedIn, t, geolocationEnabled = true, projectsEnabled = true }) {
  // Detect day-mark workers up front — the actual switch to the DayMark
  // UI happens at the return statement (after all hook calls) so React's
  // hook-order rule isn't violated when the same component renders the
  // hourly/clock-in flow for everyone else.
  const { user } = useAuth();
  const isDayMark = user?.rate_type === 'daily' && user?.day_mark_mode;
  // One-time hint shown until the user either dismisses it or clocks in once.
  // We show it based on whether they've ever dismissed or clocked in — the
  // server will return status=clocked-in-before on load if they have past
  // entries, so we can trust the 'status === null && no past successful use'
  // heuristic via the dismissed flag alone.
  const [hintDismissed, setHintDismissed] = useState(() => {
    try { return !!localStorage.getItem(HINT_DISMISSED_KEY); } catch { return false; }
  });
  const dismissHint = () => {
    try { localStorage.setItem(HINT_DISMISSED_KEY, '1'); } catch { /* quota */ }
    setHintDismissed(true);
  };
  const { isOffline, queueCount, onSync, sendToSW } = useOffline() || {};
  const [status, setStatus] = useState(null); // null = loading, false = not clocked in, object = clocked in
  const [clockInForm, setClockInForm] = useState({ selectedProject: '', notes: '' });
  const { clearPersisted: clearClockInPersisted } = useFormPersist('clock-in', clockInForm, setClockInForm);
  const selectedProject = clockInForm.selectedProject;
  const notes = clockInForm.notes;
  const setSelectedProject = v => setClockInForm(f => ({ ...f, selectedProject: v }));
  const setNotes = v => setClockInForm(f => ({ ...f, notes: v }));
  const [elapsed, setElapsed] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [breakAdded, setBreakAdded] = useState(false);
  const [mileageAdded, setMileageAdded] = useState(false);
  const [breakMinutes, setBreakMinutes] = useState('');
  const [mileage, setMileage] = useState('');
  const [locationDenied, setLocationDenied] = useState(false);
  const [switchingProject, setSwitchingProject] = useState(false);
  const [switchProject, setSwitchProject] = useState('');
  const [pendingChecklist, setPendingChecklist] = useState(null); // { template_id, items, name }
  const [checklistAnswers, setChecklistAnswers] = useState({});
  const [checklistSubmitting, setChecklistSubmitting] = useState(false);
  const [confirmingCancelClock, setConfirmingCancelClock] = useState(false);
  const [clockOutSummary, setClockOutSummary] = useState(null); // { seconds, projectName }
  const timerRef = useRef(null);

  useEffect(() => {
    const refreshStatus = () => api.get('/clock/status').then(r => setStatus(r.data || false)).catch(() => setStatus(false));
    refreshStatus();
    // Re-check whenever the PWA becomes visible again — covers the case
    // where the worker pocketed the phone after clocking out, the request
    // failed/queued in the background, and they come back later expecting
    // to be clocked out.
    const onVisible = () => { if (document.visibilityState === 'visible') refreshStatus(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Pre-select last used work when active work loads and nothing is already chosen.
  // Also scrub any stale selection restored by useFormPersist — if the persisted
  // project id isn't in the current list (project was archived, renumbered, or the
  // user now belongs to a different company), clear it so we don't submit a
  // ghost project_id that the server rejects with "Project not found".
  useEffect(() => {
    if (!projects || projects.length === 0) return;
    if (clockInForm.selectedProject) {
      const stillValid = projects.some(p => String(p.id) === String(clockInForm.selectedProject));
      if (!stillValid) setSelectedProject('');
      return;
    }
    const last = localStorage.getItem('lastProjectId');
    if (last && projects.find(p => String(p.id) === last)) {
      setSelectedProject(last);
    }
  }, [projects]);

  // Refresh clock status after the offline queue runs — whether anything
  // synced, failed auth, or was dropped as bad. Without this, an offline
  // clock-out that the SW silently dropped (auth-failed or 4xx during
  // replay) leaves the server with a stale active_clock row, and the
  // worker comes back to find themselves "still clocked in".
  useEffect(() => {
    if (!onSync) return;
    return onSync(() => {
      api.get('/clock/status').then(r => setStatus(r.data || false)).catch(silentError('clockinout'));
    });
  }, [onSync]);

  useEffect(() => {
    if (status && status.clock_in_time) {
      const updateElapsed = () => {
        const diff = Math.floor((Date.now() - new Date(status.clock_in_time)) / 1000);
        setElapsed(diff);
      };
      updateElapsed();
      timerRef.current = setInterval(updateElapsed, 1000);
    } else {
      clearInterval(timerRef.current);
      setElapsed(0);
    }
    return () => clearInterval(timerRef.current);
  }, [status]);

  // Push live location while clocked in
  useEffect(() => {
    if (!status || !status.clock_in_time || !geolocationEnabled || !navigator.geolocation) return;

    const pushLocation = (pos) => {
      api.post('/clock/location', { lat: pos.coords.latitude, lng: pos.coords.longitude }).catch(silentError('clockinout'));
    };

    // watchPosition runs continuously while screen is on; fires on movement too
    const watchId = navigator.geolocation.watchPosition(pushLocation, () => {}, {
      enableHighAccuracy: false,
      maximumAge: 30000,
      timeout: 10000,
    });

    // Also push immediately when the worker opens their phone / switches back to the app
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        navigator.geolocation.getCurrentPosition(pushLocation, () => {}, { timeout: 2500, maximumAge: 60000, enableHighAccuracy: false });
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      navigator.geolocation.clearWatch(watchId);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [!!status?.clock_in_time, geolocationEnabled]);

  // Auto-dismiss clock-out summary after 5s
  useEffect(() => {
    if (!clockOutSummary) return;
    const id = setTimeout(() => setClockOutSummary(null), 5000);
    return () => clearTimeout(id);
  }, [clockOutSummary]);

  const toLocalTime = d => {
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const projectHistoryKey = `opsfloa_project_history_${user?.company_id || 'company'}_${user?.id || 'user'}`;
  const projectHistory = readProjectHistory(projectHistoryKey);
  let lastProjectId = '';
  try { lastProjectId = localStorage.getItem('lastProjectId') || ''; } catch {}
  const orderedProjects = [...(projects || [])].sort((a, b) => {
    const ah = projectHistory[String(a.id)] || {};
    const bh = projectHistory[String(b.id)] || {};
    const aLast = parseInt(ah.lastUsed, 10) || 0;
    const bLast = parseInt(bh.lastUsed, 10) || 0;
    if (!aLast && !bLast && lastProjectId) {
      if (String(a.id) === lastProjectId) return -1;
      if (String(b.id) === lastProjectId) return 1;
    }
    if (aLast !== bLast) return bLast - aLast;
    const aCount = parseInt(ah.count, 10) || 0;
    const bCount = parseInt(bh.count, 10) || 0;
    if (aCount !== bCount) return bCount - aCount;
    return 0;
  });
  const selectedProjectData = orderedProjects.find(p => String(p.id) === String(selectedProject));
  const projectHasGeofence = !!(selectedProjectData?.geo_lat && selectedProjectData?.geo_lng && selectedProjectData?.geo_radius_ft);
  const switchProjects = orderedProjects.filter(p => String(p.id) !== String(status?.project_id));
  const projectMeta = p => p.wage_type === 'prevailing' ? t.prevailing : t.regular;

  const handleClockIn = async () => {
  // When work selection is on but the company has zero active work,
    // fall back to project-less clock-in instead of blocking the worker.
    if (projectsEnabled && hasProjects && !selectedProject) { setError(`${t.cioSelect} project ${t.cioFirst}`); return; }
    setError('');
    setLocationDenied(false);
    setLoading(true);
    // Capture clock-in time immediately before GPS wait — GPS can take several seconds
    const clock_in_time = new Date().toISOString();
    // Always fetch GPS when the selected project has a geofence, even if geolocation feature is off globally
    const loc = (geolocationEnabled || projectHasGeofence)
      ? await getLocation({
          timeout: projectHasGeofence ? 8000 : 2500,
          maximumAge: projectHasGeofence ? 0 : 60000,
          enableHighAccuracy: projectHasGeofence,
        })
      : { lat: null, lng: null };
    if (loc.permissionDenied) setLocationDenied(true);
    const { lat, lng } = loc;
    const local_work_date = new Date().toLocaleDateString('en-CA');
    try {
      const r = await api.post('/clock/in', { project_id: selectedProject, notes: notes || undefined, lat, lng, local_work_date, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, location_denied: loc.permissionDenied || false, clock_in_time });
      if (r.data?.offline) {
        // Queued offline — show a pending state
        const offlineStatus = { offline_queued: true, project_name: orderedProjects.find(p => p.id == selectedProject)?.name };
        setStatus(offlineStatus);
        rememberProjectChoice(projectHistoryKey, selectedProject);
        setNotes('');
        clearClockInPersisted();
      } else {
        setStatus(r.data);
        rememberProjectChoice(projectHistoryKey, selectedProject);
        // Auto-dismiss the first-clock-in hint — they've figured it out.
        try { localStorage.setItem(HINT_DISMISSED_KEY, '1'); } catch {}
        onClockedIn?.(r.data);
        setNotes('');
        clearClockInPersisted();
      }
    } catch (err) {
      const data = err.response?.data;
      if (data?.checklist_required) {
        // Fetch template so we can show inline checklist
        api.get(`/safety-checklists/templates`).then(r => {
          const tmpl = r.data.find(t => t.id === data.template_id);
          if (tmpl) setPendingChecklist(tmpl);
          else setError(t.checklistRequiredFieldApp);
        }).catch(() => setError(t.checklistRequiredField));
      } else {
        setError(data?.geofence ? data.error : (data?.error || t.clockInFailed));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleChecklistSubmit = async () => {
    setChecklistSubmitting(true);
    try {
      await api.post('/safety-checklists/submissions', {
        template_id: pendingChecklist.id,
        template_name: pendingChecklist.name,
        project_id: selectedProject || null,
        answers: checklistAnswers,
        check_date: new Date().toLocaleDateString('en-CA'),
      });
      setPendingChecklist(null);
      setChecklistAnswers({});
      // Retry clock-in now that checklist is complete
      handleClockIn();
    } catch (err) {
      setError(err.response?.data?.error || t.failedSubmitChecklist);
    } finally {
      setChecklistSubmitting(false);
    }
  };

  const handleCancelClockIn = async () => {
    setConfirmingCancelClock(false);
    setLoading(true);
    try {
      await api.delete('/clock/cancel');
      setStatus(false);
      setSelectedProject('');
      clearClockInPersisted();
      setBreakAdded(false);
      setMileageAdded(false);
      setBreakMinutes('');
      setMileage('');
    } catch (err) {
      setError(err.response?.data?.error || t.failedCancel);
    } finally {
      setLoading(false);
    }
  };

  const handleClockOut = async () => {
    setError('');
    setLoading(true);
    const clockOutInstant = new Date();
    const { lat, lng } = geolocationEnabled ? await getLocation() : { lat: null, lng: null };
    const local_clock_in = status.clock_in_time ? toLocalTime(new Date(status.clock_in_time)) : toLocalTime(new Date());
    const local_clock_out = toLocalTime(clockOutInstant);
    try {
      const r = await api.post('/clock/out', {
        lat, lng,
        break_minutes: breakMinutes ? parseInt(breakMinutes) : 0,
        mileage: mileage ? parseFloat(mileage) : null,
        local_clock_in,
        local_clock_out,
      });
      if (r.data?.offline) {
        // Queued offline — stay "clocked in" locally until sync
        setStatus(prev => ({ ...prev, clock_out_queued: true }));
      } else {
        const summarySeconds = elapsed;
        const summaryProject = status.project_name;
        onEntryAdded({ ...r.data, project_name: status.project_name });
        setStatus(false);
        setSelectedProject('');
        setBreakAdded(false);
        setMileageAdded(false);
        setBreakMinutes('');
        setMileage('');
        setClockOutSummary({ seconds: summarySeconds, projectName: summaryProject });
      }
    } catch (err) {
      setError(err.response?.data?.error || t.clockOutFailed);
    } finally {
      setLoading(false);
    }
  };

  const handleSwitchProject = async () => {
    if (!switchProject) { setError(`${t.cioSelectNew} project.`); return; }
    setError('');
    setLoading(true);
    const switchInstant = new Date();
    const nextProject = orderedProjects.find(p => String(p.id) === String(switchProject));
    const nextProjectHasGeofence = !!(nextProject?.geo_lat && nextProject?.geo_lng && nextProject?.geo_radius_ft);
    const { lat, lng } = (geolocationEnabled || nextProjectHasGeofence)
      ? await getLocation({
          timeout: nextProjectHasGeofence ? 8000 : 2500,
          maximumAge: nextProjectHasGeofence ? 0 : 60000,
          enableHighAccuracy: nextProjectHasGeofence,
        })
      : { lat: null, lng: null };
    const local_clock_in = status.clock_in_time ? toLocalTime(new Date(status.clock_in_time)) : toLocalTime(switchInstant);
    const local_clock_out = toLocalTime(switchInstant);
    try {
      const local_work_date = new Date().toLocaleDateString('en-CA');
      const switch_clock_in_time = switchInstant.toISOString();
      const r = await api.post('/clock/switch', {
        project_id: switchProject,
        lat, lng,
        break_minutes: breakMinutes ? parseInt(breakMinutes) : 0,
        mileage: mileage ? parseFloat(mileage) : null,
        local_clock_in,
        local_clock_out,
        local_work_date,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        clock_in_time: switch_clock_in_time,
      });
      if (r.data?.offline) {
        setStatus(prev => ({
          ...prev,
          project_id: switchProject,
          project_name: nextProject?.name || prev?.project_name,
          wage_type: nextProject?.wage_type || prev?.wage_type,
          clock_in_time: switch_clock_in_time,
          clock_out_queued: true,
        }));
      } else {
        if (r.data?.closed_entry) onEntryAdded(r.data.closed_entry);
        setStatus(r.data);
      }
      rememberProjectChoice(projectHistoryKey, switchProject);
      setSwitchingProject(false);
      setSwitchProject('');
      setBreakAdded(false);
      setMileageAdded(false);
      setBreakMinutes('');
      setMileage('');
    } catch (err) {
      setError(err.response?.data?.error || t.failedSwitchProject);
    } finally {
      setLoading(false);
    }
  };

  const offlineBanner = (isOffline || queueCount > 0) && (
    <div style={styles.offlineBanner}>
      <span>
        {isOffline
          ? t.offlineWarning
          : `${queueCount} ${queueCount !== 1 ? t.syncPendingPunches : t.syncPendingPunch}`}
        {queueCount > 0 && isOffline ? ` · ${queueCount} ${queueCount !== 1 ? t.syncQueuedPunches : t.syncQueuedPunch}` : null}
      </span>
      {!isOffline && queueCount > 0 && (
        <span style={{ display: 'flex', gap: 8, marginLeft: 8 }}>
          <button style={styles.syncRetryBtn} onClick={() => sendToSW?.({ type: 'REPLAY_QUEUE' })}>{t.syncRetry}</button>
          <button style={styles.syncClearBtn} onClick={() => sendToSW?.({ type: 'CLEAR_QUEUE' })}>{t.syncClear}</button>
        </span>
      )}
    </div>
  );

  if (status === null) return (
    <div style={styles.card}>
      {offlineBanner}
      <p style={{ color: '#6b7280', fontSize: 14, margin: 0 }}>{t.clockingStatus}</p>
    </div>
  );

  if (status) {
    const clockOutQueued = status.clock_out_queued;
    return (
      <div style={styles.clockedInCard}>
        {isOffline && <div style={styles.offlineBannerDark}>{t.offlineClockOutWarn}</div>}
        <div style={styles.clockedInTop}>
          <div>
            <div style={styles.clockedInLabel}>{t.currentlyClockedIn}</div>
            <div style={styles.projectName}>{status.project_name}</div>
            {status.offline_queued && <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>{t.clockInQueuedOffline}</div>}
            {clockOutQueued && <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>{t.clockOutQueuedSync}</div>}
          </div>
          {!status.offline_queued && !clockOutQueued && <div style={styles.timer}>{formatElapsed(elapsed)}</div>}
        </div>

        {!clockOutQueued && (
          <>
            {/* Added rows */}
            {breakAdded && (
              <div style={styles.addedRow}>
                <span style={styles.addedIcon}>☕</span>
                <span style={styles.addedLabel}>{t.breakLabel}</span>
                <input
                  style={styles.addedInput}
                  type="number" min="0" max="480" step="1"
                  placeholder="0"
                  value={breakMinutes}
                  onChange={e => setBreakMinutes(e.target.value)}
                  autoFocus
                />
                <span style={styles.addedUnit}>{t.cioUnitMin}</span>
                <button style={styles.removeBtn} aria-label={t.removeBreak} onClick={() => { setBreakAdded(false); setBreakMinutes(''); }}>✕</button>
              </div>
            )}
            {mileageAdded && (
              <div style={styles.addedRow}>
                <span style={styles.addedIcon}>🚗</span>
                <span style={styles.addedLabel}>{t.mileageLabel}</span>
                <input
                  style={styles.addedInput}
                  type="number" min="0" step="0.1"
                  placeholder="0.0"
                  value={mileage}
                  onChange={e => setMileage(e.target.value)}
                />
                <span style={styles.addedUnit}>{t.cioUnitMi}</span>
                <button style={styles.removeBtn} aria-label={t.removeMileage} onClick={() => { setMileageAdded(false); setMileage(''); }}>✕</button>
              </div>
            )}

            {/* Add buttons */}
            {(!breakAdded || !mileageAdded) && (
              <div style={styles.addBtns}>
                {!breakAdded && <button style={styles.addBtn} onClick={() => setBreakAdded(true)}>{t.addBreak}</button>}
                {!mileageAdded && <button style={styles.addBtn} onClick={() => setMileageAdded(true)}>{t.addMileage}</button>}
              </div>
            )}

            {error && <p role="alert" style={styles.errorDark}>{error}</p>}

            {switchingProject ? (
              <div style={styles.switchBox}>
                <ProjectWheelPicker
                  label={`${t.cioSelectNew} project`}
                  placeholder={`${t.cioChoose} project`}
                  value={switchProject}
                  options={switchProjects}
                  onChange={setSwitchProject}
                  getMeta={projectMeta}
                  tone="dark"
                />
                <div style={styles.switchActions}>
                  <button style={{ ...styles.switchConfirmBtn, ...(loading || !switchProject ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={handleSwitchProject} disabled={loading || !switchProject}>
                    {loading ? t.saving : t.confirmSwitch}
                  </button>
                  <button style={styles.switchCancelBtn} onClick={() => { setSwitchingProject(false); setSwitchProject(''); setError(''); }}>
                    {t.cancel}
                  </button>
                </div>
              </div>
            ) : (
              projectsEnabled && projects?.length > 1 && (
                <button style={{ ...styles.switchProjectBtn, ...(loading ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => setSwitchingProject(true)} disabled={loading}>
                  {`${t.cioSwitch} project`}
                </button>
              )
            )}

            <button style={{ ...styles.clockOutBtn, ...(loading ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} className="clock-btn" onClick={handleClockOut} disabled={loading}>
              {loading ? t.clockingOut : t.clockOut}
            </button>
            {confirmingCancelClock ? (
              <>
                <button style={{ ...styles.confirmCancelBtn, ...(loading ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={handleCancelClockIn} disabled={loading}>{t.confirm}</button>
                <button style={styles.cancelClockInBtn} onClick={() => setConfirmingCancelClock(false)}>{t.cancel}</button>
              </>
            ) : (
              <button style={{ ...styles.cancelClockInBtn, ...(loading ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => setConfirmingCancelClock(true)} disabled={loading}>
                {t.cancelClockIn}
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  // When there are zero projects, don't block clock-in — the server falls
  // back to accepting a project-less clock-in in that case (see clock.js).
  // We just hide the project picker below and render the rest of the form.
  const hasProjects = projects && projects.length > 0;

  if (isDayMark) {
    return <DayMark t={t} onEntryAdded={onEntryAdded} />;
  }

  return (
    <div style={styles.card}>
      {offlineBanner}
      {clockOutSummary && (
        <div style={styles.clockOutSummary}>
          <div style={styles.clockOutSummaryCheck}>✓</div>
          <div style={styles.clockOutSummaryBody}>
            <div style={styles.clockOutSummaryTitle}>{t.clockOutSummaryTitle}</div>
            <div style={styles.clockOutSummaryProject}>{clockOutSummary.projectName}</div>
            <div style={styles.clockOutSummaryDuration}>{t.clockOutSummaryDuration}: <strong>{formatElapsed(clockOutSummary.seconds)}</strong></div>
          </div>
          <button style={styles.clockOutSummaryDismiss} aria-label={t.dismiss} onClick={() => setClockOutSummary(null)}>✕</button>
        </div>
      )}
      <h2 style={styles.heading}>{t.clockIn}</h2>
      {!hintDismissed && (
        <div style={styles.firstHint} role="note">
          <span style={styles.firstHintIcon}>👋</span>
          <div style={{ flex: 1 }}>
            <div style={styles.firstHintTitle}>{t.firstClockinHintTitle}</div>
            <div style={styles.firstHintBody}>{t.firstClockinHintBody}</div>
          </div>
          <button style={styles.firstHintDismiss} aria-label={t.dismiss} onClick={dismissHint}>✕</button>
        </div>
      )}
      <div style={styles.form}>
        {projectsEnabled && hasProjects && (
          <ProjectWheelPicker
            label="Project"
            placeholder={`${t.cioChoose} project`}
            value={selectedProject}
            options={orderedProjects}
            onChange={setSelectedProject}
            getMeta={projectMeta}
          />
        )}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <label htmlFor="clockin-notes" style={styles.label}>{t.notesOptional}</label>
            <span style={styles.charCount}>{notes.length}/500</span>
          </div>
          <input
            id="clockin-notes"
            style={styles.input}
            type="text"
            placeholder={t.notesPlaceholder}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            maxLength={500}
          />
        </div>
        {projectHasGeofence && (
          <div style={styles.geofenceHint}>{t.geofenceLocationHint}</div>
        )}
        {locationDenied && (
          <div style={styles.locationDenied}>
            <div style={styles.locationDeniedTitle}>{t.locationAccessBlocked}</div>
            <p style={styles.locationDeniedText}>{t.locationAccessHelp}</p>
            <ul style={styles.locationDeniedList}>
              <li><strong>{t.cioLocationHelpIphoneLabel}</strong> {t.cioLocationHelpIphone}</li>
              <li><strong>{t.cioLocationHelpAndroidLabel}</strong> {t.cioLocationHelpAndroid}</li>
              <li><strong>{t.cioLocationHelpChromeLabel}</strong> {t.cioLocationHelpChrome}</li>
              <li><strong>{t.cioLocationHelpFirefoxLabel}</strong> {t.cioLocationHelpFirefox}</li>
            </ul>
            <p style={styles.locationDeniedText}>{t.locationAfterUpdate}</p>
          </div>
        )}
        {error && <p role="alert" style={styles.error}>{error}</p>}
        {pendingChecklist && (
          <div style={styles.checklistGate}>
            <div style={styles.checklistGateTitle}>{t.checklistRequiredTitle} {pendingChecklist.name}</div>
            <div style={styles.checklistGateSub}>{t.checklistCompleteToClock}</div>
            {(pendingChecklist.items || []).map((item, i) => (
              <div key={i} style={styles.checklistGateItem}>
                {item.type === 'text' ? (
                  <>
                    <div style={styles.checklistGateLabel}>{item.label}</div>
                    <input
                      style={styles.checklistGateTextInput}
                      type="text"
                      placeholder={t.notesPlaceholder}
                      value={checklistAnswers[i] || ''}
                      onChange={e => setChecklistAnswers(a => ({ ...a, [i]: e.target.value }))}
                      maxLength={500}
                    />
                  </>
                ) : (
                  <label style={styles.checklistGateCheckRow}>
                    <input
                      type="checkbox"
                      checked={!!checklistAnswers[i]}
                      onChange={e => setChecklistAnswers(a => ({ ...a, [i]: e.target.checked }))}
                      style={{ width: 18, height: 18, flexShrink: 0 }}
                    />
                    <span style={styles.checklistGateLabel}>{item.label}</span>
                  </label>
                )}
              </div>
            ))}
            <button
              style={{ ...styles.checklistGateSubmitBtn, ...(checklistSubmitting ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
              onClick={handleChecklistSubmit}
              disabled={checklistSubmitting}
            >
              {checklistSubmitting ? t.checklistSubmitting : t.submitChecklistClockIn}
            </button>
            <button style={styles.checklistGateCancelBtn} onClick={() => { setPendingChecklist(null); setChecklistAnswers({}); }}>
              {t.cancel}
            </button>
          </div>
        )}
        {!pendingChecklist && (
          <button style={{ ...styles.clockInBtn, ...(loading ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} className="clock-btn" onClick={handleClockIn} disabled={loading}>
            {loading ? t.clockingIn : t.clockIn}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Day-mark UI (alternative to Clock In/Out for daily-rate workers in
// day_mark_mode). Single tap creates today's pending entry; once marked
// the button is replaced by a confirmation card so the worker can't
// re-mark the same day.

function DayMark({ t, onEntryAdded }) {
  const [marked, setMarked] = useState(null); // null=loading, true/false
  const [entry, setEntry] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const todayLocal = () => new Date().toLocaleDateString('en-CA');

  useEffect(() => {
    api.get('/clock/today-marked', { params: { local_work_date: todayLocal() } })
      .then(r => { setMarked(!!r.data.marked); setEntry(r.data.entry || null); })
      .catch(silentError('daymark-status'));
  }, []);

  const handleMark = async () => {
    setSaving(true); setError('');
    try {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      const r = await api.post('/clock/mark-day', {
        local_work_date: todayLocal(),
        // Send the worker's actual local time — server is UTC and would
        // otherwise record a UTC-offset time string.
        local_time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setMarked(true);
      setEntry(r.data);
      onEntryAdded?.(r.data);
    } catch (err) {
      if (err.response?.data?.code === 'already_marked') {
        setMarked(true);
        setEntry(err.response.data.entry || null);
      } else {
        setError(err.response?.data?.error || t.dayMarkFailed);
      }
    } finally {
      setSaving(false);
    }
  };

  if (marked === null) {
    return <div style={styles.card}><p style={{ color: '#6b7280', textAlign: 'center', margin: 0 }}>{t.loading}</p></div>;
  }

  if (marked) {
    return (
      <div style={{ ...styles.card, background: '#f0fdf4', border: '1px solid #86efac' }}>
        <div style={{ textAlign: 'center', padding: '12px 0' }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>✓</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#166534', marginBottom: 4 }}>
            {t.dayMarkAlreadyMarked}
          </div>
          <div style={{ fontSize: 13, color: '#166534', opacity: 0.85 }}>
            {t.dayMarkPendingApproval}
            {entry?.status && entry.status !== 'pending' && ` · ${entry.status}`}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.card}>
      <div style={{ textAlign: 'center', padding: '20px 0' }}>
        <div style={{ fontSize: 14, color: '#6b7280', marginBottom: 16 }}>
          {t.dayMarkIntro}
        </div>
        <button
          type="button"
          onClick={handleMark}
          disabled={saving}
          style={{
            padding: '16px 32px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none',
            borderRadius: 10, fontSize: 18, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer',
            opacity: saving ? 0.6 : 1, minWidth: 220,
          }}
        >
          {saving ? t.saving : t.dayMarkButton}
        </button>
        {error && <p role="alert" style={{ color: '#991b1b', fontSize: 13, marginTop: 14 }}>{error}</p>}
      </div>
    </div>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)' },
  firstHint: { display: 'flex', alignItems: 'flex-start', gap: 10, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '12px 14px', marginBottom: 16 },
  firstHintIcon: { fontSize: 20, lineHeight: 1, flexShrink: 0, marginTop: 2 },
  firstHintTitle: { fontSize: 14, fontWeight: 700, color: '#1e3a8a', marginBottom: 2 },
  firstHintBody: { fontSize: 13, color: '#1e40af', lineHeight: 1.4 },
  firstHintDismiss: { background: 'none', border: 'none', color: '#1e40af', fontSize: 16, cursor: 'pointer', padding: '0 4px', lineHeight: 1, flexShrink: 0, opacity: 0.6 },
  clockedInCard: { background: 'var(--ops-page-accent)', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.15)', color: '#fff', display: 'flex', flexDirection: 'column', gap: 10 },
  clockedInTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  clockedInLabel: { fontSize: 13, opacity: 0.8, marginBottom: 4 },
  projectName: { fontSize: 18, fontWeight: 700 },
  timer: { fontSize: 36, fontWeight: 800, fontVariantNumeric: 'tabular-nums', letterSpacing: 1 },
  addedRow: { display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,255,255,0.15)', borderRadius: 8, padding: '8px 12px' },
  addedIcon: { fontSize: 16 },
  addedLabel: { fontSize: 13, fontWeight: 600, flex: 1 },
  addedInput: { width: 70, padding: '5px 8px', border: '1px solid rgba(255,255,255,0.4)', borderRadius: 6, fontSize: 14, background: 'rgba(255,255,255,0.15)', color: '#fff', textAlign: 'right' },
  addedUnit: { fontSize: 12, opacity: 0.8, minWidth: 20 },
  removeBtn: { background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', fontSize: 14, cursor: 'pointer', padding: '0 2px', lineHeight: 1 },
  addBtns: { display: 'flex', gap: 8 },
  addBtn: { padding: '7px 14px', background: 'rgba(255,255,255,0.15)', color: '#fff', border: '1px solid rgba(255,255,255,0.35)', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  heading: { marginBottom: 16, fontSize: 18, fontWeight: 700 },
  form: { display: 'flex', flexDirection: 'column', gap: 14 },
  label: { fontSize: 13, fontWeight: 600, color: '#555', display: 'block', marginBottom: 4 },
  labelDark: { fontSize: 13, fontWeight: 800, color: 'rgba(255,255,255,0.86)', display: 'block', marginBottom: 6 },
  charCount: { fontSize: 11, color: '#6b7280' },
  input: { padding: '9px 11px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14, width: '100%' },
  projectPickerHeader: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 6 },
  projectPickerCount: { fontSize: 12, fontWeight: 800, color: '#64748b' },
  projectChoices: { display: 'grid', gap: 8 },
  projectChoice: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 12px', textAlign: 'left', border: '1px solid #dbe3ef', borderRadius: 8, background: '#fff', color: '#0f172a', fontSize: 14, fontWeight: 800, cursor: 'pointer' },
  projectChoiceSelected: { borderColor: 'var(--ops-page-accent)', background: '#eff6ff', boxShadow: '0 0 0 1px var(--ops-page-accent) inset' },
  projectChoiceMeta: { flexShrink: 0, fontSize: 11, fontWeight: 900, color: '#64748b', textTransform: 'uppercase' },
  projectChoiceMetaSelected: { color: '#1d4ed8' },
  projectPager: { display: 'flex', justifyContent: 'center', gap: 8, marginTop: 8 },
  projectPageBtn: { width: 36, height: 32, borderRadius: 8, border: '1px solid #cbd5e1', background: '#f8fafc', color: '#334155', fontSize: 16, fontWeight: 900, lineHeight: 1, cursor: 'pointer' },
  projectPageBtnDisabled: { opacity: 0.45, cursor: 'not-allowed' },
  locationDenied: { background: '#fefce8', border: '1px solid #fde047', borderRadius: 8, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 },
  locationDeniedTitle: { fontSize: 14, fontWeight: 700, color: '#854d0e' },
  locationDeniedText: { fontSize: 12, color: '#713f12', margin: 0 },
  locationDeniedList: { fontSize: 12, color: '#713f12', margin: '2px 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 },
  geofenceHint: { fontSize: 12, color: '#0369a1', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 6, padding: '7px 11px' },
  error: { color: '#ef4444', fontSize: 13, margin: 0, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px' },
  errorDark: { fontSize: 13, margin: 0, background: 'rgba(255,255,255,0.15)', borderRadius: 6, padding: '8px 12px', color: '#fff' },
  clockInBtn: { padding: '13px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 8, fontSize: 16, fontWeight: 700 },
  switchProjectBtn: { width: '100%', padding: '11px', background: 'rgba(255,255,255,0.15)', color: '#fff', border: '1px solid rgba(255,255,255,0.35)', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  switchBox: { background: 'rgba(255,255,255,0.12)', borderRadius: 8, padding: '12px', display: 'flex', flexDirection: 'column', gap: 10 },
  switchBoxHeader: { fontSize: 13, fontWeight: 800, color: 'rgba(255,255,255,0.86)' },
  switchChoices: { display: 'grid', gap: 8 },
  switchChoice: { width: '100%', padding: '10px 12px', textAlign: 'left', border: '1px solid rgba(255,255,255,0.35)', borderRadius: 8, background: 'rgba(255,255,255,0.12)', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  switchChoiceSelected: { background: '#fff', color: 'var(--ops-page-accent)', borderColor: '#fff' },
  switchEmpty: { padding: '10px 12px', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 8, color: 'rgba(255,255,255,0.78)', fontSize: 13 },
  switchPager: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 },
  switchPageBtn: { width: 34, height: 30, borderRadius: 7, border: '1px solid rgba(255,255,255,0.45)', background: 'rgba(255,255,255,0.14)', color: '#fff', fontSize: 16, fontWeight: 900, lineHeight: 1, cursor: 'pointer' },
  switchPageBtnDisabled: { opacity: 0.35, cursor: 'not-allowed' },
  switchPageText: { minWidth: 48, textAlign: 'center', color: 'rgba(255,255,255,0.86)', fontSize: 12, fontWeight: 800 },
  switchActions: { display: 'flex', gap: 8 },
  switchConfirmBtn: { flex: 1, padding: '9px', background: '#fff', color: 'var(--ops-page-accent)', border: 'none', borderRadius: 7, fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  switchCancelBtn: { padding: '9px 14px', background: 'none', border: '1px solid rgba(255,255,255,0.4)', color: 'rgba(255,255,255,0.8)', borderRadius: 7, fontSize: 13, cursor: 'pointer' },
  clockOutBtn: { width: '100%', padding: '13px', background: 'rgba(255,255,255,0.2)', color: '#fff', border: '2px solid rgba(255,255,255,0.5)', borderRadius: 8, fontSize: 16, fontWeight: 700, cursor: 'pointer' },
  cancelClockInBtn: { background: 'none', border: 'none', color: 'rgba(255,255,255,0.55)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline', padding: '2px 0', alignSelf: 'center' },
  confirmCancelBtn: { background: 'rgba(239,68,68,0.85)', color: '#fff', border: 'none', padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', alignSelf: 'center' },
  checklistGate: { background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 10, padding: '16px', display: 'flex', flexDirection: 'column', gap: 10 },
  checklistGateTitle: { fontSize: 14, fontWeight: 700, color: '#15803d' },
  checklistGateSub: { fontSize: 12, color: '#166534', marginTop: -6 },
  checklistGateItem: { display: 'flex', flexDirection: 'column', gap: 4 },
  checklistGateCheckRow: { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' },
  checklistGateLabel: { fontSize: 13, color: '#374151', fontWeight: 500 },
  checklistGateTextInput: { padding: '7px 10px', border: '1px solid #d1fae5', borderRadius: 6, fontSize: 13, width: '100%' },
  checklistGateSubmitBtn: { padding: '11px', background: '#15803d', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  checklistGateCancelBtn: { background: 'none', border: 'none', color: '#6b7280', fontSize: 12, cursor: 'pointer', textDecoration: 'underline', alignSelf: 'center' },
  noProjects: { textAlign: 'center', padding: '24px 16px' },
  noProjectsIcon: { fontSize: 36, marginBottom: 10 },
  noProjectsTitle: { fontWeight: 700, fontSize: 16, color: '#374151', marginBottom: 6 },
  noProjectsText: { fontSize: 13, color: '#6b7280', lineHeight: 1.5 },
  offlineBanner: { background: '#fef3c7', border: '1px solid #fcd34d', color: '#92400e', borderRadius: 7, padding: '8px 12px', fontSize: 13, fontWeight: 500, marginBottom: 12, display: 'flex', alignItems: 'center' },
  offlineBannerDark: { background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)', color: '#fff', borderRadius: 7, padding: '8px 12px', fontSize: 12, fontWeight: 500 },
  syncRetryBtn: { background: '#92400e', color: '#fff', border: 'none', borderRadius: 5, padding: '2px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  syncClearBtn: { background: 'none', border: 'none', color: '#92400e', fontSize: 12, cursor: 'pointer', textDecoration: 'underline', padding: 0 },
  clockOutSummary: { background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 10, padding: '14px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 },
  clockOutSummaryCheck: { fontSize: 24, color: '#16a34a', fontWeight: 700, flexShrink: 0 },
  clockOutSummaryBody: { flex: 1 },
  clockOutSummaryTitle: { fontSize: 15, fontWeight: 700, color: '#15803d' },
  clockOutSummaryProject: { fontSize: 13, color: '#374151', marginTop: 2 },
  clockOutSummaryDuration: { fontSize: 13, color: '#6b7280', marginTop: 2 },
  clockOutSummaryDismiss: { background: 'none', border: 'none', color: '#6b7280', fontSize: 18, cursor: 'pointer', padding: '0 4px', lineHeight: 1, flexShrink: 0 },
};
