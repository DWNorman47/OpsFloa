// Project Daily — pick a project scope (All projects or one project), then add, arrange,
// and role-scope the Checklist Builder checklists that seed each day's Daily Checklist.
// Each assignment carries a team-role scope (all / one / several) and a mode:
//   Shared     = one list everyone with a matching role shares (one change seen by all)
//   Individual = each matching person gets their own private copy
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { SkeletonList } from './Skeleton';
import ProjectScheduler from './ProjectScheduler';
import AssignmentCard from './AssignmentCard';
import { useDragReorder } from '../hooks/useDragReorder';

export default function ProjectDailySetup() {
  const t = useT();
  const [templates, setTemplates] = useState([]);
  const [projects, setProjects] = useState([]);
  const [roles, setRoles] = useState([]);
  const [scopeProject, setScopeProject] = useState(''); // '' = all projects
  const [viewMode, setViewMode] = useState('all'); // 'all' | 'daily' | 'schedule'
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addTemplateId, setAddTemplateId] = useState('');
  const [error, setError] = useState('');

  // The schedule a newly-added checklist gets, based on the day being viewed: pinned to
  // the day/date in a day view, otherwise left on no particular day.
  const addSchedule = () => {
    if (viewMode === 'daily') return { schedule_type: 'every' };
    return { schedule_type: 'none' };
  };

  // The items of each assigned checklist template, for the read-only preview column.
  const itemsByTemplate = useMemo(
    () => Object.fromEntries(templates.map(tp => [tp.id, Array.isArray(tp.items) ? tp.items : []])),
    [templates]
  );

  // Which assignments to show for the current day view: every-day defaults + the ones
  // specific to this day/date (a day view). "All checklists" shows everything.
  const visible = assignments.filter(a => {
    if (viewMode === 'daily') return a.schedule_type === 'every';
    return true;
  });

  useEffect(() => {
    Promise.all([
      api.get('/safety-checklists/templates').then(r => r.data || []).catch(() => []),
      api.get('/admin/projects').then(r => r.data || []).catch(() => []),
      api.get('/admin/roles').then(r => r.data || []).catch(() => []),
    ]).then(([tmpls, p, r]) => { setTemplates(tmpls); setProjects(p); setRoles(r); });
  }, []);

  const loadScope = useCallback(async (project) => {
    setLoading(true); setError('');
    try {
      const r = await api.get('/daily-checklist/assignments', { params: project ? { project_id: project } : {} });
      setAssignments(r.data.assignments || []);
    } catch { setAssignments([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadScope(scopeProject); }, [scopeProject, loadScope]);

  const addAssignment = async () => {
    if (!addTemplateId) return;
    setError('');
    try {
      await api.post('/daily-checklist/assignments', { template_id: Number(addTemplateId), project_id: scopeProject || null, ...addSchedule() });
      setAddTemplateId('');
      await loadScope(scopeProject);
    } catch (err) { setError(err.response?.data?.error || t.failedToSave); }
  };

  const patch = async (id, body) => {
    setAssignments(prev => prev.map(a => a.id === id ? { ...a, ...body } : a));
    try { await api.patch(`/daily-checklist/assignments/${id}`, body); }
    catch (err) { setError(err.response?.data?.error || t.failedToSave); loadScope(scopeProject); }
  };

  const remove = async (id) => {
    setAssignments(prev => prev.filter(a => a.id !== id));
    try { await api.delete(`/daily-checklist/assignments/${id}`); }
    catch { loadScope(scopeProject); }
  };

  const reorderList = async (from, to) => {
    if (from == null || to == null || from === to) return;
    const next = [...assignments];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setAssignments(next);
    try { await api.post('/daily-checklist/assignments/reorder', { order: next.map(a => a.id) }); }
    catch { loadScope(scopeProject); }
  };
  const dnd = useDragReorder(reorderList);

  return (
    <div>
      <div style={styles.topRow}>
        <div>
          <h2 style={styles.heading}>{t.pdTitle}</h2>
          <p style={styles.summary}>{t.pdSub}</p>
        </div>
      </div>

      <div style={styles.scopeBar}>
        <label style={styles.scopeBarLabel}>{t.pdProjectScope}</label>
        <select style={styles.projectSelect} value={scopeProject} onChange={e => setScopeProject(e.target.value)}>
          <option value="">{t.pdAllProjects}</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <label style={styles.scopeBarLabel}>{t.pdView}</label>
        <select style={styles.projectSelect} value={viewMode} onChange={e => setViewMode(e.target.value)}>
          <option value="all">{t.pdViewAll}</option>
          <option value="daily">{t.pdViewDaily}</option>
          <option value="schedule">{t.pdViewSchedule}</option>
        </select>
      </div>

      <p style={styles.hint}>{t.pdScopeHint}</p>

      {error && <p role="alert" style={styles.error}>{error}</p>}

      {viewMode === 'schedule' ? (
        scopeProject ? (
          <ProjectScheduler
            projectId={scopeProject}
            assignments={assignments}
            templates={templates}
            roles={roles}
            onAssignmentAdded={() => loadScope(scopeProject)}
          />
        ) : (
          <div style={styles.empty}><p style={styles.emptyText}>{t.pdSchedulePickProject}</p></div>
        )
      ) : (
      <>
      {templates.length === 0 ? (
        <div style={styles.empty}><p style={styles.emptyText}>{t.pdNoChecklists}</p></div>
      ) : (
        <div style={styles.addBar}>
          <select style={styles.addTemplateSelect} value={addTemplateId} onChange={e => setAddTemplateId(e.target.value)}>
            <option value="">{t.pdPickChecklist}</option>
            {templates.map(tp => <option key={tp.id} value={tp.id}>{tp.name}</option>)}
          </select>
          <button type="button" style={{ ...styles.addBtn, ...(addTemplateId ? {} : { opacity: 0.55, cursor: 'not-allowed' }) }} onClick={addAssignment} disabled={!addTemplateId}>
            + {t.pdAssignChecklist}
          </button>
        </div>
      )}

      {loading ? (
        <SkeletonList count={3} rows={2} />
      ) : visible.length === 0 ? (
        <div style={styles.empty}><p style={styles.emptyText}>{t.pdEmpty}</p></div>
      ) : (
        <div style={styles.list}>
          {visible.map((a, idx) => (
            <AssignmentCard
              key={a.id}
              a={a}
              roles={roles}
              items={itemsByTemplate[a.template_id] || []}
              onPatch={patch}
              onRemove={remove}
              collapsible
              {...(viewMode === 'all' ? { dragProps: dnd.dragProps(idx), isOver: dnd.isOver(idx) } : {})}
            />
          ))}
        </div>
      )}
      </>
      )}
    </div>
  );
}

const styles = {
  topRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12, gap: 12, flexWrap: 'wrap' },
  heading: { fontSize: 22, fontWeight: 800, color: '#111827', margin: 0 },
  summary: { fontSize: 13, color: '#6b7280', margin: '4px 0 0' },
  scopeBar: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' },
  scopeBarLabel: { fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' },
  projectSelect: { padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, background: '#fff', minWidth: 220 },
  hint: { fontSize: 12, color: '#6b7280', background: '#f9fafb', border: '1px solid #eef2f7', borderRadius: 8, padding: '8px 12px', lineHeight: 1.5, margin: '0 0 16px' },
  addBar: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 },
  addTemplateSelect: { padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, background: '#fff', minWidth: 220, flex: 1, maxWidth: 360 },
  addBtn: { background: '#059669', color: '#fff', border: 'none', padding: '9px 18px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer', flexShrink: 0 },
  list: { display: 'flex', flexDirection: 'column', gap: 12 },
  card: { background: '#fff', borderRadius: 12, boxShadow: '0 1px 6px rgba(0,0,0,0.07)', padding: 16 },
  cardHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 },
  cardHeadLeft: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 },
  arrows: { display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 },
  arrow: { border: '1px solid #e5e7eb', background: '#f9fafb', color: '#6b7280', borderRadius: 5, width: 24, height: 18, fontSize: 9, lineHeight: 1, cursor: 'pointer', padding: 0 },
  arrowOff: { opacity: 0.35, cursor: 'not-allowed' },
  cardTitle: { fontWeight: 700, fontSize: 15, color: '#111827' },
  cardMeta: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  removeBtn: { background: 'none', border: '1px solid #fca5a5', color: '#ef4444', padding: '5px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', flexShrink: 0 },
  twoCol: { display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-start' },
  controlsCol: { display: 'flex', flexDirection: 'column', gap: 14, flex: '1 1 240px', minWidth: 220 },
  itemsCol: { flex: '2 1 300px', minWidth: 240, background: '#f9fafb', border: '1px solid #eef2f7', borderRadius: 8, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6 },
  itemsList: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 },
  itemRow: { display: 'flex', alignItems: 'flex-start', gap: 8 },
  itemKind: { fontSize: 13, color: '#9ca3af', flexShrink: 0, marginTop: 1, width: 14, textAlign: 'center' },
  itemLabel: { fontSize: 13, color: '#374151', lineHeight: 1.4 },
  itemsEmpty: { fontSize: 13, color: '#9ca3af', fontStyle: 'italic', margin: '4px 0 0' },
  scopeCell: { display: 'flex', flexDirection: 'column', gap: 6 },
  scopeLabel: { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' },
  scopeRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  scheduleRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  smallSelect: { padding: '7px 8px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, background: '#fff' },
  dayNumInput: { padding: '7px 8px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, width: 64 },
  carryLabel: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#374151', cursor: 'pointer', lineHeight: 1.4 },
  allTag: { fontSize: 12, fontWeight: 600, color: '#374151', background: '#f3f4f6', padding: '4px 10px', borderRadius: 12 },
  chip: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600, color: '#1d4ed8', background: '#eff6ff', border: '1px solid #bfdbfe', padding: '3px 6px 3px 10px', borderRadius: 12 },
  chipX: { border: 'none', background: 'none', color: '#1d4ed8', cursor: 'pointer', fontSize: 11, padding: 0, lineHeight: 1 },
  addSelect: { padding: '5px 8px', border: '1px dashed #cbd5e1', borderRadius: 8, fontSize: 12, background: '#fff', color: '#6b7280', cursor: 'pointer' },
  modeToggle: { display: 'inline-flex', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', width: 'fit-content' },
  modeBtn: { border: 'none', background: '#fff', color: '#6b7280', padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  modeBtnOn: { background: '#059669', color: '#fff' },
  empty: { textAlign: 'center', padding: '40px 20px' },
  emptyText: { color: '#6b7280', fontSize: 15 },
  error: { color: '#ef4444', fontSize: 13, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', margin: '0 0 12px' },
};
