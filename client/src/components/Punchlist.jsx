import React, { useState, useEffect, useMemo } from 'react';
import api from '../api';
import { useAuth } from '../contexts/AuthContext';
import { langToLocale } from '../utils';
import { useOffline } from '../contexts/OfflineContext';
import { useT } from '../hooks/useT';
import { useToast } from '../contexts/ToastContext';
import { SkeletonList } from './Skeleton';
import Pagination from './Pagination';
import FieldFilters from './FieldFilters';
import { labelSg } from '../companyLabels';

const STATUS_COLORS = {
  open: { color: '#92400e', bg: '#fef3c7' },
  in_progress: { color: '#1e40af', bg: '#dbeafe' },
  resolved: { color: '#1e40af', bg: '#dbeafe' },
  done: { color: '#1e40af', bg: '#dbeafe' },
  verified: { color: '#065f46', bg: '#d1fae5' },
};

const PUNCHLIST_STATUSES = ['open', 'in_progress', 'resolved', 'verified'];

function statusStyle(status) {
  const c = STATUS_COLORS[status] || STATUS_COLORS.open;
  return { color: c.color, background: c.bg };
}

function statusLabel(status, t) {
  if (status === 'in_progress') return t.statusInProgress || 'In Progress';
  if (status === 'resolved' || status === 'done') return t.statusDone;
  if (status === 'verified') return `${t.statusVerified} ✓`;
  return t.statusOpen;
}

function AddItemForm({ projects, workers, onAdded, onCancel, isAdmin, existingPhases, workerLabel = 'Worker', defaultProjectId = null }) {
  const t = useT();
  const PRIORITIES = [
    { value: 'high', label: `🔴 ${t.priorityHigh}` },
    { value: 'normal', label: `🟡 ${t.priorityNormal}` },
    { value: 'low', label: `⚪ ${t.priorityLow}` },
  ];
  const [form, setForm] = useState({ title: '', description: '', location: '', project_id: defaultProjectId ? String(defaultProjectId) : '', priority: 'normal', assigned_to: '', phase: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async e => {
    e.preventDefault();
    if (!form.title.trim()) { setError(t.titleRequired); return; }
    setSaving(true); setError('');
    try {
      const r = await api.post('/punchlist', form);
      if (r.data?.offline) {
        onAdded({ id: 'pending-' + Date.now(), pending: true, ...form, status: 'open' });
      } else {
        onAdded(r.data);
      }
    } catch (err) {
      setError(err.response?.data?.error || t.failedToSave);
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={submit} style={styles.form}>
      <h3 style={styles.formTitle}>{t.newPunchlistItemForm}</h3>
      <div style={styles.formGrid}>
        <div style={{ ...styles.fieldGroup, gridColumn: '1 / -1' }}>
          <label htmlFor="pl-title" style={styles.label}>{t.titleField} *</label>
          <input id="pl-title" style={styles.input} type="text" placeholder={t.punchlistTitlePlaceholder} maxLength={255} value={form.title} onChange={e => set('title', e.target.value)} />
        </div>
        {projects.length > 0 && (
          <div style={styles.fieldGroup}>
            <label htmlFor="pl-project" style={styles.label}>Project</label>
            <select id="pl-project" style={styles.input} value={form.project_id} onChange={e => set('project_id', e.target.value)}>
              <option value="">{`No project`}</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
        <div style={styles.fieldGroup}>
          <label htmlFor="pl-priority" style={styles.label}>{t.priorityField}</label>
          <select id="pl-priority" style={styles.input} value={form.priority} onChange={e => set('priority', e.target.value)}>
            {PRIORITIES.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        {isAdmin && workers.length > 0 && (
          <div style={styles.fieldGroup}>
            <label htmlFor="pl-assign-to" style={styles.label}>{`${t.assignTo} ${workerLabel.toLowerCase()}`}</label>
            <select id="pl-assign-to" style={styles.input} value={form.assigned_to} onChange={e => set('assigned_to', e.target.value)}>
              <option value="">{t.unassigned}</option>
              {workers.map(w => <option key={w.id} value={w.id}>{w.full_name}</option>)}
            </select>
          </div>
        )}
        <div style={styles.fieldGroup}>
          <label htmlFor="pl-phase" style={styles.label}>{t.phaseField}</label>
          <input id="pl-phase" style={styles.input} type="text" list="phase-suggestions" placeholder={t.punchlistPhasePlaceholder} maxLength={255} value={form.phase} onChange={e => set('phase', e.target.value)} />
          <datalist id="phase-suggestions">
            {existingPhases.map(p => <option key={p} value={p} />)}
          </datalist>
        </div>
        <div style={styles.fieldGroup}>
          <label htmlFor="pl-location" style={styles.label}>{t.locationField}</label>
          <input id="pl-location" style={styles.input} type="text" placeholder={t.punchlistLocationPlaceholder} maxLength={255} value={form.location} onChange={e => set('location', e.target.value)} />
        </div>
        <div style={{ ...styles.fieldGroup, gridColumn: '1 / -1' }}>
          <label htmlFor="pl-description" style={styles.label}>{t.descriptionField}</label>
          <textarea id="pl-description" style={styles.textarea} rows={3} placeholder={t.punchlistDetailPlaceholder} maxLength={1000} value={form.description} onChange={e => set('description', e.target.value)} />
          <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{(form.description || '').length}/1000</div>
        </div>
      </div>
      {error && <p role="alert" style={styles.error}>{error}</p>}
      <div style={styles.formActions}>
        <button style={{ ...styles.submitBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={saving}>{saving ? t.saving : t.addItem}</button>
        <button style={styles.cancelBtn} type="button" onClick={onCancel}>{t.cancel}</button>
      </div>
    </form>
  );
}

function PunchItem({ item: initialItem, isAdmin, workers, onUpdated, onDeleted, existingPhases }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const toast = useToast();
  const [item, setItem] = useState(initialItem);
  const [expanded, setExpanded] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [checklist, setChecklist] = useState(null); // null = not loaded
  const [newCheckText, setNewCheckText] = useState('');
  const [addingCheck, setAddingCheck] = useState(false);
  const [editPhase, setEditPhase] = useState(initialItem.phase || '');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => { setItem(initialItem); setEditPhase(initialItem.phase || ''); }, [initialItem]);

  const nextStatus = { open: 'resolved', in_progress: 'resolved', resolved: 'verified', done: 'verified', verified: 'open' };
  const nextLabel = { open: t.markDone, in_progress: t.markDone, resolved: t.verify, done: t.verify, verified: t.reopen };

  const handleExpand = () => {
    if (item.pending) return;
    const next = !expanded;
    setExpanded(next);
    if (next && checklist === null) {
      api.get(`/punchlist/${item.id}/checklist`).then(r => setChecklist(r.data)).catch(() => setChecklist([]));
    }
  };

  const advance = async () => {
    const status = nextStatus[item.status] || 'resolved';
    setUpdating(true);
    try {
      const r = await api.patch(`/punchlist/${item.id}`, { status });
      onUpdated(r.data);
    } catch { toast(t.failedUpdateStatus, 'error'); }
    finally { setUpdating(false); }
  };

  const assignTo = async workerId => {
    try {
      const r = await api.patch(`/punchlist/${item.id}`, { assigned_to: workerId || null });
      onUpdated(r.data);
    } catch { toast(t.failedAssignWorker, 'error'); }
  };

  const savePhase = async () => {
    const val = editPhase.trim() || null;
    if (val === (item.phase || null)) return;
    try {
      const r = await api.patch(`/punchlist/${item.id}`, { phase: val });
      onUpdated(r.data);
    } catch { toast(t.failedSavePhase, 'error'); }
  };

  const handleDelete = async () => {
    try { await api.delete(`/punchlist/${item.id}`); onDeleted(item.id); }
    catch { toast(t.failedDeleteItem, 'error'); }
  };

  const toggleCheck = async (checkId, checked) => {
    try {
      const r = await api.patch(`/punchlist/${item.id}/checklist/${checkId}`, { checked });
      setChecklist(prev => prev.map(c => c.id === checkId ? r.data : c));
      const newDone = checklist.filter(c => c.id === checkId ? checked : c.checked).length;
      setItem(it => ({ ...it, checked_count: newDone }));
    } catch { toast(t.failedUpdateChecklist, 'error'); }
  };

  const deleteCheck = async checkId => {
    try {
      await api.delete(`/punchlist/${item.id}/checklist/${checkId}`);
      const updated = checklist.filter(c => c.id !== checkId);
      setChecklist(updated);
      const newDone = updated.filter(c => c.checked).length;
      setItem(it => ({ ...it, checklist_total: updated.length, checked_count: newDone }));
    } catch { toast(t.failedDeleteChecklistItem, 'error'); }
  };

  const addCheck = async e => {
    e.preventDefault();
    if (!newCheckText.trim()) return;
    setAddingCheck(true);
    try {
      const r = await api.post(`/punchlist/${item.id}/checklist`, { text: newCheckText.trim() });
      setChecklist(prev => [...(prev || []), r.data]);
      setItem(it => ({ ...it, checklist_total: parseInt(it.checklist_total || 0) + 1 }));
      setNewCheckText('');
    } catch { toast(t.failedAddChecklistItem, 'error'); }
    finally { setAddingCheck(false); }
  };

  const priorityDot = { high: 'High', normal: 'Normal', low: 'Low' }[item.priority] || 'Normal';
  const checkTotal = parseInt(item.checklist_total || 0);
  const checkDone = parseInt(item.checked_count || 0);

  return (
    <div style={{ ...styles.item, opacity: item.status === 'verified' ? 0.65 : 1 }}>
      <div style={styles.itemRow} onClick={handleExpand} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && handleExpand()}>
        <span style={{ ...styles.priorityDot, ...styles[`priority_${item.priority}`] }} title={`Priority: ${item.priority}`}>{priorityDot}</span>
        <div style={styles.itemMain}>
          <span style={{ ...styles.itemTitle, textDecoration: item.status === 'verified' ? 'line-through' : 'none' }}>
            {item.title}
            {item.pending && <span style={styles.pendingBadge}>⏳ {t.pendingSync}</span>}
          </span>
          <div style={styles.itemMeta}>
            {item.project_name && <span style={styles.metaTag}>{item.project_name}</span>}
            {item.phase && <span style={styles.phaseTag}>{item.phase}</span>}
            {item.location && <span style={styles.metaLoc}>At {item.location}</span>}
            {item.assigned_to_name && <span style={styles.metaAssign}>Assigned to {item.assigned_to_name}</span>}
            {checkTotal > 0 && (
              <span style={{ ...styles.checkProgress, ...(checkDone === checkTotal ? styles.checkProgressDone : {}) }}>
                {checkDone}/{checkTotal} done
              </span>
            )}
          </div>
        </div>
        <div style={styles.itemRight}>
          <span style={{ ...styles.statusBadge, ...statusStyle(item.status) }}>
            {statusLabel(item.status, t)}
          </span>
          <span style={styles.chevron}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div style={styles.itemBody}>
          {item.description && <p style={styles.desc}>{item.description}</p>}
          {item.resolved_at && item.status === 'verified' && (
            <p style={styles.resolvedNote}>{t.verifiedOn} {new Date(item.resolved_at).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })}</p>
          )}

          {/* Phase edit */}
          <div style={styles.phaseEditRow}>
            <label htmlFor="pl-edit-phase" style={styles.label}>{t.phaseField}</label>
            <input
              id="pl-edit-phase"
              style={styles.phaseInput}
              type="text"
              list="phase-suggestions"
              placeholder={t.phaseEditPlaceholder}
              maxLength={255}
              value={editPhase}
              onChange={e => setEditPhase(e.target.value)}
              onBlur={savePhase}
              onKeyDown={e => { if (e.key === 'Enter') { e.target.blur(); } }}
            />
          </div>

          {/* Checklist */}
          <div style={styles.checklistSection}>
            {checklist === null ? (
              <p style={styles.checklistLoading}>{t.loading}</p>
            ) : (
              <>
                {checklist.length > 0 && (
                  <div style={styles.checklistItems}>
                    {checklist.map(c => (
                      <div key={c.id} style={styles.checkRow}>
                        <input
                          type="checkbox"
                          checked={c.checked}
                          onChange={e => toggleCheck(c.id, e.target.checked)}
                          style={styles.checkbox}
                        />
                        <span style={{ ...styles.checkText, textDecoration: c.checked ? 'line-through' : 'none', color: c.checked ? '#9ca3af' : '#374151' }}>
                          {c.text}
                        </span>
                        <button style={styles.checkDeleteBtn} aria-label={t.deleteChecklistItem} onClick={() => deleteCheck(c.id)}>✕</button>
                      </div>
                    ))}
                  </div>
                )}
                <form onSubmit={addCheck} style={styles.addCheckForm}>
                  <input
                    style={styles.checkInput}
                    type="text"
                    placeholder={checklist.length === 0 ? t.addChecklistPlaceholder : t.addChecklistItemPlaceholder}
                    value={newCheckText}
                    onChange={e => setNewCheckText(e.target.value)}
                  />
                  {newCheckText.trim() && (
                    <button type="submit" style={{ ...styles.checkAddBtn, ...(addingCheck ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} disabled={addingCheck}>{t.add}</button>
                  )}
                </form>
              </>
            )}
          </div>

          {isAdmin && (
            <div style={styles.assignRow}>
              <label htmlFor="pl-edit-assign" style={styles.label}>{t.assignTo}: </label>
              <select id="pl-edit-assign" style={styles.smallSelect} value={item.assigned_to || ''} onChange={e => assignTo(e.target.value)}>
                <option value="">{t.unassigned}</option>
                {workers.map(w => <option key={w.id} value={w.id}>{w.full_name}</option>)}
              </select>
            </div>
          )}
          <div style={styles.itemActions}>
            <button style={{ ...styles.advanceBtn, ...(updating ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={advance} disabled={updating}>
              {updating ? t.saving : nextLabel[item.status] || t.markDone}
            </button>
            {confirmingDelete ? (
              <>
                <button style={styles.confirmDeleteBtn} onClick={handleDelete}>{t.confirm}</button>
                <button style={styles.cancelDeleteBtn} onClick={() => setConfirmingDelete(false)}>{t.cancel}</button>
              </>
            ) : (
              <button style={styles.deleteBtn} onClick={() => setConfirmingDelete(true)}>{t.delete}</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Punchlist({ projects, settings = null, activeProject = '', onProjectChange }) {
  const t = useT();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const { onSync } = useOffline() || {};
  const workerLabel = labelSg(settings?.label_worker, 'worker', user?.language);
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [pdfGenerating, setPdfGenerating] = useState(false);

  const downloadPDF = async () => {
    setPdfGenerating(true);
    try {
      const [{ pdf }, { PunchlistDocument }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('./PunchlistPDF'),
      ]);
      const blob = await pdf(React.createElement(PunchlistDocument, { items, companyName: user?.company_name, t, language: user?.language, settings })).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'punchlist.pdf'; a.click();
      URL.revokeObjectURL(url);
    } finally { setPdfGenerating(false); }
  };
  const [filterProject, setFilterProject] = useState(activeProject != null ? String(activeProject) : '');
  useEffect(() => { setFilterProject(activeProject != null ? String(activeProject) : ''); }, [activeProject]);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterPhase, setFilterPhase] = useState('');

  const load = async (proj = filterProject, stat = filterStatus, ph = filterPhase, p = 1) => {
    setPage(p);
    try {
      const params = { page: p, limit: 50 };
      if (proj) params.project_id = proj;
      if (stat) params.status = stat;
      if (ph) params.phase = ph;
      const r = await api.get('/punchlist', { params });
      setItems(r.data.items);
      setTotalPages(r.data.pages);
    } finally { setLoading(false); }
  };

  useEffect(() => {
    const init = async () => {
      if (isAdmin) {
        try {
          const w = await api.get('/admin/workers');
          setWorkers(w.data);
        } catch {
          setWorkers([]);
        }
      }
      await load();
    };
    init();
  }, []);

  useEffect(() => { if (!loading) load(filterProject, filterStatus, filterPhase, 1); }, [filterProject, filterStatus, filterPhase]);
  useEffect(() => { if (!onSync) return; return onSync(count => { if (count > 0) load(filterProject, filterStatus, filterPhase, page); }); }, [onSync]);

  const { openCount, inProgressCount, doneCount, verifiedCount } = useMemo(() => ({
    openCount: items.filter(i => i.status === 'open').length,
    inProgressCount: items.filter(i => i.status === 'in_progress').length,
    doneCount: items.filter(i => i.status === 'resolved' || i.status === 'done').length,
    verifiedCount: items.filter(i => i.status === 'verified').length,
  }), [items]);

  // All unique phases across current items (for datalist + filter dropdown)
  const allPhases = useMemo(() => [...new Set(items.map(i => i.phase).filter(Boolean))].sort(), [items]);
  const hasPhases = useMemo(() => items.some(i => i.phase), [items]);
  const activeFilterCount = [filterProject, filterStatus, filterPhase].filter(Boolean).length;

  // Group items by phase when any have a phase set
  const grouped = useMemo(() => {
    if (!hasPhases) return [{ phase: null, items }];
    return [
      ...allPhases.map(ph => ({ phase: ph, items: items.filter(i => i.phase === ph) })),
      ...(items.some(i => !i.phase) ? [{ phase: null, items: items.filter(i => !i.phase) }] : []),
    ];
  }, [items, allPhases, hasPhases]);

  return (
    <div>
      <div style={styles.topRow}>
        <div>
          <h2 style={styles.heading}>{t.punchlistTitle}</h2>
          {items.length > 0 && (
            <p style={styles.summary}>
              {openCount} {t.statusOpen} · {inProgressCount} {t.statusInProgress || 'In Progress'} · {doneCount} {t.statusDone} · {verifiedCount} {t.statusVerified}
            </p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {items.length > 0 && <button style={{ ...styles.pdfBtn, ...(pdfGenerating ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={downloadPDF} disabled={pdfGenerating}>{pdfGenerating ? t.preparing : t.exportPDF}</button>}
          <button style={styles.newBtn} onClick={() => setShowForm(true)}>{t.newPunchlistItem}</button>
        </div>
      </div>

      {showForm && (
        <div style={styles.formCard}>
          <AddItemForm
            projects={projects}
            workers={workers}
            isAdmin={isAdmin}
            existingPhases={allPhases}
            workerLabel={workerLabel}
            defaultProjectId={activeProject}
            onAdded={item => { setItems(prev => [item, ...prev]); setShowForm(false); }}
            onCancel={() => setShowForm(false)}
          />
        </div>
      )}

      <FieldFilters activeCount={activeFilterCount}>
        <select style={styles.filterSelect} value={filterProject} onChange={e => { setFilterProject(e.target.value); onProjectChange?.(e.target.value); }}>
          <option value="">{`All Projects`}</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select style={styles.filterSelect} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          <option value="">{t.allStatuses}</option>
          {PUNCHLIST_STATUSES.map(status => (
            <option key={status} value={status}>{statusLabel(status, t)}</option>
          ))}
        </select>
        {allPhases.length > 0 && (
          <select style={styles.filterSelect} value={filterPhase} onChange={e => setFilterPhase(e.target.value)}>
            <option value="">{t.allPhases}</option>
            {allPhases.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
      </FieldFilters>

      {loading ? (
        <SkeletonList count={4} rows={2} />
      ) : items.length === 0 ? (
        <div style={styles.empty}>
          <p style={styles.emptyText}>{t.noPunchlistItems} {t.punchlistEmptyDesc}</p>
        </div>
      ) : (
        <div>
          {grouped.map(({ phase, items: groupItems }) => (
            <div key={phase || '__none__'} style={{ marginBottom: hasPhases ? 20 : 0 }}>
              {hasPhases && (
                <div style={styles.phaseGroupHeader}>
                  {phase || <span style={{ fontStyle: 'italic', color: '#6b7280' }}>{t.noPhase}</span>}
                  <span style={styles.phaseGroupCount}>{groupItems.length}</span>
                </div>
              )}
              <div style={styles.list}>
                {groupItems.map(item => (
                  <PunchItem
                    key={item.id}
                    item={item}
                    isAdmin={isAdmin}
                    workers={workers}
                    existingPhases={allPhases}
                    onUpdated={updated => setItems(prev => prev.map(i => i.id === updated.id ? updated : i))}
                    onDeleted={id => setItems(prev => prev.filter(i => i.id !== id))}
                  />
                ))}
              </div>
            </div>
          ))}
          <Pagination page={page} pages={totalPages} onChange={p => load(filterProject, filterStatus, filterPhase, p)} />
        </div>
      )}
    </div>
  );
}

const styles = {
  topRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' },
  heading: { fontSize: 22, fontWeight: 800, color: '#111827', margin: 0 },
  summary: { fontSize: 13, color: '#6b7280', margin: '4px 0 0' },
  newBtn: { background: '#059669', color: '#fff', border: 'none', padding: '10px 18px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer', flexShrink: 0 },
  pdfBtn: { fontSize: 13, fontWeight: 600, color: 'var(--ops-page-accent)', background: '#eff6ff', border: '1px solid #bfdbfe', padding: '9px 16px', borderRadius: 8, textDecoration: 'none', cursor: 'pointer', flexShrink: 0 },
  filters: { display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' },
  filterSelect: { padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, background: '#fff', flex: 1, minWidth: 140 },
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  item: { background: '#fff', borderRadius: 10, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', overflow: 'hidden' },
  itemRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', cursor: 'pointer' },
  priorityDot: { fontSize: 10, flexShrink: 0, minWidth: 48, textAlign: 'center', borderRadius: 999, padding: '3px 7px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0 },
  priority_high: { background: '#fee2e2', color: '#991b1b' },
  priority_normal: { background: '#fef3c7', color: '#92400e' },
  priority_low: { background: '#f1f5f9', color: '#475569' },
  itemMain: { flex: 1, minWidth: 0 },
  itemTitle: { fontWeight: 600, fontSize: 14, color: '#111827', display: 'block', marginBottom: 4 },
  itemMeta: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  pendingBadge: { fontSize: 10, fontWeight: 600, color: '#92400e', background: '#fef3c7', padding: '1px 6px', borderRadius: 6, marginLeft: 6, verticalAlign: 'middle' },
  metaTag: { background: '#ede9fe', color: '#6d28d9', padding: '1px 7px', borderRadius: 10, fontWeight: 600, fontSize: 11 },
  phaseTag: { background: '#e0f2fe', color: '#0369a1', padding: '1px 7px', borderRadius: 10, fontWeight: 600, fontSize: 11 },
  metaLoc: { fontSize: 12, color: '#6b7280' },
  metaAssign: { fontSize: 12, color: '#6b7280' },
  itemRight: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  statusBadge: { fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 10 },
  chevron: { fontSize: 10, color: '#6b7280' },
  itemBody: { padding: '0 14px 14px', borderTop: '1px solid #f3f4f6' },
  desc: { fontSize: 13, color: '#374151', lineHeight: 1.6, margin: '10px 0', whiteSpace: 'pre-wrap' },
  resolvedNote: { fontSize: 12, color: '#059669', margin: '0 0 10px', fontWeight: 600 },
  phaseEditRow: { display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 12, marginTop: 8 },
  phaseInput: { padding: '6px 9px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, background: '#f9fafb', width: '100%', boxSizing: 'border-box' },
  phaseGroupHeader: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 800, color: '#0369a1', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8, paddingBottom: 4, borderBottom: '2px solid #e0f2fe' },
  phaseGroupCount: { fontSize: 11, fontWeight: 700, color: '#fff', background: '#0369a1', padding: '1px 7px', borderRadius: 10 },
  assignRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
  smallSelect: { padding: '5px 8px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12, background: '#fff' },
  itemActions: { display: 'flex', gap: 8 },
  advanceBtn: { background: '#059669', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' },
  deleteBtn: { background: 'none', border: '1px solid #fca5a5', color: '#ef4444', padding: '6px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  confirmDeleteBtn: { background: '#ef4444', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  cancelDeleteBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '6px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  // Form
  formCard: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 20 },
  form: { display: 'flex', flexDirection: 'column', gap: 14 },
  formTitle: { fontSize: 17, fontWeight: 700, margin: 0 },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 12, fontWeight: 600, color: '#6b7280' },
  input: { padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, width: '100%' },
  textarea: { padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5, width: '100%' },
  error: { color: '#ef4444', fontSize: 13, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', margin: 0 },
  formActions: { display: 'flex', gap: 10 },
  submitBtn: { background: '#059669', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  cancelBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '10px 20px', borderRadius: 8, fontSize: 14, cursor: 'pointer' },
  // Checklist
  checkProgress: { fontSize: 11, fontWeight: 600, color: '#6b7280', background: '#f3f4f6', padding: '1px 7px', borderRadius: 10 },
  checkProgressDone: { color: '#065f46', background: '#d1fae5' },
  checklistSection: { marginBottom: 12 },
  checklistLoading: { fontSize: 12, color: '#6b7280', margin: '8px 0' },
  checklistItems: { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 },
  checkRow: { display: 'flex', alignItems: 'center', gap: 8 },
  checkbox: { width: 16, height: 16, cursor: 'pointer', flexShrink: 0, accentColor: '#059669' },
  checkText: { flex: 1, fontSize: 13, lineHeight: 1.4 },
  checkDeleteBtn: { background: 'none', border: 'none', color: '#d1d5db', fontSize: 12, cursor: 'pointer', padding: '0 2px', lineHeight: 1, flexShrink: 0 },
  addCheckForm: { display: 'flex', gap: 6, alignItems: 'center' },
  checkInput: { flex: 1, padding: '6px 9px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, background: '#f9fafb' },
  checkAddBtn: { padding: '6px 12px', background: '#059669', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  // Empty / misc
  empty: { textAlign: 'center', padding: '60px 20px' },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyText: { color: '#6b7280', fontSize: 15 },
  hint: { color: '#6b7280', fontSize: 14 },
};
