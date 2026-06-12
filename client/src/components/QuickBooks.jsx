import React, { useState, useEffect, useMemo } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { useToast } from '../contexts/ToastContext';
import { SkeletonList } from './Skeleton';
import { weekRange } from '../utils/weekBounds';

import { silentError } from '../errorReporter';
const VENDOR_TYPES = ['contractor', 'subcontractor'];
const EMPLOYEE_TYPES = ['employee', 'owner'];
const IMPORT_PAGE_SIZE = 15;
const MAP_PAGE_SIZE = 20;

// Wrapper for the shared helper: previous full week honoring weekStart (0-6).
function previousWeekRange(weekStart = 1) {
  return weekRange(weekStart, -1);
}

function CollapsibleSection({ title, badge, defaultOpen = false, storageKey, children }) {
  const storageFullKey = storageKey ? `qbo-section:${storageKey}` : null;
  const [open, setOpen] = useState(() => {
    if (!storageFullKey) return defaultOpen;
    try {
      const saved = localStorage.getItem(storageFullKey);
      if (saved === '1') return true;
      if (saved === '0') return false;
    } catch { /* localStorage disabled */ }
    return defaultOpen;
  });
  const toggle = () => {
    setOpen(prev => {
      const next = !prev;
      if (storageFullKey) {
        try { localStorage.setItem(storageFullKey, next ? '1' : '0'); } catch { /* no-op */ }
      }
      return next;
    });
  };
  return (
    <div style={styles.section}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          textAlign: 'left', minHeight: 'unset',
          marginBottom: open ? 12 : 0,
        }}
      >
        <span style={{ fontSize: 12, color: '#6b7280', width: 12, display: 'inline-block' }}>
          {open ? '▾' : '▸'}
        </span>
        <h3 style={{ ...styles.sectionTitle, margin: 0 }}>{title}</h3>
        {badge != null && <span style={styles.countBadge}>{badge}</span>}
      </button>
      {open && <div>{children}</div>}
    </div>
  );
}

function Paginator({ page, total, pageSize, onChange }) {
  const t = useT();
  if (total <= pageSize) return null;
  const totalPages = Math.ceil(total / pageSize);
  const start = page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, total);
  return (
    <div style={styles.paginator}>
      <button style={{ ...styles.pageBtn, ...(page === 0 ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} aria-label={t.prevPage} onClick={() => onChange(page - 1)} disabled={page === 0}>‹</button>
      <span style={styles.pageInfo}>{start}–{end} of {total}</span>
      <button style={{ ...styles.pageBtn, ...(page >= totalPages - 1 ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} aria-label={t.nextPage} onClick={() => onChange(page + 1)} disabled={page >= totalPages - 1}>›</button>
    </div>
  );
}

export default function QuickBooks({ workers, projects, onWorkersImported, onProjectsImported, settings, onSettingsChange }) {
  const t = useT();
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [qboEmployees, setQboEmployees] = useState([]);
  const [qboVendors, setQboVendors] = useState([]);
  const [qboCustomers, setQboCustomers] = useState([]);
  const [qboAccounts, setQboAccounts] = useState([]);
  const [qboClasses, setQboClasses] = useState([]);
  const [qboItems, setQboItems] = useState([]);
  const [syncErrors, setSyncErrors] = useState([]);
  const [loadingMappings, setLoadingMappings] = useState(false);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [clearingErrors, setClearingErrors] = useState(false);
  const [retryingErrors, setRetryingErrors] = useState(new Set());
  // Bulk expense push
  const [expFrom, setExpFrom] = useState(() => previousWeekRange(settings?.week_start).from);
  const [expTo, setExpTo] = useState(() => previousWeekRange(settings?.week_start).to);
  const [expForce, setExpForce] = useState(false);
  const [expPushing, setExpPushing] = useState(false);
  const [expResult, setExpResult] = useState(null);
  // Payroll journal entry
  const [payFrom, setPayFrom] = useState(() => previousWeekRange(settings?.week_start).from);
  const [payTo, setPayTo] = useState(() => previousWeekRange(settings?.week_start).to);
  const [payDebitId, setPayDebitId] = useState('');
  const [payCreditId, setPayCreditId] = useState('');
  const [payPushing, setPayPushing] = useState(false);
  const [payResult, setPayResult] = useState(null);
  const [employeeMappings, setEmployeeMappings] = useState({});
  const [vendorMappings, setVendorMappings] = useState({});
  const [projectMappings, setProjectMappings] = useState({});
  const [classMappings, setClassMappings] = useState({});
  const [pushFrom, setPushFrom] = useState(() => previousWeekRange(settings?.week_start).from);
  const [pushTo, setPushTo] = useState(() => previousWeekRange(settings?.week_start).to);
  const [pushResult, setPushResult] = useState(null);
  const [pushing, setPushing] = useState(false);
  const [forcePush, setForcePush] = useState(false);
  // Push contractor Bills (time + reimbursements grouped per vendor)
  // Default date range = previous full week, using the company's week_start setting
  const [billFrom, setBillFrom] = useState(() => previousWeekRange(settings?.week_start).from);
  const [billTo, setBillTo] = useState(() => previousWeekRange(settings?.week_start).to);
  // If settings arrive after mount, recompute all push-section defaults against the real week_start
  const syncedWeekDefaultsRef = React.useRef(settings?.week_start != null);
  useEffect(() => {
    if (settings?.week_start != null && !syncedWeekDefaultsRef.current) {
      const r = previousWeekRange(settings.week_start);
      setBillFrom(r.from); setBillTo(r.to);
      setExpFrom(r.from);  setExpTo(r.to);
      setPayFrom(r.from);  setPayTo(r.to);
      setPushFrom(r.from); setPushTo(r.to);
      syncedWeekDefaultsRef.current = true;
    }
  }, [settings?.week_start]);
  const [billForce, setBillForce] = useState(false);
  const [billSelectedWorkers, setBillSelectedWorkers] = useState(new Set());
  const [billPreview, setBillPreview] = useState(null);
  const [billExpanded, setBillExpanded] = useState(new Set());
  const [billPreviewing, setBillPreviewing] = useState(false);
  const [billPushing, setBillPushing] = useState(false);
  const [billResult, setBillResult] = useState(null);
  const [billError, setBillError] = useState('');
  const [error, setError] = useState('');
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [savingAutoSync, setSavingAutoSync] = useState(false);

  // Import state
  const [selectedWorkers, setSelectedWorkers] = useState(new Set());
  const [selectedVendors, setSelectedVendors] = useState(new Set());
  const [vendorTypes, setVendorTypes] = useState({});
  const [selectedProjects, setSelectedProjects] = useState(new Set());
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);

  // Import search + pagination
  const [importSearch, setImportSearch] = useState('');
  const [empImportPage, setEmpImportPage] = useState(0);
  const [vendImportPage, setVendImportPage] = useState(0);
  const [custImportPage, setCustImportPage] = useState(0);

  // Mapping table pagination
  const [workerMapPages, setWorkerMapPages] = useState({});
  const [projectMapPage, setProjectMapPage] = useState(0);

  // Reset import pages when search changes
  useEffect(() => {
    setEmpImportPage(0);
    setVendImportPage(0);
    setCustImportPage(0);
  }, [importSearch]);

  useEffect(() => {
    api.get('/qbo/status').then(r => setStatus(r.data)).catch(silentError('quickbooks'));
  }, []);

  useEffect(() => {
    if (!status?.connected) return;
    setLoadingAccounts(true);
    Promise.all([api.get('/qbo/accounts'), api.get('/qbo/classes'), api.get('/qbo/errors'), api.get('/qbo/items')])
      .then(([acct, cls, errs, itms]) => {
        setQboAccounts(acct.data);
        setQboClasses(cls.data);
        setSyncErrors(errs.data);
        setQboItems(itms.data || []);
      })
      .catch(silentError('quickbooks'))
      .finally(() => setLoadingAccounts(false));
  }, [status?.connected]);

  useEffect(() => {
    if (!status?.connected) return;
    setLoadingMappings(true);
    Promise.all([api.get('/qbo/employees'), api.get('/qbo/vendors'), api.get('/qbo/customers')])
      .then(([e, v, c]) => {
        setQboEmployees(e.data);
        setQboVendors(v.data);
        setQboCustomers(c.data);
      })
      .catch(err => {
        const code = err.response?.data?.code;
        if (code === 'qbo_auth_expired') {
          setStatus(s => ({ ...s, connected: false, disconnected: true }));
        } else {
          setError(err.response?.data?.error || 'Failed to load QuickBooks data');
        }
      })
      .finally(() => setLoadingMappings(false));

    const em = {};
    const vm = {};
    workers.forEach(w => {
      if (VENDOR_TYPES.includes(w.worker_type) && w.qbo_vendor_id) vm[w.id] = w.qbo_vendor_id;
      else if (w.qbo_employee_id) em[w.id] = w.qbo_employee_id;
    });
    setEmployeeMappings(em);
    setVendorMappings(vm);

    const pm = {};
    const cm = {};
    projects.forEach(p => {
      if (p.qbo_customer_id) pm[p.id] = p.qbo_customer_id;
      if (p.qbo_class_id) cm[p.id] = p.qbo_class_id;
    });
    setProjectMappings(pm);
    setClassMappings(cm);
  }, [status?.connected]);

  const handleConnect = async () => {
    try {
      const r = await api.get('/qbo/connect');
      window.location.href = r.data.url;
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to connect');
    }
  };

  const handleDisconnect = async () => {
    setConfirmingDisconnect(false);
    await api.delete('/qbo/disconnect');
    setStatus({ connected: false });
  };

  const saveEmployeeMapping = async (workerId, qboEmployeeId) => {
    setEmployeeMappings(m => ({ ...m, [workerId]: qboEmployeeId }));
    try {
      await api.patch(`/qbo/workers/${workerId}/mapping`, { qbo_employee_id: qboEmployeeId || null });
    } catch { toast(t.failedSaveEmployeeMapping, 'error'); }
  };

  const saveVendorMapping = async (workerId, qboVendorId) => {
    setVendorMappings(m => ({ ...m, [workerId]: qboVendorId }));
    try {
      await api.patch(`/qbo/workers/${workerId}/mapping`, { qbo_vendor_id: qboVendorId || null });
    } catch { toast(t.failedSaveVendorMapping, 'error'); }
  };

  const saveProjectMapping = async (projectId, qboCustomerId) => {
    setProjectMappings(m => ({ ...m, [projectId]: qboCustomerId }));
    try {
      await api.patch(`/qbo/projects/${projectId}/mapping`, { qbo_customer_id: qboCustomerId || null });
    } catch { toast(t.failedSaveProjectMapping, 'error'); }
  };

  // Contractor workers with a QBO Vendor mapping — the only ones billable
  const billableWorkers = useMemo(
    () => workers.filter(w => VENDOR_TYPES.includes(w.worker_type) && w.qbo_vendor_id),
    [workers]
  );

  const toggleBillWorker = (id) => {
    setBillSelectedWorkers(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAllBillWorkers = () => {
    if (billSelectedWorkers.size === billableWorkers.length) setBillSelectedWorkers(new Set());
    else setBillSelectedWorkers(new Set(billableWorkers.map(w => w.id)));
  };

  const handleBillPreview = async () => {
    setBillPreviewing(true);
    setBillPreview(null);
    setBillResult(null);
    setBillError('');
    try {
      const r = await api.post('/qbo/push-bills-preview', {
        from: billFrom || undefined,
        to: billTo || undefined,
        worker_ids: billSelectedWorkers.size ? Array.from(billSelectedWorkers) : undefined,
        force: billForce || undefined,
      });
      setBillPreview(r.data.groups || []);
      setBillExpanded(new Set());
    } catch (err) {
      console.error('[push-bills-preview]', err);
      setBillError(err.response?.data?.error || err.message || 'Preview failed');
    } finally {
      setBillPreviewing(false);
    }
  };

  const handleBillPush = async () => {
    setBillPushing(true);
    setBillResult(null);
    setBillError('');
    try {
      const r = await api.post('/qbo/push-bills', {
        from: billFrom || undefined,
        to: billTo || undefined,
        worker_ids: billSelectedWorkers.size ? Array.from(billSelectedWorkers) : undefined,
        force: billForce || undefined,
      });
      setBillResult(r.data);
      setBillPreview(null);
    } catch (err) {
      console.error('[push-bills]', err);
      setBillError(err.response?.data?.error || err.message || 'Push failed');
    } finally {
      setBillPushing(false);
    }
  };

  const handlePush = async () => {
    setPushing(true);
    setPushResult(null);
    setError('');
    try {
      const r = await api.post('/qbo/push', { from: pushFrom || undefined, to: pushTo || undefined, force: forcePush || undefined });
      setPushResult(r.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Push failed');
    } finally {
      setPushing(false);
    }
  };

  const handleImport = async () => {
    setImporting(true);
    setImportResult(null);
    setError('');
    try {
      const workerPayload = [
        ...qboEmployees
          .filter(e => selectedWorkers.has(e.Id))
          .map(e => ({
            display_name: e.DisplayName,
            email: e.PrimaryEmailAddr?.Address || null,
            qbo_employee_id: e.Id,
            worker_type: 'employee',
          })),
        ...qboVendors
          .filter(v => selectedVendors.has(v.Id))
          .map(v => ({
            display_name: v.DisplayName,
            email: v.PrimaryEmailAddr?.Address || null,
            qbo_vendor_id: v.Id,
            worker_type: vendorTypes[v.Id] || 'contractor',
          })),
      ];
      const projectPayload = qboCustomers
        .filter(c => selectedProjects.has(c.Id))
        .map(c => ({ name: c.DisplayName, qbo_customer_id: c.Id }));

      const results = {};
      if (workerPayload.length > 0) {
        const r = await api.post('/qbo/import/workers', { workers: workerPayload });
        results.workers = r.data;
        if (r.data.imported.length > 0 && onWorkersImported) onWorkersImported(r.data.imported);
      }
      if (projectPayload.length > 0) {
        const r = await api.post('/qbo/import/projects', { projects: projectPayload });
        results.projects = r.data;
        if (r.data.imported.length > 0 && onProjectsImported) onProjectsImported(r.data.imported);
      }
      setImportResult(results);
      setSelectedWorkers(new Set());
      setSelectedVendors(new Set());
      setSelectedProjects(new Set());
      setImportSearch('');
    } catch (err) {
      setError(err.response?.data?.error || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const saveProjectClassMapping = async (projectId, qboClassId) => {
    setClassMappings(m => ({ ...m, [projectId]: qboClassId }));
    await api.patch(`/qbo/projects/${projectId}/mapping`, { qbo_class_id: qboClassId || null });
  };

  const dismissAllErrors = async () => {
    setClearingErrors(true);
    try { await api.delete('/qbo/errors'); setSyncErrors([]); }
    catch (err) { setError(err.response?.data?.error || 'Failed to clear errors'); }
    finally { setClearingErrors(false); }
  };

  const dismissError = async (id) => {
    try { await api.delete(`/qbo/errors/${id}`); setSyncErrors(prev => prev.filter(e => e.id !== id)); }
    catch { /* non-fatal */ }
  };

  const retryError = async (id) => {
    setRetryingErrors(prev => new Set(prev).add(id));
    setError('');
    try {
      await api.post(`/qbo/retry-error/${id}`);
      setSyncErrors(prev => prev.filter(e => e.id !== id));
    } catch (err) {
      setError(err.response?.data?.error || 'Retry failed');
    } finally {
      setRetryingErrors(prev => { const n = new Set(prev); n.delete(id); return n; });
    }
  };

  const pushExpenses = async () => {
    setExpPushing(true); setExpResult(null); setError('');
    try {
      const r = await api.post('/qbo/push-expenses', { from: expFrom || undefined, to: expTo || undefined, force: expForce || undefined });
      setExpResult(r.data);
    } catch (err) { setError(err.response?.data?.error || 'Push failed'); }
    finally { setExpPushing(false); }
  };

  const pushPayroll = async () => {
    setPayPushing(true); setPayResult(null); setError('');
    try {
      const r = await api.post('/qbo/push-payroll', { from: payFrom, to: payTo, debit_account_id: payDebitId, credit_account_id: payCreditId });
      setPayResult(r.data);
    } catch (err) { setError(err.response?.data?.error || 'Push failed'); }
    finally { setPayPushing(false); }
  };

  const saveAutoSyncSetting = async (key, value) => {
    setSavingAutoSync(true);
    try {
      const r = await api.patch('/admin/settings', { [key]: value });
      if (onSettingsChange) onSettingsChange(r.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save setting');
    } finally {
      setSavingAutoSync(false);
    }
  };

  // Filtered import lists
  const q = importSearch.trim().toLowerCase();
  const filteredEmployees = useMemo(() =>
    q ? qboEmployees.filter(e => e.DisplayName?.toLowerCase().includes(q) || e.PrimaryEmailAddr?.Address?.toLowerCase().includes(q)) : qboEmployees,
    [qboEmployees, q]);
  const filteredVendors = useMemo(() =>
    q ? qboVendors.filter(v => v.DisplayName?.toLowerCase().includes(q) || v.PrimaryEmailAddr?.Address?.toLowerCase().includes(q)) : qboVendors,
    [qboVendors, q]);
  const filteredCustomers = useMemo(() =>
    q ? qboCustomers.filter(c => c.DisplayName?.toLowerCase().includes(q)) : qboCustomers,
    [qboCustomers, q]);

  if (!status) return <SkeletonList count={4} rows={2} />;

  const TYPE_LABELS = {
    employee: t.qboTypeEmployee,
    owner: t.qboTypeOwner,
    contractor: t.qboTypeContractor,
    subcontractor: t.qboTypeSubcontractor,
  };

  const workersByType = {};
  workers.forEach(w => {
    const wtype = w.worker_type || 'employee';
    if (!workersByType[wtype]) workersByType[wtype] = [];
    workersByType[wtype].push(w);
  });
  const typeOrder = ['employee', 'owner', 'contractor', 'subcontractor'];
  const presentTypes = typeOrder.filter(wtype => workersByType[wtype]?.length > 0);

  const mappedEmployeeIds = new Set(Object.values(employeeMappings));
  const mappedVendorIds = new Set(Object.values(vendorMappings));
  const mappedCustomerIds = new Set(Object.values(projectMappings));
  const unmappedEmployees = filteredEmployees.filter(e => !mappedEmployeeIds.has(e.Id));
  const unmappedVendors = filteredVendors.filter(v => !mappedVendorIds.has(v.Id));
  const unmappedCustomers = filteredCustomers.filter(c => !mappedCustomerIds.has(c.Id));

  const totalUnmapped =
    qboEmployees.filter(e => !mappedEmployeeIds.has(e.Id)).length +
    qboVendors.filter(v => !mappedVendorIds.has(v.Id)).length +
    qboCustomers.filter(c => !mappedCustomerIds.has(c.Id)).length;

  const totalSelections = selectedWorkers.size + selectedVendors.size + selectedProjects.size;

  return (
    <div style={styles.wrap}>
      {/* ── Connection ── */}
      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>{t.qboConnection}</h3>
        {status.disconnected && (
          <div style={styles.reconnectBanner}>⚠ {t.qboReconnectBanner}</div>
        )}
        {status.connected ? (
          <div style={styles.connectedBox}>
            <span style={styles.connectedDot} />
            <div style={{ flex: 1 }}>
              <span style={{ fontWeight: 600, color: '#166534' }}>
                {status.qbo_company_name || t.qboConnected}
              </span>
              {status.connected_at && (
                <span style={styles.connectedSince}> · {t.qboConnectedSince} {new Date(status.connected_at).toLocaleDateString()}</span>
              )}
            </div>
            {confirmingDisconnect ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: '#374151' }}>{t.qboDisconnectConfirm}</span>
                <button style={styles.disconnectBtn} onClick={handleDisconnect}>{t.confirm}</button>
                <button style={styles.cancelBtn} onClick={() => setConfirmingDisconnect(false)}>{t.cancel}</button>
              </div>
            ) : (
              <button style={styles.disconnectBtn} onClick={() => setConfirmingDisconnect(true)}>{t.qboDisconnect}</button>
            )}
          </div>
        ) : (
          <div>
            <p style={styles.hint}>{t.qboConnectionHint}</p>
            <button style={styles.connectBtn} onClick={handleConnect}>
              {status.disconnected ? t.qboReconnect : t.qboConnect}
            </button>
          </div>
        )}
        {error && <p role="alert" style={styles.error}>{error}</p>}
      </div>

      {status.connected && (
        <>
          {/* ── Sync error panel ── */}
          {syncErrors.length > 0 && (
            <div style={styles.errorPanel}>
              <div style={styles.errorPanelHeader}>
                <span style={{ fontWeight: 700, color: '#92400e' }}>⚠ {syncErrors.length} QBO sync error{syncErrors.length !== 1 ? 's' : ''}</span>
                <button style={{ ...styles.clearAllBtn, ...(clearingErrors ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={dismissAllErrors} disabled={clearingErrors}>
                  {clearingErrors ? t.saving : 'Dismiss all'}
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
                {syncErrors.map(e => (
                  <div key={e.id} style={styles.errorRow}>
                    <span style={styles.errorType}>{e.entity_type}</span>
                    {e.entity_id && <span style={styles.errorEntityId}>#{e.entity_id}</span>}
                    <span style={styles.errorMsg}>{e.error_message}</span>
                    <span style={styles.errorTime}>{new Date(e.created_at).toLocaleString()}</span>
                    {(e.entity_type === 'time_entry' || e.entity_type === 'reimbursement') && (
                      <button style={{ ...styles.errorRetry, ...(retryingErrors.has(e.id) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => retryError(e.id)} disabled={retryingErrors.has(e.id)}>
                        {retryingErrors.has(e.id) ? t.saving : 'Retry'}
                      </button>
                    )}
                    <button style={styles.errorDismiss} aria-label={t.dismissError} onClick={() => dismissError(e.id)}>✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Worker mapping tables ── */}
          {presentTypes.map(type => {
            const isVendorType = VENDOR_TYPES.includes(type);
            const qboList = isVendorType ? qboVendors : qboEmployees;
            const qboLabel = isVendorType ? t.qboQBVendor : t.qboQBEmployee;
            const mappings = isVendorType ? vendorMappings : employeeMappings;
            const saveFn = isVendorType ? saveVendorMapping : saveEmployeeMapping;
            const typeWorkers = workersByType[type];
            const page = workerMapPages[type] || 0;
            const pagedWorkers = typeWorkers.slice(page * MAP_PAGE_SIZE, (page + 1) * MAP_PAGE_SIZE);
            return (
              <CollapsibleSection key={type} title={TYPE_LABELS[type]} badge={typeWorkers.length} storageKey={`mappings-${type}`}>
                {loadingMappings ? <p>{t.qboLoadingData}</p> : (
                  <>
                    <table style={styles.table}>
                      <thead>
                        <tr>
                          <th style={styles.th}>{t.qboOpsFloaWorker}</th>
                          <th style={styles.th}>{qboLabel}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pagedWorkers.map(w => (
                          <tr key={w.id}>
                            <td style={styles.td}>{w.full_name}</td>
                            <td style={styles.td}>
                              <select
                                style={styles.select}
                                value={mappings[w.id] || ''}
                                onChange={e => saveFn(w.id, e.target.value)}
                              >
                                <option value="">{t.qboNotMapped}</option>
                                {qboList.map(e => (
                                  <option key={e.Id} value={e.Id}>{e.DisplayName}</option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <Paginator
                      page={page}
                      total={typeWorkers.length}
                      pageSize={MAP_PAGE_SIZE}
                      onChange={p => setWorkerMapPages(prev => ({ ...prev, [type]: p }))}
                    />
                  </>
                )}
              </CollapsibleSection>
            );
          })}

          {/* ── Project mapping table ── */}
          <CollapsibleSection title={t.qboProjectMappings} badge={projects.length} storageKey="project-mappings">
            <p style={styles.hint}>{t.qboProjectMappingsHint}</p>
            {loadingMappings ? <p>{t.qboLoadingCustomers}</p> : (
              <>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>{t.qboOpsFloaProject}</th>
                      <th style={styles.th}>{t.qboQBCustomer}</th>
                      {qboClasses.length > 0 && <th style={styles.th}>QB Class</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {projects.slice(projectMapPage * MAP_PAGE_SIZE, (projectMapPage + 1) * MAP_PAGE_SIZE).map(p => (
                      <tr key={p.id}>
                        <td style={styles.td}>{p.name}</td>
                        <td style={styles.td}>
                          <select
                            style={styles.select}
                            value={projectMappings[p.id] || ''}
                            onChange={e => saveProjectMapping(p.id, e.target.value)}
                          >
                            <option value="">{t.qboNotMapped}</option>
                            {qboCustomers.map(c => (
                              <option key={c.Id} value={c.Id}>{c.DisplayName}</option>
                            ))}
                          </select>
                        </td>
                        {qboClasses.length > 0 && (
                          <td style={styles.td}>
                            <select
                              style={styles.select}
                              value={classMappings[p.id] || ''}
                              onChange={e => saveProjectClassMapping(p.id, e.target.value)}
                            >
                              <option value="">None</option>
                              {qboClasses.map(c => (
                                <option key={c.Id} value={c.Id}>{c.Name}</option>
                              ))}
                            </select>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Paginator
                  page={projectMapPage}
                  total={projects.length}
                  pageSize={MAP_PAGE_SIZE}
                  onChange={setProjectMapPage}
                />
              </>
            )}
          </CollapsibleSection>

          {/* ── Import from QuickBooks ── */}
          {!loadingMappings && totalUnmapped > 0 && (
            <CollapsibleSection
              title={t.qboImportFromQB}
              badge={totalSelections > 0 ? `${totalSelections} selected` : undefined}
              storageKey="import"
            >
              <p style={styles.hint}>{t.qboImportHint}</p>

              <input
                style={styles.searchInput}
                type="text"
                placeholder={t.searchNameOrEmail}
                value={importSearch}
                onChange={e => setImportSearch(e.target.value)}
              />

              {/* Employees */}
              {unmappedEmployees.length > 0 && (() => {
                const page = empImportPage;
                const paged = unmappedEmployees.slice(page * IMPORT_PAGE_SIZE, (page + 1) * IMPORT_PAGE_SIZE);
                const allUnmappedEmpIds = qboEmployees.filter(e => !mappedEmployeeIds.has(e.Id)).map(e => e.Id);
                return (
                  <div style={styles.importGroup}>
                    <div style={styles.importGroupLabel}>
                      <span>{t.qboEmployeesGroup}</span>
                      {selectedWorkers.size > 0 && <span style={styles.groupBadge}>{selectedWorkers.size}</span>}
                      <button style={styles.selectAllBtn} onClick={() =>
                        setSelectedWorkers(s => s.size === allUnmappedEmpIds.length ? new Set() : new Set(allUnmappedEmpIds))
                      }>
                        {selectedWorkers.size === allUnmappedEmpIds.length ? t.qboDeselectAll : t.qboSelectAll}
                      </button>
                    </div>
                    {paged.map(e => (
                      <label key={e.Id} style={styles.importRow}>
                        <input type="checkbox" checked={selectedWorkers.has(e.Id)} onChange={() => setSelectedWorkers(s => {
                          const n = new Set(s); n.has(e.Id) ? n.delete(e.Id) : n.add(e.Id); return n;
                        })} />
                        <span style={styles.importName}>{e.DisplayName}</span>
                        {e.PrimaryEmailAddr?.Address && <span style={styles.importEmail}>{e.PrimaryEmailAddr.Address}</span>}
                      </label>
                    ))}
                    <Paginator
                      page={page}
                      total={unmappedEmployees.length}
                      pageSize={IMPORT_PAGE_SIZE}
                      onChange={setEmpImportPage}
                    />
                  </div>
                );
              })()}

              {/* Vendors */}
              {unmappedVendors.length > 0 && (() => {
                const page = vendImportPage;
                const paged = unmappedVendors.slice(page * IMPORT_PAGE_SIZE, (page + 1) * IMPORT_PAGE_SIZE);
                const allUnmappedVendIds = qboVendors.filter(v => !mappedVendorIds.has(v.Id)).map(v => v.Id);
                return (
                  <div style={styles.importGroup}>
                    <div style={styles.importGroupLabel}>
                      <span>{t.qboVendorsGroup}</span>
                      {selectedVendors.size > 0 && <span style={styles.groupBadge}>{selectedVendors.size}</span>}
                      <button style={styles.selectAllBtn} onClick={() =>
                        setSelectedVendors(s => s.size === allUnmappedVendIds.length ? new Set() : new Set(allUnmappedVendIds))
                      }>
                        {selectedVendors.size === allUnmappedVendIds.length ? t.qboDeselectAll : t.qboSelectAll}
                      </button>
                    </div>
                    {paged.map(v => (
                      <label key={v.Id} style={styles.importRow}>
                        <input type="checkbox" checked={selectedVendors.has(v.Id)} onChange={() => setSelectedVendors(s => {
                          const n = new Set(s); n.has(v.Id) ? n.delete(v.Id) : n.add(v.Id); return n;
                        })} />
                        <span style={styles.importName}>{v.DisplayName}</span>
                        {v.PrimaryEmailAddr?.Address && <span style={styles.importEmail}>{v.PrimaryEmailAddr.Address}</span>}
                        <select
                          style={styles.importTypeSelect}
                          value={vendorTypes[v.Id] || 'contractor'}
                          onChange={e => { e.stopPropagation(); setVendorTypes(prev => ({ ...prev, [v.Id]: e.target.value })); }}
                          onClick={e => e.stopPropagation()}
                        >
                          <option value="contractor">Contractor</option>
                          <option value="subcontractor">Subcontractor</option>
                          <option value="owner">Owner / Officer</option>
                        </select>
                      </label>
                    ))}
                    <Paginator
                      page={page}
                      total={unmappedVendors.length}
                      pageSize={IMPORT_PAGE_SIZE}
                      onChange={setVendImportPage}
                    />
                  </div>
                );
              })()}

              {/* Customers */}
              {unmappedCustomers.length > 0 && (() => {
                const page = custImportPage;
                const paged = unmappedCustomers.slice(page * IMPORT_PAGE_SIZE, (page + 1) * IMPORT_PAGE_SIZE);
                const allUnmappedCustIds = qboCustomers.filter(c => !mappedCustomerIds.has(c.Id)).map(c => c.Id);
                return (
                  <div style={styles.importGroup}>
                    <div style={styles.importGroupLabel}>
                      <span>{t.qboCustomersGroup}</span>
                      {selectedProjects.size > 0 && <span style={styles.groupBadge}>{selectedProjects.size}</span>}
                      <button style={styles.selectAllBtn} onClick={() =>
                        setSelectedProjects(s => s.size === allUnmappedCustIds.length ? new Set() : new Set(allUnmappedCustIds))
                      }>
                        {selectedProjects.size === allUnmappedCustIds.length ? t.qboDeselectAll : t.qboSelectAll}
                      </button>
                    </div>
                    {paged.map(c => (
                      <label key={c.Id} style={styles.importRow}>
                        <input type="checkbox" checked={selectedProjects.has(c.Id)} onChange={() => setSelectedProjects(s => {
                          const n = new Set(s); n.has(c.Id) ? n.delete(c.Id) : n.add(c.Id); return n;
                        })} />
                        <span style={styles.importName}>{c.DisplayName}</span>
                      </label>
                    ))}
                    <Paginator
                      page={page}
                      total={unmappedCustomers.length}
                      pageSize={IMPORT_PAGE_SIZE}
                      onChange={setCustImportPage}
                    />
                  </div>
                );
              })()}

              {q && unmappedEmployees.length === 0 && unmappedVendors.length === 0 && unmappedCustomers.length === 0 && (
                <p style={styles.hint}>No results for "{importSearch}"</p>
              )}

              <button
                style={{ ...styles.pushBtn, marginTop: 16, opacity: (importing || totalSelections === 0) ? 0.5 : 1, cursor: (importing || totalSelections === 0) ? 'not-allowed' : 'pointer' }}
                onClick={handleImport}
                disabled={importing || totalSelections === 0}
              >
                {importing ? t.qboImporting : `${t.qboImportSelected} (${totalSelections})`}
              </button>

              {importResult && (
                <div style={styles.resultBox}>
                  {importResult.workers && (
                    <p style={{ margin: '0 0 4px', fontWeight: 600, color: '#166534' }}>
                      {importResult.workers.imported.length} worker{importResult.workers.imported.length !== 1 ? 's' : ''} imported.
                      {importResult.workers.temp_password && (
                        <span style={{ fontWeight: 400, color: '#374151' }}> Temp password: <code>{importResult.workers.temp_password}</code></span>
                      )}
                    </p>
                  )}
                  {importResult.projects && (
                    <p style={{ margin: '0 0 4px', fontWeight: 600, color: '#166534' }}>
                      {importResult.projects.imported.length} project{importResult.projects.imported.length !== 1 ? 's' : ''} imported.
                    </p>
                  )}
                  {(importResult.workers?.skipped?.length > 0 || importResult.projects?.skipped?.length > 0) && (
                    <details style={{ marginTop: 6 }}>
                      <summary style={{ cursor: 'pointer', color: '#92400e', fontWeight: 600, fontSize: 13 }}>
                        {(importResult.workers?.skipped?.length || 0) + (importResult.projects?.skipped?.length || 0)} skipped
                      </summary>
                      <ul style={{ marginTop: 4, paddingLeft: 18 }}>
                        {[...(importResult.workers?.skipped || []), ...(importResult.projects?.skipped || [])].map((s, i) => (
                          <li key={i} style={{ fontSize: 13, color: '#666' }}>{s.display_name || s.name}: {s.reason}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </CollapsibleSection>
          )}

          {/* ── Auto-sync settings ── */}
          <CollapsibleSection title={t.qbAutoSyncSettings} storageKey="auto-sync">
            <p style={styles.hint}>Automatically push records to QuickBooks when approved. Workers and projects must be mapped above for auto-sync to work.</p>

            <label style={styles.syncToggle}>
              <input
                type="checkbox"
                checked={!!settings?.qbo_auto_push}
                onChange={e => saveAutoSyncSetting('qbo_auto_push', e.target.checked)}
                disabled={savingAutoSync}
                style={{ marginRight: 8 }}
              />
              <span>
                <span style={{ fontWeight: 600, color: '#1a202c', fontSize: 14 }}>Auto-push time entries</span>
                <span style={{ display: 'block', fontSize: 12, color: '#6b7280', marginTop: 1 }}>When a time entry is approved, push it to QuickBooks as a Time Activity.</span>
              </span>
            </label>

            {settings?.feature_reimbursements !== false && (
              <label style={{ ...styles.syncToggle, marginTop: 12 }}>
                <input
                  type="checkbox"
                  checked={!!settings?.qbo_auto_push_expenses}
                  onChange={e => saveAutoSyncSetting('qbo_auto_push_expenses', e.target.checked)}
                  disabled={savingAutoSync}
                  style={{ marginRight: 8 }}
                />
                <span>
                  <span style={{ fontWeight: 600, color: '#1a202c', fontSize: 14 }}>Auto-push expense reimbursements</span>
                  <span style={{ display: 'block', fontSize: 12, color: '#6b7280', marginTop: 1 }}>When a reimbursement is approved, create a Purchase record in QuickBooks.</span>
                </span>
              </label>
            )}

            <label style={{ ...styles.syncToggle, marginTop: 12 }}>
              <input
                type="checkbox"
                checked={!!settings?.notify_qbo_disconnect}
                onChange={e => saveAutoSyncSetting('notify_qbo_disconnect', e.target.checked)}
                disabled={savingAutoSync}
                style={{ marginRight: 8 }}
              />
              <span>
                <span style={{ fontWeight: 600, color: '#1a202c', fontSize: 14 }}>{t.qbEmailOnDisconnect}</span>
                <span style={{ display: 'block', fontSize: 12, color: '#6b7280', marginTop: 1 }}>Send an email to all admins if the QuickBooks token expires or is revoked.</span>
              </span>
            </label>

            <label style={{ ...styles.syncToggle, marginTop: 12 }}>
              <input
                type="checkbox"
                checked={!!settings?.qbo_auto_create_customers}
                onChange={e => saveAutoSyncSetting('qbo_auto_create_customers', e.target.checked)}
                disabled={savingAutoSync}
                style={{ marginRight: 8 }}
              />
              <span>
                <span style={{ fontWeight: 600, color: '#1a202c', fontSize: 14 }}>Auto-create QB Customer when work is created</span>
                <span style={{ display: 'block', fontSize: 12, color: '#6b7280', marginTop: 1 }}>Automatically creates a matching Customer in QuickBooks when you add new work.</span>
              </span>
            </label>

            {settings?.qbo_auto_push_expenses && (
              <div style={{ marginTop: 20, display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <label htmlFor="qbo-payment-account" style={styles.label}>Payment / Bank Account</label>
                  <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 6px' }}>The account used to pay expenses (e.g. Checking, Petty Cash)</p>
                  <select
                    id="qbo-payment-account"
                    style={styles.select}
                    value={settings?.qbo_bank_account_id || ''}
                    onChange={e => saveAutoSyncSetting('qbo_bank_account_id', e.target.value)}
                    disabled={savingAutoSync || loadingAccounts}
                  >
                    <option value="">— Select account —</option>
                    {qboAccounts.filter(a => ['Bank', 'CreditCard', 'OtherCurrentAsset'].includes(a.AccountType)).map(a => (
                      <option key={a.Id} value={a.Id}>{a.Name}</option>
                    ))}
                  </select>
                </div>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <label htmlFor="qbo-expense-account" style={styles.label}>{t.qbExpenseCategoryAccount}</label>
                  <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 6px' }}>The expense account for the line item (e.g. Job Materials, Travel)</p>
                  <select
                    id="qbo-expense-account"
                    style={styles.select}
                    value={settings?.qbo_expense_account_id || ''}
                    onChange={e => saveAutoSyncSetting('qbo_expense_account_id', e.target.value)}
                    disabled={savingAutoSync || loadingAccounts}
                  >
                    <option value="">— Select account —</option>
                    {qboAccounts.filter(a => ['Expense', 'OtherExpense', 'CostOfGoodsSold'].includes(a.AccountType)).map(a => (
                      <option key={a.Id} value={a.Id}>{a.Name}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </CollapsibleSection>

          {/* ── Push expense reimbursements — only when the reimbursements feature is on ── */}
          {settings?.feature_reimbursements !== false && (
          <CollapsibleSection title={t.qbPushExpenseReimb} storageKey="push-expenses">
            <p style={styles.hint}>Manually push approved reimbursements to QuickBooks as Purchase records for a date range.</p>
            <div style={styles.pushRow}>
              <div>
                <label htmlFor="qbo-exp-from" style={styles.label}>From</label>
                <input id="qbo-exp-from" style={styles.dateInput} type="date" value={expFrom} onChange={e => setExpFrom(e.target.value)} />
              </div>
              <div>
                <label htmlFor="qbo-exp-to" style={styles.label}>To</label>
                <input id="qbo-exp-to" style={styles.dateInput} type="date" value={expTo} onChange={e => setExpTo(e.target.value)} />
              </div>
              <button style={{ ...styles.pushBtn, ...(expPushing ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={pushExpenses} disabled={expPushing}>
                {expPushing ? 'Pushing…' : 'Push Expenses'}
              </button>
            </div>
            <label style={styles.forceLabel}>
              <input type="checkbox" checked={expForce} onChange={e => setExpForce(e.target.checked)} style={{ marginRight: 6 }} />
              Re-push already-synced expenses
            </label>
            {expResult && (
              <div style={styles.resultBox}>
                <p style={{ margin: 0, fontWeight: 600, color: '#166534' }}>
                  {expResult.pushed} expense{expResult.pushed !== 1 ? 's' : ''} pushed successfully.
                </p>
                {expResult.already_synced > 0 && (
                  <p style={{ margin: '6px 0 0', fontSize: 13, color: '#6b7280' }}>{expResult.already_synced} already synced (skipped).</p>
                )}
                {expResult.skipped?.length > 0 && (
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ cursor: 'pointer', color: '#92400e', fontWeight: 600 }}>{expResult.skipped.length} skipped</summary>
                    <ul style={{ marginTop: 6, paddingLeft: 20 }}>
                      {expResult.skipped.map((s, i) => <li key={i} style={{ fontSize: 13, color: '#666' }}>{s.reason}</li>)}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </CollapsibleSection>
          )}

          {/* ── Payroll journal entry ── */}
          <CollapsibleSection title={t.qbPushPayrollJournal} storageKey="push-payroll">
            <p style={styles.hint}>Creates a journal entry in QuickBooks for the total labor cost of approved time entries in a date range. Select the wage expense account to debit and the liability or bank account to credit.</p>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
              <div>
                <label htmlFor="qbo-pay-from" style={styles.label}>From</label>
                <input id="qbo-pay-from" style={styles.dateInput} type="date" value={payFrom} onChange={e => setPayFrom(e.target.value)} />
              </div>
              <div>
                <label htmlFor="qbo-pay-to" style={styles.label}>To</label>
                <input id="qbo-pay-to" style={styles.dateInput} type="date" value={payTo} onChange={e => setPayTo(e.target.value)} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <label htmlFor="qbo-debit" style={styles.label}>Debit — Wages Expense Account</label>
                <select id="qbo-debit" style={styles.select} value={payDebitId} onChange={e => setPayDebitId(e.target.value)} disabled={loadingAccounts}>
                  <option value="">— Select account —</option>
                  {qboAccounts.filter(a => ['Expense', 'OtherExpense', 'CostOfGoodsSold'].includes(a.AccountType)).map(a => (
                    <option key={a.Id} value={a.Id}>{a.Name}</option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <label htmlFor="qbo-credit" style={styles.label}>Credit — Payroll Liability / Bank Account</label>
                <select id="qbo-credit" style={styles.select} value={payCreditId} onChange={e => setPayCreditId(e.target.value)} disabled={loadingAccounts}>
                  <option value="">— Select account —</option>
                  {qboAccounts.filter(a => ['Bank', 'CreditCard', 'OtherCurrentLiability', 'LongTermLiability'].includes(a.AccountType)).map(a => (
                    <option key={a.Id} value={a.Id}>{a.Name}</option>
                  ))}
                </select>
              </div>
            </div>
            <button
              style={{ ...styles.pushBtn, opacity: (payPushing || !payFrom || !payTo || !payDebitId || !payCreditId) ? 0.5 : 1, cursor: (payPushing || !payFrom || !payTo || !payDebitId || !payCreditId) ? 'not-allowed' : 'pointer' }}
              onClick={pushPayroll}
              disabled={payPushing || !payFrom || !payTo || !payDebitId || !payCreditId}
            >
              {payPushing ? 'Pushing…' : 'Push Journal Entry'}
            </button>
            {payResult && (
              <div style={styles.resultBox}>
                <p style={{ margin: 0, fontWeight: 600, color: '#166534' }}>
                  Journal entry created — ${payResult.amount?.toFixed(2)} across {payResult.entries} entries.
                </p>
                <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>{payResult.description}</p>
              </div>
            )}
          </CollapsibleSection>

          {/* ── Push Bills (contractor time + reimbursements per vendor) ── */}
          <CollapsibleSection title={t.qbPushBillsContractors} storageKey="push-bills">
            <p style={styles.hint}>
              Creates one QBO Bill per contractor, combining approved time entries (as labor lines) and approved reimbursements (as expense lines) for the selected date range. Only contractors with a mapped QBO Vendor appear.
            </p>

            {/* Required settings */}
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 16 }}>
              <div style={{ flex: 1, minWidth: 240 }}>
                <label htmlFor="qbo-labor-item" style={styles.label}>Labor Service Item *</label>
                <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 6px' }}>QBO Service item used on Bill labor lines (hours × rate).</p>
                <select
                  id="qbo-labor-item"
                  style={styles.select}
                  value={settings?.qbo_labor_item_id || ''}
                  onChange={e => saveAutoSyncSetting('qbo_labor_item_id', e.target.value)}
                  disabled={savingAutoSync || loadingAccounts}
                >
                  <option value="">— Select item —</option>
                  {qboItems.map(it => (
                    <option key={it.Id} value={it.Id}>{it.Name}</option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 240 }}>
                <label htmlFor="qbo-bill-expense" style={styles.label}>{t.qbReimbExpenseAccount}</label>
                <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 6px' }}>Only needed if you're billing reimbursements. The QBO account where mileage / expense dollars post (e.g. "Travel" or "Subcontractor Reimbursements").</p>
                <select
                  id="qbo-bill-expense"
                  style={styles.select}
                  value={settings?.qbo_expense_account_id || ''}
                  onChange={e => saveAutoSyncSetting('qbo_expense_account_id', e.target.value)}
                  disabled={savingAutoSync || loadingAccounts}
                >
                  <option value="">— Select account —</option>
                  {qboAccounts.filter(a => ['Expense', 'OtherExpense', 'CostOfGoodsSold'].includes(a.AccountType)).map(a => (
                    <option key={a.Id} value={a.Id}>{a.Name}</option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 240 }}>
                <label htmlFor="qbo-bill-terms" style={styles.label}>Bill Terms (days)</label>
                <p style={{ fontSize: 12, color: '#6b7280', margin: '2px 0 6px' }}>Days from bill date to due date. 0 = due on receipt.</p>
                <input
                  id="qbo-bill-terms"
                  type="number"
                  min={0}
                  max={365}
                  style={styles.dateInput}
                  value={settings?.qbo_bill_terms_days ?? 0}
                  onChange={e => saveAutoSyncSetting('qbo_bill_terms_days', e.target.value)}
                />
              </div>
            </div>
            {!settings?.qbo_labor_item_id && (
              <p role="alert" style={{ fontSize: 13, color: '#92400e', background: '#fef3c7', padding: '8px 12px', borderRadius: 6, marginBottom: 12 }}>
                Labor Service Item is required. Reimbursement Expense Account is only needed if any contractor has reimbursements in the range.
              </p>
            )}

            {/* Date range + force */}
            <div style={styles.pushRow}>
              <div>
                <label htmlFor="qbo-bill-from" style={styles.label}>From</label>
                <input id="qbo-bill-from" style={styles.dateInput} type="date" value={billFrom} onChange={e => setBillFrom(e.target.value)} />
              </div>
              <div>
                <label htmlFor="qbo-bill-to" style={styles.label}>To</label>
                <input id="qbo-bill-to" style={styles.dateInput} type="date" value={billTo} onChange={e => setBillTo(e.target.value)} />
              </div>
            </div>
            <label style={styles.forceLabel}>
              <input type="checkbox" checked={billForce} onChange={e => setBillForce(e.target.checked)} style={{ marginRight: 6 }} />
              Re-push entries/reimbursements already pushed to a bill
            </label>

            {/* Worker picker */}
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <strong style={{ fontSize: 14, color: '#111827' }}>Contractors</strong>
                {billableWorkers.length > 0 && (
                  <button
                    type="button"
                    style={{ background: 'none', border: '1px solid #d1d5db', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', color: '#374151' }}
                    onClick={toggleAllBillWorkers}
                  >
                    {billSelectedWorkers.size === billableWorkers.length ? 'Clear all' : 'Select all'}
                  </button>
                )}
              </div>
              {billableWorkers.length === 0 ? (
                <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>No contractors with QBO Vendor mappings yet. Map them in the Worker Mappings section above.</p>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {billableWorkers.map(w => {
                    const selected = billSelectedWorkers.has(w.id);
                    return (
                      <label
                        key={w.id}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6,
                          padding: '6px 12px', borderRadius: 20, cursor: 'pointer',
                          background: selected ? '#dbeafe' : '#f3f4f6',
                          border: `1px solid ${selected ? '#60a5fa' : '#e5e7eb'}`,
                          color: selected ? '#1e40af' : '#374151',
                          fontSize: 13, fontWeight: selected ? 600 : 500,
                        }}
                      >
                        <input type="checkbox" checked={selected} onChange={() => toggleBillWorker(w.id)} style={{ margin: 0 }} />
                        {w.full_name}
                      </label>
                    );
                  })}
                </div>
              )}
              <p style={{ fontSize: 12, color: '#6b7280', margin: '8px 0 0' }}>
                Leave empty to include all contractors in the range.
              </p>
            </div>

            {/* Preview + push buttons */}
            {(() => {
              const missingLabor = !settings?.qbo_labor_item_id;
              const missingExpense = !settings?.qbo_expense_account_id;
              const noPreview = !billPreview || billPreview.length === 0;
              // Expense account is only required when at least one bill includes reimbursements
              const previewHasReimbs = billPreview?.some(g => (g.reimbursements || 0) > 0);
              const needExpenseAcct = previewHasReimbs && missingExpense;
              const pushDisabled = billPushing || noPreview || missingLabor || needExpenseAcct;
              const reason = missingLabor
                ? 'Set a Labor Service Item above first.'
                : needExpenseAcct
                ? 'One or more contractors have reimbursements — set a Reimbursement Expense Account first.'
                : noPreview
                ? 'Click Preview first to see what will be billed.'
                : null;
              return (
                <>
                  <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                    <button
                      style={{ ...styles.pushBtn, background: '#1f2937', ...(billPreviewing ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                      onClick={handleBillPreview}
                      disabled={billPreviewing}
                    >
                      {billPreviewing ? 'Loading…' : 'Preview'}
                    </button>
                    <button
                      style={{ ...styles.pushBtn, ...(pushDisabled ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                      onClick={handleBillPush}
                      disabled={pushDisabled}
                      title={reason || ''}
                    >
                      {billPushing ? 'Pushing…' : `Push ${billPreview?.length || 0} ${billPreview?.length === 1 ? 'Bill' : 'Bills'}`}
                    </button>
                    {reason && !billPushing && (
                      <span style={{ fontSize: 13, color: '#6b7280' }}>{reason}</span>
                    )}
                  </div>
                  {billError && (
                    <p role="alert" style={{ marginTop: 10, color: '#991b1b', background: '#fee2e2', padding: '8px 12px', borderRadius: 6, fontSize: 13 }}>
                      {billError}
                    </p>
                  )}
                </>
              );
            })()}

            {/* Preview table */}
            {billPreview && billPreview.length === 0 && (
              <p style={{ marginTop: 12, fontSize: 13, color: '#6b7280' }}>Nothing to bill in that range.</p>
            )}
            {billPreview && billPreview.length > 0 && (
              <div style={{ marginTop: 16, overflowX: 'auto' }}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, width: 28 }} aria-label="Expand"></th>
                      <th style={styles.th}>Contractor</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>Hours</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>Labor $</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>OT hrs</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>OT premium $</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>Reimb. $</th>
                      <th style={{ ...styles.th, textAlign: 'right' }}>{t.qbBillTotal}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {billPreview.map(g => {
                      const open = billExpanded.has(g.user_id);
                      const toggle = () => setBillExpanded(prev => {
                        const next = new Set(prev);
                        if (next.has(g.user_id)) next.delete(g.user_id); else next.add(g.user_id);
                        return next;
                      });
                      return (
                        <React.Fragment key={g.user_id}>
                          <tr onClick={toggle} style={{ cursor: 'pointer' }}>
                            <td style={styles.td}>
                              <button
                                type="button"
                                aria-expanded={open}
                                aria-label={open ? 'Collapse' : 'Expand'}
                                onClick={e => { e.stopPropagation(); toggle(); }}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 12, color: '#6b7280', minHeight: 'unset' }}
                              >
                                {open ? '▾' : '▸'}
                              </button>
                            </td>
                            <td style={styles.td}>{g.full_name}</td>
                            <td style={{ ...styles.td, textAlign: 'right' }}>{g.hours.toFixed(2)}</td>
                            <td style={{ ...styles.td, textAlign: 'right' }}>${g.labor_amount.toFixed(2)}</td>
                            <td style={{ ...styles.td, textAlign: 'right', color: g.overtime_hours > 0 ? '#92400e' : '#9ca3af' }}>{(g.overtime_hours || 0).toFixed(2)}</td>
                            <td style={{ ...styles.td, textAlign: 'right', color: g.overtime_premium > 0 ? '#92400e' : '#9ca3af' }}>${(g.overtime_premium || 0).toFixed(2)}</td>
                            <td style={{ ...styles.td, textAlign: 'right' }}>${g.reimb_amount.toFixed(2)}</td>
                            <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>${g.total.toFixed(2)}</td>
                          </tr>
                          {open && (
                            <tr>
                              <td colSpan={8} style={{ ...styles.td, background: '#f9fafb', padding: '12px 16px' }}>
                                {g.time_entry_rows?.length > 0 && (
                                  <div style={{ marginBottom: g.reimbursement_rows?.length ? 14 : 0 }}>
                                    <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3 }}>
                                      Time entries ({g.time_entry_rows.length})
                                    </div>
                                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                                      <thead>
                                        <tr>
                                          <th style={{ textAlign: 'left', padding: '4px 8px', color: '#6b7280', fontWeight: 600, width: 100 }}>Date</th>
                                          <th style={{ textAlign: 'left', padding: '4px 8px', color: '#6b7280', fontWeight: 600 }}>Project</th>
                                          <th style={{ textAlign: 'left', padding: '4px 8px', color: '#6b7280', fontWeight: 600 }}>Notes</th>
                                          <th style={{ textAlign: 'right', padding: '4px 8px', color: '#6b7280', fontWeight: 600, width: 70 }}>Hours</th>
                                          <th style={{ textAlign: 'right', padding: '4px 8px', color: '#6b7280', fontWeight: 600, width: 90 }}>Amount</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {g.time_entry_rows.map(te => (
                                          <tr key={te.id}>
                                            <td style={{ padding: '4px 8px', color: '#111827' }}>{te.work_date}</td>
                                            <td style={{ padding: '4px 8px', color: '#111827' }}>{te.project_name || '—'}</td>
                                            <td style={{ padding: '4px 8px', color: '#6b7280' }}>{te.description || '—'}</td>
                                            <td style={{ padding: '4px 8px', textAlign: 'right', color: '#111827' }}>{te.hours.toFixed(2)}</td>
                                            <td style={{ padding: '4px 8px', textAlign: 'right', color: '#111827' }}>${te.amount.toFixed(2)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                                {g.reimbursement_rows?.length > 0 && (
                                  <div>
                                    <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3 }}>
                                      Reimbursements ({g.reimbursement_rows.length})
                                    </div>
                                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                                      <thead>
                                        <tr>
                                          <th style={{ textAlign: 'left', padding: '4px 8px', color: '#6b7280', fontWeight: 600, width: 100 }}>Date</th>
                                          <th style={{ textAlign: 'left', padding: '4px 8px', color: '#6b7280', fontWeight: 600 }}>Project</th>
                                          <th style={{ textAlign: 'left', padding: '4px 8px', color: '#6b7280', fontWeight: 600 }}>Description</th>
                                          <th style={{ textAlign: 'right', padding: '4px 8px', color: '#6b7280', fontWeight: 600, width: 90 }}>Amount</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {g.reimbursement_rows.map(r => (
                                          <tr key={r.id}>
                                            <td style={{ padding: '4px 8px', color: '#111827' }}>{r.expense_date}</td>
                                            <td style={{ padding: '4px 8px', color: '#111827' }}>{r.project_name || '—'}</td>
                                            <td style={{ padding: '4px 8px', color: '#6b7280' }}>{r.description || '—'}</td>
                                            <td style={{ padding: '4px 8px', textAlign: 'right', color: '#111827' }}>${r.amount.toFixed(2)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                    <tr>
                      <td style={styles.td}></td>
                      <td style={{ ...styles.td, fontWeight: 700 }}>Total</td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>
                        {billPreview.reduce((s, g) => s + g.hours, 0).toFixed(2)}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>
                        ${billPreview.reduce((s, g) => s + g.labor_amount, 0).toFixed(2)}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>
                        {billPreview.reduce((s, g) => s + (g.overtime_hours || 0), 0).toFixed(2)}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>
                        ${billPreview.reduce((s, g) => s + (g.overtime_premium || 0), 0).toFixed(2)}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>
                        ${billPreview.reduce((s, g) => s + g.reimb_amount, 0).toFixed(2)}
                      </td>
                      <td style={{ ...styles.td, textAlign: 'right', fontWeight: 700 }}>
                        ${billPreview.reduce((s, g) => s + g.total, 0).toFixed(2)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {/* Result */}
            {billResult && (
              <div style={styles.resultBox}>
                <p style={{ margin: 0, fontWeight: 600, color: '#166534' }}>
                  {billResult.pushed.length} {billResult.pushed.length === 1 ? 'bill' : 'bills'} created in QuickBooks.
                </p>
                {billResult.pushed.length > 0 && (
                  <ul style={{ marginTop: 8, paddingLeft: 20 }}>
                    {billResult.pushed.map(p => (
                      <li key={p.user_id} style={{ fontSize: 13, color: '#374151' }}>
                        {p.full_name} — Bill #{p.bill_id} ({p.time_entries} time {p.time_entries === 1 ? 'entry' : 'entries'}, {p.reimbursements} reimb.)
                      </li>
                    ))}
                  </ul>
                )}
                {billResult.skipped.length > 0 && (
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ cursor: 'pointer', color: '#92400e', fontWeight: 600 }}>
                      {billResult.skipped.length} skipped
                    </summary>
                    <ul style={{ marginTop: 6, paddingLeft: 20 }}>
                      {billResult.skipped.map((s, i) => (
                        <li key={i} style={{ fontSize: 13, color: '#666' }}>
                          {s.full_name}: {s.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </CollapsibleSection>

          {/* ── Push time entries ── */}
          <CollapsibleSection title={t.qboPushEntries} storageKey="push-time">
            <p style={styles.hint}>{t.qboPushHint}</p>
            <div style={styles.pushRow}>
              <div>
                <label htmlFor="qbo-push-from" style={styles.label}>{t.qboFrom}</label>
                <input id="qbo-push-from" style={styles.dateInput} type="date" value={pushFrom} onChange={e => setPushFrom(e.target.value)} />
              </div>
              <div>
                <label htmlFor="qbo-push-to" style={styles.label}>{t.qboTo}</label>
                <input id="qbo-push-to" style={styles.dateInput} type="date" value={pushTo} onChange={e => setPushTo(e.target.value)} />
              </div>
              <button style={{ ...styles.pushBtn, ...(pushing ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={handlePush} disabled={pushing}>
                {pushing ? t.qboPushing : t.qboPush}
              </button>
            </div>
            <label style={styles.forceLabel}>
              <input type="checkbox" checked={forcePush} onChange={e => setForcePush(e.target.checked)} style={{ marginRight: 6 }} />
              {t.qboRepush}
            </label>
            {pushResult && (
              <div style={styles.resultBox}>
                <p style={{ margin: 0, fontWeight: 600, color: '#166534' }}>
                  {pushResult.pushed} {pushResult.pushed === 1 ? 'entry' : 'entries'} pushed successfully.
                </p>
                {pushResult.already_synced > 0 && (
                  <p style={{ margin: '6px 0 0', fontSize: 13, color: '#6b7280' }}>
                    {pushResult.already_synced} already synced (skipped).
                  </p>
                )}
                {pushResult.skipped.length > 0 && (
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ cursor: 'pointer', color: '#92400e', fontWeight: 600 }}>
                      {pushResult.skipped.length} skipped
                    </summary>
                    <ul style={{ marginTop: 6, paddingLeft: 20 }}>
                      {pushResult.skipped.map((s, i) => (
                        <li key={i} style={{ fontSize: 13, color: '#666' }}>{s.reason}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </CollapsibleSection>
        </>
      )}
    </div>
  );
}

const styles = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 24 },
  section: { background: '#fff', borderRadius: 12, padding: '24px', boxShadow: '0 1px 4px rgba(0,0,0,0.07)' },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 },
  sectionTitle: { fontSize: 16, fontWeight: 700, color: '#1a202c', margin: 0 },
  countBadge: { fontSize: 11, fontWeight: 700, background: '#f3f4f6', color: '#6b7280', padding: '2px 8px', borderRadius: 10 },
  selectedBadge: { fontSize: 11, fontWeight: 700, background: '#dbeafe', color: '#1d4ed8', padding: '2px 8px', borderRadius: 10, marginLeft: 'auto' },
  hint: { fontSize: 13, color: '#6b7280', marginBottom: 14 },
  connectedBox: { display: 'flex', alignItems: 'center', gap: 10 },
  connectedDot: { width: 10, height: 10, borderRadius: '50%', background: '#16a34a', flexShrink: 0 },
  connectedSince: { fontSize: 13, color: '#6b7280', flex: 1 },
  connectBtn: { background: '#2CA01C', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 22px', fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  disconnectBtn: { background: 'none', border: '1px solid #d1d5db', borderRadius: 7, padding: '6px 14px', fontWeight: 600, fontSize: 13, cursor: 'pointer', color: '#6b7280' },
  cancelBtn: { background: '#e5e7eb', border: 'none', borderRadius: 7, padding: '6px 14px', fontWeight: 600, fontSize: 13, cursor: 'pointer', color: '#374151' },
  error: { color: '#e53e3e', fontSize: 13, marginTop: 8 },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { textAlign: 'left', padding: '8px 12px', fontSize: 13, fontWeight: 600, color: '#6b7280', borderBottom: '1px solid #e5e7eb' },
  td: { padding: '10px 12px', borderBottom: '1px solid #f3f4f6', fontSize: 14 },
  select: { width: '100%', padding: '7px 10px', border: '1px solid #ddd', borderRadius: 6, fontSize: 13 },
  searchInput: { width: '100%', padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, marginBottom: 16, boxSizing: 'border-box' },
  pushRow: { display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' },
  label: { display: 'block', fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 4 },
  dateInput: { padding: '8px 10px', border: '1px solid #ddd', borderRadius: 7, fontSize: 14 },
  pushBtn: { background: '#2CA01C', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', fontWeight: 700, fontSize: 14, cursor: 'pointer' },
  resultBox: { marginTop: 16, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '14px 16px' },
  reconnectBanner: { background: '#fffbeb', border: '1px solid #fcd34d', color: '#92400e', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 14 },
  forceLabel: { display: 'flex', alignItems: 'center', fontSize: 13, color: '#6b7280', marginTop: 10, cursor: 'pointer' },
  importGroup: { marginBottom: 20, borderBottom: '1px solid #f3f4f6', paddingBottom: 16 },
  importGroupLabel: { fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 },
  groupBadge: { fontSize: 11, fontWeight: 700, background: '#dbeafe', color: '#1d4ed8', padding: '2px 7px', borderRadius: 10 },
  selectAllBtn: { background: 'none', border: 'none', color: 'var(--ops-page-accent)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: 0, marginLeft: 'auto' },
  importRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid #f9fafb', cursor: 'pointer', fontSize: 14 },
  importName: { flex: 1, fontWeight: 500, color: '#111827' },
  importEmail: { fontSize: 12, color: '#6b7280' },
  importTypeSelect: { padding: '4px 8px', border: '1px solid #ddd', borderRadius: 6, fontSize: 12, minHeight: 'unset' },
  paginator: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, justifyContent: 'flex-end' },
  pageBtn: { background: '#f3f4f6', border: 'none', borderRadius: 6, padding: '4px 10px', fontSize: 16, cursor: 'pointer', color: '#374151', minHeight: 'unset', lineHeight: 1 },
  pageInfo: { fontSize: 13, color: '#6b7280', fontVariantNumeric: 'tabular-nums' },
  syncToggle: { display: 'flex', alignItems: 'flex-start', cursor: 'pointer', fontSize: 14, color: '#374151' },
  errorPanel: { background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 12, padding: '16px 20px' },
  errorPanelHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  clearAllBtn: { background: 'none', border: '1px solid #fcd34d', color: '#92400e', borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  errorRow: { display: 'flex', alignItems: 'center', gap: 8, background: '#fff', border: '1px solid #fde68a', borderRadius: 7, padding: '7px 12px', fontSize: 13, flexWrap: 'wrap' },
  errorType: { background: '#fef3c7', color: '#92400e', borderRadius: 4, padding: '1px 7px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', flexShrink: 0 },
  errorEntityId: { color: '#6b7280', fontSize: 12, flexShrink: 0 },
  errorMsg: { flex: 1, color: '#374151', minWidth: 120 },
  errorTime: { color: '#6b7280', fontSize: 11, flexShrink: 0 },
  errorDismiss: { background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 2px', flexShrink: 0 },
  errorRetry: { padding: '2px 10px', background: '#eff6ff', color: 'var(--ops-page-accent)', border: '1px solid #bfdbfe', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', flexShrink: 0 },
};
