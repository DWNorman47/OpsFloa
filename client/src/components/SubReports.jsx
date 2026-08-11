import React, { useState, useEffect, useMemo } from 'react';
import api from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useOffline } from '../contexts/OfflineContext';
import { useT } from '../hooks/useT';
import { langToLocale } from '../utils';
import Pagination from './Pagination';
import { SkeletonList } from './Skeleton';
import FieldFilters from './FieldFilters';
import { labelSg, labelPl } from '../companyLabels';

import { silentError } from '../errorReporter';
function today() {
  return new Date().toLocaleDateString('en-CA');
}

function fmtSubDate(value, locale = 'en-US') {
  if (!value) return '';
  const raw = value.toString().substring(0, 10);
  const parsed = new Date(`${raw}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

const BLANK = {
  report_date: today(), project_id: '', sub_company: '',
  foreman_name: '', headcount: '', work_performed: '', notes: '',
};

// ── Form (create or edit) ─────────────────────────────────────────────────────

function SubReportForm({ projects, initial = BLANK, onSaved, onCancel, workerLabelPluralLower = 'workers' }) {
  const t = useT();
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setError(''); };
  const isEdit = !!initial.id;

  const handleSubmit = async e => {
    e.preventDefault();
    if (!form.sub_company.trim()) { setError(t.subCompanyRequired); return; }
    setSaving(true); setError('');
    try {
      const r = isEdit
        ? await api.patch(`/sub-reports/${initial.id}`, form)
        : await api.post('/sub-reports', form);
      if (!isEdit && r.data?.offline) {
        onSaved({ id: 'pending-' + Date.now(), pending: true, ...form, project_name: '' }, false);
        return;
      }
      onSaved(r.data, isEdit);
    } catch (err) {
      setError(err.response?.data?.error || t.failedToSave);
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={handleSubmit} style={styles.form}>
      <h3 style={styles.formTitle}>{isEdit ? t.editSubReport : t.newSubReport}</h3>

      <div style={styles.row}>
        <div style={styles.fieldGroup}>
          <label style={styles.label}>{t.date} *</label>
          <input style={styles.input} type="date" value={form.report_date} onChange={e => set('report_date', e.target.value)} required max={today()} />
        </div>
        {projects.length > 0 && (
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Project</label>
            <select style={styles.input} value={form.project_id} onChange={e => set('project_id', e.target.value)}>
              <option value="">{`No project`}</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
      </div>

      <div style={styles.row}>
        <div style={styles.fieldGroup}>
          <label style={styles.label}>{t.subCompany} *</label>
          <input style={styles.input} type="text" placeholder={t.companyNamePlaceholder} maxLength={255} value={form.sub_company} onChange={e => set('sub_company', e.target.value)} required />
        </div>
        <div style={styles.fieldGroup}>
          <label style={styles.label}>{t.foremanField}</label>
          <input style={styles.input} type="text" placeholder={t.nameOnSitePlaceholder} maxLength={255} value={form.foreman_name} onChange={e => set('foreman_name', e.target.value)} />
        </div>
      </div>

      <div style={styles.fieldGroup}>
        <label style={styles.label}>{t.headcount} <span style={styles.optional}>({workerLabelPluralLower} on location)</span></label>
        <input style={{ ...styles.input, maxWidth: 120 }} type="number" min="1" placeholder="0" value={form.headcount} onChange={e => set('headcount', e.target.value)} />
      </div>

      <div style={styles.fieldGroup}>
        <label style={styles.label}>{t.workPerformed}</label>
        <textarea style={styles.textarea} rows={3} placeholder={t.subWorkPerformedPlaceholder} maxLength={2000} value={form.work_performed} onChange={e => set('work_performed', e.target.value)} />
        <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{form.work_performed.length}/2000</div>
      </div>

      <div style={styles.fieldGroup}>
        <label style={styles.label}>{t.notes} <span style={styles.optional}>({t.optional})</span></label>
        <textarea style={styles.textarea} rows={2} placeholder={t.issuesPlaceholder} maxLength={1000} value={form.notes} onChange={e => set('notes', e.target.value)} />
        <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{(form.notes || '').length}/1000</div>
      </div>

      {error && <p role="alert" style={styles.error}>{error}</p>}

      <div style={styles.formActions}>
        <button style={{ ...styles.submitBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={saving}>{saving ? t.saving : isEdit ? t.saveChanges : t.addReport}</button>
        <button style={styles.cancelBtn} type="button" onClick={onCancel}>{t.cancel}</button>
      </div>
    </form>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────

function SubCard({ report, onEdit, onDeleted }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const headcount = Number(report.headcount || 0);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.delete(`/sub-reports/${report.id}`);
      onDeleted(report.id);
    } finally { setDeleting(false); }
  };

  return (
    <div style={styles.card}>
      <div style={styles.cardHeader} onClick={() => setExpanded(e => !e)} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setExpanded(prev => !prev)}>
        <div style={styles.cardLeft}>
          <div style={styles.subName}>
            {report.sub_company}
            {report.pending && <span style={styles.pendingBadge}>⏳ {t.pendingSync}</span>}
          </div>
          <div style={styles.cardMeta}>
            <span>{fmtSubDate(report.report_date, locale)}</span>
            {report.project_name && <span style={styles.projectTag}>{report.project_name}</span>}
            {headcount > 0 && <span style={styles.headcountTag}>{headcount} {headcount === 1 ? 'person' : 'people'}</span>}
            {report.foreman_name && <span style={styles.foremanTag}>Lead: {report.foreman_name}</span>}
          </div>
        </div>
        <span style={styles.chevron}>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div style={styles.cardBody}>
          {report.work_performed && (
            <div style={styles.section}>
              <div style={styles.sectionLabel}>{t.workPerformed}</div>
              <p style={styles.sectionText}>{report.work_performed}</p>
            </div>
          )}
          {report.notes && (
            <div style={styles.section}>
              <div style={styles.sectionLabel}>{t.notes}</div>
              <p style={styles.sectionText}>{report.notes}</p>
            </div>
          )}
          {!report.pending && (
            <div style={styles.cardActions}>
              <button style={styles.editBtn} onClick={() => onEdit(report)}>{t.edit}</button>
              {confirmingDelete ? (
                <>
                  <button style={{ ...styles.confirmDeleteBtn, ...(deleting ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={handleDelete} disabled={deleting}>{deleting ? '…' : t.confirm}</button>
                  <button style={styles.cancelDeleteBtn} onClick={() => setConfirmingDelete(false)}>{t.cancel}</button>
                </>
              ) : (
                <button style={styles.deleteBtn} onClick={() => setConfirmingDelete(true)}>{t.delete}</button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function SubReports({ projects, settings = null, defaultProjectId = null }) {
  const t = useT();
  const { user } = useAuth();
  const { onSync } = useOffline() || {};
  const workerLabel = labelSg(settings?.label_worker, 'worker', user?.language);
  const workerLabelPlural = labelPl(settings?.label_worker, 'worker', user?.language);
  const workerLabelPluralLower = workerLabelPlural.toLowerCase();
  const [reports, setReports] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [filters, setFilters] = useState({});

  const setFilter = (k, v) => setFilters(f => ({ ...f, [k]: v }));

  const loadReports = async (f = filters, p = 1) => {
    setPage(p);
    try {
      const params = { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), page: p, limit: 50 };
      const r = await api.get('/sub-reports', { params });
      setReports(r.data.items);
      setTotalPages(r.data.pages);
    } catch (err) { silentError('sub-reports fetch')(err); }
  };

  useEffect(() => { loadReports(filters, 1).finally(() => setLoading(false)); }, []);
  useEffect(() => { if (!loading) loadReports(filters, 1); }, [filters]);
  useEffect(() => { if (!onSync) return; return onSync(count => { if (count > 0) loadReports(filters, page); }); }, [onSync]);

  const handleSaved = (report, isEdit) => {
    if (isEdit) {
      setReports(prev => prev.map(r => r.id === report.id ? report : r));
      setEditing(null);
    } else {
      setReports(prev => [report, ...prev]);
      setShowForm(false);
    }
  };

  // Unique sub company names for filter
  const subNames = useMemo(() => [...new Set(reports.map(r => r.sub_company))].sort(), [reports]);
  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  return (
    <div>
      <div style={styles.topRow}>
        <h1 style={styles.heading}>{t.subReports}</h1>
        {!showForm && !editing && (
          <button style={styles.newBtn} onClick={() => setShowForm(true)}>+ {t.addReport}</button>
        )}
      </div>

      {(showForm || editing) && (
        <div style={styles.formCard}>
          <SubReportForm
            projects={projects}
            initial={editing || (defaultProjectId ? { ...BLANK, project_id: String(defaultProjectId) } : BLANK)}
            workerLabelPluralLower={workerLabelPluralLower}
            onSaved={handleSaved}
            onCancel={() => { setShowForm(false); setEditing(null); }}
          />
        </div>
      )}

      <FieldFilters activeCount={activeFilterCount}>
        {projects.length > 0 && (
          <select style={styles.filterSelect} value={filters.project_id || ''} onChange={e => setFilter('project_id', e.target.value)}>
            <option value="">{`All Projects`}</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
        {subNames.length > 1 && (
          <select style={styles.filterSelect} value={filters.sub_company || ''} onChange={e => setFilter('sub_company', e.target.value)}>
            <option value="">{t.allSubsOpt}</option>
            {subNames.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        )}
        <input style={styles.filterInput} type="date" value={filters.from || ''} onChange={e => setFilter('from', e.target.value)} title={t.fromDate} />
        <input style={styles.filterInput} type="date" value={filters.to || ''} onChange={e => setFilter('to', e.target.value)} title={t.toDate} />
      </FieldFilters>

      {loading ? (
        <SkeletonList count={4} rows={2} />
      ) : reports.length === 0 ? (
        <div style={styles.empty}>
          <p style={styles.emptyTitle}>No sub reports</p>
          <p style={styles.emptyText}>{t.noSubReports}</p>
          {!showForm && !editing && <button type="button" style={styles.emptyCtaBtn} onClick={() => setShowForm(true)}>+ {t.addReport}</button>}
        </div>
      ) : (
        <>
          <div style={styles.list}>
            {reports.map(r => (
              <SubCard
                key={r.id}
                report={r}
                onEdit={r => { setEditing({ ...r, project_id: r.project_id || '', headcount: r.headcount ?? '' }); setShowForm(false); }}
                onDeleted={id => setReports(prev => prev.filter(r => r.id !== id))}
              />
            ))}
          </div>
          <Pagination page={page} pages={totalPages} onChange={p => loadReports(filters, p)} />
        </>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  topRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' },
  heading: { fontSize: 22, fontWeight: 800, color: '#111827', margin: 0 },
  newBtn: { background: '#059669', color: '#fff', border: 'none', padding: '10px 18px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  formCard: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 20 },
  filterBar: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 },
  filterSelect: { padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, background: '#fff', color: '#374151', flex: 1, minWidth: 130 },
  filterInput: { padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, background: '#fff', color: '#374151' },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  hint: { color: '#6b7280', fontSize: 14 },
  empty: { textAlign: 'center', padding: '60px 20px' },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyTitle: { margin: '0 0 6px', fontSize: 18, fontWeight: 800, color: '#111827' },
  emptyText: { color: '#6b7280', fontSize: 15 },
  emptyCtaBtn: { marginTop: 14, background: '#059669', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 800, cursor: 'pointer' },
  // Card
  card: { background: '#fff', borderRadius: 12, boxShadow: '0 1px 6px rgba(0,0,0,0.07)', overflow: 'hidden' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '14px 16px', cursor: 'pointer', gap: 12 },
  cardLeft: { flex: 1, minWidth: 0 },
  subName: { fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 4 },
  cardMeta: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#6b7280', flexWrap: 'wrap' },
  projectTag: { background: '#ede9fe', color: '#6d28d9', padding: '1px 7px', borderRadius: 10, fontWeight: 600 },
  headcountTag: { color: '#92400e', fontWeight: 700 },
  foremanTag: { color: '#059669', fontWeight: 700 },
  chevron: { fontSize: 10, color: '#6b7280', flexShrink: 0 },
  cardBody: { padding: '0 16px 14px', borderTop: '1px solid #f3f4f6' },
  section: { marginTop: 12 },
  sectionLabel: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6b7280', marginBottom: 4 },
  sectionText: { fontSize: 14, color: '#374151', lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap' },
  cardActions: { display: 'flex', gap: 8, marginTop: 14 },
  editBtn: { background: '#f3f4f6', border: 'none', color: '#374151', padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  deleteBtn: { background: 'none', border: '1px solid #fca5a5', color: '#ef4444', padding: '6px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  confirmDeleteBtn: { background: '#ef4444', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  cancelDeleteBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '6px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  // Form
  form: { display: 'flex', flexDirection: 'column', gap: 16 },
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
