import React, { useState, useEffect, useMemo } from 'react';
import api from '../api';
import { useAuth } from '../contexts/AuthContext';
import { useOffline } from '../contexts/OfflineContext';
import { useT } from '../hooks/useT';
import { langToLocale } from '../utils';
import { labelSg, labelPl } from '../companyLabels';
import { SkeletonList } from './Skeleton';
import Pagination from './Pagination';

const WEATHER_KEYS = [
  { value: 'sunny', key: 'weatherSunny', emoji: '☀️' },
  { value: 'partly_cloudy', key: 'weatherPartlyCloudy', emoji: '🌤️' },
  { value: 'cloudy', key: 'weatherCloudy', emoji: '☁️' },
  { value: 'rainy', key: 'weatherRainy', emoji: '🌧️' },
  { value: 'stormy', key: 'weatherStormy', emoji: '⛈️' },
  { value: 'snow', key: 'weatherSnow', emoji: '🌨️' },
  { value: 'windy', key: 'weatherWindy', emoji: '🌬️' },
];

function fmtDate(str, locale = 'en-US') {
  if (!str) return '';
  const dateText = String(str);
  const date = dateText.includes('T') ? new Date(dateText) : new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateText;
  return date.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function emptyRow(type) {
  if (type === 'manpower') return { trade: '', worker_count: 1, hours: '', notes: '' };
  if (type === 'equipment') return { name: '', quantity: 1, hours: '' };
  return { description: '', quantity: '' };
}

// ── Editable table row ─────────────────────────────────────────────────────────

function RowInput({ value, onChange, type = 'text', placeholder, style, min, maxLength }) {
  return (
    <input
      style={{ ...styles.cellInput, ...style }}
      type={type} value={value} placeholder={placeholder}
      min={min} maxLength={maxLength}
      onChange={e => onChange(e.target.value)}
    />
  );
}

// ── Report Editor ──────────────────────────────────────────────────────────────

function ReportEditor({ report: initial, projects, onSaved, onCancel, companyName, fieldPhotos, settings = null, workerLabelPlural = 'Workers' }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const isNew = !initial?.id;
  const today = new Date().toLocaleDateString('en-CA');
  const WEATHER_OPTIONS = useMemo(() => WEATHER_KEYS.map(w => ({ value: w.value, label: `${w.emoji} ${t[w.key]}` })), [t]);
  const WEATHER_LABELS = useMemo(() => Object.fromEntries(WEATHER_OPTIONS.map(o => [o.value, o.label])), [WEATHER_OPTIONS]);

  const [form, setForm] = useState({
    project_id: initial?.project_id || '',
    report_date: initial?.report_date?.substring(0, 10) || today,
    superintendent: initial?.superintendent || '',
    weather_condition: initial?.weather_condition || '',
    weather_temp: initial?.weather_temp ?? '',
    work_performed: initial?.work_performed || '',
    delays_issues: initial?.delays_issues || '',
    visitor_log: initial?.visitor_log || '',
    status: initial?.status || 'draft',
  });
  const [manpower, setManpower] = useState(initial?.manpower?.length ? initial.manpower : [emptyRow('manpower')]);
  const [equipment, setEquipment] = useState(initial?.equipment?.length ? initial.equipment : []);
  const [materials, setMaterials] = useState(initial?.materials?.length ? initial.materials : []);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [gettingWeather, setGettingWeather] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pdfGenerating, setPdfGenerating] = useState(false);

  const downloadPDF = async (reportData) => {
    setPdfGenerating(true);
    try {
      const [{ pdf }, { DailyReportDocument }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('./DailyReportPDF'),
      ]);
      const blob = await pdf(React.createElement(DailyReportDocument, { report: reportData, companyName, fieldPhotos: fieldPhotos || [], t, language: user?.language, settings })).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `daily-report-${reportData.report_date || 'report'}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } finally { setPdfGenerating(false); }
  };

  useEffect(() => {
    if (!dirty) return;
    const handler = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const set = (k, v) => { setDirty(true); setForm(f => ({ ...f, [k]: v })); };

  const weatherCodeToCondition = code => {
    if (code === 0) return 'sunny';
    if (code <= 2) return 'partly_cloudy';
    if (code <= 48) return 'cloudy';
    if (code <= 67) return 'rainy';
    if (code <= 77) return 'snow';
    if (code <= 82) return 'rainy';
    if (code <= 86) return 'snow';
    if (code >= 95) return 'stormy';
    return 'cloudy';
  };

  const autoFillWeather = async () => {
    setGettingWeather(true);
    try {
      const pos = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000 })
      );
      const { latitude, longitude } = pos.coords;
      const r = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weathercode&temperature_unit=fahrenheit&forecast_days=1`
      );
      const data = await r.json();
      const code = data.current?.weathercode;
      const temp = Math.round(data.current?.temperature_2m);
      set('weather_temp', temp);
      set('weather_condition', weatherCodeToCondition(code));
    } catch {
      // geolocation denied or offline — silently ignore
    } finally { setGettingWeather(false); }
  };

  const autoFillManpower = async () => {
    if (!form.report_date) return;
    setSuggesting(true);
    try {
      const r = await api.get('/daily-reports/suggest', {
        params: { project_id: form.project_id || undefined, report_date: form.report_date }
      });
      if (r.data.length > 0) {
        setManpower(r.data.map(w => ({
          trade: w.full_name,
          worker_count: 1,
          hours: parseFloat(w.total_hours).toFixed(1),
          notes: w.project_name || '',
        })));
      }
    } finally { setSuggesting(false); }
  };

  const updateRow = (list, setList, i, key, value) => {
    setDirty(true);
    const next = list.map((r, idx) => idx === i ? { ...r, [key]: value } : r);
    setList(next);
  };
  const addRow = (list, setList, type) => { setDirty(true); setList([...list, emptyRow(type)]); };
  const removeRow = (list, setList, i) => { setDirty(true); setList(list.filter((_, idx) => idx !== i)); };

  const save = async (status) => {
    const isSub = status === 'submitted';
    isSub ? setSubmitting(true) : setSaving(true);
    setError('');
    try {
      const payload = { ...form, status, manpower, equipment, materials };
      payload.weather_temp = form.weather_temp !== '' ? parseInt(form.weather_temp) : null;
      let r;
      if (isNew) {
        r = await api.post('/daily-reports', payload);
        if (r.data?.offline) {
          onSaved({ id: 'pending-' + Date.now(), pending: true, ...form, report_date: form.report_date, manpower, equipment, materials });
          return;
        }
      } else {
        r = await api.patch(`/daily-reports/${initial.id}`, { ...payload, updated_at: initial.updated_at });
      }
      setDirty(false);
      onSaved(r.data);
    } catch (err) {
      const msg = err.response?.status === 409
        ? t.concurrentModification
        : err.response?.data?.error || t.failedToSave;
      setError(msg);
    } finally { setSaving(false); setSubmitting(false); }
  };

  return (
    <div style={styles.editor}>
      <div style={styles.editorHeader}>
        <h3 style={styles.editorTitle}>{isNew ? t.newDailyReport : t.editDailyReport}</h3>
        {!isNew && initial.status === 'submitted' && (
          <button style={{ ...styles.pdfBtn, ...(pdfGenerating ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => downloadPDF({ ...initial, ...form, manpower, equipment, materials })} disabled={pdfGenerating}>
            {pdfGenerating ? t.preparing : t.exportPDF}
          </button>
        )}
      </div>

      {/* Header fields */}
      <div style={styles.fieldGrid}>
        <div style={styles.fieldGroup}>
          <label style={styles.label}>{t.date}</label>
          <input style={styles.input} type="date" value={form.report_date} onChange={e => set('report_date', e.target.value)} max={new Date().toLocaleDateString('en-CA')} />
        </div>
        <div style={styles.fieldGroup}>
          <label style={styles.label}>Project</label>
          <select style={styles.input} value={form.project_id} onChange={e => set('project_id', e.target.value)}>
            <option value="">{`No project`}</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div style={styles.fieldGroup}>
          <label style={styles.label}>{t.superintendent}</label>
          <input style={styles.input} type="text" placeholder={t.superintendent} value={form.superintendent} onChange={e => set('superintendent', e.target.value)} maxLength={255} />
        </div>
        <div style={styles.fieldGroup}>
          <label style={styles.label}>
            {t.weather}
            <button type="button" style={{ ...styles.weatherBtn, ...(gettingWeather ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={autoFillWeather} disabled={gettingWeather} title={t.autoFillLocation}>
              {gettingWeather ? t.loading : '🌤 Auto'}
            </button>
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <select style={{ ...styles.input, flex: 1 }} value={form.weather_condition} onChange={e => set('weather_condition', e.target.value)}>
              <option value="">{t.select}</option>
              {WEATHER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input style={{ ...styles.input, width: 70 }} type="number" placeholder="°F" min="-50" max="130" value={form.weather_temp} onChange={e => set('weather_temp', e.target.value)} />
          </div>
        </div>
      </div>

      {/* Manpower */}
      <div style={styles.section}>
        <div style={styles.sectionHead}>
          <span style={styles.sectionTitle}>{t.manpowerSection}</span>
          <button style={{ ...styles.autofillBtn, ...(suggesting ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={autoFillManpower} disabled={suggesting}>
            {suggesting ? t.loading : `⚡ ${t.autoFillEntries}`}
          </button>
        </div>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>{t.tradeOrName}</th>
              <th style={{ ...styles.th, width: 70 }}>{workerLabelPlural}</th>
              <th style={{ ...styles.th, width: 70 }}>{t.hours}</th>
              <th style={{ ...styles.th, flex: 2 }}>{t.notes}</th>
              <th style={{ ...styles.th, width: 30 }}></th>
            </tr>
          </thead>
          <tbody>
            {manpower.map((m, i) => (
              <tr key={i}>
                <td style={styles.td}><RowInput value={m.trade} onChange={v => updateRow(manpower, setManpower, i, 'trade', v)} placeholder={t.crewTypePlaceholder} maxLength={255} /></td>
                <td style={styles.td}><RowInput value={m.worker_count} onChange={v => updateRow(manpower, setManpower, i, 'worker_count', v)} type="number" min="1" style={{ width: 55 }} /></td>
                <td style={styles.td}><RowInput value={m.hours} onChange={v => updateRow(manpower, setManpower, i, 'hours', v)} type="number" min="0" placeholder="0" style={{ width: 55 }} /></td>
                <td style={styles.td}><RowInput value={m.notes} onChange={v => updateRow(manpower, setManpower, i, 'notes', v)} placeholder={t.optional} maxLength={500} /></td>
                <td style={styles.td}><button style={styles.removeRowBtn} aria-label={t.removeRow} onClick={() => removeRow(manpower, setManpower, i)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button style={styles.addRowBtn} onClick={() => addRow(manpower, setManpower, 'manpower')}>{t.addRow}</button>
      </div>

      {/* Work Performed */}
      <div style={styles.section}>
        <div style={styles.sectionHead}>
          <span style={styles.sectionTitle}>{t.workPerformed}</span>
          <span style={styles.charCount}>{(form.work_performed || '').length}/2000</span>
        </div>
        <textarea style={styles.textarea} rows={4} placeholder={t.workPerformedPlaceholder} maxLength={2000} value={form.work_performed} onChange={e => set('work_performed', e.target.value)} />
      </div>

      {/* Equipment */}
      <div style={styles.section}>
        <div style={styles.sectionHead}>
          <span style={styles.sectionTitle}>{t.equipmentOnSite}</span>
          <button style={styles.addRowBtn} onClick={() => addRow(equipment, setEquipment, 'equipment')}>+ {t.add}</button>
        </div>
        {equipment.length > 0 && (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>{t.equipmentField}</th>
                <th style={{ ...styles.th, width: 70 }}>{t.qty}</th>
                <th style={{ ...styles.th, width: 70 }}>{t.hours}</th>
                <th style={{ ...styles.th, width: 30 }}></th>
              </tr>
            </thead>
            <tbody>
              {equipment.map((e, i) => (
                <tr key={i}>
                  <td style={styles.td}><RowInput value={e.name} onChange={v => updateRow(equipment, setEquipment, i, 'name', v)} placeholder={t.equipmentNamePlaceholder} maxLength={255} /></td>
                  <td style={styles.td}><RowInput value={e.quantity} onChange={v => updateRow(equipment, setEquipment, i, 'quantity', v)} type="number" min="1" style={{ width: 55 }} /></td>
                  <td style={styles.td}><RowInput value={e.hours} onChange={v => updateRow(equipment, setEquipment, i, 'hours', v)} type="number" min="0" placeholder="0" style={{ width: 55 }} /></td>
                  <td style={styles.td}><button style={styles.removeRowBtn} aria-label={t.removeRow} onClick={() => removeRow(equipment, setEquipment, i)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Materials */}
      <div style={styles.section}>
        <div style={styles.sectionHead}>
          <span style={styles.sectionTitle}>{t.materialsDelivered}</span>
          <button style={styles.addRowBtn} onClick={() => addRow(materials, setMaterials, 'materials')}>+ {t.add}</button>
        </div>
        {materials.length > 0 && (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>{t.descriptionField}</th>
                <th style={{ ...styles.th, width: 110 }}>{t.quantity}</th>
                <th style={{ ...styles.th, width: 30 }}></th>
              </tr>
            </thead>
            <tbody>
              {materials.map((m, i) => (
                <tr key={i}>
                  <td style={styles.td}><RowInput value={m.description} onChange={v => updateRow(materials, setMaterials, i, 'description', v)} placeholder={t.materialDescPlaceholder} maxLength={500} /></td>
                  <td style={styles.td}><RowInput value={m.quantity} onChange={v => updateRow(materials, setMaterials, i, 'quantity', v)} placeholder={t.materialQtyPlaceholder} /></td>
                  <td style={styles.td}><button style={styles.removeRowBtn} aria-label={t.removeRow} onClick={() => removeRow(materials, setMaterials, i)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Delays */}
      <div style={styles.section}>
        <div style={styles.sectionHead}>
          <span style={styles.sectionTitle}>{t.delaysIssues}</span>
          <span style={styles.charCount}>{(form.delays_issues || '').length}/2000</span>
        </div>
        <textarea style={styles.textarea} rows={3} placeholder={t.delaysIssuesPlaceholder} maxLength={2000} value={form.delays_issues} onChange={e => set('delays_issues', e.target.value)} />
      </div>

      {/* Visitor log */}
      <div style={styles.section}>
        <div style={styles.sectionHead}>
          <span style={styles.sectionTitle}>{t.visitorLog}</span>
          <span style={styles.charCount}>{(form.visitor_log || '').length}/2000</span>
        </div>
        <textarea style={styles.textarea} rows={2} placeholder={t.visitorLogPlaceholder} maxLength={2000} value={form.visitor_log} onChange={e => set('visitor_log', e.target.value)} />
      </div>

      {fieldPhotos.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionHead}><span style={styles.sectionTitle}>📷 {fieldPhotos.length} {t.photosFromFieldReports}</span></div>
          <div style={styles.photoStrip}>
            {fieldPhotos.map((p, i) => (
              <img key={i} src={p.url} style={styles.photoThumb} alt={p.caption || `photo ${i + 1}`} title={p.caption} loading="lazy" />
            ))}
          </div>
          <p style={styles.photoNote}>{t.photosPulledNote}</p>
        </div>
      )}

      {error && <p role="alert" style={styles.error}>{error}</p>}

      <div style={styles.editorActions}>
        <button style={{ ...styles.saveDraftBtn, ...((saving || submitting) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => save('draft')} disabled={saving || submitting}>
          {saving ? t.saving : t.saveDraft}
        </button>
        <button style={{ ...styles.submitBtn, ...((saving || submitting) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => save('submitted')} disabled={saving || submitting}>
          {submitting ? t.submitting : t.submitReport}
        </button>
        <button style={styles.cancelBtn} onClick={onCancel}>{t.cancel}</button>
      </div>
    </div>
  );
}

// ── Report list row ────────────────────────────────────────────────────────────

function ReportRow({ report: initialReport, onEdit, onDelete, isAdmin, companyName, fieldPhotos, settings = null }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const [report, setReport] = useState(initialReport);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState('');
  const [pdfGenerating, setPdfGenerating] = useState(false);

  const downloadPDF = async () => {
    setPdfGenerating(true);
    try {
      const [{ pdf }, { DailyReportDocument }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('./DailyReportPDF'),
      ]);
      const blob = await pdf(React.createElement(DailyReportDocument, { report, companyName, fieldPhotos: fieldPhotos || [], t, language: user?.language, settings })).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `daily-report-${report.report_date || 'report'}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } finally { setPdfGenerating(false); }
  };
  const WEATHER_OPTIONS = useMemo(() => WEATHER_KEYS.map(w => ({ value: w.value, label: `${w.emoji} ${t[w.key]}` })), [t]);
  const WEATHER_LABELS = useMemo(() => Object.fromEntries(WEATHER_OPTIONS.map(o => [o.value, o.label])), [WEATHER_OPTIONS]);
  const weather = report.weather_condition ? WEATHER_LABELS[report.weather_condition] : null;

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError('');
    try { await api.delete(`/daily-reports/${report.id}`); onDelete(report.id); }
    catch { setDeleteError(t.failedToDelete); setConfirmingDelete(false); }
    finally { setDeleting(false); }
  };

  const handleApprove = async () => {
    setApproving(true);
    setApproveError('');
    try {
      const r = await api.patch(`/daily-reports/${report.id}/review`);
      setReport(r.data);
    } catch { setApproveError(t.failedToApprove); }
    finally { setApproving(false); }
  };

  const isReviewed = report.status === 'reviewed';
  const isSubmitted = report.status === 'submitted';

  return (
    <div style={styles.reportRow}>
      <div style={styles.rowLeft} onClick={() => !report.pending && onEdit(report)} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && !report.pending && onEdit(report)}>
        <div style={styles.rowDate}>{fmtDate(report.report_date, locale)}{report.pending && <span style={styles.pendingBadge}>⏳ {t.pendingSync}</span>}</div>
        <div style={styles.rowProject}>{report.project_name || `No project`}</div>
        {weather && <div style={styles.rowMeta}>{weather}{report.weather_temp != null ? ` · ${report.weather_temp}°F` : ''}</div>}
        {report.manpower_count > 0 && <div style={styles.rowMeta}>{report.manpower_count} {report.manpower_count !== 1 ? t.crewEntries : t.crewEntry}</div>}
        {isReviewed && report.reviewed_by && (
          <div style={styles.reviewedMeta}>
            ✓ {t.reviewedBy} {report.reviewed_by}
            {report.reviewed_at && ` · ${new Date(report.reviewed_at).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}`}
          </div>
        )}
      </div>
      <div style={styles.rowRight}>
        <span style={isReviewed ? styles.badgeReviewed : isSubmitted ? styles.badgeSubmitted : styles.badgeDraft}>
          {isReviewed ? t.statusReviewed : isSubmitted ? t.statusSubmitted : t.statusDraft}
        </span>
        {(isSubmitted || isReviewed) && (
          <button style={{ ...styles.pdfBtnSmall, ...(pdfGenerating ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={downloadPDF} disabled={pdfGenerating}>
            {pdfGenerating ? t.preparing : 'PDF'}
          </button>
        )}
        {isAdmin && isSubmitted && (
          <>
            <button style={{ ...styles.approveBtn, ...(approving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={handleApprove} disabled={approving}>
              {approving ? t.saving : t.approve}
            </button>
            {approveError && <span style={styles.inlineError}>{approveError}</span>}
          </>
        )}
        {!report.pending && <button style={styles.editRowBtn} onClick={() => onEdit(report)}>{t.edit}</button>}
        {!report.pending && (confirmingDelete ? (
          <>
            <button style={{ ...styles.confirmDeleteBtn, ...(deleting ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={handleDelete} disabled={deleting}>{deleting ? t.saving : t.confirm}</button>
            <button style={styles.cancelRowBtn} onClick={() => setConfirmingDelete(false)}>{t.cancel}</button>
            {deleteError && <span style={styles.inlineError}>{deleteError}</span>}
          </>
        ) : (
          <button style={styles.deleteRowBtn} aria-label={t.deleteReport} onClick={() => setConfirmingDelete(true)}>✕</button>
        ))}
      </div>
    </div>
  );
}

// ── Main DailyReports component ────────────────────────────────────────────────

export default function DailyReports({ projects, settings = null }) {
  const { user } = useAuth();
  const t = useT();
  const workerLabel = labelSg(settings?.label_worker, 'worker', user?.language);
  const workerLabelPlural = labelPl(settings?.label_worker, 'worker', user?.language);
  const locale = langToLocale(user?.language);
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const { onSync } = useOffline() || {};
  const [reports, setReports] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null=list, 'new'=new form, report=edit form
  const [filterProject, setFilterProject] = useState('');
  const [fieldPhotos, setFieldPhotos] = useState({});

  const loadReports = async (p = 1) => {
    setPage(p);
    try {
      const params = { page: p, limit: 50 };
      if (filterProject) params.project_id = filterProject;
      const r = await api.get('/daily-reports', { params });
      setReports(r.data.items);
      setTotalPages(r.data.pages);
    } finally { setLoading(false); }
  };

  // Load field photos for a given project+date to include in PDF
  const loadFieldPhotos = async (projectId, date) => {
    const key = `${projectId}-${date}`;
    if (fieldPhotos[key]) return fieldPhotos[key];
    try {
      const params = { from: date, to: date };
      if (projectId) params.project_id = projectId;
      const r = await api.get('/field-reports', { params });
      const photos = r.data.items.flatMap(fr => fr.photos || []);
      setFieldPhotos(prev => ({ ...prev, [key]: photos }));
      return photos;
    } catch { return []; }
  };

  useEffect(() => { loadReports(1); }, [filterProject]);
  useEffect(() => { if (!onSync) return; return onSync(count => { if (count > 0) loadReports(page); }); }, [onSync]);

  const handleSaved = report => {
    setReports(prev => {
      const idx = prev.findIndex(r => r.id === report.id);
      if (idx >= 0) return prev.map(r => r.id === report.id ? report : r);
      return [report, ...prev];
    });
    setEditing(null);
    // Pre-load photos for PDF
    loadFieldPhotos(report.project_id, report.report_date?.substring(0, 10));
  };

  const handleEdit = async report => {
    // Fetch full report if coming from list (may not have manpower/equipment/materials)
    if (!report.manpower) {
      try { const r = await api.get(`/daily-reports/${report.id}`); setEditing(r.data); return; }
      catch { return; }
    }
    setEditing(report);
    loadFieldPhotos(report.project_id, report.report_date?.substring(0, 10));
  };

  const getPhotos = report => {
    const key = `${report.project_id}-${report.report_date?.substring(0, 10)}`;
    return fieldPhotos[key] || [];
  };

  if (editing !== null) {
    return (
      <ReportEditor
        report={editing === 'new' ? null : editing}
        projects={projects}
        onSaved={handleSaved}
        onCancel={() => setEditing(null)}
        companyName={user?.company_name}
        fieldPhotos={editing && editing !== 'new' ? getPhotos(editing) : []}
        settings={settings}
        workerLabelPlural={workerLabelPlural}
      />
    );
  }

  return (
    <div>
      <div className="filter-row" style={styles.listHeader}>
        <select style={styles.filterSelect} value={filterProject} onChange={e => setFilterProject(e.target.value)}>
          <option value="">{`All Projects`}</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button style={styles.newBtn} onClick={() => setEditing('new')}>{t.newReport}</button>
      </div>

      {loading ? <SkeletonList count={3} rows={2} /> :
        reports.length === 0 ? (
          <div style={styles.empty}>
            <p style={styles.emptyText}>{t.noDailyReports}</p>
          </div>
        ) : (
          <>
            <div style={styles.reportList}>
              {reports.map(r => (
                <ReportRow
                  key={r.id}
                  report={r}
                  onEdit={handleEdit}
                  onDelete={id => setReports(prev => prev.filter(r => r.id !== id))}
                  isAdmin={isAdmin}
                  companyName={user?.company_name}
                  fieldPhotos={getPhotos(r)}
                  settings={settings}
                />
              ))}
            </div>
            <Pagination page={page} pages={totalPages} onChange={p => loadReports(p)} />
          </>
        )
      }
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  // List
  listHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 10 },
  filterSelect: { padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, background: '#fff', flex: 1, maxWidth: 220 },
  newBtn: { background: '#059669', color: '#fff', border: 'none', padding: '9px 16px', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer', flexShrink: 0 },
  reportList: { display: 'flex', flexDirection: 'column', gap: 8 },
  reportRow: { background: '#fff', borderRadius: 10, padding: '12px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  rowLeft: { flex: 1, cursor: 'pointer', minWidth: 0 },
  rowDate: { fontWeight: 700, fontSize: 14, color: '#111827', marginBottom: 2 },
  rowProject: { fontSize: 13, color: '#059669', fontWeight: 600, marginBottom: 2 },
  rowMeta: { fontSize: 12, color: '#6b7280' },
  rowRight: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' },
  pendingBadge: { fontSize: 10, fontWeight: 600, color: '#92400e', background: '#fef3c7', padding: '1px 6px', borderRadius: 6, marginLeft: 6, verticalAlign: 'middle' },
  badgeDraft: { fontSize: 11, fontWeight: 700, color: '#92400e', background: '#fef3c7', padding: '2px 8px', borderRadius: 10 },
  badgeSubmitted: { fontSize: 11, fontWeight: 700, color: '#065f46', background: '#d1fae5', padding: '2px 8px', borderRadius: 10 },
  badgeReviewed: { fontSize: 11, fontWeight: 700, color: '#fff', background: 'var(--ops-page-accent)', padding: '2px 8px', borderRadius: 10 },
  reviewedMeta: { fontSize: 11, color: 'var(--ops-page-accent)', fontWeight: 600, marginTop: 2 },
  approveBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '4px 10px', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  editRowBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#374151', padding: '4px 10px', borderRadius: 6, fontSize: 12, cursor: 'pointer' },
  deleteRowBtn: { background: 'none', border: '1px solid #fca5a5', color: '#ef4444', padding: '4px 8px', borderRadius: 6, fontSize: 11, cursor: 'pointer' },
  confirmDeleteBtn: { background: '#ef4444', color: '#fff', border: 'none', padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer' },
  cancelRowBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '4px 8px', borderRadius: 6, fontSize: 11, cursor: 'pointer' },
  inlineError: { fontSize: 11, color: '#ef4444' },
  pdfBtnSmall: { fontSize: 11, fontWeight: 600, color: 'var(--ops-page-accent)', background: '#eff6ff', border: 'none', padding: '4px 10px', borderRadius: 6, textDecoration: 'none', cursor: 'pointer' },
  hint: { color: '#6b7280', fontSize: 14 },
  empty: { textAlign: 'center', padding: '40px 20px' },
  emptyIcon: { fontSize: 36, marginBottom: 10 },
  emptyText: { color: '#6b7280', fontSize: 14 },
  // Editor
  editor: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)' },
  editorHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12 },
  editorTitle: { fontSize: 18, fontWeight: 800, color: '#111827', margin: 0 },
  pdfBtn: { fontSize: 13, fontWeight: 600, color: '#fff', background: 'var(--ops-page-accent)', border: 'none', padding: '8px 16px', borderRadius: 7, textDecoration: 'none', cursor: 'pointer' },
  fieldGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, marginBottom: 20 },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: 6 },
  weatherBtn: { fontSize: 11, fontWeight: 600, color: 'var(--ops-page-accent)', background: '#eff6ff', border: 'none', padding: '2px 7px', borderRadius: 5, cursor: 'pointer', textTransform: 'none', letterSpacing: 0 },
  input: { padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, width: '100%' },
  section: { marginBottom: 20 },
  sectionHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 10 },
  charCount: { fontSize: 11, color: '#6b7280', flexShrink: 0 },
  sectionTitle: { fontWeight: 700, fontSize: 13, color: '#111827', textTransform: 'uppercase', letterSpacing: '0.04em' },
  autofillBtn: { fontSize: 12, color: 'var(--ops-page-accent)', background: '#eff6ff', border: 'none', padding: '5px 10px', borderRadius: 6, cursor: 'pointer', fontWeight: 600, flexShrink: 0 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 6 },
  th: { textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', padding: '6px 8px', borderBottom: '2px solid #e5e7eb' },
  td: { padding: '4px 8px', borderBottom: '1px solid #f3f4f6' },
  cellInput: { padding: '5px 7px', border: '1px solid #e5e7eb', borderRadius: 5, fontSize: 13, width: '100%' },
  removeRowBtn: { background: 'none', border: 'none', color: '#fca5a5', fontSize: 14, cursor: 'pointer', padding: '2px 4px' },
  addRowBtn: { fontSize: 12, color: '#6b7280', background: 'none', border: '1px dashed #d1d5db', padding: '5px 12px', borderRadius: 6, cursor: 'pointer', marginTop: 4 },
  textarea: { width: '100%', padding: '9px 11px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 },
  photoStrip: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  photoThumb: { width: 80, height: 60, objectFit: 'cover', borderRadius: 6 },
  photoNote: { fontSize: 11, color: '#6b7280', margin: '6px 0 0' },
  error: { color: '#ef4444', fontSize: 13, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', margin: '0 0 12px' },
  editorActions: { display: 'flex', gap: 10, flexWrap: 'wrap' },
  saveDraftBtn: { background: '#f3f4f6', color: '#374151', border: '1px solid #e5e7eb', padding: '10px 20px', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer' },
  submitBtn: { background: '#059669', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  cancelBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '10px 20px', borderRadius: 8, fontSize: 14, cursor: 'pointer' },
};
