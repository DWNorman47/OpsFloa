import React, { useState, useEffect, useCallback } from 'react';
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

function RecurringEditor({ projectId, t, toast }) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true); setSaved(false);
    api.get(`/daily-checklist/projects/${projectId}/recurring`)
      .then(r => { if (alive) setText((r.data.items || []).map(i => i.text).join('\n')); })
      .catch(() => { if (alive) toast(t.dcLoadFailed, 'error'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [projectId, t, toast]);

  const save = async () => {
    setSaving(true); setSaved(false);
    const items = text.split('\n').map(s => s.trim()).filter(Boolean).map(s => ({ text: s }));
    try {
      await api.put(`/daily-checklist/projects/${projectId}/recurring`, { items });
      setSaved(true);
    } catch { toast(t.dcRecurringSaveFailed, 'error'); }
    finally { setSaving(false); }
  };

  if (loading) return <div style={styles.panel}><SkeletonList rows={3} /></div>;
  return (
    <div style={styles.panel}>
      <p style={styles.help}>{t.dcRecurringHelp}</p>
      <textarea style={styles.textarea} rows={5} value={text} placeholder={t.dcRecurringPlaceholder}
        onChange={e => { setText(e.target.value); setSaved(false); }} />
      <div style={styles.rowEnd}>
        {saved && <span style={styles.savedMsg}>{t.dcRecurringSaved}</span>}
        <button style={{ ...styles.btn, ...(saving ? styles.btnOff : {}) }} onClick={save} disabled={saving}>
          {saving ? t.dcSaving : t.dcRecurringSave}
        </button>
      </div>
    </div>
  );
}

// One prepared day in the queue — inline reschedule / edit-items / reorder / delete.
function QueueRow({ day, t, toast, first, last, onChanged }) {
  const [editing, setEditing] = useState(null); // 'items' | 'when' | null
  const [itemsText, setItemsText] = useState('');
  const [when, setWhen] = useState({ schedule_type: day.schedule_type, scheduled_date: day.scheduled_date || localToday(), ordinal_target: day.ordinal_target || 1 });

  const openItems = async () => {
    try {
      const r = await api.get(`/daily-checklist/days/${day.id}`);
      setItemsText((r.data.items || []).map(i => i.text).join('\n'));
      setEditing('items');
    } catch { toast(t.dcLoadFailed, 'error'); }
  };
  const saveItems = async () => {
    const items = itemsText.split('\n').map(s => s.trim()).filter(Boolean).map(s => ({ text: s }));
    try { await api.put(`/daily-checklist/days/${day.id}/plan-items`, { items }); setEditing(null); onChanged(); }
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
          <label style={styles.radioRow}>
            <input type="radio" checked={when.schedule_type === 'calendar'} onChange={() => setWhen(w => ({ ...w, schedule_type: 'calendar' }))} />
            {t.dcScheduleCalendar}
            {when.schedule_type === 'calendar' && <input type="date" style={styles.inlineInput} value={when.scheduled_date} onChange={e => setWhen(w => ({ ...w, scheduled_date: e.target.value }))} />}
          </label>
          <label style={styles.radioRow}>
            <input type="radio" checked={when.schedule_type === 'ordinal'} onChange={() => setWhen(w => ({ ...w, schedule_type: 'ordinal' }))} />
            {t.dcScheduleOrdinal}
            {when.schedule_type === 'ordinal' && <input type="number" min={1} style={styles.inlineNum} value={when.ordinal_target} onChange={e => setWhen(w => ({ ...w, ordinal_target: e.target.value }))} />}
          </label>
          <div style={styles.rowEnd}>
            <button style={styles.linkBtnSm} onClick={() => setEditing(null)}>{t.dcCancel}</button>
            <button style={styles.btn} onClick={saveWhen}>{t.dcSavePlan}</button>
          </div>
        </div>
      )}
      {editing === 'items' && (
        <div style={styles.editBox}>
          <textarea style={styles.textarea} rows={4} value={itemsText} placeholder={t.dcPlanItemsPlaceholder} onChange={e => setItemsText(e.target.value)} />
          <div style={styles.rowEnd}>
            <button style={styles.linkBtnSm} onClick={() => setEditing(null)}>{t.dcCancel}</button>
            <button style={styles.btn} onClick={saveItems}>{t.dcSavePlan}</button>
          </div>
        </div>
      )}
    </li>
  );
}

function DayManager({ projectId, t, toast, onQueueChanged }) {
  const [queue, setQueue] = useState(null);
  const [form, setForm] = useState({ schedule_type: 'calendar', scheduled_date: localToday(), ordinal_target: 1, name: '', items: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try { const r = await api.get(`/daily-checklist/projects/${projectId}/queue`); setQueue(r.data.days || []); }
    catch { toast(t.dcQueueLoadFailed, 'error'); setQueue([]); }
  }, [projectId, t, toast]);
  useEffect(() => { load(); }, [load]); // mount only — does NOT touch the parent

  // After a mutation, reload the queue AND tell the parent to refresh the active view
  // (an edit may have merged items onto the running day).
  const refresh = useCallback(async () => { await load(); onQueueChanged?.(); }, [load, onQueueChanged]);

  const create = async () => {
    setSaving(true);
    const body = {
      schedule_type: form.schedule_type,
      ...(form.schedule_type === 'calendar' ? { scheduled_date: form.scheduled_date } : { ordinal_target: Number(form.ordinal_target) }),
      name: form.name.trim() || undefined,
      items: form.items.split('\n').map(s => s.trim()).filter(Boolean).map(s => ({ text: s })),
    };
    try {
      await api.post(`/daily-checklist/projects/${projectId}/days`, body);
      setForm(f => ({ ...f, name: '', items: '' }));
      await refresh();
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
        <div style={styles.whenCol}>
          <label style={styles.radioRow}>
            <input type="radio" checked={form.schedule_type === 'calendar'} onChange={() => setForm(f => ({ ...f, schedule_type: 'calendar' }))} />
            {t.dcScheduleCalendar}
            {form.schedule_type === 'calendar' && <input type="date" style={styles.inlineInput} value={form.scheduled_date} onChange={e => setForm(f => ({ ...f, scheduled_date: e.target.value }))} />}
          </label>
          <label style={styles.radioRow}>
            <input type="radio" checked={form.schedule_type === 'ordinal'} onChange={() => setForm(f => ({ ...f, schedule_type: 'ordinal' }))} />
            {t.dcScheduleOrdinal}
            {form.schedule_type === 'ordinal' && <input type="number" min={1} style={styles.inlineNum} value={form.ordinal_target} onChange={e => setForm(f => ({ ...f, ordinal_target: e.target.value }))} />}
          </label>
        </div>
        <input style={styles.addInput} value={form.name} placeholder={t.dcDayNamePlaceholder} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
      </div>
      <textarea style={styles.textarea} rows={3} value={form.items} placeholder={t.dcPlanItemsPlaceholder} onChange={e => setForm(f => ({ ...f, items: e.target.value }))} />
      <div style={styles.rowEnd}>
        <button style={{ ...styles.btn, ...(saving ? styles.btnOff : {}) }} onClick={create} disabled={saving}>{t.dcCreateDay}</button>
      </div>

      <div style={styles.queueTitle}>{t.dcQueueTitle}</div>
      {queue === null ? <SkeletonList rows={2} />
        : queue.length === 0 ? <p style={styles.empty}>{t.dcQueueEmpty}</p>
          : <ul style={styles.queueList}>
            {queue.map((d, i) => (
              <QueueRow key={d.id} day={d} t={t} toast={toast} first={i === 0} last={i === queue.length - 1} onChanged={onChanged} />
            ))}
          </ul>}
    </div>
  );
}
const swap = (arr, i, j) => { const a = arr.slice(); [a[i], a[j]] = [a[j], a[i]]; return a; };

export default function DailyChecklist({ projects = [], settings = null, loading: projectsLoading = false }) {
  const t = useT();
  const toast = useToast();
  const canStart = usePerm('daily_checklist_start_day');
  const canCheck = usePerm('daily_checklist_check_items');
  const canManageRecurring = usePerm('daily_checklist_manage_recurring');
  const canComplete = usePerm('daily_checklist_complete_day');
  const canSchedule = usePerm('daily_checklist_schedule_days');
  const canManageSettings = usePerm('manage_settings');

  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [day, setDay] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newItem, setNewItem] = useState('');
  const [panel, setPanel] = useState(null); // 'recurring' | 'manager' | null
  const [queued, setQueued] = useState([]); // prepared days waiting (shown on the Start card)
  const [conflict, setConflict] = useState(null);
  const [autostart, setAutostart] = useState(settings?.daily_checklist_clockin_autostart === true);

  const loadActive = useCallback(async (pid) => {
    if (!pid) { setDay(null); setItems([]); setQueued([]); return; }
    setLoading(true);
    try {
      const r = await api.get(`/daily-checklist/projects/${pid}/active`);
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

  useEffect(() => { loadActive(projectId); }, [projectId, loadActive]);

  // Stable so the Day Manager's effects don't re-fire every render (which thrashed the
  // active card). Called only after a Day Manager mutation, to pick up items merged onto
  // the running day.
  const refreshActive = useCallback(() => { loadActive(projectId); }, [loadActive, projectId]);

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
    try { const r = await api.post(`/daily-checklist/days/${day.id}/items`, { text: text2 }); setItems(prev => [...prev, r.data.item]); setNewItem(''); }
    catch { toast(t.dcAddFailed, 'error'); }
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
  const toggleAutostart = async () => {
    const next = !autostart;
    setAutostart(next);
    try { await api.patch('/admin/settings', { daily_checklist_clockin_autostart: next }); }
    catch { setAutostart(!next); toast(t.dcAutostartFailed, 'error'); }
  };

  // Projects load async in the parent — show a skeleton until they settle, so we don't flash
  // "No projects yet" mid-load. Only claim empty once loading is done.
  if (projects.length === 0) return projectsLoading ? <SkeletonList rows={4} /> : <p style={styles.empty}>{t.dcNoProjects}</p>;
  const doneCount = items.filter(i => i.checked).length;

  return (
    <div style={styles.wrap}>
      <div style={styles.head}>
        <label style={styles.label}>{t.dcSelectProject}</label>
        <select style={styles.select} value={projectId} onChange={e => setProjectId(Number(e.target.value) || e.target.value)}>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span style={styles.headActions}>
          {canManageRecurring && <button style={styles.linkBtn} onClick={() => setPanel(p => p === 'recurring' ? null : 'recurring')}>{panel === 'recurring' ? '▾' : '▸'} {t.dcManageRecurring}</button>}
          {canSchedule && <button style={styles.linkBtn} onClick={() => setPanel(p => p === 'manager' ? null : 'manager')}>{panel === 'manager' ? '▾' : '▸'} {t.dcDayManager}</button>}
        </span>
      </div>

      {canManageSettings && (
        <label style={styles.toggleRow}>
          <input type="checkbox" checked={autostart} onChange={toggleAutostart} />
          <span>{t.dcAutostartLabel}</span>
          <span style={styles.toggleHelp}>{t.dcAutostartHelp}</span>
        </label>
      )}

      {canManageRecurring && panel === 'recurring' && projectId && <RecurringEditor key={`r${projectId}`} projectId={projectId} t={t} toast={toast} />}
      {canSchedule && panel === 'manager' && projectId && <DayManager key={`m${projectId}`} projectId={projectId} t={t} toast={toast} onQueueChanged={refreshActive} />}

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
                  <label style={styles.itemLabel}>
                    <input type="checkbox" checked={item.checked} disabled={!canCheck} onChange={() => toggleItem(item)} />
                    <span style={{ ...styles.itemText, ...(item.checked ? styles.itemChecked : {}) }}>{item.text}</span>
                  </label>
                  {item.source === 'rollover' && <span style={styles.badge}>{t.dcCarriedOver}</span>}
                  {canCheck && <button style={styles.removeBtn} onClick={() => removeItem(item)} aria-label={t.dcRemove}>×</button>}
                </li>
              ))}
            </ul>
          )}
          {canCheck && (
            <div style={styles.addRow}>
              <input style={styles.addInput} value={newItem} placeholder={t.dcAddItemPlaceholder} onChange={e => setNewItem(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addItem(); }} />
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
  rowEnd: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginTop: 8 },
  savedMsg: { color: '#059669', fontSize: 13, fontWeight: 600 },
  toggleRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', flexWrap: 'wrap' },
  toggleHelp: { color: '#9ca3af', fontSize: 12 },
  // Day manager
  prepareGrid: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 },
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
