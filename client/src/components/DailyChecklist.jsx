import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { useToast } from '../contexts/ToastContext';
import { usePerm } from '../hooks/usePerm';
import { SkeletonList } from './Skeleton';

/**
 * Daily Checklist (Field module). Pick a project, start today's checklist, and check items
 * off. Items are assembled server-side from the recurring template plus anything rolled
 * over from the last completed day, on top of a resumed plan's own items. Managers can edit
 * the recurring template, and (Phase 2) run the Day Manager: prepare days ahead on a date
 * or a work-day number, order the queue, and reschedule/pause/delete. See
 * docs/plans/daily-checklist.md.
 */

// Local YYYY-MM-DD — the worker's "today", so the day is dated in their timezone.
const localToday = () => new Date().toLocaleDateString('en-CA');

// Cross-tab, same-origin clipboard for checklist rows (structured), so rows copied in one
// project's day manager paste into another's — even the impersonate new tab. The system
// clipboard gets the plain-text labels too, for pasting elsewhere.
const ROW_CLIP_KEY = 'opsfloa_dc_rows';
const readRowClip = () => { try { const r = JSON.parse(localStorage.getItem(ROW_CLIP_KEY) || 'null'); return Array.isArray(r) ? r : []; } catch { return []; } };

// Structured editor for a template/plan item list. Each row is a checkbox or a text field,
// and can be marked "carryover" — a carryover row is recurring (belongs to the project's
// standing template, shows every day) vs a one-off for the day being prepared. Rows can be
// dragged to reorder, clicked (on the grip) to select, and copied/pasted across projects.
// `items` is [{ text, kind, carryover }]; onChange gets the next array.
function ItemListEditor({ items, onChange, t, toast }) {
  const [selected, setSelected] = useState(() => new Set()); // selected row indices
  const [menu, setMenu] = useState(null); // { x, y } context menu position
  const [dropAt, setDropAt] = useState(null); // insertion index shown while dragging
  const dragFrom = useRef(null);
  const anchor = useRef(null); // last plain-clicked row, for shift-click ranges

  const set = (i, patch) => onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const add = kind => onChange([...items, { text: '', kind, carryover: false }]);
  const remove = i => { onChange(items.filter((_, j) => j !== i)); setSelected(new Set()); anchor.current = null; };
  const toggleSelect = i => setSelected(s => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });

  // Plain click toggles a row (and anchors it); shift-click selects the whole range from the
  // anchor to the clicked row.
  const selectClick = (e, i) => {
    if (e.shiftKey && anchor.current != null) {
      const lo = Math.min(anchor.current, i), hi = Math.max(anchor.current, i);
      setSelected(s => { const n = new Set(s); for (let k = lo; k <= hi; k++) n.add(k); return n; });
    } else {
      toggleSelect(i);
      anchor.current = i;
    }
  };

  // Move the dragged row to an insertion index (0..length, i.e. "before row N").
  const moveTo = (from, insertAt) => {
    if (from == null || insertAt == null) return;
    const idx = insertAt > from ? insertAt - 1 : insertAt;
    if (idx === from) return;
    const next = items.slice();
    const [m] = next.splice(from, 1);
    next.splice(idx, 0, m);
    onChange(next);
    setSelected(new Set()); anchor.current = null; // indices shifted
  };

  const copySelected = () => {
    const rows = [...selected].sort((a, b) => a - b).map(i => items[i]).filter(it => it && it.text.trim())
      .map(it => ({ text: it.text.trim(), kind: it.kind || 'check', carryover: !!it.carryover }));
    if (!rows.length) return;
    try { localStorage.setItem(ROW_CLIP_KEY, JSON.stringify(rows)); } catch { /* private mode */ }
    try { navigator.clipboard?.writeText(rows.map(r => r.text).join('\n')); } catch { /* ignore */ }
    toast(t.dcCopied.replace('{n}', rows.length), 'success');
    setMenu(null);
  };
  const pasteRows = () => {
    const rows = readRowClip();
    if (!rows.length) { toast(t.dcNothingToPaste, 'error'); setMenu(null); return; }
    onChange([...items, ...rows.map(r => ({ text: String(r.text || '').slice(0, 500), kind: r.kind === 'text' ? 'text' : 'check', carryover: !!r.carryover }))]);
    toast(t.dcPasted.replace('{n}', rows.length), 'success');
    setMenu(null);
  };

  // Ctrl/Cmd+C copies the selection, Ctrl/Cmd+V pastes — but only when the focus isn't in a
  // text field (so normal text copy/paste still works while editing a row).
  const onKeyDown = e => {
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (editing || !(e.ctrlKey || e.metaKey)) return;
    if ((e.key === 'c' || e.key === 'C') && selected.size) { e.preventDefault(); copySelected(); }
    else if (e.key === 'v' || e.key === 'V') { e.preventDefault(); pasteRows(); }
  };

  return (
    <div style={styles.editorList} tabIndex={0} onKeyDown={onKeyDown}
      onDragOver={e => { if (dragFrom.current != null) e.preventDefault(); }}
      onDrop={() => { moveTo(dragFrom.current, dropAt); setDropAt(null); }}>
      {items.map((it, i) => (
        <React.Fragment key={i}>
          {dropAt === i && dragFrom.current != null && <div style={styles.dropLine} />}
          <div style={{ ...styles.editorRow, ...(selected.has(i) ? styles.editorRowSel : {}) }}
            onDragOver={e => { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); setDropAt(e.clientY > r.top + r.height / 2 ? i + 1 : i); }}
            onContextMenu={e => { e.preventDefault(); if (!selected.has(i)) toggleSelect(i); setMenu({ x: e.clientX, y: e.clientY }); }}>
            <span style={styles.dragHandle} title={t.dcRowHint} role="button" tabIndex={0} aria-pressed={selected.has(i)}
              draggable onDragStart={e => { dragFrom.current = i; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(i)); } catch { /* ignore */ } }}
              onDragEnd={() => { dragFrom.current = null; setDropAt(null); }}
              onClick={e => selectClick(e, i)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSelect(i); anchor.current = i; } }}>⋮⋮</span>
          <select style={styles.kindSelect} value={it.kind || 'check'} onChange={e => set(i, { kind: e.target.value })}>
            <option value="check">{t.dcKindCheck}</option>
            <option value="text">{t.dcKindText}</option>
          </select>
          <input style={styles.editorInput} value={it.text}
            placeholder={it.kind === 'text' ? t.dcTextLabelPlaceholder : t.dcItemPlaceholder}
            onChange={e => set(i, { text: e.target.value })} />
          <button type="button" title={t.dcCarryoverHint} aria-pressed={!!it.carryover}
            style={{ ...styles.carryBtn, ...(it.carryover ? styles.carryBtnOn : {}) }}
            onClick={() => set(i, { carryover: !it.carryover })}>
            {t.dcCarryover}
          </button>
            <button type="button" style={styles.editorRemoveBtn} onClick={() => remove(i)} aria-label={t.dcRemove}>×</button>
          </div>
        </React.Fragment>
      ))}
      {dropAt === items.length && dragFrom.current != null && <div style={styles.dropLine} />}
      <div style={styles.editorAdd}
        onDragOver={e => { e.preventDefault(); setDropAt(items.length); }}
        onDrop={() => { moveTo(dragFrom.current, dropAt); setDropAt(null); }}>
        <button type="button" style={styles.addItemBtn} onClick={() => add('check')}>+ {t.dcKindCheck}</button>
        <button type="button" style={styles.addItemBtn} onClick={() => add('text')}>+ {t.dcKindText}</button>
        <button type="button" style={styles.addItemBtn} onClick={pasteRows}>{t.dcPaste}</button>
      </div>
      {menu && (
        <>
          <div style={styles.menuScrim} onClick={() => setMenu(null)} onContextMenu={e => { e.preventDefault(); setMenu(null); }} />
          <div style={{ ...styles.ctxMenu, top: menu.y, left: menu.x }}>
            <button type="button" style={{ ...styles.ctxItem, ...(selected.size ? {} : styles.ctxItemOff) }} onClick={copySelected} disabled={!selected.size}>{t.dcCopy} ({selected.size})</button>
            <button type="button" style={styles.ctxItem} onClick={pasteRows}>{t.dcPaste}</button>
          </div>
        </>
      )}
    </div>
  );
}
// carryover: force the flag (true for recurring rows loaded from the template); else honor
// the row's own flag. Save keeps the flag so the server can split recurring vs one-off.
const toEditRows = (rows, carryover = false) => (rows || []).map(i => ({ text: i.text, kind: i.kind || 'check', carryover: i.carryover === true || carryover }));
const toSaveRows = rows => rows.filter(it => it.text.trim()).map(it => ({ text: it.text.trim(), kind: it.kind || 'check', carryover: !!it.carryover }));

// One prepared day in the queue — inline reschedule / edit-items / reorder / delete.
function QueueRow({ day, t, toast, first, last, onChanged, recurring }) {
  const [editing, setEditing] = useState(null); // 'items' | 'when' | null
  const [itemsArr, setItemsArr] = useState([]);
  const [when, setWhen] = useState({ schedule_type: day.schedule_type, scheduled_date: day.scheduled_date || localToday(), ordinal_target: day.ordinal_target || 1 });

  const openItems = async () => {
    try {
      const r = await api.get(`/daily-checklist/days/${day.id}`);
      // Show the project's recurring items (carryover) above this day's own one-offs.
      setItemsArr([...(recurring || []), ...toEditRows(r.data.items, false)]);
      setEditing('items');
    } catch { toast(t.dcLoadFailed, 'error'); }
  };
  const saveItems = async () => {
    try { await api.put(`/daily-checklist/days/${day.id}/plan-items`, { items: toSaveRows(itemsArr) }); setEditing(null); onChanged(); }
    catch { toast(t.dcPlanSaveFailed, 'error'); }
  };
  const saveWhen = async () => {
    const body = when.schedule_type === 'calendar'
      ? { schedule_type: 'calendar', scheduled_date: when.scheduled_date }
      : { schedule_type: 'ordinal', ordinal_target: Number(when.ordinal_target) };
    try { await api.patch(`/daily-checklist/days/${day.id}`, body); setEditing(null); onChanged(); }
    catch { toast(t.dcRescheduleFailed, 'error'); }
  };
  const del = async () => {
    try { await api.delete(`/daily-checklist/days/${day.id}`); onChanged(); }
    catch { toast(t.dcDeleteFailed, 'error'); }
  };

  const label = day.schedule_type === 'calendar'
    ? String(day.scheduled_date || '').slice(0, 10)
    : t.dcDayLabel.replace('{n}', day.ordinal_target);

  return (
    <li style={styles.queueRow}>
      <div style={styles.queueMain}>
        <div style={styles.reorder}>
          <button style={styles.reorderBtn} disabled={first} onClick={() => onChanged('up', day.id)} aria-label={t.dcMoveUp}>▲</button>
          <button style={styles.reorderBtn} disabled={last} onClick={() => onChanged('down', day.id)} aria-label={t.dcMoveDown}>▼</button>
        </div>
        <span style={styles.queueLabel}>{label}</span>
        {day.name && <span style={styles.queueName}>{day.name}</span>}
        {day.status === 'paused' && <span style={styles.badgePaused}>{t.dcQueuePaused}</span>}
        <span style={styles.queueCount}>{t.dcItemsCount.replace('{n}', day.item_count)}</span>
        <span style={styles.queueActions}>
          <button style={styles.linkBtnSm} onClick={openItems}>{t.dcEditItems}</button>
          <button style={styles.linkBtnSm} onClick={() => setEditing(editing === 'when' ? null : 'when')}>{t.dcReschedule}</button>
          <button style={styles.linkBtnDanger} onClick={del}>{t.dcDelete}</button>
        </span>
      </div>

      {editing === 'when' && (
        <div style={styles.editBox}>
          <div style={styles.whenRow}>
            <select style={styles.kindSelect} value={when.schedule_type} onChange={e => setWhen(w => ({ ...w, schedule_type: e.target.value }))}>
              <option value="calendar">{t.dcScheduleCalendar}</option>
              <option value="ordinal">{t.dcScheduleOrdinal}</option>
            </select>
            {when.schedule_type === 'calendar'
              ? <input type="date" style={styles.inlineInput} value={when.scheduled_date} onChange={e => setWhen(w => ({ ...w, scheduled_date: e.target.value }))} />
              : <input type="number" min={1} style={styles.inlineNum} value={when.ordinal_target} onChange={e => setWhen(w => ({ ...w, ordinal_target: e.target.value }))} />}
          </div>
          <div style={styles.rowEnd}>
            <button style={styles.linkBtnSm} onClick={() => setEditing(null)}>{t.dcCancel}</button>
            <button style={styles.btn} onClick={saveWhen}>{t.dcSavePlan}</button>
          </div>
        </div>
      )}
      {editing === 'items' && (
        <div style={styles.editBox}>
          <ItemListEditor items={itemsArr} onChange={setItemsArr} t={t} toast={toast} />
          <div style={styles.rowEnd}>
            <button style={styles.linkBtnSm} onClick={() => setEditing(null)}>{t.dcCancel}</button>
            <button style={styles.btn} onClick={saveItems}>{t.dcSavePlan}</button>
          </div>
        </div>
      )}
    </li>
  );
}

export function DayManager({ projectId, t, toast, onQueueChanged }) {
  const [queue, setQueue] = useState(null);
  const [recurring, setRecurring] = useState([]); // recurring template as carryover rows
  const [form, setForm] = useState({ schedule_type: 'ordinal', scheduled_date: localToday(), ordinal_target: 1, name: '', items: null });
  const [saving, setSaving] = useState(false);

  // Load the queue AND the recurring template (shown as carryover rows). Returns the fresh
  // recurring rows so callers can reset the form to them.
  const load = useCallback(async () => {
    try {
      const [q, rec] = await Promise.all([
        api.get(`/daily-checklist/projects/${projectId}/queue`),
        api.get(`/daily-checklist/projects/${projectId}/recurring`),
      ]);
      setQueue(q.data.days || []);
      const recRows = toEditRows(rec.data.items, true);
      setRecurring(recRows);
      // Seed the prepare form with recurring rows the first time (before the user edits it).
      setForm(f => (f.items === null ? { ...f, items: recRows } : f));
      return recRows;
    } catch { toast(t.dcQueueLoadFailed, 'error'); setQueue([]); return []; }
  }, [projectId, t, toast]);
  useEffect(() => { load(); }, [load]); // mount only — does NOT touch the parent

  // After a mutation, reload AND tell the parent to refresh the active view (an edit may
  // have merged items onto the running day).
  const refresh = useCallback(async () => { const r = await load(); onQueueChanged?.(); return r; }, [load, onQueueChanged]);

  const create = async () => {
    setSaving(true);
    const body = {
      schedule_type: form.schedule_type,
      ...(form.schedule_type === 'calendar' ? { scheduled_date: form.scheduled_date } : { ordinal_target: Number(form.ordinal_target) }),
      name: form.name.trim() || undefined,
      items: toSaveRows(form.items || []),
    };
    try {
      await api.post(`/daily-checklist/projects/${projectId}/days`, body);
      const recRows = await refresh();               // reload; recurring may have changed
      setForm(f => ({ ...f, name: '', items: recRows })); // reset to just the recurring rows
    } catch { toast(t.dcPrepareFailed, 'error'); }
    finally { setSaving(false); }
  };

  // onChanged doubles as the reorder handler: (dir, id) moves a row; no args = reload+notify.
  const onChanged = async (dir, id) => {
    if (!dir) return refresh();
    const ids = queue.map(d => d.id);
    const i = ids.indexOf(id);
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setQueue(dir === 'up' ? swap(queue, i, i - 1) : swap(queue, i, i + 1)); // optimistic
    try { await api.post(`/daily-checklist/projects/${projectId}/queue/reorder`, { order: ids }); }
    catch { toast(t.dcReorderFailed, 'error'); load(); }
  };

  return (
    <div style={styles.panel}>
      <div style={styles.prepareGrid}>
        <div style={styles.whenRow}>
          <select style={styles.kindSelect} value={form.schedule_type} onChange={e => setForm(f => ({ ...f, schedule_type: e.target.value }))}>
            <option value="calendar">{t.dcScheduleCalendar}</option>
            <option value="ordinal">{t.dcScheduleOrdinal}</option>
          </select>
          {form.schedule_type === 'calendar'
            ? <input type="date" style={styles.inlineInput} value={form.scheduled_date} onChange={e => setForm(f => ({ ...f, scheduled_date: e.target.value }))} />
            : <input type="number" min={1} style={styles.inlineNum} value={form.ordinal_target} onChange={e => setForm(f => ({ ...f, ordinal_target: e.target.value }))} />}
        </div>
        <input style={styles.addInput} value={form.name} placeholder={t.dcDayNamePlaceholder} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
      </div>
      <ItemListEditor items={form.items || []} onChange={items => setForm(f => ({ ...f, items }))} t={t} toast={toast} />
      <div style={styles.rowEnd}>
        <button style={{ ...styles.btn, ...(saving ? styles.btnOff : {}) }} onClick={create} disabled={saving}>{t.dcCreateDay}</button>
      </div>

      <div style={styles.queueTitle}>{t.dcQueueTitle}</div>
      {queue === null ? <SkeletonList rows={2} />
        : queue.length === 0 ? <p style={styles.empty}>{t.dcQueueEmpty}</p>
          : <ul style={styles.queueList}>
            {queue.map((d, i) => (
              <QueueRow key={d.id} day={d} t={t} toast={toast} first={i === 0} last={i === queue.length - 1} onChanged={onChanged} recurring={recurring} />
            ))}
          </ul>}
    </div>
  );
}
const swap = (arr, i, j) => { const a = arr.slice(); [a[i], a[j]] = [a[j], a[i]]; return a; };

// ── History ────────────────────────────────────────────────────────────────
// Read-only review of a project's COMPLETED days. Each row expands (lazy) to the
// full item breakdown, with who checked each item and when.
export function ChecklistHistory({ projectId, t, toast }) {
  const [days, setDays] = useState(null);      // null = loading
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState({});    // dayId → { items } | { loading:true }
  const canDelete = usePerm('daily_checklist_complete_day');

  const deleteDay = async (d) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t.dcDeleteDayConfirm)) return;
    try {
      await api.delete(`/daily-checklist/days/${d.id}`);
      setDays(prev => (prev || []).filter(x => x.id !== d.id));
      if (openId === d.id) setOpenId(null);
      toast(t.dcDayDeleted, 'success');
    } catch { toast(t.dcDeleteDayFailed, 'error'); }
  };

  useEffect(() => {
    let alive = true;
    setDays(null); setOpenId(null); setDetail({});
    api.get(`/daily-checklist/projects/${projectId}/history`)
      .then(r => { if (alive) setDays(r.data.days || []); })
      .catch(() => { if (alive) { setDays([]); toast(t.dcLoadFailed, 'error'); } });
    return () => { alive = false; };
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (dayId) => {
    if (openId === dayId) { setOpenId(null); return; }
    setOpenId(dayId);
    if (detail[dayId]) return;
    setDetail(d => ({ ...d, [dayId]: { loading: true } }));
    try {
      const r = await api.get(`/daily-checklist/days/${dayId}`);
      setDetail(d => ({ ...d, [dayId]: { items: r.data.items || [] } }));
    } catch {
      setDetail(d => ({ ...d, [dayId]: { items: [] } }));
      toast(t.dcLoadFailed, 'error');
    }
  };

  if (days === null) return <div style={hStyles.panel}><div style={hStyles.muted}>{t.loading}</div></div>;
  if (!days.length) return <div style={hStyles.panel}><div style={hStyles.muted}>{t.dcHistoryEmpty}</div></div>;

  return (
    <div style={hStyles.panel}>
      {days.map(d => {
        const open = openId === d.id;
        const det = detail[d.id];
        return (
          <div key={d.id} style={hStyles.day}>
            <div style={hStyles.headRow}>
              <button type="button" style={hStyles.dayHead} onClick={() => toggle(d.id)} aria-expanded={open}>
                <span style={hStyles.chev}>{open ? '▾' : '▸'}</span>
                <span style={hStyles.dayDate}>{d.work_date ? String(d.work_date).slice(0, 10) : t.dcDayLabel.replace('{n}', d.day_number)}</span>
                <span style={hStyles.dayMeta}>{t.dcDayLabel.replace('{n}', d.day_number)} · {t.dcItemsChecked.replace('{n}', d.checked_count).replace('{total}', d.item_count)}</span>
              </button>
              {canDelete && (
                <button type="button" style={hStyles.delBtn} onClick={() => deleteDay(d)} title={t.dcDeleteDay} aria-label={t.dcDeleteDay}>🗑</button>
              )}
            </div>
            {open && (
              <div style={hStyles.items}>
                {!det || det.loading ? (
                  <div style={hStyles.muted}>{t.loading}</div>
                ) : det.items.length === 0 ? (
                  <div style={hStyles.muted}>{t.dcHistoryNoItems}</div>
                ) : det.items.map(it => {
                  const done = it.kind === 'text' ? !!(it.value && it.value.trim()) : it.checked;
                  return (
                    <div key={it.id} style={hStyles.item}>
                      <span style={{ ...hStyles.mark, color: done ? '#059669' : '#9ca3af' }}>{it.kind === 'text' ? '✎' : (it.checked ? '✓' : '○')}</span>
                      <div style={hStyles.itemBody}>
                        <div style={hStyles.itemText}>{it.text}{it.kind === 'text' && it.value ? `: ${it.value}` : ''}</div>
                        <div style={hStyles.itemWho}>
                          {done
                            ? `${it.checked_by_name || t.dcSomeone}${it.checked_at ? ' · ' + new Date(it.checked_at).toLocaleString() : ''}`
                            : t.dcUnchecked}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const hStyles = {
  panel: { background: '#f9fafb', border: '1px solid #eef0f2', borderRadius: 10, padding: 8, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 6 },
  muted: { color: '#6b7280', fontSize: 13, padding: '8px 6px' },
  day: { background: '#fff', border: '1px solid #eef0f2', borderRadius: 8, overflow: 'hidden' },
  headRow: { display: 'flex', alignItems: 'center' },
  dayHead: { display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, background: 'none', border: 'none', cursor: 'pointer', padding: '10px 12px', textAlign: 'left' },
  delBtn: { flexShrink: 0, background: '#fef2f2', color: '#ef4444', border: '1px solid #fecaca', borderRadius: 6, cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '6px 9px', margin: '0 8px' },
  chev: { color: '#9ca3af', fontSize: 12 },
  dayDate: { fontWeight: 700, fontSize: 14, color: '#111827', fontVariantNumeric: 'tabular-nums' },
  dayMeta: { marginLeft: 'auto', fontSize: 12, color: '#6b7280' },
  items: { borderTop: '1px solid #f3f4f6', padding: '4px 12px 10px', display: 'flex', flexDirection: 'column', gap: 8 },
  item: { display: 'flex', gap: 10, alignItems: 'flex-start', paddingTop: 8 },
  mark: { fontSize: 15, fontWeight: 700, lineHeight: 1.3, flexShrink: 0 },
  itemBody: { minWidth: 0 },
  itemText: { fontSize: 13.5, color: '#111827', lineHeight: 1.35 },
  itemWho: { fontSize: 11.5, color: '#6b7280', marginTop: 1 },
};

export default function DailyChecklist({ projects = [], settings = null, loading: projectsLoading = false, activeProject = '', onProjectChange }) {
  const t = useT();
  const toast = useToast();
  const canStart = usePerm('daily_checklist_start_day');
  const canCheck = usePerm('daily_checklist_check_items');
  const canComplete = usePerm('daily_checklist_complete_day');

  // Project = the shared Field "active project". A ?project=<id> deep link (e.g.
  // from the clock-in prompt) wins on mount; otherwise the shared value; else the first.
  const initialUrlProj = useRef(Number(new URLSearchParams(window.location.search).get('project')) || 0);
  const [projectId, setProjectId] = useState(() => {
    if (initialUrlProj.current) return initialUrlProj.current;
    return activeProject ? Number(activeProject) : (projects[0]?.id ?? '');
  });
  const [day, setDay] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newItem, setNewItem] = useState('');
  const [newItemKind, setNewItemKind] = useState('check');
  const [queued, setQueued] = useState([]); // prepared days waiting (shown on the Start card)
  const [conflict, setConflict] = useState(null);

  const loadActive = useCallback(async (pid) => {
    if (!pid) { setDay(null); setItems([]); setQueued([]); return; }
    setLoading(true);
    try {
      const r = await api.get(`/daily-checklist/projects/${pid}/active`, { params: { today: localToday() } });
      setDay(r.data.day); setItems(r.data.items || []);
      // With no active day, peek at the queue so the Start card can show what's prepared
      // (starting resumes the top of the queue).
      if (!r.data.day) {
        try { const q = await api.get(`/daily-checklist/projects/${pid}/queue`); setQueued(q.data.days || []); }
        catch { setQueued([]); }
      } else setQueued([]);
    } catch { toast(t.dcLoadFailed, 'error'); }
    finally { setLoading(false); }
  }, [t, toast]);

  // Projects load async in the parent; seed/repair the selection once they arrive so the
  // panels (guarded on projectId) and the active-day fetch actually have a project.
  useEffect(() => {
    if (projects.length && !projects.some(p => p.id === projectId)) setProjectId(projects[0].id);
  }, [projects, projectId]);

  // Push a ?project= deep link into the shared value once, so the other tabs follow it.
  useEffect(() => {
    if (initialUrlProj.current) onProjectChange?.(initialUrlProj.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the shared Field project (changed from any tab). Skip the first pass when
  // a deep link is present — the push above aligns the shared value instead.
  useEffect(() => {
    if (initialUrlProj.current) { initialUrlProj.current = 0; return; }
    const next = activeProject ? Number(activeProject) : (projects[0]?.id ?? '');
    setProjectId(prev => (prev === next ? prev : next));
  }, [activeProject, projects]);

  // Drop the ?project= param once consumed so a refresh doesn't re-force it (mirrors the
  // Administration ?focus= pattern); the selection is already seeded above.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('project')) return;
    params.delete('project');
    window.history.replaceState(null, '', window.location.pathname + (params.toString() ? '?' + params.toString() : '') + window.location.hash);
  }, []);

  useEffect(() => { loadActive(projectId); }, [projectId, loadActive]);

  // Stable so the Day Manager's effects don't re-fire every render (which thrashed the

  const startDay = async (resolution) => {
    setBusy(true);
    try {
      const r = await api.post(`/daily-checklist/projects/${projectId}/start`, { work_date: localToday(), ...(resolution ? { resolution } : {}) }, { suppressToast: true });
      setConflict(null); setDay(r.data.day); setItems(r.data.items || []);
    } catch (err) {
      if (err.response?.status === 409 && err.response.data?.conflict) setConflict(err.response.data);
      else toast(t.dcStartFailed, 'error');
    } finally { setBusy(false); }
  };

  const toggleItem = async (item) => {
    const next = !item.checked;
    setItems(prev => prev.map(i => (i.id === item.id ? { ...i, checked: next } : i)));
    try { await api.patch(`/daily-checklist/days/${day.id}/items/${item.id}`, { checked: next }); }
    catch { setItems(prev => prev.map(i => (i.id === item.id ? { ...i, checked: item.checked } : i))); toast(t.dcUpdateFailed, 'error'); }
  };
  const addItem = async () => {
    const text2 = newItem.trim();
    if (!text2 || !day) return;
    try { const r = await api.post(`/daily-checklist/days/${day.id}/items`, { text: text2, kind: newItemKind }); setItems(prev => [...prev, r.data.item]); setNewItem(''); }
    catch { toast(t.dcAddFailed, 'error'); }
  };
  // Text-field items: type freely (local), save on blur. `textBaseline` captures the value the
  // field held when the user started editing (its server value), sent as `prev_value` so the
  // server rejects a save if someone else changed a SHARED text field meanwhile (409) instead of
  // silently overwriting their entry.
  const textBaseline = useRef({});
  const setItemValueLocal = (item, value) => setItems(prev => prev.map(i => (i.id === item.id ? { ...i, value } : i)));
  const saveItemValue = async (item, value) => {
    const prev_value = textBaseline.current[item.id] ?? (item.value || '');
    try {
      await api.patch(`/daily-checklist/days/${day.id}/items/${item.id}`, { value, prev_value });
      textBaseline.current[item.id] = value; // new baseline for the next edit
    } catch (err) {
      if (err?.response?.status === 409) {
        const theirs = err.response.data?.value ?? '';
        setItems(prev => prev.map(i => (i.id === item.id ? { ...i, value: theirs } : i)));
        textBaseline.current[item.id] = theirs;
        toast(err.response.data?.error || t.dcUpdateFailed, 'error');
      } else { toast(t.dcUpdateFailed, 'error'); }
    }
  };
  const removeItem = async (item) => {
    try { await api.delete(`/daily-checklist/days/${day.id}/items/${item.id}`); setItems(prev => prev.filter(i => i.id !== item.id)); }
    catch { toast(t.dcRemoveFailed, 'error'); }
  };
  const completeDay = async () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t.dcCompleteConfirm)) return;
    setBusy(true);
    try { await api.post(`/daily-checklist/days/${day.id}/complete`, {}); setDay(null); setItems([]); toast(t.dcCompleted, 'success'); loadActive(projectId); }
    catch { toast(t.dcCompleteFailed, 'error'); }
    finally { setBusy(false); }
  };
  const cancelDay = async () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t.dcCancelConfirm)) return;
    setBusy(true);
    try { await api.post(`/daily-checklist/days/${day.id}/cancel`, {}); setDay(null); setItems([]); toast(t.dcCanceled, 'success'); loadActive(projectId); }
    catch { toast(t.dcCancelFailed, 'error'); }
    finally { setBusy(false); }
  };

  // Projects load async in the parent — show a skeleton until they settle, so we don't flash
  // "No projects yet" mid-load. Only claim empty once loading is done.
  if (projects.length === 0) return projectsLoading ? <SkeletonList rows={4} /> : <p style={styles.empty}>{t.dcNoProjects}</p>;
  // "Done" spans both kinds: a checked box or a filled-in text field.
  const isDone = it => (it.kind === 'text' ? !!(it.value && it.value.trim()) : it.checked);
  const doneCount = items.filter(isDone).length;

  return (
    <div style={styles.wrap}>
      <div style={styles.head}>
        <label style={styles.label}>{t.dcSelectProject}</label>
        <select style={styles.select} value={projectId} onChange={e => { const v = Number(e.target.value) || e.target.value; setProjectId(v); onProjectChange?.(v); }}>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {conflict ? (
        <div style={styles.conflictCard}>
          <div style={styles.conflictTitle}>{t.dcConflictTitle}</div>
          <p style={styles.help}>{t.dcConflictHelp}</p>
          <div style={styles.conflictOpts}>
            {['calendar', 'ordinal'].map(k => (
              <div key={k} style={styles.conflictOpt}>
                <div style={styles.conflictName}>{conflict[k].name || (k === 'calendar' ? t.dcScheduleCalendar : t.dcScheduleOrdinal)}</div>
                <ul style={styles.conflictItems}>{(conflict[k].items || []).map(it => <li key={it.id}>{it.text}</li>)}</ul>
                <button style={styles.btn} onClick={() => startDay(k)}>{k === 'calendar' ? t.dcUseCalendar : t.dcUseOrdinal}</button>
              </div>
            ))}
          </div>
          <div style={styles.rowEnd}>
            <button style={styles.linkBtnSm} onClick={() => setConflict(null)}>{t.dcCancel}</button>
            <button style={styles.completeBtn} onClick={() => startDay('merge')}>{t.dcMerge}</button>
          </div>
        </div>
      ) : loading ? (
        <SkeletonList rows={4} />
      ) : !day ? (
        <div style={styles.startCard}>
          <p style={styles.startMsg}>{t.dcNoActiveDay}</p>
          {queued.length > 0 && (
            <p style={styles.queuedHint}>
              {t.dcQueuedHint
                .replace('{label}', queued[0].schedule_type === 'calendar' ? String(queued[0].scheduled_date || '').slice(0, 10) : t.dcDayLabel.replace('{n}', queued[0].ordinal_target))
                .replace('{n}', queued[0].item_count)}
            </p>
          )}
          {canStart && <button style={{ ...styles.startBtn, ...(busy ? styles.btnOff : {}) }} onClick={() => startDay()} disabled={busy}>{busy ? t.dcStarting : t.dcStartDay}</button>}
        </div>
      ) : (
        <div style={styles.dayCard}>
          <div style={styles.dayHead}>
            <span style={styles.dayTitle}>{t.dcDayLabel.replace('{n}', day.day_number)}{day.work_date ? ` · ${String(day.work_date).slice(0, 10)}` : ''}</span>
            <span style={styles.progress}>{t.dcProgress.replace('{done}', doneCount).replace('{total}', items.length)}</span>
          </div>
          {items.length === 0 ? <p style={styles.empty}>{t.dcItemsEmpty}</p> : (
            <ul style={styles.list}>
              {items.map(item => (
                <li key={item.id} style={styles.item}>
                  {item.kind === 'text' ? (
                    <div style={styles.textItem}>
                      <span style={styles.textItemLabel}>{item.text}</span>
                      <input style={styles.textItemInput} value={item.value || ''} disabled={!canCheck}
                        placeholder={t.dcTextValuePlaceholder}
                        onFocus={() => { textBaseline.current[item.id] = item.value || ''; }}
                        onChange={e => setItemValueLocal(item, e.target.value)}
                        onBlur={e => canCheck && saveItemValue(item, e.target.value)} />
                    </div>
                  ) : (
                    <label style={styles.itemLabel}>
                      <input type="checkbox" checked={item.checked} disabled={!canCheck} onChange={() => toggleItem(item)} />
                      <span style={{ ...styles.itemText, ...(item.checked ? styles.itemChecked : {}) }}>{item.text}</span>
                    </label>
                  )}
                  {item.source === 'rollover' && <span style={styles.badge}>{t.dcCarriedOver}</span>}
                  {canCheck && <button style={styles.removeBtn} onClick={() => removeItem(item)} aria-label={t.dcRemove}>×</button>}
                </li>
              ))}
            </ul>
          )}
          {canCheck && (
            <div style={styles.addRow}>
              <select style={styles.kindSelect} value={newItemKind} onChange={e => setNewItemKind(e.target.value)}>
                <option value="check">{t.dcKindCheck}</option>
                <option value="text">{t.dcKindText}</option>
              </select>
              <input style={styles.addInput} value={newItem} placeholder={newItemKind === 'text' ? t.dcTextLabelPlaceholder : t.dcAddItemPlaceholder} onChange={e => setNewItem(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addItem(); }} />
              <button style={styles.btn} onClick={addItem}>{t.dcAdd}</button>
            </div>
          )}
          {canComplete && (
            <div style={styles.rowEnd}>
              <button style={{ ...styles.cancelDayBtn, ...(busy ? styles.btnOff : {}) }} onClick={cancelDay} disabled={busy}>{t.dcCancelDay}</button>
              <button style={{ ...styles.completeBtn, ...(busy ? styles.btnOff : {}) }} onClick={completeDay} disabled={busy}>{t.dcCompleteDay}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 14 },
  head: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  headActions: { marginLeft: 'auto', display: 'flex', gap: 14 },
  label: { fontSize: 13, fontWeight: 600, color: '#374151' },
  select: { padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, minWidth: 180 },
  linkBtn: { background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 13, fontWeight: 600, padding: 0 },
  linkBtnSm: { background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 12.5, padding: '0 2px' },
  linkBtnDanger: { background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 12.5, padding: '0 2px' },
  help: { fontSize: 12.5, color: '#6b7280', margin: '0 0 8px' },
  panel: { background: '#f9fafb', border: '1px solid #eef0f2', borderRadius: 10, padding: 12 },
  textarea: { width: '100%', boxSizing: 'border-box', borderRadius: 8, border: '1px solid #d1d5db', padding: 10, fontSize: 14, fontFamily: 'inherit', resize: 'vertical' },
  // Structured item editor
  editorList: { display: 'flex', flexDirection: 'column', gap: 6 },
  editorRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '2px 4px', borderRadius: 7 },
  editorRowSel: { background: '#eef2ff', boxShadow: 'inset 0 0 0 1px #c7d2fe' },
  dropLine: { height: 2, background: '#2563eb', borderRadius: 2, margin: '1px 2px', pointerEvents: 'none' },
  dragHandle: { background: 'none', border: 'none', color: '#9ca3af', cursor: 'grab', fontSize: 15, lineHeight: 1, padding: '2px 4px', letterSpacing: '-2px', userSelect: 'none' },
  menuScrim: { position: 'fixed', inset: 0, zIndex: 3000 },
  ctxMenu: { position: 'fixed', zIndex: 3001, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.16)', padding: 4, minWidth: 130, display: 'flex', flexDirection: 'column' },
  ctxItem: { background: 'none', border: 'none', textAlign: 'left', padding: '7px 10px', borderRadius: 6, fontSize: 13, color: '#374151', cursor: 'pointer' },
  ctxItemOff: { color: '#9ca3af', cursor: 'not-allowed' },
  kindSelect: { padding: '6px 8px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff' },
  editorInput: { flex: 1, minWidth: 100, padding: '7px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 14 },
  // Carryover toggle button — grayed out when off, accent-colored when on.
  carryBtn: { background: '#f3f4f6', color: '#9ca3af', border: '1px solid #e5e7eb', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' },
  carryBtnOn: { background: '#eef2ff', color: '#2563eb', borderColor: '#c7d2fe' },
  editorRemoveBtn: { background: '#fff', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 8, padding: '4px 11px', fontSize: 16, fontWeight: 700, lineHeight: 1, cursor: 'pointer' },
  editorAdd: { display: 'flex', gap: 8, marginTop: 4 },
  addItemBtn: { background: '#eef2ff', color: '#2563eb', border: '1px solid #c7d2fe', borderRadius: 8, padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  // Text-field item in the active day
  textItem: { flex: 1, display: 'flex', flexDirection: 'column', gap: 3 },
  textItemLabel: { fontSize: 13, fontWeight: 600, color: '#374151' },
  textItemInput: { padding: '6px 9px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 14 },
  rowEnd: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginTop: 8 },
  savedMsg: { color: '#059669', fontSize: 13, fontWeight: 600 },
  toggleRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', flexWrap: 'wrap' },
  toggleHelp: { color: '#9ca3af', fontSize: 12 },
  // Day manager
  prepareGrid: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 },
  whenRow: { display: 'flex', alignItems: 'center', gap: 8 },
  whenCol: { display: 'flex', flexDirection: 'column', gap: 4 },
  radioRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151' },
  inlineInput: { padding: '4px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 },
  inlineNum: { width: 64, padding: '4px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 },
  queueTitle: { fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4, margin: '14px 0 6px' },
  queueList: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  queueRow: { background: '#fff', border: '1px solid #eef0f2', borderRadius: 8, padding: '6px 8px' },
  queueMain: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  reorder: { display: 'flex', flexDirection: 'column' },
  reorderBtn: { background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 9, lineHeight: 1, padding: 0 },
  queueLabel: { fontSize: 13, fontWeight: 700, color: '#111827', fontVariantNumeric: 'tabular-nums' },
  queueName: { fontSize: 13, color: '#4b5563' },
  queueCount: { fontSize: 12, color: '#9ca3af' },
  queueActions: { marginLeft: 'auto', display: 'flex', gap: 10 },
  badgePaused: { fontSize: 11, fontWeight: 700, color: '#92400e', background: '#fef3c7', borderRadius: 6, padding: '1px 6px' },
  editBox: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 },
  // Start / day
  startCard: { textAlign: 'center', background: '#f9fafb', border: '1px dashed #d1d5db', borderRadius: 10, padding: '24px 16px' },
  startMsg: { color: '#6b7280', fontSize: 14, margin: '0 0 12px' },
  queuedHint: { color: '#2563eb', fontSize: 13, fontWeight: 600, margin: '0 0 12px' },
  startBtn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 18px', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  dayCard: { background: '#fff', border: '1px solid #eef0f2', borderRadius: 10, padding: 14 },
  dayHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 10 },
  dayTitle: { fontSize: 15, fontWeight: 700, color: '#111827' },
  progress: { fontSize: 13, color: '#6b7280', fontVariantNumeric: 'tabular-nums' },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 },
  item: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 8, background: '#f9fafb' },
  itemLabel: { flex: 1, display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' },
  itemText: { fontSize: 14, color: '#374151' },
  itemChecked: { textDecoration: 'line-through', color: '#9ca3af' },
  badge: { fontSize: 11, fontWeight: 700, color: '#92400e', background: '#fef3c7', borderRadius: 6, padding: '1px 6px' },
  removeBtn: { background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '0 4px' },
  addRow: { display: 'flex', gap: 8, marginTop: 10 },
  addInput: { flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, minWidth: 160 },
  btn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  completeBtn: { background: '#059669', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 16px', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  cancelDayBtn: { background: '#fff', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 8, padding: '9px 16px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  btnOff: { opacity: 0.55, cursor: 'not-allowed' },
  empty: { color: '#6b7280', fontSize: 14, padding: '8px 2px' },
  // Conflict
  conflictCard: { background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: 14 },
  conflictTitle: { fontSize: 15, fontWeight: 700, color: '#92400e', marginBottom: 4 },
  conflictOpts: { display: 'flex', gap: 12, flexWrap: 'wrap' },
  conflictOpt: { flex: '1 1 220px', background: '#fff', border: '1px solid #eef0f2', borderRadius: 8, padding: 10 },
  conflictName: { fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 6 },
  conflictItems: { margin: '0 0 10px', paddingLeft: 18, fontSize: 13, color: '#4b5563' },
};
