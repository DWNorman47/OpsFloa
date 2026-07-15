import React, { useState, useEffect, useMemo } from 'react';
import api from '../api';
import { useAuth } from '../contexts/AuthContext';
import { langToLocale } from '../utils';
import { useT } from '../hooks/useT';
import Pagination from './Pagination';
import { SkeletonList } from './Skeleton';
import FieldFilters from './FieldFilters';

const today = () => new Date().toLocaleDateString('en-CA');

function formatChecklistDate(value, locale = 'en-US') {
  if (!value) return '';
  const dateText = String(value);
  const date = dateText.includes('T') ? new Date(dateText) : new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateText;
  return date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function normalizeChecklistItem(item = {}) {
  return {
    ...item,
    label: item.label ?? item.text ?? item.name ?? '',
    type: item.type === 'checkbox' ? 'check' : (item.type || 'check'),
  };
}

function normalizeTemplate(template = {}) {
  return {
    ...template,
    items: Array.isArray(template.items) ? template.items.map(normalizeChecklistItem) : [],
  };
}

function checklistAnswer(answers, item, index) {
  return answers?.[index] ?? answers?.[item?.id] ?? answers?.[item?.label] ?? answers?.[item?.text];
}

const PRESETS = [
  {
    name: 'Daily Workplace Safety',
    description: 'General daily workplace safety walkthrough',
    items: [
      { label: 'PPE available and in use', type: 'check' },
      { label: 'First aid kit stocked', type: 'check' },
      { label: 'Emergency contacts posted', type: 'check' },
      { label: 'Fall protection in place', type: 'check' },
      { label: 'Walkways clear of hazards', type: 'check' },
      { label: 'Tools and equipment in good condition', type: 'check' },
      { label: 'Notes', type: 'text' },
    ],
  },
  {
    name: 'Pre-Task Hazard Assessment',
    description: 'Fill out before starting any new task',
    items: [
      { label: 'Task and work area explained to the team', type: 'check' },
      { label: 'Hazards identified and communicated', type: 'check' },
      { label: 'Required PPE confirmed', type: 'check' },
      { label: 'Emergency exit routes known', type: 'check' },
      { label: 'Describe the main hazard for this task', type: 'text' },
      { label: 'Controls or precautions in place', type: 'text' },
    ],
  },
  {
    name: 'End-of-Day Closeout',
    description: 'Before wrapping up each day',
    items: [
      { label: 'All tools secured or stored', type: 'check' },
      { label: 'Materials stacked and secured', type: 'check' },
      { label: 'No open electrical hazards', type: 'check' },
      { label: 'Site access points secured', type: 'check' },
      { label: 'Waste and debris contained', type: 'check' },
      { label: 'Notes', type: 'text' },
    ],
  },
];

// ── Template Manager ──────────────────────────────────────────────────────────

function TemplateForm({ initial, onSaved, onCancel }) {
  const t = useT();
  const isEdit = !!initial?.id;
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [items, setItems] = useState(
    (initial?.items ?? []).map(i => ({ ...i, _id: Math.random() }))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showPresets, setShowPresets] = useState(false);

  const addItem = () => setItems(p => [...p, { _id: Math.random(), label: '', type: 'check' }]);
  const removeItem = id => setItems(p => p.filter(i => i._id !== id));
  const updateItem = (id, k, v) => setItems(p => p.map(i => i._id === id ? { ...i, [k]: v } : i));

  const submit = async e => {
    e.preventDefault();
    if (!name.trim()) { setError(t.nameRequired); return; }
    if (items.filter(i => i.label.trim()).length === 0) { setError(t.atLeastOneItem); return; }
    setSaving(true); setError('');
    const payload = {
      name,
      description,
      items: items.filter(i => i.label.trim()).map(({ _id, ...i }) => i),
    };
    try {
      const r = isEdit
        ? await api.patch(`/safety-checklists/templates/${initial.id}`, payload)
        : await api.post('/safety-checklists/templates', payload);
      onSaved(r.data, isEdit);
    } catch (err) {
      setError(err.response?.data?.error || t.failedToSave);
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={submit} style={styles.form}>
      <div style={styles.formTitleRow}>
        <h3 style={styles.formTitle}>{isEdit ? t.editTemplate : t.newChecklistTemplate}</h3>
        {!isEdit && (
          <button type="button" style={styles.presetBtn} onClick={() => setShowPresets(s => !s)}>
            {showPresets ? t.hidePresets : t.fromPreset}
          </button>
        )}
      </div>

      {showPresets && (
        <div style={styles.presetGrid}>
          {PRESETS.map(p => (
            <button key={p.name} type="button" style={styles.presetCard} onClick={() => {
              setName(p.name); setDescription(p.description);
              setItems(p.items.map(i => ({ ...i, _id: Math.random() })));
              setShowPresets(false);
            }}>
              <div style={styles.presetCardName}>{p.name}</div>
              <div style={styles.presetCardDesc}>{p.description}</div>
            </button>
          ))}
        </div>
      )}

      <div style={styles.formGrid}>
        <div style={{ ...styles.fieldGroup, gridColumn: '1 / -1' }}>
          <label style={styles.label}>{t.templateNameLabel}<span style={{ color: '#ef4444', marginLeft: 2 }}>*</span></label>
          <input style={styles.input} type="text" maxLength={255} value={name} onChange={e => setName(e.target.value)} placeholder={t.checklistNamePlaceholder} />
        </div>
        <div style={{ ...styles.fieldGroup, gridColumn: '1 / -1' }}>
          <label style={styles.label}>{t.descriptionField}</label>
          <input style={styles.input} type="text" maxLength={500} value={description} onChange={e => setDescription(e.target.value)} placeholder={t.descriptionField} />
        </div>
      </div>

      <div style={styles.itemsSection}>
        <div style={styles.itemsHeader}>
          <span style={styles.label}>{t.checklistItemsLabel}</span>
          <button type="button" style={styles.addItemBtn} onClick={addItem}>{t.addItem}</button>
        </div>
        {items.map((item, idx) => (
          <div key={item._id} style={styles.itemEditRow}>
            <span style={styles.itemIdx}>{idx + 1}</span>
            <input
              style={{ ...styles.input, flex: 1 }}
              type="text"
              placeholder={t.itemLabelPlaceholder}
              value={item.label}
              onChange={e => updateItem(item._id, 'label', e.target.value)}
            />
            <select style={styles.typeSelect} value={item.type} onChange={e => updateItem(item._id, 'type', e.target.value)}>
              <option value="check">{t.checklistTypeCheckbox}</option>
              <option value="text">{t.checklistTypeText}</option>
            </select>
            <button type="button" style={styles.removeItemBtn} aria-label={t.removeItem} onClick={() => removeItem(item._id)}>✕</button>
          </div>
        ))}
        {items.length === 0 && <p style={styles.hint}>{t.noItemsYet}</p>}
      </div>

      {error && <p role="alert" style={styles.error}>{error}</p>}
      <div style={styles.formActions}>
        <button style={{ ...styles.submitBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={saving}>{saving ? t.saving : isEdit ? t.saveChanges : t.createTemplate}</button>
        <button style={styles.cancelBtn} type="button" onClick={onCancel}>{t.cancel}</button>
      </div>
    </form>
  );
}

// ── Fill Out Form ─────────────────────────────────────────────────────────────

function FillForm({ templates, projects, onSubmitted, onCancel }) {
  const t = useT();
  const [templateId, setTemplateId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [checkDate, setCheckDate] = useState(today());
  const [answers, setAnswers] = useState({});
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const template = templates.find(t => String(t.id) === String(templateId));
  const items = template?.items ?? [];

  const setAnswer = (idx, val) => setAnswers(a => ({ ...a, [idx]: val }));

  const allRequiredAnswered = items.every((item, i) =>
    item.type === 'text' ? true : answers[i] !== undefined
  );

  const submit = async e => {
    e.preventDefault();
    if (!templateId) { setError(t.selectChecklistError); return; }
    setSaving(true); setError('');
    try {
      const r = await api.post('/safety-checklists', {
        template_id: templateId,
        project_id: projectId || null,
        check_date: checkDate,
        answers,
        notes: notes || null,
      });
      onSubmitted(r.data);
    } catch (err) {
      setError(err.response?.data?.error || t.failedToSave);
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={submit} style={styles.form}>
      <h3 style={styles.formTitle}>{t.fillOutChecklist}</h3>

      <div style={styles.formGrid}>
        <div style={{ ...styles.fieldGroup, gridColumn: '1 / -1' }}>
          <label style={styles.label}>{t.templateField} *</label>
          <select style={styles.input} value={templateId} onChange={e => { setTemplateId(e.target.value); setAnswers({}); }}>
            <option value="">{t.selectChecklistOpt}</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div style={styles.fieldGroup}>
          <label style={styles.label}>{t.date}</label>
          <input style={styles.input} type="date" value={checkDate} onChange={e => setCheckDate(e.target.value)} />
        </div>
        {projects.length > 0 && (
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Project</label>
            <select style={styles.input} value={projectId} onChange={e => setProjectId(e.target.value)}>
              <option value="">{`No project`}</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
      </div>

      {template?.description && (
        <p style={styles.templateDesc}>{template.description}</p>
      )}

      {items.length > 0 && (
        <div style={styles.fillItems}>
          {items.map((item, i) => (
            <div key={i} style={styles.fillRow}>
              {item.type === 'check' ? (
                <>
                  <input
                    type="checkbox"
                    id={`item-${i}`}
                    checked={answers[i] === true}
                    onChange={e => setAnswer(i, e.target.checked)}
                    style={styles.fillCheckbox}
                  />
                  <label htmlFor={`item-${i}`} style={styles.fillLabel}>{item.label}</label>
                </>
              ) : (
                <div style={{ flex: 1 }}>
                  <label style={styles.fillLabel}>{item.label}</label>
                  <input
                    style={{ ...styles.input, marginTop: 4 }}
                    type="text"
                    placeholder={t.enterResponse}
                    value={answers[i] || ''}
                    onChange={e => setAnswer(i, e.target.value)}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {items.length > 0 && (
        <div style={styles.fieldGroup}>
          <label style={styles.label}>{t.additionalNotes}</label>
          <textarea style={styles.textarea} rows={2} placeholder={t.anyObservations} maxLength={1000} value={notes} onChange={e => setNotes(e.target.value)} />
          <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{notes.length}/1000</div>
        </div>
      )}

      {error && <p role="alert" style={styles.error}>{error}</p>}
      <div style={styles.formActions}>
        <button style={{ ...styles.submitBtn, ...((saving || !templateId) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={saving || !templateId}>
          {saving ? t.submitting : t.submitChecklist}
        </button>
        <button style={styles.cancelBtn} type="button" onClick={onCancel}>{t.cancel}</button>
      </div>
    </form>
  );
}

// ── Submission Card ───────────────────────────────────────────────────────────

function SubmissionCard({ sub, isAdmin, onDeleted }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const items = sub.template_items ?? [];

  const checkItems = items.filter(i => i.type === 'check');
  const checkedCount = checkItems.filter((_, i) => {
    const globalIdx = items.indexOf(checkItems[i]);
    return checklistAnswer(sub.answers, checkItems[i], globalIdx) === true;
  }).length;

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError('');
    try { await api.delete(`/safety-checklists/${sub.id}`); onDeleted(sub.id); }
    catch { setDeleteError(t.failedToDelete); setConfirmingDelete(false); }
    finally { setDeleting(false); }
  };

  return (
    <div style={styles.card}>
      <div style={styles.cardHeader} onClick={() => setExpanded(e => !e)} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setExpanded(prev => !prev)}>
        <div style={styles.cardLeft}>
          <div style={styles.cardTitle}>{sub.template_name}</div>
          <div style={styles.cardMeta}>
            {formatChecklistDate(sub.check_date, locale)}
            {sub.project_name && <span style={styles.projectTag}>{sub.project_name}</span>}
            {sub.submitted_by_name && <span style={styles.submittedBy}>{t.submittedBy} {sub.submitted_by_name}</span>}
          </div>
        </div>
        <div style={styles.cardRight}>
          {checkItems.length > 0 && (
            <span style={{ ...styles.progressBadge, ...(checkedCount === checkItems.length ? styles.progressDone : {}) }}>
              {checkedCount}/{checkItems.length} done
            </span>
          )}
          <span style={styles.chevron}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div style={styles.cardBody}>
          {items.length > 0 && (
            <div style={styles.answerList}>
              {items.map((item, i) => (
                <div key={i} style={styles.answerRow}>
                  {item.type === 'check' ? (
                    <>
                      <span style={checklistAnswer(sub.answers, item, i) ? styles.checkYes : styles.checkNo}>
                        {checklistAnswer(sub.answers, item, i) ? 'Yes' : 'No'}
                      </span>
                      <span style={styles.answerLabel}>{item.label}</span>
                    </>
                  ) : (
                    <div style={{ flex: 1 }}>
                      <div style={styles.answerLabel}>{item.label}</div>
                      {checklistAnswer(sub.answers, item, i) && <div style={styles.answerText}>{checklistAnswer(sub.answers, item, i)}</div>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {sub.notes && <p style={styles.subNotes}>{sub.notes}</p>}
          {isAdmin && (
            <div style={styles.cardActions}>
              {confirmingDelete ? (
                <>
                  <button style={{ ...styles.confirmDeleteBtn, ...(deleting ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={handleDelete} disabled={deleting}>{deleting ? t.saving : t.confirm}</button>
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

// ── Main Component ────────────────────────────────────────────────────────────

export default function SafetyChecklists({ projects }) {
  const t = useT();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const [view, setView] = useState('list'); // 'list' | 'fill' | 'templates'
  const [templates, setTemplates] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [filterProject, setFilterProject] = useState('');
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [pendingDeleteTemplateId, setPendingDeleteTemplateId] = useState(null);

  // Attach template items to submissions for rendering
  const { templatesById, enriched } = useMemo(() => {
    const byId = Object.fromEntries(templates.map(t => [t.id, t]));
    return {
      templatesById: byId,
      enriched: submissions.map(s => ({ ...s, template_items: byId[s.template_id]?.items ?? [] })),
    };
  }, [templates, submissions]);

  const load = async (proj = filterProject, p = 1) => {
    setPage(p);
    try {
      const params = { page: p, limit: 50 };
      if (proj) params.project_id = proj;
      const [t, s] = await Promise.all([
        api.get('/safety-checklists/templates'),
        api.get('/safety-checklists', { params }),
      ]);
      setTemplates((t.data || []).map(normalizeTemplate));
      setSubmissions(s.data.items);
      setTotalPages(s.data.pages);
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);
  useEffect(() => { if (!loading) load(filterProject, 1); }, [filterProject]);

  if (view === 'fill') {
    return (
      <div style={styles.formCard}>
        <FillForm
          templates={templates}
          projects={projects}
          onSubmitted={sub => { setSubmissions(prev => [sub, ...prev]); setView('list'); }}
          onCancel={() => setView('list')}
        />
      </div>
    );
  }

  if (view === 'templates') {
    return (
      <div>
        <div style={styles.topRow}>
          <h2 style={styles.heading}>{t.checklistTemplates}</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={styles.newBtn} onClick={() => { setEditingTemplate(null); setShowTemplateForm(true); }}>{t.newTemplate}</button>
            <button style={styles.backBtn} onClick={() => { setShowTemplateForm(false); setView('list'); }}>← {t.back}</button>
          </div>
        </div>

        {showTemplateForm && (
          <div style={styles.formCard}>
            <TemplateForm
              initial={editingTemplate}
              onSaved={(t, isEdit) => {
                const normalized = normalizeTemplate(t);
                setTemplates(prev => isEdit ? prev.map(x => x.id === normalized.id ? normalized : x) : [normalized, ...prev]);
                setShowTemplateForm(false);
                setEditingTemplate(null);
              }}
              onCancel={() => { setShowTemplateForm(false); setEditingTemplate(null); }}
            />
          </div>
        )}

        {templates.length === 0 && !showTemplateForm ? (
          <div style={styles.empty}>
            <p style={styles.emptyText}>{t.noTemplatesAdmin}</p>
            <button style={styles.emptyCtaBtn} onClick={() => setShowTemplateForm(true)}>
              + Create Template
            </button>
          </div>
        ) : (
          <div style={styles.list}>
            {templates.map(tmpl => (
              <div key={tmpl.id} style={styles.templateCard}>
                <div style={styles.templateCardLeft}>
                  <div style={styles.templateCardName}>{tmpl.name}</div>
                  {tmpl.description && <div style={styles.templateCardDesc}>{tmpl.description}</div>}
                  <div style={styles.templateCardCount}>{tmpl.items?.length ?? 0} {t.itemsCount}</div>
                </div>
                <div style={styles.templateCardActions}>
                  <button style={styles.editBtn} onClick={() => { setEditingTemplate({ ...tmpl, items: tmpl.items?.map(i => ({ ...i, _id: Math.random() })) }); setShowTemplateForm(true); }}>{t.edit}</button>
                  {pendingDeleteTemplateId === tmpl.id ? (
                    <>
                      <button style={styles.confirmDeleteBtn} onClick={async () => {
                        await api.delete(`/safety-checklists/templates/${tmpl.id}`);
                        setTemplates(prev => prev.filter(x => x.id !== tmpl.id));
                        setPendingDeleteTemplateId(null);
                      }}>{t.confirm}</button>
                      <button style={styles.cancelDeleteBtn} onClick={() => setPendingDeleteTemplateId(null)}>{t.cancel}</button>
                    </>
                  ) : (
                    <button style={styles.deleteBtn} onClick={() => setPendingDeleteTemplateId(tmpl.id)}>{t.delete}</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={styles.topRow}>
        <div>
          <h2 style={styles.heading}>{t.safetyChecklists}</h2>
          {submissions.length > 0 && (
            <p style={styles.summary}>{submissions.length} {submissions.length !== 1 ? t.submissionsPluralCount : t.submissionsCount}</p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {isAdmin && <button style={styles.templatesBtn} onClick={() => setView('templates')}>{t.manageTemplates}</button>}
          <button style={{ ...styles.newBtn, ...(templates.length === 0 ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => setView('fill')} disabled={templates.length === 0}>
            {templates.length === 0 ? t.noTemplates : `+ ${t.fillOut}`}
          </button>
        </div>
      </div>

      {projects.length > 0 && (
        <FieldFilters activeCount={filterProject ? 1 : 0}>
          <select style={styles.filterSelect} value={filterProject} onChange={e => setFilterProject(e.target.value)}>
            <option value="">{`All Projects`}</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </FieldFilters>
      )}

      {loading ? (
        <SkeletonList count={4} rows={2} />
      ) : submissions.length === 0 ? (
        <div style={styles.empty}>
          <p style={styles.emptyText}>
            {templates.length === 0
              ? isAdmin ? t.noTemplatesAdmin : t.noTemplatesWorker
              : t.noSubmissionsYet}
          </p>
        </div>
      ) : (
        <>
          <div style={styles.list}>
            {enriched.map(s => (
              <SubmissionCard
                key={s.id}
                sub={s}
                isAdmin={isAdmin}
                onDeleted={id => setSubmissions(prev => prev.filter(x => x.id !== id))}
              />
            ))}
          </div>
          <Pagination page={page} pages={totalPages} onChange={p => load(filterProject, p)} />
        </>
      )}
    </div>
  );
}

const styles = {
  topRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' },
  heading: { fontSize: 22, fontWeight: 800, color: '#111827', margin: 0 },
  summary: { fontSize: 13, color: '#6b7280', margin: '4px 0 0' },
  newBtn: { background: '#059669', color: '#fff', border: 'none', padding: '10px 18px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer', flexShrink: 0 },
  templatesBtn: { background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', padding: '9px 16px', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer', flexShrink: 0 },
  backBtn: { background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', padding: '9px 16px', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  filters: { marginBottom: 14 },
  filterSelect: { padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, background: '#fff', minWidth: 160 },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  // Submission card
  card: { background: '#fff', borderRadius: 12, boxShadow: '0 1px 6px rgba(0,0,0,0.07)', overflow: 'hidden' },
  cardHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', cursor: 'pointer', gap: 12 },
  cardLeft: { flex: 1, minWidth: 0 },
  cardTitle: { fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 4 },
  cardMeta: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: '#6b7280' },
  projectTag: { background: '#ede9fe', color: '#6d28d9', padding: '1px 7px', borderRadius: 10, fontWeight: 600 },
  submittedBy: { color: '#6b7280' },
  cardRight: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  progressBadge: { fontSize: 11, fontWeight: 700, color: '#92400e', background: '#fef3c7', padding: '2px 8px', borderRadius: 10 },
  progressDone: { color: '#065f46', background: '#d1fae5' },
  chevron: { fontSize: 10, color: '#6b7280' },
  cardBody: { padding: '0 16px 16px', borderTop: '1px solid #f3f4f6' },
  answerList: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 },
  answerRow: { display: 'flex', alignItems: 'flex-start', gap: 10 },
  checkYes: { fontSize: 14, fontWeight: 700, color: '#059669', flexShrink: 0, marginTop: 1 },
  checkNo: { fontSize: 14, fontWeight: 700, color: '#dc2626', flexShrink: 0, marginTop: 1 },
  answerLabel: { fontSize: 13, color: '#374151', fontWeight: 500 },
  answerText: { fontSize: 13, color: '#6b7280', marginTop: 2, fontStyle: 'italic' },
  subNotes: { fontSize: 13, color: '#6b7280', margin: '12px 0 8px', fontStyle: 'italic' },
  cardActions: { display: 'flex', gap: 8, marginTop: 10 },
  // Template card
  templateCard: { background: '#fff', borderRadius: 10, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  templateCardLeft: { flex: 1, minWidth: 0 },
  templateCardName: { fontWeight: 700, fontSize: 14, color: '#111827', marginBottom: 2 },
  templateCardDesc: { fontSize: 12, color: '#6b7280', marginBottom: 4 },
  templateCardCount: { fontSize: 11, color: '#6b7280' },
  templateCardActions: { display: 'flex', gap: 8, flexShrink: 0 },
  editBtn: { background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  deleteBtn: { background: 'none', border: '1px solid #fca5a5', color: '#ef4444', padding: '5px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  confirmDeleteBtn: { background: '#ef4444', color: '#fff', border: 'none', padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  cancelDeleteBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '5px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  inlineError: { fontSize: 12, color: '#ef4444' },
  // Form
  formCard: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 20 },
  form: { display: 'flex', flexDirection: 'column', gap: 14 },
  formTitleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  formTitle: { fontSize: 17, fontWeight: 700, margin: 0 },
  presetBtn: { fontSize: 13, fontWeight: 600, color: 'var(--ops-page-accent)', background: '#eff6ff', border: '1px solid #bfdbfe', padding: '6px 14px', borderRadius: 7, cursor: 'pointer' },
  presetGrid: { display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 0 8px', borderBottom: '1px solid #f3f4f6' },
  presetCard: { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px', cursor: 'pointer', textAlign: 'left' },
  presetCardName: { fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 2 },
  presetCardDesc: { fontSize: 12, color: '#6b7280' },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12 },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 12, fontWeight: 600, color: '#6b7280' },
  input: { padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, width: '100%', boxSizing: 'border-box' },
  textarea: { padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5, width: '100%' },
  itemsSection: { display: 'flex', flexDirection: 'column', gap: 8 },
  itemsHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  addItemBtn: { fontSize: 12, fontWeight: 600, color: '#059669', background: '#ecfdf5', border: '1px solid #a7f3d0', padding: '5px 12px', borderRadius: 6, cursor: 'pointer' },
  itemEditRow: { display: 'flex', alignItems: 'center', gap: 8 },
  itemIdx: { fontSize: 12, fontWeight: 700, color: '#6b7280', flexShrink: 0, width: 18 },
  typeSelect: { padding: '8px 6px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12, background: '#fff', flexShrink: 0 },
  removeItemBtn: { fontSize: 11, color: '#6b7280', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', borderRadius: 4, flexShrink: 0 },
  templateDesc: { fontSize: 13, color: '#6b7280', margin: '0 0 4px', fontStyle: 'italic' },
  fillItems: { display: 'flex', flexDirection: 'column', gap: 12, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: 14 },
  fillRow: { display: 'flex', alignItems: 'flex-start', gap: 10 },
  fillCheckbox: { width: 18, height: 18, cursor: 'pointer', flexShrink: 0, marginTop: 1, accentColor: '#059669' },
  fillLabel: { fontSize: 14, color: '#374151', fontWeight: 500 },
  error: { color: '#ef4444', fontSize: 13, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', margin: 0 },
  formActions: { display: 'flex', gap: 10 },
  submitBtn: { background: '#059669', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  cancelBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '10px 20px', borderRadius: 8, fontSize: 14, cursor: 'pointer' },
  empty: { textAlign: 'center', padding: '60px 20px' },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyText: { color: '#6b7280', fontSize: 15 },
  emptyCtaBtn: { marginTop: 14, background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  hint: { color: '#6b7280', fontSize: 14 },
};
