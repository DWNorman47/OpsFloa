// Project scheduler — the visual work-calendar behind Project Daily. Mark which dates a
// project is worked; the Nth worked date is labeled Day N, and each worked date shows the
// checklists that run then (every-day + Day-N + date-pinned). Add a checklist to a date
// from the detail panel. Month/Week toggle. Foundation for future planner rows.
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import AssignmentCard from './AssignmentCard';
import { useDragReorder } from '../hooks/useDragReorder';

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = d => addDays(d, -d.getDay()); // Sunday-start
const sameYmd = (a, b) => ymd(a) === b;

// Which assigned checklists run on a worked date (day number dn).
function checklistsForDate(assignments, dateStr, dn) {
  return assignments.filter(a =>
    a.schedule_type === 'every' ||
    (a.schedule_type === 'ordinal' && dn != null && Number(a.ordinal_target) === dn) ||
    (a.schedule_type === 'date' && (a.scheduled_date || '').slice(0, 10) === dateStr)
  );
}

export default function ProjectScheduler({ projectId, assignments = [], templates = [], roles = [], onReorder, onAssignmentAdded }) {
  const t = useT();
  const [viewMode, setViewMode] = useState('week'); // 'week' | 'month'
  const [anchor, setAnchor] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });
  const [workDays, setWorkDays] = useState({}); // { 'YYYY-MM-DD': dayNumber }
  const [selected, setSelected] = useState(null); // 'YYYY-MM-DD'
  const [selChecklistId, setSelChecklistId] = useState(null); // assignment selected for item preview
  const [addTemplateId, setAddTemplateId] = useState('');
  const [error, setError] = useState('');

  const itemsByTemplate = useMemo(
    () => Object.fromEntries(templates.map(tp => [tp.id, Array.isArray(tp.items) ? tp.items : []])),
    [templates]
  );

  // The visible grid of dates.
  const gridDays = useMemo(() => {
    if (viewMode === 'week') {
      const start = startOfWeek(anchor);
      return Array.from({ length: 7 }, (_, i) => addDays(start, i));
    }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const start = startOfWeek(first);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i)); // 6 weeks
  }, [viewMode, anchor]);

  const loadWorkDays = useCallback(async () => {
    if (!projectId || gridDays.length === 0) return;
    const from = ymd(gridDays[0]);
    const to = ymd(gridDays[gridDays.length - 1]);
    try {
      const r = await api.get(`/daily-checklist/projects/${projectId}/work-days`, { params: { from, to } });
      const map = {};
      (r.data.days || []).forEach(d => { map[d.work_date] = d.day_number; });
      setWorkDays(map);
    } catch { setWorkDays({}); }
  }, [projectId, gridDays]);

  useEffect(() => { loadWorkDays(); }, [loadWorkDays]);
  useEffect(() => { setSelChecklistId(null); }, [selected]); // drop the item preview when the date changes

  const toggleWorked = async (dateStr, worked) => {
    setError('');
    // Optimistic: flip presence; day numbers get corrected by the reload.
    setWorkDays(prev => {
      const next = { ...prev };
      if (worked) next[dateStr] = next[dateStr] || 0; else delete next[dateStr];
      return next;
    });
    try {
      await api.put(`/daily-checklist/projects/${projectId}/work-days`, { work_date: dateStr, worked });
      await loadWorkDays(); // day numbers shift when a date is added/removed
    } catch (err) { setError(err.response?.data?.error || t.failedToSave); loadWorkDays(); }
  };

  const addChecklistToDate = async (dateStr) => {
    if (!addTemplateId) return;
    setError('');
    try {
      await api.post('/daily-checklist/assignments', {
        template_id: Number(addTemplateId), project_id: projectId,
        schedule_type: 'date', scheduled_date: dateStr,
      });
      setAddTemplateId('');
      onAssignmentAdded?.();
    } catch (err) { setError(err.response?.data?.error || t.failedToSave); }
  };

  const shiftPeriod = (dir) => setAnchor(prev => viewMode === 'week'
    ? addDays(prev, dir * 7)
    : new Date(prev.getFullYear(), prev.getMonth() + dir, 1));
  const goToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); setAnchor(d); };

  const todayStr = ymd(new Date());
  const label = viewMode === 'week'
    ? `${gridDays[0].toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${gridDays[6].toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
    : anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const weekdays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(new Date()), i).toLocaleDateString(undefined, { weekday: 'short' })), []);

  const selDn = selected ? (workDays[selected] ?? null) : null;
  const selChecklists = selected && selDn != null ? checklistsForDate(assignments, selected, selDn) : [];
  const selChecklist = selChecklistId ? selChecklists.find(a => a.id === selChecklistId) : null;
  const selItems = selChecklist ? (itemsByTemplate[selChecklist.template_id] || []) : null;

  // Drag-reorder within the day: rebuild the global order so the day's checklists follow
  // the new drag order while every other assignment keeps its position, then hand it to the
  // parent (which reorders optimistically + shows Saving…), so the drop feels instant.
  const reorderDay = (from, to) => {
    if (from == null || to == null || from === to) return;
    const dayIds = selChecklists.map(a => a.id);
    const [moved] = dayIds.splice(from, 1);
    dayIds.splice(to, 0, moved);
    const daySet = new Set(dayIds);
    let k = 0;
    const orderIds = assignments.map(a => a.id).map(id => (daySet.has(id) ? dayIds[k++] : id));
    onReorder?.(orderIds);
  };
  const dnd = useDragReorder(reorderDay);

  const patchAssignment = async (id, body) => {
    try { await api.patch(`/daily-checklist/assignments/${id}`, body); onAssignmentAdded?.(); }
    catch (err) { setError(err.response?.data?.error || t.failedToSave); }
  };
  const removeAssignment = async (id) => {
    try { await api.delete(`/daily-checklist/assignments/${id}`); setSelChecklistId(null); onAssignmentAdded?.(); }
    catch (err) { setError(err.response?.data?.error || t.failedToSave); }
  };

  return (
    <div>
      <div style={styles.toolbar}>
        <div style={styles.navGroup}>
          <button style={styles.navBtn} onClick={() => shiftPeriod(-1)}>‹ {t.pdPrev}</button>
          <span style={styles.periodLabel}>{label}</span>
          <button style={styles.navBtn} onClick={() => shiftPeriod(1)}>{t.pdNext} ›</button>
          <button style={styles.todayBtn} onClick={goToday}>{t.pdToday}</button>
        </div>
        <div style={styles.viewToggle}>
          {['month', 'week'].map(m => (
            <button key={m} style={{ ...styles.viewBtn, ...(viewMode === m ? styles.viewBtnOn : {}) }} onClick={() => setViewMode(m)}>
              {m === 'month' ? t.pdMonth : t.pdWeek}
            </button>
          ))}
        </div>
      </div>

      {error && <p role="alert" style={styles.error}>{error}</p>}

      <div style={styles.weekdayRow}>
        {weekdays.map(w => <div key={w} style={styles.weekdayCell}>{w}</div>)}
      </div>
      <div style={styles.grid}>
        {gridDays.map(d => {
          const dateStr = ymd(d);
          const inMonth = viewMode === 'week' || d.getMonth() === anchor.getMonth();
          const dn = workDays[dateStr];
          const worked = dn !== undefined;
          const lists = worked ? checklistsForDate(assignments, dateStr, dn) : [];
          const isToday = dateStr === todayStr;
          const isSel = dateStr === selected;
          return (
            <div
              key={dateStr}
              style={{ ...styles.cell, ...(worked ? styles.cellWorked : {}), ...(isSel ? styles.cellSel : {}), ...(inMonth ? {} : styles.cellOut) }}
              onClick={() => setSelected(dateStr)}
            >
              <div style={styles.cellTop}>
                <span style={{ ...styles.cellDate, ...(isToday ? styles.cellToday : {}) }}>{d.getDate()}</span>
                <input
                  type="checkbox"
                  checked={worked}
                  onClick={e => e.stopPropagation()}
                  onChange={e => toggleWorked(dateStr, e.target.checked)}
                  title={t.pdWorkedDay}
                  style={styles.workChk}
                />
              </div>
              {worked && <div style={styles.dayNum}>{t.pdDayN.replace('{n}', dn)}</div>}
              {lists.slice(0, 3).map(a => <div key={a.id} style={styles.listChip}>{a.template_name}</div>)}
              {lists.length > 3 && <div style={styles.moreChip}>+{lists.length - 3}</div>}
            </div>
          );
        })}
      </div>

      {selected && (
        <div style={styles.detail}>
          <div style={styles.detailHead}>
            <div>
              <div style={styles.detailDate}>{parseYmd(selected).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
              <div style={styles.detailSub}>{selDn != null ? t.pdDayN.replace('{n}', selDn) : t.pdNotWorked}</div>
            </div>
            <label style={styles.detailToggle}>
              <input type="checkbox" checked={selDn != null} onChange={e => toggleWorked(selected, e.target.checked)} />
              {t.pdWorkedDay}
            </label>
          </div>

          {selDn != null && (
            <>
              <div style={styles.detailLabel}>{t.pdRunsThisDay}</div>
              {selChecklists.length === 0 ? (
                <p style={styles.detailEmpty}>{t.pdNoneThisDay}</p>
              ) : (
                <div style={styles.detailList}>
                  {selChecklists.map((a, i) => (
                    <div
                      key={a.id}
                      draggable
                      {...dnd.dragProps(i)}
                      style={{ ...styles.detailItem, ...(a.id === selChecklistId ? styles.detailItemSel : {}), ...(dnd.isOver(i) ? styles.detailItemDrop : {}) }}
                      onClick={() => setSelChecklistId(id => (id === a.id ? null : a.id))}
                    >
                      <span style={styles.dragHandle} title={t.pdDrag} aria-hidden="true">⠿</span>
                      <span style={styles.detailItemName}>{a.template_name}</span>
                      <span style={styles.detailItemTag}>
                        {a.schedule_type === 'every' ? t.pdSchedEvery
                          : a.schedule_type === 'ordinal' ? t.pdSchedOrdinal.replace('#', a.ordinal_target)
                          : t.pdSchedDate}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {selChecklist && (
                <div style={{ marginTop: 14 }}>
                  <AssignmentCard
                    a={selChecklist}
                    roles={roles}
                    items={selItems || []}
                    onPatch={patchAssignment}
                    onRemove={removeAssignment}
                  />
                </div>
              )}
              {templates.length > 0 && (
                <div style={styles.addBar}>
                  <select style={styles.addSelect} value={addTemplateId} onChange={e => setAddTemplateId(e.target.value)}>
                    <option value="">{t.pdPickChecklist}</option>
                    {templates.map(tp => <option key={tp.id} value={tp.id}>{tp.name}</option>)}
                  </select>
                  <button style={{ ...styles.addBtn, ...(addTemplateId ? {} : { opacity: 0.55, cursor: 'not-allowed' }) }} onClick={() => addChecklistToDate(selected)} disabled={!addTemplateId}>
                    + {t.pdAddToDate}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 },
  navGroup: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  navBtn: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 600, color: '#374151', cursor: 'pointer' },
  todayBtn: { background: 'none', border: 'none', color: '#6b7280', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  periodLabel: { fontSize: 15, fontWeight: 800, color: '#111827', minWidth: 140 },
  viewToggle: { display: 'inline-flex', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' },
  viewBtn: { border: 'none', background: '#fff', color: '#6b7280', padding: '7px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  viewBtnOn: { background: '#2563eb', color: '#fff' },
  weekdayRow: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, marginBottom: 6 },
  weekdayCell: { fontSize: 11, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.04em', textAlign: 'center' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 },
  cell: { minHeight: 84, border: '1px solid #eef2f7', borderRadius: 8, background: '#fff', padding: 6, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 3, overflow: 'hidden' },
  cellWorked: { background: '#ecfdf5', borderColor: '#a7f3d0' },
  cellSel: { boxShadow: '0 0 0 2px #2563eb', borderColor: '#2563eb' },
  cellOut: { opacity: 0.4 },
  cellTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  cellDate: { fontSize: 13, fontWeight: 700, color: '#374151' },
  cellToday: { background: '#2563eb', color: '#fff', borderRadius: 10, padding: '0 6px' },
  workChk: { cursor: 'pointer', accentColor: '#059669' },
  dayNum: { fontSize: 10, fontWeight: 800, color: '#065f46', textTransform: 'uppercase', letterSpacing: '0.03em' },
  listChip: { fontSize: 11, color: '#1d4ed8', background: '#eff6ff', borderRadius: 5, padding: '1px 5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  moreChip: { fontSize: 10, color: '#6b7280' },
  detail: { marginTop: 16, background: '#fff', border: '1px solid #eef2f7', borderRadius: 10, padding: 16 },
  detailHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  detailDate: { fontSize: 15, fontWeight: 800, color: '#111827' },
  detailSub: { fontSize: 12, fontWeight: 700, color: '#065f46', marginTop: 2 },
  detailToggle: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: '#374151', cursor: 'pointer' },
  detailLabel: { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '14px 0 6px' },
  detailEmpty: { fontSize: 13, color: '#9ca3af', fontStyle: 'italic', margin: 0 },
  detailList: { display: 'flex', flexDirection: 'column', gap: 6 },
  detailItem: { display: 'flex', alignItems: 'center', gap: 10, background: '#f9fafb', border: '1px solid #eef2f7', borderRadius: 7, padding: '7px 10px', cursor: 'pointer' },
  detailItemSel: { borderColor: '#2563eb', boxShadow: '0 0 0 2px #2563eb' },
  detailItemDrop: { boxShadow: '0 0 0 2px #93c5fd' },
  dragHandle: { color: '#9ca3af', fontSize: 15, cursor: 'grab', userSelect: 'none', flexShrink: 0, lineHeight: 1 },
  detailArrows: { display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 },
  detailArrow: { border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', borderRadius: 5, width: 22, height: 16, fontSize: 8, lineHeight: 1, cursor: 'pointer', padding: 0 },
  detailArrowOff: { opacity: 0.35, cursor: 'not-allowed' },
  detailItemName: { fontSize: 13, fontWeight: 600, color: '#111827', flex: 1, minWidth: 0 },
  detailItemTag: { fontSize: 11, fontWeight: 700, color: '#6b7280', flexShrink: 0 },
  checklistPreview: { marginTop: 14, background: '#f9fafb', border: '1px solid #eef2f7', borderRadius: 8, padding: '10px 14px' },
  previewList: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 },
  previewItem: { display: 'flex', alignItems: 'flex-start', gap: 8 },
  previewKind: { fontSize: 13, color: '#9ca3af', flexShrink: 0, marginTop: 1, width: 14, textAlign: 'center' },
  previewLabel: { fontSize: 13, color: '#374151', lineHeight: 1.4 },
  addBar: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  addSelect: { padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: '#fff', minWidth: 200, flex: 1 },
  addBtn: { background: '#059669', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer' },
  error: { color: '#ef4444', fontSize: 13, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', margin: '0 0 10px' },
};
