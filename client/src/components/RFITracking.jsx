import React, { useState, useEffect, useMemo } from 'react';
import api from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useOffline } from '../contexts/OfflineContext';
import { useT } from '../hooks/useT';
import { langToLocale } from '../utils';
import Pagination from './Pagination';
import { SkeletonList } from './Skeleton';
import FieldFilters from './FieldFilters';

import { silentError } from '../errorReporter';
function today() { return new Date().toLocaleDateString('en-CA'); }

function fmtRfiDate(value, locale = 'en-US') {
  if (!value) return '';
  const raw = value.toString().substring(0, 10);
  const parsed = new Date(`${raw}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

const STATUS_STYLES = {
  open:     { color: '#92400e', background: '#fef3c7' },
  answered: { color: '#065f46', background: '#d1fae5' },
  closed:   { color: '#374151', background: '#f3f4f6' },
};

// ── RFI Form ──────────────────────────────────────────────────────────────────

function RFIForm({ initial, projects, onSaved, onCancel, workLabel = 'Project' }) {
  const t = useT();
  const STATUS_LABELS = useMemo(() => ({ open: t.statusOpen, answered: t.statusAnswered, closed: t.statusClosed }), [t]);
  const isEdit = !!initial?.id;
  const [form, setForm] = useState({
    project_id: initial?.project_id ?? '',
    subject: initial?.subject ?? '',
    description: initial?.description ?? '',
    directed_to: initial?.directed_to ?? '',
    submitted_by: initial?.submitted_by ?? '',
    date_submitted: initial?.date_submitted?.toString().substring(0, 10) ?? today(),
    date_due: initial?.date_due?.toString().substring(0, 10) ?? '',
    response: initial?.response ?? '',
    status: initial?.status ?? 'open',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async e => {
    e.preventDefault();
    if (!form.subject.trim()) { setError(t.rfiSubjectRequired); return; }
    setSaving(true); setError('');
    try {
      const r = isEdit
        ? await api.patch(`/rfis/${initial.id}`, { ...form, updated_at: initial.updated_at })
        : await api.post('/rfis', form);
      if (!isEdit && r.data?.offline) {
        onSaved({ id: 'pending-' + Date.now(), pending: true, ...form, rfi_number: '?', status: 'open' }, false);
        return;
      }
      onSaved(r.data, isEdit);
    } catch (err) {
      const msg = err.response?.status === 409
        ? t.concurrentModification
        : err.response?.data?.error || t.failedToSave;
      setError(msg);
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={handleSubmit} style={styles.form}>
      <h3 style={styles.formTitle}>{isEdit ? `${t.editRFIPrefix} #${initial.rfi_number}` : t.newRFI}</h3>

      <div style={styles.row}>
        {projects.length > 0 && (
          <div style={styles.fieldGroup}>
            <label htmlFor="rfi-project" style={styles.label}>{workLabel}</label>
            <select id="rfi-project" style={styles.input} value={form.project_id} onChange={e => set('project_id', e.target.value)}>
              <option value="">{`No ${workLabel.toLowerCase()}`}</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
        <div style={{ ...styles.fieldGroup, flex: 3 }}>
          <label htmlFor="rfi-subject" style={styles.label}>{t.subjectField} *</label>
          <input id="rfi-subject" style={styles.input} type="text" placeholder={t.rfiSubjectPlaceholder} maxLength={255} value={form.subject} onChange={e => set('subject', e.target.value)} required />
        </div>
      </div>

      <div style={styles.fieldGroup}>
        <label htmlFor="rfi-description" style={styles.label}>{t.descriptionField} <span style={styles.optional}>({t.optional})</span></label>
        <textarea id="rfi-description" style={styles.textarea} rows={3} placeholder={t.rfiDescriptionPlaceholder} maxLength={2000} value={form.description} onChange={e => set('description', e.target.value)} />
        <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{form.description.length}/2000</div>
      </div>

      <div style={styles.row}>
        <div style={styles.fieldGroup}>
          <label htmlFor="rfi-directed-to" style={styles.label}>{t.directedTo}</label>
          <input id="rfi-directed-to" style={styles.input} type="text" placeholder={t.rfiDirectedToPlaceholder} maxLength={255} value={form.directed_to} onChange={e => set('directed_to', e.target.value)} />
        </div>
        <div style={styles.fieldGroup}>
          <label htmlFor="rfi-submitted-by" style={styles.label}>{t.submittedBy}</label>
          <input id="rfi-submitted-by" style={styles.input} type="text" placeholder={t.rfiSubmittedByPlaceholder} maxLength={255} value={form.submitted_by} onChange={e => set('submitted_by', e.target.value)} />
        </div>
      </div>

      <div style={styles.row}>
        <div style={styles.fieldGroup}>
          <label htmlFor="rfi-date-submitted" style={styles.label}>{t.dateSubmitted}</label>
          <input id="rfi-date-submitted" style={styles.input} type="date" value={form.date_submitted} onChange={e => set('date_submitted', e.target.value)} />
        </div>
        <div style={styles.fieldGroup}>
          <label htmlFor="rfi-date-due" style={styles.label}>{t.responseDue} <span style={styles.optional}>({t.optional})</span></label>
          <input id="rfi-date-due" style={styles.input} type="date" value={form.date_due} onChange={e => set('date_due', e.target.value)} />
        </div>
        {isEdit && (
          <div style={styles.fieldGroup}>
            <label htmlFor="rfi-status" style={styles.label}>{t.statusLabel}</label>
            <select id="rfi-status" style={styles.input} value={form.status} onChange={e => set('status', e.target.value)}>
              {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        )}
      </div>

      {isEdit && (
        <div style={styles.fieldGroup}>
          <label htmlFor="rfi-response" style={styles.label}>{t.rfiResponse}</label>
          <textarea id="rfi-response" style={styles.textarea} rows={3} placeholder={t.rfiResponsePlaceholder} maxLength={2000} value={form.response} onChange={e => set('response', e.target.value)} />
          <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{form.response.length}/2000</div>
        </div>
      )}

      {error && <p role="alert" style={styles.error}>{error}</p>}

      <div style={styles.formActions}>
        <button style={{ ...styles.submitBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={saving}>{saving ? t.saving : isEdit ? t.saveChanges : t.createRFI}</button>
        <button style={styles.cancelBtn} type="button" onClick={onCancel}>{t.cancel}</button>
      </div>
    </form>
  );
}

// ── RFI Card ──────────────────────────────────────────────────────────────────

function RFICard({ rfi, isAdmin, companyName, onEdit, onDeleted, settings = null }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const STATUS_LABELS = useMemo(() => ({ open: t.statusOpen, answered: t.statusAnswered, closed: t.statusClosed }), [t]);
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [pdfGenerating, setPdfGenerating] = useState(false);

  const downloadPDF = async () => {
    setPdfGenerating(true);
    try {
      const [{ pdf }, { RFIDocument }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('./RFIPdf'),
      ]);
      const blob = await pdf(React.createElement(RFIDocument, { rfi, companyName, t, language: user?.language, settings })).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `RFI-${rfi.rfi_number}-${(rfi.subject || 'rfi').replace(/[^a-z0-9]/gi, '-').toLowerCase()}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } finally { setPdfGenerating(false); }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError('');
    try { await api.delete(`/rfis/${rfi.id}`); onDeleted(rfi.id); }
    catch { setDeleteError(t.failedToDelete); setConfirmingDelete(false); }
    finally { setDeleting(false); }
  };

  const isOverdue = rfi.date_due && rfi.status === 'open' && new Date(`${rfi.date_due.toString().substring(0, 10)}T23:59:59`) < new Date();
  const statusStyle = STATUS_STYLES[rfi.status] || STATUS_STYLES.open;

  return (
    <div style={{ ...styles.card, ...(isOverdue ? styles.cardOverdue : {}) }}>
      <div style={styles.cardHeader} onClick={() => setExpanded(e => !e)} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setExpanded(prev => !prev)}>
        <div style={styles.rfiNumber}>#{rfi.rfi_number}</div>
        <div style={styles.cardMiddle}>
          <div style={styles.subject}>
            {rfi.subject}
            {rfi.pending && <span style={styles.pendingBadge}>⏳ {t.pendingSync}</span>}
          </div>
          <div style={styles.meta}>
            {rfi.project_name && <span style={styles.projectTag}>{rfi.project_name}</span>}
            {rfi.directed_to && <span>→ {rfi.directed_to}</span>}
            <span>{fmtRfiDate(rfi.date_submitted, locale)}</span>
            {rfi.date_due && (
              <span style={isOverdue ? styles.overdueDate : styles.dueDate}>
                {isOverdue ? 'Overdue: ' : ''}{t.dueDateLabel} {fmtRfiDate(rfi.date_due, locale)}
              </span>
            )}
          </div>
        </div>
        <div style={styles.cardRight}>
          <span style={{ ...styles.statusBadge, ...statusStyle }}>{STATUS_LABELS[rfi.status]}</span>
          <span style={styles.chevron}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div style={styles.cardBody}>
          {rfi.description && (
            <div style={styles.section}>
              <div style={styles.sectionLabel}>{t.descriptionSection}</div>
              <p style={styles.sectionText}>{rfi.description}</p>
            </div>
          )}

          {rfi.submitted_by && (
            <div style={styles.inlineMeta}>
              <span style={styles.metaKey}>{t.submittedByLabel}</span> {rfi.submitted_by}
            </div>
          )}

          {rfi.response ? (
            <div style={styles.responseBox}>
              <div style={styles.responseLabel}>{t.rfiResponse}</div>
              <p style={styles.responseText}>{rfi.response}</p>
            </div>
          ) : rfi.status === 'open' ? (
            <p style={styles.noResponse}>{t.noResponseYet}</p>
          ) : null}

          {!rfi.pending && (
            <div style={styles.cardActions}>
              <button style={{ ...styles.pdfBtn, ...(pdfGenerating ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={downloadPDF} disabled={pdfGenerating}>{pdfGenerating ? t.preparing : t.exportPDF}</button>
              {isAdmin && (
                <>
                  <button style={styles.editBtn} onClick={() => onEdit(rfi)}>
                    {rfi.status === 'open' && !rfi.response ? t.addResponse : t.edit}
                  </button>
                  {confirmingDelete ? (
                    <>
                      <button style={{ ...styles.confirmDeleteBtn, ...(deleting ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={handleDelete} disabled={deleting}>{deleting ? '…' : t.confirm}</button>
                      <button style={styles.smallCancelBtn} onClick={() => setConfirmingDelete(false)}>{t.cancel}</button>
                    </>
                  ) : (
                    <button style={styles.deleteBtn} onClick={() => setConfirmingDelete(true)}>{t.delete}</button>
                  )}
                  {deleteError && <span style={styles.inlineError}>{deleteError}</span>}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function RFITracking({ projects, settings = null }) {
  const { user } = useAuth();
  const t = useT();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const { onSync } = useOffline() || {};
  const workLabel = settings?.label_work || 'Project';
  const workLabelPlural = workLabel.endsWith('s') ? workLabel : `${workLabel}s`;

  const [rfis, setRfis] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [filters, setFilters] = useState({});
  const [companyName, setCompanyName] = useState('');

  const setFilter = (k, v) => setFilters(f => ({ ...f, [k]: v }));

  const loadRFIs = async (f = filters, p = 1) => {
    setPage(p);
    try {
      const params = { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), page: p, limit: 50 };
      const r = await api.get('/rfis', { params });
      setRfis(r.data.items);
      setTotalPages(r.data.pages);
    } catch (err) { silentError('rfi fetch')(err); }
  };

  useEffect(() => {
    loadRFIs(filters, 1).finally(() => setLoading(false));
    api.get('/company-info').then(r => setCompanyName(r.data.name || '')).catch(silentError('rfitracking'));
  }, []);
  useEffect(() => { if (!loading) loadRFIs(filters, 1); }, [filters]);
  useEffect(() => { if (!onSync) return; return onSync(count => { if (count > 0) loadRFIs(filters, page); }); }, [onSync]);

  const handleSaved = (rfi, isEdit) => {
    if (isEdit) {
      setRfis(prev => prev.map(r => r.id === rfi.id ? rfi : r));
      setEditing(null);
    } else {
      setRfis(prev => [rfi, ...prev]);
      setShowForm(false);
    }
  };

  const openCount = rfis.filter(r => r.status === 'open').length;
  const overdueCount = rfis.filter(r => r.date_due && r.status === 'open' && new Date(r.date_due) < new Date()).length;
  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  return (
    <div>
      <div style={styles.topRow}>
        <div>
          <h1 style={styles.heading}>{t.rfiTracking}</h1>
          <p style={styles.summary}>
            {rfis.length} RFI{rfis.length !== 1 ? 's' : ''} · {openCount} {t.rfiOpenLabel}
            {overdueCount > 0 && <span style={styles.overdueNote}> · {overdueCount} {t.rfiOverdueLabel}</span>}
          </p>
        </div>
        {isAdmin && !showForm && !editing && (
          <button style={styles.newBtn} onClick={() => setShowForm(true)}>+ {t.newRFI}</button>
        )}
      </div>

      {(showForm || editing) && (
        <div style={styles.formCard}>
          <RFIForm
            initial={editing || null}
            projects={projects}
            workLabel={workLabel}
            onSaved={handleSaved}
            onCancel={() => { setShowForm(false); setEditing(null); }}
          />
        </div>
      )}

      <FieldFilters activeCount={activeFilterCount}>
        <select style={styles.filterSelect} value={filters.status || ''} onChange={e => setFilter('status', e.target.value)}>
          <option value="">{t.allStatuses}</option>
          <option value="open">{t.statusOpen}</option>
          <option value="answered">{t.statusAnswered}</option>
          <option value="closed">{t.statusClosed}</option>
        </select>
        {projects.length > 0 && (
          <select style={styles.filterSelect} value={filters.project_id || ''} onChange={e => setFilter('project_id', e.target.value)}>
            <option value="">{`All ${workLabelPlural}`}</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        <input style={styles.filterInput} type="date" value={filters.from || ''} onChange={e => setFilter('from', e.target.value)} title={t.fromDate} />
        <input style={styles.filterInput} type="date" value={filters.to || ''} onChange={e => setFilter('to', e.target.value)} title={t.toDate} />
      </FieldFilters>

      {loading ? (
        <SkeletonList count={4} rows={2} />
      ) : rfis.length === 0 ? (
        <div style={styles.empty}>
          <p style={styles.emptyTitle}>No RFIs</p>
          <p style={styles.emptyText}>{isAdmin ? t.noRFIsAdmin : t.noRFIsWorker}</p>
          {isAdmin && !showForm && !editing && <button type="button" style={styles.emptyCtaBtn} onClick={() => setShowForm(true)}>{t.newRFI}</button>}
        </div>
      ) : (
        <>
          <div style={styles.list}>
            {rfis.map(r => (
              <RFICard
                key={r.id}
                rfi={r}
                isAdmin={isAdmin}
                companyName={companyName}
                settings={settings}
                onEdit={r => { setEditing(r); setShowForm(false); }}
                onDeleted={id => setRfis(prev => prev.filter(r => r.id !== id))}
              />
            ))}
          </div>
          <Pagination page={page} pages={totalPages} onChange={p => loadRFIs(filters, p)} />
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
  overdueNote: { color: '#ef4444', fontWeight: 700 },
  newBtn: { background: '#059669', color: '#fff', border: 'none', padding: '10px 18px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer', flexShrink: 0 },
  formCard: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 20 },
  filterBar: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 },
  filterSelect: { padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, background: '#fff', color: '#374151', flex: 1, minWidth: 120 },
  filterInput: { padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, background: '#fff', color: '#374151' },
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  hint: { color: '#6b7280', fontSize: 14 },
  empty: { textAlign: 'center', padding: '60px 20px' },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyTitle: { margin: '0 0 6px', fontSize: 18, fontWeight: 800, color: '#111827' },
  emptyText: { color: '#6b7280', fontSize: 15 },
  emptyCtaBtn: { marginTop: 14, background: '#059669', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 800, cursor: 'pointer' },
  // Card
  card: { background: '#fff', borderRadius: 12, boxShadow: '0 1px 6px rgba(0,0,0,0.07)', overflow: 'hidden' },
  cardOverdue: { boxShadow: '0 1px 6px rgba(0,0,0,0.07), inset 3px 0 0 #ef4444' },
  cardHeader: { display: 'flex', alignItems: 'flex-start', padding: '13px 16px', cursor: 'pointer', gap: 12 },
  rfiNumber: { fontSize: 13, fontWeight: 800, color: 'var(--ops-page-accent)', flexShrink: 0, minWidth: 36, marginTop: 1 },
  cardMiddle: { flex: 1, minWidth: 0 },
  subject: { fontWeight: 700, fontSize: 14, color: '#111827', marginBottom: 4 },
  meta: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: '#6b7280' },
  projectTag: { background: '#ede9fe', color: '#6d28d9', padding: '1px 7px', borderRadius: 10, fontWeight: 600 },
  dueDate: { color: '#6b7280' },
  overdueDate: { color: '#ef4444', fontWeight: 700 },
  cardRight: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  statusBadge: { fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10 },
  chevron: { fontSize: 10, color: '#6b7280' },
  cardBody: { padding: '0 16px 14px', borderTop: '1px solid #f3f4f6' },
  section: { marginTop: 12 },
  sectionLabel: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6b7280', marginBottom: 4 },
  sectionText: { fontSize: 14, color: '#374151', lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap' },
  inlineMeta: { fontSize: 13, color: '#374151', marginTop: 10 },
  metaKey: { fontWeight: 600, color: '#6b7280' },
  responseBox: { background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 14px', marginTop: 12 },
  responseLabel: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#059669', marginBottom: 6 },
  responseText: { fontSize: 13, color: '#374151', lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap' },
  noResponse: { fontSize: 13, color: '#6b7280', fontStyle: 'italic', marginTop: 10 },
  cardActions: { display: 'flex', gap: 8, marginTop: 14 },
  pdfBtn: { display: 'inline-block', background: '#eff6ff', color: 'var(--ops-page-accent)', border: '1px solid #bfdbfe', padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  editBtn: { background: '#f3f4f6', border: 'none', color: '#374151', padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  deleteBtn: { background: 'none', border: '1px solid #fca5a5', color: '#ef4444', padding: '6px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  confirmDeleteBtn: { background: '#ef4444', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  smallCancelBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '6px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  inlineError: { fontSize: 12, color: '#ef4444' },
  // Form
  form: { display: 'flex', flexDirection: 'column', gap: 14 },
  formTitle: { fontSize: 17, fontWeight: 700, margin: 0 },
  row: { display: 'flex', gap: 12, flexWrap: 'wrap' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 5, flex: 1, minWidth: 180 },
  label: { fontSize: 13, fontWeight: 600, color: '#374151' },
  optional: { fontWeight: 400, color: '#6b7280' },
  input: { padding: '9px 11px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, background: '#fff' },
  textarea: { padding: '9px 11px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 },
  error: { color: '#ef4444', fontSize: 13, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', margin: 0 },
  formActions: { display: 'flex', gap: 10 },
  submitBtn: { background: '#059669', color: '#fff', border: 'none', padding: '11px 22px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  cancelBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '11px 22px', borderRadius: 8, fontSize: 14, cursor: 'pointer' },
  pendingBadge: { fontSize: 10, fontWeight: 600, color: '#92400e', background: '#fef3c7', padding: '1px 6px', borderRadius: 6, marginLeft: 8, verticalAlign: 'middle' },
};
