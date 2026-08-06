import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { useToast } from '../contexts/ToastContext';
import { usePerm } from '../hooks/usePerm';
import { SkeletonList } from './Skeleton';

/**
 * Daily Checklist (Field module) — the Phase 1 view: pick a project, start today's
 * checklist, and check items off. Items are assembled server-side from the project's
 * recurring template plus anything rolled over from the last completed day. Managers can
 * also edit the recurring template here. Advance scheduling (the day manager) is Phase 2.
 * See docs/plans/daily-checklist.md.
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

  if (loading) return <div style={styles.recurringBox}><SkeletonList rows={3} /></div>;
  return (
    <div style={styles.recurringBox}>
      <p style={styles.help}>{t.dcRecurringHelp}</p>
      <textarea
        style={styles.textarea}
        rows={5}
        value={text}
        placeholder={t.dcRecurringPlaceholder}
        onChange={e => { setText(e.target.value); setSaved(false); }}
      />
      <div style={styles.rowEnd}>
        {saved && <span style={styles.savedMsg}>{t.dcRecurringSaved}</span>}
        <button style={{ ...styles.btn, ...(saving ? styles.btnOff : {}) }} onClick={save} disabled={saving}>
          {saving ? t.dcSaving : t.dcRecurringSave}
        </button>
      </div>
    </div>
  );
}

export default function DailyChecklist({ projects = [] }) {
  const t = useT();
  const toast = useToast();
  const canStart = usePerm('daily_checklist_start_day');
  const canCheck = usePerm('daily_checklist_check_items');
  const canManageRecurring = usePerm('daily_checklist_manage_recurring');
  const canComplete = usePerm('daily_checklist_complete_day');

  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [day, setDay] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newItem, setNewItem] = useState('');
  const [showRecurring, setShowRecurring] = useState(false);

  const loadActive = useCallback(async (pid) => {
    if (!pid) { setDay(null); setItems([]); return; }
    setLoading(true);
    try {
      const r = await api.get(`/daily-checklist/projects/${pid}/active`);
      setDay(r.data.day); setItems(r.data.items || []);
    } catch { toast(t.dcLoadFailed, 'error'); }
    finally { setLoading(false); }
  }, [t, toast]);

  useEffect(() => { loadActive(projectId); }, [projectId, loadActive]);

  const startDay = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/daily-checklist/projects/${projectId}/start`, { work_date: localToday() });
      setDay(r.data.day); setItems(r.data.items || []);
    } catch { toast(t.dcStartFailed, 'error'); }
    finally { setBusy(false); }
  };

  const toggleItem = async (item) => {
    const next = !item.checked;
    setItems(prev => prev.map(i => (i.id === item.id ? { ...i, checked: next } : i))); // optimistic
    try {
      await api.patch(`/daily-checklist/days/${day.id}/items/${item.id}`, { checked: next });
    } catch {
      setItems(prev => prev.map(i => (i.id === item.id ? { ...i, checked: item.checked } : i))); // revert
      toast(t.dcUpdateFailed, 'error');
    }
  };

  const addItem = async () => {
    const text2 = newItem.trim();
    if (!text2 || !day) return;
    try {
      const r = await api.post(`/daily-checklist/days/${day.id}/items`, { text: text2 });
      setItems(prev => [...prev, r.data.item]); setNewItem('');
    } catch { toast(t.dcAddFailed, 'error'); }
  };

  const removeItem = async (item) => {
    try {
      await api.delete(`/daily-checklist/days/${day.id}/items/${item.id}`);
      setItems(prev => prev.filter(i => i.id !== item.id));
    } catch { toast(t.dcRemoveFailed, 'error'); }
  };

  const completeDay = async () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(t.dcCompleteConfirm)) return;
    setBusy(true);
    try {
      await api.post(`/daily-checklist/days/${day.id}/complete`, {});
      setDay(null); setItems([]);
      toast(t.dcCompleted, 'success');
    } catch { toast(t.dcCompleteFailed, 'error'); }
    finally { setBusy(false); }
  };

  if (projects.length === 0) return <p style={styles.empty}>{t.dcNoProjects}</p>;

  const doneCount = items.filter(i => i.checked).length;

  return (
    <div style={styles.wrap}>
      <div style={styles.head}>
        <label style={styles.label}>{t.dcSelectProject}</label>
        <select style={styles.select} value={projectId} onChange={e => setProjectId(Number(e.target.value) || e.target.value)}>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {canManageRecurring && (
          <button style={styles.linkBtn} onClick={() => setShowRecurring(v => !v)}>
            {showRecurring ? '▾' : '▸'} {t.dcManageRecurring}
          </button>
        )}
      </div>

      {canManageRecurring && showRecurring && projectId && (
        <RecurringEditor key={projectId} projectId={projectId} t={t} toast={toast} />
      )}

      {loading ? (
        <SkeletonList rows={4} />
      ) : !day ? (
        <div style={styles.startCard}>
          <p style={styles.startMsg}>{t.dcNoActiveDay}</p>
          {canStart && (
            <button style={{ ...styles.startBtn, ...(busy ? styles.btnOff : {}) }} onClick={startDay} disabled={busy}>
              {busy ? t.dcStarting : t.dcStartDay}
            </button>
          )}
        </div>
      ) : (
        <div style={styles.dayCard}>
          <div style={styles.dayHead}>
            <span style={styles.dayTitle}>
              {t.dcDayLabel.replace('{n}', day.day_number)}
              {day.work_date ? ` · ${String(day.work_date).slice(0, 10)}` : ''}
            </span>
            <span style={styles.progress}>{t.dcProgress.replace('{done}', doneCount).replace('{total}', items.length)}</span>
          </div>

          {items.length === 0 ? (
            <p style={styles.empty}>{t.dcItemsEmpty}</p>
          ) : (
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
              <input
                style={styles.addInput}
                value={newItem}
                placeholder={t.dcAddItemPlaceholder}
                onChange={e => setNewItem(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addItem(); }}
              />
              <button style={styles.btn} onClick={addItem}>{t.dcAdd}</button>
            </div>
          )}

          {canComplete && (
            <div style={styles.rowEnd}>
              <button style={{ ...styles.completeBtn, ...(busy ? styles.btnOff : {}) }} onClick={completeDay} disabled={busy}>
                {t.dcCompleteDay}
              </button>
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
  label: { fontSize: 13, fontWeight: 600, color: '#374151' },
  select: { padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, minWidth: 180 },
  linkBtn: { marginLeft: 'auto', background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  help: { fontSize: 12.5, color: '#6b7280', margin: '0 0 8px' },
  recurringBox: { background: '#f9fafb', border: '1px solid #eef0f2', borderRadius: 10, padding: 12 },
  textarea: { width: '100%', boxSizing: 'border-box', borderRadius: 8, border: '1px solid #d1d5db', padding: 10, fontSize: 14, fontFamily: 'inherit', resize: 'vertical' },
  rowEnd: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginTop: 8 },
  savedMsg: { color: '#059669', fontSize: 13, fontWeight: 600 },
  startCard: { textAlign: 'center', background: '#f9fafb', border: '1px dashed #d1d5db', borderRadius: 10, padding: '24px 16px' },
  startMsg: { color: '#6b7280', fontSize: 14, margin: '0 0 12px' },
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
  addInput: { flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14 },
  btn: { background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  completeBtn: { background: '#059669', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 16px', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  btnOff: { opacity: 0.55, cursor: 'not-allowed' },
  empty: { color: '#6b7280', fontSize: 14, padding: '8px 2px' },
};
