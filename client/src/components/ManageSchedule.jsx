import React, { useState, useEffect, useMemo } from 'react';
import api from '../api';
import { useToast } from '../contexts/ToastContext';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { langToLocale } from '../utils';
import { SkeletonList } from './Skeleton';
import {
  DndContext, DragOverlay, PointerSensor, TouchSensor,
  useSensor, useSensors, useDroppable, useDraggable,
} from '@dnd-kit/core';

import { silentError } from '../errorReporter';
import { startOfWeek as computeStartOfWeek } from '../utils/weekBounds';
// Local wrapper so existing call sites don't need a weekStart arg threaded
// through; the setting is read per-render inside the component.
function startOfWeekFor(date, ws) { return computeStartOfWeek(date, ws ?? 1); }
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function toISO(d) { return d.toLocaleDateString('en-CA'); }
function fmtDay(d, locale = 'en-US') { return d.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' }); }
function fmtTime(t) { const [h, m] = t.split(':'); const hr = parseInt(h); return `${hr % 12 || 12}:${m}${hr < 12 ? 'a' : 'p'}`; }

// Visual content of a shift pill — used both inline and in the drag overlay
function PillContent({ s }) {
  return (
    <>
      <div style={styles.pillWorker}>
        {s.worker_name}
        {s.cant_make_it && <span style={styles.pillCantBadge}>✗ Can't make it</span>}
      </div>
      {s.cant_make_it && s.cant_make_it_note && (
        <div style={styles.pillCantNote}>{s.cant_make_it_note}</div>
      )}
      {s.project_name && <div style={styles.pillProject}>{s.project_name}</div>}
      <div style={styles.pillTime}>{fmtTime(s.start_time)}–{fmtTime(s.end_time)}{s.recurrence_group_id ? ' ↻' : ''}</div>
      {s.notes && <div style={styles.pillNotes}>{s.notes}</div>}
    </>
  );
}

function DraggableShift({ s, editingId, startEdit, setEditingId, dragMode }) {
  const t = useT();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: String(s.id) });
  const isEditing = editingId === s.id;

  return (
    <div ref={setNodeRef}>
      <div style={{ ...styles.shiftPill, ...(isEditing ? styles.shiftPillActive : {}), ...(s.cant_make_it ? styles.shiftPillCant : {}), opacity: isDragging ? 0.35 : 1, cursor: dragMode ? 'grab' : 'default' }} {...(dragMode ? { ...listeners, ...attributes } : {})}>
        <PillContent s={s} />
        <div style={styles.pillActions} onPointerDown={e => e.stopPropagation()} onTouchStart={e => e.stopPropagation()}>
          <button style={isEditing ? styles.editPillBtnActive : styles.editPillBtn} onClick={() => isEditing ? setEditingId(null) : startEdit(s)}>
            {isEditing ? t.cancel : t.edit}
          </button>
        </div>
      </div>
    </div>
  );
}

function DroppableDay({ date, isToday, children }) {
  const { setNodeRef, isOver } = useDroppable({ id: date });
  return (
    <div
      ref={setNodeRef}
      style={{
        ...styles.dayCol,
        borderTop: `3px solid ${isToday ? 'var(--ops-page-accent)' : '#e5e7eb'}`,
        background: isOver ? '#eff6ff' : undefined,
        transition: 'background 0.15s',
      }}
    >
      {children}
    </div>
  );
}

function exportCSV(shifts, days, workerLabel = 'Worker', workLabel = 'Project') {
  const header = ['Date', workerLabel, workLabel, 'Start', 'End', 'Notes', "Can't Make It", 'Reason', 'Series ID'];
  const rows = shifts.map(s => [
    s.shift_date.substring(0, 10),
    s.worker_name,
    s.project_name || '',
    s.start_time.substring(0, 5),
    s.end_time.substring(0, 5),
    s.notes || '',
    s.cant_make_it ? 'Yes' : 'No',
    s.cant_make_it_note || '',
    s.recurrence_group_id || '',
  ]);
  const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `schedule-${days[0].toLocaleDateString('en-CA')}.csv`;
  a.click();
}

function SummaryView({ shifts, days, workerLabel = 'Worker' }) {
  const t = useT();
  const [cantOnly, setCantOnly] = useState(false);

  // Build worker → day → shifts map
  const { workerMap, hasCantFlags } = useMemo(() => {
    const map = {};
    shifts.forEach(s => {
      const name = s.worker_name;
      if (!map[name]) map[name] = { name, byDay: {} };
      const key = s.shift_date.substring(0, 10);
      if (!map[name].byDay[key]) map[name].byDay[key] = [];
      map[name].byDay[key].push(s);
    });
    return { workerMap: map, hasCantFlags: shifts.some(s => s.cant_make_it) };
  }, [shifts]);

  let rows = useMemo(() => {
    const sorted = Object.values(workerMap).sort((a, b) => a.name.localeCompare(b.name));
    return cantOnly ? sorted.filter(row => Object.values(row.byDay).some(arr => arr.some(s => s.cant_make_it))) : sorted;
  }, [workerMap, cantOnly]);

  if (Object.values(workerMap).length === 0) return <p style={{ color: '#6b7280', fontSize: 13, padding: '16px 0' }}>{t.msNoShiftsWeek}</p>;

  return (
    <div style={styles.summaryWrap}>
      {hasCantFlags && (
        <label style={styles.cantOnlyToggle}>
          <input type="checkbox" checked={cantOnly} onChange={e => setCantOnly(e.target.checked)} />
          {' '}{t.msCantOnly}
        </label>
      )}
      {cantOnly && rows.length === 0 && (
        <p style={{ color: '#6b7280', fontSize: 13, padding: '8px 0' }}>{t.msCantOnlyNoFlags}</p>
      )}
      <table style={styles.summaryTable}>
        <thead>
          <tr>
            <th style={styles.summaryThWorker}>{workerLabel}</th>
            {days.map(day => {
              const isToday = toISO(day) === toISO(new Date());
              return (
                <th key={toISO(day)} style={{ ...styles.summaryTh, color: isToday ? 'var(--ops-page-accent)' : '#374151' }}>
                  <div>{day.toLocaleDateString(locale, { weekday: 'short' })}</div>
                  <div style={{ fontWeight: 400, fontSize: 10 }}>{day.getDate()}</div>
                </th>
              );
            })}
            <th style={styles.summaryThTotal}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const total = Object.values(row.byDay).reduce((n, arr) => n + arr.length, 0);
            const hasCant = Object.values(row.byDay).some(arr => arr.some(s => s.cant_make_it));
            return (
              <tr key={row.name} style={hasCant ? styles.summaryRowCant : {}}>
                <td style={styles.summaryTdWorker} title={row.name}>
                  {row.name}
                  {hasCant && <span style={styles.summaryCantDot} title={t.wsCantMakeIt}>✗</span>}
                </td>
                {days.map(day => {
                  const key = toISO(day);
                  const dayShifts = row.byDay[key] || [];
                  return (
                    <td key={key} style={styles.summaryTd}>
                      {dayShifts.length === 0 ? (
                        <span style={styles.summaryEmpty}>–</span>
                      ) : dayShifts.map((s, i) => (
                        <div key={i} style={{ ...styles.summaryShift, ...(s.cant_make_it ? styles.summaryShiftCant : {}) }}>
                          {fmtTime(s.start_time)}–{fmtTime(s.end_time)}
                          {s.project_name && <div style={styles.summaryProject}>{s.project_name}</div>}
                          {s.cant_make_it && s.cant_make_it_note && (
                            <div style={styles.summaryCantNote}>{s.cant_make_it_note}</div>
                          )}
                        </div>
                      ))}
                    </td>
                  );
                })}
                <td style={styles.summaryTdTotal}>{total}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function ManageSchedule({ workers, projects, weekStart: companyWeekStart = 1, settings = null }) {
  const toast = useToast();
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const workerLabel = settings?.label_worker || 'Team Member';
  const workLabel = settings?.label_work || 'Project';
  const workerLabelLower = workerLabel.toLowerCase();
  const workLabelLower = workLabel.toLowerCase();
  const [weekStart, setWeekStart] = useState(() => startOfWeekFor(new Date(), companyWeekStart));
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState('grid');
  const [form, setForm] = useState({ user_id: '', project_id: '', shift_date: toISO(new Date()), start_time: '08:00', end_time: '17:00', notes: '', repeat: 'none' });
  const [availability, setAvailability] = useState([]); // [{ user_id, day_of_week, start_time, end_time }]
  const [availabilityWarning, setAvailabilityWarning] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [editSaving, setEditSaving] = useState(false);
  const [activeShift, setActiveShift] = useState(null);
  const [dragMode, setDragMode] = useState(false);
  const [preDragShifts, setPreDragShifts] = useState(null);
  const [pendingMoves, setPendingMoves] = useState({});
  const [savingMoves, setSavingMoves] = useState(false);
  const [overlapWarning, setOverlapWarning] = useState('');
  const [copyingWeek, setCopyingWeek] = useState(false);

  const activeSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );
  const disabledSensors = useSensors();
  const sensors = dragMode ? activeSensors : disabledSensors;

  const enterDragMode = () => {
    setPreDragShifts(shifts);
    setPendingMoves({});
    setDragMode(true);
    setEditingId(null);
  };

  const discardDrag = () => {
    setShifts(preDragShifts);
    setPendingMoves({});
    setPreDragShifts(null);
    setDragMode(false);
  };

  const saveDragMoves = async () => {
    setSavingMoves(true);
    try {
      await Promise.all(Object.entries(pendingMoves).map(([shiftId, newDate]) => {
        const shift = shifts.find(s => s.id === parseInt(shiftId));
        if (!shift) return Promise.resolve();
        return api.patch(`/shifts/admin/${shiftId}`, {
          shift_date: newDate,
          start_time: shift.start_time.substring(0, 5),
          end_time: shift.end_time.substring(0, 5),
          project_id: shift.project_id || '',
          notes: shift.notes || '',
        });
      }));
      toast(t.shiftsSaved.replace('{n}', Object.keys(pendingMoves).length), 'success');
    } catch {
      toast(t.someShiftsFailed, 'error');
    } finally {
      setSavingMoves(false);
      setPendingMoves({});
      setPreDragShifts(null);
      setDragMode(false);
    }
  };

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const from = toISO(days[0]);
  const to = toISO(days[6]);

  useEffect(() => {
    setLoading(true);
    api.get('/shifts/admin', { params: { from, to } })
      .then(r => setShifts(r.data))
      .catch(silentError('manageschedule'))
      .finally(() => setLoading(false));
  }, [from, to]);

  useEffect(() => {
    api.get('/availability/admin').then(r => setAvailability(r.data)).catch(silentError('manageschedule'));
  }, []);

  useEffect(() => {
    const today = toISO(new Date());
    const dateInView = today >= from && today <= to ? today : from;
    setForm(f => ({ ...f, shift_date: dateInView }));
  }, [from, to]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const addShift = async e => {
    e.preventDefault();
    if (!form.user_id) { setError(`Select a ${workerLabelLower}.`); return; }

    // Check worker availability
    const shiftDay = new Date(form.shift_date + 'T00:00:00').getDay();
    const workerAvail = availability.find(a => String(a.user_id) === String(form.user_id) && a.day_of_week === shiftDay);
    if (workerAvail) {
      const availStart = workerAvail.start_time.substring(0, 5);
      const availEnd = workerAvail.end_time.substring(0, 5);
      if (form.start_time < availStart || form.end_time > availEnd) {
        setAvailabilityWarning(t.msAvailabilityWarning);
      } else {
        setAvailabilityWarning('');
      }
    } else {
      setAvailabilityWarning('');
    }

    // Check for overlapping shift for the same worker on the same day
    const existing = shifts.filter(s =>
      String(s.user_id) === String(form.user_id) &&
      s.shift_date.substring(0, 10) === form.shift_date
    );
    const newStart = form.start_time;
    const newEnd = form.end_time;
    const hasOverlap = existing.some(s => {
      const eStart = s.start_time.substring(0, 5);
      const eEnd = s.end_time.substring(0, 5);
      return newStart < eEnd && newEnd > eStart;
    });
    if (hasOverlap) {
      setOverlapWarning(t.msOverlapWarning);
    } else {
      setOverlapWarning('');
    }

    // Generate dates for recurring
    const baseDates = [form.shift_date];
    if (form.repeat === 'weekly-4') {
      for (let i = 1; i < 4; i++) baseDates.push(toISO(addDays(new Date(form.shift_date + 'T00:00:00'), i * 7)));
    } else if (form.repeat === 'biweekly-4') {
      for (let i = 1; i < 4; i++) baseDates.push(toISO(addDays(new Date(form.shift_date + 'T00:00:00'), i * 14)));
    } else if (form.repeat === 'monthly-3') {
      for (let i = 1; i < 3; i++) {
        const d = new Date(form.shift_date + 'T00:00:00');
        d.setMonth(d.getMonth() + i);
        baseDates.push(toISO(d));
      }
    }

    setSaving(true); setError('');
    try {
      const newShifts = [];
      const groupId = baseDates.length > 1 ? crypto.randomUUID() : undefined;
      for (const date of baseDates) {
        const r = await api.post('/shifts/admin', { ...form, shift_date: date, recurrence_group_id: groupId });
        newShifts.push(r.data);
      }
      setShifts(prev => [...prev, ...newShifts].sort((a, b) => a.shift_date.localeCompare(b.shift_date) || a.start_time.localeCompare(b.start_time)));
      setForm(f => ({ ...f, notes: '', repeat: 'none' }));
      setOverlapWarning(''); setAvailabilityWarning('');
      toast(baseDates.length > 1 ? t.shiftsAddedN.replace('{n}', baseDates.length) : t.shiftAdded, 'success');
    } catch (err) {
      setError(err.response?.data?.error || t.failedSaveShift);
    } finally { setSaving(false); }
  };

  const copyWeek = async () => {
    if (shifts.length === 0) return;
    setCopyingWeek(true);
    let failed = 0;
    const results = [];
    for (const s of shifts) {
      const nextDate = toISO(addDays(new Date(s.shift_date.substring(0, 10) + 'T00:00:00'), 7));
      try {
        const r = await api.post('/shifts/admin', {
          user_id: s.user_id,
          project_id: s.project_id || '',
          shift_date: nextDate,
          start_time: s.start_time.substring(0, 5),
          end_time: s.end_time.substring(0, 5),
          notes: s.notes || '',
        });
        results.push(r.data);
      } catch { failed++; }
    }
    setCopyingWeek(false);
    if (failed === shifts.length) { toast(t.msCopyFailed, 'error'); return; }
    if (failed > 0) toast(t.msCopyFailed, 'error');
    else toast(t.msCopyDone, 'success');
    // Navigate to next week to show the copies
    setShifts(prev => [...prev, ...results].sort((a, b) => a.shift_date.localeCompare(b.shift_date) || a.start_time.localeCompare(b.start_time)));
    setWeekStart(d => addDays(d, 7));
  };

  const deleteShift = async id => {
    setDeleting(id);
    try {
      await api.delete(`/shifts/admin/${id}`);
      setShifts(prev => prev.filter(s => s.id !== id));
      if (editingId === id) setEditingId(null);
    } finally { setDeleting(null); }
  };

  const cancelSeries = async groupId => {
    setDeleting(groupId);
    try {
      const r = await api.delete(`/shifts/admin/series/${groupId}`);
      const today = toISO(new Date());
      setShifts(prev => prev.filter(s => !(s.recurrence_group_id === groupId && s.shift_date >= today)));
      setEditingId(null);
      toast(t.shiftsCancelled.replace('{n}', r.data.deleted), 'success');
    } catch { toast(t.failedSaveShift, 'error'); }
    finally { setDeleting(null); }
  };

  const duplicateShift = async s => {
    try {
      const r = await api.post('/shifts/admin', {
        user_id: s.user_id,
        project_id: s.project_id || '',
        shift_date: s.shift_date.substring(0, 10),
        start_time: s.start_time.substring(0, 5),
        end_time: s.end_time.substring(0, 5),
        notes: s.notes || '',
      });
      setShifts(prev => [...prev, r.data].sort((a, b) => a.shift_date.localeCompare(b.shift_date) || a.start_time.localeCompare(b.start_time)));
      toast(t.shiftDuplicated, 'success');
    } catch {
      toast(t.failedDuplicateShift, 'error');
    }
  };

  const startEdit = s => {
    setEditingId(s.id);
    setEditForm({
      project_id: s.project_id || '',
      shift_date: s.shift_date.substring(0, 10),
      start_time: s.start_time.substring(0, 5),
      end_time: s.end_time.substring(0, 5),
      notes: s.notes || '',
      updated_at: s.updated_at,
    });
  };

  const saveEdit = async id => {
    setEditSaving(true);
    try {
      const r = await api.patch(`/shifts/admin/${id}`, editForm);
      setShifts(prev => prev.map(s => s.id === id ? r.data : s));
      setEditingId(null);
    } catch (err) {
      const msg = err.response?.status === 409
        ? t.concurrentModification
        : err.response?.data?.error || 'Failed to update shift';
      toast(msg, 'error');
    } finally { setEditSaving(false); }
  };

  const handleDragStart = ({ active }) => {
    setActiveShift(shifts.find(s => String(s.id) === active.id) || null);
    setEditingId(null);
  };

  const handleDragEnd = ({ active, over }) => {
    setActiveShift(null);
    if (!over || !dragMode) return;
    const shiftId = parseInt(active.id);
    const shift = shifts.find(s => s.id === shiftId);
    if (!shift) return;
    const currentDate = shift.shift_date.substring(0, 10);
    const newDate = over.id;
    if (currentDate === newDate) return;

    // Local-only update — no API call until Save
    setShifts(prev => prev.map(s => s.id === shiftId ? { ...s, shift_date: newDate } : s));
    setPendingMoves(prev => ({ ...prev, [shiftId]: newDate }));
  };

  const shiftsByDay = useMemo(() => {
    const map = {};
    days.forEach(d => { map[toISO(d)] = []; });
    shifts.forEach(s => {
      const key = s.shift_date.substring(0, 10);
      if (map[key]) map[key].push(s);
    });
    return map;
  }, [shifts, days]);

  const shiftProps = { editingId, startEdit, setEditingId, dragMode };
  const editingShift = useMemo(() => editingId ? shifts.find(s => s.id === editingId) : null, [editingId, shifts]);

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>{t.schedule}</h3>

      <form onSubmit={addShift} style={styles.form}>
        <div style={styles.formRow}>
          <div style={styles.field}>
            <label htmlFor="ms-worker" style={styles.label}>{workerLabel}</label>
            <select id="ms-worker" style={styles.input} value={form.user_id} onChange={e => set('user_id', e.target.value)} required>
              <option value="">{`Select ${workerLabelLower}`}</option>
              {workers.map(w => <option key={w.id} value={w.id}>{w.full_name}</option>)}
            </select>
          </div>
          <div style={styles.field}>
            <label htmlFor="ms-project" style={styles.label}>{workLabel}</label>
            <select id="ms-project" style={styles.input} value={form.project_id} onChange={e => set('project_id', e.target.value)}>
              <option value="">{`No ${workLabelLower}`}</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div style={styles.field}>
            <label htmlFor="ms-date" style={styles.label}>{t.date}</label>
            <input id="ms-date" style={styles.input} type="date" value={form.shift_date} onChange={e => set('shift_date', e.target.value)} required />
          </div>
          <div style={styles.field}>
            <label htmlFor="ms-start" style={styles.label}>{t.start}</label>
            <input id="ms-start" style={styles.input} type="time" value={form.start_time} onChange={e => set('start_time', e.target.value)} required />
          </div>
          <div style={styles.field}>
            <label htmlFor="ms-end" style={styles.label}>{t.end}</label>
            <input id="ms-end" style={styles.input} type="time" value={form.end_time} onChange={e => set('end_time', e.target.value)} required />
          </div>
          <div style={{ ...styles.field, flex: 2 }}>
            <label htmlFor="ms-notes" style={styles.label}>{t.notes}</label>
            <input id="ms-notes" style={styles.input} type="text" value={form.notes} onChange={e => set('notes', e.target.value)} placeholder={t.optional} maxLength={500} />
          </div>
          <div style={styles.field}>
            <label htmlFor="ms-repeat" style={styles.label}>{t.msRepeat}</label>
            <select id="ms-repeat" style={styles.input} value={form.repeat} onChange={e => set('repeat', e.target.value)}>
              <option value="none">{t.msRepeatNone}</option>
              <option value="weekly-4">{t.msRepeatWeekly4}</option>
              <option value="biweekly-4">{t.msRepeatBiweekly4}</option>
              <option value="monthly-3">{t.msRepeatMonthly3}</option>
            </select>
          </div>
          <div style={styles.field}>
            <label style={styles.label}>&nbsp;</label>
            <button style={{ ...styles.addBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={saving}>{saving ? t.saving : t.addShift}</button>
          </div>
        </div>
        {availabilityWarning && <p style={styles.overlapWarning}>📅 {availabilityWarning}</p>}
        {overlapWarning && <p style={styles.overlapWarning}>⚠ {overlapWarning}</p>}
        {error && <p role="alert" style={styles.error}>{error}</p>}
      </form>

      <div style={styles.weekNav}>
        <button style={styles.navBtn} onClick={() => setWeekStart(d => addDays(d, -7))}>{t.prevWeek}</button>
        <span style={styles.weekLabel}>{fmtDay(days[0], locale)} – {fmtDay(days[6], locale)}</span>
        <button style={styles.navBtn} onClick={() => setWeekStart(d => addDays(d, 7))}>{t.nextWeek}</button>
        <button style={styles.todayBtn} onClick={() => setWeekStart(startOfWeekFor(new Date(), companyWeekStart))}>{t.today}</button>
        <button style={styles.exportBtn} onClick={() => exportCSV(shifts, days, workerLabel, workLabel)} title={t.exportWeekCSV}>⬇ CSV</button>
        {shifts.length > 0 && (
          <button style={{ ...styles.copyWeekBtn, ...(copyingWeek ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={copyWeek} disabled={copyingWeek} title={t.msCopyWeek}>
            {copyingWeek ? t.msCopying : '⧉ ' + t.msCopyWeek}
          </button>
        )}
        <div style={styles.viewToggle}>
          <button style={{ ...styles.viewBtn, ...(viewMode === 'grid' ? styles.viewBtnActive : {}) }} onClick={() => setViewMode('grid')}>{t.msViewGrid}</button>
          <button style={{ ...styles.viewBtn, ...(viewMode === 'summary' ? styles.viewBtnActive : {}) }} onClick={() => setViewMode('summary')}>{t.msViewSummary}</button>
        </div>
        {!dragMode
          ? <button style={styles.dragModeBtn} onClick={enterDragMode}>{t.rearrange}</button>
          : (
            <div style={styles.dragModeBanner}>
              <span style={styles.dragModeLabel}>
                {t.dragMode}{Object.keys(pendingMoves).length > 0 ? ` · ${Object.keys(pendingMoves).length} unsaved` : ''}
              </span>
              <button style={{ ...styles.saveDragBtn, ...((savingMoves || Object.keys(pendingMoves).length === 0) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={saveDragMoves} disabled={savingMoves || Object.keys(pendingMoves).length === 0}>
                {savingMoves ? t.saving : t.saveAndNotify}
              </button>
              <button style={{ ...styles.discardDragBtn, ...(savingMoves ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={discardDrag} disabled={savingMoves}>{t.discard}</button>
            </div>
          )
        }
      </div>

      {loading ? <SkeletonList count={4} rows={2} /> : viewMode === 'summary' ? (
        <SummaryView shifts={shifts} days={days} workerLabel={workerLabel} />
      ) : (
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div style={styles.grid}>
            {days.map(day => {
              const key = toISO(day);
              const dayShifts = shiftsByDay[key] || [];
              const isToday = key === toISO(new Date());
              return (
                <DroppableDay key={key} date={key} isToday={isToday}>
                  <div style={{ ...styles.dayHead, color: isToday ? 'var(--ops-page-accent)' : '#374151' }}>
                    {day.toLocaleDateString(locale, { weekday: 'short' })} {day.getDate()}
                  </div>
                  {dayShifts.length === 0
                    ? <div style={styles.emptyDay} />
                    : dayShifts.map(s => <DraggableShift key={s.id} s={s} {...shiftProps} />)
                  }
                </DroppableDay>
              );
            })}
          </div>

          <DragOverlay dropAnimation={null}>
            {activeShift && (
              <div style={{ ...styles.shiftPill, boxShadow: '0 8px 24px rgba(0,0,0,0.18)', cursor: 'grabbing', opacity: 0.95 }}>
                <PillContent s={activeShift} />
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {editingShift && (
        <div style={styles.editPanel}>
          <div style={styles.editPanelHeader}>
            <span style={styles.editPanelTitle}>Editing: {editingShift.worker_name} · {fmtDay(new Date(editingShift.shift_date + 'T00:00:00'), locale)}</span>
          </div>
          <div style={styles.editGrid}>
            <div style={styles.editField}>
              <label htmlFor="ms-edit-date" style={styles.editLabel}>{t.date}</label>
              <input id="ms-edit-date" style={styles.editInput} type="date" value={editForm.shift_date} onChange={ev => setEditForm(f => ({ ...f, shift_date: ev.target.value }))} />
            </div>
            <div style={styles.editField}>
              <label htmlFor="ms-edit-start" style={styles.editLabel}>{t.start}</label>
              <input id="ms-edit-start" style={styles.editInput} type="time" value={editForm.start_time} onChange={ev => setEditForm(f => ({ ...f, start_time: ev.target.value }))} />
            </div>
            <div style={styles.editField}>
              <label htmlFor="ms-edit-end" style={styles.editLabel}>{t.end}</label>
              <input id="ms-edit-end" style={styles.editInput} type="time" value={editForm.end_time} onChange={ev => setEditForm(f => ({ ...f, end_time: ev.target.value }))} />
            </div>
            <div style={styles.editField}>
              <label htmlFor="ms-edit-project" style={styles.editLabel}>{workLabel}</label>
              <select id="ms-edit-project" style={styles.editInput} value={editForm.project_id} onChange={ev => setEditForm(f => ({ ...f, project_id: ev.target.value }))}>
                <option value="">{`No ${workLabelLower}`}</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div style={{ ...styles.editField, flex: 2 }}>
              <label htmlFor="ms-edit-notes" style={styles.editLabel}>{t.notes}</label>
              <input id="ms-edit-notes" style={styles.editInput} type="text" value={editForm.notes} onChange={ev => setEditForm(f => ({ ...f, notes: ev.target.value }))} placeholder={t.optional} maxLength={500} />
            </div>
          </div>
          <div style={styles.editActions}>
            <div style={styles.editActionsLeft}>
              <button style={{ ...styles.saveBtn, ...(editSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => saveEdit(editingShift.id)} disabled={editSaving}>{editSaving ? t.saving : t.save}</button>
              <button style={styles.cancelBtn} onClick={() => setEditingId(null)}>{t.cancel}</button>
            </div>
            <div style={styles.editActionsRight}>
              <button style={styles.dupBtn} onClick={() => duplicateShift(editingShift)}>{t.copy}</button>
              {editingShift.recurrence_group_id && (
                <button style={{ ...styles.seriesBtn, ...(deleting === editingShift.recurrence_group_id ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => cancelSeries(editingShift.recurrence_group_id)} disabled={deleting === editingShift.recurrence_group_id}>
                  {deleting === editingShift.recurrence_group_id ? t.saving : t.msCancelSeries}
                </button>
              )}
              <button style={{ ...styles.deleteBtn, ...(deleting === editingShift.id ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => deleteShift(editingShift.id)} disabled={deleting === editingShift.id}>
                {deleting === editingShift.id ? t.saving : t.del}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 24 },
  title: { fontSize: 17, fontWeight: 700, marginBottom: 16 },
  form: { marginBottom: 16 },
  formRow: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' },
  field: { display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 100 },
  label: { fontSize: 11, fontWeight: 600, color: '#555', textTransform: 'uppercase' },
  input: { padding: '7px 9px', border: '1px solid #ddd', borderRadius: 6, fontSize: 13 },
  addBtn: { padding: '7px 14px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' },
  error: { color: '#e53e3e', fontSize: 13, marginTop: 4 },
  overlapWarning: { color: '#d97706', fontSize: 13, marginTop: 4, background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 6, padding: '5px 10px' },
  copyWeekBtn: { background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: '#6b7280', whiteSpace: 'nowrap' },
  weekNav: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' },
  navBtn: { background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 10px', fontSize: 13, cursor: 'pointer', color: '#374151' },
  weekLabel: { fontWeight: 600, fontSize: 14, color: '#111827', flex: 1 },
  todayBtn: { background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: '#6b7280' },
  dragModeBtn: { background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#374151' },
  dragModeBanner: { display: 'flex', alignItems: 'center', gap: 8, background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, padding: '5px 12px' },
  dragModeLabel: { fontSize: 12, fontWeight: 600, color: '#92400e', flex: 1 },
  saveDragBtn: { background: '#059669', color: '#fff', border: 'none', borderRadius: 6, padding: '5px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  discardDragBtn: { background: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '5px 12px', fontSize: 12, cursor: 'pointer', color: '#6b7280' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, overflowX: 'auto' },
  dayCol: { padding: '8px 6px', minHeight: 80, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 90 },
  dayHead: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 },
  emptyDay: { flex: 1, background: '#f9fafb', borderRadius: 4, minHeight: 40 },
  shiftPill: { background: '#eff6ff', borderLeft: '3px solid var(--ops-page-accent)', borderRadius: 5, padding: '5px 7px', fontSize: 11 },
  pillWorker: { fontWeight: 700, color: '#1e3a5f', marginBottom: 1, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  pillCantBadge: { fontSize: 9, fontWeight: 700, color: '#dc2626', background: '#fee2e2', padding: '1px 5px', borderRadius: 4, whiteSpace: 'nowrap' },
  pillCantNote: { fontSize: 9, color: '#dc2626', fontStyle: 'italic', marginTop: 1 },
  pillProject: { color: '#6b7280', fontSize: 10 },
  pillTime: { fontWeight: 600, color: 'var(--ops-page-accent)', marginTop: 2 },
  pillNotes: { color: '#6b7280', fontSize: 10, fontStyle: 'italic' },
  shiftPillActive: { background: '#dbeafe', borderLeftColor: '#1d4ed8' },
  shiftPillCant: { background: '#fff5f5', borderLeftColor: '#ef4444' },
  pillActions: { display: 'flex', gap: 4, marginTop: 6 },
  editPillBtn: { flex: 1, background: '#dbeafe', border: 'none', color: '#1d4ed8', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '4px 9px', borderRadius: 5, lineHeight: 1 },
  editPillBtnActive: { flex: 1, background: '#bfdbfe', border: 'none', color: '#1e40af', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '4px 9px', borderRadius: 5, lineHeight: 1 },
  editPanel: { background: '#f8faff', border: '1px solid #dbeafe', borderRadius: 8, padding: 16, marginTop: 16 },
  editPanelHeader: { marginBottom: 12 },
  editPanelTitle: { fontSize: 13, fontWeight: 700, color: '#1e3a5f' },
  editGrid: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 },
  editField: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 100 },
  editLabel: { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' },
  editInput: { padding: '7px 9px', border: '1px solid #ddd', borderRadius: 6, fontSize: 13 },
  editActions: { display: 'flex', justifyContent: 'space-between', gap: 8 },
  editActionsLeft: { display: 'flex', gap: 8 },
  editActionsRight: { display: 'flex', gap: 8 },
  saveBtn: { background: '#059669', color: '#fff', border: 'none', padding: '7px 18px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  cancelBtn: { background: 'none', border: '1px solid #d1d5db', color: '#6b7280', padding: '7px 18px', borderRadius: 6, fontSize: 13, cursor: 'pointer' },
  dupBtn: { background: '#d1fae5', border: 'none', color: '#065f46', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '7px 16px', borderRadius: 6 },
  seriesBtn: { background: '#fef3c7', border: 'none', color: '#92400e', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '7px 16px', borderRadius: 6 },
  deleteBtn: { background: '#fee2e2', border: 'none', color: '#b91c1c', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '7px 16px', borderRadius: 6 },
  viewToggle: { display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #d1d5db' },
  viewBtn: { background: '#fff', border: 'none', padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#374151' },
  viewBtnActive: { background: 'var(--ops-page-accent)', color: '#fff' },
  summaryWrap: { overflowX: 'auto', WebkitOverflowScrolling: 'touch' },
  summaryTable: { borderCollapse: 'collapse', fontSize: 12, minWidth: 520 },
  summaryThWorker: { textAlign: 'left', padding: '6px 10px', fontWeight: 700, color: '#374151', borderBottom: '2px solid #e5e7eb', minWidth: 100, maxWidth: 140 },
  summaryTh: { textAlign: 'center', padding: '6px 4px', fontWeight: 700, borderBottom: '2px solid #e5e7eb', minWidth: 60 },
  summaryThTotal: { textAlign: 'center', padding: '6px 8px', fontWeight: 700, color: '#374151', borderBottom: '2px solid #e5e7eb', width: 40 },
  summaryTdWorker: { padding: '8px 10px', fontWeight: 700, color: '#111827', borderBottom: '1px solid #f3f4f6', verticalAlign: 'top', whiteSpace: 'nowrap', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' },
  summaryTd: { padding: '4px', borderBottom: '1px solid #f3f4f6', verticalAlign: 'top', textAlign: 'center' },
  summaryTdTotal: { padding: '8px', borderBottom: '1px solid #f3f4f6', textAlign: 'center', fontWeight: 700, color: '#374151' },
  summaryEmpty: { color: '#d1d5db' },
  summaryShift: { background: '#eff6ff', color: '#1e3a5f', borderRadius: 4, padding: '3px 4px', marginBottom: 2, fontWeight: 600, lineHeight: 1.3, whiteSpace: 'nowrap' },
  summaryShiftCant: { background: '#fff5f5', color: '#b91c1c' },
  summaryProject: { fontSize: 10, fontWeight: 400, color: '#6b7280', marginTop: 1 },
  summaryRowCant: { background: '#fff9f9' },
  summaryCantDot: { marginLeft: 5, fontSize: 10, color: '#dc2626', fontWeight: 700 },
  cantOnlyToggle: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: '#dc2626', marginBottom: 10, cursor: 'pointer' },
  exportBtn: { background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: '#6b7280' },
  summaryCantNote: { fontSize: 9, color: '#b91c1c', fontStyle: 'italic', marginTop: 2 },
};
