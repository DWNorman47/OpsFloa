import React, { useState } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { useToast } from '../contexts/ToastContext';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
function isEditable(dateStr) {
  return Date.now() - new Date(dateStr.substring(0, 10) + 'T00:00:00').getTime() <= SEVEN_DAYS_MS;
}
function midTime(start, end) {
  const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const s = toMin(start); let e = toMin(end);
  if (e <= s) e += 1440;
  const mid = Math.round((s + e) / 2) % 1440;
  return `${String(Math.floor(mid / 60)).padStart(2, '0')}:${String(mid % 60).padStart(2, '0')}`;
}

export default function EntryPanel({ entry, projects = [], onRefresh, onDeleted, onClose, workLabel = 'Project' }) {
  const t = useT();
  const toast = useToast();
  const editable = !entry.locked && isEditable(entry.work_date);
  const mid = midTime(entry.start_time, entry.end_time);
  const workLabelLower = workLabel.toLowerCase();

  const [tab, setTab] = useState('edit');
  const [editForm, setEditForm] = useState({
    start_time: entry.start_time.substring(0, 5),
    end_time: entry.end_time.substring(0, 5),
    notes: entry.notes || '',
    break_minutes: entry.break_minutes || 0,
    mileage: entry.mileage || '',
  });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const [breakForm, setBreakForm] = useState({ breakStart: mid, breakEnd: mid });
  const [switchForm, setSwitchForm] = useState({ at: mid, project_id: '' });
  const [splitSaving, setSplitSaving] = useState(false);
  const [splitError, setSplitError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const switchTab = tabName => { setTab(tabName); setSplitError(''); setEditError(''); };

  const handleSaveEdit = async () => {
    setEditSaving(true); setEditError('');
    try {
      await api.patch(`/time-entries/${entry.id}`, editForm);
      await onRefresh();
      toast(t.entryUpdated, 'success');
      onClose?.();
    } catch (err) { setEditError(err.response?.data?.error || t.entryPanelFailedSave); }
    finally { setEditSaving(false); }
  };

  const doSplitBreak = async () => {
    const { breakStart, breakEnd } = breakForm;
    const s = entry.start_time.substring(0, 5);
    const e = entry.end_time.substring(0, 5);
    if (!breakStart || !breakEnd) { setSplitError(t.entryPanelSetBreakTimes); return; }
    if (breakEnd <= breakStart) { setSplitError(t.entryPanelBreakEndAfter); return; }
    if (breakStart <= s || breakEnd >= e) { setSplitError(t.entryPanelBreakWithin); return; }
    setSplitSaving(true); setSplitError('');
    try {
      await api.patch(`/time-entries/${entry.id}`, { start_time: s, end_time: breakStart, notes: entry.notes, break_minutes: entry.break_minutes, mileage: entry.mileage });
      await api.post('/time-entries', { project_id: entry.project_id, work_date: entry.work_date.substring(0, 10), start_time: breakEnd, end_time: entry.end_time, notes: entry.notes || undefined, client_id: crypto.randomUUID(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      await onRefresh();
      onClose?.();
    } catch (err) { setSplitError(err.response?.data?.error || t.entryPanelFailedSplit); }
    finally { setSplitSaving(false); }
  };

  const doSplitSwitch = async () => {
    const { at, project_id } = switchForm;
    const s = entry.start_time.substring(0, 5);
    const e = entry.end_time.substring(0, 5);
    if (!at || !project_id) { setSplitError(t.entryPanelSetSwitchTime); return; }
    if (at <= s || at >= e) { setSplitError(t.entryPanelSwitchWithin); return; }
    setSplitSaving(true); setSplitError('');
    try {
      await api.patch(`/time-entries/${entry.id}`, { start_time: s, end_time: at, notes: entry.notes, break_minutes: entry.break_minutes, mileage: entry.mileage });
      await api.post('/time-entries', { project_id, work_date: entry.work_date.substring(0, 10), start_time: at, end_time: entry.end_time, client_id: crypto.randomUUID(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      await onRefresh();
      onClose?.();
    } catch (err) { setSplitError(err.response?.data?.error || t.entryPanelFailedSplit); }
    finally { setSplitSaving(false); }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError('');
    try {
      await api.delete(`/time-entries/${entry.id}`);
      onDeleted?.(entry.id);
      onClose?.();
    } catch (err) {
      setDeleteError(err.response?.data?.error || t.entryPanelFailedDelete);
      setConfirmingDelete(false);
    }
    finally { setDeleting(false); }
  };

  return (
    <div style={s.panel}>
      {editable && (
        <div style={s.tabBar}>
          <button style={tab === 'edit' ? s.tabOn : s.tab} onClick={() => switchTab('edit')}>{t.entryPanelEdit}</button>
          <button style={tab === 'break' ? s.tabOn : s.tab} onClick={() => switchTab('break')}>{t.entryPanelInsertBreak}</button>
          <button style={tab === 'switch' ? s.tabOn : s.tab} onClick={() => switchTab('switch')}>{`${workLabel} switch`}</button>
        </div>
      )}

      {tab === 'edit' && (
        <div>
          {editable ? (
            <>
              <div style={s.row}>
                <div style={s.field}><label htmlFor="ep-start" style={s.label}>{t.entryPanelStart}</label><input id="ep-start" style={s.input} type="time" value={editForm.start_time} onChange={ev => setEditForm(f => ({ ...f, start_time: ev.target.value }))} disabled={editSaving} /></div>
                <div style={s.field}><label htmlFor="ep-end" style={s.label}>{t.entryPanelEnd}</label><input id="ep-end" style={s.input} type="time" value={editForm.end_time} onChange={ev => setEditForm(f => ({ ...f, end_time: ev.target.value }))} disabled={editSaving} /></div>
                <div style={s.field}><label htmlFor="ep-break" style={s.label}>{t.entryPanelBreakMin}</label><input id="ep-break" style={s.input} type="number" min="0" max="480" value={editForm.break_minutes} onChange={ev => setEditForm(f => ({ ...f, break_minutes: ev.target.value }))} disabled={editSaving} /></div>
                <div style={s.field}><label htmlFor="ep-mileage" style={s.label}>{t.entryPanelMileage}</label><input id="ep-mileage" style={s.input} type="number" min="0" step="0.1" value={editForm.mileage} onChange={ev => setEditForm(f => ({ ...f, mileage: ev.target.value }))} placeholder={t.optional} disabled={editSaving} /></div>
                <div style={{ ...s.field, flex: 2 }}><label htmlFor="ep-notes" style={s.label}>{t.notes}</label><input id="ep-notes" style={s.input} type="text" maxLength={500} value={editForm.notes} onChange={ev => setEditForm(f => ({ ...f, notes: ev.target.value }))} placeholder={t.optional} disabled={editSaving} /></div>
              </div>
              {editError && <p style={s.error}>{editError}</p>}
              <div style={s.actions}>
                <button style={{ ...s.saveBtn, ...(editSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={handleSaveEdit} disabled={editSaving}>{editSaving ? t.saving : t.save}</button>
                <button style={s.cancelBtn} onClick={onClose}>{t.cancel}</button>
              </div>
            </>
          ) : (
            <p style={s.locked}>{entry.locked ? t.entryPanelLocked : t.entryPanelTooOld}</p>
          )}
        </div>
      )}

      {editable && tab === 'break' && (
        <div>
          <p style={s.hint}>{t.entryPanelBreakHint}</p>
          <div style={s.row}>
            <div style={s.field}><label htmlFor="ep-break-start" style={s.label}>{t.entryPanelBreakStart}</label><input id="ep-break-start" type="time" style={s.input} value={breakForm.breakStart} onChange={e => setBreakForm(f => ({ ...f, breakStart: e.target.value }))} /></div>
            <div style={s.field}><label htmlFor="ep-break-end" style={s.label}>{t.entryPanelBreakEnd}</label><input id="ep-break-end" type="time" style={s.input} value={breakForm.breakEnd} onChange={e => setBreakForm(f => ({ ...f, breakEnd: e.target.value }))} /></div>
          </div>
          {splitError && <p style={s.error}>{splitError}</p>}
          <div style={s.actions}>
            <button style={{ ...s.saveBtn, ...(splitSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={doSplitBreak} disabled={splitSaving}>{splitSaving ? t.saving : t.entryPanelInsertBreakBtn}</button>
            <button style={s.cancelBtn} onClick={onClose}>{t.cancel}</button>
          </div>
        </div>
      )}

      {editable && tab === 'switch' && (
        <div>
          <p style={s.hint}>{t.entryPanelSwitchHint}</p>
          <div style={s.row}>
            <div style={s.field}><label htmlFor="ep-switch-at" style={s.label}>{t.entryPanelSwitchAt}</label><input id="ep-switch-at" type="time" style={s.input} value={switchForm.at} onChange={e => setSwitchForm(f => ({ ...f, at: e.target.value }))} /></div>
            <div style={{ ...s.field, flex: 2 }}>
              <label htmlFor="ep-switch-project" style={s.label}>{`Switch to ${workLabelLower}`}</label>
              <select id="ep-switch-project" style={s.input} value={switchForm.project_id} onChange={e => setSwitchForm(f => ({ ...f, project_id: e.target.value }))}>
                <option value="">{t.selectPlaceholder}…</option>
                {projects.filter(p => p.active !== false).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>
          {splitError && <p style={s.error}>{splitError}</p>}
          <div style={s.actions}>
            <button style={{ ...s.saveBtn, ...(splitSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={doSplitSwitch} disabled={splitSaving}>{splitSaving ? t.saving : t.entryPanelInsertSwitchBtn}</button>
            <button style={s.cancelBtn} onClick={onClose}>{t.cancel}</button>
          </div>
        </div>
      )}

      {!entry.pending && !entry.locked && (
        <div style={s.deleteRow}>
          {confirmingDelete ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, color: '#374151' }}>{t.entryPanelDeleteConfirm}</span>
              <button style={{ ...s.deleteConfirmBtn, ...(deleting ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={handleDelete} disabled={deleting}>{deleting ? t.entryPanelDeleting : t.confirm}</button>
              <button style={s.cancelBtn} onClick={() => setConfirmingDelete(false)}>{t.cancel}</button>
            </div>
          ) : (
            <button style={s.deleteBtn} onClick={() => setConfirmingDelete(true)}>{t.entryPanelDeleteEntry}</button>
          )}
          {deleteError && <p style={s.error}>{deleteError}</p>}
        </div>
      )}
    </div>
  );
}

const s = {
  panel: { marginTop: 10, paddingTop: 12, borderTop: '1px solid #e5e7eb' },
  tabBar: { display: 'flex', gap: 4, marginBottom: 12, background: '#f3f4f6', borderRadius: 8, padding: 4 },
  tab: { flex: 1, padding: '10px 0', background: 'none', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, color: '#6b7280', cursor: 'pointer' },
  tabOn: { flex: 1, padding: '10px 0', background: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 700, color: 'var(--ops-page-accent)', cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' },
  row: { display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 },
  field: { display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 90 },
  label: { fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' },
  input: { padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 },
  hint: { fontSize: 12, color: '#6b7280', margin: '0 0 10px' },
  error: { color: '#ef4444', fontSize: 12, margin: '4px 0 8px' },
  locked: { fontSize: 13, color: '#6b7280', margin: '0 0 8px' },
  actions: { display: 'flex', gap: 8, alignItems: 'center' },
  saveBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '7px 16px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  cancelBtn: { background: 'none', border: '1px solid #d1d5db', color: '#6b7280', padding: '7px 14px', borderRadius: 6, fontSize: 13, cursor: 'pointer' },
  deleteRow: { marginTop: 12, paddingTop: 10, borderTop: '1px solid #fee2e2' },
  deleteBtn: { background: 'none', border: '1px solid #fca5a5', color: '#ef4444', padding: '9px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  deleteConfirmBtn: { background: '#dc2626', color: '#fff', border: 'none', padding: '7px 14px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer' },
};
