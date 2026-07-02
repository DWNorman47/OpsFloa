import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import api from '../api';
import AppHeader from '../components/AppHeader';
import { useT } from '../hooks/useT';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { SkeletonList } from '../components/Skeleton';
import EmptyState from '../components/EmptyState';
import TabBar from '../components/TabBar';
import { langToLocale } from '../utils';
import { silentError, reportClientError } from '../errorReporter';
import RetryBanner from '../components/RetryBanner';
import ProjectFinancialsTab from '../components/ProjectFinancialsTab';
import ProjectCloseoutTab from '../components/ProjectCloseoutTab';
import { EstimatesPanel } from './EstimatesPage';
import { ChangeOrdersPanel } from './ChangeOrdersPage';
import { SubPOsPanel } from './SubsPage';
import { useHasAnyPerm } from '../hooks/usePerm';

function punchColor(status) {
  return { open: '#f59e0b', in_progress: '#3b82f6', resolved: '#059669', closed: '#9ca3af' }[status] || '#9ca3af';
}

function plural(label) {
  if (!label) return '';
  if (/s$/i.test(label)) return label;
  if (/y$/i.test(label)) return `${label.slice(0, -1)}ies`;
  return `${label}s`;
}

// ── Project Card ──────────────────────────────────────────────────────────────

function ProjectCard({ project, metrics, settings, onClick }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const m = metrics || {};
  const totalHours = parseFloat(m.total_hours || 0);
  const budgetHours = parseFloat(project.budget_hours || 0);
  const budgetDollars = parseFloat(project.budget_dollars || 0);
  const workerCount = parseInt(m.worker_count || 0);
  const workerLabel = settings?.label_worker || 'Team Member';

  const hoursUsedPct = budgetHours > 0 ? Math.min(100, (totalHours / budgetHours) * 100) : 0;

  const hourColor = hoursUsedPct >= 100 ? '#ef4444' : hoursUsedPct >= 85 ? '#f59e0b' : '#059669';

  const fmtHours = h => {
    const n = parseFloat(h);
    if (isNaN(n)) return '0h';
    return n % 1 === 0 ? `${n}h` : `${n.toFixed(1)}h`;
  };

  const fmtMoney = v => {
    const n = parseFloat(v);
    if (isNaN(n) || n === 0) return null;
    return new Intl.NumberFormat(locale, { style: 'currency', currency: settings?.currency || 'USD', maximumFractionDigits: 0 }).format(n);
  };
  const statusColors = { planning: '#dbeafe|#1d4ed8', in_progress: '#d1fae5|#065f46', on_hold: '#fef3c7|#92400e', completed: '#e5e7eb|#374151' };
  const [statusBg, statusFg] = (statusColors[project.status] || '#f3f4f6|#6b7280').split('|');
  const statusLabel = { planning: 'Planning', in_progress: 'In Progress', on_hold: 'On Hold', completed: 'Completed' }[project.status];

  return (
    <div style={{ ...styles.card, opacity: project.active === false ? 0.6 : 1 }} onClick={onClick} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onClick()}>
      {project.active === false && (
        <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Archived</div>
      )}
      <div style={styles.cardTop}>
        <div style={styles.cardName}>{project.name}</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0, marginLeft: 8 }}>
          {statusLabel && <span style={{ fontSize: 10, fontWeight: 700, background: statusBg, color: statusFg, padding: '2px 7px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{statusLabel}</span>}
          <div style={styles.cardBadge}>{workerCount} {plural(workerLabel).toLowerCase()}</div>
        </div>
      </div>
      {project.client_name && <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8, marginTop: -4 }}>{project.client_name}{project.job_number ? ` · ${project.job_number}` : ''}</div>}

      <div style={styles.statsRow}>
        <div style={styles.statItem}>
          <div style={styles.statValue}>{fmtHours(totalHours)}</div>
          <div style={styles.statLabel}>{t.ppTotalHoursStat}</div>
        </div>
        {budgetHours > 0 && (
          <div style={styles.statItem}>
            <div style={{ ...styles.statValue, color: hourColor }}>{fmtHours(budgetHours)}</div>
            <div style={styles.statLabel}>{t.ppBudgetHoursStat}</div>
          </div>
        )}
        {m.overtime_hours > 0 && (
          <div style={styles.statItem}>
            <div style={{ ...styles.statValue, color: '#f59e0b' }}>{fmtHours(m.overtime_hours)}</div>
            <div style={styles.statLabel}>Overtime</div>
          </div>
        )}
        {budgetDollars > 0 && (
          <div style={styles.statItem}>
            <div style={styles.statValue}>{fmtMoney(budgetDollars)}</div>
            <div style={styles.statLabel}>Budget</div>
          </div>
        )}
      </div>

      {budgetHours > 0 && (
        <div style={styles.progressWrap}>
          <div style={styles.progressBar}>
            <div style={{ ...styles.progressFill, width: `${hoursUsedPct}%`, background: hourColor }} />
          </div>
          <div style={{ ...styles.progressLabel, color: hourColor }}>
            {hoursUsedPct.toFixed(0)}% of budget hours used
          </div>
        </div>
      )}
      {project.progress_pct != null && (
        <div style={{ ...styles.progressWrap, marginTop: budgetHours > 0 ? 6 : 8 }}>
          <div style={styles.progressBar}>
            <div style={{ ...styles.progressFill, width: `${project.progress_pct}%`, background: '#8b5cf6' }} />
          </div>
          <div style={{ ...styles.progressLabel, color: '#8b5cf6' }}>
            {project.progress_pct}% complete
          </div>
        </div>
      )}
    </div>
  );
}

// ── Project Detail Panel ──────────────────────────────────────────────────────

function ProjectDetail({ project, metrics, settings, companyInfo = {}, onClose, onProjectUpdated, onProjectArchived }) {
  const t = useT();
  const { user } = useAuth();
  const locale = langToLocale(user?.language);
  const [tab, setTab] = useState('overview');
  // Coerce any unknown status (e.g. from old data where the conversion
  // path wrote 'active') to a valid dropdown option so the user can save
  // edits without first manually picking a status.
  const VALID_PROJECT_STATUSES = ['planning', 'in_progress', 'on_hold', 'completed'];
  const initialStatus = VALID_PROJECT_STATUSES.includes(project.status) ? project.status : 'in_progress';
  const [editForm, setEditForm] = useState({
    name: project.name,
    status: initialStatus,
    client_name: project.client_name || '',
    job_number: project.job_number || '',
    address: project.address || '',
    start_date: project.start_date ? project.start_date.split('T')[0] : '',
    end_date: project.end_date ? project.end_date.split('T')[0] : '',
    description: project.description || '',
    progress_pct: project.progress_pct != null ? String(project.progress_pct) : '',
    wage_type: project.wage_type || 'regular',
    geo_lat: project.geo_lat != null ? String(project.geo_lat) : '',
    geo_lng: project.geo_lng != null ? String(project.geo_lng) : '',
    geo_radius_ft: project.geo_radius_ft != null ? String(project.geo_radius_ft) : '',
  });
  const [editSaving, setEditSaving] = useState(false);
  const [editMsg, setEditMsg] = useState('');
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [geoLocating, setGeoLocating] = useState(false);
  const [geoError, setGeoError] = useState('');
  const [geocoding, setGeocoding] = useState(false);
  const [entries, setEntries] = useState([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [entriesError, setEntriesError] = useState(null);
  const [billData, setBillData] = useState(null);
  const [billLoading, setBillLoading] = useState(false);
  const [pdfGenerating, setPdfGenerating] = useState(false);
  const [qboStatus, setQboStatus] = useState(null);
  const [qboItems, setQboItems] = useState(null);
  const [qboItemId, setQboItemId] = useState('');
  const [qboLoading, setQboLoading] = useState(false);
  const [qboPushing, setQboPushing] = useState(false);
  const [qboPushResult, setQboPushResult] = useState(null);
  const [showQboPicker, setShowQboPicker] = useState(false);
  const [billFrom, setBillFrom] = useState('');
  const [billTo, setBillTo] = useState('');
  const [workers, setWorkers] = useState([]);
  const [workersLoading, setWorkersLoading] = useState(false);
  const [activity, setActivity] = useState([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [health, setHealth] = useState(null);
  const [photos, setPhotos] = useState([]);
  const [photosOpen, setPhotosOpen] = useState(false);
  const [photosLoaded, setPhotosLoaded] = useState(false);
  const [lightboxPhoto, setLightboxPhoto] = useState(null);
  const [rfis, setRfis] = useState([]);
  const [rfisOpen, setRfisOpen] = useState(false);
  const [rfisLoaded, setRfisLoaded] = useState(false);
  const [rfiFormOpen, setRfiFormOpen] = useState(false);
  const [rfiForm, setRfiForm] = useState({ subject: '', directed_to: '', description: '', date_due: '' });
  const [rfiSaving, setRfiSaving] = useState(false);
  const [rfiError, setRfiError] = useState('');
  const [punch, setPunch] = useState([]);
  const [punchOpen, setPunchOpen] = useState(false);
  const [punchLoaded, setPunchLoaded] = useState(false);
  const [punchFormOpen, setPunchFormOpen] = useState(false);
  const [punchForm, setPunchForm] = useState({ title: '', description: '', location: '', priority: 'normal' });
  const [punchSaving, setPunchSaving] = useState(false);
  const [punchError, setPunchError] = useState('');
  const [docs, setDocs] = useState([]);
  const [docsOpen, setDocsOpen] = useState(false);
  const [docsLoaded, setDocsLoaded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pendingDocDelete, setPendingDocDelete] = useState(null);
  const [invoiceHistory, setInvoiceHistory] = useState(null);
  const [checkingInvoice, setCheckingInvoice] = useState(new Set());

  const m = metrics || {};
  const fmtHours = h => {
    const n = parseFloat(h);
    if (isNaN(n) || n === 0) return '0h';
    return n % 1 === 0 ? `${n}h` : `${n.toFixed(1)}h`;
  };
  const fmtMoney = v => {
    const n = parseFloat(v);
    if (isNaN(n) || n === 0) return '—';
    return new Intl.NumberFormat(locale, { style: 'currency', currency: settings?.currency || 'USD', maximumFractionDigits: 0 }).format(n);
  };

  const workLabel = settings?.label_work || 'Project';
  const workLabelLower = workLabel.toLowerCase();
  const clientLabel = settings?.label_client || 'Customer';
  const workerLabel = settings?.label_worker || 'Team Member';
  const workerLabelPlural = plural(workerLabel);

  useEffect(() => {
    if (tab === 'entries') {
      setEntriesLoading(true);
      api.get(`/admin/projects/${project.id}/entries`)
        .then(r => { setEntries(r.data.entries || []); setEntriesError(null); })
        .catch(err => { setEntriesError(t.failedLoadEntries || 'Failed to load entries'); silentError('project entries')(err); })
        .finally(() => setEntriesLoading(false));
    }
    if (tab === 'overview' && workers.length === 0) {
      setWorkersLoading(true);
      api.get(`/admin/projects/${project.id}/workers`)
        .then(r => setWorkers(r.data))
        .catch(silentError('project workers'))
        .finally(() => setWorkersLoading(false));
      setActivityLoading(true);
      api.get(`/admin/projects/${project.id}/activity`)
        .then(r => setActivity(r.data))
        .catch(silentError('project activity'))
        .finally(() => setActivityLoading(false));
      api.get(`/admin/projects/${project.id}/health`)
        .then(r => setHealth(r.data))
        .catch(silentError('project health'));
    }
  }, [tab, project.id]);

  const loadPhotos = () => {
    if (photosLoaded) return;
    setPhotosLoaded(true);
    api.get(`/admin/projects/${project.id}/photos`)
      .then(r => setPhotos(r.data))
      .catch(silentError('project photos'));
  };

  const loadRfis = () => {
    if (rfisLoaded) return;
    setRfisLoaded(true);
    api.get(`/admin/projects/${project.id}/rfis`)
      .then(r => setRfis(r.data))
      .catch(silentError('project rfis'));
  };

  const submitRfi = async (e) => {
    e.preventDefault();
    if (!rfiForm.subject.trim()) return;
    setRfiSaving(true);
    setRfiError('');
    try {
      const { data: newRfi } = await api.post(`/admin/projects/${project.id}/rfis`, rfiForm);
      setRfis(prev => [newRfi, ...prev]);
      setRfiForm({ subject: '', directed_to: '', description: '', date_due: '' });
      setRfiFormOpen(false);
    } catch (err) {
      setRfiError(t.failedSave || 'Failed to save RFI');
      reportClientError({ kind: 'unhandled', message: `submit RFI: ${err?.message || err}`, stack: err?.stack });
    }
    setRfiSaving(false);
  };

  const loadPunch = () => {
    if (punchLoaded) return;
    setPunchLoaded(true);
    api.get('/punchlist', { params: { project_id: project.id, limit: 100 } })
      .then(r => setPunch(r.data.items))
      .catch(silentError('project punchlist'));
  };

  const submitPunch = async (e) => {
    e.preventDefault();
    if (!punchForm.title.trim()) { setPunchError(t.titleRequired || 'Title is required.'); return; }
    setPunchSaving(true);
    setPunchError('');
    try {
      const { data: item } = await api.post('/punchlist', { ...punchForm, project_id: project.id });
      setPunch(prev => [item, ...prev]);
      setPunchForm({ title: '', description: '', location: '', priority: 'normal' });
      setPunchFormOpen(false);
    } catch {
      setPunchError(t.failedSave);
    }
    setPunchSaving(false);
  };

  const loadDocs = () => {
    if (docsLoaded) return;
    setDocsLoaded(true);
    api.get(`/admin/projects/${project.id}/documents`)
      .then(r => setDocs(r.data))
      .catch(silentError('project documents'));
  };

  const [uploadError, setUploadError] = React.useState('');
  const uploadDoc = async (file) => {
    if (!file) return;
    setUploading(true);
    setUploadError('');
    try {
      const { data: { uploadUrl, fileUrl } } = await api.get(
        `/admin/projects/${project.id}/documents/upload-url`,
        { params: { name: file.name, type: file.type } }
      );
      await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
      const { data: doc } = await api.post(`/admin/projects/${project.id}/documents`, {
        name: file.name, url: fileUrl, size_bytes: file.size,
      });
      setDocs(d => [...d, doc]);
    } catch (err) {
      setUploadError(t.uploadFailed || 'Upload failed');
      reportClientError({ kind: 'unhandled', message: `document upload: ${err?.message || err}`, stack: err?.stack });
    } finally {
      setUploading(false);
    }
  };

  const loadBilling = () => {
    setBillLoading(true);
    const params = {};
    if (billFrom) params.from = billFrom;
    if (billTo) params.to = billTo;
    api.get(`/admin/projects/${project.id}/entries`, { params })
      .then(r => setBillData(r.data))
      .catch(silentError('project billing'))
      .finally(() => setBillLoading(false));
  };

  useEffect(() => {
    if (tab === 'billing' && !billData) loadBilling();
    if (tab === 'billing' && invoiceHistory === null && project.qbo_customer_id) {
      api.get(`/qbo/invoices/project/${project.id}`)
        .then(r => setInvoiceHistory(r.data))
        .catch(err => { setInvoiceHistory([]); silentError('project invoice history')(err); });
    }
  }, [tab]);

  const downloadPDF = async () => {
    setPdfGenerating(true);
    try {
      const [{ pdf }, { default: ProjectBillPDF }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('../components/ProjectBillPDF'),
      ]);
      const el = React.createElement(ProjectBillPDF, { data: billData, currency: settings?.currency || 'USD', companyInfo, project, t, language: user?.language, settings });
      const blob = await pdf(el).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `invoice-${project.name.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } finally { setPdfGenerating(false); }
  };

  const openQBOPicker = async () => {
    setQboPushResult(null);
    setQboLoading(true);
    try {
      if (!qboStatus) {
        const r = await api.get('/qbo/status');
        setQboStatus(r.data);
        if (!r.data.connected) return;
      }
      if (qboItems === null) {
        const r = await api.get('/qbo/items');
        setQboItems(r.data);
        if (r.data.length === 1) setQboItemId(r.data[0].Id);
      }
      setShowQboPicker(true);
    } catch (err) {
      silentError('QBO picker')(err);
    } finally {
      setQboLoading(false);
    }
  };

  const pushInvoiceToQBO = async () => {
    if (!qboItemId) return;
    setQboPushing(true);
    setQboPushResult(null);
    try {
      const total = parseFloat(billData.summary.total_cost);
      const periodStr = [billFrom, billTo].filter(Boolean).join(' – ') || 'all dates';
      const description = `Labor — ${project.name} (${periodStr})`;
      const r = await api.post('/qbo/invoices', {
        customer_id: project.qbo_customer_id,
        item_id: qboItemId,
        amount: total,
        description,
        txn_date: billTo || new Date().toLocaleDateString('en-CA'),
        project_id: project.id,
      });
      setQboPushResult({ success: true, invoiceId: r.data.Id, docNumber: r.data.DocNumber });
      setShowQboPicker(false);
      // Refresh invoice history
      api.get(`/qbo/invoices/project/${project.id}`)
        .then(res => setInvoiceHistory(res.data))
        .catch(silentError('project invoice history refresh'));
    } catch (err) {
      setQboPushResult({ success: false, error: err.response?.data?.error || 'Push failed' });
    } finally { setQboPushing(false); }
  };

  const checkInvoicePayment = async (qboInvoiceId) => {
    setCheckingInvoice(prev => new Set(prev).add(qboInvoiceId));
    try {
      const r = await api.post(`/qbo/invoices/${qboInvoiceId}/check-payment`);
      setInvoiceHistory(prev => prev.map(inv =>
        inv.qbo_invoice_id === qboInvoiceId
          ? { ...inv, balance: r.data.balance, payment_status: r.data.payment_status, last_checked_at: new Date().toISOString() }
          : inv
      ));
    } catch { /* non-fatal */ }
    finally {
      setCheckingInvoice(prev => { const n = new Set(prev); n.delete(qboInvoiceId); return n; });
    }
  };

  const handleEditSave = async () => {
    if (!editForm.name.trim()) return;
    // Geofence: a complete fence needs all three values. Either send all or
    // none — partial values are confusing and the server would store them
    // anyway, leaving the project in a bad half-state.
    const lat = editForm.geo_lat.trim();
    const lng = editForm.geo_lng.trim();
    const radius = editForm.geo_radius_ft.trim();
    const geoCount = [lat, lng, radius].filter(Boolean).length;
    if (geoCount > 0 && geoCount < 3) {
      setEditMsg('Geofence needs latitude, longitude, AND radius — or leave all three blank.');
      return;
    }
    setEditSaving(true); setEditMsg('');
    try {
      const payload = {
        name: editForm.name.trim(),
        status: editForm.status,
        client_name: editForm.client_name || null,
        job_number: editForm.job_number || null,
        address: editForm.address || null,
        start_date: editForm.start_date || null,
        end_date: editForm.end_date || null,
        description: editForm.description || null,
        progress_pct: editForm.progress_pct !== '' ? parseInt(editForm.progress_pct, 10) : null,
        wage_type: editForm.wage_type,
        updated_at: project.updated_at,
      };
      if (geoCount === 3) {
        payload.geo_lat = parseFloat(lat);
        payload.geo_lng = parseFloat(lng);
        payload.geo_radius_ft = parseInt(radius, 10);
      } else if (project.geo_radius_ft != null) {
        // User cleared all three fields on a project that had a geofence —
        // explicit clear so the server drops it.
        payload.clear_geofence = true;
      }
      const r = await api.patch(`/admin/projects/${project.id}`, payload);
      onProjectUpdated?.(r.data);
      setEditMsg('Saved');
      setTimeout(() => setEditMsg(''), 2000);
    } catch (err) {
      setEditMsg(err.response?.status === 409 ? 'Modified by someone else — refresh first' : 'Failed to save');
    } finally { setEditSaving(false); }
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setGeoError('Your browser doesn\'t support geolocation.');
      return;
    }
    setGeoLocating(true); setGeoError('');
    navigator.geolocation.getCurrentPosition(
      pos => {
        setEditForm(f => ({
          ...f,
          geo_lat: pos.coords.latitude.toFixed(6),
          geo_lng: pos.coords.longitude.toFixed(6),
          geo_radius_ft: f.geo_radius_ft || '300',
        }));
        setGeoLocating(false);
      },
      err => {
        setGeoError(err.code === 1 ? 'Location permission denied.' : 'Could not get your location.');
        setGeoLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const handleMarkComplete = async () => {
    setEditSaving(true); setEditMsg('');
    try {
      const r = await api.patch(`/admin/projects/${project.id}`, { status: 'completed' });
      onProjectUpdated?.(r.data);
      setEditForm(f => ({ ...f, status: 'completed' }));
      setEditMsg(`${workLabel} marked as complete`);
      setTimeout(() => setEditMsg(''), 2500);
    } catch {
      setEditMsg('Failed to update');
    } finally { setEditSaving(false); }
  };

  const handleArchiveProject = async () => {
    setEditSaving(true); setEditMsg('');
    try {
      await api.delete(`/admin/projects/${project.id}`);
      onProjectArchived?.(project.id);
      onClose?.();
    } catch (err) {
      setEditMsg(err.response?.data?.error || `Failed to archive ${workLabelLower}`);
      setConfirmArchive(false);
    } finally { setEditSaving(false); }
  };

  const exportCsv = () => {
    if (!billData?.entries?.length) return;
    const rows = [[workerLabel, 'Date', 'Start', 'End', 'Regular Hours', 'Overtime Hours', 'Cost']];
    billData.entries.forEach(e => {
      rows.push([
        e.worker_name || '',
        e.work_date?.toString().substring(0, 10) || '',
        e.start_time || '',
        e.end_time || '',
        parseFloat(e.regular_hours || 0).toFixed(2),
        parseFloat(e.overtime_hours || 0).toFixed(2),
        parseFloat(e.total_cost || 0).toFixed(2),
      ]);
    });
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name.replace(/[^a-z0-9]/gi, '_')}_billing.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const budgetHours = parseFloat(project.budget_hours || 0);
  const totalHours = parseFloat(m.total_hours || 0);
  const hoursUsedPct = budgetHours > 0 ? Math.min(100, (totalHours / budgetHours) * 100) : 0;
  const hourColor = hoursUsedPct >= 100 ? '#ef4444' : hoursUsedPct >= 85 ? '#f59e0b' : '#059669';

  return (
    <div style={styles.detailOverlay} className="project-detail-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={styles.detailPanel} className="project-detail-panel">
        <div style={styles.detailHeader} className="project-detail-header">
          <div>
            <h2 style={styles.detailTitle}>{project.name}</h2>
            <p style={styles.detailSub}>
              {project.client_name && <>{project.client_name} · </>}
              {parseInt(m.worker_count || 0)} {workerLabelPlural.toLowerCase()} · {parseInt(m.total_entries || 0)} entries
            </p>
          </div>
          <button style={styles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div style={styles.detailTabs} className="project-detail-tabs">
          {['overview', 'financials', 'closeout', 'billing', 'entries', 'edit'].map(t => (
            <button key={t} className="project-detail-tab" style={{ ...styles.detailTab, ...(tab === t ? styles.detailTabActive : {}) }} onClick={() => setTab(t)}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        <div style={styles.detailBody} className="project-detail-body">
          {tab === 'overview' && (
            <div>
              {/* Project metadata */}
              {(project.client_name || project.job_number || project.address || project.start_date || project.end_date || project.description || (project.status && project.status !== 'in_progress')) && (
                <div style={{ ...styles.budgetSection, marginBottom: 16 }}>
                  <div style={styles.sectionTitle}>{t.mpProjectInfo}</div>
                  {project.status && (() => {
                    const statusColors = { planning: '#dbeafe|#1d4ed8', in_progress: '#d1fae5|#065f46', on_hold: '#fef3c7|#92400e', completed: '#e5e7eb|#374151' };
                    const [bg, fg] = (statusColors[project.status] || '#f3f4f6|#6b7280').split('|');
                    const label = { planning: 'Planning', in_progress: 'In Progress', on_hold: 'On Hold', completed: 'Completed' }[project.status];
                    return label ? <span style={{ fontSize: 11, fontWeight: 700, background: bg, color: fg, padding: '2px 9px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.04em', display: 'inline-block', marginBottom: 8 }}>{label}</span> : null;
                  })()}
                  {project.client_name && <div style={styles.budgetRow}><span style={styles.budgetLabel}>{clientLabel}</span><span style={styles.budgetValue}>{project.client_name}</span></div>}
                  {project.job_number && <div style={styles.budgetRow}><span style={styles.budgetLabel}>Job #</span><span style={styles.budgetValue}>{project.job_number}</span></div>}
                  {project.address && <div style={styles.budgetRow}><span style={styles.budgetLabel}>Address</span><span style={{ ...styles.budgetValue, textAlign: 'right', maxWidth: 220 }}>{project.address}</span></div>}
                  {project.start_date && <div style={styles.budgetRow}><span style={styles.budgetLabel}>Start</span><span style={styles.budgetValue}>{new Date(project.start_date).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })}</span></div>}
                  {project.end_date && <div style={styles.budgetRow}><span style={styles.budgetLabel}>{t.ppTargetEnd}</span><span style={styles.budgetValue}>{new Date(project.end_date).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })}</span></div>}
                  {project.description && <p style={{ fontSize: 13, color: '#374151', margin: '8px 0 0', lineHeight: 1.5 }}>{project.description}</p>}
                </div>
              )}

              <div style={styles.metricsGrid}>
                <div style={styles.metricCard}>
                  <div style={styles.metricValue}>{fmtHours(m.total_hours)}</div>
                  <div style={styles.metricLabel}>{t.ppTotalHours}</div>
                </div>
                <div style={styles.metricCard}>
                  <div style={styles.metricValue}>{fmtHours(m.regular_hours)}</div>
                  <div style={styles.metricLabel}>{t.ppRegularHours}</div>
                </div>
                <div style={styles.metricCard}>
                  <div style={{ ...styles.metricValue, color: parseFloat(m.overtime_hours) > 0 ? '#f59e0b' : '#111827' }}>
                    {fmtHours(m.overtime_hours)}
                  </div>
                  <div style={styles.metricLabel}>{t.ppOvertimeHours}</div>
                </div>
                <div style={styles.metricCard}>
                  <div style={styles.metricValue}>{parseInt(m.worker_count || 0)}</div>
                  <div style={styles.metricLabel}>{workerLabelPlural}</div>
                </div>
              </div>

              {/* Health counts */}
              {health && (health.open_punchlist > 0 || health.open_rfis > 0 || health.reports_week > 0) && (
                <div style={styles.healthRow}>
                  {health.open_punchlist > 0 && (
                    <div style={styles.healthChip}>
                      <span style={{ ...styles.healthDot, background: '#f59e0b' }} />
                      <span>{health.open_punchlist} open punch{health.open_punchlist !== 1 ? 'list items' : 'list item'}</span>
                    </div>
                  )}
                  {health.open_rfis > 0 && (
                    <div style={styles.healthChip}>
                      <span style={{ ...styles.healthDot, background: '#3b82f6' }} />
                      <span>{health.open_rfis} open RFI{health.open_rfis !== 1 ? 's' : ''}</span>
                    </div>
                  )}
                  {health.reports_week > 0 && (
                    <div style={styles.healthChip}>
                      <span style={{ ...styles.healthDot, background: '#059669' }} />
                      <span>{health.reports_week} field report{health.reports_week !== 1 ? 's' : ''} this week</span>
                    </div>
                  )}
                </div>
              )}

              {/* Visibility */}
              <ProjectVisibility project={project} onProjectUpdated={onProjectUpdated} toggleStyle={styles.activityToggle} countStyle={styles.activityCount} workLabel={workLabel} workerLabel={workerLabel} />

              {/* Punchlist */}
              <div style={{ marginBottom: 16 }}>
                <button
                  style={styles.activityToggle}
                  onClick={() => { setPunchOpen(o => !o); if (!punchOpen) loadPunch(); }}
                >
                  <span>{t.punchlistTitle}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {punch.filter(p => p.status === 'open').length > 0 && (
                      <span style={{ ...styles.activityCount, background: '#f59e0b' }}>
                        {punch.filter(p => p.status === 'open').length} open
                      </span>
                    )}
                    {punch.length > 0 && punch.filter(p => p.status === 'open').length === 0 && (
                      <span style={styles.activityCount}>{punch.length}</span>
                    )}
                    <span style={{ fontSize: 12, color: '#6b7280' }}>{punchOpen ? '▴' : '▾'}</span>
                  </span>
                </button>

                {punchOpen && (
                  <div>
                    {punchLoaded && punch.length === 0 && !punchFormOpen && (
                      <p style={{ fontSize: 12, color: '#6b7280', margin: '8px 0 6px' }}>{t.ppNoPunchlist}</p>
                    )}
                    {punch.length > 0 && (
                      <div style={{ ...styles.activityList, marginBottom: 8 }}>
                        {punch.map(item => {
                          const statusColor = item.status === 'open' ? '#f59e0b' : item.status === 'in_progress' ? '#3b82f6' : item.status === 'resolved' ? '#059669' : '#9ca3af';
                          const priorityColor = item.priority === 'high' ? '#ef4444' : item.priority === 'low' ? '#9ca3af' : '#374151';
                          return (
                            <div key={item.id} style={styles.activityItem}>
                              <div style={{ ...styles.activityDot, background: statusColor }} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={styles.activityTitle}>
                                  <span style={{ ...styles.activityTag, background: statusColor + '22', color: statusColor }}>{item.status}</span>
                                  {item.priority === 'high' && <span style={{ ...styles.activityTag, background: '#fee2e2', color: '#ef4444' }}>high</span>}
                                  <span style={styles.activityText}>{item.title}</span>
                                </div>
                                <div style={styles.activityMeta}>
                                  {item.location && <span>{item.location} · </span>}
                                  {item.assigned_to_name && <span>→ {item.assigned_to_name} · </span>}
                                  <span>{new Date(item.created_at).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}</span>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {punchFormOpen ? (
                      <form onSubmit={submitPunch} style={styles.rfiForm}>
                        <input
                          style={styles.rfiInput}
                          type="text"
                          placeholder={t.ppPunchTitlePlaceholder}
                          value={punchForm.title}
                          onChange={e => setPunchForm(f => ({ ...f, title: e.target.value }))}
                          required
                        />
                        <input
                          style={styles.rfiInput}
                          type="text"
                          placeholder={t.ppPunchLocationPlaceholder}
                          value={punchForm.location}
                          onChange={e => setPunchForm(f => ({ ...f, location: e.target.value }))}
                        />
                        <select
                          style={styles.rfiInput}
                          value={punchForm.priority}
                          onChange={e => setPunchForm(f => ({ ...f, priority: e.target.value }))}
                        >
                          <option value="low">{t.optLowPriority}</option>
                          <option value="normal">{t.optNormalPriority}</option>
                          <option value="high">{t.optHighPriority}</option>
                        </select>
                        <textarea
                          style={{ ...styles.rfiInput, resize: 'vertical', minHeight: 56, fontFamily: 'inherit' }}
                          placeholder={t.ppPunchDescPlaceholder}
                          value={punchForm.description}
                          onChange={e => setPunchForm(f => ({ ...f, description: e.target.value }))}
                        />
                        {punchError && <p style={{ color: '#dc2626', fontSize: 12, margin: 0 }}>{punchError}</p>}
                        <div style={{ display: 'flex', gap: 6 }} className="project-inline-actions">
                          <button type="submit" style={styles.rfiSubmitBtn} disabled={punchSaving}>
                            {punchSaving ? t.saving : t.punchlistAddItem}
                          </button>
                          <button type="button" style={styles.rfiCancelBtn} onClick={() => { setPunchFormOpen(false); setPunchError(''); }}>
                            {t.cancel}
                          </button>
                        </div>
                      </form>
                    ) : (
                      <button style={styles.uploadBtn} onClick={() => setPunchFormOpen(true)}>+ Add Item</button>
                    )}
                  </div>
                )}
              </div>

              {/* Roster */}
              {(workersLoading || workers.length > 0) && (
                <div style={{ ...styles.budgetSection, marginBottom: 16 }}>
                  <div style={styles.sectionTitle}>{workerLabelPlural} ({workers.length})</div>
                  {workersLoading ? (
                    <p style={{ fontSize: 12, color: '#6b7280', margin: 0 }}>Loading…</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {workers.map(w => (
                        <div key={w.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 13, color: '#374151', fontWeight: 600 }}>{w.worker_name}</span>
                          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                            <span style={{ fontSize: 12, color: '#6b7280' }}>
                              {parseFloat(w.total_hours).toFixed(1)}h
                            </span>
                            <span style={{ fontSize: 11, color: '#6b7280' }}>
                              {new Date(w.last_worked).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {(budgetHours > 0 || project.budget_dollars > 0) && (
                <div style={styles.budgetSection}>
                  <div style={styles.sectionTitle}>Budget</div>
                  {budgetHours > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={styles.budgetRow}>
                        <span style={styles.budgetLabel}>Hours</span>
                        <span style={{ ...styles.budgetValue, color: hourColor }}>{fmtHours(totalHours)} / {fmtHours(budgetHours)}</span>
                      </div>
                      <div style={styles.progressBar}>
                        <div style={{ ...styles.progressFill, width: `${hoursUsedPct}%`, background: hourColor }} />
                      </div>
                      <div style={{ ...styles.progressLabel, color: hourColor }}>{hoursUsedPct.toFixed(0)}% used</div>
                    </div>
                  )}
                  {project.budget_dollars > 0 && health && (() => {
                    const cost = parseFloat(health.approx_cost || 0);
                    const budget = parseFloat(project.budget_dollars);
                    const pct = Math.min(100, (cost / budget) * 100);
                    const color = pct >= 100 ? '#ef4444' : pct >= 85 ? '#f59e0b' : 'var(--ops-page-accent)';
                    return (
                      <div style={{ marginBottom: 8 }}>
                        <div style={styles.budgetRow}>
                          <span style={styles.budgetLabel}>Est. Cost</span>
                          <span style={{ ...styles.budgetValue, color }}>{fmtMoney(cost)} / {fmtMoney(budget)}</span>
                        </div>
                        <div style={styles.progressBar}>
                          <div style={{ ...styles.progressFill, width: `${pct}%`, background: color }} />
                        </div>
                        <div style={{ ...styles.progressLabel, color }}>{pct.toFixed(0)}% of budget used</div>
                      </div>
                    );
                  })()}
                  {project.budget_dollars > 0 && !health && (
                    <div style={styles.budgetRow}>
                      <span style={styles.budgetLabel}>{t.ppDollarBudget}</span>
                      <span style={styles.budgetValue}>{fmtMoney(project.budget_dollars)}</span>
                    </div>
                  )}
                </div>
              )}

              {project.progress_pct != null && (
                <div style={{ ...styles.budgetSection, marginBottom: 16 }}>
                  <div style={styles.sectionTitle}>Progress</div>
                  <div style={styles.progressBar}>
                    <div style={{ ...styles.progressFill, width: `${project.progress_pct}%`, background: '#8b5cf6' }} />
                  </div>
                  <div style={{ ...styles.progressLabel, color: '#8b5cf6', marginTop: 4 }}>{project.progress_pct}% complete</div>
                </div>
              )}

              {project.wage_type && project.wage_type !== 'regular' && (
                <div style={styles.tagRow}>
                  <span style={styles.wageTag}>{project.wage_type === 'prevailing' ? 'Prevailing Wage' : project.wage_type}</span>
                </div>
              )}

              {/* Recent Activity accordion */}
              {(activityLoading || activity.length > 0) && (
                <div style={{ marginTop: 16 }}>
                  <button
                    style={styles.activityToggle}
                    onClick={() => setActivityOpen(o => !o)}
                  >
                    <span>{t.recentActivity}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {activity.length > 0 && <span style={styles.activityCount}>{activity.length}</span>}
                      <span style={{ fontSize: 12, color: '#6b7280' }}>{activityOpen ? '▴' : '▾'}</span>
                    </span>
                  </button>

                  {activityOpen && (
                    activityLoading ? (
                      <p style={{ fontSize: 12, color: '#6b7280', margin: '8px 0 0' }}>Loading…</p>
                    ) : (
                      <div style={styles.activityList}>
                        {activity.map(item => (
                          <div key={`${item.type}-${item.id}`} style={styles.activityItem}>
                            <div style={{ ...styles.activityDot, background: item.type === 'note' ? '#059669' : punchColor(item.status) }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={styles.activityTitle}>
                                {item.type === 'punch' && (
                                  <span style={{ ...styles.activityTag, background: punchColor(item.status) + '22', color: punchColor(item.status) }}>
                                    {item.status}
                                  </span>
                                )}
                                {item.type === 'punch' && item.priority === 'high' && (
                                  <span style={{ ...styles.activityTag, background: '#fee2e2', color: '#dc2626' }}>high</span>
                                )}
                                <span style={styles.activityText}>{item.title}</span>
                              </div>
                              <div style={styles.activityMeta}>
                                {item.type === 'note' ? '📝' : '✅'}
                                {item.worker_name && <span>{item.worker_name} · </span>}
                                <span>{new Date(item.event_at).toLocaleDateString(locale, { month: 'short', day: 'numeric' })} {new Date(item.event_at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}</span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )
                  )}
                </div>
              )}

              {/* Photos */}
              <div style={{ marginTop: 16 }}>
                <button
                  style={styles.activityToggle}
                  onClick={() => { setPhotosOpen(o => !o); if (!photosOpen) loadPhotos(); }}
                >
                  <span>{t.photosLabel}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {photos.length > 0 && <span style={styles.activityCount}>{photos.length}</span>}
                    <span style={{ fontSize: 12, color: '#6b7280' }}>{photosOpen ? '▴' : '▾'}</span>
                  </span>
                </button>

                {photosOpen && (
                  photosLoaded && photos.length === 0 ? (
                    <p style={{ fontSize: 12, color: '#6b7280', margin: '8px 0 0' }}>{t.noPhotosYet}</p>
                  ) : (
                    <div style={styles.photoGrid}>
                      {photos.map((ph, i) => (
                        <button key={i} style={styles.photoThumb} onClick={() => setLightboxPhoto(ph)}>
                          <img src={ph.url} alt={ph.caption || ''} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', borderRadius: 6 }} loading="lazy" />
                        </button>
                      ))}
                    </div>
                  )
                )}
              </div>

              {/* Documents */}
              <div style={{ marginTop: 16 }}>
                <button
                  style={styles.activityToggle}
                  onClick={() => { setDocsOpen(o => !o); if (!docsOpen) loadDocs(); }}
                >
                  <span>{t.documentsLabel}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {docs.length > 0 && <span style={styles.activityCount}>{docs.length}</span>}
                    <span style={{ fontSize: 12, color: '#6b7280' }}>{docsOpen ? '▴' : '▾'}</span>
                  </span>
                </button>

                {docsOpen && (
                  <div style={{ marginTop: 6 }}>
                    {docsLoaded && docs.length === 0 && !uploading && (
                      <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>{t.ppNoDocuments}</p>
                    )}
                    {docs.map(doc => (
                      <div key={doc.id} style={styles.docRow}>
                        <a href={doc.url} target="_blank" rel="noopener noreferrer" style={styles.docName}>{doc.name}</a>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                          {doc.size_bytes > 0 && <span style={styles.docSize}>{(doc.size_bytes / 1024).toFixed(0)} KB</span>}
                          {pendingDocDelete === doc.id ? (
                            <>
                              <span style={{ fontSize: 12, color: '#374151' }}>Delete?</span>
                              <button style={styles.docDeleteConfirm} onClick={async () => { setPendingDocDelete(null); await api.delete(`/admin/projects/${project.id}/documents/${doc.id}`); setDocs(d => d.filter(x => x.id !== doc.id)); }}>Yes</button>
                              <button style={styles.docDeleteCancel} onClick={() => setPendingDocDelete(null)}>No</button>
                            </>
                          ) : (
                            <button style={styles.docDelete} aria-label={`Delete ${doc.name}`} onClick={() => setPendingDocDelete(doc.id)}>✕</button>
                          )}
                        </div>
                      </div>
                    ))}
                    <label style={{ ...styles.uploadBtn, opacity: uploading ? 0.6 : 1, cursor: uploading ? 'not-allowed' : 'pointer' }}>
                      {uploading ? 'Uploading…' : '+ Attach File'}
                      <input type="file" style={{ display: 'none' }} disabled={uploading} onChange={e => { uploadDoc(e.target.files[0]); e.target.value = ''; }} />
                    </label>
                    {uploadError && <p role="alert" style={{ color: '#dc2626', fontSize: 12, margin: '6px 0 0' }}>{uploadError}</p>}
                  </div>
                )}
              </div>

              {/* RFIs */}
              <div style={{ marginTop: 16 }}>
                <button
                  style={styles.activityToggle}
                  onClick={() => { setRfisOpen(o => !o); if (!rfisOpen) loadRfis(); }}
                >
                  <span>RFIs</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {rfis.length > 0 && <span style={styles.activityCount}>{rfis.length}</span>}
                    <span style={{ fontSize: 12, color: '#6b7280' }}>{rfisOpen ? '▴' : '▾'}</span>
                  </span>
                </button>

                {rfisOpen && (
                  <div>
                    {rfisLoaded && rfis.length === 0 && !rfiFormOpen && (
                      <p style={{ fontSize: 12, color: '#6b7280', margin: '8px 0 6px' }}>No RFIs for this project.</p>
                    )}
                    {rfis.length > 0 && (
                      <div style={{ ...styles.activityList, marginBottom: 8 }}>
                        {rfis.map(r => {
                          const statusColor = r.status === 'open' ? '#3b82f6' : r.status === 'answered' ? '#f59e0b' : '#9ca3af';
                          return (
                            <div key={r.id} style={styles.activityItem}>
                              <div style={{ ...styles.activityDot, background: statusColor }} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={styles.activityTitle}>
                                  <span style={{ ...styles.activityTag, background: statusColor + '22', color: statusColor }}>{r.status}</span>
                                  <span style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>RFI #{r.rfi_number}</span>
                                  <span style={styles.activityText}>{r.subject}</span>
                                </div>
                                <div style={styles.activityMeta}>
                                  {r.directed_to && <span>{r.directed_to} · </span>}
                                  <span>{new Date(r.date_submitted).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                                  {r.date_due && <span> · Due {new Date(r.date_due).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}</span>}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {rfiFormOpen ? (
                      <form onSubmit={submitRfi} style={styles.rfiForm}>
                        <input
                          style={styles.rfiInput}
                          type="text"
                          placeholder={t.ppRfiSubjectPlaceholder}
                          value={rfiForm.subject}
                          onChange={e => setRfiForm(f => ({ ...f, subject: e.target.value }))}
                          required
                        />
                        <input
                          style={styles.rfiInput}
                          type="text"
                          placeholder={t.ppRfiDirectedPlaceholder}
                          value={rfiForm.directed_to}
                          onChange={e => setRfiForm(f => ({ ...f, directed_to: e.target.value }))}
                        />
                        <input
                          style={styles.rfiInput}
                          type="date"
                          title={t.ppRfiDueDateTitle}
                          value={rfiForm.date_due}
                          onChange={e => setRfiForm(f => ({ ...f, date_due: e.target.value }))}
                        />
                        <textarea
                          style={{ ...styles.rfiInput, resize: 'vertical', minHeight: 60, fontFamily: 'inherit' }}
                          placeholder={t.ppPunchDescPlaceholder}
                          value={rfiForm.description}
                          onChange={e => setRfiForm(f => ({ ...f, description: e.target.value }))}
                        />
                        {rfiError && <p role="alert" style={{ color: '#dc2626', fontSize: 12, margin: 0 }}>{rfiError}</p>}
                        <div style={{ display: 'flex', gap: 6 }} className="project-inline-actions">
                          <button type="submit" style={styles.rfiSubmitBtn} disabled={rfiSaving}>
                            {rfiSaving ? 'Saving…' : 'Create RFI'}
                          </button>
                          <button type="button" style={styles.rfiCancelBtn} onClick={() => setRfiFormOpen(false)}>
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <button style={styles.uploadBtn} onClick={() => setRfiFormOpen(true)}>+ New RFI</button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Lightbox */}
          {lightboxPhoto && (
            <div style={styles.lightboxOverlay} onClick={() => setLightboxPhoto(null)}>
              <div style={styles.lightboxContent} onClick={e => e.stopPropagation()}>
                <img src={lightboxPhoto.url} alt={lightboxPhoto.caption || ''} style={{ maxWidth: '100%', maxHeight: '80vh', borderRadius: 8 }} />
                {lightboxPhoto.caption && <p style={{ color: '#f3f4f6', marginTop: 8, fontSize: 14 }}>{lightboxPhoto.caption}</p>}
                {lightboxPhoto.worker_name && <p style={{ color: '#6b7280', fontSize: 12, margin: '2px 0 0' }}>{lightboxPhoto.worker_name} · {lightboxPhoto.report_date}</p>}
                <button style={styles.lightboxClose} aria-label={t.close || 'Close'} onClick={() => setLightboxPhoto(null)}>✕</button>
              </div>
            </div>
          )}

          {tab === 'financials' && <ProjectFinancialsTab projectId={project.id} />}
          {tab === 'closeout' && <ProjectCloseoutTab projectId={project.id} />}

          {tab === 'billing' && (
            <div>
              <div style={styles.billFilterRow} className="project-bill-filter-row">
                <div style={styles.fieldGroup}>
                  <label style={styles.filterLabel}>From</label>
                  <input style={styles.filterInput} type="date" value={billFrom} onChange={e => setBillFrom(e.target.value)} />
                </div>
                <div style={styles.fieldGroup}>
                  <label style={styles.filterLabel}>To</label>
                  <input style={styles.filterInput} type="date" value={billTo} onChange={e => setBillTo(e.target.value)} />
                </div>
                <button style={styles.generateBtn} onClick={loadBilling} disabled={billLoading}>
                  {billLoading ? 'Loading…' : 'Generate'}
                </button>
                {billData?.entries?.length > 0 && (
                  <button style={{ ...styles.generateBtn, background: '#059669' }} onClick={exportCsv}>
                    Export CSV
                  </button>
                )}
              </div>

              {billData && billData.summary && (
                <div>
                  <div style={styles.metricsGrid}>
                    <div style={styles.metricCard}>
                      <div style={styles.metricValue}>{parseFloat(billData.summary.total_hours).toFixed(1)}h</div>
                      <div style={styles.metricLabel}>{t.ppTotalHours}</div>
                    </div>
                    <div style={styles.metricCard}>
                      <div style={{ ...styles.metricValue, color: 'var(--ops-page-accent)' }}>
                        {fmtMoney(billData.summary.total_cost)}
                      </div>
                      <div style={styles.metricLabel}>{t.ppTotalCost}</div>
                    </div>
                  </div>

                  <div style={styles.budgetSection}>
                    <div style={styles.sectionTitle}>{t.ppCostBreakdown}</div>
                    {billData.summary.regular_hours > 0 && (
                      <div style={styles.budgetRow}>
                        <span style={styles.budgetLabel}>Regular ({parseFloat(billData.summary.regular_hours).toFixed(1)}h)</span>
                        <span style={{ ...styles.budgetValue, color: 'var(--ops-page-accent)' }}>{fmtMoney(billData.summary.regular_cost)}</span>
                      </div>
                    )}
                    {billData.summary.overtime_hours > 0 && (
                      <div style={styles.budgetRow}>
                        <span style={styles.budgetLabel}>Overtime ({parseFloat(billData.summary.overtime_hours).toFixed(1)}h × {billData.summary.overtime_multiplier}x)</span>
                        <span style={{ ...styles.budgetValue, color: '#ef4444' }}>{fmtMoney(billData.summary.overtime_cost)}</span>
                      </div>
                    )}
                    {billData.summary.prevailing_hours > 0 && (
                      <div style={styles.budgetRow}>
                        <span style={styles.budgetLabel}>Prevailing ({parseFloat(billData.summary.prevailing_hours).toFixed(1)}h @ {fmtMoney(billData.summary.prevailing_wage_rate)}/hr)</span>
                        <span style={{ ...styles.budgetValue, color: '#f59e0b' }}>{fmtMoney(billData.summary.prevailing_cost)}</span>
                      </div>
                    )}
                    <div style={{ ...styles.budgetRow, borderTop: '1px solid #e5e7eb', marginTop: 6, paddingTop: 8 }}>
                      <span style={{ ...styles.budgetLabel, fontWeight: 700, color: '#111827' }}>{t.ppTotalDue}</span>
                      <span style={{ ...styles.budgetValue, fontSize: 16, color: '#111827' }}>{fmtMoney(billData.summary.total_cost)}</span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                    <button style={styles.pdfLink} onClick={downloadPDF} disabled={pdfGenerating}>
                      {pdfGenerating ? 'Preparing PDF…' : '⬇ Download Invoice'}
                    </button>
                    {project.qbo_customer_id && (
                      <button style={{ ...styles.qboBtn, ...(qboLoading ? { opacity: 0.6, cursor: 'not-allowed' } : {}) }} onClick={openQBOPicker} disabled={qboPushing || qboLoading}>
                        {qboLoading ? 'Loading…' : 'Push to QuickBooks'}
                      </button>
                    )}
                  </div>

                  {showQboPicker && qboItems !== null && (
                    <div style={styles.qboPicker}>
                      <div style={styles.qboPickerLabel}>{t.ppQboServiceLabel}</div>
                      {qboItems.length === 0 ? (
                        <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>{t.noQboServiceItems}</p>
                      ) : (
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }} className="project-qbo-service-row">
                          <select style={styles.qboSelect} value={qboItemId} onChange={e => setQboItemId(e.target.value)}>
                            <option value="">{t.selectItemPh}</option>
                            {qboItems.map(item => (
                              <option key={item.Id} value={item.Id}>{item.Name}</option>
                            ))}
                          </select>
                          <button style={styles.qboConfirmBtn} onClick={pushInvoiceToQBO} disabled={!qboItemId || qboPushing}>
                            {qboPushing ? 'Pushing…' : 'Create Invoice'}
                          </button>
                          <button style={styles.qboCancelBtn} onClick={() => setShowQboPicker(false)}>Cancel</button>
                        </div>
                      )}
                    </div>
                  )}

                  {qboPushResult && (
                    <div style={{ ...styles.qboResult, background: qboPushResult.success ? '#f0fdf4' : '#fef2f2', borderColor: qboPushResult.success ? '#bbf7d0' : '#fecaca' }}>
                      {qboPushResult.success
                        ? `Invoice #${qboPushResult.docNumber || qboPushResult.invoiceId} created in QuickBooks.`
                        : `Error: ${qboPushResult.error}`}
                    </div>
                  )}

                  {invoiceHistory && invoiceHistory.length > 0 && (
                    <div style={styles.invoiceHistory}>
                      <div style={styles.invoiceHistoryTitle}>QuickBooks Invoice History</div>
                      {invoiceHistory.map(inv => {
                        const statusColor = inv.payment_status === 'paid' ? '#059669' : inv.payment_status === 'partial' ? '#d97706' : '#dc2626';
                        const statusLabel = inv.payment_status === 'paid' ? 'Paid' : inv.payment_status === 'partial' ? 'Partial' : inv.payment_status === 'unknown' ? 'Unknown' : 'Unpaid';
                        return (
                          <div key={inv.id} style={styles.invoiceRow}>
                            <span style={styles.invoiceNum}>#{inv.doc_number || inv.qbo_invoice_id}</span>
                            <span style={styles.invoiceAmt}>{fmtMoney(inv.amount)}</span>
                            <span style={styles.invoiceDate}>{inv.txn_date ? String(inv.txn_date).substring(0, 10) : '—'}</span>
                            <span style={{ ...styles.invoiceStatus, color: statusColor }}>
                              {statusLabel}
                              {inv.balance != null && inv.payment_status !== 'paid' && ` (${fmtMoney(inv.balance)} remaining)`}
                            </span>
                            <button
                              style={styles.checkPaymentBtn}
                              onClick={() => checkInvoicePayment(inv.qbo_invoice_id)}
                              disabled={checkingInvoice.has(inv.qbo_invoice_id)}
                            >
                              {checkingInvoice.has(inv.qbo_invoice_id) ? '…' : 'Check Status'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {!billData && !billLoading && (
                <p style={styles.emptyText}>{t.ppSetDateRangeHint}</p>
              )}
            </div>
          )}

          {tab === 'entries' && (
            <>
            <RetryBanner message={entriesError} onRetry={() => { setEntriesError(null); setEntriesLoading(true); api.get(`/admin/projects/${project.id}/entries`).then(r => setEntries(r.data.entries || [])).catch(err => { setEntriesError(t.failedLoadEntries || 'Failed to load entries'); silentError('project entries retry')(err); }).finally(() => setEntriesLoading(false)); }} />
            {entriesLoading ? <p style={styles.loadingText}>Loading…</p> :
            entries.length === 0 ? <p style={styles.emptyText}>{t.ppNoTimeEntries}</p> :
            <div style={styles.entriesTable}>
              <div style={styles.tableHeader}>
                <span style={styles.thDate}>Date</span>
                <span style={styles.thWorker}>{workerLabel}</span>
                <span style={styles.thHours}>Hours</span>
              </div>
              {entries.slice(0, 200).map(e => {
                const start = new Date(`1970-01-01T${e.start_time}`);
                const end = new Date(`1970-01-01T${e.end_time}`);
                let hrs = (end - start) / 3600000;
                if (hrs < 0) hrs += 24;
                return (
                  <div key={e.id} style={styles.tableRow}>
                    <span style={styles.tdDate}>{new Date(e.work_date).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                    <span style={styles.tdWorker}>{e.worker_name}</span>
                    <span style={styles.tdHours}>{hrs.toFixed(1)}h</span>
                  </div>
                );
              })}
              {entries.length > 200 && <p style={styles.moreText}>{t.showingFirst200.replace('{n}', entries.length)}</p>}
            </div>}
            </>
          )}

          {tab === 'edit' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {editForm.status !== 'completed' && (
                <button
                  style={styles.finishBtn}
                  onClick={handleMarkComplete}
                  disabled={editSaving}
                >
                  {t.markAsComplete}
                </button>
              )}
              {editForm.status === 'completed' && (
                <div style={{ fontSize: 13, fontWeight: 600, color: '#059669', background: '#d1fae5', borderRadius: 8, padding: '10px 14px' }}>
                  {t.projectIsComplete}
                </div>
              )}

              {project.active !== false && (
                <div style={styles.archiveBox}>
                  <div>
                    <div style={styles.archiveTitle}>Archive {workLabel}</div>
                    <div style={styles.archiveHint}>
                      {settings?.media_delete_on_project_archive
                        ? `Hide this ${workLabelLower} from active lists and permanently delete its media.`
                        : `Hide this ${workLabelLower} from active lists without deleting its history.`}
                    </div>
                  </div>
                  {confirmArchive ? (
                    <div style={styles.archiveActions}>
                      <button
                        type="button"
                        style={{ ...styles.archiveConfirmBtn, ...(editSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                        onClick={handleArchiveProject}
                        disabled={editSaving}
                      >
                        {editSaving ? 'Archiving...' : 'Confirm archive'}
                      </button>
                      <button type="button" style={styles.archiveCancelBtn} onClick={() => setConfirmArchive(false)} disabled={editSaving}>
                        {t.cancel}
                      </button>
                    </div>
                  ) : (
                    <button type="button" style={styles.archiveProjectBtn} onClick={() => setConfirmArchive(true)}>
                      Archive
                    </button>
                  )}
                </div>
              )}

              <div style={pf.field}>
                <label style={pf.label}>{t.projectNameLabel}</label>
                <input style={pf.input} value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} />
              </div>

              <div style={pf.row} className="project-edit-grid">
                <div style={pf.field}>
                  <label style={pf.label}>{t.status}</label>
                  <select style={pf.input} value={editForm.status} onChange={e => setEditForm(f => ({ ...f, status: e.target.value }))}>
                    <option value="planning">{t.statusPlanning}</option>
                    <option value="in_progress">{t.statusInProgress}</option>
                    <option value="on_hold">{t.statusOnHold}</option>
                    <option value="completed">{t.statusCompleted}</option>
                  </select>
                </div>
                <div style={pf.field}>
                  <label style={pf.label}>{t.progressPctLabel}</label>
                  <input style={pf.input} type="number" min="0" max="100" placeholder="0–100" value={editForm.progress_pct} onChange={e => setEditForm(f => ({ ...f, progress_pct: e.target.value }))} />
                </div>
              </div>

              <div style={pf.row} className="project-edit-grid">
                <div style={pf.field}>
                  <label style={pf.label}>{`${clientLabel} name`}</label>
                  <input style={pf.input} value={editForm.client_name} onChange={e => setEditForm(f => ({ ...f, client_name: e.target.value }))} placeholder={`${clientLabel} name`} />
                </div>
                <div style={pf.field}>
                  <label style={pf.label}>{t.jobNumberLabel}</label>
                  <input style={pf.input} value={editForm.job_number} onChange={e => setEditForm(f => ({ ...f, job_number: e.target.value }))} placeholder={t.jobNumberPlaceholder} />
                </div>
              </div>

              <div style={pf.field}>
                <label style={pf.label}>
                  {t.address}
                  {geocoding && <span style={{ fontWeight: 400, color: '#6b7280', marginLeft: 8, fontSize: 12 }}>· Looking up address…</span>}
                </label>
                <input
                  style={pf.input}
                  value={editForm.address}
                  onChange={e => setEditForm(f => ({ ...f, address: e.target.value }))}
                  onBlur={async () => {
                    // Auto-geocode the address into the empty geofence,
                    // matching the create form's behaviour. Skip if any
                    // geofence field is already populated so we never
                    // overwrite a deliberate value.
                    if (!editForm.address.trim()) return;
                    if (editForm.geo_lat || editForm.geo_lng || editForm.geo_radius_ft) return;
                    setGeocoding(true);
                    const geo = await geocodeAddress(editForm.address);
                    setGeocoding(false);
                    if (geo) {
                      setEditForm(f => ({
                        ...f,
                        geo_lat: geo.lat.toFixed(6),
                        geo_lng: geo.lng.toFixed(6),
                        geo_radius_ft: String(DEFAULT_GEOFENCE_RADIUS_FT),
                      }));
                    }
                  }}
                  placeholder={t.adminAddressPh}
                />
              </div>

              <div style={pf.row} className="project-edit-grid">
                <div style={pf.field}>
                  <label style={pf.label}>{t.startDate}</label>
                  <input style={pf.input} type="date" value={editForm.start_date} onChange={e => setEditForm(f => ({ ...f, start_date: e.target.value }))} />
                </div>
                <div style={pf.field}>
                  <label style={pf.label}>{t.endDate}</label>
                  <input style={pf.input} type="date" value={editForm.end_date} onChange={e => setEditForm(f => ({ ...f, end_date: e.target.value }))} />
                </div>
              </div>

              <div style={pf.field}>
                <label style={pf.label}>{t.descriptionLabel}</label>
                <textarea style={pf.textarea} rows={3} value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} placeholder={t.scopeOfWorkPh} />
              </div>

          {/* Geofence — when filled in, team members can only clock in to this
                  project from within the radius. Server enforces; spoofed
                  client coords don't help. Leaving all three blank means
                  no geofence (clock in from anywhere). */}
              <div style={pf.field}>
                <label style={pf.label}>📍 Geofence (optional)</label>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8, lineHeight: 1.5 }}>
                  Require {workerLabelPlural.toLowerCase()} to be physically near the {workLabelLower} location to clock in.
                  Distance is calculated server-side from their phone&apos;s GPS.
                  Leave all three fields blank to allow clock-in from anywhere.
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }} className="project-geofence-row">
                  <input
                    style={{ ...pf.input, flex: '1 1 130px', minWidth: 0 }}
                    type="number" step="0.000001"
                    placeholder="Latitude"
                    value={editForm.geo_lat}
                    onChange={e => setEditForm(f => ({ ...f, geo_lat: e.target.value }))}
                  />
                  <input
                    style={{ ...pf.input, flex: '1 1 130px', minWidth: 0 }}
                    type="number" step="0.000001"
                    placeholder="Longitude"
                    value={editForm.geo_lng}
                    onChange={e => setEditForm(f => ({ ...f, geo_lng: e.target.value }))}
                  />
                  <input
                    style={{ ...pf.input, flex: '1 1 110px', minWidth: 0 }}
                    type="number" min="50" step="50"
                    placeholder="Radius (ft)"
                    value={editForm.geo_radius_ft}
                    onChange={e => setEditForm(f => ({ ...f, geo_radius_ft: e.target.value }))}
                  />
                  <button
                    type="button"
                    style={{
                      background: '#eef2ff', border: '1px solid #c7d2fe', color: '#4338ca',
                      padding: '8px 12px', borderRadius: 7, fontSize: 13, fontWeight: 600,
                      cursor: geoLocating ? 'wait' : 'pointer',
                      opacity: geoLocating ? 0.6 : 1, whiteSpace: 'nowrap',
                    }}
                    onClick={useMyLocation}
                    disabled={geoLocating}
                  >
                    {geoLocating ? 'Locating…' : 'Use my location'}
                  </button>
                  {(editForm.geo_lat || editForm.geo_lng || editForm.geo_radius_ft) && (
                    <button
                      type="button"
                      style={{
                        background: 'none', border: 'none', color: '#6b7280',
                        fontSize: 13, cursor: 'pointer', padding: '8px 4px', whiteSpace: 'nowrap',
                      }}
                      onClick={() => setEditForm(f => ({ ...f, geo_lat: '', geo_lng: '', geo_radius_ft: '' }))}
                    >
                      ✕ Clear
                    </button>
                  )}
                </div>
                {geoError && <p style={{ fontSize: 12, color: '#dc2626', margin: '6px 0 0' }}>{geoError}</p>}
              </div>

              {editMsg && (
                <p style={{ fontSize: 13, margin: 0, color: editMsg === 'Saved' || editMsg.includes('complete') ? '#059669' : '#dc2626', fontWeight: 600 }}>{editMsg}</p>
              )}

              <div style={pf.actions} className="project-form-actions">
                <button style={pf.saveBtn} onClick={handleEditSave} disabled={editSaving || !editForm.name.trim()}>
                  {editSaving ? t.saving : t.saveChanges}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Per-Project Visibility ──────────────────────────────────────────────────
//
// Controls who sees this project in their Time Clock dropdown. Styled to
// match the overview tab's other panels (budgetSection look). Collapsed by
// default; header is clickable. Empty selection = visible to everyone.

function ProjectVisibility({ project, onProjectUpdated, toggleStyle, countStyle, workLabel = 'Project', workerLabel = 'Worker' }) {
  const t = useT();
  const workerLabelPlural = plural(workerLabel);
  const workLabelLower = workLabel.toLowerCase();
  const workerLabelLower = workerLabel.toLowerCase();
  const workerLabelPluralLower = workerLabelPlural.toLowerCase();
  const [open, setOpen] = useState(false);
  const [workers, setWorkers] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(() => new Set(project.visible_to_user_ids || []));

  useEffect(() => {
    setSelected(new Set(project.visible_to_user_ids || []));
  }, [project.id, project.visible_to_user_ids]);

  useEffect(() => {
    if (!open || workers !== null) return;
    setLoading(true);
    api.get('/admin/workers')
      .then(r => setWorkers(r.data.filter(w => w.role === 'worker')))
      .catch(() => setError('Could not load workers'))
      .finally(() => setLoading(false));
  }, [open, workers]);

  const toggleWorker = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setSaved(false);
  };
  const clearAll = () => { setSelected(new Set()); setSaved(false); };
  const selectAll = () => {
    if (!workers) return;
    setSelected(new Set(workers.map(w => w.id)));
    setSaved(false);
  };

  const save = async () => {
    setSaving(true); setError('');
    try {
      const ids = selected.size > 0 ? Array.from(selected) : null;
      const r = await api.patch(`/admin/projects/${project.id}`, { visible_to_user_ids: ids });
      onProjectUpdated?.(r.data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const restricted = selected.size > 0;

  return (
    <div style={{ marginBottom: 16 }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={toggleStyle}
      >
        <span>Visibility</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {restricted && (
            <span style={{ ...countStyle, background: '#3b82f6' }}>
              {selected.size} {selected.size === 1 ? workerLabelLower : workerLabelPluralLower}
            </span>
          )}
          {!restricted && <span style={countStyle}>Everyone</span>}
          <span style={{ fontSize: 12, color: '#6b7280' }}>{open ? '▴' : '▾'}</span>
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 12px' }}>
            Choose which {workerLabelPluralLower} see this {workLabelLower} in their Time Clock dropdown. Leave empty to make it visible to
            everyone. Admins always see every {workLabelLower} regardless of this setting.
          </p>
          {loading && <p style={{ fontSize: 13, color: '#6b7280' }}>{t.ppLoadingWorkers}</p>}
          {workers && workers.length === 0 && <p style={{ fontSize: 13, color: '#6b7280' }}>{t.ppNoWorkersYet}</p>}
          {workers && workers.length > 0 && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                <button type="button" style={pvStyles.linkBtn} onClick={selectAll}>{t.ppSelectAllBtn}</button>
                <button type="button" style={pvStyles.linkBtn} onClick={clearAll}>Clear (visible to all)</button>
                <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 'auto' }}>{selected.size} / {workers.length} selected</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {workers.map(w => {
                  const on = selected.has(w.id);
                  return (
                    <label
                      key={w.id}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        padding: '6px 12px', borderRadius: 20, fontSize: 13, cursor: 'pointer',
                        background: on ? '#dbeafe' : '#fff',
                        border: `1px solid ${on ? '#60a5fa' : '#e5e7eb'}`,
                        color: on ? '#1e40af' : '#374151',
                        fontWeight: on ? 600 : 500,
                      }}
                    >
                      <input type="checkbox" checked={on} onChange={() => toggleWorker(w.id)} style={{ margin: 0 }} />
                      {w.full_name}
                    </label>
                  );
                })}
              </div>
              {error && <p role="alert" style={{ color: '#991b1b', fontSize: 13, marginTop: 8 }}>{error}</p>}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
                {saved && <span style={{ fontSize: 13, color: '#059669', fontWeight: 600 }}>✓ Saved</span>}
                <button
                  type="button"
                  onClick={save}
                  disabled={saving}
                  style={{ padding: '7px 16px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.55 : 1 }}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const pvStyles = {
  linkBtn: { background: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '4px 10px', fontSize: 12, fontWeight: 600, color: '#374151', cursor: 'pointer' },
};

// ── Project Row (list view) ───────────────────────────────────────────────────

function ProjectRow({ project, metrics, settings, onClick }) {
  const t = useT();
  const m = metrics || {};
  const workerLabel = settings?.label_worker || 'Team Member';
  const workerLabelPlural = plural(workerLabel);
  const totalHours = parseFloat(m.total_hours || 0);
  const fmtHours = h => { const n = parseFloat(h); return isNaN(n) || n === 0 ? '0h' : n % 1 === 0 ? `${n}h` : `${n.toFixed(1)}h`; };
  const statusColors = { planning: '#dbeafe|#1d4ed8', in_progress: '#d1fae5|#065f46', on_hold: '#fef3c7|#92400e', completed: '#e5e7eb|#374151' };
  const [statusBg, statusFg] = (statusColors[project.status] || '#f3f4f6|#6b7280').split('|');
  const statusLabel = { planning: t.statusPlanning, in_progress: t.statusInProgress, on_hold: t.statusOnHold, completed: t.statusCompleted }[project.status];
  const budgetHours = parseFloat(project.budget_hours || 0);
  const hoursUsedPct = budgetHours > 0 ? Math.min(100, (totalHours / budgetHours) * 100) : 0;
  const hourColor = hoursUsedPct >= 100 ? '#ef4444' : hoursUsedPct >= 85 ? '#f59e0b' : '#059669';

  return (
    <div style={styles.row} onClick={onClick} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onClick()}>
      <div style={styles.rowLeft}>
        <span style={styles.rowName}>{project.name}</span>
        {project.client_name && <span style={styles.rowClient}>{project.client_name}{project.job_number ? ` · ${project.job_number}` : ''}</span>}
      </div>
      <div style={styles.rowRight}>
        {statusLabel && <span style={{ fontSize: 10, fontWeight: 700, background: statusBg, color: statusFg, padding: '2px 7px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>{statusLabel}</span>}
        {budgetHours > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <div style={{ width: 60, height: 5, background: '#f3f4f6', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${hoursUsedPct}%`, background: hourColor, borderRadius: 3 }} />
            </div>
            <span style={{ fontSize: 12, color: hourColor, fontWeight: 600 }}>{fmtHours(totalHours)}/{fmtHours(budgetHours)}</span>
          </div>
        )}
        {budgetHours === 0 && totalHours > 0 && <span style={{ fontSize: 12, color: '#6b7280', flexShrink: 0 }}>{fmtHours(totalHours)}</span>}
        <span style={{ fontSize: 12, color: '#6b7280', flexShrink: 0 }}>{parseInt(m.worker_count || 0)} {(parseInt(m.worker_count || 0) === 1 ? workerLabel : workerLabelPlural).toLowerCase()}</span>
        {project.active === false && <span style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>{t.archivedLabel}</span>}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

const BLANK_PROJECT = { name: '', client_id: '', job_number: '', address: '', start_date: '', end_date: '', status: 'in_progress', description: '', wage_type: 'regular', geo_lat: '', geo_lng: '', geo_radius_ft: '' };

// Default geofence radius (in feet) when the address-based auto-fill kicks in.
// 300 ft is large enough that GPS jitter on a phone won't false-reject a
// person who's actually at the work location, small enough that it's a meaningful
// gate for typical service, field, or facilities work.
const DEFAULT_GEOFENCE_RADIUS_FT = 300;

// Geocode an address via the server proxy. Returns { lat, lng, display_name }
// on a hit, null on a miss or any error. Designed to be called from a blur
// handler — failures must be silent so they don't block the form.
async function geocodeAddress(addr) {
  const trimmed = String(addr || '').trim();
  if (trimmed.length < 5) return null;
  try {
    const r = await api.get('/admin/geocode', { params: { q: trimmed } });
    return r.data;
  } catch {
    return null;
  }
}

function ProjectCreateForm({ clients, settings, onSaved, onCancel, onClientCreated }) {
  const t = useT();
  const [form, setForm] = useState(BLANK_PROJECT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [quickClientOpen, setQuickClientOpen] = useState(false);
  const [quickClientName, setQuickClientName] = useState('');
  const [quickClientSaving, setQuickClientSaving] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [geoLocating, setGeoLocating] = useState(false);
  const [geoError, setGeoError] = useState('');
  // Warn on tab-close while a half-filled new-project form is open;
  // cleared on a successful save just before the parent unmounts us.
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);
  const set = (k, v) => { setDirty(true); setForm(f => ({ ...f, [k]: v })); };
  const showPrevailing = (settings?.prevailing_wage_rate ?? 0) > 0;
  const workLabel = settings?.label_work || 'Project';
  const workLabelLower = workLabel.toLowerCase();
  const clientLabel = settings?.label_client || 'Customer';
  const clientLabelLower = clientLabel.toLowerCase();
  const workerLabel = settings?.label_worker || 'Team Member';

  // When the address loses focus, try to fill the geofence from it — but
  // only if the user hasn't already entered any geofence values manually.
  // Silent on failure: if geocoding misses, the form is still valid and
  // the admin can keep typing.
  const tryAutoGeocode = async () => {
    if (!form.address.trim()) return;
    if (form.geo_lat || form.geo_lng || form.geo_radius_ft) return;
    setGeocoding(true);
    const geo = await geocodeAddress(form.address);
    setGeocoding(false);
    if (geo) {
      setForm(f => ({
        ...f,
        geo_lat: geo.lat.toFixed(6),
        geo_lng: geo.lng.toFixed(6),
        geo_radius_ft: String(DEFAULT_GEOFENCE_RADIUS_FT),
      }));
    }
  };

  const useMyLocationCreate = () => {
    if (!navigator.geolocation) {
      setGeoError("Your browser doesn't support geolocation.");
      return;
    }
    setGeoLocating(true); setGeoError('');
    navigator.geolocation.getCurrentPosition(
      pos => {
        setDirty(true);
        setForm(f => ({
          ...f,
          geo_lat: pos.coords.latitude.toFixed(6),
          geo_lng: pos.coords.longitude.toFixed(6),
          geo_radius_ft: f.geo_radius_ft || String(DEFAULT_GEOFENCE_RADIUS_FT),
        }));
        setGeoLocating(false);
      },
      err => {
        setGeoError(err.code === 1 ? 'Location permission denied.' : "Couldn't get your location.");
        setGeoLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  const handleQuickClientCreate = async () => {
    const name = quickClientName.trim();
    if (!name) {
      setError(`${clientLabel} name is required.`);
      return;
    }
    setQuickClientSaving(true); setError('');
    try {
      const r = await api.post('/admin/clients', { name });
      onClientCreated?.(r.data);
      set('client_id', String(r.data.id));
      setQuickClientName('');
      setQuickClientOpen(false);
    } catch (err) {
      setError(err.response?.data?.error || `Failed to add ${clientLabelLower}.`);
    } finally {
      setQuickClientSaving(false);
    }
  };

  const handleSubmit = async e => {
    e.preventDefault();
    if (!form.name.trim()) { setError(`${workLabel} name is required.`); return; }
    // Geofence: enforce all-or-none on the client too so the server's
    // friendlier 400 doesn't surprise an admin mid-create.
    const lat = form.geo_lat.trim();
    const lng = form.geo_lng.trim();
    const radius = form.geo_radius_ft.trim();
    const geoCount = [lat, lng, radius].filter(Boolean).length;
    if (geoCount > 0 && geoCount < 3) {
      setError('Geofence needs latitude, longitude, AND radius — or leave all three blank.');
      return;
    }
    setSaving(true); setError('');
    try {
      const r = await api.post('/admin/projects', {
        ...form,
        client_id: form.client_id || null,
        prevailing_wage_rate: form.wage_type === 'prevailing' && settings?.prevailing_wage_rate ? settings.prevailing_wage_rate : null,
        geo_lat:        geoCount === 3 ? parseFloat(lat) : null,
        geo_lng:        geoCount === 3 ? parseFloat(lng) : null,
        geo_radius_ft:  geoCount === 3 ? parseInt(radius, 10) : null,
      });
      setDirty(false);
      onSaved(r.data);
    } catch (err) {
      setError(err.response?.data?.error || t.failedCreateProject);
    } finally { setSaving(false); }
  };

  return (
    <div style={pf.card} className="project-create-card">
      <h3 style={pf.title}>New {workLabel}</h3>
      <form onSubmit={handleSubmit} style={pf.form}>
        <div style={pf.row} className="project-form-grid">
          <div style={pf.field}>
            <label style={pf.label}>{workLabel} name *</label>
            <input style={pf.input} value={form.name} onChange={e => set('name', e.target.value)} placeholder={`${workLabel} name`} required autoFocus />
          </div>
          <div style={pf.field}>
            <label style={pf.label}>{t.jobNumberLabel}</label>
            <input style={pf.input} value={form.job_number} onChange={e => set('job_number', e.target.value)} placeholder={t.jobNumberPlaceholder} />
          </div>
        </div>

        <div style={pf.row} className="project-form-grid">
          <div style={pf.field}>
            <div style={pf.labelRow}>
              <label style={pf.label}>{clientLabel}</label>
              <button
                type="button"
                style={pf.linkBtn}
                onClick={() => {
                  setQuickClientOpen(open => !open);
                  setError('');
                }}
              >
                {quickClientOpen ? 'Use existing' : `+ Quick add ${clientLabelLower}`}
              </button>
            </div>
            {quickClientOpen ? (
              <div style={pf.quickAddBox} className="project-quick-add-box">
                <input
                  style={pf.input}
                  value={quickClientName}
                  onChange={e => setQuickClientName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleQuickClientCreate();
                    }
                  }}
                  placeholder={`${clientLabel} name`}
                />
                <button
                  type="button"
                  style={{ ...pf.quickAddBtn, ...(quickClientSaving || !quickClientName.trim() ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                  onClick={handleQuickClientCreate}
                  disabled={quickClientSaving || !quickClientName.trim()}
                >
                  {quickClientSaving ? 'Adding...' : 'Add'}
                </button>
              </div>
            ) : (
              <select style={pf.input} value={form.client_id} onChange={e => set('client_id', e.target.value)}>
                <option value="">No {clientLabelLower}</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
          </div>
          <div style={pf.field}>
            <label style={pf.label}>{t.status}</label>
            <select style={pf.input} value={form.status} onChange={e => set('status', e.target.value)}>
              <option value="planning">{t.statusPlanning}</option>
              <option value="in_progress">{t.statusInProgress}</option>
              <option value="on_hold">{t.statusOnHold}</option>
              <option value="completed">{t.statusCompleted}</option>
            </select>
          </div>
        </div>

        <div style={pf.field}>
          <label style={pf.label}>
            {t.addressLocation}
            {geocoding && <span style={{ fontWeight: 400, color: '#6b7280', marginLeft: 8, fontSize: 12 }}>· Looking up address…</span>}
          </label>
          <input
            style={pf.input}
            value={form.address}
            onChange={e => set('address', e.target.value)}
            onBlur={tryAutoGeocode}
            placeholder={t.adminAddressPh}
          />
        </div>

        {/* Geofence — auto-filled from the address blur above when blank.
            Visible always; admins can also tap "Use my location" or paste
            coordinates manually. Server enforces all-or-none. */}
        <div style={pf.field}>
          <label style={pf.label}>📍 Geofence (optional)</label>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8, lineHeight: 1.5 }}>
            Require {plural(workerLabel).toLowerCase()} to be physically near the work location to clock in.
            Leave all three fields blank to allow clock-in from anywhere.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }} className="project-geofence-row">
            <input
              style={{ ...pf.input, flex: '1 1 130px', minWidth: 0 }}
              type="number" step="0.000001"
              placeholder="Latitude"
              value={form.geo_lat}
              onChange={e => set('geo_lat', e.target.value)}
            />
            <input
              style={{ ...pf.input, flex: '1 1 130px', minWidth: 0 }}
              type="number" step="0.000001"
              placeholder="Longitude"
              value={form.geo_lng}
              onChange={e => set('geo_lng', e.target.value)}
            />
            <input
              style={{ ...pf.input, flex: '1 1 110px', minWidth: 0 }}
              type="number" min="50" step="50"
              placeholder="Radius (ft)"
              value={form.geo_radius_ft}
              onChange={e => set('geo_radius_ft', e.target.value)}
            />
            <button
              type="button"
              style={{
                background: '#eef2ff', border: '1px solid #c7d2fe', color: '#4338ca',
                padding: '8px 12px', borderRadius: 7, fontSize: 13, fontWeight: 600,
                cursor: geoLocating ? 'wait' : 'pointer',
                opacity: geoLocating ? 0.6 : 1, whiteSpace: 'nowrap',
              }}
              onClick={useMyLocationCreate}
              disabled={geoLocating}
            >
              {geoLocating ? 'Locating…' : 'Use my location'}
            </button>
            {(form.geo_lat || form.geo_lng || form.geo_radius_ft) && (
              <button
                type="button"
                style={{
                  background: 'none', border: 'none', color: '#6b7280',
                  fontSize: 13, cursor: 'pointer', padding: '8px 4px', whiteSpace: 'nowrap',
                }}
                onClick={() => { setDirty(true); setForm(f => ({ ...f, geo_lat: '', geo_lng: '', geo_radius_ft: '' })); }}
              >
                ✕ Clear
              </button>
            )}
          </div>
          {geoError && <p style={{ fontSize: 12, color: '#dc2626', margin: '6px 0 0' }}>{geoError}</p>}
        </div>

        <div style={pf.row} className="project-form-grid">
          <div style={pf.field}>
            <label style={pf.label}>{t.startDate}</label>
            <input style={pf.input} type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} />
          </div>
          <div style={pf.field}>
            <label style={pf.label}>{t.endDate}</label>
            <input style={pf.input} type="date" value={form.end_date} onChange={e => set('end_date', e.target.value)} />
          </div>
          {showPrevailing && (
            <div style={pf.field}>
              <label style={pf.label}>{t.wageType}</label>
              <select style={pf.input} value={form.wage_type} onChange={e => set('wage_type', e.target.value)}>
                <option value="regular">{t.regular}</option>
                <option value="prevailing">{t.prevailing}</option>
              </select>
            </div>
          )}
        </div>

        <div style={pf.field}>
          <label style={pf.label}>{t.descriptionLabel} <span style={{ fontWeight: 400, color: '#6b7280' }}>{t.optionalHint}</span></label>
          <textarea style={pf.textarea} rows={2} value={form.description} onChange={e => set('description', e.target.value)} placeholder={`Notes or scope for this ${workLabelLower}`} />
        </div>

        {error && <p style={pf.error}>{error}</p>}

        <div style={pf.actions} className="project-form-actions">
          <button style={pf.saveBtn} type="submit" disabled={saving}>{saving ? t.creating : `Create ${workLabel}`}</button>
          <button style={pf.cancelBtn} type="button" onClick={onCancel}>{t.cancel}</button>
        </div>
      </form>
    </div>
  );
}

// Sales (Estimates + Change Orders) lives as tabs inside the Projects module.
// Reuse the perms the standalone Sales module used so these tabs only show for
// users who could see Sales before the consolidation.
const SALES_TAB_PERMS = ['manage_projects', 'manage_settings'];
const PROJECT_TAB_IDS = ['projects', 'estimates', 'change_orders', 'pos'];

export default function ProjectsPage() {
  const { user } = useAuth();
  const t = useT();
  const hasSalesPerm = useHasAnyPerm(SALES_TAB_PERMS);
  // Tab can be deep-linked via the URL hash (e.g. /projects#estimates), which
  // is how the retired /sales and /change-orders routes land here.
  const [mainTab, setMainTab] = useState(() => {
    const h = (window.location.hash || '').replace('#', '');
    return PROJECT_TAB_IDS.includes(h) ? h : 'projects';
  });
  useEffect(() => {
    const syncTabFromHash = () => {
      const h = (window.location.hash || '').replace('#', '');
      setMainTab(PROJECT_TAB_IDS.includes(h) ? h : 'projects');
    };
    window.addEventListener('hashchange', syncTabFromHash);
    return () => window.removeEventListener('hashchange', syncTabFromHash);
  }, []);
  const changeTab = (id) => {
    setMainTab(id);
    try { window.history.replaceState(null, '', id === 'projects' ? window.location.pathname : `#${id}`); } catch { /* ignore */ }
  };
  const [projects, setProjects] = useState([]);
  const [metrics, setMetrics] = useState({});
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState(null);
  const [features, setFeatures] = useState({});
  const [showArchived, setShowArchived] = useState(false);
  const [companyInfo, setCompanyInfo] = useState({});
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [clients, setClients] = useState([]);
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('opsfloa_projects_view') || 'grid');

  const loadProjects = (archived) => {
    setLoading(true);
    Promise.all([
      api.get('/admin/projects', { params: archived ? { include_archived: 'true' } : {} }),
      api.get('/admin/projects/metrics'),
      api.get('/settings'),
      api.get('/company-info'),
    ]).then(([pRes, mRes, sRes, ciRes]) => {
      setProjects(pRes.data);
      const metricsMap = {};
      mRes.data.forEach(m => { metricsMap[m.id] = m; });
      setMetrics(metricsMap);
      setSettings(sRes.data);
      setFeatures(sRes.data);
      setCompanyInfo(ciRes.data || {});
    }).catch(() => setLoadError(true)).finally(() => setLoading(false));
  };

  useEffect(() => { loadProjects(showArchived); }, [showArchived]);

  useEffect(() => {
    // Customers are managed in the Directory module now, but the project create
    // form still needs the list to assign one.
    if (showCreateForm) {
      api.get('/admin/clients').then(r => setClients(r.data)).catch(silentError('clients list'));
    }
  }, [showCreateForm]);

  const activeProjects = projects.filter(p => p.active).length;
  const totalHours = Object.values(metrics).reduce((s, m) => s + parseFloat(m.total_hours || 0), 0);
  const workLabel = settings?.label_work || 'Project';
  const workLabelLower = workLabel.toLowerCase();
  const workLabelPlural = plural(workLabel);

  // Estimates/Change Orders and sub Purchase Orders are part of the Projects
  // module — not separately toggleable. They show to admins who can manage
  // project work; the Projects module itself is gated upstream (route + switcher).
  const canSeeSales = hasSalesPerm;
  const canSeePOs = hasSalesPerm;
  // Fall back to Projects if a gated tab is deep-linked by someone without access.
  const tabAllowed = (id) => {
    if (id === 'estimates' || id === 'change_orders') return canSeeSales;
    if (id === 'pos') return canSeePOs;
    return true;
  };
  const activeTab = tabAllowed(mainTab) ? mainTab : 'projects';

  const tabs = [
    { id: 'projects', label: workLabelPlural },
    ...(canSeeSales ? [
      { id: 'estimates', label: t.estList },
      { id: 'change_orders', label: t.coList },
    ] : []),
    ...(canSeePOs ? [{ id: 'pos', label: t.subPurchaseOrders }] : []),
  ];

  return (
    <div style={styles.page}>
      <AppHeader currentApp="projects" features={features} />

      <main id="main-content" style={styles.main}>
        <TabBar
          active={activeTab}
          onChange={changeTab}
          tabs={tabs}
          breakpoint={520}
        />

        {activeTab === 'estimates' && (
          <div style={{ marginTop: 24 }}>
            <EstimatesPanel />
          </div>
        )}

        {activeTab === 'change_orders' && (
          <div style={{ marginTop: 24 }}>
            <ChangeOrdersPanel />
          </div>
        )}

        {activeTab === 'pos' && (
          <div style={{ marginTop: 24 }}>
            <SubPOsPanel />
          </div>
        )}

        {activeTab === 'projects' && (
          <>
            <div style={styles.pageHeader} className="projects-page-header">
              <div style={styles.pageHeaderRow} className="projects-page-header-row">
                <div style={styles.pageHeaderCopy}>
                  <h1 style={styles.pageTitle}>{workLabelPlural}</h1>
                  <p style={styles.pageSub}>
                    {loading
                      ? `${t.prjLoadingPrefix} ${workLabelPlural.toLowerCase()}...`
                      : `${activeProjects} ${t.prjActiveLabel} ${activeProjects === 1 ? workLabelLower : workLabelPlural.toLowerCase()}${totalHours > 0 ? ` - ${totalHours.toFixed(0)} ${t.prjTotalHoursSuffix}` : ''}`}
                  </p>
                </div>
                <div style={styles.pageHeaderControls} className="projects-page-header-controls">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: '#6b7280', cursor: 'pointer' }}>
                    <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} style={{ cursor: 'pointer' }} />
                    {t.prjShowArchived}
                  </label>
                  <div style={styles.viewToggle}>
                    <button
                      style={{ ...styles.viewToggleBtn, ...(viewMode === 'grid' ? styles.viewToggleBtnActive : {}) }}
                      title={t.ppGridViewTitle}
                      onClick={() => { setViewMode('grid'); localStorage.setItem('opsfloa_projects_view', 'grid'); }}
                    >⊞</button>
                    <button
                      style={{ ...styles.viewToggleBtn, ...(viewMode === 'list' ? styles.viewToggleBtnActive : {}) }}
                      title={t.ppListViewTitle}
                      onClick={() => { setViewMode('list'); localStorage.setItem('opsfloa_projects_view', 'list'); }}
                    >☰</button>
                  </div>
                  {!showCreateForm && (
                    <button style={styles.newProjectBtn} className="projects-new-btn" onClick={() => setShowCreateForm(true)}>
                      + New {workLabel}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {showCreateForm && (
              <ProjectCreateForm
                clients={clients}
                settings={settings}
                onClientCreated={client => {
                  setClients(prev => [...prev, client].sort((a, b) => a.name.localeCompare(b.name)));
                }}
                onSaved={p => {
                  setProjects(prev => [...prev, p]);
                  setShowCreateForm(false);
                }}
                onCancel={() => setShowCreateForm(false)}
              />
            )}

            {!loading && projects.length >= 500 && (
              <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '8px 14px', marginBottom: 12, fontSize: 13, color: '#92400e' }}>
                Showing the first 500 {workLabelPlural.toLowerCase()}. Use search or filters to find others.
              </div>
            )}
            {loading ? (
              <SkeletonList count={5} rows={3} />
            ) : loadError ? (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '16px 20px', color: '#991b1b', fontSize: 14 }}>
                Failed to load {workLabelPlural.toLowerCase()}.{' '}
                <button style={{ background: 'none', border: 'none', color: 'var(--ops-page-accent)', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline', padding: 0 }} onClick={() => { setLoadError(false); loadProjects(showArchived); }}>{t.ppTryAgainLink}</button>
              </div>
            ) : projects.length === 0 ? (
              <EmptyState
                mark="W"
                title={`No ${settings?.label_work?.toLowerCase() || 'project'} yet`}
                body={`Create your first ${settings?.label_work?.toLowerCase() || 'work item'} so time, notes, billing, and reports have somewhere to land.`}
                actionLabel={`Add ${settings?.label_work || 'Project'}`}
                onAction={() => setShowCreateForm(true)}
              />
            ) : viewMode === 'grid' ? (
              <div style={styles.grid}>
                {projects.map(p => (
                  <ProjectCard
                    key={p.id}
                    project={p}
                    metrics={metrics[p.id]}
                    settings={settings}
                    onClick={() => setSelected(p)}
                  />
                ))}
              </div>
            ) : (
              <div style={styles.rowList}>
                {projects.map(p => (
                  <ProjectRow
                    key={p.id}
                    project={p}
                    metrics={metrics[p.id]}
                    settings={settings}
                    onClick={() => setSelected(p)}
                  />
                ))}
              </div>
            )}

            {selected && (
              <ProjectDetail
                project={selected}
                metrics={metrics[selected.id]}
                settings={settings}
                companyInfo={companyInfo}
                onClose={() => setSelected(null)}
                onProjectUpdated={updated => {
                  setProjects(prev => prev.map(p => p.id === updated.id ? { ...p, ...updated } : p));
                  setSelected(updated);
                }}
                onProjectArchived={archivedId => {
                  setProjects(prev => showArchived
                    ? prev.map(p => p.id === archivedId ? { ...p, active: false } : p)
                    : prev.filter(p => p.id !== archivedId));
                  setSelected(null);
                }}
              />
            )}
          </>
        )}

      </main>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  page: { minHeight: '100vh', background: '#f4f6f9', display: 'flex', flexDirection: 'column', '--ops-page-accent': '#7c3aed' },
  header: { background: '#8b5cf6', color: '#fff', padding: '0 24px', paddingTop: 'env(safe-area-inset-top)', paddingBottom: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', position: 'sticky', top: 0, zIndex: 100, minHeight: 'calc(56px + env(safe-area-inset-top))' },
  headerTopRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', height: 56 },
  logoGroup: { display: 'flex', alignItems: 'center', gap: 10 },
  companyName: { fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)' },
  headerRight: { display: 'flex', gap: 12, alignItems: 'center' },
  headerBtn: { background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', padding: '6px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  main: { flex: 1, padding: '18px 20px 24px', maxWidth: 1100, margin: '0 auto', width: '100%' },
  pageHeader: { marginBottom: 24 },
  pageHeaderRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, minWidth: 0 },
  pageHeaderCopy: { minWidth: 0, flex: '1 1 auto' },
  pageHeaderControls: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, marginTop: 4, flexWrap: 'wrap', flexShrink: 0 },
  pageTitle: { fontSize: 28, fontWeight: 800, color: '#111827', margin: 0 },
  pageSub: { fontSize: 14, color: '#6b7280', margin: '4px 0 0' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 },
  // Card
  card: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '18px 20px', boxShadow: '0 1px 4px rgba(15,23,42,0.04)', cursor: 'pointer', transition: 'box-shadow 0.15s, transform 0.15s' },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 },
  cardName: { fontSize: 16, fontWeight: 700, color: '#111827', lineHeight: 1.3 },
  cardBadge: { fontSize: 11, fontWeight: 700, background: '#f1f5f9', color: '#475569', padding: '2px 8px', borderRadius: 10, flexShrink: 0, marginLeft: 8 },
  statsRow: { display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 },
  statItem: {},
  statValue: { fontSize: 20, fontWeight: 800, color: '#111827' },
  statLabel: { fontSize: 11, color: '#6b7280', marginTop: 1 },
  progressWrap: { marginTop: 8 },
  progressBar: { height: 6, background: '#f3f4f6', borderRadius: 3, overflow: 'hidden', marginBottom: 4 },
  progressFill: { height: '100%', borderRadius: 3, transition: 'width 0.3s' },
  progressLabel: { fontSize: 11, fontWeight: 600 },
  // Loading / empty
  loadingText: { color: '#6b7280', fontSize: 14, marginTop: 20 },
  emptyText: { color: '#6b7280', fontSize: 15 },
  // Detail panel
  detailOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 500, display: 'flex', justifyContent: 'flex-end' },
  detailPanel: { width: '100%', maxWidth: 480, background: '#fff', height: '100%', display: 'flex', flexDirection: 'column', boxShadow: '-4px 0 24px rgba(0,0,0,0.12)' },
  detailHeader: { padding: '20px 20px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid #f3f4f6', paddingBottom: 16 },
  detailTitle: { fontSize: 20, fontWeight: 800, color: '#111827', margin: 0 },
  detailSub: { fontSize: 13, color: '#6b7280', margin: '4px 0 0' },
  closeBtn: { background: '#f3f4f6', border: 'none', borderRadius: 20, width: 32, height: 32, cursor: 'pointer', fontSize: 14, color: '#6b7280', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  detailTabs: { display: 'flex', gap: 4, margin: '0 20px 12px', padding: 4, border: '1px solid #e2e8f0', borderRadius: 10, background: '#eef2f7', overflowX: 'auto' },
  detailTab: { flex: '1 0 auto', minHeight: 36, padding: '0 14px', border: 'none', borderRadius: 8, background: 'transparent', fontSize: 13, fontWeight: 800, color: '#64748b', cursor: 'pointer', whiteSpace: 'nowrap' },
  detailTabActive: { color: 'var(--ops-page-accent)', background: '#fff', boxShadow: '0 1px 5px rgba(15,23,42,0.08)' },
  detailBody: { flex: 1, overflowY: 'auto', padding: 20 },
  metricsGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 },
  metricCard: { background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px 14px' },
  metricValue: { fontSize: 22, fontWeight: 800, color: '#111827' },
  metricLabel: { fontSize: 11, color: '#6b7280', marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.04em' },
  budgetSection: { background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, padding: '14px 16px', marginBottom: 16 },
  sectionTitle: { fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#6b7280', marginBottom: 10 },
  budgetRow: { display: 'flex', justifyContent: 'space-between', marginBottom: 6 },
  budgetLabel: { fontSize: 13, color: '#6b7280' },
  budgetValue: { fontSize: 13, fontWeight: 700, color: '#111827' },
  tagRow: { display: 'flex', gap: 6, marginTop: 10 },
  wageTag: { fontSize: 11, fontWeight: 600, background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: 10 },
  // Billing
  billFilterRow: { display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 4 },
  filterLabel: { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' },
  filterInput: { padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, background: '#fff' },
  generateBtn: { background: '#8b5cf6', color: '#fff', border: 'none', padding: '9px 18px', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer', alignSelf: 'flex-end' },
  pdfLink: { display: 'inline-block', marginTop: 16, background: '#eff6ff', color: 'var(--ops-page-accent)', border: '1px solid #bfdbfe', padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 700, textDecoration: 'none', cursor: 'pointer' },
  qboBtn: { display: 'inline-block', marginTop: 16, background: '#2CA01C', color: '#fff', border: 'none', padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  qboPicker: { marginTop: 12, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 14px' },
  qboPickerLabel: { fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 8 },
  qboSelect: { padding: '7px 10px', border: '1px solid #ddd', borderRadius: 6, fontSize: 13, minWidth: 200 },
  qboConfirmBtn: { background: '#2CA01C', color: '#fff', border: 'none', borderRadius: 6, padding: '7px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  qboCancelBtn: { background: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '7px 14px', fontSize: 13, cursor: 'pointer', color: '#6b7280' },
  qboResult: { marginTop: 10, fontSize: 13, padding: '10px 14px', borderRadius: 8, border: '1px solid', color: '#374151' },
  invoiceHistory: { marginTop: 16, borderTop: '1px solid #e5e7eb', paddingTop: 14 },
  invoiceHistoryTitle: { fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8 },
  invoiceRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid #f3f4f6', flexWrap: 'wrap' },
  invoiceNum: { fontSize: 13, fontWeight: 600, color: '#111827', minWidth: 70 },
  invoiceAmt: { fontSize: 13, fontWeight: 700, color: '#111827', minWidth: 80 },
  invoiceDate: { fontSize: 12, color: '#6b7280', minWidth: 80 },
  invoiceStatus: { fontSize: 12, fontWeight: 600, flex: 1 },
  checkPaymentBtn: { padding: '4px 12px', background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12, fontWeight: 600, color: '#374151', cursor: 'pointer' },
  // Entries table
  entriesTable: { display: 'flex', flexDirection: 'column', gap: 2 },
  tableHeader: { display: 'flex', gap: 8, padding: '6px 10px', background: '#f9fafb', borderRadius: 6, marginBottom: 4 },
  tableRow: { display: 'flex', gap: 8, padding: '8px 10px', borderRadius: 6, fontSize: 13 },
  thDate: { flex: 1.2, fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' },
  thWorker: { flex: 2, fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' },
  thHours: { width: 50, textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' },
  tdDate: { flex: 1.2, color: '#6b7280' },
  tdWorker: { flex: 2, fontWeight: 600, color: '#111827' },
  tdHours: { width: 50, textAlign: 'right', fontWeight: 700, color: '#374151' },
  moreText: { fontSize: 12, color: '#6b7280', textAlign: 'center', marginTop: 8 },
  // Health
  healthRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 },
  healthChip: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: '#374151', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 20, padding: '4px 10px' },
  healthDot: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  // Activity
  activityToggle: { width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '9px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.06em' },
  activityCount: { fontSize: 11, fontWeight: 700, color: '#fff', background: '#9ca3af', padding: '1px 7px', borderRadius: 10 },
  activityList: { display: 'flex', flexDirection: 'column', gap: 1, marginTop: 6 },
  activityItem: { display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px', borderRadius: 7, background: '#fafafa', border: '1px solid #f3f4f6' },
  activityDot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0, marginTop: 4 },
  activityTitle: { display: 'flex', gap: 4, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 2 },
  activityTag: { fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 6, textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 },
  activityText: { fontSize: 13, color: '#111827', lineHeight: 1.4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' },
  activityMeta: { display: 'flex', gap: 4, alignItems: 'center', fontSize: 11, color: '#6b7280', flexWrap: 'wrap' },
  docRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 10px', borderRadius: 7, background: '#fafafa', border: '1px solid #f3f4f6', marginBottom: 4 },
  docName: { fontSize: 13, color: 'var(--ops-page-accent)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0, textDecoration: 'none' },
  docSize: { fontSize: 11, color: '#6b7280' },
  docDelete: { background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 14, padding: '2px 4px', lineHeight: 1 },
  docDeleteConfirm: { background: '#dc2626', color: '#fff', border: 'none', borderRadius: 5, padding: '2px 8px', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  docDeleteCancel: { background: '#e5e7eb', color: '#374151', border: 'none', borderRadius: 5, padding: '2px 8px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  uploadBtn: { display: 'inline-block', marginTop: 6, background: '#f3f4f6', border: '1px dashed #d1d5db', borderRadius: 7, padding: '7px 14px', fontSize: 12, fontWeight: 600, color: '#6b7280' },
  rfiForm: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, padding: '12px', background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' },
  rfiInput: { padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, background: '#fff', width: '100%', boxSizing: 'border-box' },
  rfiSubmitBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  rfiCancelBtn: { background: 'none', border: '1px solid #e5e7eb', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#6b7280', cursor: 'pointer' },
  photoGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: 4, marginTop: 6 },
  photoThumb: { width: '100%', aspectRatio: '1', padding: 0, border: 'none', background: '#f3f4f6', borderRadius: 6, cursor: 'pointer', overflow: 'hidden' },
  lightboxOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  lightboxContent: { position: 'relative', maxWidth: '90vw', textAlign: 'center', padding: 16 },
  lightboxClose: { position: 'absolute', top: -8, right: -8, background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', borderRadius: '50%', width: 28, height: 28, cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  // Tab bar
  tabBar: { display: 'flex', gap: 4, marginBottom: 24, background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 10, padding: 4 },
  tabBtn: { flex: 1, background: 'none', border: 'none', padding: '9px 16px', fontSize: 14, fontWeight: 700, color: '#64748b', cursor: 'pointer', borderRadius: 7, transition: 'color 0.15s, background 0.15s' },
  tabBtnActive: { color: 'var(--ops-page-accent)', background: '#fff', border: '1px solid #e2e8f0', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' },
      // New work button
  newProjectBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '9px 18px', borderRadius: 8, fontWeight: 800, fontSize: 13, cursor: 'pointer' },
  // View toggle
  viewToggle: { display: 'flex', border: '1px solid #cbd5e1', background: '#f8fafc', borderRadius: 7, overflow: 'hidden' },
  viewToggleBtn: { background: '#f8fafc', border: 'none', padding: '6px 10px', fontSize: 16, cursor: 'pointer', color: '#64748b', lineHeight: 1 },
  viewToggleBtnActive: { background: '#fff', color: 'var(--ops-page-accent)' },
  // List view
  rowList: { display: 'flex', flexDirection: 'column', gap: 2 },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, background: '#fff', borderRadius: 8, padding: '11px 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)', cursor: 'pointer', borderLeft: '3px solid #8b5cf6', transition: 'box-shadow 0.15s' },
  rowLeft: { display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0, flex: 1 },
  rowName: { fontSize: 14, fontWeight: 700, color: '#111827', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rowClient: { fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  rowRight: { display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 },
  finishBtn: { background: '#059669', color: '#fff', border: 'none', padding: '11px 20px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer', width: '100%' },
  archiveBox: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, border: '1px solid #fecaca', background: '#fff7f7', borderRadius: 10, padding: '12px 14px', flexWrap: 'wrap' },
  archiveTitle: { fontSize: 13, fontWeight: 800, color: '#991b1b' },
  archiveHint: { fontSize: 12, color: '#7f1d1d', marginTop: 2 },
  archiveActions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  archiveProjectBtn: { background: '#fff', color: '#991b1b', border: '1px solid #fecaca', padding: '8px 12px', borderRadius: 8, fontSize: 13, fontWeight: 800, cursor: 'pointer' },
  archiveConfirmBtn: { background: '#dc2626', color: '#fff', border: 'none', padding: '8px 12px', borderRadius: 8, fontSize: 13, fontWeight: 800, cursor: 'pointer' },
  archiveCancelBtn: { background: '#fff', color: '#374151', border: '1px solid #cbd5e1', padding: '8px 12px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' },
};

// ── Project Create Form Styles ─────────────────────────────────────────────────

const pf = {
  card: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '24px 28px', marginBottom: 24, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' },
  title: { fontSize: 18, fontWeight: 800, color: '#111827', margin: '0 0 20px' },
  form: { display: 'flex', flexDirection: 'column', gap: 16 },
  row: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 },
  field: { display: 'flex', flexDirection: 'column', gap: 4 },
  labelRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  label: { fontSize: 12, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' },
  linkBtn: { background: 'none', border: 'none', color: '#6d28d9', fontSize: 12, fontWeight: 800, cursor: 'pointer', padding: 0, whiteSpace: 'nowrap' },
  input: { padding: '9px 11px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 14, background: '#fff', color: '#111827', width: '100%', boxSizing: 'border-box' },
  quickAddBox: { display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, marginTop: 6 },
  quickAddBtn: { background: '#111827', color: '#fff', border: 'none', padding: '9px 14px', borderRadius: 7, fontSize: 13, fontWeight: 800, cursor: 'pointer' },
  textarea: { padding: '9px 11px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 14, background: '#fff', color: '#111827', resize: 'vertical', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' },
  actions: { display: 'flex', gap: 10, marginTop: 4 },
  saveBtn: { background: '#8b5cf6', color: '#fff', border: 'none', padding: '10px 24px', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  cancelBtn: { background: 'none', border: '1px solid #e5e7eb', padding: '10px 18px', borderRadius: 8, fontWeight: 600, fontSize: 14, color: '#6b7280', cursor: 'pointer' },
  error: { color: '#ef4444', fontSize: 13, margin: 0 },
};
