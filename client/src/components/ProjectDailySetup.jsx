// Project Daily — pick a project scope (All projects or one project), then add, arrange,
// and role-scope the Checklist Builder checklists that seed each day's Daily Checklist.
// Each assignment carries a team-role scope (all / one / several) and a mode:
//   Shared     = one list everyone with a matching role shares (one change seen by all)
//   Individual = each matching person gets their own private copy
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { SkeletonList } from './Skeleton';

// A role scope picker: "All types" until you add specific roles; chips + Add after.
function RolePicker({ allLabel, addLabel, options, selected, onChange }) {
  const ids = Array.isArray(selected) && selected.length ? selected.map(String) : null;
  const nameById = useMemo(() => Object.fromEntries(options.map(o => [String(o.id), o.name])), [options]);
  const remaining = options.filter(o => !ids || !ids.includes(String(o.id)));
  const add = id => { if (id) onChange([...(ids || []), id].map(Number)); };
  const remove = id => {
    const next = (ids || []).filter(x => x !== String(id)).map(Number);
    onChange(next.length ? next : null); // empty → back to All
  };
  return (
    <div style={styles.scopeRow}>
      {!ids ? (
        <span style={styles.allTag}>{allLabel}</span>
      ) : (
        ids.map(id => (
          <span key={id} style={styles.chip}>
            {nameById[id] || id}
            <button type="button" style={styles.chipX} aria-label="Remove" onClick={() => remove(id)}>✕</button>
          </span>
        ))
      )}
      {remaining.length > 0 && (
        <select style={styles.addSelect} value="" onChange={e => { add(e.target.value); e.target.value = ''; }}>
          <option value="">+ {addLabel}</option>
          {remaining.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      )}
    </div>
  );
}

export default function ProjectDailySetup() {
  const t = useT();
  const [templates, setTemplates] = useState([]);
  const [projects, setProjects] = useState([]);
  const [roles, setRoles] = useState([]);
  const [scopeProject, setScopeProject] = useState(''); // '' = all projects
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addTemplateId, setAddTemplateId] = useState('');
  const [error, setError] = useState('');

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
      await api.post('/daily-checklist/assignments', { template_id: Number(addTemplateId), project_id: scopeProject || null });
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

  const move = async (idx, dir) => {
    const next = [...assignments];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    setAssignments(next);
    try { await api.post('/daily-checklist/assignments/reorder', { order: next.map(a => a.id) }); }
    catch { loadScope(scopeProject); }
  };

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
      </div>

      <p style={styles.hint}>{t.pdScopeHint}</p>

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

      {error && <p role="alert" style={styles.error}>{error}</p>}

      {loading ? (
        <SkeletonList count={3} rows={2} />
      ) : assignments.length === 0 ? (
        <div style={styles.empty}><p style={styles.emptyText}>{t.pdEmpty}</p></div>
      ) : (
        <div style={styles.list}>
          {assignments.map((a, idx) => (
            <div key={a.id} style={styles.card}>
              <div style={styles.cardHead}>
                <div style={styles.cardHeadLeft}>
                  <div style={styles.arrows}>
                    <button type="button" style={{ ...styles.arrow, ...(idx === 0 ? styles.arrowOff : {}) }} aria-label={t.pdMoveUp} disabled={idx === 0} onClick={() => move(idx, -1)}>▲</button>
                    <button type="button" style={{ ...styles.arrow, ...(idx === assignments.length - 1 ? styles.arrowOff : {}) }} aria-label={t.pdMoveDown} disabled={idx === assignments.length - 1} onClick={() => move(idx, 1)}>▼</button>
                  </div>
                  <div>
                    <div style={styles.cardTitle}>{a.template_name}</div>
                    <div style={styles.cardMeta}>{a.item_count} {t.itemsCount}</div>
                  </div>
                </div>
                <button type="button" style={styles.removeBtn} onClick={() => remove(a.id)}>{t.delete}</button>
              </div>

              <div style={styles.scopeGrid}>
                <div style={styles.scopeCell}>
                  <div style={styles.scopeLabel}>{t.pdTypeScope}</div>
                  <RolePicker
                    allLabel={t.pdAllTypes}
                    addLabel={t.pdAddRole}
                    options={roles}
                    selected={a.role_ids}
                    onChange={ids => patch(a.id, { role_ids: ids })}
                  />
                </div>
                <div style={styles.scopeCell}>
                  <div style={styles.scopeLabel}>{t.pdModeLabel}</div>
                  <div style={styles.modeToggle}>
                    {['shared', 'individual'].map(m => (
                      <button
                        key={m}
                        type="button"
                        style={{ ...styles.modeBtn, ...(a.mode === m ? styles.modeBtnOn : {}) }}
                        onClick={() => a.mode !== m && patch(a.id, { mode: m })}
                      >
                        {m === 'shared' ? t.pdModeShared : t.pdModeIndividual}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
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
  scopeGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 },
  scopeCell: { display: 'flex', flexDirection: 'column', gap: 6 },
  scopeLabel: { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' },
  scopeRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
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
