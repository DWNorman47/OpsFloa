// Project Daily — assign whole Checklist Builder checklists to seed each day's Daily
// Checklist. Each assignment = a checklist + a project scope + a team-role scope + a mode.
// Projects and roles default to "All"; an Add control narrows either to a specific set.
//   Shared     = one list everyone with a matching role shares (one change seen by all)
//   Individual = each matching person gets their own private copy
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { SkeletonList } from './Skeleton';

// A scope picker: "All" until you add specific ones; chips + an Add dropdown after.
function ScopePicker({ allLabel, addLabel, options, selected, onChange }) {
  const ids = Array.isArray(selected) && selected.length ? selected.map(String) : null;
  const nameById = useMemo(() => Object.fromEntries(options.map(o => [String(o.id), o.name])), [options]);
  const remaining = options.filter(o => !ids || !ids.includes(String(o.id)));
  const add = id => { if (!id) return; onChange([...(ids || []), id].map(Number)); };
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
  const [assignments, setAssignments] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [projects, setProjects] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addTemplateId, setAddTemplateId] = useState('');
  const [error, setError] = useState('');

  const loadAssignments = useCallback(async () => {
    const r = await api.get('/daily-checklist/assignments');
    setAssignments(r.data.assignments || []);
  }, []);

  useEffect(() => {
    Promise.all([
      api.get('/daily-checklist/assignments').then(r => r.data.assignments || []).catch(() => []),
      api.get('/safety-checklists/templates').then(r => r.data || []).catch(() => []),
      api.get('/admin/projects').then(r => r.data || []).catch(() => []),
      api.get('/admin/roles').then(r => r.data || []).catch(() => []),
    ]).then(([a, tmpls, p, r]) => {
      setAssignments(a); setTemplates(tmpls); setProjects(p); setRoles(r);
    }).finally(() => setLoading(false));
  }, []);

  const addAssignment = async () => {
    if (!addTemplateId) return;
    setError('');
    try {
      await api.post('/daily-checklist/assignments', { template_id: Number(addTemplateId) });
      setAddTemplateId('');
      await loadAssignments();
    } catch (err) { setError(err.response?.data?.error || t.failedToSave); }
  };

  // Patch one field, updating local state optimistically.
  const patch = async (id, body) => {
    setAssignments(prev => prev.map(a => a.id === id ? { ...a, ...body } : a));
    try { await api.patch(`/daily-checklist/assignments/${id}`, body); }
    catch (err) { setError(err.response?.data?.error || t.failedToSave); loadAssignments(); }
  };

  const remove = async (id) => {
    setAssignments(prev => prev.filter(a => a.id !== id));
    try { await api.delete(`/daily-checklist/assignments/${id}`); }
    catch { loadAssignments(); }
  };

  return (
    <div>
      <div style={styles.topRow}>
        <div>
          <h2 style={styles.heading}>{t.pdTitle}</h2>
          <p style={styles.summary}>{t.pdSub}</p>
        </div>
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
          {assignments.map(a => (
            <div key={a.id} style={styles.card}>
              <div style={styles.cardHead}>
                <div>
                  <div style={styles.cardTitle}>{a.template_name}</div>
                  <div style={styles.cardMeta}>{a.item_count} {t.itemsCount}</div>
                </div>
                <button type="button" style={styles.removeBtn} onClick={() => remove(a.id)}>{t.delete}</button>
              </div>

              <div style={styles.scopeGrid}>
                <div style={styles.scopeCell}>
                  <div style={styles.scopeLabel}>{t.pdProjectScope}</div>
                  <ScopePicker
                    allLabel={t.pdAllProjects}
                    addLabel={t.pdAddProject}
                    options={projects}
                    selected={a.project_ids}
                    onChange={ids => patch(a.id, { project_ids: ids })}
                  />
                </div>
                <div style={styles.scopeCell}>
                  <div style={styles.scopeLabel}>{t.pdTypeScope}</div>
                  <ScopePicker
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
  hint: { fontSize: 12, color: '#6b7280', background: '#f9fafb', border: '1px solid #eef2f7', borderRadius: 8, padding: '8px 12px', lineHeight: 1.5, margin: '0 0 16px' },
  addBar: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 },
  addTemplateSelect: { padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, background: '#fff', minWidth: 220, flex: 1, maxWidth: 360 },
  addBtn: { background: '#059669', color: '#fff', border: 'none', padding: '9px 18px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer', flexShrink: 0 },
  list: { display: 'flex', flexDirection: 'column', gap: 12 },
  card: { background: '#fff', borderRadius: 12, boxShadow: '0 1px 6px rgba(0,0,0,0.07)', padding: 16 },
  cardHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 },
  cardTitle: { fontWeight: 700, fontSize: 15, color: '#111827' },
  cardMeta: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  removeBtn: { background: 'none', border: '1px solid #fca5a5', color: '#ef4444', padding: '5px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', flexShrink: 0 },
  scopeGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 },
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
