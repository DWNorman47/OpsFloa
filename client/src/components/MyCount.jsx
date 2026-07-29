import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api';
import { getCached, setCached, isFresh, enqueuePendingSync, getPendingSyncs, removePendingSync } from '../offlineDb';
import { useT } from '../hooks/useT';
import EmptyState from './EmptyState';

const CACHE_KEY = 'my-count-assignments';

// Group assignments by count_id
function groupByCount(assignments) {
  const map = {};
  for (const a of assignments) {
    const key = a.count_id;
    if (!map[key]) {
      map[key] = {
        count_id: a.count_id,
        count_type: a.count_type,
        count_location: a.count_location_name || 'All Locations',
        assignments: [],
      };
    }
    map[key].assignments.push(a);
  }
  return Object.values(map);
}

function roleColor(role) {
  return { counter: '#2563eb', auditor: '#d97706', reconciler: '#7c3aed' }[role] || '#6b7280';
}
function roleBg(role) {
  return { counter: '#dbeafe', auditor: '#fef3c7', reconciler: '#ede9fe' }[role] || '#f3f4f6';
}

export default function MyCount() {
  const t = useT();
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [submitStates, setSubmitStates] = useState({}); // { [assignmentId]: { qty, notes, submitting, submitted, error } }
  const mounted = useRef(true);
  const drainingRef = useRef(false); // ref-based guard so event handlers always see current value

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async (forceRefresh = false) => {
    if (!mounted.current) return;
    setLoading(true);
    try {
      const cached = await getCached(CACHE_KEY);
      if (!forceRefresh && isFresh(cached, CACHE_KEY)) {
        setAssignments(cached.data || []);
        setLoading(false);
        return;
      }
      if (navigator.onLine) {
        const r = await api.get('/inventory/cycle-counts/my-assignments');
        const data = r.data || [];
        await setCached(CACHE_KEY, data);
        if (mounted.current) setAssignments(data);
      } else if (cached) {
        if (mounted.current) setAssignments(cached.data || []);
      }
    } catch {
      const cached = await getCached(CACHE_KEY);
      if (cached && mounted.current) setAssignments(cached.data || []);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  const loadPendingCount = useCallback(async () => {
    const syncs = await getPendingSyncs();
    if (mounted.current) setPendingCount(syncs.length);
  }, []);

  // Drain the offline sync queue when we come back online.
  // Uses a ref guard so the online event handler (captured at mount) always sees the current lock.
  const drainQueue = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    setSyncing(true);
    try {
      const syncs = await getPendingSyncs();
      for (const sync of syncs) {
        try {
          await api.post(`/inventory/cycle-counts/${sync.count_id}/submit`, {
            line_id: sync.line_id,
            role: sync.role,
            counted_qty: sync.counted_qty,
            counted_uom_id: sync.counted_uom_id || null,
            notes: sync.notes || null,
          });
          await removePendingSync(sync.id);
        } catch (e) {
          const status = e.response?.status;
          if ([400, 404, 409, 422].includes(status)) {
            // Validation/not-found/conflict errors are permanent for this queued item.
            // Remove from queue so it doesn't block subsequent items on every reconnect
            await removePendingSync(sync.id);
          } else {
            // Network, auth/permission, rate-limit, or 5xx error — preserve the item.
            break;
          }
        }
      }
    } finally {
      drainingRef.current = false;
      if (mounted.current) {
        setSyncing(false);
        loadPendingCount();
        load(true); // refresh assignments after drain
      }
    }
  }, [load, loadPendingCount]);

  useEffect(() => {
    load();
    loadPendingCount();
    if (navigator.onLine) drainQueue();
    const handleOnline = () => {
      setOffline(false);
      drainQueue();
    };
    const handleOffline = () => setOffline(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [drainQueue, load, loadPendingCount]);

  const getState = (assignmentId) => submitStates[assignmentId] || { qty: '', notes: '', submitting: false, submitted: false, error: '' };
  const setState = (assignmentId, patch) => setSubmitStates(prev => ({
    ...prev,
    [assignmentId]: { ...getState(assignmentId), ...patch },
  }));

  const submit = async (assignment) => {
    const state = getState(assignment.assignment_id);
    const qty = parseFloat(state.qty);
    if (isNaN(qty) || qty < 0) {
      setState(assignment.assignment_id, { error: t.myCountErrQty });
      return;
    }
    setState(assignment.assignment_id, { submitting: true, error: '' });

    const payload = {
      count_id: assignment.count_id,
      line_id: assignment.line_id,
      role: assignment.role,
      counted_qty: qty,
      notes: state.notes?.trim() || null,
    };

    if (!navigator.onLine) {
      // Queue for later sync
      await enqueuePendingSync(payload);
      setState(assignment.assignment_id, { submitted: true, submitting: false });
      // Update local cache to mark as submitted so it disappears from the list
      const remaining = assignments.filter(a => a.assignment_id !== assignment.assignment_id);
      setAssignments(remaining);
      await setCached(CACHE_KEY, remaining);
      loadPendingCount();
      return;
    }

    try {
      await api.post(`/inventory/cycle-counts/${assignment.count_id}/submit`, {
        line_id: payload.line_id,
        role: payload.role,
        counted_qty: qty,
        notes: payload.notes,
      });
      setState(assignment.assignment_id, { submitted: true, submitting: false });
      // Remove from list
      const remaining = assignments.filter(a => a.assignment_id !== assignment.assignment_id);
      setAssignments(remaining);
      await setCached(CACHE_KEY, remaining);
    } catch (e) {
      setState(assignment.assignment_id, {
        submitting: false,
        error: e.response?.data?.error || t.myCountErrSubmit,
      });
    }
  };

  const groups = groupByCount(assignments);
  const isAuditRole = (role) => role === 'auditor';

  if (loading) return <div style={s.loading}>{t.myCountLoading}</div>;

  return (
    <div style={s.wrap}>
      <div style={s.headerRow}>
        <h2 style={s.title}>{t.myCountTitle}</h2>
        <button style={{ ...s.refreshBtn, ...(offline ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => load(true)} disabled={offline}>
          {offline ? t.myCountOffline : t.myCountRefresh}
        </button>
      </div>

      {offline && (
        <div style={s.offlineBanner}>{t.myCountOfflineBanner}</div>
      )}

      {syncing && (
        <div style={s.syncBanner}>{t.myCountSyncing} {pendingCount} {t.myCountQueuedSuffix}</div>
      )}

      {!syncing && pendingCount > 0 && (
        <div style={s.pendingBanner}>
          {pendingCount} {t.myCountPendingPrefix}{' '}
          {!offline && (
            <button style={s.syncNowBtn} onClick={drainQueue}>{t.myCountSyncNow}</button>
          )}
        </div>
      )}

      {groups.length === 0 ? (
        <EmptyState mark="C" title={t.myCountEmpty} body={t.myCountEmptyHint} tone="good" />
      ) : (
        groups.map(group => (
          <div key={group.count_id} style={s.countCard}>
            <div style={s.countHeader}>
              <span style={s.countType}>{group.count_type?.replace('_', ' ')}</span>
              <span style={s.countLoc}>{group.count_location}</span>
            </div>
            <div style={s.lineList}>
              {group.assignments.map(a => {
                const state = getState(a.assignment_id);
                if (state.submitted) return null;
                const hideExpected = isAuditRole(a.role);
                return (
                  <div key={a.assignment_id} style={s.lineCard}>
                    <div style={s.lineTop}>
                      <div>
                        <span style={s.itemName}>{a.item_name}</span>
                        {a.sku && <span style={s.sku}>{a.sku}</span>}
                        {a.location_name && <span style={s.loc}> · {a.location_name}</span>}
                      </div>
                      <span style={{ ...s.roleBadge, color: roleColor(a.role), background: roleBg(a.role) }}>
                        {a.role}
                      </span>
                    </div>
                    {!hideExpected && (
                      <div style={s.expected}>
                        {t.myCountExpected}: <strong>{parseFloat(a.expected_qty)} {a.stock_uom_unit || a.unit}</strong>
                      </div>
                    )}
                    <div style={s.inputRow}>
                      <div style={s.inputGroup}>
                        <label style={s.inputLabel}>
                          {a.role === 'auditor' ? t.myCountRoleAuditor : a.role === 'reconciler' ? t.myCountRoleReconciler : t.myCountRoleCounter}
                        </label>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          style={s.qtyInput}
                          value={state.qty}
                          onChange={e => setState(a.assignment_id, { qty: e.target.value, error: '' })}
                          placeholder="0"
                        />
                        <span style={s.unit}>{a.stock_uom_unit || a.unit}</span>
                      </div>
                      <div style={s.inputGroup}>
                        <label style={s.inputLabel}>{t.myCountNotes}</label>
                        <input
                          type="text"
                          style={s.notesInput}
                          maxLength={500}
                          value={state.notes}
                          onChange={e => setState(a.assignment_id, { notes: e.target.value })}
                          placeholder={t.myCountNotesPlaceholder}
                        />
                      </div>
                    </div>
                    {state.error && <div style={s.error}>{state.error}</div>}
                    <button
                      style={{ ...s.submitBtn, opacity: state.submitting ? 0.6 : 1 }}
                      onClick={() => submit(a)}
                      disabled={state.submitting || state.qty === ''}
                    >
                      {state.submitting ? t.myCountSubmitting : offline ? t.myCountQueueOffline : t.myCountSubmit}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

const s = {
  wrap:          { padding: 16, maxWidth: 600 },
  headerRow:     { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title:         { fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 },
  refreshBtn:    { padding: '6px 14px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', fontSize: 13, fontWeight: 600, color: '#374151', cursor: 'pointer' },
  offlineBanner: { background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 12 },
  syncBanner:    { background: '#dbeafe', color: '#1e40af', border: '1px solid #93c5fd', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 12 },
  pendingBanner: { background: '#fef9c3', color: '#713f12', border: '1px solid #fde047', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 },
  syncNowBtn:    { padding: '3px 10px', borderRadius: 6, border: 'none', background: '#d97706', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  loading:       { textAlign: 'center', padding: 40, color: '#6b7280', fontSize: 14 },
  countCard:     { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, marginBottom: 16, overflow: 'hidden' },
  countHeader:   { display: 'flex', alignItems: 'center', gap: 10, background: '#f9fafb', padding: '10px 16px', borderBottom: '1px solid #e5e7eb' },
  countType:     { fontSize: 12, fontWeight: 700, textTransform: 'capitalize', color: '#374151', background: '#e5e7eb', padding: '2px 8px', borderRadius: 8 },
  countLoc:      { fontSize: 14, fontWeight: 600, color: '#111827' },
  lineList:      { padding: '8px 0' },
  lineCard:      { padding: '12px 16px', borderBottom: '1px solid #f3f4f6' },
  lineTop:       { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 },
  itemName:      { fontSize: 15, fontWeight: 700, color: '#111827' },
  sku:           { fontSize: 12, color: '#6b7280', marginLeft: 6, fontFamily: 'monospace' },
  loc:           { fontSize: 12, color: '#6b7280' },
  roleBadge:     { padding: '2px 10px', borderRadius: 10, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' },
  expected:      { fontSize: 13, color: '#6b7280', marginBottom: 8 },
  inputRow:      { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 },
  inputGroup:    { display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 100 },
  inputLabel:    { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' },
  qtyInput:      { padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 15, width: '100%', boxSizing: 'border-box', fontWeight: 700 },
  notesInput:    { padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, width: '100%', boxSizing: 'border-box' },
  unit:          { fontSize: 12, color: '#6b7280' },
  error:         { color: '#dc2626', fontSize: 13, marginBottom: 6 },
  submitBtn:     { width: '100%', padding: '10px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
};
