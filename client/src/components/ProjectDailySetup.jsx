// Project Daily — the admin setup surface for the recurring items that seed each day's
// Daily Checklist. Items are authored per scope cell along two dimensions plus a mode:
//   • Project: "Default — all projects" or a specific project (both apply, additively)
//   • Team member type: "All types" or a specific type (both apply, additively)
//   • Mode per item: shared (one state everyone with the type shares) vs individual
//     (each matching person gets their own private check state)
// Picking a (project, type) cell loads that cell's items; Save replaces the cell.
import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { SkeletonList } from './Skeleton';

const KINDS = ['check', 'text'];
const MODES = ['shared', 'individual'];

export default function ProjectDailySetup() {
  const t = useT();
  const [projects, setProjects] = useState([]);
  const [roles, setRoles] = useState([]);
  const [scopeProject, setScopeProject] = useState(''); // '' = default (all projects)
  const [scopeRole, setScopeRole] = useState('');        // '' = all types
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api.get('/admin/projects').then(r => r.data).catch(() => []),
      api.get('/admin/roles').then(r => r.data).catch(() => []),
    ]).then(([p, r]) => { setProjects(p || []); setRoles(r || []); });
  }, []);

  const loadScope = useCallback(async (project, role) => {
    setLoading(true); setError(''); setSaved(false); setDirty(false);
    try {
      const params = {};
      if (project) params.project_id = project;
      if (role) params.role_id = role;
      const r = await api.get('/daily-checklist/recurring', { params });
      setItems((r.data.items || []).map(it => ({
        _id: Math.random(),
        text: it.text || '',
        kind: KINDS.includes(it.kind) ? it.kind : 'check',
        mode: MODES.includes(it.mode) ? it.mode : 'shared',
      })));
    } catch {
      setError(t.failedToLoad); setItems([]);
    } finally { setLoading(false); }
  }, [t]);

  useEffect(() => { loadScope(scopeProject, scopeRole); }, [scopeProject, scopeRole, loadScope]);

  const addItem = () => { setItems(p => [...p, { _id: Math.random(), text: '', kind: 'check', mode: 'shared' }]); setDirty(true); setSaved(false); };
  const removeItem = id => { setItems(p => p.filter(i => i._id !== id)); setDirty(true); setSaved(false); };
  const updateItem = (id, k, v) => { setItems(p => p.map(i => i._id === id ? { ...i, [k]: v } : i)); setDirty(true); setSaved(false); };

  const save = async () => {
    setSaving(true); setError('');
    try {
      await api.put('/daily-checklist/recurring', {
        project_id: scopeProject || null,
        role_id: scopeRole || null,
        items: items.filter(i => i.text.trim()).map(i => ({ text: i.text.trim(), kind: i.kind, mode: i.mode })),
      });
      setSaved(true); setDirty(false);
    } catch (err) {
      setError(err.response?.data?.error || t.failedToSave);
    } finally { setSaving(false); }
  };

  const scopeLabel = (scopeProject ? (projects.find(p => String(p.id) === String(scopeProject))?.name || '') : t.pdDefaultAllProjects)
    + ' · ' + (scopeRole ? (roles.find(r => String(r.id) === String(scopeRole))?.name || '') : t.pdAllTypes);

  return (
    <div>
      <div style={styles.topRow}>
        <div>
          <h2 style={styles.heading}>{t.pdTitle}</h2>
          <p style={styles.summary}>{t.pdSub}</p>
        </div>
      </div>

      <div style={styles.scopeBar}>
        <div style={styles.fieldGroup}>
          <label style={styles.label}>{t.pdProjectScope}</label>
          <select style={styles.select} value={scopeProject} onChange={e => setScopeProject(e.target.value)}>
            <option value="">{t.pdDefaultAllProjects}</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div style={styles.fieldGroup}>
          <label style={styles.label}>{t.pdTypeScope}</label>
          <select style={styles.select} value={scopeRole} onChange={e => setScopeRole(e.target.value)}>
            <option value="">{t.pdAllTypes}</option>
            {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
      </div>

      <p style={styles.hint}>{t.pdScopeHint}</p>

      {loading ? (
        <SkeletonList count={3} rows={1} />
      ) : (
        <>
          <div style={styles.editingScope}>{t.pdEditing}: <strong>{scopeLabel}</strong></div>
          <div style={styles.list}>
            {items.map((item, idx) => (
              <div key={item._id} style={styles.itemRow}>
                <span style={styles.itemIdx}>{idx + 1}</span>
                <input
                  style={styles.textInput}
                  type="text"
                  placeholder={t.itemLabelPlaceholder}
                  value={item.text}
                  onChange={e => updateItem(item._id, 'text', e.target.value)}
                />
                <select style={styles.smallSelect} value={item.kind} onChange={e => updateItem(item._id, 'kind', e.target.value)}>
                  <option value="check">{t.checklistTypeCheckbox}</option>
                  <option value="text">{t.checklistTypeText}</option>
                </select>
                <select style={styles.smallSelect} value={item.mode} onChange={e => updateItem(item._id, 'mode', e.target.value)} title={t.pdModeLabel}>
                  <option value="shared">{t.pdModeShared}</option>
                  <option value="individual">{t.pdModeIndividual}</option>
                </select>
                <button type="button" style={styles.removeBtn} aria-label={t.removeItem} onClick={() => removeItem(item._id)}>✕</button>
              </div>
            ))}
            {items.length === 0 && <p style={styles.empty}>{t.pdEmpty}</p>}
          </div>

          <div style={styles.actions}>
            <button type="button" style={styles.addBtn} onClick={addItem}>{t.addItem}</button>
            <div style={{ flex: 1 }} />
            {saved && !dirty && <span style={styles.savedTag}>✓ {t.pdSaved}</span>}
            <button
              type="button"
              style={{ ...styles.saveBtn, ...((saving || !dirty) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
              onClick={save}
              disabled={saving || !dirty}
            >
              {saving ? t.saving : t.saveChanges}
            </button>
          </div>
          {error && <p role="alert" style={styles.error}>{error}</p>}
        </>
      )}
    </div>
  );
}

const styles = {
  topRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' },
  heading: { fontSize: 22, fontWeight: 800, color: '#111827', margin: 0 },
  summary: { fontSize: 13, color: '#6b7280', margin: '4px 0 0' },
  scopeBar: { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 200, flex: 1 },
  label: { fontSize: 12, fontWeight: 600, color: '#6b7280' },
  select: { padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, background: '#fff', width: '100%', boxSizing: 'border-box' },
  hint: { fontSize: 12, color: '#6b7280', background: '#f9fafb', border: '1px solid #eef2f7', borderRadius: 8, padding: '8px 12px', lineHeight: 1.5, margin: '0 0 16px' },
  editingScope: { fontSize: 12, color: '#6b7280', margin: '0 0 8px' },
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  itemRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  itemIdx: { fontSize: 12, fontWeight: 700, color: '#6b7280', flexShrink: 0, width: 18 },
  textInput: { padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, flex: 1, minWidth: 160, boxSizing: 'border-box' },
  smallSelect: { padding: '8px 6px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12, background: '#fff', flexShrink: 0 },
  removeBtn: { fontSize: 11, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', borderRadius: 4, flexShrink: 0 },
  empty: { color: '#6b7280', fontSize: 14, padding: '10px 0' },
  actions: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 },
  addBtn: { fontSize: 12, fontWeight: 600, color: '#059669', background: '#ecfdf5', border: '1px solid #a7f3d0', padding: '8px 14px', borderRadius: 7, cursor: 'pointer' },
  savedTag: { fontSize: 13, fontWeight: 600, color: '#065f46' },
  saveBtn: { background: '#059669', color: '#fff', border: 'none', padding: '9px 18px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  error: { color: '#ef4444', fontSize: 13, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', margin: '10px 0 0' },
};
