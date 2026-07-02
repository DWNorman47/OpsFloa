import React, { useState, useEffect, useMemo } from 'react';
import api from '../api';
import { useToast } from '../contexts/ToastContext';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { labelSg } from '../companyLabels';

// ── Time helpers ─────────────────────────────────────────────────────────────
function strToMin(str) {
  if (!str) return 0;
  const [h, m] = str.split(':').map(Number);
  return h * 60 + m;
}

function minToDisplay(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  const period = h < 12 ? 'AM' : 'PM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${period}`;
}

function minToHHMM(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function isoToLocalMin(isoStr) {
  const d = new Date(isoStr);
  return d.getHours() * 60 + d.getMinutes();
}

function dur(startMin, endMin) {
  const diff = endMin - startMin;
  if (diff <= 0) return '';
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Component ────────────────────────────────────────────────────────────────
export default function DayTimeline({ entries, projects, settings, onEntryAdded, onEntryUpdated, onRefresh }) {
  const t = useT();
  const toast = useToast();
  const { user } = useAuth();
  const today = todayLocal();
  const workLabel = labelSg(settings?.label_work, 'work', user?.language);
  const workLabelLower = workLabel.toLowerCase();

  const [clockStatus, setClockStatus] = useState(undefined); // undefined=loading, null=not clocked in, obj=clocked in
  const [breaks, setBreaks] = useState(new Set()); // gap keys marked as intentional breaks

  // Gap insertion state
  const [activeGapKey, setActiveGapKey] = useState(null);
  const [gapMode, setGapMode] = useState('work'); // 'work' | 'break' | 'switch'
  const [workForm, setWorkForm] = useState({ project_id: '', start: '', end: '' });
  const [switchForm, setSwitchForm] = useState({ p1: '', p2: '', split: '' });

  // Entry split state
  const [splitId, setSplitId] = useState(null);
  const [splitMode, setSplitMode] = useState('break'); // 'break' | 'switch'
  const [splitBreakForm, setSplitBreakForm] = useState({ breakStart: '', breakEnd: '' });
  const [splitSwitchForm, setSplitSwitchForm] = useState({ at: '', project_id: '' });

  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [pendingDeleteEntry, setPendingDeleteEntry] = useState(null);

  useEffect(() => {
    api.get('/clock/status')
      .then(r => setClockStatus(r.data || null))
      .catch(() => setClockStatus(null));
  }, []);

  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();

  const todayEntries = useMemo(() =>
    entries
      .filter(e => e.work_date?.toString().substring(0, 10) === today)
      .sort((a, b) => a.start_time.localeCompare(b.start_time)),
    [entries, today]
  );

  // Build timeline segments: entry | gap | active
  const segments = useMemo(() => {
    if (clockStatus === undefined) return null;
    const segs = [];
    let prevEnd = null;

    for (const entry of todayEntries) {
      const start = strToMin(entry.start_time);
      const end = strToMin(entry.end_time);
      if (prevEnd !== null && start > prevEnd + 1) {
        segs.push({ type: 'gap', start: prevEnd, end: start, key: `gap_${prevEnd}_${start}` });
      }
      segs.push({ type: 'entry', entry, start, end });
      prevEnd = end;
    }

    if (clockStatus) {
      const clockStart = isoToLocalMin(clockStatus.clock_in_time);
      if (prevEnd !== null && clockStart > prevEnd + 1) {
        segs.push({ type: 'gap', start: prevEnd, end: clockStart, key: `gap_${prevEnd}_${clockStart}` });
      }
      segs.push({ type: 'active', clockStatus, start: clockStart });
    }

    return segs;
  }, [todayEntries, clockStatus]);

  // ── Gap actions ─────────────────────────────────────────────────────────────
  function openGap(gap) {
    setSplitId(null);
    setActiveGapKey(gap.key);
    setGapMode('work');
    setWorkForm({ project_id: '', start: minToHHMM(gap.start), end: minToHHMM(gap.end) });
    setSwitchForm({ p1: '', p2: '', split: minToHHMM(Math.round((gap.start + gap.end) / 2)) });
  }

  function closeGap() { setActiveGapKey(null); }

  async function addWork() {
    if (!workForm.project_id) { toast(t.dtSelectProject_err, 'error'); return; }
    if (!workForm.start || !workForm.end) { toast(t.dtSetStartEnd, 'error'); return; }
    setSaving(true);
    try {
      const r = await api.post('/time-entries', {
        project_id: workForm.project_id,
        work_date: today,
        start_time: workForm.start,
        end_time: workForm.end,
        client_id: crypto.randomUUID(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      onEntryAdded(r.data);
      closeGap();
      toast(t.dtEntryAdded, 'success');
    } catch (err) {
      toast(err.response?.data?.error || t.failedSaveEntry, 'error');
    } finally { setSaving(false); }
  }

  async function addSwitch(gap) {
    if (!switchForm.p1 || !switchForm.p2) { toast(t.dtSelectBothProjects, 'error'); return; }
    if (!switchForm.split) { toast(t.dtSetSwitchTime, 'error'); return; }
    setSaving(true);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      await Promise.all([
        api.post('/time-entries', { project_id: switchForm.p1, work_date: today, start_time: minToHHMM(gap.start), end_time: switchForm.split, client_id: crypto.randomUUID(), timezone: tz }),
        api.post('/time-entries', { project_id: switchForm.p2, work_date: today, start_time: switchForm.split, end_time: minToHHMM(gap.end), client_id: crypto.randomUUID(), timezone: tz }),
      ]);
      await onRefresh();
      closeGap();
      toast(t.dtEntriesAdded, 'success');
    } catch (err) {
      toast(err.response?.data?.error || t.failedToSave, 'error');
    } finally { setSaving(false); }
  }

  // ── Entry delete ─────────────────────────────────────────────────────────────
  async function doDelete(entry) {
    setPendingDeleteEntry(null);
    setDeletingId(entry.id);
    try {
      await api.delete(`/time-entries/${entry.id}`);
      toast(t.dtEntryDeleted, 'success');
      onRefresh();
    } catch (err) {
      toast(err.response?.data?.error || t.failedDeleteEntry, 'error');
    } finally { setDeletingId(null); }
  }

  // ── Entry split actions ──────────────────────────────────────────────────────
  function openSplit(entry) {
    setActiveGapKey(null);
    setSplitId(entry.id);
    setSplitMode('break');
    const mid = minToHHMM(Math.round((strToMin(entry.start_time) + strToMin(entry.end_time)) / 2));
    setSplitBreakForm({ breakStart: mid, breakEnd: mid });
    setSplitSwitchForm({ at: mid, project_id: '' });
  }

  function closeSplit() { setSplitId(null); }

  async function doSplitBreak(entry) {
    const { breakStart, breakEnd } = splitBreakForm;
    if (!breakStart || !breakEnd) { toast(t.dtBreakStartEnd, 'error'); return; }
    if (breakStart >= entry.end_time.substring(0, 5) || breakEnd <= entry.start_time.substring(0, 5)) {
      toast(t.dtBreakWithin, 'error'); return;
    }
    if (breakEnd <= breakStart) { toast(t.dtBreakEndAfterStart, 'error'); return; }
    setSaving(true);
    try {
      const [patchRes, postRes] = await Promise.all([
        api.patch(`/time-entries/${entry.id}`, { start_time: entry.start_time, end_time: breakStart, notes: entry.notes, break_minutes: entry.break_minutes, mileage: entry.mileage }),
        api.post('/time-entries', {
          project_id: entry.project_id,
          work_date: today,
          start_time: breakEnd,
          end_time: entry.end_time,
          notes: entry.notes || undefined,
          client_id: crypto.randomUUID(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      ]);
      closeSplit();
      toast(t.dtBreakInserted, 'success');
      onRefresh();
    } catch (err) {
      toast(err.response?.data?.error || t.entryPanelFailedSplit, 'error');
    } finally { setSaving(false); }
  }

  async function doSplitSwitch(entry) {
    const { at, project_id } = splitSwitchForm;
    if (!at || !project_id) { toast(t.dtSetSwitchTimeAndProject, 'error'); return; }
    if (at <= entry.start_time.substring(0, 5) || at >= entry.end_time.substring(0, 5)) {
      toast(t.dtSwitchTimeMustBeWithin, 'error'); return;
    }
    setSaving(true);
    try {
      const [patchRes, postRes] = await Promise.all([
        api.patch(`/time-entries/${entry.id}`, { start_time: entry.start_time, end_time: at, notes: entry.notes, break_minutes: entry.break_minutes, mileage: entry.mileage }),
        api.post('/time-entries', {
          project_id,
          work_date: today,
          start_time: at,
          end_time: entry.end_time,
          client_id: crypto.randomUUID(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      ]);
      closeSplit();
      toast(t.dtProjectSwitchInserted, 'success');
      onRefresh();
    } catch (err) {
      toast(err.response?.data?.error || t.entryPanelFailedSplit, 'error');
    } finally { setSaving(false); }
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  if (segments === null) return null;

  const activeProjects = (projects || []).filter(p => p.active !== false);

  const isEmpty = segments.length === 0;

  return (
    <div style={s.card}>
      <div style={s.cardHeader}>Today's Timeline</div>

      {isEmpty ? (
        <p style={s.empty}>No activity recorded today yet.</p>
      ) : (
        <div style={s.timeline}>
          {segments.map((seg, i) => {
            const isLast = i === segments.length - 1;

            if (seg.type === 'entry') {
              const isSplitting = splitId === seg.entry.id;
              return (
                <div key={seg.entry.id} style={s.row}>
                  <div style={s.timeCol}>
                    <span style={s.timeLabel}>{minToDisplay(seg.start)}</span>
                  </div>
                  <div style={s.dotCol}>
                    <div style={s.dotGreen} />
                    {!isLast && <div style={s.line} />}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ ...s.block, background: '#ecfdf5', borderColor: '#6ee7b7' }}>
                      <div style={s.blockTop}>
                        <div>
                          <span style={s.blockTitle}>{seg.entry.project_name || `No ${workLabelLower}`}</span>
                          <span style={s.blockMeta}>{minToDisplay(seg.start)} – {minToDisplay(seg.end)} · {dur(seg.start, seg.end)}</span>
                          {seg.entry.status === 'approved' && <span style={s.badgeGreen}>Approved</span>}
                          {seg.entry.status === 'rejected' && <span style={s.badgeRed}>Rejected</span>}
                        </div>
                        {!seg.entry.locked && (
                          <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
                            <button style={s.splitBtn} onClick={() => isSplitting ? closeSplit() : openSplit(seg.entry)}>
                              {isSplitting ? 'Cancel' : '✂ Split'}
                            </button>
                            {pendingDeleteEntry?.id === seg.entry.id ? (
                              <>
                                <button style={{ ...s.confirmEntryDeleteBtn, ...(deletingId === seg.entry.id ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} aria-label={t.elConfirmDelete} onClick={() => doDelete(seg.entry)} disabled={deletingId === seg.entry.id}>✓</button>
                                <button style={s.cancelEntryDeleteBtn} aria-label={t.cancelDelete} onClick={() => setPendingDeleteEntry(null)}>✕</button>
                              </>
                            ) : (
                              <button style={{ ...s.deleteBtn, ...(deletingId === seg.entry.id ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} aria-label={t.deleteEntry} onClick={() => setPendingDeleteEntry(seg.entry)} disabled={deletingId === seg.entry.id}>✕</button>
                            )}
                          </div>
                        )}
                      </div>

                      {isSplitting && (
                        <div style={s.splitPanel}>
                          <div style={s.modeBtns}>
                            <button style={splitMode === 'break' ? s.modeBtnOn : s.modeBtn} onClick={() => setSplitMode('break')}>{t.dtInsertBreak}</button>
                            <button style={splitMode === 'switch' ? s.modeBtnOn : s.modeBtn} onClick={() => setSplitMode('switch')}>{workLabel} switch</button>
                          </div>

                          {splitMode === 'break' && (
                            <div style={s.form}>
                              <p style={s.hint}>Break times must fall within {minToDisplay(seg.start)} – {minToDisplay(seg.end)}.</p>
                              <div style={s.timeRow}>
                                <label htmlFor="dt-break-start" style={s.miniLabel}>{t.dtBreakStart}</label>
                                <input id="dt-break-start" type="time" style={s.timeInput} value={splitBreakForm.breakStart}
                                  onChange={e => setSplitBreakForm(f => ({ ...f, breakStart: e.target.value }))} />
                              </div>
                              <div style={s.timeRow}>
                                <label htmlFor="dt-break-end" style={s.miniLabel}>{t.dtBreakEnd}</label>
                                <input id="dt-break-end" type="time" style={s.timeInput} value={splitBreakForm.breakEnd}
                                  onChange={e => setSplitBreakForm(f => ({ ...f, breakEnd: e.target.value }))} />
                              </div>
                              <button style={{ ...s.addBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => doSplitBreak(seg.entry)} disabled={saving}>
                                {saving ? 'Saving...' : 'Insert break'}
                              </button>
                            </div>
                          )}

                          {splitMode === 'switch' && (
                            <div style={s.form}>
                              <p style={s.hint}>{t.dtSwitchHint}</p>
                              <div style={s.timeRow}>
                                <label htmlFor="dt-switch-at" style={s.miniLabel}>{t.dtSwitchAt}</label>
                                <input id="dt-switch-at" type="time" style={s.timeInput} value={splitSwitchForm.at}
                                  onChange={e => setSplitSwitchForm(f => ({ ...f, at: e.target.value }))} />
                              </div>
                              <select style={s.select} value={splitSwitchForm.project_id}
                                onChange={e => setSplitSwitchForm(f => ({ ...f, project_id: e.target.value }))}>
                                <option value="">Switch to {workLabelLower}...</option>
                                {activeProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                              </select>
                              <button style={{ ...s.addBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => doSplitSwitch(seg.entry)} disabled={saving}>
                                {saving ? t.saving : t.dtInsertSwitch}
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            }

            if (seg.type === 'gap') {
              const isBreak = breaks.has(seg.key);
              const isOpen = activeGapKey === seg.key;
              return (
                <div key={seg.key} style={s.row}>
                  <div style={s.timeCol} />
                  <div style={s.dotCol}>
                    <div style={s.dotGray} />
                    {!isLast && <div style={{ ...s.line, borderLeftStyle: 'dashed', borderLeftColor: '#d1d5db' }} />}
                  </div>
                  <div style={{ flex: 1 }}>
                    {isBreak ? (
                      <div style={{ ...s.gapChip, background: '#fff7ed', borderColor: '#fed7aa', color: '#92400e' }}>
                        ☕ Break · {dur(seg.start, seg.end)}
                      </div>
                    ) : isOpen ? (
                      <div style={s.gapExpanded}>
                        <div style={s.gapExpandedHeader}>
                          <span style={s.gapLabel}>Gap: {minToDisplay(seg.start)} – {minToDisplay(seg.end)} ({dur(seg.start, seg.end)})</span>
                          <button style={s.closeBtn} aria-label={t.labelModalClose} onClick={closeGap}>✕</button>
                        </div>

                        <div style={s.modeBtns}>
                          <button style={gapMode === 'work' ? s.modeBtnOn : s.modeBtn} onClick={() => setGapMode('work')}>{t.dtWorkPeriod}</button>
                          <button style={gapMode === 'break' ? s.modeBtnOn : s.modeBtn} onClick={() => setGapMode('break')}>{t.dtBreak}</button>
                          <button style={gapMode === 'switch' ? s.modeBtnOn : s.modeBtn} onClick={() => setGapMode('switch')}>{workLabel} switch</button>
                        </div>

                        {gapMode === 'work' && (
                          <div style={s.form}>
                            <select style={s.select} value={workForm.project_id}
                              onChange={e => setWorkForm(f => ({ ...f, project_id: e.target.value }))}>
                              <option value="">Select {workLabelLower}...</option>
                              {activeProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                            <div style={s.timeRow}>
                              <input type="time" style={s.timeInput} value={workForm.start}
                                onChange={e => setWorkForm(f => ({ ...f, start: e.target.value }))} />
                              <span style={s.dash}>–</span>
                              <input type="time" style={s.timeInput} value={workForm.end}
                                onChange={e => setWorkForm(f => ({ ...f, end: e.target.value }))} />
                            </div>
                            <button style={{ ...s.addBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={addWork} disabled={saving}>
                              {saving ? t.saving : t.dtAddEntry}
                            </button>
                          </div>
                        )}

                        {gapMode === 'break' && (
                          <div style={s.form}>
                            <p style={s.hint}>No time entry is created. The gap will be labeled as a break on this screen.</p>
                            <button style={s.addBtn} onClick={() => { setBreaks(prev => new Set([...prev, seg.key])); closeGap(); }}>
                              {t.dtMarkAsBreak}
                            </button>
                          </div>
                        )}

                        {gapMode === 'switch' && (
                          <div style={s.form}>
                            <p style={s.hint}>Split this gap between two {workLabelLower} entries at a switch time.</p>
                            <div style={s.switchRow}>
                              <select style={{ ...s.select, flex: 1 }} value={switchForm.p1}
                                onChange={e => setSwitchForm(f => ({ ...f, p1: e.target.value }))}>
                                <option value="">First {workLabelLower}...</option>
                                {activeProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                              </select>
                              <span style={s.switchArrow}>{minToDisplay(seg.start)} →</span>
                            </div>
                            <div style={s.switchRow}>
                              <input type="time" style={{ ...s.timeInput, flex: 1 }} value={switchForm.split}
                                onChange={e => setSwitchForm(f => ({ ...f, split: e.target.value }))} />
                              <span style={s.switchArrow}>switch</span>
                            </div>
                            <div style={s.switchRow}>
                              <select style={{ ...s.select, flex: 1 }} value={switchForm.p2}
                                onChange={e => setSwitchForm(f => ({ ...f, p2: e.target.value }))}>
                                <option value="">Second {workLabelLower}...</option>
                                {activeProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                              </select>
                              <span style={s.switchArrow}>→ {minToDisplay(seg.end)}</span>
                            </div>
                            <button style={{ ...s.addBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => addSwitch(seg)} disabled={saving}>
                              {saving ? t.saving : t.dtAddBothEntries}
                            </button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <button style={s.gapChip} onClick={() => openGap(seg)}>
                        + {dur(seg.start, seg.end)} unaccounted · tap to fill
                      </button>
                    )}
                  </div>
                </div>
              );
            }

            if (seg.type === 'active') {
              return (
                <div key="active" style={s.row}>
                  <div style={s.timeCol}>
                    <span style={s.timeLabel}>{minToDisplay(seg.start)}</span>
                  </div>
                  <div style={s.dotCol}>
                    <div style={s.dotBlue} />
                  </div>
                  <div style={{ ...s.block, background: '#eff6ff', borderColor: '#bfdbfe' }}>
                    <span style={s.blockTitle}>{seg.clockStatus.project_name || `No ${workLabelLower}`}</span>
                    <span style={s.blockMeta}>Clocked in · {dur(seg.start, nowMin)} in progress</span>
                  </div>
                </div>
              );
            }

            return null;
          })}
        </div>
      )}
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────
const s = {
  card: { background: '#fff', borderRadius: 12, padding: '18px 16px', boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 16 },
  cardHeader: { fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 14 },
  empty: { fontSize: 14, color: '#6b7280', margin: 0 },
  timeline: { display: 'flex', flexDirection: 'column' },
  row: { display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 10 },
  timeCol: { width: 62, textAlign: 'right', paddingTop: 5, flexShrink: 0 },
  timeLabel: { fontSize: 11, color: '#6b7280', fontVariantNumeric: 'tabular-nums' },
  dotCol: { display: 'flex', flexDirection: 'column', alignItems: 'center', width: 14, paddingTop: 5, flexShrink: 0 },
  dotGreen: { width: 10, height: 10, borderRadius: '50%', background: '#10b981', flexShrink: 0 },
  dotGray: { width: 10, height: 10, borderRadius: '50%', background: '#d1d5db', flexShrink: 0 },
  dotBlue: { width: 10, height: 10, borderRadius: '50%', background: '#3b82f6', boxShadow: '0 0 0 3px #bfdbfe', flexShrink: 0 },
  line: { width: 0, flex: 1, minHeight: 16, borderLeft: '2px solid #e5e7eb', marginTop: 2 },
  block: { flex: 1, border: '1px solid', borderRadius: 8, padding: '8px 12px' },
  blockTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  blockTitle: { display: 'block', fontSize: 14, fontWeight: 600, color: '#111827' },
  blockMeta: { display: 'block', fontSize: 12, color: '#6b7280', marginTop: 2 },
  badgeGreen: { display: 'inline-block', marginTop: 4, fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 10, background: '#d1fae5', color: '#065f46' },
  badgeRed: { display: 'inline-block', marginTop: 4, fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 10, background: '#fee2e2', color: '#991b1b' },
  splitBtn: { flexShrink: 0, padding: '3px 10px', background: 'none', border: '1px solid #d1d5db', color: '#6b7280', borderRadius: 6, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' },
  deleteBtn: { flexShrink: 0, padding: '3px 8px', background: 'none', border: '1px solid #fca5a5', color: '#ef4444', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  confirmEntryDeleteBtn: { flexShrink: 0, padding: '3px 8px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  cancelEntryDeleteBtn: { flexShrink: 0, padding: '3px 8px', background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  splitPanel: { marginTop: 10, paddingTop: 10, borderTop: '1px solid #e5e7eb' },
  gapChip: { display: 'block', width: '100%', textAlign: 'left', background: 'none', border: '1px dashed #d1d5db', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: '#6b7280', cursor: 'pointer' },
  gapExpanded: { border: '1px solid #d1d5db', borderRadius: 8, padding: 12, background: '#f9fafb' },
  gapExpandedHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  gapLabel: { fontSize: 12, fontWeight: 600, color: '#6b7280' },
  closeBtn: { background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', fontSize: 16, padding: 0, lineHeight: 1 },
  modeBtns: { display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' },
  modeBtn: { padding: '4px 12px', background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12, color: '#6b7280', cursor: 'pointer' },
  modeBtnOn: { padding: '4px 12px', background: '#1a56db', border: '1px solid #1a56db', borderRadius: 6, fontSize: 12, color: '#fff', cursor: 'pointer', fontWeight: 600 },
  form: { display: 'flex', flexDirection: 'column', gap: 8 },
  hint: { margin: 0, fontSize: 12, color: '#6b7280' },
  select: { padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, width: '100%', boxSizing: 'border-box' },
  timeRow: { display: 'flex', alignItems: 'center', gap: 8 },
  timeInput: { padding: '7px 8px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, flex: 1 },
  miniLabel: { fontSize: 12, color: '#6b7280', width: 76, flexShrink: 0 },
  dash: { color: '#6b7280', flexShrink: 0, fontSize: 14 },
  switchRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 },
  switchArrow: { fontSize: 11, color: '#6b7280', flexShrink: 0, whiteSpace: 'nowrap' },
  addBtn: { padding: '8px 16px', background: '#1a56db', color: '#fff', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer', alignSelf: 'flex-start' },
};
