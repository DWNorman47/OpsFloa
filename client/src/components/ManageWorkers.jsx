import React, { useState, useEffect, useRef } from 'react';
import api from '../api';
import { useToast } from '../contexts/ToastContext';
import { formatCurrency } from '../utils';
import { useT } from '../hooks/useT';
import { SkeletonList } from './Skeleton';
import ModalShell from './ModalShell';
import WorkerFringes from './WorkerFringes';
import WorkerSsn from './WorkerSsn';
import EmptyState from './EmptyState';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { usePerm } from '../hooks/usePerm';

import { silentError } from '../errorReporter';
function WorkerDocuments({ workerId }) {
  const t = useT();
  const toast = useToast();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [pendingDeleteDocId, setPendingDeleteDocId] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    api.get(`/admin/workers/${workerId}/documents`)
      .then(r => setDocs(r.data))
      .catch(silentError('manageworkers'))
      .finally(() => setLoading(false));
  }, [workerId]);

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setUploadError(t.docsUploadError); return; }
    setUploading(true); setUploadError('');
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const r = await api.post(`/admin/workers/${workerId}/documents`, { name: file.name, data: ev.target.result });
        setDocs(prev => [r.data, ...prev]);
      } catch { setUploadError(t.docsUploadError); }
      finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
    };
    reader.readAsDataURL(file);
  };

  const handleDelete = async (docId) => {
    try {
      await api.delete(`/admin/workers/${workerId}/documents/${docId}`);
      setDocs(prev => prev.filter(d => d.id !== docId));
      toast(t.docsDeleted, 'success');
    } catch {
      toast(t.docsDeleteFailed, 'error');
    } finally { setPendingDeleteDocId(null); }
  };

  const fmtSize = (b) => b ? (b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`) : '';

  return (
    <div style={ds.section}>
      <div style={ds.header}>
        <span style={ds.title}>{t.docsTitle}</span>
        <label style={ds.uploadBtn}>
          <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={handleUpload} accept=".pdf,.png,.jpg,.jpeg,.doc,.docx,.xls,.xlsx" />
          {uploading ? t.docsUploading : `+ ${t.docsUpload}`}
        </label>
      </div>
      {uploadError && <p style={ds.error}>{uploadError}</p>}
      {loading ? null : docs.length === 0 ? (
        <p style={ds.empty}>{t.docsNoDocuments}</p>
      ) : (
        <div style={ds.list}>
          {docs.map(d => (
            <div key={d.id} style={ds.docRow}>
              <a href={d.url} target="_blank" rel="noopener noreferrer" style={ds.docName} title={d.name}>{d.name}</a>
              <span style={ds.docMeta}>{fmtSize(d.size_bytes)}{d.uploaded_by_name ? ` · ${d.uploaded_by_name}` : ''}</span>
              {pendingDeleteDocId === d.id ? (
                <>
                  <button style={ds.confirmDeleteBtn} onClick={() => handleDelete(d.id)}>{t.confirm}</button>
                  <button style={ds.cancelDeleteBtn} onClick={() => setPendingDeleteDocId(null)}>{t.cancel}</button>
                </>
              ) : (
                <button style={ds.deleteBtn} aria-label={`Delete ${d.name}`} onClick={() => setPendingDeleteDocId(d.id)}>✕</button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const ds = {
  section: { marginTop: 0, paddingTop: 10, borderTop: '1px solid #f3f4f6' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  title: { fontSize: 13, fontWeight: 700, color: '#374151' },
  uploadBtn: { background: '#eff6ff', color: 'var(--ops-page-accent)', border: '1px solid #bfdbfe', borderRadius: 6, padding: '4px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  list: { display: 'flex', flexDirection: 'column', gap: 6 },
  docRow: { display: 'flex', alignItems: 'center', gap: 10, background: '#f9fafb', borderRadius: 6, padding: '6px 10px' },
  docName: { flex: 1, fontSize: 13, color: 'var(--ops-page-accent)', textDecoration: 'none', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  docMeta: { fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' },
  deleteBtn: { background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 12, padding: '0 2px', lineHeight: 1 },
  confirmDeleteBtn: { background: '#ef4444', color: '#fff', border: 'none', borderRadius: 5, padding: '3px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  cancelDeleteBtn: { background: 'none', border: '1px solid #d1d5db', color: '#6b7280', borderRadius: 5, padding: '3px 8px', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  error: { fontSize: 12, color: '#ef4444', margin: '4px 0' },
  empty: { fontSize: 12, color: '#6b7280', margin: '4px 0' },
};

const LANGUAGES = ['English', 'Spanish'];

const findBuiltinRole = (roles, legacyRole = 'worker') => {
  const roleName = legacyRole === 'admin' ? 'Admin' : 'Worker';
  return roles.find(role => role.is_builtin && role.name === roleName) || null;
};

export const resolveWorkerRoleId = (worker, roles = []) =>
  worker?.role_id ?? findBuiltinRole(roles, worker?.role)?.id ?? null;

const createAddForm = (defaultRate, defaultTempPassword, roles = []) => {
  const defaultRole = findBuiltinRole(roles, 'worker');
  return {
    first_name: '',
    last_name: '',
    username: '',
    password: defaultTempPassword,
    email: '',
    role: 'worker',
    role_id: defaultRole?.id ?? null,
    worker_type: 'employee',
    classification: '',
    language: 'English',
    hourly_rate: String(defaultRate),
    rate_type: 'hourly',
    overtime_rule: 'daily',
  };
};

const createInviteForm = (defaultRate, roles = []) => {
  const defaultRole = findBuiltinRole(roles, 'worker');
  return {
    first_name: '',
    last_name: '',
    email: '',
    role: 'worker',
    role_id: defaultRole?.id ?? null,
    worker_type: 'employee',
    classification: '',
    language: 'English',
    hourly_rate: String(defaultRate),
    rate_type: 'hourly',
    overtime_rule: 'daily',
  };
};

const workerTypeLabel = (type, t) => ({
  employee:      t.mwTypeEmployee,
  contractor:    t.mwTypeContractor,
  subcontractor: t.mwTypeSubcontractor,
  owner:         t.mwTypeOwner,
  unpaid:        t.mwTypeUnpaid,
}[type] || type);

const permLabels = (t) => [
  { key: 'approve_entries', label: t.mwPermApproveEntries },
  { key: 'manage_workers', label: t.mwPermManageWorkers },
  { key: 'manage_projects', label: t.mwPermManageProjects },
  { key: 'view_reports', label: t.mwPermViewReports },
  { key: 'manage_settings', label: t.mwPermManageSettings },
];

function fmtRate(w, currency = 'USD') {
  const amt = parseFloat(w.hourly_rate ?? 0);
  if (w.rate_type === 'daily') return `${formatCurrency(amt, currency)} / day`;
  return `${formatCurrency(amt, currency)} / hr`;
}

// Shows the user's actual role name (Owner / Admin / Worker / custom).
// Falls back to the legacy worker/admin label if no role data is available.
// Owner gets a gold badge so it stands out — easy answer to "who owns this account?".
function RoleBadge({ worker, role, availableRoles, workerLabel }) {
  const t = useT();
  // If we know the role_id and have the catalog, show the actual role name.
  if (worker?.role_id && availableRoles?.length) {
    const roleObj = availableRoles.find(r => r.id === worker.role_id);
    if (roleObj) {
      const isOwner = roleObj.is_builtin && roleObj.name === 'Owner';
      const isAdminTier = roleObj.parent_role === 'admin';
      const bg = isOwner ? '#fef3c7' : isAdminTier ? '#dbeafe' : '#f3f4f6';
      const fg = isOwner ? '#92400e' : isAdminTier ? '#1e40af' : '#6b7280';
      return (
        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: bg, color: fg }}>
          {roleObj.name}
        </span>
      );
    }
  }
  // Legacy fallback: just worker/admin from users.role
  const r = role ?? worker?.role;
  const isAdmin = r === 'admin' || r === 'super_admin';
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: isAdmin ? '#dbeafe' : '#f3f4f6', color: isAdmin ? '#1e40af' : '#6b7280' }}>
      {isAdmin ? t.adminRole : (workerLabel || t.workerRole)}
    </span>
  );
}

export default function ManageWorkers({ workers, onWorkerAdded, onWorkerDeleted, onWorkerUpdated, onWorkerRestored, defaultRate = 0, defaultTempPassword = '', showRate = true, identityEditable = true, currency = 'USD', currentUser = null, qboConnected = false, trackClassifications = false, trackFringes = false, collectSsn = false, workerLabel = 'Worker' }) {
  const canViewCertifiedPayroll = usePerm('view_certified_payroll');
  const toast = useToast();
  const t = useT();
  const rateTypes = [
    { value: 'hourly', label: t.perHour },
    { value: 'daily', label: t.perDay },
  ];
  const overtimeRules = [
    { value: 'daily', label: t.otDaily },
    { value: 'weekly', label: t.otWeekly },
    { value: 'none', label: t.otNone },
  ];

  // Add form state
  const [showForm, setShowForm] = useState(false);
  const [addMode, setAddMode] = useState('manual');
  const [form, setForm] = useState(() => createAddForm(defaultRate, defaultTempPassword));
  const [inviteForm, setInviteForm] = useState(() => createInviteForm(defaultRate));
  // True once the user edits the open add/invite panel, so the tab-close
  // prompt only fires when there's actually entered data to lose.
  const [formTouched, setFormTouched] = useState(false);
  const [error, setError] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [inviteSent, setInviteSent] = useState('');
  const [saving, setSaving] = useState(false);
  const [inviteSaving, setInviteSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [usernameTaken, setUsernameTaken] = useState(false);
  const [usernameChecking, setUsernameChecking] = useState(false);
  const [archivedConflict, setArchivedConflict] = useState(null);
  const [qboVendorPrompt, setQboVendorPrompt] = useState(null); // { user_id, display_name }
  const [qboVendorCreating, setQboVendorCreating] = useState(false);
  const [qboVendorResult, setQboVendorResult] = useState(null); // 'ok' | 'error'

  // Expand / edit state
  const [expandedId, setExpandedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editSection, setEditSection] = useState(null); // 'info' | 'username' | 'rate'

  const [editInfoForm, setEditInfoForm] = useState({});
  const [editInfoSaving, setEditInfoSaving] = useState(false);
  const [originalRoleId, setOriginalRoleId] = useState(null);

  const [editUsernameVal, setEditUsernameVal] = useState('');
  const [editUsernameTaken, setEditUsernameTaken] = useState(false);
  const [editUsernameChecking, setEditUsernameChecking] = useState(false);
  const [editUsernameSaving, setEditUsernameSaving] = useState(false);

  const [editRateForm, setEditRateForm] = useState({ rate: '', rate_type: 'hourly', overtime_rule: 'daily', guaranteed_weekly_hours: '', guarantee_enabled: false, day_mark_mode: false });
  const [editRateSaving, setEditRateSaving] = useState(false);

  const [editPermForm, setEditPermForm] = useState({ full_access: true, keys: {} });
  const [editPermSaving, setEditPermSaving] = useState(false);

  const [editWorkerUpdatedAt, setEditWorkerUpdatedAt] = useState(null);

  const [editWorkerAccessForm, setEditWorkerAccessForm] = useState({ all_workers: true, ids: new Set() });
  const [editWorkerAccessSaving, setEditWorkerAccessSaving] = useState(false);
  const [editMessagingForm, setEditMessagingForm] = useState({ blocked: false, blockedIds: new Set() });
  const [editMessagingSaving, setEditMessagingSaving] = useState(false);

  // Invite
  const [inviteSending, setInviteSending] = useState(new Set());
  const [invitedIds, setInvitedIds] = useState(new Set());
  const [clearingBounce, setClearingBounce] = useState(new Set());

  // History
  const [archived, setArchived] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [loadingArchived, setLoadingArchived] = useState(false);
  const [archivedFetched, setArchivedFetched] = useState(false);
  const [pendingRemoveId, setPendingRemoveId] = useState(null);

  // Classifications for Certified Payroll — fetched only when the feature is on.
  const [classifications, setClassifications] = useState([]);
  useEffect(() => {
    if (!trackClassifications) return;
    api.get('/certified-payroll/classifications')
      .then(r => setClassifications(r.data.active || []))
      .catch(silentError('manageworkers'));
  }, [trackClassifications]);

  // Phase B: company roles for the role picker on the worker edit form.
  // Falls back to an empty list if the endpoint 403s (admin without
  // assign_roles can't see them; legacy admin-only role select still shows).
  const [availableRoles, setAvailableRoles] = useState([]);
  useEffect(() => {
    api.get('/admin/roles')
      .then(r => {
        const roles = r.data || [];
        setAvailableRoles(roles);
        setForm(current => {
          if (current.role_id != null) return current;
          const matchedRole = findBuiltinRole(roles, current.role);
          return matchedRole
            ? { ...current, role_id: matchedRole.id, role: matchedRole.parent_role }
            : current;
        });
        setInviteForm(current => {
          if (current.role_id != null) return current;
          const matchedRole = findBuiltinRole(roles, current.role);
          return matchedRole
            ? { ...current, role_id: matchedRole.id, role: matchedRole.parent_role }
            : current;
        });
      })
      .catch(silentError('manageworkers-roles'));
  }, []);

  // ── Add form helpers ────────────────────────────────────────────────────────
  // Warn on tab-close only while the add/invite panel is open and touched.
  // beforeunload only catches full-document unloads; in-app cancel just
  // resets the flag below.
  useUnsavedChanges(showForm && formTouched);
  const set = (k, v) => { setFormTouched(true); setForm(f => ({ ...f, [k]: v })); };
  const setInvite = (k, v) => { setFormTouched(true); setInviteForm(f => ({ ...f, [k]: v })); };

  const updateAutoUsername = (first, last) => {
    if (usernameEdited) return;
    const suggested = (first.charAt(0) + last).toLowerCase().replace(/[^a-z0-9]/g, '');
    setForm(f => ({ ...f, username: suggested }));
    setUsernameTaken(false);
  };

  const handleFirstNameChange = v => {
    setFormTouched(true);
    setForm(f => ({ ...f, first_name: v }));
    updateAutoUsername(v, form.last_name);
  };
  const handleLastNameChange = v => {
    setFormTouched(true);
    setForm(f => ({ ...f, last_name: v }));
    updateAutoUsername(form.first_name, v);
  };

  const checkUsername = async username => {
    if (!username) return;
    setUsernameChecking(true);
    try {
      const r = await api.get('/admin/workers/check-username', { params: { username } });
      setUsernameTaken(r.data.taken);
    } catch (err) { silentError('check-username')(err); }
    finally { setUsernameChecking(false); }
  };

  const handleAdd = async e => {
    e.preventDefault();
    setError(''); setArchivedConflict(null); setSaving(true);
    try {
      const full_name = [form.first_name, form.last_name].filter(Boolean).join(' ');
      const r = await api.post('/admin/workers', { ...form, full_name });
      onWorkerAdded(r.data);
      toast(t.workerCreated, 'success');
      const workerType = form.worker_type;
      setForm(createAddForm(defaultRate, defaultTempPassword, availableRoles));
      setUsernameEdited(false); setUsernameTaken(false); setShowForm(false); setFormTouched(false);
      // Offer to create as QBO Vendor if connected and worker is contractor/subcontractor
      if (qboConnected && (workerType === 'contractor' || workerType === 'subcontractor')) {
        setQboVendorPrompt({ user_id: r.data.id, display_name: r.data.full_name });
        setQboVendorResult(null);
      }
    } catch (err) {
      const data = err.response?.data;
      if (data?.archived_id) { setArchivedConflict({ id: data.archived_id, name: data.archived_name }); setError(data.error); }
      else setError(data?.error || 'Failed to create user');
    } finally { setSaving(false); }
  };

  const handleInvite = async e => {
    e.preventDefault();
    setInviteError(''); setInviteSaving(true);
    try {
      const inv_full_name = [inviteForm.first_name, inviteForm.last_name].filter(Boolean).join(' ');
      const { role_id, ...inviteFields } = inviteForm;
      const r = await api.post('/admin/workers/invite', {
        ...inviteFields,
        ...(role_id != null ? { role_id } : {}),
        full_name: inv_full_name,
      });
      onWorkerAdded(r.data);
      setFormTouched(false);
      if (r.data.email_sent === false) {
        setInviteError(t.workerInviteEmailFailed);
        setInviteForm(createInviteForm(defaultRate, availableRoles));
      } else {
        setInviteSent(inviteForm.email);
        setTimeout(() => setInviteSent(''), 6000);
        setInviteForm(createInviteForm(defaultRate, availableRoles));
      }
    } catch (err) {
      setInviteError(err.response?.data?.error || 'Failed to send invite');
    } finally { setInviteSaving(false); }
  };

  const handleRestoreConflict = async () => {
    if (!archivedConflict) return;
    await handleRestore(archivedConflict.id);
    setArchivedConflict(null); setError(''); setShowForm(false);
  };

  const createQboVendor = async () => {
    if (!qboVendorPrompt) return;
    setQboVendorCreating(true);
    try {
      await api.post('/qbo/workers/create-vendor', {
        user_id: qboVendorPrompt.user_id,
        display_name: qboVendorPrompt.display_name,
      });
      setQboVendorResult('ok');
    } catch {
      setQboVendorResult('error');
    } finally { setQboVendorCreating(false); }
  };

  // ── Expand / panel edit helpers ─────────────────────────────────────────────
  const cancelEdit = () => { setEditingId(null); setEditSection(null); setEditUsernameTaken(false); };

  const toggleExpand = id => {
    if (expandedId === id) { setExpandedId(null); cancelEdit(); }
    else { setExpandedId(id); cancelEdit(); }
  };

  const startEditInfo = w => {
    setEditingId(w.id); setEditSection('info');
    setEditWorkerUpdatedAt(w.updated_at || null);
    setEditInfoForm({ full_name: w.full_name, invoice_name: w.invoice_name || '', email: w.email || '', role: w.role, role_id: resolveWorkerRoleId(w, availableRoles), language: w.language || 'English', worker_type: w.worker_type || 'employee', classification: w.classification || '' });
    // Snapshot the original role_id so saveInfo knows whether to fire the
    // separate /admin/workers/:id/role call (which has the last-Owner check).
    setOriginalRoleId(w.role_id ?? null);
  };

  const startEditUsername = w => {
    setEditingId(w.id); setEditSection('username');
    setEditWorkerUpdatedAt(w.updated_at || null);
    setEditUsernameVal(w.username); setEditUsernameTaken(false);
  };

  const startEditRate = w => {
    setEditingId(w.id); setEditSection('rate');
    setEditWorkerUpdatedAt(w.updated_at || null);
    const gwh = w.guaranteed_weekly_hours != null ? parseFloat(w.guaranteed_weekly_hours) : null;
    setEditRateForm({
      rate: String(w.hourly_rate ?? 0),
      rate_type: w.rate_type || 'hourly',
      overtime_rule: w.overtime_rule || 'daily',
      guarantee_enabled: gwh != null && gwh > 0,
      guaranteed_weekly_hours: gwh != null ? String(gwh) : '40',
      day_mark_mode: !!w.day_mark_mode,
    });
  };

  const checkEditUsername = async (username, workerId) => {
    if (!username) return;
    setEditUsernameChecking(true);
    try {
      const r = await api.get('/admin/workers/check-username', { params: { username, exclude_id: workerId } });
      setEditUsernameTaken(r.data.taken);
    } catch (err) { silentError('check-username-edit')(err); }
    finally { setEditUsernameChecking(false); }
  };

  const saveInfo = async id => {
    setEditInfoSaving(true);
    try {
      // If role_id changed, send it to the dedicated endpoint first — that's
      // the one with the last-Owner guard. If that fails (e.g., last-Owner),
      // we abort before mutating any other fields.
      if (editInfoForm.role_id != null && editInfoForm.role_id !== originalRoleId) {
        await api.patch(`/admin/workers/${id}/role`, { role_id: editInfoForm.role_id });
      }
      // Strip role_id and the legacy role from the bulk update — the role
      // endpoint above already set both. Sending role here would re-overwrite
      // role_id with whatever we computed from the parent.
      const { role_id: _omit1, role: _omit2, ...rest } = editInfoForm;
      const r = await api.patch(`/admin/workers/${id}`, { ...rest, updated_at: editWorkerUpdatedAt });
      onWorkerUpdated(r.data);
      cancelEdit();
    } catch (err) {
      const msg = err.response?.status === 409 ? t.concurrentModification : err.response?.data?.error || 'Failed to update';
      toast(msg, 'error');
    } finally { setEditInfoSaving(false); }
  };

  const saveUsername = async id => {
    setEditUsernameSaving(true);
    try {
      const r = await api.patch(`/admin/workers/${id}`, { username: editUsernameVal, updated_at: editWorkerUpdatedAt });
      onWorkerUpdated(r.data);
      cancelEdit();
    } catch (err) {
      const msg = err.response?.status === 409 ? t.concurrentModification : err.response?.data?.error || 'Username already taken';
      toast(msg, 'error');
    } finally { setEditUsernameSaving(false); }
  };

  const saveRate = async id => {
    setEditRateSaving(true);
    try {
      const r = await api.patch(`/admin/workers/${id}`, {
        hourly_rate: editRateForm.rate,
        rate_type: editRateForm.rate_type,
        overtime_rule: editRateForm.overtime_rule,
        guaranteed_weekly_hours: editRateForm.guarantee_enabled
          ? (parseFloat(editRateForm.guaranteed_weekly_hours) || 40)
          : null,
        // day_mark_mode only meaningful for daily workers; harmless for hourly
        day_mark_mode: editRateForm.rate_type === 'daily' ? editRateForm.day_mark_mode : false,
        updated_at: editWorkerUpdatedAt,
      });
      onWorkerUpdated(r.data);
      cancelEdit();
    } catch (err) {
      const msg = err.response?.status === 409 ? t.concurrentModification : err.response?.data?.error || 'Failed to update';
      toast(msg, 'error');
    } finally { setEditRateSaving(false); }
  };

  const startEditPermissions = w => {
    setEditingId(w.id); setEditSection('permissions');
    const fullAccess = w.admin_permissions == null;
    const defaultKeys = permLabels(t).reduce((acc, { key }) => ({ ...acc, [key]: true }), {});
    setEditPermForm({ full_access: fullAccess, keys: fullAccess ? defaultKeys : { ...defaultKeys, ...w.admin_permissions } });
  };

  const savePermissions = async id => {
    setEditPermSaving(true);
    try {
      const perms = editPermForm.full_access ? null : editPermForm.keys;
      const r = await api.patch(`/admin/workers/${id}/permissions`, { admin_permissions: perms });
      onWorkerUpdated(r.data);
      cancelEdit();
    } catch (err) { toast(err.response?.data?.error || t.failedUpdatePermissions, 'error'); }
    finally { setEditPermSaving(false); }
  };

  const startEditWorkerAccess = w => {
    setEditingId(w.id); setEditSection('worker-access');
    const allWorkers = !w.worker_access_ids || w.worker_access_ids.length === 0;
    setEditWorkerAccessForm({ all_workers: allWorkers, ids: new Set(w.worker_access_ids || []) });
  };

  const saveWorkerAccess = async id => {
    setEditWorkerAccessSaving(true);
    try {
      const ids = editWorkerAccessForm.all_workers ? null : Array.from(editWorkerAccessForm.ids);
      const r = await api.patch(`/admin/workers/${id}/worker-access`, { worker_access_ids: ids });
      onWorkerUpdated(r.data);
      cancelEdit();
    } catch (err) { toast(err.response?.data?.error || t.failedUpdateWorkerAccess, 'error'); }
    finally { setEditWorkerAccessSaving(false); }
  };

  const startEditMessaging = w => {
    setEditingId(w.id); setEditSection('messaging');
    setEditMessagingForm({ blocked: !!w.messaging_blocked, blockedIds: new Set(w.messaging_blocked_user_ids || []) });
  };

  const saveMessaging = async id => {
    setEditMessagingSaving(true);
    try {
      const r = await api.patch(`/admin/workers/${id}/messaging`, {
        messaging_blocked: editMessagingForm.blocked,
        messaging_blocked_user_ids: Array.from(editMessagingForm.blockedIds),
      });
      onWorkerUpdated(r.data);
      cancelEdit();
    } catch (err) { toast(err.response?.data?.error || t.failedUpdateWorker, 'error'); }
    finally { setEditMessagingSaving(false); }
  };

  // ── Invite helper ────────────────────────────────────────────────────────────
  const sendInvite = async (id) => {
    setInviteSending(s => new Set(s).add(id));
    try {
      const r = await api.post(`/admin/workers/${id}/send-invite`);
      if (r.data.email_sent) {
        setInvitedIds(s => new Set(s).add(id));
      } else {
        toast(t.workerInviteEmailFailed, 'error');
      }
    } catch (err) {
      toast(err.response?.data?.error || t.failedSendInvite, 'error');
    } finally {
      setInviteSending(s => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  // Lift an email suppression. A suppressed worker receives nothing at all —
  // no invite, no password reset — and until this existed there was no way back
  // short of editing the database. Use when the address is right and whatever
  // was wrong at their end is fixed; if the address itself is wrong, just edit
  // it (saving a new address clears the flag on its own).
  const clearBounce = async (id) => {
    setClearingBounce(s => new Set(s).add(id));
    try {
      await api.post(`/admin/workers/${id}/clear-email-bounce`);
      // `workers` is a prop — report up. The parent merges by id, so a partial
      // is enough and avoids refetching the list to drop one flag.
      onWorkerUpdated({ id, email_bounced_at: null, email_bounce_reason: null });
      toast(t.mwEmailBounceCleared, 'success');
    } catch (err) {
      toast(err.response?.data?.error || t.mwEmailBounceClearFailed, 'error');
    } finally {
      setClearingBounce(s => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  // ── Archive helpers ──────────────────────────────────────────────────────────
  const loadArchived = async () => {
    if (archivedFetched) return;
    setLoadingArchived(true);
    try {
      const r = await api.get('/admin/workers/archived');
      setArchived(r.data); setArchivedFetched(true);
    } finally { setLoadingArchived(false); }
  };

  const handleRemove = async (id) => {
    setPendingRemoveId(null);
    try {
      await api.delete(`/admin/workers/${id}`);
      onWorkerDeleted(id);
      setArchivedFetched(false);
      if (expandedId === id) setExpandedId(null);
    } catch { toast(t.failedRemoveUser, 'error'); }
  };

  const handleRestore = async id => {
    try {
      const r = await api.patch(`/admin/workers/${id}/restore`);
      onWorkerRestored({ ...r.data, total_entries: 0, total_hours: 0, regular_hours: 0, overtime_hours: 0, prevailing_hours: 0 });
      setArchived(prev => prev.filter(w => w.id !== id));
    } catch { toast(t.failedRestoreUser, 'error'); }
  };

  return (
    <div style={s.card} className="manage-workers-card">
      <div style={s.cardHeader} className="manage-workers-card-header">
        <h3 style={s.cardTitle}>{t.users}</h3>
        <button style={s.addBtn} onClick={() => { setShowForm(v => !v); setFormTouched(false); setError(''); setArchivedConflict(null); setInviteError(''); setInviteSent(''); setForm(createAddForm(defaultRate, defaultTempPassword, availableRoles)); setInviteForm(createInviteForm(defaultRate, availableRoles)); setUsernameEdited(false); setAddMode('manual'); }}>
          {showForm ? t.cancel : t.addUser}
        </button>
      </div>

      {showForm && (
        <div style={s.addPanel} className="manage-workers-add-panel">
          <div style={s.modeTabs} className="manage-workers-mode-tabs">
            <button style={addMode === 'manual' ? s.modeTabActive : s.modeTab} onClick={() => setAddMode('manual')}>{t.addManually}</button>
            <button style={addMode === 'invite' ? s.modeTabActive : s.modeTab} onClick={() => setAddMode('invite')}>{t.inviteByEmail}</button>
          </div>

          {addMode === 'manual' ? (
            <form onSubmit={handleAdd} style={s.addForm} className="manage-workers-form" autoComplete="off">
              {/* Honeypot fields: some browsers (Chrome in particular) ignore
                  autoComplete="off" on the real username/password and look for
                  the first such fields in the form to autofill. These invisible
                  decoys absorb that autofill so the admin's own credentials
                  don't end up prefilled into the real fields below. */}
              <input type="text"     name="fake-username" autoComplete="username"      tabIndex={-1} aria-hidden="true" style={{ position: 'absolute', left: -9999, width: 1, height: 1, opacity: 0 }} />
              <input type="password" name="fake-password" autoComplete="current-password" tabIndex={-1} aria-hidden="true" style={{ position: 'absolute', left: -9999, width: 1, height: 1, opacity: 0 }} />
              <div style={s.formGrid} className="manage-workers-form-grid">
                <div style={s.fieldGroup}>
                  <label htmlFor="mw-first-name" style={s.label}>{t.firstName}<span style={{ color: '#ef4444', marginLeft: 2 }}>*</span></label>
                  <input id="mw-first-name" name="mw-first-name" autoComplete="off" style={s.input} value={form.first_name} onChange={e => handleFirstNameChange(e.target.value)} required />
                </div>
                <div style={s.fieldGroup}>
                  <label htmlFor="mw-last-name" style={s.label}>{t.lastName}<span style={{ color: '#ef4444', marginLeft: 2 }}>*</span></label>
                  <input id="mw-last-name" name="mw-last-name" autoComplete="off" style={s.input} value={form.last_name} onChange={e => handleLastNameChange(e.target.value)} required />
                </div>
                <div style={s.fieldGroup}>
                  <label htmlFor="mw-username" style={s.label}>{t.username}<span style={{ color: '#ef4444', marginLeft: 2 }}>*</span>{usernameChecking ? ` ${t.mwChecking}` : usernameTaken ? ` ${t.mwTaken}` : ''}</label>
                  <input
                    id="mw-username"
                    name="mw-new-username"
                    autoComplete="off"
                    style={{ ...s.input, borderColor: usernameTaken ? '#fca5a5' : undefined }}
                    value={form.username}
                    onChange={e => { setUsernameEdited(!!e.target.value); set('username', e.target.value); setUsernameTaken(false); }}
                    onBlur={e => checkUsername(e.target.value)}
                    required
                  />
                </div>
                <div style={s.fieldGroup}>
                  <label htmlFor="mw-password" style={s.label}>{t.temporaryPassword}<span style={{ color: '#ef4444', marginLeft: 2 }}>*</span></label>
                  <div style={{ position: 'relative' }}>
                    <input id="mw-password" name="mw-new-password" autoComplete="new-password" style={{ ...s.input, width: '100%', paddingRight: 36, boxSizing: 'border-box' }} type={showPassword ? 'text' : 'password'} value={form.password} onChange={e => set('password', e.target.value)} required minLength={8} />
                    <button type="button" onClick={() => setShowPassword(v => !v)} style={s.eyeBtn} tabIndex={-1}>{showPassword ? '🙈' : '👁'}</button>
                  </div>
                </div>
                <div style={s.fieldGroup}>
                  <label htmlFor="mw-email" style={s.label}>{t.emailOptional}</label>
                  <input id="mw-email" name="mw-new-email" autoComplete="off" style={s.input} type="email" value={form.email} onChange={e => set('email', e.target.value)} />
                </div>
                <div style={s.fieldGroup}>
                  <label htmlFor="mw-role" style={s.label}>{t.role}</label>
                  <select
                    id="mw-role"
                    style={s.input}
                    value={form.role_id ?? ''}
                    onChange={e => {
                      const id = e.target.value ? parseInt(e.target.value) : '';
                      const picked = availableRoles.find(r => r.id === id);
                      setFormTouched(true);
                      // Keep legacy `form.role` in sync with the chosen role's parent
                      // so the existing POST handler still routes it correctly during
                      // Phase B's coexistence window.
                      setForm(f => ({ ...f, role_id: id || null, role: picked?.parent_role || 'worker' }));
                    }}
                  >
                    {availableRoles.length === 0 && (
                      <>
                        <option value="">{workerLabel}</option>
                      </>
                    )}
                    {availableRoles.map(r => (
                      <option key={r.id} value={r.id}>{r.name}{r.is_builtin ? '' : ` (${r.parent_role})`}</option>
                    ))}
                  </select>
                </div>
                <div style={s.fieldGroup}>
                  <label htmlFor="mw-worker-type" style={s.label}>{t.mwWorkerType}</label>
                  <select id="mw-worker-type" style={s.input} value={form.worker_type} onChange={e => set('worker_type', e.target.value)}>
                    <option value="employee">{t.mwTypeEmployee}</option>
                    <option value="contractor">{t.mwTypeContractor}</option>
                    <option value="subcontractor">{t.mwTypeSubcontractor}</option>
                    <option value="unpaid">{t.mwTypeUnpaid}</option>
                    <option value="owner">{t.mwTypeOwner}</option>
                  </select>
                </div>
                {trackClassifications && (
                  <div style={s.fieldGroup}>
                    <label htmlFor="mw-classification" style={s.label}>{t.mwJobClassification} <span style={{ color: '#6b7280', fontSize: 12, fontWeight: 400 }}>{t.mwOptional}</span></label>
                    <select id="mw-classification" style={s.input} value={form.classification} onChange={e => set('classification', e.target.value)}>
                      <option value="">{t.mwNoneOption}</option>
                      {classifications.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                )}
                <div style={s.fieldGroup}>
                  <label htmlFor="mw-language" style={s.label}>{t.language}</label>
                  <select id="mw-language" style={s.input} value={form.language} onChange={e => set('language', e.target.value)}>
                    {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
                {showRate && (
                  <>
                    <div style={s.fieldGroup}>
                      <label htmlFor="mw-hourly-rate" style={s.label}>{t.payRate}</label>
                      <input id="mw-hourly-rate" style={s.input} type="number" min="0" step="0.01" value={form.hourly_rate} onChange={e => set('hourly_rate', e.target.value)} />
                    </div>
                    <div style={s.fieldGroup}>
                      <label htmlFor="mw-rate-type" style={s.label}>{t.rateType}</label>
                      <select id="mw-rate-type" style={s.input} value={form.rate_type} onChange={e => set('rate_type', e.target.value)}>
                        {rateTypes.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    </div>
                    <div style={s.fieldGroup}>
                      <label htmlFor="mw-overtime-rule" style={s.label}>{t.overtimeRule}</label>
                      <select id="mw-overtime-rule" style={s.input} value={form.overtime_rule} onChange={e => set('overtime_rule', e.target.value)}>
                        {overtimeRules.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    </div>
                  </>
                )}
              </div>
              {error && (
                <div role="alert" style={s.errorBox}>
                  <span style={s.errorText}>{error}</span>
                  {archivedConflict && <button type="button" style={s.restoreInlineBtn} onClick={handleRestoreConflict}>{t.restore} {archivedConflict.name}</button>}
                </div>
              )}
              <button style={{ ...s.saveBtn, ...((saving || usernameTaken) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={saving || usernameTaken}>{saving ? t.creating : t.createUser}</button>
            </form>
          ) : (
            <form onSubmit={handleInvite} style={s.addForm} className="manage-workers-form">
              {inviteSent ? (
                <div style={s.inviteSuccess}>
                  {t.inviteSentPrefix} <strong>{inviteSent}</strong>.{' '}
                  <button type="button" style={s.restoreInlineBtn} onClick={() => setInviteSent('')}>{t.sendAnother}</button>
                </div>
              ) : (
                <>
                  <div style={s.formGrid} className="manage-workers-form-grid">
                    <div style={s.fieldGroup}>
                      <label htmlFor="mw-inv-first-name" style={s.label}>{t.firstName}<span style={s.requiredStar}>*</span></label>
                      <input id="mw-inv-first-name" style={s.input} value={inviteForm.first_name} onChange={e => setInvite('first_name', e.target.value)} required />
                    </div>
                    <div style={s.fieldGroup}>
                      <label htmlFor="mw-inv-last-name" style={s.label}>{t.lastName}<span style={s.requiredStar}>*</span></label>
                      <input id="mw-inv-last-name" style={s.input} value={inviteForm.last_name} onChange={e => setInvite('last_name', e.target.value)} required />
                    </div>
                    <div style={s.fieldGroup}>
                      <label htmlFor="mw-inv-email" style={s.label}>{t.email}<span style={s.requiredStar}>*</span></label>
                      <input id="mw-inv-email" style={s.input} type="email" value={inviteForm.email} onChange={e => setInvite('email', e.target.value)} required />
                    </div>
                    <div style={s.fieldGroup}>
                      <label htmlFor="mw-inv-role" style={s.label}>{t.role}</label>
                      <select
                        id="mw-inv-role"
                        style={s.input}
                        value={availableRoles.length > 0 ? (inviteForm.role_id ?? '') : inviteForm.role}
                        onChange={e => {
                          setFormTouched(true);
                          if (availableRoles.length === 0) {
                            setInviteForm(current => ({ ...current, role: e.target.value, role_id: null }));
                            return;
                          }
                          const roleId = Number(e.target.value);
                          const selectedRole = availableRoles.find(role => Number(role.id) === roleId);
                          setInviteForm(current => ({
                            ...current,
                            role_id: selectedRole?.id ?? null,
                            role: selectedRole?.parent_role || 'worker',
                          }));
                        }}
                      >
                        {availableRoles.length === 0 && (
                          <>
                            <option value="worker">{workerLabel}</option>
                            <option value="admin">{t.adminRole}</option>
                          </>
                        )}
                        {availableRoles.map(role => (
                          <option key={role.id} value={role.id}>
                            {role.name}{role.is_builtin ? '' : ` (${role.parent_role})`}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div style={s.fieldGroup}>
                      <label htmlFor="mw-inv-worker-type" style={s.label}>{t.mwWorkerType}</label>
                      <select id="mw-inv-worker-type" style={s.input} value={inviteForm.worker_type} onChange={e => setInvite('worker_type', e.target.value)}>
                        <option value="employee">{t.mwTypeEmployee}</option>
                        <option value="contractor">{t.mwTypeContractor}</option>
                        <option value="subcontractor">{t.mwTypeSubcontractor}</option>
                    <option value="unpaid">{t.mwTypeUnpaid}</option>
                        <option value="owner">{t.mwTypeOwner}</option>
                      </select>
                    </div>
                    {trackClassifications && (
                      <div style={s.fieldGroup}>
                        <label htmlFor="mw-inv-classification" style={s.label}>{t.mwJobClassification} <span style={{ color: '#6b7280', fontSize: 12, fontWeight: 400 }}>{t.mwOptional}</span></label>
                        <select id="mw-inv-classification" style={s.input} value={inviteForm.classification} onChange={e => setInvite('classification', e.target.value)}>
                          <option value="">{t.mwNoneOption}</option>
                          {classifications.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                    )}
                    <div style={s.fieldGroup}>
                      <label htmlFor="mw-inv-language" style={s.label}>{t.language}</label>
                      <select id="mw-inv-language" style={s.input} value={inviteForm.language} onChange={e => setInvite('language', e.target.value)}>
                        {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                      </select>
                    </div>
                    {showRate && (
                      <>
                        <div style={s.fieldGroup}>
                          <label htmlFor="mw-inv-rate" style={s.label}>{t.payRate}</label>
                          <input id="mw-inv-rate" style={s.input} type="number" min="0" step="0.01" value={inviteForm.hourly_rate} onChange={e => setInvite('hourly_rate', e.target.value)} />
                        </div>
                        <div style={s.fieldGroup}>
                          <label htmlFor="mw-inv-rate-type" style={s.label}>{t.rateType}</label>
                          <select id="mw-inv-rate-type" style={s.input} value={inviteForm.rate_type} onChange={e => setInvite('rate_type', e.target.value)}>
                            {rateTypes.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                          </select>
                        </div>
                        <div style={s.fieldGroup}>
                          <label htmlFor="mw-inv-overtime-rule" style={s.label}>{t.overtimeRule}</label>
                          <select id="mw-inv-overtime-rule" style={s.input} value={inviteForm.overtime_rule} onChange={e => setInvite('overtime_rule', e.target.value)}>
                            {overtimeRules.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                          </select>
                        </div>
                      </>
                    )}
                  </div>
                  {inviteError && <p style={s.errorText}>{inviteError}</p>}
                  <button style={{ ...s.saveBtn, ...(inviteSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} type="submit" disabled={inviteSaving}>{inviteSaving ? t.sendingInvite : t.sendInvite}</button>
                </>
              )}
            </form>
          )}
        </div>
      )}

      {workers.length === 0 ? (
        <EmptyState
          mark="T"
          title={`No ${workerLabel.toLowerCase()} records yet`}
          body={`Add your first ${workerLabel.toLowerCase()} using the form above.`}
        />
      ) : (
        <div style={s.list}>
          {workers.map(w => {
            const isExpanded = expandedId === w.id;
            const isEditing = editingId === w.id;
            return (
              <div key={w.id} style={s.item}>
                <button style={s.itemBar} onClick={() => toggleExpand(w.id)}>
                  <div style={s.itemLeft}>
                    <span style={s.itemName}>{w.full_name}</span>
                    <span style={s.itemUsername}>@{w.username}</span>
                    <RoleBadge worker={w} availableRoles={availableRoles} workerLabel={workerLabel} />
                  </div>
                  <span style={{ ...s.chevron, transform: isExpanded ? 'rotate(180deg)' : 'none' }}>▾</span>
                </button>

                {isExpanded && (
                  <div style={s.panel}>

                    {/* ── Profile section ── */}
                    {identityEditable && (
                      <div style={s.section}>
                        <div style={s.sectionHeader}>
                          <span style={s.sectionTitle}>{t.profile}</span>
                          {(!isEditing || editSection !== 'info') && (
                            <button style={s.sectionBtn} onClick={() => isEditing && editSection === 'info' ? cancelEdit() : startEditInfo(w)}>{t.edit}</button>
                          )}
                        </div>
                        {isEditing && editSection === 'info' ? (
                          <div style={s.editBlock}>
                            <div style={s.formGrid} className="manage-workers-form-grid">
                              <div style={s.fieldGroup}>
                                <label htmlFor="mw-edit-full-name" style={s.label}>{t.fullName}</label>
                                <input id="mw-edit-full-name" style={s.input} value={editInfoForm.full_name} onChange={e => setEditInfoForm(f => ({ ...f, full_name: e.target.value }))} />
                              </div>
                              <div style={s.fieldGroup}>
                                <label htmlFor="mw-edit-invoice-name" style={s.label}>{t.mwInvoiceName} <span style={{ color: '#6b7280', fontWeight: 400 }}>{t.mwOptional}</span></label>
                                <input id="mw-edit-invoice-name" style={s.input} value={editInfoForm.invoice_name} onChange={e => setEditInfoForm(f => ({ ...f, invoice_name: e.target.value }))} placeholder={t.invoiceNamePlaceholder} />
                              </div>
                              <div style={s.fieldGroup}>
                                <label htmlFor="mw-edit-email" style={s.label}>{t.email}</label>
                                <input id="mw-edit-email" style={s.input} type="email" value={editInfoForm.email} onChange={e => setEditInfoForm(f => ({ ...f, email: e.target.value }))} />
                              </div>
                              <div style={s.fieldGroup}>
                                <label htmlFor="mw-edit-role" style={s.label}>{t.role}</label>
                                <select
                                  id="mw-edit-role"
                                  style={s.input}
                                  value={editInfoForm.role_id ?? ''}
                                  onChange={e => setEditInfoForm(f => ({ ...f, role_id: e.target.value ? parseInt(e.target.value) : null }))}
                                >
                                  {availableRoles.length === 0 && <option value="">—</option>}
                                  {availableRoles.map(r => (
                                    <option key={r.id} value={r.id}>{r.name}{r.is_builtin ? '' : ` (${r.parent_role})`}</option>
                                  ))}
                                </select>
                              </div>
                              <div style={s.fieldGroup}>
                                <label htmlFor="mw-edit-worker-type" style={s.label}>{t.mwWorkerType}</label>
                                <select id="mw-edit-worker-type" style={s.input} value={editInfoForm.worker_type || 'employee'} onChange={e => setEditInfoForm(f => ({ ...f, worker_type: e.target.value }))}>
                                  <option value="employee">{t.mwTypeEmployee}</option>
                                  <option value="contractor">{t.mwTypeContractor}</option>
                                  <option value="subcontractor">{t.mwTypeSubcontractor}</option>
                    <option value="unpaid">{t.mwTypeUnpaid}</option>
                                  <option value="owner">{t.mwTypeOwner}</option>
                                </select>
                              </div>
                              <div style={s.fieldGroup}>
                                <label htmlFor="mw-edit-language" style={s.label}>{t.language}</label>
                                <select id="mw-edit-language" style={s.input} value={editInfoForm.language} onChange={e => setEditInfoForm(f => ({ ...f, language: e.target.value }))}>
                                  {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
                                </select>
                              </div>
                              {trackClassifications && (
                                <div style={s.fieldGroup}>
                                  <label htmlFor="mw-edit-classification" style={s.label}>{t.mwJobClassification}</label>
                                  <select
                                    id="mw-edit-classification"
                                    style={s.input}
                                    value={editInfoForm.classification || ''}
                                    onChange={e => setEditInfoForm(f => ({ ...f, classification: e.target.value }))}
                                  >
                                    <option value="">{t.mwNoneOption}</option>
                                    {classifications.map(c => <option key={c} value={c}>{c}</option>)}
                                    {editInfoForm.classification && !classifications.includes(editInfoForm.classification) && (
                                      <option value={editInfoForm.classification}>{editInfoForm.classification} {t.mwNotInList}</option>
                                    )}
                                  </select>
                                </div>
                              )}
                            </div>
                            <div style={s.editActions} className="manage-workers-actions">
                              <button style={{ ...s.saveBtn, ...(editInfoSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => saveInfo(w.id)} disabled={editInfoSaving}>{editInfoSaving ? t.loading : t.save}</button>
                              <button style={s.cancelBtn} onClick={cancelEdit}>{t.cancel}</button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div style={s.infoGrid}>
                              <span style={s.infoLabel}>{t.mwName}</span>
                              <span style={s.infoValue}>{w.full_name}</span>
                              {w.invoice_name && <>
                                <span style={s.infoLabel}>{t.mwInvoiceName}</span>
                                <span style={s.infoValue}>{w.invoice_name}</span>
                              </>}
                              <span style={s.infoLabel}>{t.email}</span>
                              <span style={s.infoValue}>{w.email || <em style={{ color: '#6b7280' }}>{t.notSet}</em>}</span>
                              <span style={s.infoLabel}>{t.language}</span>
                              <span style={s.infoValue}>{w.language || 'English'}</span>
                              <span style={s.infoLabel}>{t.role}</span>
                              <span style={s.infoValue}><RoleBadge worker={w} availableRoles={availableRoles} /></span>
                              <span style={s.infoLabel}>{t.mwWorkerType}</span>
                              <span style={s.infoValue}>{workerTypeLabel(w.worker_type || 'employee', t)}</span>
                              {trackClassifications && (
                                <>
                                  <span style={s.infoLabel}>{t.mwClassification}</span>
                                  <span style={s.infoValue}>{w.classification || <em style={{ color: '#6b7280' }}>{t.notSet}</em>}</span>
                                </>
                              )}
                            </div>
                            {/* A suppressed address gets NO mail — not the invite
                                below, not a password reset. Show it first: it's
                                the reason the invite never arrives, and without
                                this banner the whole thing is invisible. */}
                            {w.email_bounced_at && (
                              <div style={s.bounceBanner}>
                                <span style={s.bounceBannerText}>
                                  {t.mwEmailBouncing}
                                  {w.email_bounce_reason && <span style={s.bounceReason}>{w.email_bounce_reason}</span>}
                                </span>
                                <button
                                  style={{ ...s.bounceBtn, ...(clearingBounce.has(w.id) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                                  onClick={() => clearBounce(w.id)}
                                  disabled={clearingBounce.has(w.id)}
                                >
                                  {clearingBounce.has(w.id) ? t.mwSendingEllipsis : t.mwEmailBounceRetry}
                                </button>
                              </div>
                            )}
                            {w.must_change_password && w.email && (
                              <div style={s.inviteBanner}>
                                <span style={s.inviteBannerText}>{t.mwHasNotSignedIn}</span>
                                {invitedIds.has(w.id) ? (
                                  <span style={s.inviteSentLabel}>{t.mwInviteSent}</span>
                                ) : (
                                  <button style={{ ...s.inviteBtn, ...(inviteSending.has(w.id) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => sendInvite(w.id)} disabled={inviteSending.has(w.id)}>
                                    {inviteSending.has(w.id) ? t.mwSendingEllipsis : t.mwSendInviteEmail}
                                  </button>
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}

                    {/* ── Username section ── */}
                    {identityEditable && (
                      <div style={s.section}>
                        <div style={s.sectionHeader}>
                          <span style={s.sectionTitle}>{t.usernameSection}</span>
                          {(!isEditing || editSection !== 'username') && (
                            <button style={s.sectionBtn} onClick={() => isEditing && editSection === 'username' ? cancelEdit() : startEditUsername(w)}>{t.changeUsername}</button>
                          )}
                        </div>
                        {isEditing && editSection === 'username' ? (
                          <div style={s.editBlock}>
                            <div style={s.fieldGroup}>
                              <label htmlFor="mw-edit-username" style={s.label}>{t.newUsername}{editUsernameChecking ? ` ${t.mwChecking}` : editUsernameTaken ? ` ${t.mwTaken}` : ''}</label>
                              <input
                                id="mw-edit-username"
                                style={{ ...s.input, borderColor: editUsernameTaken ? '#fca5a5' : undefined, maxWidth: 240 }}
                                value={editUsernameVal}
                                onChange={e => { setEditUsernameVal(e.target.value); setEditUsernameTaken(false); }}
                                onBlur={e => checkEditUsername(e.target.value, w.id)}
                              />
                            </div>
                            <div style={s.editActions} className="manage-workers-actions">
                              <button style={{ ...s.saveBtn, ...((editUsernameSaving || editUsernameTaken) ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => saveUsername(w.id)} disabled={editUsernameSaving || editUsernameTaken}>{editUsernameSaving ? t.loading : t.save}</button>
                              <button style={s.cancelBtn} onClick={cancelEdit}>{t.cancel}</button>
                            </div>
                          </div>
                        ) : (
                          <span style={s.infoMono}>@{w.username}</span>
                        )}
                      </div>
                    )}

                    {/* ── Pay Rate section ── */}
                    {showRate && (
                      <div style={s.section}>
                        <div style={s.sectionHeader}>
                          <span style={s.sectionTitle}>{t.payRateSection}</span>
                          {(!isEditing || editSection !== 'rate') && (
                            <button style={s.sectionBtn} onClick={() => isEditing && editSection === 'rate' ? cancelEdit() : startEditRate(w)}>{t.edit}</button>
                          )}
                        </div>
                        {isEditing && editSection === 'rate' ? (
                          <div style={s.editBlock}>
                            <div style={s.formGrid} className="manage-workers-form-grid">
                              <div style={s.fieldGroup}>
                                <label htmlFor="mw-edit-rate" style={s.label}>{t.amount}</label>
                                <input id="mw-edit-rate" style={{ ...s.input, maxWidth: 120 }} type="number" min="0" step="0.01" value={editRateForm.rate} onChange={e => setEditRateForm(f => ({ ...f, rate: e.target.value }))} />
                              </div>
                              <div style={s.fieldGroup}>
                                <label htmlFor="mw-edit-rate-type" style={s.label}>{t.rateType}</label>
                                <select id="mw-edit-rate-type" style={s.input} value={editRateForm.rate_type} onChange={e => setEditRateForm(f => ({ ...f, rate_type: e.target.value }))}>
                                  {rateTypes.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                                </select>
                              </div>
                              <div style={s.fieldGroup}>
                                <label htmlFor="mw-edit-overtime-rule" style={s.label}>{t.overtimeRule}</label>
                                <select id="mw-edit-overtime-rule" style={s.input} value={editRateForm.overtime_rule} onChange={e => setEditRateForm(f => ({ ...f, overtime_rule: e.target.value }))}>
                                  {overtimeRules.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                                </select>
                              </div>
                            </div>
                            {editRateForm.rate_type === 'daily' && (
                              <div style={{ marginBottom: 10 }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: '#374151', userSelect: 'none' }}>
                                  <input
                                    type="checkbox"
                                    checked={editRateForm.day_mark_mode}
                                    onChange={e => setEditRateForm(f => ({ ...f, day_mark_mode: e.target.checked }))}
                                  />
                                  <span style={{ fontWeight: 600 }}>{t.mwDayMarkMode || 'Clock-in marks full day'}</span>
                                </label>
                                <div style={{ fontSize: 12, color: '#6b7280', marginLeft: 24, marginTop: 4 }}>
                                  {t.mwDayMarkModeHint || 'Worker taps once per day — no clock-out. The entry counts as a full day immediately.'}
                                </div>
                              </div>
                            )}
                            <div style={{ marginBottom: 10 }}>
                              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: '#374151', userSelect: 'none' }}>
                                <input
                                  type="checkbox"
                                  checked={editRateForm.guarantee_enabled}
                                  onChange={e => setEditRateForm(f => ({ ...f, guarantee_enabled: e.target.checked }))}
                                />
                                <span style={{ fontWeight: 600 }}>{t.mwWeeklyMinGuarantee}</span>
                              </label>
                              {editRateForm.guarantee_enabled && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, marginLeft: 24 }}>
                                  <input
                                    style={{ ...s.input, maxWidth: 80 }}
                                    type="number"
                                    min="1"
                                    step="0.5"
                                    value={editRateForm.guaranteed_weekly_hours}
                                    onChange={e => setEditRateForm(f => ({ ...f, guaranteed_weekly_hours: e.target.value }))}
                                  />
                                  <span style={{ fontSize: 13, color: '#6b7280' }}>{t.mwWeeklyMinHint}</span>
                                </div>
                              )}
                            </div>
                            <div style={s.editActions} className="manage-workers-actions">
                              <button style={{ ...s.saveBtn, ...(editRateSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => saveRate(w.id)} disabled={editRateSaving}>{editRateSaving ? t.loading : t.save}</button>
                              <button style={s.cancelBtn} onClick={cancelEdit}>{t.cancel}</button>
                            </div>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                            <span style={s.infoValue}>{fmtRate(w, currency)}</span>
                            <span aria-hidden="true" style={{ color: '#94a3b8', fontSize: 12 }}>-</span>
                            <span style={{ ...s.infoValue, fontSize: 12, color: '#6b7280' }}>
                              {overtimeRules.find(r => r.value === (w.overtime_rule || 'daily'))?.label}
                            </span>
                            {w.guaranteed_weekly_hours != null && parseFloat(w.guaranteed_weekly_hours) > 0 && (
                              <span style={{ ...s.infoValue, fontSize: 12, color: '#2563eb', background: '#dbeafe', padding: '1px 7px', borderRadius: 8 }}>
                                {parseFloat(w.guaranteed_weekly_hours)}{t.mwHwkMin}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* ── Permissions section (admin-role workers only, visible to full-access admins) ── */}
                    {w.role === 'admin' && !w.role_id && !currentUser?.admin_permissions && (
                      <div style={s.section}>
                        <div style={s.sectionHeader}>
                          <span style={s.sectionTitle}>{t.mwPermissions}</span>
                          {(!isEditing || editSection !== 'permissions') && (
                            <button style={s.sectionBtn} onClick={() => startEditPermissions(w)}>{t.edit}</button>
                          )}
                        </div>
                        {isEditing && editSection === 'permissions' ? (
                          <div style={s.editBlock}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#111827' }}>
                              <input
                                type="checkbox"
                                checked={editPermForm.full_access}
                                onChange={e => setEditPermForm(f => ({ ...f, full_access: e.target.checked }))}
                              />
                              {t.mwFullAccessNoRestrictions}
                            </label>
                            {!editPermForm.full_access && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 4, marginTop: 4 }}>
                                {permLabels(t).map(({ key, label }) => (
                                  <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: '#374151' }}>
                                    <input
                                      type="checkbox"
                                      checked={editPermForm.keys[key] === true}
                                      onChange={e => setEditPermForm(f => ({ ...f, keys: { ...f.keys, [key]: e.target.checked } }))}
                                    />
                                    {label}
                                  </label>
                                ))}
                              </div>
                            )}
                            <div style={s.editActions} className="manage-workers-actions">
                              <button style={{ ...s.saveBtn, ...(editPermSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => savePermissions(w.id)} disabled={editPermSaving}>{editPermSaving ? t.loading : t.save}</button>
                              <button style={s.cancelBtn} onClick={cancelEdit}>{t.cancel}</button>
                            </div>
                          </div>
                        ) : (
                          <div>
                            {w.admin_permissions == null
                              ? <span style={{ fontSize: 13, color: '#059669', fontWeight: 600 }}>{t.mwFullAccess}</span>
                              : (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 8px' }}>
                                  {permLabels(t).filter(({ key }) => w.admin_permissions[key]).map(({ key, label }) => (
                                    <span key={key} style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: '#dbeafe', color: '#1e40af' }}>{label}</span>
                                  ))}
                                  {permLabels(t).every(({ key }) => !w.admin_permissions[key]) && (
                                    <span style={{ fontSize: 13, color: '#6b7280' }}>{t.mwNoPermissions}</span>
                                  )}
                                </div>
                              )
                            }
                          </div>
                        )}
                      </div>
                    )}

      {/* ── Team member access section (admin-role users only, visible to full-access admins) ── */}
                    {w.role === 'admin' && !currentUser?.admin_permissions && (
                      <div style={s.section}>
                        <div style={s.sectionHeader}>
                          <span style={s.sectionTitle}>{t.mwWorkerAccess}</span>
                          {(!isEditing || editSection !== 'worker-access') && (
                            <button style={s.sectionBtn} onClick={() => startEditWorkerAccess(w)}>{t.edit}</button>
                          )}
                        </div>
                        {isEditing && editSection === 'worker-access' ? (
                          <div style={s.editBlock}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#111827' }}>
                              <input
                                type="checkbox"
                                checked={editWorkerAccessForm.all_workers}
                                onChange={e => setEditWorkerAccessForm(f => ({ ...f, all_workers: e.target.checked }))}
                              />
                              {t.mwAllWorkers}
                            </label>
                            {!editWorkerAccessForm.all_workers && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 4, marginTop: 4, maxHeight: 220, overflowY: 'auto' }}>
                                {workers.filter(wk => wk.role === 'worker').map(wk => (
                                  <label key={wk.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: '#374151' }}>
                                    <input
                                      type="checkbox"
                                      checked={editWorkerAccessForm.ids.has(wk.id)}
                                      onChange={e => {
                                        setEditWorkerAccessForm(f => {
                                          const ids = new Set(f.ids);
                                          e.target.checked ? ids.add(wk.id) : ids.delete(wk.id);
                                          return { ...f, ids };
                                        });
                                      }}
                                    />
                                    {wk.full_name} <span style={{ color: '#6b7280', fontSize: 12 }}>@{wk.username}</span>
                                  </label>
                                ))}
                              </div>
                            )}
                            <div style={s.editActions} className="manage-workers-actions">
                              <button style={{ ...s.saveBtn, ...(editWorkerAccessSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => saveWorkerAccess(w.id)} disabled={editWorkerAccessSaving}>{editWorkerAccessSaving ? t.loading : t.save}</button>
                              <button style={s.cancelBtn} onClick={cancelEdit}>{t.cancel}</button>
                            </div>
                          </div>
                        ) : (
                          <div>
                            {!w.worker_access_ids || w.worker_access_ids.length === 0
                              ? <span style={{ fontSize: 13, color: '#059669', fontWeight: 600 }}>{t.mwAllWorkers}</span>
                              : (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 8px' }}>
                                  {w.worker_access_ids.map(id => {
                                    const wk = workers.find(x => x.id === id);
                                    return wk ? (
                                      <span key={id} style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: '#f3f4f6', color: '#374151' }}>{wk.full_name}</span>
                                    ) : null;
                                  })}
                                </div>
                              )
                            }
                          </div>
                        )}
                      </div>
                    )}

      {/* ── Messaging block system ── */}
                    {w.id !== currentUser?.id && (
                      <div style={s.section}>
                        <div style={s.sectionHeader}>
                          <span style={s.sectionTitle}>{t.mwMessaging}</span>
                          {(!isEditing || editSection !== 'messaging') && (
                            <button style={s.sectionBtn} onClick={() => startEditMessaging(w)}>{t.edit}</button>
                          )}
                        </div>
                        {isEditing && editSection === 'messaging' ? (
                          <div style={s.editBlock}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#111827' }}>
                              <input
                                type="checkbox"
                                checked={editMessagingForm.blocked}
                                onChange={e => setEditMessagingForm(f => ({ ...f, blocked: e.target.checked }))}
                              />
                              {t.mwMsgBlockAll}
                            </label>
                            <div style={{ fontSize: 12, color: '#6b7280', margin: '4px 0' }}>{t.mwMsgBlockAllDesc}</div>
                            {!editMessagingForm.blocked && (
                              <>
                                <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', marginTop: 6 }}>{t.mwMsgCantMessage}</div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 4, marginTop: 4, maxHeight: 220, overflowY: 'auto' }}>
                                  {workers.filter(wk => wk.id !== w.id).map(wk => (
                                    <label key={wk.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: '#374151' }}>
                                      <input
                                        type="checkbox"
                                        checked={editMessagingForm.blockedIds.has(wk.id)}
                                        onChange={e => {
                                          setEditMessagingForm(f => {
                                            const ids = new Set(f.blockedIds);
                                            e.target.checked ? ids.add(wk.id) : ids.delete(wk.id);
                                            return { ...f, blockedIds: ids };
                                          });
                                        }}
                                      />
                                      {wk.full_name} <span style={{ color: '#6b7280', fontSize: 12 }}>@{wk.username}</span>
                                    </label>
                                  ))}
                                </div>
                              </>
                            )}
                            <div style={s.editActions} className="manage-workers-actions">
                              <button style={{ ...s.saveBtn, ...(editMessagingSaving ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => saveMessaging(w.id)} disabled={editMessagingSaving}>{editMessagingSaving ? t.loading : t.save}</button>
                              <button style={s.cancelBtn} onClick={cancelEdit}>{t.cancel}</button>
                            </div>
                          </div>
                        ) : (
                          <div>
                            {w.messaging_blocked
                              ? <span style={{ fontSize: 13, color: '#dc2626', fontWeight: 600 }}>{t.mwMsgBlockedTag}</span>
                              : (!w.messaging_blocked_user_ids || w.messaging_blocked_user_ids.length === 0)
                                ? <span style={{ fontSize: 13, color: '#059669', fontWeight: 600 }}>{t.mwMsgNoBlocks}</span>
                                : (
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 8px' }}>
                                    {w.messaging_blocked_user_ids.map(id => {
                                      const wk = workers.find(x => x.id === id);
                                      return wk ? (
                                        <span key={id} style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, background: '#fee2e2', color: '#991b1b' }}>{wk.full_name}</span>
                                      ) : null;
                                    })}
                                  </div>
                                )
                            }
                          </div>
                        )}
                      </div>
                    )}

                    {/* ── Certified Payroll SSN last-4 ── */}
                    {!isEditing && canViewCertifiedPayroll && collectSsn && w.role === 'worker' && (
                      <WorkerSsn userId={w.id} />
                    )}

                    {/* ── Certified Payroll fringe benefits ── */}
                    {!isEditing && canViewCertifiedPayroll && trackFringes && w.role === 'worker' && (
                      <WorkerFringes userId={w.id} currency={currency} />
                    )}

                    {/* ── Documents ── */}
                    {!isEditing && <WorkerDocuments workerId={w.id} />}

                    {/* ── Remove ── */}
                    {identityEditable && !isEditing && (
                      <div style={s.removeActions}>
                        {pendingRemoveId === w.id ? (
                          <>
                            <button style={s.confirmRemoveBtn} onClick={() => handleRemove(w.id)}>{t.confirm}</button>
                            <button style={s.cancelRemoveBtn} onClick={() => setPendingRemoveId(null)}>{t.cancel}</button>
                          </>
                        ) : (
                          <button style={s.removeBtn} onClick={() => setPendingRemoveId(w.id)}>{t.removeUser}</button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={s.historyFooter}>
        <button style={s.historyToggle} onClick={() => { setShowHistory(v => !v); loadArchived(); }}>
          {showHistory ? '▾' : '▸'} {t.history} {archived.length > 0 ? `(${archived.length})` : ''}
        </button>
        {showHistory && (
          <div style={s.historyList}>
            {loadingArchived ? <SkeletonList count={3} rows={1} />
              : archived.length === 0 ? (
                <div style={s.emptyState}>
                  <div style={s.emptyStateIcon}>🗑️</div>
                  <p style={s.emptyStateTitle}>{t.noRemovedUsers}</p>
                  <p style={s.emptyStateSubtitle}>{t.mwRemovedWorkersHere}</p>
                </div>
              )
              : archived.map(w => (
                <div key={w.id} style={s.historyItem}>
                  <div style={s.itemLeft}>
                    <span style={{ ...s.itemName, color: '#6b7280' }}>{w.full_name}</span>
                    <span style={{ ...s.itemUsername, color: '#d1d5db' }}>@{w.username}</span>
                    <RoleBadge worker={w} availableRoles={availableRoles} />
                  </div>
                  <button style={s.restoreBtn} onClick={() => handleRestore(w.id)}>{t.restore}</button>
                </div>
              ))
            }
          </div>
        )}
      </div>

      {/* QBO Vendor creation prompt */}
      {qboVendorPrompt && (
        <div style={s.qboPromptOverlay}>
          <ModalShell
            onClose={() => { setQboVendorPrompt(null); setQboVendorResult(null); }}
            titleId="mw-qbo-vendor-title"
            style={s.qboPromptModal}
          >
            <div id="mw-qbo-vendor-title" style={s.qboPromptTitle}>{t.mwQboVendorTitle}</div>
            <p style={s.qboPromptBody}>
              <strong>{qboVendorPrompt.display_name}</strong>{t.mwQboVendorBodyPrefix}
            </p>
            {qboVendorResult === 'ok' && (
              <div style={s.qboPromptSuccess}>{t.mwQboVendorCreated}</div>
            )}
            {qboVendorResult === 'error' && (
              <div style={s.qboPromptError}>{t.mwQboVendorFailed}</div>
            )}
            <div style={s.qboPromptActions} className="ops-modal-actions">
              {!qboVendorResult && (
                <button style={{ ...s.saveBtn, ...(qboVendorCreating ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={createQboVendor} disabled={qboVendorCreating}>
                  {qboVendorCreating ? t.mwQboCreating : t.mwQboYesCreate}
                </button>
              )}
              <button style={s.cancelBtn} onClick={() => { setQboVendorPrompt(null); setQboVendorResult(null); }}>
                {qboVendorResult ? t.mwQboClose : t.mwQboSkip}
              </button>
            </div>
          </ModalShell>
        </div>
      )}
    </div>
  );
}

const s = {
  card: { background: '#fff', borderRadius: 12, padding: 24, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 24 },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  cardTitle: { fontSize: 17, fontWeight: 700, margin: 0 },
  addBtn: { padding: '7px 16px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  addPanel: { background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, marginBottom: 16 },
  modeTabs: { display: 'flex', gap: 4, marginBottom: 14, background: '#f0f4ff', borderRadius: 8, padding: 3, width: 'fit-content' },
  modeTab: { padding: '5px 14px', background: 'none', border: 'none', borderRadius: 6, fontSize: 13, color: '#666', cursor: 'pointer', fontWeight: 500 },
  modeTabActive: { padding: '5px 14px', background: '#fff', border: 'none', borderRadius: 6, fontSize: 13, color: 'var(--ops-page-accent)', cursor: 'pointer', fontWeight: 700, boxShadow: '0 1px 3px rgba(0,0,0,0.1)' },
  addForm: { display: 'flex', flexDirection: 'column', gap: 12 },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 12, fontWeight: 600, color: '#6b7280' },
  requiredStar: { color: '#ef4444', marginLeft: 2, fontWeight: 800 },
  input: { padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 14 },
  eyeBtn: { position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 15, padding: 0, lineHeight: 1 },
  errorBox: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  errorText: { color: '#e53e3e', fontSize: 13 },
  restoreInlineBtn: { background: '#059669', color: '#fff', border: 'none', padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  inviteSuccess: { background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, padding: '12px 16px', fontSize: 13, color: '#166534' },
  saveBtn: { padding: '8px 18px', background: '#059669', color: '#fff', border: 'none', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer', width: 'fit-content' },
  cancelBtn: { padding: '8px 14px', background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', borderRadius: 7, fontSize: 13, cursor: 'pointer' },
  empty: { color: '#6b7280', fontSize: 14, margin: 0 },
  emptyState: { textAlign: 'center', padding: '40px 0 24px' },
  emptyStateIcon: { fontSize: 40, marginBottom: 10 },
  emptyStateTitle: { fontSize: 16, fontWeight: 700, color: '#374151', margin: '0 0 4px' },
  emptyStateSubtitle: { fontSize: 13, color: '#6b7280', margin: 0 },
  list: { display: 'flex', flexDirection: 'column', gap: 2 },
  item: { border: '1px solid #f3f4f6', borderRadius: 8, overflow: 'hidden' },
  itemBar: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', gap: 10 },
  itemLeft: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  itemName: { fontSize: 14, fontWeight: 600, color: '#111827' },
  itemUsername: { fontSize: 13, color: '#6b7280' },
  chevron: { fontSize: 14, color: '#6b7280', transition: 'transform 0.2s', flexShrink: 0, display: 'inline-block' },
  panel: { padding: '4px 16px 16px', borderTop: '1px solid #f3f4f6', background: '#f9fafb', display: 'flex', flexDirection: 'column', gap: 0 },
  removeActions: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, paddingTop: 8 },
  section: { borderBottom: '1px solid #eeeeee', paddingBottom: 12, paddingTop: 12 },
  sectionHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  sectionTitle: { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 },
  sectionBtn: { padding: '3px 12px', background: 'none', border: '1px solid #d1d5db', color: '#374151', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  infoGrid: { display: 'grid', gridTemplateColumns: '90px 1fr', gap: '5px 12px', alignItems: 'center' },
  infoLabel: { fontSize: 12, color: '#6b7280', fontWeight: 500 },
  infoValue: { fontSize: 14, color: '#111827' },
  infoMono: { fontSize: 14, color: '#374151', fontFamily: 'monospace' },
  editBlock: { display: 'flex', flexDirection: 'column', gap: 10 },
  editActions: { display: 'flex', gap: 8 },
  removeBtn: { padding: '6px 14px', background: 'none', border: '1px solid #fca5a5', color: '#ef4444', borderRadius: 6, fontSize: 13, cursor: 'pointer' },
  confirmRemoveBtn: { padding: '6px 14px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  cancelRemoveBtn: { padding: '6px 14px', background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', borderRadius: 6, fontSize: 13, cursor: 'pointer' },
  inviteBanner: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, padding: '8px 10px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 7 },
  inviteBannerText: { fontSize: 12, color: '#92400e', flex: 1 },
  inviteBtn: { padding: '4px 12px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', flexShrink: 0 },
  inviteSentLabel: { fontSize: 12, color: '#059669', fontWeight: 600, flexShrink: 0 },
  // Red, not the invite banner's amber: this isn't "waiting on them", it's
  // "we are dropping their mail right now".
  bounceBanner: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, padding: '8px 10px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 7 },
  bounceBannerText: { fontSize: 12, color: '#991b1b', flex: 1 },
  bounceReason: { display: 'block', marginTop: 2, fontSize: 11, color: '#b91c1c', opacity: 0.85, wordBreak: 'break-word' },
  bounceBtn: { padding: '4px 12px', background: 'none', border: '1px solid #fca5a5', color: '#b91c1c', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', flexShrink: 0 },
  historyFooter: { marginTop: 16, borderTop: '1px solid #f0f0f0', paddingTop: 12 },
  historyToggle: { background: 'none', border: 'none', color: '#6b7280', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '2px 0' },
  historyList: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 },
  historyItem: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: '#f9fafb', borderRadius: 7 },
  restoreBtn: { padding: '4px 12px', background: 'none', border: '1px solid #6ee7b7', color: '#059669', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  qboPromptOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  qboPromptModal: { background: '#fff', borderRadius: 12, padding: 28, maxWidth: 440, width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.18)', display: 'flex', flexDirection: 'column', gap: 12 },
  qboPromptTitle: { fontSize: 17, fontWeight: 700, color: '#111827' },
  qboPromptBody: { fontSize: 14, color: '#374151', margin: 0, lineHeight: 1.5 },
  qboPromptActions: { display: 'flex', gap: 10, marginTop: 4 },
  qboPromptSuccess: { fontSize: 13, color: '#059669', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 7, padding: '8px 12px' },
  qboPromptError: { fontSize: 13, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 7, padding: '8px 12px' },
};
