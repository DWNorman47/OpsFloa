import React, { useState, useEffect, useMemo } from 'react';
import api from '../api';
import { useAuth } from '../contexts/AuthContext';
import { langToLocale } from '../utils';
import { useOffline } from '../contexts/OfflineContext';
import { useT } from '../hooks/useT';
import Pagination from './Pagination';
import FieldFilters from './FieldFilters';
import { labelSg, labelPl } from '../companyLabels';

function today() { return new Date().toLocaleDateString('en-CA'); }

const STATUS_STYLES = {
  pass:    { color: '#065f46', background: '#d1fae5' },
  fail:    { color: '#991b1b', background: '#fee2e2' },
  pending: { color: '#92400e', background: '#fef3c7' },
};

function parseInspectionName(name = '') {
  const text = String(name || '').trim();
  const match = text.match(/^(.*?)\s+-\s+([A-Z0-9-]+)(?:\s+\d{4}-\d{2}-\d{2})?$/);
  if (!match) return { title: text || 'Inspection', ref: '' };
  return { title: match[1], ref: match[2] };
}

// ITEM_TYPES is built inside TemplateBuilder using t keys

// ── Preset Templates ───────────────────────────────────────────────────────────

const PRESET_TEMPLATES = [
  {
    name: 'Daily Workplace Safety',
    items: [
      { label: 'PPE available and in use', type: 'pass_fail' },
      { label: 'First aid kit stocked', type: 'pass_fail' },
      { label: 'Emergency contact posted', type: 'pass_fail' },
      { label: 'Fall protection in place', type: 'pass_fail' },
      { label: 'Housekeeping / clear walkways', type: 'pass_fail' },
      { label: 'Tool condition satisfactory', type: 'pass_fail' },
      { label: 'Notes', type: 'text' },
    ],
  },
  {
    name: 'Equipment / Platform Inspection',
    items: [
      { label: 'Equipment or platform is stable and secure', type: 'pass_fail' },
      { label: 'Work surface is clear and usable', type: 'pass_fail' },
      { label: 'Guards, rails, or barriers are in place where needed', type: 'pass_fail' },
      { label: 'Access path is safe and unobstructed', type: 'pass_fail' },
      { label: 'Load or capacity limits are understood', type: 'pass_fail' },
      { label: 'Team knows who to report issues to', type: 'pass_fail' },
      { label: 'Inspector notes', type: 'text' },
    ],
  },
  {
    name: 'Electrical Inspection',
    items: [
      { label: 'GFCI protection in use', type: 'pass_fail' },
      { label: 'Extension cords in good condition', type: 'pass_fail' },
      { label: 'Panel / breaker box accessible', type: 'pass_fail' },
      { label: 'No exposed wiring', type: 'pass_fail' },
      { label: 'Grounding verified', type: 'pass_fail' },
      { label: 'Lockout/Tagout procedures followed', type: 'pass_fail' },
      { label: 'Notes', type: 'text' },
    ],
  },
];

// ── Template Builder ───────────────────────────────────────────────────────────

function TemplateBuilder({ initial, onSaved, onCancel }) {
  const t = useT();
  const ITEM_TYPES = useMemo(() => [
    { value: 'pass_fail', label: t.inspPassFail },
    { value: 'text', label: t.inspTextNote },
    { value: 'number', label: t.inspNumber },
  ], [t]);
  const isEdit = !!initial?.id;
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [items, setItems] = useState(
    (initial?.items ?? []).map(i => ({ ...i, _id: Math.random() }))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showPresets, setShowPresets] = useState(false);

  const addItem = () => setItems(prev => [...prev, { _id: Math.random(), label: '', type: 'pass_fail' }]);
  const removeItem = (id) => setItems(prev => prev.filter(i => i._id !== id));
  const updateItem = (id, k, v) => setItems(prev => prev.map(i => i._id === id ? { ...i, [k]: v } : i));

  const pickPreset = (preset) => {
    setName(preset.name);
    setItems(preset.items.map(i => ({ ...i, _id: Math.random() })));
    setShowPresets(false);
  };

  const handleSubmit = async e => {
    e.preventDefault();
    if (!name.trim()) { setError(t.inspTemplateNameRequired); return; }
    if (items.length === 0) { setError(t.inspAddAtLeastOne); return; }
    setSaving(true); setError('');
    const cleanItems = items.map(({ _id, ...rest }) => ({ ...rest, id: _id.toString(36).slice(2) }));
    try {
      const r = isEdit
        ? await api.patch(`/inspections/templates/${initial.id}`, { name, description, items: cleanItems })
        : await api.post('/inspections/templates', { name, description, items: cleanItems });
      onSaved(r.data, isEdit);
    } catch (err) {
      setError(err.response?.data?.error || t.inspFailedSave);
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={handleSubmit} style={styles.form}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={styles.formTitle}>{isEdit ? t.inspEditTemplate : t.inspNewTemplateTitle}</h3>
        {!isEdit && (
          <button type="button" style={styles.presetBtn} onClick={() => setShowPresets(s => !s)}>
            {t.inspFromPreset}
          </button>
        )}
      </div>

      {showPresets && (
        <div style={styles.presetGrid}>
          {PRESET_TEMPLATES.map(p => (
            <button key={p.name} type="button" style={styles.presetCard} onClick={() => pickPreset(p)}>
              <div style={styles.presetName}>{p.name}</div>
              <div style={styles.presetCount}>{p.items.length} {t.inspItemsCount}</div>
            </button>
          ))}
        </div>
      )}

      <div style={styles.fieldGroup}>
        <label style={styles.label}>{t.inspTemplateName}</label>
        <input style={styles.input} value={name} onChange={e => setName(e.target.value)} placeholder={t.inspTemplatePlaceholder} />
      </div>
      <div style={styles.fieldGroup}>
        <label style={styles.label}>{t.inspDescriptionField} <span style={styles.optional}>{t.inspOptional}</span></label>
        <input style={styles.input} maxLength={255} value={description} onChange={e => setDescription(e.target.value)} placeholder={t.inspTemplateDescPlaceholder} />
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <label style={styles.label}>{t.inspChecklistItems}</label>
          <button type="button" style={styles.addItemBtn} onClick={addItem}>{t.inspAddItem}</button>
        </div>
        {items.length === 0 && (
          <p style={styles.hint}>{t.inspNoItemsYet}</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map((item, idx) => (
            <div key={item._id} style={styles.itemRow}>
              <span style={styles.itemNum}>{idx + 1}</span>
              <input
                style={{ ...styles.input, flex: 1 }}
                value={item.label}
                onChange={e => updateItem(item._id, 'label', e.target.value)}
                placeholder={t.inspItemLabel}
              />
              <select style={styles.typeSelect} value={item.type} onChange={e => updateItem(item._id, 'type', e.target.value)}>
                {ITEM_TYPES.map(it => <option key={it.value} value={it.value}>{it.label}</option>)}
              </select>
              <button type="button" style={styles.removeItemBtn} aria-label={t.removeItem} onClick={() => removeItem(item._id)}>✕</button>
            </div>
          ))}
        </div>
      </div>

      {error && <p role="alert" style={styles.error}>{error}</p>}
      <div style={styles.formActions}>
        <button style={{ ...styles.submitBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={saving}>{saving ? t.saving : isEdit ? t.inspSaveChanges : t.inspCreateTemplate}</button>
        <button style={styles.cancelBtn} type="button" onClick={onCancel}>{t.cancel}</button>
      </div>
    </form>
  );
}

// ── Inspection Form (fill out an inspection) ──────────────────────────────────

function InspectionForm({ templates, projects, initial, onSaved, onCancel, workLabel = 'Project' }) {
  const t = useT();
  const isEdit = !!initial?.id;
  const [form, setForm] = useState({
    template_id: initial?.template_id ?? '',
    project_id: initial?.project_id ?? '',
    name: initial?.name ?? '',
    inspector: initial?.inspector ?? '',
    location: initial?.location ?? '',
    notes: initial?.notes ?? '',
    status: initial?.status ?? 'pass',
    inspected_at: initial?.inspected_at?.toString().substring(0, 10) ?? today(),
    results: initial?.results ?? {},
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const selectedTemplate = templates.find(tpl => tpl.id === form.template_id);

  const handleTemplateChange = (tid) => {
    const tpl = templates.find(tpl2 => tpl2.id === tid);
    set('template_id', tid);
    if (tpl && !isEdit) set('name', tpl.name);
  };

  const setResult = (itemId, field, value) => {
    setForm(f => ({
      ...f,
      results: { ...f.results, [itemId]: { ...(f.results[itemId] || {}), [field]: value } },
    }));
  };

  // Auto-compute overall status from pass_fail items
  useEffect(() => {
    if (!selectedTemplate) return;
    const pfItems = selectedTemplate.items.filter(i => i.type === 'pass_fail');
    if (pfItems.length === 0) return;
    const anyFail = pfItems.some(i => form.results[i.id]?.value === 'fail');
    const allDone = pfItems.every(i => form.results[i.id]?.value != null);
    if (!allDone) set('status', 'pending');
    else if (anyFail) set('status', 'fail');
    else set('status', 'pass');
  }, [form.results, selectedTemplate?.id]);

  const handleSubmit = async e => {
    e.preventDefault();
    if (!form.name.trim() || !form.inspected_at) { setError(t.inspNameDateRequired); return; }
    setSaving(true); setError('');
    try {
      const r = isEdit
        ? await api.patch(`/inspections/${initial.id}`, form)
        : await api.post('/inspections', form);
      if (!isEdit && r.data?.offline) {
        onSaved({ id: 'pending-' + Date.now(), pending: true, ...form, status: form.status || 'pending', results: form.results || {} }, false);
        return;
      }
      onSaved(r.data, isEdit);
    } catch (err) {
      setError(err.response?.data?.error || t.inspFailedSave);
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={handleSubmit} style={styles.form}>
      <h3 style={styles.formTitle}>{isEdit ? t.inspEditInspection : t.inspNewInspectionTitle}</h3>

      {!isEdit && templates.length > 0 && (
        <div style={styles.fieldGroup}>
          <label style={styles.label}>{t.inspChecklistTemplate} <span style={styles.optional}>{t.inspOptional}</span></label>
          <select style={styles.input} value={form.template_id} onChange={e => handleTemplateChange(e.target.value)}>
            <option value="">{t.inspBlankInspection}</option>
            {templates.map(tpl => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
          </select>
        </div>
      )}

      <div style={styles.row}>
        <div style={styles.fieldGroup}>
          <label style={styles.label}>{t.inspInspectionName}</label>
          <input style={styles.input} maxLength={255} value={form.name} onChange={e => set('name', e.target.value)} placeholder={t.inspectionNamePlaceholder} />
        </div>
        <div style={styles.fieldGroup}>
          <label style={styles.label}>{t.date}</label>
          <input style={styles.input} type="date" value={form.inspected_at} onChange={e => set('inspected_at', e.target.value)} />
        </div>
      </div>

      <div style={styles.row}>
        <div style={styles.fieldGroup}>
          <label style={styles.label}>{t.inspInspector} <span style={styles.optional}>{t.inspOptional}</span></label>
          <input style={styles.input} maxLength={255} value={form.inspector} onChange={e => set('inspector', e.target.value)} placeholder={t.inspInspectorPlaceholder} />
        </div>
        <div style={styles.fieldGroup}>
          <label style={styles.label}>{t.inspInspectionLocation} <span style={styles.optional}>{t.inspOptional}</span></label>
          <input style={styles.input} maxLength={255} value={form.location} onChange={e => set('location', e.target.value)} placeholder={t.inspLocationPlaceholder} />
        </div>
      </div>

      {projects.length > 0 && (
        <div style={styles.fieldGroup}>
          <label style={styles.label}>{workLabel} <span style={styles.optional}>{t.inspOptional}</span></label>
          <select style={styles.input} value={form.project_id} onChange={e => set('project_id', e.target.value)}>
            <option value="">{`No ${workLabel.toLowerCase()}`}</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}

      {selectedTemplate && selectedTemplate.items.length > 0 && (
        <div>
          <label style={{ ...styles.label, marginBottom: 8, display: 'block' }}>{t.inspChecklistItems}</label>
          <div style={styles.checklistGrid}>
            {selectedTemplate.items.map(item => {
              const res = form.results[item.id] || {};
              return (
                <div key={item.id} style={styles.checklistItem}>
                  <div style={styles.checklistLabel}>{item.label}</div>
                  {item.type === 'pass_fail' && (
                    <div style={styles.pfRow}>
                      {['pass', 'fail'].map(v => (
                        <button
                          key={v}
                          type="button"
                          style={{ ...styles.pfBtn, ...(res.value === v ? styles[`pfBtn_${v}`] : {}) }}
                          onClick={() => setResult(item.id, 'value', res.value === v ? null : v)}
                        >
                          {v === 'pass' ? t.inspPassBtn : t.inspFailBtn}
                        </button>
                      ))}
                      {res.value === 'fail' && (
                        <input
                          style={{ ...styles.input, flex: 1, fontSize: 12 }}
                          value={res.note || ''}
                          onChange={e => setResult(item.id, 'note', e.target.value)}
                          placeholder={t.inspDescribeIssue}
                        />
                      )}
                    </div>
                  )}
                  {item.type === 'text' && (
                    <input
                      style={styles.input}
                      value={res.value || ''}
                      onChange={e => setResult(item.id, 'value', e.target.value)}
                      placeholder={t.inspEnterNote}
                    />
                  )}
                  {item.type === 'number' && (
                    <input
                      style={{ ...styles.input, width: 120 }}
                      type="number"
                      value={res.value || ''}
                      onChange={e => setResult(item.id, 'value', e.target.value)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={styles.row}>
        <div style={styles.fieldGroup}>
          <label style={styles.label}>{t.inspOverallStatus}</label>
          <select style={styles.input} value={form.status} onChange={e => set('status', e.target.value)}>
            <option value="pass">{t.inspStatusPass}</option>
            <option value="fail">{t.inspStatusFail}</option>
            <option value="pending">{t.inspStatusPending}</option>
          </select>
        </div>
      </div>

      <div style={styles.fieldGroup}>
        <label style={styles.label}>{t.notes} <span style={styles.optional}>{t.inspOptional}</span></label>
        <textarea style={styles.textarea} rows={3} maxLength={1000} value={form.notes} onChange={e => set('notes', e.target.value)} placeholder={t.inspNotesPh} />
        <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{(form.notes || '').length}/1000</div>
      </div>

      {error && <p role="alert" style={styles.error}>{error}</p>}
      <div style={styles.formActions}>
        <button style={{ ...styles.submitBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={saving}>{saving ? t.saving : isEdit ? t.inspSaveChanges : t.inspSaveInspection}</button>
        <button style={styles.cancelBtn} type="button" onClick={onCancel}>{t.cancel}</button>
      </div>
    </form>
  );
}

// ── Inspection Card ────────────────────────────────────────────────────────────

function InspectionCard({ ins, isAdmin, templates, onEdit, onDeleted }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError('');
    try { await api.delete(`/inspections/${ins.id}`); onDeleted(ins.id); }
    catch { setDeleteError(t.inspFailedDelete); setConfirmingDelete(false); }
    finally { setDeleting(false); }
  };

  const statusStyle = STATUS_STYLES[ins.status] || STATUS_STYLES.pending;
  const fmtDate = d => d ? new Date(d).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const displayName = parseInspectionName(ins.name);

  // Build a label lookup map from the template this inspection was based on
  const template = templates?.find(tpl => tpl.id === ins.template_id);
  const itemLabels = {};
  if (template?.items) {
    template.items.forEach(i => { itemLabels[i.id] = i.label; });
  }

  // Count pass/fail items
  const results = ins.results || {};
  const pfEntries = Object.values(results).filter(r => r.value === 'pass' || r.value === 'fail');
  const passCount = pfEntries.filter(r => r.value === 'pass').length;
  const failCount = pfEntries.filter(r => r.value === 'fail').length;
  const hasItems = pfEntries.length > 0;

  return (
    <div style={{ ...styles.card, ...(ins.status === 'fail' ? styles.cardFail : {}) }}>
      <div style={styles.cardHeader} onClick={() => setExpanded(e => !e)} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setExpanded(prev => !prev)}>
        <div style={styles.cardMiddle}>
          <div style={styles.cardName}>
            {displayName.title}
            {displayName.ref && <span style={styles.refTag}>{displayName.ref}</span>}
            {ins.pending && <span style={styles.pendingBadge}>{t.inspPendingSync}</span>}
          </div>
          <div style={styles.cardMeta}>
            <span>{fmtDate(ins.inspected_at)}</span>
            {ins.project_name && <span style={styles.projectTag}>{ins.project_name}</span>}
            {ins.inspector && <span>By {ins.inspector}</span>}
            {ins.location && <span>At {ins.location}</span>}
            {hasItems && (
              <span style={styles.scoreChip}>
                {passCount} pass - {failCount} fail
              </span>
            )}
          </div>
        </div>
        <div style={styles.cardRight}>
          <span style={{ ...styles.statusBadge, ...statusStyle }}>{ins.status.toUpperCase()}</span>
          <span style={styles.chevron}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div style={styles.cardBody}>
          {ins.notes && (
            <div style={styles.notesBlock}>{ins.notes}</div>
          )}

          {Object.entries(results).length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={styles.sectionLabel}>{t.inspChecklistResults}</div>
              <div style={styles.resultsGrid}>
                {Object.entries(results).map(([itemId, res]) => {
                  const isPass = res.value === 'pass';
                  const isFail = res.value === 'fail';
                  return (
                    <div key={itemId} style={{ ...styles.resultRow, ...(isFail ? styles.resultRowFail : {}) }}>
                      <span style={styles.resultDot}>{isPass ? '✓' : isFail ? '✗' : '—'}</span>
                      <span style={styles.resultLabel}>{itemLabels[itemId] || itemId}</span>
                      {res.note && <span style={styles.resultNote}>{res.note}</span>}
                      {typeof res.value === 'string' && res.value !== 'pass' && res.value !== 'fail' && (
                        <span style={styles.resultValue}>{res.value}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {isAdmin && !ins.pending && (
            <div style={styles.cardActions}>
              <button style={styles.editBtn} onClick={() => onEdit(ins)}>{t.edit}</button>
              {confirmingDelete ? (
                <>
                  <button style={{ ...styles.confirmDeleteBtn, ...(deleting ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={handleDelete} disabled={deleting}>{deleting ? '…' : t.confirm}</button>
                  <button style={styles.cancelDeleteBtn} onClick={() => setConfirmingDelete(false)}>{t.cancel}</button>
                </>
              ) : (
                <button style={styles.deleteBtn} onClick={() => setConfirmingDelete(true)}>{t.delete}</button>
              )}
              {deleteError && <span style={styles.inlineError}>{deleteError}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function InspectionChecklists({ projects, settings = null }) {
  const t = useT();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const { onSync } = useOffline() || {};
  const workLabel = labelSg(settings?.label_work, 'work', user?.language);
  const workLabelPlural = labelPl(settings?.label_work, 'work', user?.language);

  const [inspections, setInspections] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('inspections'); // 'inspections' | 'templates'
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [filters, setFilters] = useState({});
  const [pendingDeleteTemplateId, setPendingDeleteTemplateId] = useState(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);

  const setFilter = (k, v) => { setPage(1); setFilters(f => ({ ...f, [k]: v })); };

  const loadAll = async (p = page) => {
    const [insRes, tplRes] = await Promise.all([
      api.get('/inspections', { params: { ...Object.fromEntries(Object.entries(filters).filter(([,v]) => v)), page: p, limit: 50 } }),
      api.get('/inspections/templates'),
    ]);
    setInspections(insRes.data.items);
    setPages(insRes.data.pages || 1);
    setTemplates(tplRes.data);
  };

  useEffect(() => { loadAll(1).finally(() => setLoading(false)); }, []);
  useEffect(() => { if (!loading) loadAll(page); }, [filters, page]);

  const handleSaved = (item, isEdit) => {
    if (view === 'templates') {
      if (isEdit) setTemplates(prev => prev.map(tpl => tpl.id === item.id ? item : tpl));
      else setTemplates(prev => [item, ...prev]);
    } else {
      if (isEdit) setInspections(prev => prev.map(i => i.id === item.id ? item : i));
      else setInspections(prev => [item, ...prev]);
    }
    setEditing(null);
    setShowForm(false);
  };

  const passCount = inspections.filter(i => i.status === 'pass').length;
  const failCount = inspections.filter(i => i.status === 'fail').length;
  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  return (
    <div>
      <div style={styles.topRow}>
        <div>
          <h1 style={styles.heading}>{t.inspHeading}</h1>
          <p style={styles.summary}>
            {inspections.length} {inspections.length !== 1 ? t.inspInspectionsCount : t.inspInspectionCount} · {passCount} {t.inspSummaryPass}
            {failCount > 0 && <span style={styles.failNote}> · {failCount} {t.inspSummaryFail}</span>}
          </p>
        </div>
        <div style={styles.topActions}>
          {isAdmin && (
            <div style={styles.viewToggle}>
              <button
                style={{ ...styles.toggleBtn, ...(view === 'inspections' ? styles.toggleBtnActive : {}) }}
                onClick={() => { setView('inspections'); setShowForm(false); setEditing(null); }}
              >{t.inspInspectionsTab}</button>
              <button
                style={{ ...styles.toggleBtn, ...(view === 'templates' ? styles.toggleBtnActive : {}) }}
                onClick={() => { setView('templates'); setShowForm(false); setEditing(null); }}
              >{t.inspTemplatesTab}</button>
            </div>
          )}
          {!showForm && !editing && (
            <button style={styles.newBtn} onClick={() => setShowForm(true)}>
              {view === 'templates' ? t.inspNewTemplate : t.inspNewInspection}
            </button>
          )}
        </div>
      </div>

      {(showForm || editing) && (
        <div style={styles.formCard}>
          {view === 'templates' ? (
            <TemplateBuilder
              initial={editing || null}
              onSaved={handleSaved}
              onCancel={() => { setShowForm(false); setEditing(null); }}
            />
          ) : (
            <InspectionForm
              templates={templates}
              projects={projects}
              workLabel={workLabel}
              initial={editing || null}
              onSaved={handleSaved}
              onCancel={() => { setShowForm(false); setEditing(null); }}
            />
          )}
        </div>
      )}

      {view === 'inspections' && (
        <FieldFilters activeCount={activeFilterCount}>
          <select style={styles.filterSelect} value={filters.status || ''} onChange={e => setFilter('status', e.target.value)}>
            <option value="">{t.inspAllStatuses}</option>
            <option value="pass">{t.inspStatusPass}</option>
            <option value="fail">{t.inspStatusFail}</option>
            <option value="pending">{t.inspStatusPending}</option>
          </select>
          {projects.length > 0 && (
            <select style={styles.filterSelect} value={filters.project_id || ''} onChange={e => setFilter('project_id', e.target.value)}>
              <option value="">{`All ${workLabelPlural}`}</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          {templates.length > 0 && (
            <select style={styles.filterSelect} value={filters.template_id || ''} onChange={e => setFilter('template_id', e.target.value)}>
              <option value="">{t.inspAllTemplates}</option>
              {templates.map(tpl => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
            </select>
          )}
          <input style={styles.filterInput} type="date" value={filters.from || ''} onChange={e => setFilter('from', e.target.value)} title={t.fromDate} />
          <input style={styles.filterInput} type="date" value={filters.to || ''} onChange={e => setFilter('to', e.target.value)} title={t.toDate} />
        </FieldFilters>
      )}

      {loading ? (
        <p style={styles.hint}>{t.loading}</p>
      ) : view === 'templates' ? (
        templates.length === 0 ? (
          <div style={styles.empty}>
            <p style={styles.emptyText}>{t.inspNoTemplates}</p>
          </div>
        ) : (
          <div style={styles.list}>
            {templates.map(tpl => (
              <div key={tpl.id} style={styles.templateCard}>
                <div style={styles.templateInfo}>
                  <div style={styles.templateName}>{tpl.name}</div>
                  {tpl.description && <div style={styles.templateDesc}>{tpl.description}</div>}
                  <div style={styles.templateCount}>{tpl.items?.length || 0} {t.inspItemsCount}</div>
                </div>
                {isAdmin && (
                  <div style={styles.cardActions}>
                    <button style={styles.editBtn} onClick={() => { setEditing(tpl); setShowForm(false); }}>{t.edit}</button>
                    {pendingDeleteTemplateId === tpl.id ? (
                      <>
                        <button style={styles.confirmDeleteBtn} onClick={async () => {
                          await api.delete(`/inspections/templates/${tpl.id}`);
                          setTemplates(prev => prev.filter(x => x.id !== tpl.id));
                          setPendingDeleteTemplateId(null);
                        }}>{t.confirm}</button>
                        <button style={styles.cancelDeleteBtn} onClick={() => setPendingDeleteTemplateId(null)}>{t.cancel}</button>
                      </>
                    ) : (
                      <button style={styles.deleteBtn} onClick={() => setPendingDeleteTemplateId(tpl.id)}>{t.delete}</button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      ) : inspections.length === 0 ? (
        <div style={styles.empty}>
          <p style={styles.emptyText}>{isAdmin ? t.inspNoInspectionsAdmin : t.inspNoInspectionsWorker}</p>
        </div>
      ) : (
        <>
          <div style={styles.list}>
            {inspections.map(ins => (
              <InspectionCard
                key={ins.id}
                ins={ins}
                isAdmin={isAdmin}
                templates={templates}
                onEdit={ins => { setEditing(ins); setShowForm(false); }}
                onDeleted={id => setInspections(prev => prev.filter(i => i.id !== id))}
              />
            ))}
          </div>
          <Pagination page={page} pages={pages} onChange={setPage} />
        </>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  topRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' },
  heading: { fontSize: 22, fontWeight: 800, color: '#111827', margin: 0 },
  summary: { fontSize: 13, color: '#6b7280', margin: '4px 0 0' },
  failNote: { color: '#ef4444', fontWeight: 700 },
  topActions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  viewToggle: { display: 'flex', background: '#f3f4f6', borderRadius: 8, padding: 3, gap: 2 },
  toggleBtn: { padding: '6px 14px', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer', background: 'none', color: '#6b7280' },
  toggleBtnActive: { background: '#fff', color: '#111827', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' },
  newBtn: { background: '#059669', color: '#fff', border: 'none', padding: '10px 18px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  formCard: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 20 },
  filterBar: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 },
  filterSelect: { padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, background: '#fff', color: '#374151', flex: 1, minWidth: 120 },
  filterInput: { padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, background: '#fff', color: '#374151' },
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  hint: { color: '#6b7280', fontSize: 14 },
  empty: { textAlign: 'center', padding: '60px 20px' },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyText: { color: '#6b7280', fontSize: 15 },
  // Card
  card: { background: '#fff', borderRadius: 12, boxShadow: '0 1px 6px rgba(0,0,0,0.07)', overflow: 'hidden' },
  cardFail: { boxShadow: '0 1px 6px rgba(0,0,0,0.07), inset 3px 0 0 #ef4444' },
  cardHeader: { display: 'flex', alignItems: 'flex-start', padding: '13px 16px', cursor: 'pointer', gap: 12 },
  cardMiddle: { flex: 1, minWidth: 0 },
  cardName: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', fontWeight: 700, fontSize: 14, color: '#111827', marginBottom: 4 },
  cardMeta: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: '#6b7280' },
  refTag: { color: '#475569', background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 999, padding: '1px 7px', fontSize: 11, fontWeight: 800 },
  projectTag: { background: '#ede9fe', color: '#6d28d9', padding: '1px 7px', borderRadius: 10, fontWeight: 600 },
  scoreChip: { background: '#f3f4f6', color: '#374151', padding: '1px 7px', borderRadius: 10, fontWeight: 600, fontSize: 11 },
  cardRight: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  statusBadge: { fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10 },
  chevron: { fontSize: 10, color: '#6b7280' },
  cardBody: { padding: '0 16px 14px', borderTop: '1px solid #f3f4f6' },
  notesBlock: { marginTop: 12, fontSize: 13, color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap' },
  sectionLabel: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6b7280', marginBottom: 8 },
  resultsGrid: { display: 'flex', flexDirection: 'column', gap: 4 },
  resultRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderRadius: 6, fontSize: 13 },
  resultRowFail: { background: '#fef2f2' },
  resultDot: { fontSize: 13, flexShrink: 0, width: 16 },
  resultLabel: { flex: 1, color: '#374151' },
  resultNote: { color: '#ef4444', fontSize: 12 },
  resultValue: { color: '#374151', fontSize: 12 },
  cardActions: { display: 'flex', gap: 8, marginTop: 14 },
  editBtn: { background: '#f3f4f6', border: 'none', color: '#374151', padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  deleteBtn: { background: 'none', border: '1px solid #fca5a5', color: '#ef4444', padding: '6px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  confirmDeleteBtn: { background: '#ef4444', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  cancelDeleteBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '6px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  inlineError: { fontSize: 12, color: '#ef4444' },
  // Template card
  templateCard: { background: '#fff', borderRadius: 10, padding: '14px 16px', boxShadow: '0 1px 6px rgba(0,0,0,0.07)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  templateInfo: { flex: 1 },
  templateName: { fontWeight: 700, fontSize: 14, color: '#111827' },
  templateDesc: { fontSize: 13, color: '#6b7280', marginTop: 2 },
  templateCount: { fontSize: 12, color: '#6b7280', marginTop: 4 },
  // Form
  form: { display: 'flex', flexDirection: 'column', gap: 14 },
  formTitle: { fontSize: 17, fontWeight: 700, margin: 0 },
  row: { display: 'flex', gap: 12, flexWrap: 'wrap' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 5, flex: 1, minWidth: 180 },
  label: { fontSize: 13, fontWeight: 600, color: '#374151' },
  optional: { fontWeight: 400, color: '#6b7280' },
  input: { padding: '9px 11px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, background: '#fff' },
  textarea: { padding: '9px 11px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 },
  typeSelect: { padding: '9px 8px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: '#fff' },
  error: { color: '#ef4444', fontSize: 13, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', margin: 0 },
  formActions: { display: 'flex', gap: 10 },
  submitBtn: { background: '#059669', color: '#fff', border: 'none', padding: '11px 22px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  cancelBtn: { background: '#f3f4f6', color: '#374151', border: 'none', padding: '11px 18px', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer' },
  // Template builder
  presetBtn: { background: '#eff6ff', color: 'var(--ops-page-accent)', border: '1px solid #bfdbfe', padding: '7px 14px', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  presetGrid: { display: 'flex', gap: 8, flexWrap: 'wrap', background: '#f9fafb', borderRadius: 8, padding: 12 },
  presetCard: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px', cursor: 'pointer', textAlign: 'left', minWidth: 140 },
  presetName: { fontSize: 13, fontWeight: 700, color: '#111827' },
  presetCount: { fontSize: 11, color: '#6b7280', marginTop: 2 },
  addItemBtn: { background: '#f3f4f6', border: 'none', color: '#374151', padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  itemRow: { display: 'flex', gap: 8, alignItems: 'center' },
  itemNum: { fontSize: 12, color: '#6b7280', width: 20, flexShrink: 0, textAlign: 'right' },
  removeItemBtn: { background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 14, padding: '0 4px' },
  pendingBadge: { fontSize: 10, fontWeight: 600, color: '#92400e', background: '#fef3c7', padding: '1px 6px', borderRadius: 6, marginLeft: 8, verticalAlign: 'middle' },
  // Checklist
  checklistGrid: { display: 'flex', flexDirection: 'column', gap: 8, background: '#f9fafb', borderRadius: 8, padding: 12 },
  checklistItem: { display: 'flex', flexDirection: 'column', gap: 6 },
  checklistLabel: { fontSize: 13, fontWeight: 600, color: '#374151' },
  pfRow: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
  pfBtn: { padding: '6px 14px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: '#fff', color: '#374151' },
  pfBtn_pass: { background: '#d1fae5', border: '1px solid #6ee7b7', color: '#065f46' },
  pfBtn_fail: { background: '#fee2e2', border: '1px solid #fca5a5', color: '#991b1b' },
};
