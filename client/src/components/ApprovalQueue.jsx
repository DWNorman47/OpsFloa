import React, { useState, useEffect, useMemo } from 'react';
import api from '../api';
import { getOrFetch } from '../offlineDb';
import { SkeletonList } from './Skeleton';
import EmptyState from './EmptyState';
import MessageThread from './MessageThread';
import ModalShell from './ModalShell';
import MapLink from './MapLink';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';
import { fmtHours, langToLocale, formatDateTime } from '../utils';
import { labelSg, labelPl } from '../companyLabels';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
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

// Split segments are a contiguous chain over the original punch: the first start is the
// punch's start and the last end is the punch's end (both fixed), and every segment's
// start is just the previous segment's end. Only the intermediate ends are editable, so
// re-derive the starts (and pin the two fixed bounds) after any change.
function rechainSegments(segs, bounds) {
  if (!segs.length) return segs;
  const lastIdx = segs.length - 1;
  return segs.map((s, i) => ({
    ...s,
    start_time: i === 0 ? bounds.start : segs[i - 1].end_time,
    end_time: i === lastIdx ? bounds.end : s.end_time,
  }));
}

function formatHours(start, end) {
  const s = new Date(`1970-01-01T${start}`);
  const e = new Date(`1970-01-01T${end}`);
  return fmtHours((e - s) / 3600000);
}

// Real elapsed hours from the instant columns (start_ts→end_ts), used to show the
// TRUE duration of a flagged multi-day shift whose wall-clock hours are truncated.
function spanHours(e) {
  if (!e.start_ts || !e.end_ts) return null;
  const ms = new Date(e.end_ts) - new Date(e.start_ts);
  if (!(ms > 0)) return null;
  return fmtHours(ms / 3600000);
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

// Human label for a time entry's clock source.
function sourceLabel(src, t) {
  if (src === 'admin') return t.aqSourceAdmin;
  if (src === 'log_entry') return t.aqSourceLog;
  return t.aqSourceWorker;
}

// "lat, lng" to 5 decimals, or a "not recorded" note.
function coordText(lat, lng, t) {
  if (lat == null || lng == null) return t.aqNotRecorded;
  return `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
}

// Location history popup. Flow: pick a worker first, then a From date (defaults to their
// last day in the pending queue, else their most recent worked day), an optional To date
// (a range), and — for a single day — a dropdown of that day's entries. Three scopes:
//   • single day  → per-day first clock-in (green) + last clock-out (red) + breadcrumb path
//   • date range  → the same, for each day in the range (the entries dropdown hides)
//   • one entry   → the entry's first/last recorded location + path (the To date hides)
function LocationHistoryModal({ seed, pendingEntries, onClose, t, locale }) {
  const [workers, setWorkers] = useState([]);
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');           // set → range mode (entries dropdown hides)
  const [entryId, setEntryId] = useState(''); // set → single-entry mode (To date hides)
  const [rows, setRows] = useState(null);     // entries; null = not loaded yet
  const [pings, setPings] = useState([]);
  const [loading, setLoading] = useState(false);

  const rangeMode = !!to;
  const entryMode = !!entryId;

  const load = (uid, f, t2) => {
    if (!uid || !f) { setRows([]); setPings([]); return; }
    setLoading(true);
    api.get('/admin/worker-locations', { params: { user_id: uid, from: f, to: t2 || f } })
      .then(r => { setRows(r.data?.entries || []); setPings(r.data?.pings || []); })
      .catch(() => { setRows([]); setPings([]); })
      .finally(() => setLoading(false));
  };

  const lastPendingDay = (uid) => {
    const ds = (pendingEntries || [])
      .filter(e => String(e.user_id) === String(uid) && e.work_date)
      .map(e => String(e.work_date).substring(0, 10))
      .sort();
    return ds.length ? ds[ds.length - 1] : null;
  };

  const selectWorker = async (uid) => {
    setUserId(uid); setEntryId(''); setTo(''); setRows(null); setPings([]);
    if (!uid) { setFrom(''); return; }
    let day = lastPendingDay(uid);
    if (!day) {
      try {
        const r = await api.get('/admin/worker-locations', { params: { user_id: uid, latest: 1 } });
        day = r.data?.latest_date ? String(r.data.latest_date).substring(0, 10) : '';
      } catch { /* leave blank */ }
    }
    setFrom(day || '');
    load(uid, day || '', '');
  };

  const changeFrom = (d) => { setFrom(d); setEntryId(''); load(userId, d, to); };
  const changeTo = (d) => { setTo(d); setEntryId(''); load(userId, from, d); }; // set = range; clear = back to day
  const selectEntry = (id) => { setEntryId(id); if (id) setTo(''); };            // within the loaded day — no reload

  useEffect(() => {
    api.get('/admin/workers', { params: { all_roles: true } })
      .then(r => setWorkers(r.data || []))
      .catch(silentError('lochistory'));
    if (seed?.user_id) {
      const uid = String(seed.user_id);
      const d = seed.date ? String(seed.date).substring(0, 10) : '';
      setUserId(uid);
      if (d) { setFrom(d); setEntryId(seed.entry_id ? String(seed.entry_id) : ''); load(uid, d, ''); }
      else selectWorker(uid);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const showDropdown = !rangeMode; // entries dropdown hidden once a To date is set
  const showToBox = !entryMode;    // dash + To date hidden once an entry is picked

  // ── Map geometry ──────────────────────────────────────────────────────────────
  // One day (date/range mode): earliest clock-in, latest clock-out, path across its shifts.
  const dayGeom = (dayEntries) => {
    const ins = dayEntries.filter(e => e.clock_in_lat != null).sort((a, b) => new Date(a.start_ts) - new Date(b.start_ts));
    const outs = dayEntries.filter(e => e.clock_out_lat != null).sort((a, b) => new Date(a.end_ts) - new Date(b.end_ts));
    const green = ins[0] ? [Number(ins[0].clock_in_lat), Number(ins[0].clock_in_lng)] : null;
    const red = outs.length ? [Number(outs[outs.length - 1].clock_out_lat), Number(outs[outs.length - 1].clock_out_lng)] : null;
    const starts = dayEntries.map(e => new Date(e.start_ts).getTime()).filter(n => Number.isFinite(n));
    const ends = dayEntries.map(e => new Date(e.end_ts).getTime()).filter(n => Number.isFinite(n));
    const path = (starts.length && ends.length)
      ? pings.filter(pg => { const ms = new Date(pg.recorded_at).getTime(); return ms >= Math.min(...starts) && ms <= Math.max(...ends); })
             .map(pg => [Number(pg.lat), Number(pg.lng)])
      : [];
    return { green, red, path };
  };

  // One entry (entry mode): all its recorded locations in time order — clock-in point,
  // pings during the shift, clock-out point.
  const entryGeom = (e) => {
    const pts = [];
    if (e.clock_in_lat != null) pts.push({ pos: [Number(e.clock_in_lat), Number(e.clock_in_lng)], t: new Date(e.start_ts).getTime() });
    if (e.start_ts && e.end_ts) {
      const s = new Date(e.start_ts).getTime(), en = new Date(e.end_ts).getTime();
      pings.forEach(pg => { const ms = new Date(pg.recorded_at).getTime(); if (ms >= s && ms <= en) pts.push({ pos: [Number(pg.lat), Number(pg.lng)], t: ms }); });
    }
    if (e.clock_out_lat != null) pts.push({ pos: [Number(e.clock_out_lat), Number(e.clock_out_lng)], t: new Date(e.end_ts).getTime() });
    pts.sort((a, b) => a.t - b.t);
    const positions = pts.map(p => p.pos);
    return {
      first: positions[0] || null,
      last: positions.length > 1 ? positions[positions.length - 1] : null,
      path: positions.length >= 2 ? positions : [],
      only: positions.length === 1 ? positions[0] : null,
    };
  };

  const byDay = {};
  (rows || []).forEach(e => { const d = String(e.work_date).substring(0, 10); (byDay[d] = byDay[d] || []).push(e); });
  const dayKeys = Object.keys(byDay).sort();
  const dayEntries = (rows || []).filter(e => String(e.work_date).substring(0, 10) === from)
    .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));
  const selectedEntry = entryMode ? (rows || []).find(e => String(e.id) === String(entryId)) : null;

  const allPositions = [];
  if (entryMode && selectedEntry) {
    const g = entryGeom(selectedEntry);
    [g.only, g.first, g.last].forEach(p => p && allPositions.push(p));
    g.path.forEach(p => allPositions.push(p));
  } else {
    dayKeys.forEach(d => {
      const g = dayGeom(byDay[d]);
      [g.green, g.red].forEach(p => p && allPositions.push(p));
      g.path.forEach(p => allPositions.push(p));
    });
  }
  const hasMap = allPositions.length > 0;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <ModalShell onClose={onClose} titleId="aq-loc-title" style={styles.locModal}>
        <div onClick={e => e.stopPropagation()}>
          <h3 id="aq-loc-title" style={styles.modalTitle}>📍 {t.aqLocationHistory}</h3>
          <div style={styles.locControls}>
            <select style={styles.dateInput} value={userId} onChange={e => selectWorker(e.target.value)}>
              <option value="">{t.aqSelectWorker}</option>
              {workers.map(w => (
                <option key={w.id} value={w.id}>{w.full_name || w.name || w.username}</option>
              ))}
            </select>
            {userId && (
              <>
                <input type="date" style={styles.dateInput} value={from} onChange={e => changeFrom(e.target.value)} title={t.fromDate} />
                {showToBox && (
                  <>
                    <span style={{ fontSize: 12, color: '#6b7280' }}>–</span>
                    <input type="date" style={to ? styles.dateInput : styles.dateInputGray} value={to} onChange={e => changeTo(e.target.value)} title={t.toDate} />
                  </>
                )}
              </>
            )}
          </div>
          {userId && showDropdown && (
            <div style={styles.locControls}>
              <select style={styles.entrySelect} value={entryId} onChange={e => selectEntry(e.target.value)}>
                <option value="">{t.aqAllEntries}</option>
                {dayEntries.map(e => (
                  <option key={e.id} value={e.id}>
                    {formatTime(e.start_time)}–{formatTime(e.end_time)}{e.project_name ? ` · ${e.project_name}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {!userId ? (
            <p style={styles.approvedEmpty}>{t.aqPickWorkerFirst}</p>
          ) : loading ? (
            <p style={styles.approvedEmpty}>…</p>
          ) : !hasMap ? (
            <p style={styles.approvedEmpty}>{t.aqNoLocationData}</p>
          ) : (
            <div style={styles.mapWrap}>
              <MapContainer center={allPositions[0]} zoom={14} style={styles.map} scrollWheelZoom={false}>
                <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />
                <FitBounds positions={allPositions} />
                {entryMode && selectedEntry ? (() => {
                  const g = entryGeom(selectedEntry);
                  return (
                    <>
                      {g.path.length >= 2 && <Polyline positions={g.path} color="#2563eb" weight={4} opacity={0.7} />}
                      {g.only && <Marker position={g.only} icon={clockInIcon}><Popup>{coordText(g.only[0], g.only[1], t)}</Popup></Marker>}
                      {g.first && !g.only && <Marker position={g.first} icon={clockInIcon}><Popup>🟢 {t.clockIn}</Popup></Marker>}
                      {g.last && <Marker position={g.last} icon={clockOutIcon}><Popup>🔴 {t.clockOut}</Popup></Marker>}
                    </>
                  );
                })() : dayKeys.map(d => {
                  const g = dayGeom(byDay[d]);
                  return (
                    <React.Fragment key={d}>
                      {g.path.length >= 2 && <Polyline positions={g.path} color="#2563eb" weight={4} opacity={0.7} />}
                      {g.green && <Marker position={g.green} icon={clockInIcon}><Popup>🟢 {t.clockIn}<br />{formatDate(d + 'T00:00:00', locale)}</Popup></Marker>}
                      {g.red && <Marker position={g.red} icon={clockOutIcon}><Popup>🔴 {t.clockOut}<br />{formatDate(d + 'T00:00:00', locale)}</Popup></Marker>}
                    </React.Fragment>
                  );
                })}
              </MapContainer>
            </div>
          )}

          <div style={styles.modalActions}>
            <button style={styles.modalCloseBtn} onClick={onClose}>{t.close}</button>
          </div>
        </div>
      </ModalShell>
    </div>
  );
}

export default function ApprovalQueue({ onCountChange, settings = null }) {
  const { user } = useAuth();
  const t = useT();
  const locale = langToLocale(user?.language);
  const workerLabel = labelSg(settings?.label_worker, 'worker', user?.language);
  const workerLabelPlural = labelPl(settings?.label_worker, 'worker', user?.language);
  const workerLabelPluralLower = workerLabelPlural.toLowerCase();
  const [entries, setEntries] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [rejectingId, setRejectingId] = useState(null);
  const [rejectNote, setRejectNote] = useState('');
  const [working, setWorking] = useState(null);
  const [approvingAll, setApprovingAll] = useState(false);
  const [openMessageId, setOpenMessageId] = useState(null);
  const [openMapId, setOpenMapId] = useState(null);
  const [expandedIds, setExpandedIds] = useState(() => new Set()); // pending rows are compact by default; expand to reveal location, comments, edit & split
  const toggleExpand = (id) => setExpandedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
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
  const [recentRejected, setRecentRejected] = useState([]);
  const [showRejected, setShowRejected] = useState(false);
  const [unrejecting, setUnrejecting] = useState(null);
  const [unrejectError, setUnrejectError] = useState('');
  const [splitSegments, setSplitSegments] = useState([]);
  const [splitBounds, setSplitBounds] = useState({ start: '', end: '' }); // fixed punch start/end
  const [splitSaving, setSplitSaving] = useState(false);
  const [splitError, setSplitError] = useState('');
  const [confirmingApproveAll, setConfirmingApproveAll] = useState(false);
  const [editSaveError, setEditSaveError] = useState('');
  const [unapproveError, setUnapproveError] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [approvingSelected, setApprovingSelected] = useState(false);
  const [showPending, setShowPending] = useState(true); // approvals list open by default each load
  const [expandedRecent, setExpandedRecent] = useState(() => new Set()); // recently-approved/rejected rows expanded inline for details (keyed 'a-'/'r-' + id)
  const toggleRecentExpand = (key) => setExpandedRecent(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const [locHistoryOpen, setLocHistoryOpen] = useState(false);
  const [locSeed, setLocSeed] = useState(null); // { user_id, from, to } prefill for the Location history popup

  const fetch = () => {
    setLoading(true);
    setFetchError(false);
    const params = {};
    if (dateFrom) params.from = dateFrom;
    if (dateTo) params.to = dateTo;
    Promise.all([
      api.get('/admin/entries/pending', { params }),
      getOrFetch('projects', () => api.get('/work').then(r => r.data)),
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
    // With a date range, the server returns every approved entry in range that
    // isn't already in a finalized payroll run (review-before-finalize); with no
    // range it returns the last 24h of approvals.
    const params = {};
    if (dateFrom) params.from = dateFrom;
    if (dateTo) params.to = dateTo;
    api.get('/admin/entries/recently-approved', { params })
      .then(r => setRecentApproved(r.data))
      .catch(silentError('approvalqueue'));
  };

  const fetchRecentRejected = () => {
    // Mirror of the approved list: date range → rejected entries in range; no
    // range → the last 24h of rejections.
    const params = {};
    if (dateFrom) params.from = dateFrom;
    if (dateTo) params.to = dateTo;
    api.get('/admin/entries/recently-rejected', { params })
      .then(r => setRecentRejected(r.data))
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
      getOrFetch('projects', () => api.get('/work').then(r => r.data)),
    ])
      .then(([r, p]) => { if (!mounted) return; setEntries(r.data.entries); setHasMore(r.data.has_more); setProjects(p); })
      .catch(() => { if (mounted) setFetchError(true); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);
  // Refresh the approved list on mount and whenever the date range changes (the
  // range switches it from "last 24h" to "unfinalized approved entries in range").
  useEffect(() => { fetchRecentApproved(); fetchRecentRejected(); }, [dateFrom, dateTo]); // eslint-disable-line react-hooks/exhaustive-deps
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
    // Pre-fill two segments covering the full time range. Start/end of the punch are fixed;
    // only the middle boundary (segment 1's end) is editable.
    const pStart = e.start_time.substring(0, 5);
    const pEnd = e.end_time.substring(0, 5);
    const mid = midTime(pStart, pEnd);
    setSplitBounds({ start: pStart, end: pEnd });
    setSplitSegments([
      { _key: 0, start_time: pStart, end_time: mid, project_id: e.project_id ? String(e.project_id) : '' },
      { _key: 1, start_time: mid, end_time: pEnd, project_id: '' },
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

  const unreject = async id => {
    setUnrejecting(id);
    try {
      await api.patch(`/admin/entries/${id}/unreject`);
      setRecentRejected(prev => prev.filter(e => e.id !== id));
      fetch(); // back into the pending queue
    } catch (err) {
      setUnrejectError(err.response?.data?.error || t.failedRestore);
    } finally { setUnrejecting(null); }
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

  // Inline detail panel for an expanded recently-approved/rejected row. Work
  // date/time/project already show in the row header, so this adds the rest:
  // who approved/rejected it (+ when), reason, source, notes, clock locations
  // (with map links), QuickBooks sync, and a jump to the full location history.
  const renderRecentDetails = (entry, rejected) => (
    <div style={styles.recentDetails}>
      <div style={styles.detailGrid}>
        <span style={styles.detailLabel}>{rejected ? t.aqRejectedBy : t.aqApprovedBy}</span>
        <span>{entry.approved_by_name || '—'}{entry.approved_at ? ` · ${formatDateTime(entry.approved_at, user?.language)}` : ''}</span>
        {rejected && entry.approval_note && (<><span style={styles.detailLabel}>{t.aqRejectReason}</span><span>{entry.approval_note}</span></>)}
        <span style={styles.detailLabel}>{t.aqSource}</span>
        <span>{sourceLabel(entry.clock_source, t)}{entry.clocked_in_by_name ? ` (${entry.clocked_in_by_name})` : ''}</span>
        {entry.notes && (<><span style={styles.detailLabel}>{t.aqNotes}</span><span>{entry.notes}</span></>)}
        <span style={styles.detailLabel}>{t.aqClockInLoc}</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {coordText(entry.clock_in_lat, entry.clock_in_lng, t)}
          <MapLink lat={entry.clock_in_lat} lng={entry.clock_in_lng} />
        </span>
        <span style={styles.detailLabel}>{t.aqClockOutLoc}</span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {coordText(entry.clock_out_lat, entry.clock_out_lng, t)}
          <MapLink lat={entry.clock_out_lat} lng={entry.clock_out_lng} />
        </span>
        {!rejected && (<>
          <span style={styles.detailLabel}>QuickBooks</span>
          <span>{entry.qbo_activity_id ? t.aqQbSynced : '—'}</span>
        </>)}
      </div>
      {(entry.clock_in_lat || entry.clock_out_lat) && (
        <button
          style={{ ...styles.viewMapBtn, marginTop: 10 }}
          onClick={() => {
            const d = (entry.work_date || '').toString().substring(0, 10);
            setLocSeed({ user_id: entry.user_id, date: d, entry_id: entry.id });
            setLocHistoryOpen(true);
          }}
        >📍 {t.aqViewOnMap}</button>
      )}
    </div>
  );

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
        <button style={styles.locHistoryBtn} onClick={() => { setLocSeed(null); setLocHistoryOpen(true); }}>
          📍 {t.aqLocationHistory}
        </button>
      </div>

      {/* Always visible so the approved empty-state can point at "the dates above". */}
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
        <>
        <button style={styles.recentToggle} onClick={() => setShowPending(v => !v)}>
          <span>{t.aqPendingSection} ({visibleEntries.length})</span>
          <span>{showPending ? '▾' : '▸'}</span>
        </button>
        {showPending && (
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
                const isExpanded = expandedIds.has(e.id);
                return (
                <div key={e.id} className="approval-row" style={{ ...styles.row, ...(selectedIds.has(e.id) ? styles.rowSelected : {}) }}>
                  <input
                    type="checkbox"
                    className="approval-check"
                    checked={selectedIds.has(e.id)}
                    onChange={() => canApprove && toggleSelect(e.id)}
                    disabled={!canApprove}
                    title={!canApprove ? 'This entry cannot be approved until its end time has passed.' : undefined}
                    style={{ ...styles.rowCheckbox, ...(!canApprove ? { opacity: 0.35, cursor: 'not-allowed' } : {}) }}
                  />
                  <div className="approval-main" style={styles.rowMain}>
                    <div style={styles.worker}>{e.worker_name}</div>
                    <div style={styles.detail}>
                      <span style={styles.project}>{e.project_name}</span>
                      <span style={styles.sep}>·</span>
                      <span>{formatTime(e.start_time)} – {formatTime(e.end_time)} ({formatHours(e.start_time, e.end_time)})</span>
                      <span style={{ ...styles.wageTag, background: e.wage_type === 'prevailing' ? '#d97706' : '#2563eb' }}>
                        {e.wage_type === 'prevailing' ? t.prevailing : t.regular}
                      </span>
                      {e.long_shift_flagged && (
                        <span style={{ ...styles.wageTag, background: '#b91c1c' }} title={t.aqLongShiftTitle}>
                          ⚠ {t.aqLongShift}{spanHours(e) ? `: ${spanHours(e)}` : ''}
                        </span>
                      )}
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
                    {isExpanded && (e.clock_in_lat || e.clock_out_lat) && (
                      <div style={styles.locationRow}>
                        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                          <button style={styles.locationBtn} onClick={() => setOpenMapId(openMapId === e.id ? null : e.id)}>
                            📍 {openMapId === e.id ? t.aqHideMap : t.aqViewLocation}
                          </button>
                        </div>
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
                                {e.clock_in_lat && <Marker position={[parseFloat(e.clock_in_lat), parseFloat(e.clock_in_lng)]} icon={clockInIcon}><Popup>🟢 {t.clockIn}<br />{e.worker_name}<br /><MapLink lat={e.clock_in_lat} lng={e.clock_in_lng} /></Popup></Marker>}
                                {e.clock_out_lat && <Marker position={[parseFloat(e.clock_out_lat), parseFloat(e.clock_out_lng)]} icon={clockOutIcon}><Popup>🔴 {t.clockOut}<br />{e.worker_name}<br /><MapLink lat={e.clock_out_lat} lng={e.clock_out_lng} /></Popup></Marker>}
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
                    {isExpanded && (
                      <div style={styles.expandTools}>
                        <button style={styles.editTimesBtn} onClick={() => startEdit(e)}>✏️ Edit</button>
                        <button style={styles.splitBtn} onClick={() => startSplit(e)}>⇌ Split</button>
                        <button style={{ ...styles.msgBtn, marginTop: 0 }} onClick={() => setOpenMessageId(openMessageId === e.id ? null : e.id)}>
                          {openMessageId === e.id ? `💬 ${t.hideComments}` : t.commentsOpen}
                        </button>
                      </div>
                    )}
                    {isExpanded && openMessageId === e.id && <MessageThread entryId={e.id} currentUserId={user?.id} />}
                  </div>

                  {editingId === e.id ? (
                    <div className="approval-form" style={styles.editTimesForm}>
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
                        <div style={styles.editTimesLabel}>Project</div>
                        <select style={styles.editProjectSelect} value={editProject} onChange={ev => setEditProject(ev.target.value)}>
                          <option value="">No project</option>
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
                    <div className="approval-form" style={styles.splitForm}>
                      <div style={styles.splitTitle}>{t.aqSplitEntry}</div>
                      {splitError && <div style={styles.splitError}>{splitError}</div>}
                      {splitSegments.map((seg, i) => {
                        const isLast = i === splitSegments.length - 1;
                        // Starts are always derived (the previous end); the last end is the fixed
                        // punch-out. Only intermediate ends are editable.
                        const disabledStyle = { ...styles.editTimeInput, background: '#f3f4f6', color: '#9ca3af', cursor: 'not-allowed' };
                        return (
                        <div key={seg._key} style={styles.splitSegment}>
                          <div style={styles.splitSegLabel}>{t.aqSegment} {i + 1}</div>
                          <div style={styles.splitSegRow}>
                            <div>
                              <div style={styles.editTimesLabel}>{t.start}</div>
                              <input type="time" style={disabledStyle} value={seg.start_time} disabled readOnly />
                            </div>
                            <div>
                              <div style={styles.editTimesLabel}>{t.end}</div>
                              <input type="time" style={isLast ? disabledStyle : styles.editTimeInput} value={seg.end_time}
                                disabled={isLast} min={seg.start_time} max={splitBounds.end}
                                onChange={ev => setSplitSegments(prev => rechainSegments(prev.map((s, j) => j === i ? { ...s, end_time: ev.target.value } : s), splitBounds))} />
                            </div>
                            <div style={{ flex: 1, minWidth: 120 }}>
                              <div style={styles.editTimesLabel}>Project</div>
                              <select style={styles.editProjectSelect} value={seg.project_id}
                                onChange={ev => setSplitSegments(prev => prev.map((s, j) => j === i ? { ...s, project_id: ev.target.value } : s))}>
                                <option value="">No project</option>
                                {(projects || []).filter(p => p.active !== false).map(p => (
                                  <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                              </select>
                            </div>
                            {splitSegments.length > 2 && (
                              <button style={styles.splitRemoveBtn} aria-label={t.removeSegment} onClick={() => setSplitSegments(prev => rechainSegments(prev.filter((_, j) => j !== i), splitBounds))}>✕</button>
                            )}
                          </div>
                        </div>
                        );
                      })}
                      <button style={styles.splitAddBtn} onClick={() => {
                        // Carve a new final segment out of the current last one: split it at its
                        // midpoint. The new segment's end becomes the fixed punch-out (disabled),
                        // and the previously-last segment's end becomes editable.
                        setSplitSegments(prev => {
                          const li = prev.length - 1;
                          const last = prev[li];
                          const mid = midTime(last.start_time, last.end_time);
                          return rechainSegments([
                            ...prev.slice(0, li),
                            { ...last, end_time: mid },
                            { _key: Date.now(), start_time: mid, end_time: splitBounds.end, project_id: '' },
                          ], splitBounds);
                        });
                      }}>{t.aqAddSegment}</button>
                      <div style={styles.editTimesActions}>
                        <button style={{ ...styles.saveTimesBtn, ...(splitSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => saveSplit(e.id)} disabled={splitSaving}>{splitSaving ? t.saving : t.aqSplitSave}</button>
                        <button style={styles.cancelBtn} onClick={() => setSplittingId(null)}>{t.cancel}</button>
                      </div>
                    </div>
                  ) : rejectingId === e.id ? (
                    <div className="approval-form" style={styles.rejectForm}>
                      <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <input style={styles.rejectInput} placeholder={t.reasonOptional} maxLength={500} value={rejectNote} onChange={ev => setRejectNote(ev.target.value)} autoFocus />
                        <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{rejectNote.length}/500</div>
                      </div>
                      <button style={{ ...styles.confirmRejectBtn, ...(working === e.id ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => submitReject(e.id)} disabled={working === e.id}>{working === e.id ? t.saving : t.confirmReject}</button>
                      <button style={styles.cancelBtn} onClick={() => { setRejectingId(null); setRejectNote(''); }}>{t.cancel}</button>
                    </div>
                  ) : (
                    <div className="approval-actions" style={styles.actions}>
                      <button
                        style={{ ...styles.approveIconBtn, ...((working === e.id || !canApprove) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                        onClick={() => canApprove && approve(e.id)}
                        disabled={working === e.id || !canApprove}
                        title={!canApprove ? 'This entry cannot be approved until its end time has passed.' : t.approve}
                        aria-label={t.approve}
                      >
                        {working === e.id ? '…' : '✓'}
                      </button>
                      <button style={styles.rejectIconBtn} onClick={() => { setRejectingId(e.id); setRejectNote(''); }} title={t.reject} aria-label={t.reject}>✕</button>
                      <button
                        style={styles.locHistoryIconBtn}
                        onClick={() => {
                          const d = (e.work_date || '').toString().substring(0, 10);
                          setLocSeed({ user_id: e.user_id, date: d, entry_id: e.id });
                          setLocHistoryOpen(true);
                        }}
                        title={t.aqLocationHistory}
                        aria-label={t.aqLocationHistory}
                      >📍</button>
                    </div>
                  )}
                  {!isExpanded && rejectingId !== e.id && (
                    <button
                      className="approval-expand"
                      style={styles.expandWideBtn}
                      onClick={() => toggleExpand(e.id)}
                      aria-label={t.aqExpandRow}
                      aria-expanded={false}
                    >
                      {t.aqExpandRow} ▾
                    </button>
                  )}
                </div>
              );})}
            </div>
          ))}
        </div>
        )}
        </>
      )}

      <div style={styles.recentSection}>
        <button style={styles.recentToggle} onClick={() => setShowRecent(v => !v)}>
          <span>{(dateFrom || dateTo) ? t.aqApprovedInRange : t.aqRecentlyApproved} ({recentApproved.length})</span>
          <span>{showRecent ? '▾' : '▸'}</span>
        </button>
        {showRecent && (
          recentApproved.length === 0 ? (
            <p style={styles.approvedEmpty}>{t.aqApprovedEmptyHint}</p>
          ) : (
            <div style={styles.recentList}>
              {recentApproved.map(e => {
                const key = 'a-' + e.id;
                const open = expandedRecent.has(key);
                return (
                <div key={e.id} style={styles.recentItem}>
                  <div style={styles.recentRow}>
                    <button style={styles.recentInfoBtn} onClick={() => toggleRecentExpand(key)} title={t.aqViewDetails} aria-expanded={open}>
                      <span style={styles.recentChevron}>{open ? '▾' : '▸'}</span>
                      <span style={styles.recentWorker}>{e.worker_name}</span>
                      <span style={styles.recentDate}>{formatDate(e.work_date, locale)}</span>
                      <span style={styles.recentTime}>{formatTime(e.start_time)} – {formatTime(e.end_time)}</span>
                      {e.project_name && <span style={styles.recentProject}>{e.project_name}</span>}
                      {e.qbo_activity_id && (
                        <span style={styles.qboSyncBadge} title={`Synced to QuickBooks${e.qbo_synced_at ? ' · ' + formatDateTime(e.qbo_synced_at, user?.language) : ''}`}>
                          QB ✓
                        </span>
                      )}
                    </button>
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
                  {open && renderRecentDetails(e, false)}
                </div>
                );
              })}
            </div>
          )
        )}
      </div>

      <div style={styles.recentSection}>
        <button style={styles.recentToggle} onClick={() => setShowRejected(v => !v)}>
          <span>{(dateFrom || dateTo) ? t.aqRejectedInRange : t.aqRecentlyRejected} ({recentRejected.length})</span>
          <span>{showRejected ? '▾' : '▸'}</span>
        </button>
        {showRejected && (
          recentRejected.length === 0 ? (
            <p style={styles.approvedEmpty}>{t.aqRejectedEmptyHint}</p>
          ) : (
            <div style={styles.recentList}>
              {recentRejected.map(e => {
                const key = 'r-' + e.id;
                const open = expandedRecent.has(key);
                return (
                <div key={e.id} style={styles.recentItem}>
                  <div style={styles.recentRow}>
                    <button style={styles.recentInfoBtn} onClick={() => toggleRecentExpand(key)} title={t.aqViewDetails} aria-expanded={open}>
                      <span style={styles.recentChevron}>{open ? '▾' : '▸'}</span>
                      <span style={styles.recentWorker}>{e.worker_name}</span>
                      <span style={styles.recentDate}>{formatDate(e.work_date, locale)}</span>
                      <span style={styles.recentTime}>{formatTime(e.start_time)} – {formatTime(e.end_time)}</span>
                      {e.project_name && <span style={styles.recentProject}>{e.project_name}</span>}
                      {e.approval_note && <span style={styles.recentReason} title={e.approval_note}>“{e.approval_note}”</span>}
                    </button>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                      <button
                        style={{ ...styles.restoreBtn, ...(unrejecting === e.id ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                        onClick={() => { setUnrejectError(''); unreject(e.id); }}
                        disabled={unrejecting === e.id}
                      >
                        {unrejecting === e.id ? t.saving : t.aqRestore}
                      </button>
                      {unrejectError && unrejecting === null && <span style={styles.inlineError}>{unrejectError}</span>}
                    </div>
                  </div>
                  {open && renderRecentDetails(e, true)}
                </div>
                );
              })}
            </div>
          )
        )}
      </div>

      {locHistoryOpen && (
        <LocationHistoryModal seed={locSeed} pendingEntries={entries} onClose={() => setLocHistoryOpen(false)} t={t} locale={locale} />
      )}
    </div>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 24, minWidth: 0, maxWidth: '100%' },
  header: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap', minWidth: 0 },
  dateFilterRow: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14, flexWrap: 'wrap' },
  dateInput: { padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, color: '#374151', minHeight: 'unset' },
  dateInputGray: { padding: '4px 8px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, color: '#9ca3af', background: '#f9fafb', minHeight: 'unset' },
  entrySelect: { padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, color: '#374151', minHeight: 'unset', minWidth: 220, maxWidth: '100%' },
  applyDateBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, padding: '4px 10px', cursor: 'pointer' },
  clearDateBtn: { background: 'none', border: 'none', color: '#6b7280', fontSize: 13, cursor: 'pointer', padding: '0 4px', lineHeight: 1, minHeight: 'unset' },
  title: { fontSize: 17, fontWeight: 700, margin: 0, flex: '1 1 120px', minWidth: 0 },
  badge: { background: '#fef3c7', color: '#b45309', border: '1px solid #fcd34d', borderRadius: 20, padding: '2px 10px', fontSize: 12, fontWeight: 700, flex: '0 0 auto' },
  filterSelect: { padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, color: '#374151', background: '#fff', flex: '1 1 180px', minWidth: 0, maxWidth: '100%' },
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
  row: { border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 16px', marginBottom: 10, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  rowSelected: { background: '#f0f7ff', borderColor: '#93c5fd' },
  rowCheckbox: { marginTop: 3, flexShrink: 0, cursor: 'pointer', width: 15, height: 15 },
  selectAllBtn: { padding: '4px 12px', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#374151', flex: '0 0 auto' },
  approveSelectedBtn: { background: '#059669', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer', flex: '0 0 auto' },
  rowMain: { flex: 1, minWidth: 200 },
  worker: { fontWeight: 700, fontSize: 15, marginBottom: 4 },
  detail: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#555', flexWrap: 'wrap' },
  project: { fontWeight: 600, color: '#374151' },
  sep: { color: '#d1d5db' },
  wageTag: { color: '#fff', padding: '1px 7px', borderRadius: 10, fontSize: 11, fontWeight: 700 },
  notes: { marginTop: 4, fontSize: 12, color: '#6b7280', fontStyle: 'italic' },
  sourceBadge: { fontSize: 11, color: '#1e40af', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 4, padding: '2px 8px', fontWeight: 600, display: 'inline-block', marginTop: 4 },
  actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' },
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
  approveIconBtn: { background: '#059669', color: '#fff', border: 'none', width: 34, height: 34, borderRadius: 6, fontSize: 17, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 },
  rejectIconBtn: { background: 'none', border: '1px solid #fca5a5', color: '#ef4444', width: 34, height: 34, borderRadius: 6, fontSize: 15, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 },
  locHistoryIconBtn: { background: 'none', border: '1px solid #bfdbfe', color: 'var(--ops-page-accent)', width: 34, height: 34, borderRadius: 6, fontSize: 15, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 },
  // Full-bleed footer bar: negative margins cancel the card's 12x16 padding so it
  // sits flush against the card's bottom/side borders, with only the bottom corners
  // rounded to match. Thin tap strip that expands the row.
  expandWideBtn: { boxSizing: 'border-box', width: 'calc(100% + 32px)', margin: '10px -16px -12px -16px', padding: '0 3px', lineHeight: 1, background: 'none', border: 'none', borderTop: '1px solid #e5e7eb', borderRadius: '0 0 7px 7px', color: '#9ca3af', fontSize: 11, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 24 },
  rejectForm: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  rejectInput: { padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, minWidth: 160 },
  confirmRejectBtn: { background: '#ef4444', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  cancelBtn: { background: 'none', border: '1px solid #d1d5db', color: '#6b7280', padding: '6px 12px', borderRadius: 6, fontSize: 13, cursor: 'pointer' },
  approveAllBtn: { background: '#059669', color: '#fff', border: 'none', padding: '5px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer', flex: '0 0 auto' },
  recentSection: { marginTop: 20, borderTop: '1px solid #f0f0f0', paddingTop: 12 },
  recentToggle: { background: 'none', border: 'none', display: 'flex', justifyContent: 'space-between', width: '100%', fontSize: 13, fontWeight: 600, color: '#6b7280', cursor: 'pointer', padding: '4px 0' },
  recentList: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 },
  recentItem: { display: 'flex', flexDirection: 'column', background: '#f9fafb', borderRadius: 7, overflow: 'hidden' },
  recentRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 10px', background: '#f9fafb', borderRadius: 7, flexWrap: 'wrap' },
  recentChevron: { color: '#9ca3af', fontSize: 11 },
  recentDetails: { padding: '4px 12px 12px', borderTop: '1px solid #eef2f7' },
  recentInfo: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 },
  recentWorker: { fontWeight: 700, color: '#374151' },
  recentDate: { color: '#6b7280' },
  recentTime: { color: '#6b7280' },
  recentProject: { background: '#e0e7ff', color: '#3730a3', borderRadius: 6, padding: '1px 7px', fontSize: 11, fontWeight: 600 },
  unapproveBtn: { padding: '5px 12px', background: '#fff', border: '1px solid #fca5a5', color: '#dc2626', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
  restoreBtn: { padding: '5px 12px', background: '#fff', border: '1px solid #a7f3d0', color: '#059669', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
  recentReason: { color: '#b45309', fontStyle: 'italic', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  qboSyncBadge: { background: '#d1fae5', color: '#065f46', border: '1px solid #6ee7b7', borderRadius: 6, padding: '1px 6px', fontSize: 11, fontWeight: 700 },
  cancelApproveAllBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '5px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer', flex: '0 0 auto' },
  inlineError: { fontSize: 12, color: '#ef4444' },
  msgBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '3px 10px', borderRadius: 5, fontSize: 11, cursor: 'pointer', marginTop: 6 },
  expandTools: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 },
  signedTag: { display: 'inline-block', marginTop: 4, background: '#ede9fe', color: '#5b21b6', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10 },
  waitingTag: { display: 'inline-block', marginTop: 4, background: '#fef3c7', color: '#92400e', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10 },
  locationRow: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 },
  locationBtn: { background: 'none', border: '1px solid #bfdbfe', color: 'var(--ops-page-accent)', padding: '3px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: 'pointer', alignSelf: 'flex-start' },
  mapWrap: { borderRadius: 8, overflow: 'hidden', border: '1px solid #e5e7eb' },
  mapLegend: { display: 'flex', gap: 12, padding: '6px 10px', background: '#f9fafb', flexWrap: 'wrap' },
  mapLegendItem: { fontSize: 11, color: '#374151', display: 'flex', alignItems: 'center', gap: 4 },
  mapLegendMissing: { fontSize: 11, color: '#6b7280', fontStyle: 'italic' },
  map: { height: 280, width: '100%' },
  locHistoryBtn: { marginLeft: 'auto', background: 'none', border: '1px solid #bfdbfe', color: 'var(--ops-page-accent)', padding: '5px 12px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer', flex: '0 0 auto' },
  approvedEmpty: { fontSize: 13, color: '#6b7280', fontStyle: 'italic', margin: '10px 2px', textAlign: 'center' },
  recentInfoBtn: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13, background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', padding: 0, flex: 1 },
  // Modal (detail + location history)
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000, padding: 16 },
  modal: { background: '#fff', borderRadius: 12, padding: 20, maxWidth: 460, width: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.25)' },
  locModal: { background: '#fff', borderRadius: 12, padding: 20, maxWidth: 720, width: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.25)' },
  modalTitle: { margin: '0 0 14px', fontSize: 17, fontWeight: 700, color: '#111827' },
  detailGrid: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 14px', fontSize: 13, color: '#374151', alignItems: 'baseline' },
  detailLabel: { fontWeight: 600, color: '#6b7280' },
  modalActions: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18, flexWrap: 'wrap' },
  viewMapBtn: { background: 'none', border: '1px solid #bfdbfe', color: 'var(--ops-page-accent)', padding: '7px 14px', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  modalCloseBtn: { background: '#111827', color: '#fff', border: 'none', padding: '7px 16px', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  locControls: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 },
  locList: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 },
  locListRow: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, padding: '6px 8px', background: '#f9fafb', borderRadius: 6 },
  locCoord: { color: '#6b7280', fontFamily: 'monospace', fontSize: 11 },
};
