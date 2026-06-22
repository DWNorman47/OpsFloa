import React, { useState, useEffect, useMemo } from 'react';
import api from '../api';
import { getOrFetch } from '../offlineDb';
import { SkeletonList } from './Skeleton';
import EmptyState from './EmptyState';
import MessageThread from './MessageThread';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';
import { fmtHours, langToLocale } from '../utils';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { silentError } from '../errorReporter';
// Use SVG divIcons — avoids all CDN/bundler PNG loading issues
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

const clockInIcon  = makePinIcon('#16a34a'); // green
const clockOutIcon = makePinIcon('#dc2626'); // red

// Fits the map bounds to show all markers when the map opens
function FitBounds({ positions }) {
  const map = useMap();
  useEffect(() => {
    if (positions.length === 1) {
      map.setView(positions[0], 15);
    } else if (positions.length > 1) {
      map.fitBounds(positions, { padding: [40, 40] });
    }
  }, [map, positions]);
  return null;
}

function formatDate(dateStr, locale = 'en-US') {
  const d = new Date(dateStr.substring(0, 10) + 'T00:00:00');
  return d.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatTime(t) {
  const [h, m] = t.split(':');
  const hour = parseInt(h);
  return `${hour % 12 || 12}:${m} ${hour < 12 ? 'AM' : 'PM'}`;
}

function midTime(start, end) {
  const toMins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const fromMins = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return fromMins(Math.round((toMins(start) + toMins(end)) / 2));
}

function formatHours(start, end) {
  const s = new Date(`1970-01-01T${start}`);
  const e = new Date(`1970-01-01T${end}`);
  return fmtHours((e - s) / 3600000);
}

function entryHasEnded(entry) {
  if (!entry?.end_ts) return false;
  return new Date(entry.end_ts).getTime() <= Date.now();
}

// Default OT override suggestion when the admin opens Edit on an entry that
// has no override saved yet. Uses the company's overtime rule + threshold
// applied to *this entry viewed alone*. Prevailing-wage entries never count
// toward OT, so they always suggest 0. Weekly/none rules can't be resolved
// without peer entries in the period, so they default to blank (h=0, m=0).
function suggestedOverrideFor(entry, rule, threshold) {
  if (entry.wage_type === 'prevailing') return { h: 0, m: 0 };
  if (rule !== 'daily') return { h: 0, m: 0 };
  const s = new Date(`1970-01-01T${entry.start_time}`);
  const e = new Date(`1970-01-01T${entry.end_time}`);
  let ms = e - s;
  if (ms < 0) ms += 86400000;
  const total = ms / 3600000 - (entry.break_minutes || 0) / 60;
  const ot = Math.max(0, total - (parseFloat(threshold) || 8));
  const h = Math.trunc(ot);
  const m = Math.round((ot - h) * 60);
  // Handle rounding: 59.6min → 60 should bubble to h+1 / 0m
  if (m >= 60) return { h: h + 1, m: 0 };
  return { h, m };
}

export default function ApprovalQueue({ onCountChange, settings = null }) {
  const { user } = useAuth();
  const t = useT();
  const locale = langToLocale(user?.language);
  const workerLabel = settings?.label_worker || 'Team Member';
  const workerLabelPlural = workerLabel.endsWith('s') ? workerLabel : `${workerLabel}s`;
  const workerLabelPluralLower = workerLabelPlural.toLowerCase();
  const workLabel = settings?.label_work || 'Project';
  const workLabelLower = workLabel.toLowerCase();
  const [entries, setEntries] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [rejectingId, setRejectingId] = useState(null);
  const [rejectNote, setRejectNote] = useState('');
  const [working, setWorking] = useState(null);
  const [approvingAll, setApprovingAll] = useState(false);
  const [openMessageId, setOpenMessageId] = useState(null);
  const [openMapId, setOpenMapId] = useState(null);
  const [fetchError, setFetchError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [workerFilter, setWorkerFilter] = useState('');
  // Overtime rule + threshold used to pre-fill the override input when the
  // admin opens Edit on an entry that has no override set.
  const [otRule, setOtRule] = useState('daily');
  const [otThreshold, setOtThreshold] = useState(8);
  // Edit state
  const [editingId, setEditingId] = useState(null);
  const [editDate, setEditDate] = useState('');
  const [editStart, setEditStart] = useState('');
  const [editEnd, setEditEnd] = useState('');
  const [editProject, setEditProject] = useState('');
  // OT override is stored on the server as decimal hours but entered as
  // hours + minutes so admins don't have to do mental math. Both blank = no
  // override; any non-blank = explicit override, minutes defaulting to 0.
  const [editOtHours, setEditOtHours] = useState('');
  const [editOtMinutes, setEditOtMinutes] = useState('');
  const [editUpdatedAt, setEditUpdatedAt] = useState(null);
  const [editSaving, setEditSaving] = useState(false);
  // Split state
  const [splittingId, setSplittingId] = useState(null);
  // Recent approvals
  const [recentApproved, setRecentApproved] = useState([]);
  const [showRecent, setShowRecent] = useState(false);
  const [unapproving, setUnapproving] = useState(null);
  const [splitSegments, setSplitSegments] = useState([]);
  const [splitSaving, setSplitSaving] = useState(false);
  const [splitError, setSplitError] = useState('');
  const [confirmingApproveAll, setConfirmingApproveAll] = useState(false);
  const [editSaveError, setEditSaveError] = useState('');
  const [unapproveError, setUnapproveError] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [approvingSelected, setApprovingSelected] = useState(false);

  const fetch = () => {
    setLoading(true);
    setFetchError(false);
    const params = {};
    if (dateFrom) params.from = dateFrom;
    if (dateTo) params.to = dateTo;
    Promise.all([
      api.get('/admin/entries/pending', { params }),
      getOrFetch('projects', () => api.get('/projects').then(r => r.data)),
      getOrFetch('settings', () => api.get('/settings').then(r => r.data)),
    ])
      .then(([r, p, s]) => {
        setEntries(r.data.entries);
        setHasMore(r.data.has_more);
        setProjects(p);
        if (s?.overtime_rule) setOtRule(s.overtime_rule);
        if (s?.overtime_threshold != null) setOtThreshold(parseFloat(s.overtime_threshold) || 8);
      })
      .catch(() => setFetchError(true))
      .finally(() => setLoading(false));
  };

  const loadMore = () => {
    setLoadingMore(true);
    const params = { offset: entries.length };
    if (dateFrom) params.from = dateFrom;
    if (dateTo) params.to = dateTo;
    api.get('/admin/entries/pending', { params })
      .then(r => { setEntries(prev => [...prev, ...r.data.entries]); setHasMore(r.data.has_more); })
      .catch(silentError('approvalqueue'))
      .finally(() => setLoadingMore(false));
  };

  const fetchRecentApproved = () => {
    api.get('/admin/entries/recently-approved')
      .then(r => setRecentApproved(r.data))
      .catch(silentError('approvalqueue'));
  };

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setFetchError(false);
    const params = {};
    if (dateFrom) params.from = dateFrom;
    if (dateTo) params.to = dateTo;
    Promise.all([
      api.get('/admin/entries/pending', { params }),
      getOrFetch('projects', () => api.get('/projects').then(r => r.data)),
    ])
      .then(([r, p]) => { if (!mounted) return; setEntries(r.data.entries); setHasMore(r.data.has_more); setProjects(p); })
      .catch(() => { if (mounted) setFetchError(true); })
      .finally(() => { if (mounted) setLoading(false); });
    fetchRecentApproved();
    return () => { mounted = false; };
  }, []);
  useEffect(() => { if (onCountChange) onCountChange(entries.length); }, [entries]);

  const startEdit = (e) => {
    setEditingId(e.id);
    setEditDate((e.work_date || '').toString().substring(0, 10));
    setEditStart(e.start_time.substring(0, 5));
    setEditEnd(e.end_time.substring(0, 5));
    setEditProject(e.project_id ? String(e.project_id) : '');
    if (e.overtime_hours_override != null) {
      const total = parseFloat(e.overtime_hours_override);
      const h = Math.trunc(total);
      const m = Math.round((total - h) * 60);
      setEditOtHours(String(h));
      setEditOtMinutes(m > 0 ? String(m) : '');
    } else {
      // No saved override → pre-fill with what the current OT rule would
      // produce for this entry viewed in isolation. Gives the admin a
      // sensible starting value they can accept or tweak instead of
      // starting from a blank that looks like "this entry has no OT".
      // Weekly/none rules can't be computed per-entry without peer
      // entries, so those still default to blank.
      const { h, m } = suggestedOverrideFor(e, otRule, otThreshold);
      setEditOtHours(h > 0 || m > 0 ? String(h) : '');
      setEditOtMinutes(m > 0 ? String(m) : '');
    }
    setEditUpdatedAt(e.updated_at || null);
    setSplittingId(null);
  };

  const saveEdit = async (id) => {
    setEditSaving(true);
    try {
      const updated = await api.patch(`/admin/entries/${id}/edit`, {
        work_date: editDate,
        start_time: editStart,
        end_time: editEnd,
        project_id: editProject ? parseInt(editProject) : null,
        // Both blank = clear override; anything else = override. Minutes
        // default to 0 if the admin only fills hours (and vice versa).
        // Blank vs 0h0m distinguishes "no override" from "override of 0
        // hours (never counts as OT)".
        overtime_hours_override:
          editOtHours === '' && editOtMinutes === ''
            ? null
            : (parseInt(editOtHours || '0', 10) + parseInt(editOtMinutes || '0', 10) / 60),
        updated_at: editUpdatedAt,
      });
      setEntries(prev => prev.map(e => e.id === id ? { ...e, ...updated.data } : e));
      setEditingId(null);
    } catch (err) {
      const msg = err.response?.status === 409
        ? t.concurrentModification
        : err.response?.data?.error || t.failedToSave;
      setEditSaveError(msg);
    } finally {
      setEditSaving(false);
    }
  };

  const startSplit = (e) => {
    setSplittingId(e.id);
    setEditingId(null);
    setSplitError('');
    // Pre-fill two segments covering the full time range
    const mid = midTime(e.start_time.substring(0, 5), e.end_time.substring(0, 5));
    setSplitSegments([
      { _key: 0, start_time: e.start_time.substring(0, 5), end_time: mid, project_id: e.project_id ? String(e.project_id) : '' },
      { _key: 1, start_time: mid, end_time: e.end_time.substring(0, 5), project_id: '' },
    ]);
  };

  const saveSplit = async (id) => {
    setSplitSaving(true); setSplitError('');
    try {
      const r = await api.post(`/admin/entries/${id}/split`, {
        segments: splitSegments.map(s => ({
          start_time: s.start_time,
          end_time: s.end_time,
          project_id: s.project_id ? parseInt(s.project_id) : null,
        })),
      });
      // Remove original, add new entries (with placeholder project names until reload)
      setEntries(prev => {
        const orig = prev.find(e => e.id === id);
        const newEntries = r.data.created.map(ne => ({
          ...orig, ...ne,
          project_name: projects.find(p => p.id === ne.project_id)?.name || null,
        }));
        return [...prev.filter(e => e.id !== id), ...newEntries];
      });
      setSplittingId(null);
    } catch (err) {
      setSplitError(err.response?.data?.error || t.entryPanelFailedSplit);
    } finally {
      setSplitSaving(false);
    }
  };

  const approve = async id => {
    setWorking(id);
    try {
      await api.patch(`/admin/entries/${id}/approve`);
      setEntries(prev => prev.filter(e => e.id !== id));
      fetchRecentApproved();
    } finally { setWorking(null); }
  };

  const unapprove = async id => {
    setUnapproving(id);
    try {
      await api.patch(`/admin/entries/${id}/unapprove`);
      setRecentApproved(prev => prev.filter(e => e.id !== id));
      fetch(); // refresh pending queue
    } catch (err) {
      setUnapproveError(err.response?.data?.error || t.failedUnapprove);
    } finally { setUnapproving(null); }
  };

  const submitReject = async id => {
    setWorking(id);
    try {
      await api.patch(`/admin/entries/${id}/reject`, { note: rejectNote });
      setEntries(prev => prev.filter(e => e.id !== id));
      setRejectingId(null);
      setRejectNote('');
    } finally { setWorking(null); }
  };

  const visibleEntries = useMemo(() => entries.filter(e => {
    if (workerFilter && e.worker_name !== workerFilter) return false;
    if (dateFrom && e.work_date.substring(0, 10) < dateFrom) return false;
    if (dateTo && e.work_date.substring(0, 10) > dateTo) return false;
    return true;
  }), [entries, workerFilter, dateFrom, dateTo]);

  const workerNames = useMemo(() => [...new Set(entries.map(e => e.worker_name))].sort(), [entries]);
  const approvableVisibleEntries = useMemo(() => visibleEntries.filter(entryHasEnded), [visibleEntries]);

  // Group by work_date, sorted most recent first
  const { entriesByDay, sortedDays } = useMemo(() => {
    const byDay = visibleEntries.reduce((acc, e) => {
      const day = e.work_date.substring(0, 10);
      if (!acc[day]) acc[day] = [];
      acc[day].push(e);
      return acc;
    }, {});
    return { entriesByDay: byDay, sortedDays: Object.keys(byDay).sort((a, b) => b.localeCompare(a)) };
  }, [visibleEntries]);

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelectedIds(new Set(approvableVisibleEntries.map(e => e.id)));
  const deselectAll = () => setSelectedIds(new Set());

  const approveSelected = async () => {
    const ids = [...selectedIds].filter(id => entries.some(e => e.id === id && entryHasEnded(e)));
    if (ids.length === 0) return;
    setApprovingSelected(true);
    try {
      await api.post('/admin/entries/bulk-approve', { ids });
      setEntries(prev => prev.filter(e => !selectedIds.has(e.id)));
      setSelectedIds(new Set());
      fetchRecentApproved();
    } finally { setApprovingSelected(false); }
  };

  const approveAll = async () => {
    const targets = approvableVisibleEntries;
    setConfirmingApproveAll(false);
    setApprovingAll(true);
    try {
      if (workerFilter) {
        for (const e of targets) await api.patch(`/admin/entries/${e.id}/approve`);
        setEntries(prev => prev.filter(e => e.worker_name !== workerFilter || !entryHasEnded(e)));
      } else {
        await api.post('/admin/entries/approve-all');
        setEntries(prev => prev.filter(e => !entryHasEnded(e)));
      }
    } finally { setApprovingAll(false); }
  };

  if (loading) return <div className="admin-card" style={styles.card}><SkeletonList count={4} rows={2} /></div>;

  return (
    <div className="admin-card" style={styles.card}>
      <div style={styles.header}>
        <h3 style={styles.title}>{t.approvalQueue}</h3>
        {entries.length > 0 && (
          <>
            <span style={styles.badge}>{visibleEntries.length}{workerFilter ? '' : ' ' + t.aqPending}</span>
            {workerNames.length > 1 && (
              <select
                style={styles.filterSelect}
                value={workerFilter}
                onChange={e => { setWorkerFilter(e.target.value); setSelectedIds(new Set()); }}
              >
                <option value="">{`All ${workerLabelPlural}`}</option>
                {workerNames.map(n => (
                  <option key={n} value={n}>{n} ({entries.filter(e => e.worker_name === n).length})</option>
                ))}
              </select>
            )}
            {selectedIds.size > 0 ? (
              <>
                <button
                  style={{ ...styles.approveSelectedBtn, ...(approvingSelected ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                  onClick={approveSelected}
                  disabled={approvingSelected}
                  title={approvingSelected ? t.aqApprovingSelected : undefined}
                >
                  {approvingSelected ? t.aqApprovingSelected : `${t.aqApproveSelected} (${selectedIds.size})`}
                </button>
                <button style={styles.cancelApproveAllBtn} onClick={deselectAll}>{t.cancel}</button>
              </>
            ) : confirmingApproveAll ? (
              <>
                <button style={{ ...styles.approveAllBtn, ...(approvingAll ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={approveAll} disabled={approvingAll}>
                  {approvingAll ? t.aqApprovingAll : t.confirm}
                </button>
                <button style={styles.cancelApproveAllBtn} onClick={() => setConfirmingApproveAll(false)}>{t.cancel}</button>
              </>
            ) : (
              <>
                <button style={styles.selectAllBtn} onClick={selectedIds.size > 0 ? deselectAll : selectAll}>
                  {selectedIds.size > 0 ? t.aqDeselectAll : t.aqSelectAll}
                </button>
                <button
                  style={{ ...styles.approveAllBtn, ...((approvingAll || approvableVisibleEntries.length === 0) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                  onClick={() => setConfirmingApproveAll(true)}
                  disabled={approvingAll || approvableVisibleEntries.length === 0}
                  title={approvableVisibleEntries.length === 0 ? 'No ended entries are ready to approve.' : (approvingAll ? t.aqApprovingAll : undefined)}
                >
                  {workerFilter ? `${t.approve} ${workerFilter.split(' ')[0]}'s` : t.aqApproveAll}
                </button>
              </>
            )}
          </>
        )}
      </div>

      {entries.length > 0 && (
        <div className="filter-row" style={styles.dateFilterRow}>
          <input
            type="date"
            style={styles.dateInput}
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            title={t.fromDate}
          />
          <span style={{ fontSize: 12, color: '#6b7280' }}>–</span>
          <input
            type="date"
            style={styles.dateInput}
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            title={t.toDate}
          />
          <button style={styles.applyDateBtn} onClick={() => { setSelectedIds(new Set()); fetch(); }}>{t.apply}</button>
          {(dateFrom || dateTo) && (
            <button style={styles.clearDateBtn} aria-label={t.clearDateFilters} onClick={() => { setDateFrom(''); setDateTo(''); setSelectedIds(new Set()); fetch(); }}>✕</button>
          )}
        </div>
      )}

      {fetchError ? (
        <p style={styles.fetchError}>{t.failedLoadPending} <button style={styles.retryBtn} onClick={fetch}>{t.retry}</button></p>
      ) : entries.length === 0 ? (
        <EmptyState
          mark="A"
          title={t.allCaughtUp}
          body={`No pending time entries to review for your ${workerLabelPluralLower}.`}
          tone="good"
        />
      ) : (
        <div style={styles.list}>
          {hasMore && (
            <div style={{ textAlign: 'center', padding: '12px 0 4px' }}>
              <button
                style={{ fontSize: 13, fontWeight: 600, color: 'var(--ops-page-accent)', background: 'none', border: '1px solid #bfdbfe', borderRadius: 7, padding: '7px 20px', cursor: loadingMore ? 'not-allowed' : 'pointer', opacity: loadingMore ? 0.6 : 1 }}
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? '…' : t.loadMore || 'Load More'}
              </button>
            </div>
          )}
          {visibleEntries.length === 0 && workerFilter && (
            <p style={styles.empty}>{t.aqNoPendingFor} {workerFilter}.</p>
          )}
          {visibleEntries.length === 0 && !workerFilter && (dateFrom || dateTo) && (
            <p style={styles.empty}>No entries found for this date range.</p>
          )}
          {sortedDays.map(day => (
            <div key={day}>
              <div style={styles.dayHeader}>
                {formatDate(day + 'T00:00:00', locale)}
                <span style={styles.dayCount}>{entriesByDay[day].length}</span>
              </div>
              {entriesByDay[day].map(e => {
                const canApprove = entryHasEnded(e);
                return (
                <div key={e.id} className="approval-row" style={{ ...styles.row, ...(selectedIds.has(e.id) ? styles.rowSelected : {}) }}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(e.id)}
                    onChange={() => canApprove && toggleSelect(e.id)}
                    disabled={!canApprove}
                    title={!canApprove ? 'This entry cannot be approved until its end time has passed.' : undefined}
                    style={{ ...styles.rowCheckbox, ...(!canApprove ? { opacity: 0.35, cursor: 'not-allowed' } : {}) }}
                  />
                  <div style={styles.rowMain}>
                    <div style={styles.worker}>{e.worker_name}</div>
                    <div style={styles.detail}>
                      <span style={styles.project}>{e.project_name}</span>
                      <span style={styles.sep}>·</span>
                      <span>{formatTime(e.start_time)} – {formatTime(e.end_time)} ({formatHours(e.start_time, e.end_time)})</span>
                      <span style={{ ...styles.wageTag, background: e.wage_type === 'prevailing' ? '#d97706' : '#2563eb' }}>
                        {e.wage_type === 'prevailing' ? t.prevailing : t.regular}
                      </span>
                      {e.overtime_hours_override != null && (() => {
                        const total = parseFloat(e.overtime_hours_override);
                        const h = Math.trunc(total);
                        const m = Math.round((total - h) * 60);
                        const label = m > 0 ? `OT ${h}h ${m}m` : `OT ${h}h`;
                        return (
                          <span style={{ ...styles.wageTag, background: '#7c3aed' }} title={t.aqOvertimeOverrideBadgeTitle || 'Admin set a manual overtime value for this entry'}>
                            {label}
                          </span>
                        );
                      })()}
                    </div>
                    {e.worker_signed_at && (
                      <span style={styles.signedTag}>{`${workerLabel} signed`}</span>
                    )}
                    {!canApprove && (
                      <span style={styles.waitingTag}>{t.apqCannotApprove}</span>
                    )}
                    {e.notes && <div style={styles.notes}>{e.notes}</div>}
                    {e.clock_source && e.clock_source !== 'worker' && (
                      <div style={styles.sourceBadge}>
                        {e.clock_source === 'admin'
                          ? `${t.aqClockedInByAdmin}${e.clocked_in_by_name ? ': ' + e.clocked_in_by_name : ''}`
                          : t.aqLogEntry}
                      </div>
                    )}
                    {(e.clock_in_lat || e.clock_out_lat) && (
                      <div style={styles.locationRow}>
                        <button style={styles.locationBtn} onClick={() => setOpenMapId(openMapId === e.id ? null : e.id)}>
                          📍 {openMapId === e.id ? t.aqHideMap : t.aqViewLocation}
                        </button>
                        {openMapId === e.id && (() => {
                          const positions = [
                            e.clock_in_lat  ? [parseFloat(e.clock_in_lat),  parseFloat(e.clock_in_lng)]  : null,
                            e.clock_out_lat ? [parseFloat(e.clock_out_lat), parseFloat(e.clock_out_lng)] : null,
                          ].filter(Boolean);
                          return (
                            <div style={styles.mapWrap}>
                              <MapContainer center={positions[0]} zoom={14} style={styles.map} scrollWheelZoom={false}>
                                <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' />
                                <FitBounds positions={positions} />
                                {e.clock_in_lat && <Marker position={[parseFloat(e.clock_in_lat), parseFloat(e.clock_in_lng)]} icon={clockInIcon}><Popup>🟢 {t.clockIn}<br />{e.worker_name}</Popup></Marker>}
                                {e.clock_out_lat && <Marker position={[parseFloat(e.clock_out_lat), parseFloat(e.clock_out_lng)]} icon={clockOutIcon}><Popup>🔴 {t.clockOut}<br />{e.worker_name}</Popup></Marker>}
                              </MapContainer>
                              <div style={styles.mapLegend}>
                                {e.clock_in_lat
                                  ? <span style={styles.mapLegendItem}><span style={{ color: '#16a34a' }}>●</span> {t.aqClockInLegend}</span>
                                  : <span style={styles.mapLegendMissing}>{t.aqNoClockInLoc}</span>
                                }
                                {e.clock_out_lat
                                  ? <span style={styles.mapLegendItem}><span style={{ color: '#dc2626' }}>●</span> {t.aqClockOutLegend}</span>
                                  : <span style={styles.mapLegendMissing}>{t.aqNoClockOutLoc}</span>
                                }
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                    <button style={styles.msgBtn} onClick={() => setOpenMessageId(openMessageId === e.id ? null : e.id)}>
                      {openMessageId === e.id ? `💬 ${t.hideComments}` : t.commentsOpen}
                    </button>
                    {openMessageId === e.id && <MessageThread entryId={e.id} currentUserId={user?.id} />}
                  </div>

                  {editingId === e.id ? (
                    <div style={styles.editTimesForm}>
                      <div style={styles.editTimesRow}>
                        <div>
                          <div style={styles.editTimesLabel}>{t.aqEditDateLabel || 'Date'}</div>
                          <input type="date" style={styles.editTimeInput} value={editDate} onChange={ev => setEditDate(ev.target.value)} />
                        </div>
                        <div>
                          <div style={styles.editTimesLabel}>{t.start}</div>
                          <input type="time" style={styles.editTimeInput} value={editStart} onChange={ev => setEditStart(ev.target.value)} />
                        </div>
                        <div>
                          <div style={styles.editTimesLabel}>{t.end}</div>
                          <input type="time" style={styles.editTimeInput} value={editEnd} onChange={ev => setEditEnd(ev.target.value)} />
                        </div>
                      </div>
                      <div style={{ marginTop: 8 }}>
                        <div style={styles.editTimesLabel}>{workLabel}</div>
                        <select style={styles.editProjectSelect} value={editProject} onChange={ev => setEditProject(ev.target.value)}>
                          <option value="">{`No ${workLabelLower}`}</option>
                          {(projects || []).filter(p => p.active !== false).map(p => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </select>
                      </div>
                      <div style={{ marginTop: 8 }}>
                        <div style={styles.editTimesLabel}>
                          {t.aqOvertimeOverrideLabel || 'Overtime hours (override)'}
                          <span style={{ color: '#6b7280', fontWeight: 400, marginLeft: 6 }}>
                            {t.aqOvertimeOverrideHint || '— leave blank to use the normal rule'}
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <input
                            type="number"
                            step="1"
                            min="0"
                            placeholder={t.aqOvertimeOverrideHoursPlaceholder || 'h'}
                            style={{ ...styles.editTimeInput, width: 60 }}
                            value={editOtHours}
                            onChange={ev => setEditOtHours(ev.target.value)}
                            aria-label={t.hours || 'hours'}
                          />
                          <span style={{ color: '#6b7280', fontSize: 13 }}>h</span>
                          <input
                            type="number"
                            step="1"
                            min="0"
                            max="59"
                            placeholder={t.aqOvertimeOverrideMinutesPlaceholder || 'm'}
                            style={{ ...styles.editTimeInput, width: 60 }}
                            value={editOtMinutes}
                            onChange={ev => setEditOtMinutes(ev.target.value)}
                            aria-label={t.minutes || 'minutes'}
                          />
                          <span style={{ color: '#6b7280', fontSize: 13 }}>m</span>
                        </div>
                      </div>
                      <div style={styles.editTimesActions}>
                        <button style={{ ...styles.saveTimesBtn, ...(editSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => { setEditSaveError(''); saveEdit(e.id); }} disabled={editSaving}>{editSaving ? t.saving : t.save}</button>
                        <button style={styles.cancelBtn} onClick={() => setEditingId(null)}>{t.cancel}</button>
                        {editSaveError && <span style={styles.inlineError}>{editSaveError}</span>}
                      </div>
                    </div>
                  ) : splittingId === e.id ? (
                    <div style={styles.splitForm}>
                      <div style={styles.splitTitle}>{t.aqSplitEntry}</div>
                      {splitError && <div style={styles.splitError}>{splitError}</div>}
                      {splitSegments.map((seg, i) => (
                        <div key={seg._key} style={styles.splitSegment}>
                          <div style={styles.splitSegLabel}>{t.aqSegment} {i + 1}</div>
                          <div style={styles.splitSegRow}>
                            <div>
                              <div style={styles.editTimesLabel}>{t.start}</div>
                              <input type="time" style={styles.editTimeInput} value={seg.start_time}
                                onChange={ev => setSplitSegments(prev => prev.map((s, j) => j === i ? { ...s, start_time: ev.target.value } : s))} />
                            </div>
                            <div>
                              <div style={styles.editTimesLabel}>{t.end}</div>
                              <input type="time" style={styles.editTimeInput} value={seg.end_time}
                                onChange={ev => setSplitSegments(prev => prev.map((s, j) => j === i ? { ...s, end_time: ev.target.value } : s))} />
                            </div>
                            <div style={{ flex: 1, minWidth: 120 }}>
                              <div style={styles.editTimesLabel}>{workLabel}</div>
                              <select style={styles.editProjectSelect} value={seg.project_id}
                                onChange={ev => setSplitSegments(prev => prev.map((s, j) => j === i ? { ...s, project_id: ev.target.value } : s))}>
                                <option value="">{`No ${workLabelLower}`}</option>
                                {(projects || []).filter(p => p.active !== false).map(p => (
                                  <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                              </select>
                            </div>
                            {splitSegments.length > 2 && (
                              <button style={styles.splitRemoveBtn} aria-label={t.removeSegment} onClick={() => setSplitSegments(prev => prev.filter((_, j) => j !== i))}>✕</button>
                            )}
                          </div>
                        </div>
                      ))}
                      <button style={styles.splitAddBtn} onClick={() => {
                        const last = splitSegments[splitSegments.length - 1];
                        setSplitSegments(prev => [...prev, { _key: Date.now(), start_time: last.end_time, end_time: last.end_time, project_id: '' }]);
                      }}>{t.aqAddSegment}</button>
                      <div style={styles.editTimesActions}>
                        <button style={{ ...styles.saveTimesBtn, ...(splitSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => saveSplit(e.id)} disabled={splitSaving}>{splitSaving ? t.saving : t.aqSplitSave}</button>
                        <button style={styles.cancelBtn} onClick={() => setSplittingId(null)}>{t.cancel}</button>
                      </div>
                    </div>
                  ) : rejectingId === e.id ? (
                    <div style={styles.rejectForm}>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <input style={styles.rejectInput} placeholder={t.reasonOptional} maxLength={500} value={rejectNote} onChange={ev => setRejectNote(ev.target.value)} autoFocus />
                        <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{rejectNote.length}/500</div>
                      </div>
                      <button style={{ ...styles.confirmRejectBtn, ...(working === e.id ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => submitReject(e.id)} disabled={working === e.id}>{working === e.id ? t.saving : t.confirmReject}</button>
                      <button style={styles.cancelBtn} onClick={() => { setRejectingId(null); setRejectNote(''); }}>{t.cancel}</button>
                    </div>
                  ) : (
                    <div style={styles.actions}>
                      <button style={styles.editTimesBtn} onClick={() => startEdit(e)}>✏️ Edit</button>
                      <button style={styles.splitBtn} onClick={() => startSplit(e)}>⇌ Split</button>
                      <button
                        style={{ ...styles.approveBtn, ...((working === e.id || !canApprove) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                        onClick={() => canApprove && approve(e.id)}
                        disabled={working === e.id || !canApprove}
                        title={!canApprove ? 'This entry cannot be approved until its end time has passed.' : undefined}
                      >
                        {working === e.id ? t.saving : t.approve}
                      </button>
                      <button style={styles.rejectBtn} onClick={() => { setRejectingId(e.id); setRejectNote(''); }}>{t.reject}</button>
                    </div>
                  )}
                </div>
              );})}
            </div>
          ))}
        </div>
      )}

      {recentApproved.length > 0 && (
        <div style={styles.recentSection}>
          <button style={styles.recentToggle} onClick={() => setShowRecent(v => !v)}>
            <span>{t.aqRecentlyApproved} ({recentApproved.length})</span>
            <span>{showRecent ? '▾' : '▸'}</span>
          </button>
          {showRecent && (
            <div style={styles.recentList}>
              {recentApproved.map(e => (
                <div key={e.id} style={styles.recentRow}>
                  <div style={styles.recentInfo}>
                    <span style={styles.recentWorker}>{e.worker_name}</span>
                    <span style={styles.recentDate}>{formatDate(e.work_date, locale)}</span>
                    <span style={styles.recentTime}>{formatTime(e.start_time)} – {formatTime(e.end_time)}</span>
                    {e.project_name && <span style={styles.recentProject}>{e.project_name}</span>}
                    {e.qbo_activity_id && (
                      <span style={styles.qboSyncBadge} title={`Synced to QuickBooks${e.qbo_synced_at ? ' · ' + new Date(e.qbo_synced_at).toLocaleTimeString() : ''}`}>
                        QB ✓
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                    <button
                      style={{ ...styles.unapproveBtn, ...(unapproving === e.id ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                      onClick={() => { setUnapproveError(''); unapprove(e.id); }}
                      disabled={unapproving === e.id}
                    >
                      {unapproving === e.id ? t.saving : t.aqUnapprove}
                    </button>
                    {unapproveError && unapproving === null && <span style={styles.inlineError}>{unapproveError}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 24 },
  header: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 },
  dateFilterRow: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 },
  dateInput: { padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, color: '#374151', minHeight: 'unset' },
  applyDateBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, padding: '4px 10px', cursor: 'pointer' },
  clearDateBtn: { background: 'none', border: 'none', color: '#6b7280', fontSize: 13, cursor: 'pointer', padding: '0 4px', lineHeight: 1, minHeight: 'unset' },
  title: { fontSize: 17, fontWeight: 700, margin: 0 },
  badge: { background: '#fef3c7', color: '#b45309', border: '1px solid #fcd34d', borderRadius: 20, padding: '2px 10px', fontSize: 12, fontWeight: 700 },
  filterSelect: { padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, color: '#374151', background: '#fff' },
  empty: { color: '#059669', fontSize: 14, fontWeight: 500 },
  emptyState: { textAlign: 'center', padding: '36px 0 28px' },
  emptyIcon: { fontSize: 36, color: '#059669', marginBottom: 8 },
  emptyTitle: { fontSize: 16, fontWeight: 700, color: '#059669', margin: '0 0 4px' },
  emptySubtitle: { fontSize: 13, color: '#6b7280', margin: 0 },
  fetchError: { color: '#991b1b', fontSize: 14 },
  retryBtn: { background: 'none', border: 'none', color: 'var(--ops-page-accent)', fontWeight: 700, textDecoration: 'underline', cursor: 'pointer', padding: 0, fontSize: 14 },
  list:      { display: 'flex', flexDirection: 'column', gap: 16 },
  dayHeader: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '2px 0 6px', borderBottom: '1px solid #e5e7eb', marginBottom: 8 },
  dayCount:  { background: '#f3f4f6', color: '#6b7280', borderRadius: 10, padding: '1px 7px', fontSize: 11, fontWeight: 700, textTransform: 'none', letterSpacing: 0 },
  row: { border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 16px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  rowSelected: { background: '#f0f7ff', borderColor: '#93c5fd' },
  rowCheckbox: { marginTop: 3, flexShrink: 0, cursor: 'pointer', width: 15, height: 15 },
  selectAllBtn: { padding: '4px 12px', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#374151' },
  approveSelectedBtn: { background: '#059669', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  rowMain: { flex: 1, minWidth: 200 },
  worker: { fontWeight: 700, fontSize: 15, marginBottom: 4 },
  detail: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#555', flexWrap: 'wrap' },
  project: { fontWeight: 600, color: '#374151' },
  sep: { color: '#d1d5db' },
  wageTag: { color: '#fff', padding: '1px 7px', borderRadius: 10, fontSize: 11, fontWeight: 700 },
  notes: { marginTop: 4, fontSize: 12, color: '#6b7280', fontStyle: 'italic' },
  sourceBadge: { fontSize: 11, color: '#1e40af', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 4, padding: '2px 8px', fontWeight: 600, display: 'inline-block', marginTop: 4 },
  actions: { display: 'flex', gap: 8, alignItems: 'center' },
  editTimesBtn: { padding: '6px 12px', background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  splitBtn:     { padding: '6px 12px', background: '#faf5ff', color: '#7c3aed', border: '1px solid #ddd6fe', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  editProjectSelect: { padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, width: '100%' },
  splitForm:    { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 220, maxWidth: 420 },
  splitTitle:   { fontSize: 13, fontWeight: 700, color: '#374151' },
  splitError:   { background: '#fee2e2', color: '#dc2626', borderRadius: 6, padding: '6px 10px', fontSize: 13 },
  splitSegment: { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 12px' },
  splitSegLabel:{ fontSize: 11, fontWeight: 700, color: '#6b7280', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' },
  splitSegRow:  { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' },
  splitRemoveBtn: { padding: '4px 8px', background: 'none', border: '1px solid #fca5a5', color: '#ef4444', borderRadius: 6, fontSize: 13, cursor: 'pointer', alignSelf: 'flex-end' },
  splitAddBtn:  { background: 'none', border: '1px dashed #d1d5db', color: '#6b7280', padding: '5px 12px', borderRadius: 7, fontSize: 13, cursor: 'pointer', textAlign: 'left' },
  editTimesForm: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 160 },
  editTimesRow: { display: 'flex', gap: 10 },
  editTimesLabel: { fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 3 },
  editTimeInput: { padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13 },
  editTimesActions: { display: 'flex', gap: 8 },
  saveTimesBtn: { padding: '6px 14px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  approveBtn: { background: '#059669', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  rejectBtn: { background: 'none', border: '1px solid #fca5a5', color: '#ef4444', padding: '6px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  rejectForm: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  rejectInput: { padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, minWidth: 160 },
  confirmRejectBtn: { background: '#ef4444', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  cancelBtn: { background: 'none', border: '1px solid #d1d5db', color: '#6b7280', padding: '6px 12px', borderRadius: 6, fontSize: 13, cursor: 'pointer' },
  approveAllBtn: { background: '#059669', color: '#fff', border: 'none', padding: '5px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer', marginLeft: 'auto' },
  recentSection: { marginTop: 20, borderTop: '1px solid #f0f0f0', paddingTop: 12 },
  recentToggle: { background: 'none', border: 'none', display: 'flex', justifyContent: 'space-between', width: '100%', fontSize: 13, fontWeight: 600, color: '#6b7280', cursor: 'pointer', padding: '4px 0' },
  recentList: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 },
  recentRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 10px', background: '#f9fafb', borderRadius: 7, flexWrap: 'wrap' },
  recentInfo: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 },
  recentWorker: { fontWeight: 700, color: '#374151' },
  recentDate: { color: '#6b7280' },
  recentTime: { color: '#6b7280' },
  recentProject: { background: '#e0e7ff', color: '#3730a3', borderRadius: 6, padding: '1px 7px', fontSize: 11, fontWeight: 600 },
  unapproveBtn: { padding: '5px 12px', background: '#fff', border: '1px solid #fca5a5', color: '#dc2626', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
  qboSyncBadge: { background: '#d1fae5', color: '#065f46', border: '1px solid #6ee7b7', borderRadius: 6, padding: '1px 6px', fontSize: 11, fontWeight: 700 },
  cancelApproveAllBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '5px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer' },
  inlineError: { fontSize: 12, color: '#ef4444' },
  msgBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '3px 10px', borderRadius: 5, fontSize: 11, cursor: 'pointer', marginTop: 6 },
  signedTag: { display: 'inline-block', marginTop: 4, background: '#ede9fe', color: '#5b21b6', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10 },
  waitingTag: { display: 'inline-block', marginTop: 4, background: '#fef3c7', color: '#92400e', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10 },
  locationRow: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 },
  locationBtn: { background: 'none', border: '1px solid #bfdbfe', color: 'var(--ops-page-accent)', padding: '3px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: 'pointer', alignSelf: 'flex-start' },
  mapWrap: { borderRadius: 8, overflow: 'hidden', border: '1px solid #e5e7eb' },
  mapLegend: { display: 'flex', gap: 12, padding: '6px 10px', background: '#f9fafb', flexWrap: 'wrap' },
  mapLegendItem: { fontSize: 11, color: '#374151', display: 'flex', alignItems: 'center', gap: 4 },
  mapLegendMissing: { fontSize: 11, color: '#6b7280', fontStyle: 'italic' },
  map: { height: 280, width: '100%' },
};
