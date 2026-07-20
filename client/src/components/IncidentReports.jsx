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
function today() {
  return new Date().toLocaleDateString('en-CA');
}

function fmtIncidentDate(value, locale = 'en-US') {
  if (!value) return '';
  const raw = value.toString().substring(0, 10);
  const parsed = new Date(`${raw}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Incident Form ─────────────────────────────────────────────────────────────

function IncidentForm({ projects, onSubmitted, onCancel }) {
  const t = useT();
  const TYPE_LABELS = useMemo(() => ({
    'injury': `🤕 ${t.typeInjury}`,
    'near-miss': `⚠️ ${t.typeNearMiss}`,
    'property-damage': `🔧 ${t.typePropertyDamage}`,
    'environmental': `🌿 ${t.typeEnvironmental}`,
    'other': `📝 ${t.typeOther}`,
  }), [t]);
  const TREATMENT_LABELS = useMemo(() => ({
    'none': t.treatmentNone,
    'first-aid': t.treatmentFirstAid,
    'medical-attention': t.treatmentMedicalFull,
    'hospitalization': t.treatmentHospitalization,
  }), [t]);
  const [form, setForm] = useState({
    incident_date: today(),
    incident_time: '',
    type: 'near-miss',
    project_id: '',
    injured_name: '',
    body_part: '',
    treatment: 'none',
    work_stopped: false,
    description: '',
    witnesses: '',
    corrective_action: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setError(''); };
  const isInjury = form.type === 'injury';

  const handleSubmit = async e => {
    e.preventDefault();
    if (!form.description.trim()) { setError(t.descriptionRequired); return; }
    setSaving(true); setError('');
    try {
      const payload = { ...form };
      if (!isInjury) { delete payload.injured_name; delete payload.body_part; delete payload.treatment; }
      if (!payload.project_id) delete payload.project_id;
      if (!payload.incident_time) delete payload.incident_time;
      const r = await api.post('/incidents', payload);
      if (r.data?.offline) {
        onSubmitted({ id: 'pending-' + Date.now(), pending: true, ...form, incident_date: form.incident_date, status: 'open' });
      } else {
        onSubmitted(r.data);
      }
    } catch (err) {
      setError(err.response?.data?.error || t.failedToSave);
    } finally { setSaving(false); }
  };

  return (
    <form onSubmit={handleSubmit} style={styles.form}>
      <h3 style={styles.formTitle}>{t.newIncidentReport}</h3>

      <div style={styles.row}>
        <div style={styles.fieldGroup}>
          <label htmlFor="ir-date" style={styles.label}>{t.date} *</label>
          <input id="ir-date" style={styles.input} type="date" value={form.incident_date} onChange={e => set('incident_date', e.target.value)} required max={new Date().toLocaleDateString('en-CA')} />
        </div>
        <div style={styles.fieldGroup}>
          <label htmlFor="ir-time" style={styles.label}>{t.timeLabel} <span style={styles.optional}>{t.quizOptional}</span></label>
          <input id="ir-time" style={styles.input} type="time" value={form.incident_time} onChange={e => set('incident_time', e.target.value)} />
        </div>
      </div>

      <div style={styles.row}>
        <div style={styles.fieldGroup}>
          <label htmlFor="ir-type" style={styles.label}>{t.incidentType}</label>
          <select id="ir-type" style={styles.input} value={form.type} onChange={e => set('type', e.target.value)}>
            {Object.entries(TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {projects.length > 0 && (
          <div style={styles.fieldGroup}>
            <label htmlFor="ir-project" style={styles.label}>Project <span style={styles.optional}>{t.quizOptional}</span></label>
            <select id="ir-project" style={styles.input} value={form.project_id} onChange={e => set('project_id', e.target.value)}>
              <option value="">{`No project`}</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
      </div>

      {isInjury && (
        <>
          <div style={styles.row}>
            <div style={styles.fieldGroup}>
              <label htmlFor="ir-injured-name" style={styles.label}>{t.injuredName}</label>
              <input id="ir-injured-name" style={styles.input} type="text" placeholder={t.fullNamePlaceholder} maxLength={255} value={form.injured_name} onChange={e => set('injured_name', e.target.value)} />
            </div>
            <div style={styles.fieldGroup}>
              <label htmlFor="ir-body-part" style={styles.label}>{t.bodyPartAffected}</label>
              <input id="ir-body-part" style={styles.input} type="text" maxLength={255} placeholder={t.bodyPartPlaceholder} value={form.body_part} onChange={e => set('body_part', e.target.value)} />
            </div>
          </div>
          <div style={styles.fieldGroup}>
            <label htmlFor="ir-treatment" style={styles.label}>{t.treatmentField}</label>
            <select id="ir-treatment" style={styles.input} value={form.treatment} onChange={e => set('treatment', e.target.value)}>
              {Object.entries(TREATMENT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </>
      )}

      <div style={styles.fieldGroup}>
        <div style={styles.labelRow}>
          <label htmlFor="ir-description" style={styles.label}>{t.descriptionField} *</label>
          <span style={styles.charCount}>{form.description.length}/2000</span>
        </div>
        <textarea id="ir-description" style={styles.textarea} rows={4} placeholder={t.describeWhatHappened} maxLength={2000} value={form.description} onChange={e => set('description', e.target.value)} required />
      </div>

      <div style={styles.fieldGroup}>
        <div style={styles.labelRow}>
          <label htmlFor="ir-witnesses" style={styles.label}>{t.witnessesLabel} <span style={styles.optional}>{t.quizOptional}</span></label>
          <span style={styles.charCount}>{form.witnesses.length}/500</span>
        </div>
        <input id="ir-witnesses" style={styles.input} type="text" placeholder={t.witnessesPlaceholder} maxLength={500} value={form.witnesses} onChange={e => set('witnesses', e.target.value)} />
      </div>

      <div style={styles.fieldGroup}>
        <div style={styles.labelRow}>
          <label htmlFor="ir-corrective-action" style={styles.label}>{t.correctiveActionLabel} <span style={styles.optional}>{t.quizOptional}</span></label>
          <span style={styles.charCount}>{form.corrective_action.length}/2000</span>
        </div>
        <textarea id="ir-corrective-action" style={styles.textarea} rows={3} placeholder={t.correctiveActionPlaceholder} maxLength={2000} value={form.corrective_action} onChange={e => set('corrective_action', e.target.value)} />
      </div>

      <label style={styles.checkRow}>
        <input type="checkbox" checked={form.work_stopped} onChange={e => set('work_stopped', e.target.checked)} />
        <span style={styles.checkLabel}>{t.workStoppedLabel}</span>
      </label>

      {error && <p role="alert" style={styles.error}>{error}</p>}

      <div style={styles.formActions}>
        <button style={{ ...styles.submitBtn, ...(saving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={saving}>
          {saving ? t.submitting : t.submitReport}
        </button>
        <button style={styles.cancelBtn} type="button" onClick={onCancel}>{t.cancel}</button>
      </div>
    </form>
  );
}

// ── Incident Card ─────────────────────────────────────────────────────────────

function IncidentCard({ incident, isAdmin, onClosed, onDeleted }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const TYPE_LABELS = useMemo(() => ({
    'injury': `🤕 ${t.typeInjury}`,
    'near-miss': `⚠️ ${t.typeNearMiss}`,
    'property-damage': `🔧 ${t.typePropertyDamage}`,
    'environmental': `🌿 ${t.typeEnvironmental}`,
    'other': `📝 ${t.typeOther}`,
  }), [t]);
  const TREATMENT_LABELS = useMemo(() => ({
    'none': t.treatmentNone,
    'first-aid': t.treatmentFirstAid,
    'medical-attention': t.treatmentMedicalFull,
    'hospitalization': t.treatmentHospitalization,
  }), [t]);
  const [expanded, setExpanded] = useState(false);
  const [closing, setClosing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const handleClose = async () => {
    setClosing(true);
    try {
      await api.patch(`/incidents/${incident.id}/close`);
      onClosed(incident.id);
    } finally { setClosing(false); }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.delete(`/incidents/${incident.id}`);
      onDeleted(incident.id);
    } finally { setDeleting(false); }
  };

  const typeLabel = TYPE_LABELS[incident.type] || incident.type;
  const isInjury = incident.type === 'injury';

  return (
    <div style={styles.card}>
      <div style={styles.cardHeader} onClick={() => setExpanded(e => !e)} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setExpanded(prev => !prev)}>
        <div style={styles.cardLeft}>
          {isAdmin && <div style={styles.workerName}>{incident.reporter_name}</div>}
          <div style={styles.cardTitle}>{typeLabel}{incident.pending && <span style={styles.pendingBadge}>⏳ {t.pendingSync}</span>}</div>
          <div style={styles.cardMeta}>
            <span>{fmtIncidentDate(incident.incident_date, locale)}{incident.incident_time ? ` at ${incident.incident_time.substring(0, 5)}` : ''}</span>
            {incident.project_name && <span style={styles.projectTag}>{incident.project_name}</span>}
            {incident.work_stopped && <span style={styles.stoppedTag}>{t.workStoppedTag}</span>}
          </div>
        </div>
        <div style={styles.cardRight}>
          <span style={incident.status === 'closed' ? styles.badgeClosed : styles.badgeOpen}>
            {incident.status === 'closed' ? t.incidentClosed : t.incidentOpen}
          </span>
          <span style={styles.chevron}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div style={styles.cardBody}>
          {isInjury && (incident.injured_name || incident.body_part || incident.treatment) && (
            <div style={styles.injuryBox}>
              {incident.injured_name && <div><strong>{t.injuredLabel}:</strong> {incident.injured_name}</div>}
              {incident.body_part && <div><strong>{t.bodyPartLabel}:</strong> {incident.body_part}</div>}
              {incident.treatment && <div><strong>{t.treatmentDetailLabel}:</strong> {TREATMENT_LABELS[incident.treatment] || incident.treatment}</div>}
            </div>
          )}

          <div style={styles.section}>
            <div style={styles.sectionLabel}>{t.descriptionSection}</div>
            <p style={styles.sectionText}>{incident.description}</p>
          </div>

          {incident.witnesses && (
            <div style={styles.section}>
              <div style={styles.sectionLabel}>{t.witnessesSection}</div>
              <p style={styles.sectionText}>{incident.witnesses}</p>
            </div>
          )}

          {incident.corrective_action && (
            <div style={styles.section}>
              <div style={styles.sectionLabel}>{t.correctiveActionSection}</div>
              <p style={styles.sectionText}>{incident.corrective_action}</p>
            </div>
          )}

          <div style={styles.cardActions}>
            {isAdmin && incident.status !== 'closed' && (
              <button style={{ ...styles.closeBtn, ...(closing ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={handleClose} disabled={closing}>
                {closing ? t.saving : t.closeIncident}
              </button>
            )}
            {(!isAdmin || incident.status !== 'closed') && (
              confirmingDelete ? (
                <>
                  <button style={{ ...styles.confirmDeleteBtn, ...(deleting ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={handleDelete} disabled={deleting}>{deleting ? '…' : t.confirm}</button>
                  <button style={styles.cancelDeleteBtn} onClick={() => setConfirmingDelete(false)}>{t.cancel}</button>
                </>
              ) : (
                <button style={styles.deleteBtn} onClick={() => setConfirmingDelete(true)}>{t.delete}</button>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function IncidentReports({ projects }) {
  const { user } = useAuth();
  const t = useT();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const { onSync } = useOffline() || {};
  const TYPE_LABELS = useMemo(() => ({
    'injury': `🤕 ${t.typeInjury}`,
    'near-miss': `⚠️ ${t.typeNearMiss}`,
    'property-damage': `🔧 ${t.typePropertyDamage}`,
    'environmental': `🌿 ${t.typeEnvironmental}`,
    'other': `📝 ${t.typeOther}`,
  }), [t]);

  const [incidents, setIncidents] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [filters, setFilters] = useState({});
  const [pdfGenerating, setPdfGenerating] = useState(false);

  const downloadPDF = async () => {
    setPdfGenerating(true);
    try {
      const [{ pdf }, { IncidentReportDocument }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('./IncidentReportPDF'),
      ]);
      const blob = await pdf(React.createElement(IncidentReportDocument, { incidents, companyName: user?.company_name, language: user?.language })).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'incident-reports.pdf'; a.click();
      URL.revokeObjectURL(url);
    } finally { setPdfGenerating(false); }
  };

  const loadIncidents = async (f = filters, p = 1) => {
    setPage(p);
    try {
      const params = { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), page: p, limit: 50 };
      const r = await api.get('/incidents', { params });
      setIncidents(r.data.items);
      setTotalPages(r.data.pages);
    } catch (err) { silentError('incident-reports fetch')(err); }
  };

  useEffect(() => { loadIncidents(filters, 1).finally(() => setLoading(false)); }, []);
  useEffect(() => { if (!loading) loadIncidents(filters, 1); }, [filters]);
  useEffect(() => { if (!onSync) return; return onSync(count => { if (count > 0) loadIncidents(filters, page); }); }, [onSync]);

  const setFilter = (k, v) => setFilters(f => ({ ...f, [k]: v }));

  const openCount = incidents.filter(i => i.status === 'open').length;
  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  return (
    <div>
      <div style={styles.topRow}>
        <div>
          <h1 style={styles.heading}>{t.incidentReports}</h1>
          {openCount > 0 && (
            <p style={styles.openNote}>{openCount} {openCount !== 1 ? t.openIncidentsPlural : t.openIncidents}</p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {incidents.length > 0 && <button style={{ ...styles.pdfBtn, ...(pdfGenerating ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={downloadPDF} disabled={pdfGenerating}>{pdfGenerating ? t.preparing : t.exportPDF}</button>}
          {!showForm && <button style={styles.newBtn} onClick={() => setShowForm(true)}>{t.newIncident}</button>}
        </div>
      </div>

      {showForm && (
        <div style={styles.formCard}>
          <IncidentForm
            projects={projects}
            onSubmitted={r => { setIncidents(prev => [r, ...prev]); setShowForm(false); }}
            onCancel={() => setShowForm(false)}
          />
        </div>
      )}

      {isAdmin && (
        <FieldFilters activeCount={activeFilterCount}>
          <select style={styles.filterSelect} value={filters.type || ''} onChange={e => setFilter('type', e.target.value)}>
            <option value="">{t.allTypes}</option>
            {Object.entries(TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select style={styles.filterSelect} value={filters.status || ''} onChange={e => setFilter('status', e.target.value)}>
            <option value="">{t.allStatuses}</option>
            <option value="open">{t.incidentOpen}</option>
            <option value="closed">{t.incidentClosed}</option>
          </select>
          <input style={styles.filterInput} type="date" value={filters.from || ''} onChange={e => setFilter('from', e.target.value)} title={t.fromDate} />
          <input style={styles.filterInput} type="date" value={filters.to || ''} onChange={e => setFilter('to', e.target.value)} title={t.toDate} />
        </FieldFilters>
      )}

      {loading ? (
        <SkeletonList count={4} rows={2} />
      ) : incidents.length === 0 ? (
        <div style={styles.empty}>
          <p style={styles.emptyTitle}>No incident reports</p>
          <p style={styles.emptyText}>{isAdmin ? t.noIncidents : t.noIncidentsWorker}</p>
          {!showForm && <button type="button" style={styles.emptyCtaBtn} onClick={() => setShowForm(true)}>{t.newIncident}</button>}
        </div>
      ) : (
        <>
          <div style={styles.list}>
            {incidents.map(i => (
              <IncidentCard
                key={i.id}
                incident={i}
                isAdmin={isAdmin}
                onClosed={id => setIncidents(prev => prev.map(r => r.id === id ? { ...r, status: 'closed' } : r))}
                onDeleted={id => setIncidents(prev => prev.filter(r => r.id !== id))}
              />
            ))}
          </div>
          <Pagination page={page} pages={totalPages} onChange={p => loadIncidents(filters, p)} />
        </>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  topRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' },
  heading: { fontSize: 22, fontWeight: 800, color: '#111827', margin: 0 },
  openNote: { fontSize: 13, color: '#d97706', fontWeight: 600, margin: '4px 0 0' },
  newBtn: { background: '#059669', color: '#fff', border: 'none', padding: '10px 18px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer', flexShrink: 0 },
  pdfBtn: { fontSize: 13, fontWeight: 600, color: 'var(--ops-page-accent)', background: '#eff6ff', border: '1px solid #bfdbfe', padding: '9px 16px', borderRadius: 8, textDecoration: 'none', cursor: 'pointer', flexShrink: 0 },
  formCard: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 20 },
  filterBar: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 },
  filterSelect: { padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, background: '#fff', color: '#374151', flex: 1, minWidth: 120 },
  filterInput: { padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, background: '#fff', color: '#374151' },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  empty: { textAlign: 'center', padding: '60px 20px' },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyTitle: { margin: '0 0 6px', fontSize: 18, fontWeight: 800, color: '#111827' },
  emptyText: { color: '#6b7280', fontSize: 15 },
  emptyCtaBtn: { marginTop: 14, background: '#059669', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 18px', fontSize: 13, fontWeight: 800, cursor: 'pointer' },
  hint: { color: '#6b7280', fontSize: 14 },
  // Card
  card: { background: '#fff', borderRadius: 12, boxShadow: '0 1px 6px rgba(0,0,0,0.07)', overflow: 'hidden' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '14px 16px', cursor: 'pointer', gap: 12 },
  cardLeft: { flex: 1, minWidth: 0 },
  cardRight: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  workerName: { fontSize: 12, fontWeight: 700, color: '#059669', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 2 },
  cardTitle: { fontWeight: 700, fontSize: 15, color: '#111827', marginBottom: 4 },
  cardMeta: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#6b7280', flexWrap: 'wrap' },
  projectTag: { background: '#ede9fe', color: '#6d28d9', padding: '1px 7px', borderRadius: 10, fontWeight: 600 },
  stoppedTag: { background: '#fee2e2', color: '#dc2626', padding: '1px 7px', borderRadius: 10, fontWeight: 700 },
  chevron: { fontSize: 10, color: '#6b7280' },
  badgeOpen: { fontSize: 11, fontWeight: 700, color: '#92400e', background: '#fef3c7', padding: '2px 8px', borderRadius: 10 },
  badgeClosed: { fontSize: 11, fontWeight: 700, color: '#065f46', background: '#d1fae5', padding: '2px 8px', borderRadius: 10 },
  cardBody: { padding: '0 16px 14px', borderTop: '1px solid #f3f4f6' },
  injuryBox: { background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', margin: '12px 0', fontSize: 13, lineHeight: 1.8, color: '#374151' },
  section: { marginTop: 12 },
  sectionLabel: { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6b7280', marginBottom: 4 },
  sectionText: { fontSize: 14, color: '#374151', lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap' },
  cardActions: { display: 'flex', gap: 8, marginTop: 14 },
  closeBtn: { background: '#059669', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' },
  deleteBtn: { background: 'none', border: '1px solid #fca5a5', color: '#ef4444', padding: '6px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  confirmDeleteBtn: { background: '#ef4444', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  cancelDeleteBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '6px 14px', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  pendingBadge: { fontSize: 10, fontWeight: 600, color: '#92400e', background: '#fef3c7', padding: '1px 6px', borderRadius: 6, marginLeft: 6, verticalAlign: 'middle' },
  // Form
  form: { display: 'flex', flexDirection: 'column', gap: 16 },
  formTitle: { fontSize: 17, fontWeight: 700, margin: 0 },
  row: { display: 'flex', gap: 12, flexWrap: 'wrap' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 5, flex: 1, minWidth: 180 },
  labelRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 },
  label: { fontSize: 13, fontWeight: 600, color: '#374151' },
  charCount: { fontSize: 11, color: '#6b7280' },
  optional: { fontWeight: 400, color: '#6b7280' },
  input: { padding: '9px 11px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, background: '#fff' },
  textarea: { padding: '9px 11px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 },
  checkRow: { display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' },
  checkLabel: { fontSize: 14, color: '#374151' },
  error: { color: '#ef4444', fontSize: 13, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', margin: 0 },
  formActions: { display: 'flex', gap: 10 },
  submitBtn: { background: '#059669', color: '#fff', border: 'none', padding: '11px 22px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  cancelBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '11px 22px', borderRadius: 8, fontSize: 14, cursor: 'pointer' },
};
