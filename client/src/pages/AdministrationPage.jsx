import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';
import { usePerm, useHasAnyPerm } from '../hooks/usePerm';
import api from '../api';
import PasswordInput from '../components/PasswordInput';
import TabBar from '../components/TabBar';
import { PageIntro, PageShell } from '../components/PageShell';
import BillingPanel from '../components/BillingPanel';
import ManageRates from '../components/ManageRates';
import AdvancedSettings from '../components/AdvancedSettings';
import AuditLog from '../components/AuditLog';
import ServiceRequestsAdmin from '../components/ServiceRequestsAdmin';
import QuickBooks from '../components/QuickBooks';
import MFASetup from '../components/MFASetup';
import SetupQuestionnaire from '../components/SetupQuestionnaire';
import { usePlan } from '../hooks/usePlan';

import { silentError } from '../errorReporter';
function RoleBadge({ role }) {
  const t = useT();
  const isAdmin = role === 'admin' || role === 'super_admin';
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: isAdmin ? '#dbeafe' : '#f3f4f6', color: isAdmin ? '#1e40af' : '#6b7280' }}>
      {isAdmin ? t.adminRole : t.workerRole}
    </span>
  );
}

// ── Company Tab ───────────────────────────────────────────────────────────────

function CompanyTab() {
  const { user } = useAuth();
  const t = useT();
  const [company, setCompany] = useState(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.get('/admin/company').then(r => {
      setCompany(r.data);
      setName(r.data.name);
      setAddress(r.data.address || '');
      setPhone(r.data.phone || '');
      setContactEmail(r.data.contact_email || '');
    }).catch(silentError('administrationpage'));
  }, []);

  const startEdit = () => {
    setName(company?.name || '');
    setAddress(company?.address || '');
    setPhone(company?.phone || '');
    setContactEmail(company?.contact_email || '');
    setMsg('');
    setEditing(true);
  };

  const cancelEdit = () => {
    setName(company?.name || '');
    setAddress(company?.address || '');
    setPhone(company?.phone || '');
    setContactEmail(company?.contact_email || '');
    setMsg('');
    setEditing(false);
  };

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true); setMsg('');
    try {
      const r = await api.patch('/admin/company', { name, address, phone, contact_email: contactEmail });
      setCompany(r.data);
      setName(r.data.name);
      setAddress(r.data.address || '');
      setPhone(r.data.phone || '');
      setContactEmail(r.data.contact_email || '');
      setEditing(false);
      setMsg(t.companyNameUpdated);
    } catch (err) {
      setMsg(err.response?.data?.error || t.failedSave);
    } finally { setSaving(false); }
  };

  const statusInfo = {
    trial: { label: t.statusFreeTrial, color: '#92400e', bg: '#fef3c7' },
    active: { label: t.statusActive, color: '#065f46', bg: '#d1fae5' },
    past_due: { label: t.statusPastDue, color: '#991b1b', bg: '#fee2e2' },
    canceled: { label: t.statusCanceled, color: '#6b7280', bg: '#f3f4f6' },
  };

  const trialDaysLeft = company?.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(company.trial_ends_at) - new Date()) / 86400000))
    : null;

  const si = statusInfo[company?.subscription_status] || statusInfo.trial;

  // Flat (non-collapsible) info card. The company name acts as the card's
  // visual title with an Edit button across from it; that button puts the
  // whole card (name + address + phone + email) into edit mode at once.
  // Subscription details sit in their own section below — Stripe drives
  // those, not this form.
  return (
    <div style={styles.companyCard}>
      <div style={styles.companyCardBody}>
        {/* Company name acts as the card title — Edit sits across from it */}
        <div style={styles.companyTitleRow}>
          {editing ? (
            <input
              style={{ ...styles.input, fontSize: 18, fontWeight: 700, padding: '8px 12px' }}
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
            />
          ) : (
            <div style={styles.companyNameValue}>{company?.name || '—'}</div>
          )}
          {!editing && (
            <button style={styles.companyCardEditBtn} onClick={startEdit} aria-label={t.edit}>
              {t.edit}
            </button>
          )}
        </div>

        {/* Address */}
        <div style={styles.companyField}>
          <div style={styles.companyFieldLabel}>{t.address}</div>
          {editing ? (
            <input
              style={styles.input}
              placeholder={t.adminAddressPh}
              value={address}
              onChange={e => setAddress(e.target.value)}
            />
          ) : (
            <div style={company?.address ? styles.companyFieldValue : styles.companyFieldEmpty}>
              {company?.address || t.adminNoAddress}
            </div>
          )}
        </div>

        {/* Phone + Email side by side */}
        <div style={styles.companyFieldRow} className="company-field-row">
          <div style={{ ...styles.companyField, flex: 1 }}>
            <div style={styles.companyFieldLabel}>{t.phone}</div>
            {editing ? (
              <input
                style={styles.input}
                placeholder={t.adminPhonePh}
                value={phone}
                onChange={e => setPhone(e.target.value)}
              />
            ) : (
              <div style={company?.phone ? styles.companyFieldValue : styles.companyFieldEmpty}>
                {company?.phone || t.adminNoPhone}
              </div>
            )}
          </div>
          <div style={{ ...styles.companyField, flex: 2 }}>
            <div style={styles.companyFieldLabel}>{t.email}</div>
            {editing ? (
              <input
                style={styles.input}
                type="email"
                placeholder={t.email}
                value={contactEmail}
                onChange={e => setContactEmail(e.target.value)}
              />
            ) : (
              <div style={company?.contact_email ? styles.companyFieldValue : styles.companyFieldEmpty}>
                {company?.contact_email || t.adminNoEmail}
              </div>
            )}
          </div>
        </div>

        {editing && (
          <div style={styles.companyEditActions} className="company-edit-actions">
            <button style={styles.saveBtn} onClick={save} disabled={saving || !name.trim()}>
              {saving ? '...' : t.save}
            </button>
            <button style={styles.ghostBtn} onClick={cancelEdit}>{t.cancel}</button>
          </div>
        )}

        {msg && (
          <p style={{
            fontSize: 13,
            margin: '8px 0 0',
            color: msg.includes('Failed') || msg.includes('taken') ? '#dc2626' : '#059669',
          }}>
            {msg}
          </p>
        )}
      </div>

      {/* Subscription — read-only, separate section. Stripe drives this. */}
      <div style={styles.companySubscriptionSection}>
        <div style={styles.companyFieldLabel}>{t.subscriptionLabel}</div>
        <div style={styles.companySubscriptionRow}>
          <span style={{ ...styles.planBadge, background: si.bg, color: si.color }}>{si.label}</span>
          {company?.plan && (
            <span style={styles.planName}>
              {company.plan.charAt(0).toUpperCase() + company.plan.slice(1)} {t.planSuffix}
            </span>
          )}
          {company?.subscription_status === 'trial' && trialDaysLeft !== null && (
            <span style={{
              fontSize: 13,
              color: trialDaysLeft <= 3 ? '#dc2626' : '#6b7280',
              marginLeft: 'auto',
            }}>
              {trialDaysLeft > 0
                ? (trialDaysLeft === 1
                    ? t.trialDayLeft.replace('{n}', trialDaysLeft)
                    : t.trialDaysLeft.replace('{n}', trialDaysLeft))
                : t.trialExpired}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Billing Tab ───────────────────────────────────────────────────────────────

function BillingTab() {
  const t = useT();
  return (
    <div style={styles.tabContent}>
      <h2 style={styles.tabTitle}>{t.billing}</h2>
      <BillingPanel />
    </div>
  );
}

function WorkspaceLabels({ settings, onUpdated }) {
  const labelFields = [
    {
      key: 'label_work',
      label: 'Project',
      note: 'The general word for billable or trackable work.',
      examples: 'Jobs, routes, cases',
    },
    {
      key: 'label_client',
      label: 'Customer',
      note: 'The people or organizations the team serves.',
      examples: 'Clients, accounts, residents',
    },
    {
      key: 'label_worker',
      label: 'Team Member',
      note: 'The people using the app day to day.',
      examples: 'Staff, workers, techs',
    },
    {
      key: 'label_field',
      label: 'Field Work',
      note: 'The mobile or on-site work area.',
      examples: 'Service, visits, operations',
    },
  ];
  const [form, setForm] = useState({
    label_work: settings?.label_work || 'Project',
    label_client: settings?.label_client || 'Customer',
    label_worker: settings?.label_worker || 'Team Member',
    label_field: settings?.label_field || 'Field Work',
  });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setForm({
      label_work: settings?.label_work || 'Project',
      label_client: settings?.label_client || 'Customer',
      label_worker: settings?.label_worker || 'Team Member',
      label_field: settings?.label_field || 'Field Work',
    });
  }, [settings]);

  const set = (key, value) => {
    setForm(prev => ({ ...prev, [key]: value }));
    setMsg('');
  };
  const hasBlankLabel = Object.values(form).some(value => !String(value).trim());

  const save = async () => {
    if (hasBlankLabel) {
      setMsg('Labels must be 1-32 characters.');
      return;
    }
    setSaving(true); setMsg('');
    try {
      const payload = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value.trim()]));
      const r = await api.patch('/admin/settings', payload, { suppressToast: true });
      onUpdated(r.data);
      setMsg('Labels saved.');
    } catch (err) {
      setMsg(err.response?.data?.error || 'Could not save labels.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section style={styles.languageCard}>
      <button
        type="button"
        style={styles.languageTrigger}
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <span style={styles.languageTriggerCopy}>
          <span style={styles.languageTitle}>Company Labels</span>
          <span style={styles.languageText}>Rename common app words so the workspace matches this company's language.</span>
        </span>
        <span style={{ ...styles.accordionChevron, transform: open ? 'rotate(180deg)' : 'none' }}>▼</span>
      </button>
      {open && (
        <>
            <div style={styles.labelEditor} className="workspace-label-editor">
              {labelFields.map(field => (
              <label key={field.key} style={styles.labelRow} className="workspace-label-row">
                <span style={styles.labelRowCopy}>
                  <span style={styles.labelRowTitle}>{field.label}</span>
                  <span style={styles.labelRowText}>{field.note}</span>
                  <span style={styles.labelExamples}>Examples: {field.examples}</span>
                </span>
                <input
                  style={styles.labelInput}
                  value={form[field.key]}
                  maxLength={32}
                  onChange={e => set(field.key, e.target.value)}
                />
              </label>
            ))}
          </div>
          <div style={styles.languageActions} className="workspace-label-actions">
            <button type="button" style={styles.saveBtn} onClick={save} disabled={saving || hasBlankLabel}>
              {saving ? 'Saving...' : 'Save labels'}
            </button>
            {msg && <span style={msg.includes('Could not') ? styles.profileErrorInline : styles.profileSuccessInline}>{msg}</span>}
          </div>
        </>
      )}
      {!open && msg && (
        <button type="button" style={styles.languageSavedBtn} onClick={() => setOpen(true)}>
          {msg}
        </button>
      )}
    </section>
  );
}

function WorkspaceSettingGroup({ title, body, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section style={styles.settingGroupCard} className="workspace-setting-card">
      <button
        type="button"
        style={styles.languageTrigger}
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <span style={styles.languageTriggerCopy}>
          <span style={styles.languageTitle}>{title}</span>
          <span style={styles.languageText}>{body}</span>
        </span>
        <span style={{ ...styles.accordionChevron, transform: open ? 'rotate(180deg)' : 'none' }}>▼</span>
      </button>
      {open && <div style={styles.settingGroupBody} className="workspace-setting-body">{children}</div>}
    </section>
  );
}

// ── Account Tab ───────────────────────────────────────────────────────────────

function AccountTab() {
  const { user } = useAuth();
  const t = useT();
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [form, setForm] = useState({ current_password: '', new_password: '', confirm: '' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const [supportForm, setSupportForm] = useState({ subject: '', message: '' });
  const [supportSending, setSupportSending] = useState(false);
  const [supportMsg, setSupportMsg] = useState({ text: '', ok: false });

  const sendSupport = async e => {
    e.preventDefault();
    if (!supportForm.message.trim()) return;
    setSupportSending(true); setSupportMsg({ text: '', ok: false });
    try {
      await api.post('/admin/support', supportForm);
      setSupportForm({ subject: '', message: '' });
      setSupportMsg({ text: t.supportSentMsg, ok: true });
    } catch (err) {
      setSupportMsg({ text: err.response?.data?.error || t.supportFailedMsg, ok: false });
    } finally { setSupportSending(false); }
  };

  const changePassword = async e => {
    e.preventDefault();
    if (form.new_password.length < 6) { setMsg(t.newPasswordMin); return; }
    if (form.new_password !== form.confirm) { setMsg(t.passwordsNoMatch); return; }
    setSaving(true); setMsg('');
    try {
      await api.post('/auth/change-password', { current_password: form.current_password, new_password: form.new_password });
      setMsg(t.passwordChangedSuccess);
      setForm({ current_password: '', new_password: '', confirm: '' });
      setTimeout(() => { setShowPasswordForm(false); setMsg(''); }, 2000);
    } catch (err) {
      setMsg(err.response?.data?.error || t.failedChangePassword);
    } finally { setSaving(false); }
  };

  return (
    <div style={styles.tabContent}>
      <h2 style={styles.tabTitle}>{t.account}</h2>

      <div style={styles.card}>
        <div style={styles.cardRow}>
          <div style={styles.cardLabel}>{t.name}</div>
          <div style={styles.cardValue}>{user?.full_name}</div>
        </div>
        <div style={styles.cardRow}>
          <div style={styles.cardLabel}>{t.username}</div>
          <div style={styles.cardValue}>@{user?.username}</div>
        </div>
        <div style={{ ...styles.cardRow, borderBottom: 'none' }}>
          <div style={styles.cardLabel}>{t.role}</div>
          <RoleBadge role={user?.role} />
        </div>
      </div>

      <MFASetup />

      <div style={styles.card}>
        <button
          style={styles.accordionTrigger}
          onClick={() => { setShowPasswordForm(o => !o); setMsg(''); }}
        >
          <span style={styles.accordionLabel}>{t.changePassword}</span>
          <span style={{ ...styles.accordionChevron, transform: showPasswordForm ? 'rotate(180deg)' : 'none' }}>▾</span>
        </button>

        {showPasswordForm && (
          <form onSubmit={changePassword} style={styles.accordionBody}>
            <div style={styles.fieldGroup}>
              <label htmlFor="current-password" style={styles.label}>{t.currentPassword}</label>
              <PasswordInput id="current-password" style={styles.input} value={form.current_password} onChange={e => set('current_password', e.target.value)} autoFocus />
            </div>
            <div style={styles.fieldGroup}>
              <label htmlFor="new-password" style={styles.label}>{t.newPassword}</label>
              <PasswordInput id="new-password" style={styles.input} value={form.new_password} onChange={e => set('new_password', e.target.value)} />
            </div>
            <div style={styles.fieldGroup}>
              <label htmlFor="confirm-password" style={styles.label}>{t.confirmNewPassword}</label>
              <PasswordInput id="confirm-password" style={styles.input} value={form.confirm} onChange={e => set('confirm', e.target.value)} />
            </div>
            {msg && (
              <p style={{ ...styles.feedback, color: msg.includes('success') || msg.includes('exitosamente') ? '#059669' : '#dc2626' }}>{msg}</p>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={styles.saveBtn} type="submit" disabled={saving}>
                {saving ? t.saving : t.changePassword}
              </button>
              <button style={styles.ghostBtn} type="button" onClick={() => { setShowPasswordForm(false); setMsg(''); setForm({ current_password: '', new_password: '', confirm: '' }); }}>
                {t.cancel}
              </button>
            </div>
          </form>
        )}
      </div>

      <div style={styles.card}>
        <div style={{ padding: '16px 20px 0' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 2 }}>{t.supportTitle}</div>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>{t.supportSubtitle}</div>
        </div>
        <form onSubmit={sendSupport} style={{ padding: '0 20px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input
            style={styles.input}
            type="text"
            placeholder={t.supportSubjectPh}
            value={supportForm.subject}
            onChange={e => setSupportForm(f => ({ ...f, subject: e.target.value }))}
          />
          <textarea
            style={{ ...styles.input, minHeight: 90, resize: 'vertical', fontFamily: 'inherit' }}
            placeholder={t.supportMessagePh}
            value={supportForm.message}
            onChange={e => setSupportForm(f => ({ ...f, message: e.target.value }))}
            required
          />
          {supportMsg.text && (
            <p style={{ ...styles.feedback, color: supportMsg.ok ? '#059669' : '#dc2626', margin: 0 }}>{supportMsg.text}</p>
          )}
          <div>
            <button style={styles.saveBtn} type="submit" disabled={supportSending || !supportForm.message.trim()}>
              {supportSending ? t.supportSending : t.supportSendBtn}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const ADMIN_TABS = ['company', 'workspace', 'requests', 'integrations', 'billing', 'log', 'account'];

export default function AdministrationPage() {
  const { user } = useAuth();
  const plan = usePlan();
  const t = useT();
  // Phase D: per-tab permission gates. Company + Account always visible
  // (every user in the company has a profile and can see basic company info).
  const canManageSettings     = usePerm('manage_settings');
  const canManageIntegrations = usePerm('manage_integrations');
  const canManageBilling      = usePerm('manage_billing');
  // Service requests + audit log share manage_settings for now (no narrower
  // perm yet defined). Owner can grant manage_settings to delegate.
  const canSeeRequests        = useHasAnyPerm(['manage_settings', 'manage_advanced_settings']);
  const canSeeLog             = useHasAnyPerm(['manage_settings', 'view_reports']);

  // First-time admin welcome: landingFor() routes admins here on first
  // login, then we mark them as welcomed so subsequent logins land on
  // /workforce instead. Done in an effect (not during render) so the side
  // effect happens once, after the page actually renders.
  useEffect(() => {
    if (user?.role === 'admin' && user?.id) {
      const key = `admin_welcomed_${user.id}`;
      if (!localStorage.getItem(key)) localStorage.setItem(key, '1');
    }
  }, [user?.id, user?.role]);

  // #team used to be the Team admin tab; it's now the /team module. Any
  // bookmark or link still using #team lands in the right place.
  const hashTab = window.location.hash.replace('#', '');
  useEffect(() => {
    if (hashTab === 'team') {
      window.location.replace('/team');
    }
  }, [hashTab]);

  const [tab, setTab] = useState(ADMIN_TABS.includes(hashTab) ? hashTab : 'company');
  const switchTab = t => { setTab(t); history.replaceState(null, '', '#' + t); };

  // Shared state for ManageWorkers and QuickBooks
  const [workers, setWorkers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [settings, setSettings] = useState(null);
  const [qboConnected, setQboConnected] = useState(false);
  // First-run setup questionnaire shows when settings load with an empty
  // setup_questionnaire_completed_at. Admins only — workers don't reach
  // this page anyway. Tracked separately from settings so a dismiss in
  // this session takes effect immediately.
  const [showSetup, setShowSetup] = useState(false);
  const [profileSaving, setProfileSaving] = useState('');
  const [profileMsg, setProfileMsg] = useState('');

  // Integrations sub-view: 'list' or 'quickbooks' — persists for the session
  const [integrationView, setIntegrationView] = useState(() => sessionStorage.getItem('admin_integration_view') || 'list');
  const openIntegration = (id) => { sessionStorage.setItem('admin_integration_view', id); setIntegrationView(id); };
  const backToIntegrations = () => { sessionStorage.setItem('admin_integration_view', 'list'); setIntegrationView('list'); };

  // Build the tab list filtered by permission. Each tab is included only
  // if the user can see it. Company + Account stay always-on; the others
  // appear only with the matching perm.
  const tabs = [
    { id: 'company',      label: t.adminTabCompany      },
    ...(canManageSettings ? [{ id: 'workspace', label: 'Workspace' }] : []),
    ...(canSeeRequests ? [{ id: 'requests', label: 'Requests' }] : []),
    ...((plan.hasQbo && canManageIntegrations) ? [{ id: 'integrations', label: t.adminTabIntegrations }] : []),
    ...(canManageBilling ? [{ id: 'billing', label: t.adminTabBilling }] : []),
    ...(canSeeLog ? [{ id: 'log', label: t.adminTabLog }] : []),
    { id: 'account',      label: t.adminTabAccount      },
  ];

  // If the user landed on a tab they can't see (deep link with hash), fall
  // back to Company so we never render a hidden tab's content.
  const visibleIds = new Set(tabs.map(x => x.id));
  const safeTab = visibleIds.has(tab) ? tab : 'company';
  const visibleTabKey = tabs.map(x => x.id).join('|');

  useEffect(() => {
    const syncFromHash = () => {
      const nextHashTab = window.location.hash.replace('#', '');
      if (nextHashTab === 'team') {
        window.location.replace('/team');
        return;
      }
      if (tabs.some(x => x.id === nextHashTab)) setTab(nextHashTab);
    };
    syncFromHash();
    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, [visibleTabKey]);

  useEffect(() => {
    Promise.all([
      api.get('/admin/workers', { params: { all_roles: true } }),
      api.get('/admin/projects'),
      api.get('/admin/settings'),
      plan.hasQbo ? api.get('/qbo/status').catch(() => ({ data: { connected: false } })) : Promise.resolve({ data: { connected: false } }),
    ]).then(([w, p, s, qbo]) => {
      setWorkers(w.data);
      setProjects(p.data);
      setSettings(s.data);
      setQboConnected(qbo.data?.connected && !qbo.data?.disconnected);
      // Two ways to surface the questionnaire:
      //   1. Auto-pop on first run, ONLY for real admins of the company.
      //      Skipped for super_admin because they're usually impersonating
      //      and shouldn't be making setup decisions on a customer's behalf.
      //   2. Explicit ?setup=1 trigger from the "Run setup again" button
      //      on /help. This is opt-in by the human at the keyboard, so we
      //      honor it for super_admin too (e.g. dev testing the flow on
      //      stage as themselves).
      const params = new URLSearchParams(window.location.search);
      const forceSetup = params.get('setup') === '1';
      const isAdminish = user?.role === 'admin' || user?.role === 'super_admin';
      const autoPop = user?.role === 'admin' && !s.data?.setup_questionnaire_completed_at;
      if (autoPop || (forceSetup && isAdminish)) {
        setShowSetup(true);
      }
      if (forceSetup) {
        // Drop the query param so a refresh doesn't re-trigger.
        params.delete('setup');
        const qs = params.toString();
        window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
      }
    }).catch(silentError('administrationpage'));
  }, []);

  const handleWorkerAdded    = w  => setWorkers(prev => [...prev, { ...w, total_entries: 0, total_hours: 0, regular_hours: 0, overtime_hours: 0, prevailing_hours: 0 }]);
  const handleWorkerDeleted  = id => setWorkers(prev => prev.filter(w => w.id !== id));
  const handleWorkerUpdated  = w  => setWorkers(prev => prev.map(x => x.id === w.id ? { ...x, ...w } : x));
  const handleWorkerRestored = w  => setWorkers(prev => [...prev, w]);
  const applyWorkspaceProfile = async (profile) => {
    const profiles = {
      simple: {
        module_timeclock: true, module_team: true, module_projects: false, module_field: false,
        module_inventory: false, module_analytics: false, feature_scheduling: false,
        module_financial_reports: false,
        feature_reimbursements: false, feature_pto: false, feature_chat: false, feature_broadcast: false,
      },
      team: {
        module_timeclock: true, module_team: true, module_projects: true, module_field: false,
        module_inventory: false, module_analytics: false, feature_scheduling: true,
        module_financial_reports: false,
        feature_reimbursements: true, feature_pto: true, feature_chat: false, feature_broadcast: false,
      },
      full: {
        module_timeclock: true, module_team: true, module_projects: true, module_field: true,
        module_inventory: true, module_analytics: true, feature_scheduling: true,
        module_financial_reports: true,
        feature_reimbursements: true, feature_pto: true, feature_chat: false, feature_broadcast: false,
      },
    };
    const names = { simple: 'Focused time', team: 'Team operations', full: 'Full operations' };
    setProfileSaving(profile);
    setProfileMsg('');
    try {
      const r = await api.patch('/admin/settings', profiles[profile]);
      setSettings(r.data);
      setProfileMsg(`${names[profile]} profile applied.`);
    } catch (err) {
      setProfileMsg(err.response?.data?.error || 'Could not apply profile.');
    } finally {
      setProfileSaving('');
    }
  };
  const workspaceSummary = [
    ['Core modules', ['module_timeclock', 'module_team', 'module_projects', 'module_field', 'module_inventory', 'module_analytics', 'module_financial_reports']],
    ['Daily tools', ['feature_scheduling', 'feature_pto', 'feature_reimbursements', 'feature_chat', 'feature_broadcast']],
    ['Specialized', ['addon_certified_payroll', 'feature_quickbooks', 'feature_media_gallery', 'feature_geolocation']],
  ].map(([label, keys]) => {
    const active = keys.filter(key => settings?.[key] !== false && settings?.[key] != null).length;
    return { label, active, total: keys.length };
  });

  return (
    <PageShell currentApp="administration" features={settings} maxWidth={980} mainClassName="admin-main">
      {showSetup && (
        <SetupQuestionnaire
          onComplete={(applied) => {
            // Reflect the just-saved settings locally so the rest of the
            // page (and other tabs) sees the new toggles without a reload.
            setSettings(prev => ({ ...(prev || {}), ...applied }));
            setShowSetup(false);
          }}
          onDismiss={() => {
            setSettings(prev => ({ ...(prev || {}), setup_questionnaire_completed_at: new Date().toISOString() }));
            setShowSetup(false);
          }}
        />
      )}

      <PageIntro
        introId="administration"
        kicker="Administration"
        title="Tune the workspace without crowding the workday."
        description="Company details, labels, modules, integrations, billing, and account tools stay here so the daily apps can stay simple."
      />

        <TabBar active={safeTab} onChange={switchTab} tabs={tabs} />

        {safeTab === 'company'  && (
          <div style={styles.tabContent}>
            <h2 style={styles.tabTitle}>{t.company}</h2>
            <CompanyTab />
          </div>
        )}
        {safeTab === 'workspace' && canManageSettings && (
          <div style={styles.tabContent}>
            <section style={styles.workspaceHero} className="workspace-hero">
              <div style={styles.workspaceHeroCopy}>
                <div style={styles.workspaceKicker}>Workspace setup</div>
                <h2 style={styles.workspaceTitle}>Shape the app around the work people do every day.</h2>
                <p style={styles.workspaceText}>
                  Keep common tools visible, tuck specialist controls away, and adjust labels so the app speaks this company's language.
                </p>
              </div>
              <div style={styles.workspaceSide} className="workspace-side">
                <button type="button" style={styles.workspaceAction} onClick={() => setShowSetup(true)}>
                  Run quick setup
                </button>
                <div style={styles.workspaceSummaryGrid} className="workspace-summary-grid">
                  {workspaceSummary.map(item => (
                    <div key={item.label} style={styles.workspaceSummaryItem}>
                      <strong style={styles.workspaceSummaryValue}>{item.active} of {item.total}</strong>
                      <span style={styles.workspaceSummaryLabel}>{item.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
            <section style={styles.profileCard} className="workspace-profile-card">
              <div>
                <h3 style={styles.profileTitle}>Choose a starting shape</h3>
                <p style={styles.profileText}>Profiles change the visible modules. The detailed settings below remain available for fine-tuning.</p>
              </div>
              <div style={styles.profileGrid} className="workspace-profile-grid">
                {[
                  ['simple', 'Focused time', 'Time clock, team basics, and a quieter app.'],
                  ['team', 'Team operations', 'Adds work setup, scheduling, PTO, and reimbursements.'],
                  ['full', 'Full operations', 'Turns on field work, inventory, analytics, and the core team tools.'],
                ].map(([id, title, body]) => (
                  <button
                    key={id}
                    type="button"
                    style={styles.profileBtn}
                    onClick={() => applyWorkspaceProfile(id)}
                    disabled={!!profileSaving}
                  >
                    <strong>{profileSaving === id ? 'Applying...' : title}</strong>
                    <span>{body}</span>
                  </button>
                ))}
              </div>
              {profileMsg && <p style={profileMsg.includes('Could not') ? styles.profileError : styles.profileSuccess}>{profileMsg}</p>}
            </section>
            <WorkspaceLabels settings={settings} onUpdated={setSettings} />
            <WorkspaceSettingGroup
              title="Pay and billing rules"
              body="Rates, overtime, mileage, payroll periods, and other money-related defaults."
              defaultOpen
            >
              <ManageRates settings={settings} onSettingsUpdated={setSettings} />
            </WorkspaceSettingGroup>
            <WorkspaceSettingGroup
              title="Advanced Controls"
              body="Detailed feature switches and behavior settings for teams that need extra control."
            >
              <AdvancedSettings settings={settings} embedded />
            </WorkspaceSettingGroup>
          </div>
        )}
        {safeTab === 'requests' && (
          <div style={styles.tabContent}>
            <h2 style={styles.tabTitle}>Requests</h2>
            <ServiceRequestsAdmin settings={settings} />
          </div>
        )}
        {safeTab === 'log'      && (
          <div style={styles.tabContent}>
            <h2 style={styles.tabTitle}>{t.auditLog}</h2>
            <AuditLog timezone={settings?.company_timezone ?? ''} settings={settings} />
          </div>
        )}
        {safeTab === 'integrations' && (
          <div style={styles.tabContent}>
            {integrationView === 'list' && (
              <>
                <h2 style={styles.tabTitle}>{t.integrations}</h2>
                <div style={styles.integrationGrid}>
                  <button
                    type="button"
                    style={styles.integrationCard}
                    onClick={() => openIntegration('quickbooks')}
                  >
                    <div style={styles.integrationLogo}>QB</div>
                    <div style={{ flex: 1, textAlign: 'left' }}>
                      <div style={styles.integrationName}>{t.adminQuickBooksOnline}</div>
                      <div style={styles.integrationDesc}>{t.adminQboDesc}</div>
                    </div>
                    <span style={styles.integrationChevron} aria-hidden="true">›</span>
                  </button>
                </div>
              </>
            )}
            {integrationView === 'quickbooks' && (
              <>
                <div style={styles.integrationHeader}>
                  <button
                    type="button"
                    onClick={backToIntegrations}
                    style={styles.backBtn}
                    aria-label={t.adminBackToIntegrations}
                  >
                    {t.adminIntegrationsBack}
                  </button>
                  <h2 style={{ ...styles.tabTitle, margin: 0 }}>{t.adminQuickBooksOnline}</h2>
                </div>
                <QuickBooks
                  workers={workers}
                  projects={projects}
                  settings={settings}
                  onSettingsChange={setSettings}
                  onWorkersImported={imported => setWorkers(prev => [...prev, ...imported.map(w => ({ ...w, total_entries: 0, total_hours: 0, regular_hours: 0, overtime_hours: 0, prevailing_hours: 0 }))])}
                  onProjectsImported={imported => setProjects(prev => [...prev, ...imported])}
                />
              </>
            )}
          </div>
        )}
        {safeTab === 'billing'  && <BillingTab />}
        {safeTab === 'account'  && <AccountTab />}
    </PageShell>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  page: { minHeight: '100vh', background: '#f4f6f9', '--ops-page-accent': '#475569' },
  header: {
    background: '#64748b', color: '#fff', padding: '0 24px',
    paddingTop: 'env(safe-area-inset-top)', paddingBottom: 0,
    display: 'flex', flexDirection: 'column', justifyContent: 'center',
    minHeight: 'calc(56px + env(safe-area-inset-top))',
    position: 'sticky', top: 0, zIndex: 100,
  },
  headerTopRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', height: 56 },
  logoGroup: { display: 'flex', alignItems: 'center', gap: 10 },
  companyName: { fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.85)' },
  headerRight: { display: 'flex', alignItems: 'center', gap: 10 },
  headerBtn: { background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', padding: '6px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  main: { maxWidth: 900, margin: '0 auto', padding: '24px 16px' },
  // Content sections
  tabContent: { display: 'flex', flexDirection: 'column', gap: 16 },
  sectionTitle: { fontSize: 17, fontWeight: 700, margin: '8px 0 0' },
  tabTitle: { fontSize: 22, fontWeight: 800, color: '#111827', margin: '0 0 4px' },
  workspaceHero: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(230px, 360px)', alignItems: 'start', gap: 24,
    background: '#fff', color: '#0f172a', border: '1px solid #e2e8f0', borderRadius: 10, padding: '22px 28px',
    boxShadow: '0 1px 4px rgba(15,23,42,0.04)',
  },
  workspaceHeroCopy: { minWidth: 0 },
  workspaceKicker: { fontSize: 11, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#64748b', marginBottom: 6 },
  workspaceTitle: { fontSize: 20, lineHeight: 1.18, margin: '0 0 6px', maxWidth: 620, letterSpacing: 0 },
  workspaceText: { fontSize: 13, lineHeight: 1.55, color: '#64748b', margin: 0, maxWidth: 650 },
  workspaceSide: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 12 },
  workspaceAction: {
    border: 'none', borderRadius: 8, background: '#475569', color: '#fff',
    padding: '10px 16px', fontSize: 13, fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap',
  },
  workspaceSummaryGrid: { display: 'grid', gridTemplateColumns: '1fr', gap: 10, width: '100%', maxWidth: 180, justifyItems: 'end' },
  workspaceSummaryItem: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, minWidth: 0, textAlign: 'right' },
  workspaceSummaryValue: { color: '#0f172a', fontSize: 16, lineHeight: 1.1, fontWeight: 900, whiteSpace: 'nowrap' },
  workspaceSummaryLabel: { color: '#64748b', fontSize: 11, lineHeight: 1.2, fontWeight: 800, whiteSpace: 'normal' },
  profileCard: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 16, boxShadow: '0 1px 4px rgba(15,23,42,0.04)' },
  languageCard: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 0, boxShadow: '0 1px 4px rgba(15,23,42,0.04)', overflow: 'hidden' },
  settingGroupCard: { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 0, boxShadow: '0 1px 4px rgba(15,23,42,0.04)', overflow: 'hidden' },
  settingGroupBody: { padding: '0 16px 16px' },
  languageTrigger: { width: '100%', border: 'none', background: '#fff', padding: 16, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, textAlign: 'left' },
  languageTriggerCopy: { display: 'flex', flexDirection: 'column', gap: 4 },
  languageTitle: { fontSize: 17, fontWeight: 800, color: '#111827' },
  languageText: { fontSize: 13, color: '#64748b', lineHeight: 1.45 },
  languageSavedBtn: { margin: '0 18px 18px', border: '1px solid #a7f3d0', background: '#ecfdf5', color: '#047857', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  profileTitle: { margin: '0 0 4px', fontSize: 17, fontWeight: 800, color: '#111827' },
  profileText: { margin: '0 0 14px', fontSize: 13, color: '#64748b', lineHeight: 1.55 },
  profileGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 },
  profileBtn: {
    minHeight: 104, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', alignItems: 'flex-start',
    gap: 10, textAlign: 'left', border: '1px solid #dbe2ea', borderRadius: 8, background: '#f8fafc',
    padding: 14, color: '#0f172a', cursor: 'pointer',
  },
  profileSuccess: { margin: '12px 0 0', color: '#047857', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontWeight: 700 },
  profileError: { margin: '12px 0 0', color: '#b91c1c', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontWeight: 700 },
  profileSuccessInline: { color: '#047857', fontSize: 13, fontWeight: 700 },
  profileErrorInline: { color: '#b91c1c', fontSize: 13, fontWeight: 700 },
  labelEditor: { display: 'flex', flexDirection: 'column', gap: 0, padding: '0 18px' },
  labelRow: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14,
    alignItems: 'center', padding: '14px 0', borderTop: '1px solid #f1f5f9',
  },
  labelRowCopy: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
  labelRowTitle: { fontSize: 14, fontWeight: 800, color: '#111827' },
  labelRowText: { fontSize: 13, color: '#64748b', lineHeight: 1.35 },
  labelExamples: { fontSize: 12, color: '#94a3b8', lineHeight: 1.35 },
  labelInput: { padding: '9px 11px', border: '1px solid #dbe2ea', borderRadius: 8, fontSize: 14, width: '100%', background: '#fff' },
  languageActions: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '14px 18px 18px' },
  // Integrations
  integrationGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 },
  integrationCard: {
    display: 'flex', alignItems: 'center', gap: 14,
    background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12,
    padding: '16px 18px', cursor: 'pointer', textAlign: 'left', width: '100%',
    boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
  },
  integrationLogo: {
    width: 44, height: 44, borderRadius: 10,
    background: '#2CA01C', color: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontWeight: 800, fontSize: 16, flexShrink: 0,
  },
  integrationName: { fontSize: 15, fontWeight: 700, color: '#111827' },
  integrationDesc: { fontSize: 13, color: '#6b7280', marginTop: 2 },
  integrationChevron: { fontSize: 24, color: '#9ca3af', fontWeight: 300, marginLeft: 8 },
  integrationHeader: { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 8 },
  backBtn: {
    background: 'none', border: '1px solid #d1d5db', borderRadius: 8,
    padding: '6px 12px', fontSize: 13, fontWeight: 600, color: '#374151',
    cursor: 'pointer', minHeight: 'unset',
  },
  // Cards
  card: { background: '#fff', borderRadius: 12, boxShadow: '0 1px 6px rgba(0,0,0,0.07)', overflow: 'hidden' },
  // Flat (non-collapsible) Company info card. The company name acts as the
  // visual title; Edit button sits across from it on the same row so it
  // scopes to the whole card.
  companyCard: { background: '#fff', borderRadius: 12, boxShadow: '0 1px 6px rgba(0,0,0,0.07)' },
  companyCardEditBtn: {
    background: 'none', border: '1px solid #d1d5db', color: 'var(--ops-page-accent)',
    padding: '5px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    flexShrink: 0,
  },
  companyCardBody: { padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 },
  companyTitleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  companyField: { display: 'flex', flexDirection: 'column', gap: 4 },
  companyFieldRow: { display: 'flex', gap: 12, flexWrap: 'wrap' },
  companyFieldLabel: { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' },
  companyNameValue: { fontSize: 22, fontWeight: 800, color: '#111827' },
  companyFieldValue: { fontSize: 14, color: '#374151' },
  companyFieldEmpty: { fontSize: 14, color: '#d1d5db', fontStyle: 'italic' },
  companyEditActions: { display: 'flex', gap: 8, marginTop: 4 },
  companySubscriptionSection: {
    padding: '14px 20px', borderTop: '1px solid #f3f4f6',
    background: '#fafafa', borderRadius: '0 0 12px 12px',
    display: 'flex', flexDirection: 'column', gap: 6,
  },
  companySubscriptionRow: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  cardRow: { display: 'flex', alignItems: 'center', gap: 16, padding: '14px 20px', borderBottom: '1px solid #f3f4f6' },
  cardLabel: { fontSize: 13, color: '#6b7280', fontWeight: 600, minWidth: 120 },
  cardValue: { fontSize: 14, color: '#111827', fontWeight: 500 },
  planBadge: { fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 10 },
  planName: { fontSize: 13, color: '#374151', fontWeight: 500 },
  editLink: { fontSize: 12, color: 'var(--ops-page-accent)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, padding: 0 },
  feedback: { fontSize: 13, margin: '4px 0 0', padding: '6px 0' },
  // Account
  accordionTrigger: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '16px 20px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' },
  accordionLabel: { fontSize: 14, fontWeight: 600, color: '#374151' },
  accordionChevron: { fontSize: 16, color: '#6b7280', transition: 'transform 0.2s', display: 'inline-block' },
  accordionBody: { display: 'flex', flexDirection: 'column', gap: 12, padding: '0 20px 20px', borderTop: '1px solid #f3f4f6' },
  // Shared form
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 4 },
  label: { fontSize: 12, fontWeight: 600, color: '#6b7280' },
  input: { padding: '9px 11px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, width: '100%' },
  // Buttons
  saveBtn: { background: '#64748b', color: '#fff', border: 'none', padding: '9px 18px', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer', flexShrink: 0 },
  ghostBtn: { background: 'none', border: '1px solid #e5e7eb', color: '#6b7280', padding: '9px 14px', borderRadius: 7, fontSize: 13, cursor: 'pointer' },
  error: { color: '#ef4444', fontSize: 13, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, padding: '8px 12px', margin: 0 },
  hint: { color: '#6b7280', fontSize: 14, padding: '16px 0' },
};
