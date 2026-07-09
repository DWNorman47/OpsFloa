import React, { useState, useEffect } from 'react';
import api from '../api';
import { currencySymbol } from '../utils';
import { useT } from '../hooks/useT';
import { usePlan } from '../hooks/usePlan';
import { invalidateCache } from '../offlineDb';

import { silentError } from '../errorReporter';
import HelpTip from './HelpTip';
import MileageRateEditor from './MileageRateEditor';
import { EXPERIMENTAL_SETTINGS_ENABLED } from '../experimentalSettings';
const TIMEZONES = [
  { value: 'America/New_York',    label: 'Eastern Time (ET)' },
  { value: 'America/Chicago',     label: 'Central Time (CT)' },
  { value: 'America/Denver',      label: 'Mountain Time (MT)' },
  { value: 'America/Phoenix',     label: 'Arizona (MST, no DST)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'America/Anchorage',   label: 'Alaska (AKT)' },
  { value: 'Pacific/Honolulu',    label: 'Hawaii (HST)' },
  { value: 'America/Puerto_Rico', label: 'Puerto Rico (AST)' },
  { value: 'America/Mexico_City', label: 'Mexico City (CST)' },
  { value: 'America/Tijuana',     label: 'Tijuana (PST)' },
  { value: 'America/Monterrey',   label: 'Monterrey (CST)' },
  { value: 'America/Tegucigalpa', label: 'Honduras (CST)' },
  { value: 'America/Guatemala',   label: 'Guatemala (CST)' },
  { value: 'America/Managua',     label: 'Nicaragua (CST)' },
  { value: 'America/Belize',      label: 'Belize (CST)' },
  { value: 'America/Costa_Rica',  label: 'Costa Rica (CST)' },
  { value: 'America/Panama',      label: 'Panama (EST)' },
  { value: 'America/Bogota',      label: 'Colombia (COT)' },
  { value: 'America/Lima',        label: 'Peru (PET)' },
  { value: 'America/Santiago',    label: 'Chile (CLT)' },
  { value: 'America/Buenos_Aires', label: 'Argentina (ART)' },
  { value: 'America/Sao_Paulo',   label: 'Brazil — São Paulo (BRT)' },
  { value: 'America/Toronto',     label: 'Toronto (ET)' },
  { value: 'America/Vancouver',   label: 'Vancouver (PT)' },
  { value: 'Europe/London',       label: 'London (GMT/BST)' },
  { value: 'Europe/Paris',        label: 'Paris (CET)' },
  { value: 'Europe/Berlin',       label: 'Berlin (CET)' },
  { value: 'Europe/Madrid',       label: 'Madrid (CET)' },
  { value: 'Asia/Dubai',          label: 'Dubai (GST)' },
  { value: 'Asia/Kolkata',        label: 'India (IST)' },
  { value: 'Asia/Tokyo',          label: 'Japan (JST)' },
  { value: 'Asia/Shanghai',       label: 'China (CST)' },
  { value: 'Australia/Sydney',    label: 'Sydney (AEST)' },
  { value: 'Pacific/Auckland',    label: 'New Zealand (NZST)' },
  { value: 'UTC',                 label: 'UTC' },
];

const CURRENCIES = [
  { code: 'USD', name: 'USD — US Dollar' },
  { code: 'CAD', name: 'CAD — Canadian Dollar' },
  { code: 'EUR', name: 'EUR — Euro' },
  { code: 'GBP', name: 'GBP — British Pound' },
  { code: 'MXN', name: 'MXN — Mexican Peso' },
  { code: 'HNL', name: 'HNL — Honduran Lempira' },
  { code: 'GTQ', name: 'GTQ — Guatemalan Quetzal' },
  { code: 'NIO', name: 'NIO — Nicaraguan Córdoba' },
  { code: 'BZD', name: 'BZD — Belize Dollar' },
  { code: 'CRC', name: 'CRC — Costa Rican Colón' },
  { code: 'PAB', name: 'PAB — Panamanian Balboa' },
];

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + ' MB';
  return (bytes / 1024).toFixed(0) + ' KB';
}

export default function ManageRates({ settings, onSettingsUpdated }) {
  const plan = usePlan();
  const t = useT();
  const [form, setForm] = useState({
    prevailing_wage_rate: String(settings?.prevailing_wage_rate ?? 0),
    default_hourly_rate: String(settings?.default_hourly_rate ?? 30),
    overtime_multiplier: String(settings?.overtime_multiplier ?? 1.5),
    overtime_rule: settings?.overtime_rule ?? 'daily',
    overtime_threshold: String(settings?.overtime_threshold ?? 8),
    week_start: String(settings?.week_start ?? 1),
    notification_inactive_days: String(settings?.notification_inactive_days ?? 3),
    notification_use_work_hours: settings?.notification_use_work_hours ?? true,
    notification_start_hour: String(settings?.notification_start_hour ?? 6),
    notification_end_hour: String(settings?.notification_end_hour ?? 20),
    chat_retention_days: String(settings?.chat_retention_days ?? 3),
    pto_annual_days: String(settings?.pto_annual_days ?? 0),
    feature_overtime: settings?.feature_overtime ?? true,
    module_field: settings?.module_field ?? false,
    feature_scheduling: settings?.feature_scheduling ?? true,
    feature_analytics: settings?.feature_analytics ?? true,
    feature_public: settings?.feature_public ?? true,
    feature_chat: settings?.feature_chat ?? false,
    feature_geolocation: settings?.feature_geolocation ?? true,
    module_timeclock: settings?.module_timeclock ?? true,
    module_projects: settings?.module_projects ?? true,
    hide_work_orders_tab: settings?.hide_work_orders_tab ?? false,
    hide_projects_tab: settings?.hide_projects_tab ?? false,
    module_inventory: settings?.module_inventory ?? false,
    module_tools: settings?.module_tools ?? true,
    module_analytics: settings?.module_analytics ?? false,
    module_team: settings?.module_team ?? true,
    module_financial_reports: settings?.module_financial_reports ?? false,
    feature_project_integration: settings?.feature_project_integration ?? true,
    feature_inactive_alerts: settings?.feature_inactive_alerts ?? false,
    feature_overtime_alerts: settings?.feature_overtime_alerts ?? true,
    feature_broadcast: settings?.feature_broadcast ?? false,
    feature_media_gallery: settings?.feature_media_gallery ?? false,
    feature_admin_edit_time: settings?.feature_admin_edit_time ?? true,
    feature_worker_edit_time: settings?.feature_worker_edit_time ?? true,
    feature_reimbursements: settings?.feature_reimbursements ?? true,
    feature_pto: settings?.feature_pto ?? true,
    cp_track_classifications: settings?.cp_track_classifications ?? true,
    cp_track_fringes:         settings?.cp_track_fringes ?? true,
    cp_collect_ssn:           settings?.cp_collect_ssn ?? true,
    cp_require_signature:     settings?.cp_require_signature ?? true,
    cp_wh347_format:          settings?.cp_wh347_format ?? true,
    cp_compute_deductions:    settings?.cp_compute_deductions ?? false,
    show_worker_wages: settings?.show_worker_wages ?? false,
    global_required_checklist_template_id: settings?.global_required_checklist_template_id ?? '',
    currency: settings?.currency ?? 'USD',
    company_timezone: settings?.company_timezone ?? '',
    invoice_signature: settings?.invoice_signature ?? 'optional',
    default_temp_password: settings?.default_temp_password ?? '',
    cycle_count_audit_pct: String(settings?.cycle_count_audit_pct ?? 15),
    cycle_count_reconcile_threshold: String(settings?.cycle_count_reconcile_threshold ?? 0),
    cycle_count_reconcile_threshold_type: settings?.cycle_count_reconcile_threshold_type ?? 'units',
    media_retention_days: String(settings?.media_retention_days ?? 0),
    media_delete_on_project_archive: settings?.media_delete_on_project_archive ?? false,
    notify_timeoff_requests: settings?.notify_timeoff_requests ?? true,
    notify_budget_alerts: settings?.notify_budget_alerts ?? true,
    notify_entry_submitted: settings?.notify_entry_submitted ?? false,
    report_weekly_payroll: settings?.report_weekly_payroll ?? false,
    report_weekly_low_stock: settings?.report_weekly_low_stock ?? false,
    report_monthly_valuation: settings?.report_monthly_valuation ?? false,
  });
  const [prevailingEnabled, setPrevailingEnabled] = useState(() => (settings?.prevailing_wage_rate ?? 0) > 0);
  // PTO tracking is "enabled" when a non-zero value is stored. While editing
  // from 0, we flip this on so the input shows; on save, it goes back to
  // reflecting the stored value (so admin can disable by saving 0).
  const [ptoEditing, setPtoEditing] = useState(false);
  const [checklistTemplates, setChecklistTemplates] = useState([]);
  useEffect(() => {
    api.get('/safety-checklists/templates').then(r => setChecklistTemplates(r.data)).catch(silentError('managerates'));
  }, []);
  const DEFAULT_COLLAPSED = { wages: true, overtime: true, pto: true, reimbursements: true, inventoryCount: true, notifications: true, reports: true, access: true, standards: true, modules: true, features: true, storage: true, certifiedPayroll: true, experimental: true };
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem('opsfloa_company_sections');
      return stored ? JSON.parse(stored) : DEFAULT_COLLAPSED;
    } catch { return DEFAULT_COLLAPSED; }
  });
  const toggleCollapse = key => setCollapsed(c => {
    const next = { ...c, [key]: !c[key] };
    localStorage.setItem('opsfloa_company_sections', JSON.stringify(next));
    return next;
  });
  const [saving, setSaving] = useState(null); // section key or null
  const [saved, setSaved] = useState(null);   // section key or null
  const [error, setError] = useState('');

  useEffect(() => {
    if (!settings) return;
    setPrevailingEnabled((settings.prevailing_wage_rate ?? 0) > 0);
    setForm({
      prevailing_wage_rate: String(settings.prevailing_wage_rate ?? 0),
      default_hourly_rate: String(settings.default_hourly_rate ?? 30),
      overtime_multiplier: String(settings.overtime_multiplier ?? 1.5),
      overtime_rule: settings.overtime_rule ?? 'daily',
      overtime_threshold: String(settings.overtime_threshold ?? 8),
      week_start: String(settings.week_start ?? 1),
      notification_inactive_days: String(settings.notification_inactive_days ?? 3),
      notification_use_work_hours: settings.notification_use_work_hours ?? true,
      notification_start_hour: String(settings.notification_start_hour ?? 6),
      notification_end_hour: String(settings.notification_end_hour ?? 20),
      chat_retention_days: String(settings.chat_retention_days ?? 3),
      pto_annual_days: String(settings.pto_annual_days ?? 0),
      feature_overtime: settings.feature_overtime ?? true,
      module_field: settings.module_field ?? false,
      feature_scheduling: settings.feature_scheduling ?? true,
      feature_analytics: settings.feature_analytics ?? true,
      feature_public: settings.feature_public ?? true,
      feature_chat: settings.feature_chat ?? false,
      feature_geolocation: settings.feature_geolocation ?? true,
      module_timeclock: settings.module_timeclock ?? true,
      module_projects: settings.module_projects ?? true,
      hide_work_orders_tab: settings.hide_work_orders_tab ?? false,
      hide_projects_tab: settings.hide_projects_tab ?? false,
      module_inventory: settings.module_inventory ?? false,
      module_tools: settings.module_tools ?? true,
      module_analytics: settings.module_analytics ?? false,
      module_team: settings.module_team ?? true,
      module_financial_reports: settings.module_financial_reports ?? false,
      feature_project_integration: settings.feature_project_integration ?? true,
      feature_inactive_alerts: settings.feature_inactive_alerts ?? false,
      feature_overtime_alerts: settings.feature_overtime_alerts ?? true,
      feature_broadcast: settings.feature_broadcast ?? false,
      feature_media_gallery: settings.feature_media_gallery ?? false,
      feature_admin_edit_time: settings.feature_admin_edit_time ?? true,
      feature_worker_edit_time: settings.feature_worker_edit_time ?? true,
      feature_reimbursements: settings.feature_reimbursements ?? true,
      feature_pto: settings.feature_pto ?? true,
      cp_track_classifications: settings.cp_track_classifications ?? true,
      cp_track_fringes:         settings.cp_track_fringes ?? true,
      cp_collect_ssn:           settings.cp_collect_ssn ?? true,
      cp_require_signature:     settings.cp_require_signature ?? true,
      cp_wh347_format:          settings.cp_wh347_format ?? true,
      cp_compute_deductions:    settings.cp_compute_deductions ?? false,
      show_worker_wages: settings.show_worker_wages ?? false,
      global_required_checklist_template_id: settings.global_required_checklist_template_id ?? '',
      currency: settings.currency ?? 'USD',
      company_timezone: settings.company_timezone ?? '',
      invoice_signature: settings.invoice_signature ?? 'optional',
      default_temp_password: settings.default_temp_password ?? '',
      cycle_count_audit_pct: String(settings.cycle_count_audit_pct ?? 15),
      cycle_count_reconcile_threshold: String(settings.cycle_count_reconcile_threshold ?? 0),
      cycle_count_reconcile_threshold_type: settings.cycle_count_reconcile_threshold_type ?? 'units',
      media_retention_days: String(settings.media_retention_days ?? 0),
      media_delete_on_project_archive: settings.media_delete_on_project_archive ?? false,
      notify_timeoff_requests: settings.notify_timeoff_requests ?? true,
      notify_budget_alerts: settings.notify_budget_alerts ?? true,
      notify_entry_submitted: settings.notify_entry_submitted ?? false,
      report_weekly_payroll: settings.report_weekly_payroll ?? false,
      report_weekly_low_stock: settings.report_weekly_low_stock ?? false,
      report_monthly_valuation: settings.report_monthly_valuation ?? false,
    });
  }, [settings]);

  const set = (k, v) => { setForm(f => ({ ...f, [k]: v })); setSaved(null); setError(''); };

  const saveSection = async (section) => {
    setSaving(section); setError('');
    try {
      const r = await api.patch('/admin/settings', {
        prevailing_wage_rate: parseFloat(form.prevailing_wage_rate),
        default_hourly_rate: parseFloat(form.default_hourly_rate),
        overtime_multiplier: parseFloat(form.overtime_multiplier),
        overtime_rule: form.overtime_rule,
        overtime_threshold: parseFloat(form.overtime_threshold),
        week_start: parseInt(form.week_start, 10),
        notification_inactive_days: parseFloat(form.notification_inactive_days),
        notification_use_work_hours: form.notification_use_work_hours,
        notification_start_hour: parseFloat(form.notification_start_hour),
        notification_end_hour: parseFloat(form.notification_end_hour),
        chat_retention_days: parseFloat(form.chat_retention_days),
        pto_annual_days: parseFloat(form.pto_annual_days) || 0,
        feature_overtime: form.feature_overtime,
        module_field: form.module_field,
        feature_scheduling: form.feature_scheduling,
        feature_analytics: form.module_analytics,
        feature_public: form.feature_public,
        feature_chat: form.feature_chat,
        feature_geolocation: form.feature_geolocation,
        module_timeclock: form.module_timeclock,
        module_projects: form.module_projects,
        hide_work_orders_tab: form.hide_work_orders_tab,
        hide_projects_tab: form.hide_projects_tab,
        module_inventory: form.module_inventory,
        module_tools: form.module_tools,
        module_analytics: form.module_analytics,
        module_team: form.module_team,
        module_financial_reports: form.module_financial_reports,
        feature_project_integration: form.feature_project_integration,
        feature_inactive_alerts: form.feature_inactive_alerts,
        feature_overtime_alerts: form.feature_overtime_alerts,
        feature_broadcast: form.feature_broadcast,
        feature_media_gallery: form.feature_media_gallery,
        feature_admin_edit_time: form.feature_admin_edit_time,
        feature_worker_edit_time: form.feature_worker_edit_time,
        feature_reimbursements: form.feature_reimbursements,
        feature_pto: form.feature_pto,
        cp_track_classifications: form.cp_track_classifications,
        cp_track_fringes:         form.cp_track_fringes,
        cp_collect_ssn:           form.cp_collect_ssn,
        cp_require_signature:     form.cp_require_signature,
        cp_wh347_format:          form.cp_wh347_format,
        cp_compute_deductions:    form.cp_compute_deductions,
        show_worker_wages: form.show_worker_wages,
        global_required_checklist_template_id: form.global_required_checklist_template_id,
        currency: form.currency,
        company_timezone: form.company_timezone,
        invoice_signature: form.invoice_signature,
        default_temp_password: form.default_temp_password,
        cycle_count_audit_pct: isNaN(parseFloat(form.cycle_count_audit_pct)) ? 15 : parseFloat(form.cycle_count_audit_pct),
        cycle_count_reconcile_threshold: parseFloat(form.cycle_count_reconcile_threshold) || 0,
        cycle_count_reconcile_threshold_type: form.cycle_count_reconcile_threshold_type,
        media_retention_days: parseFloat(form.media_retention_days) || 0,
        media_delete_on_project_archive: form.media_delete_on_project_archive,
        notify_timeoff_requests: form.notify_timeoff_requests,
        notify_budget_alerts: form.notify_budget_alerts,
        notify_entry_submitted: form.notify_entry_submitted,
        report_weekly_payroll: form.report_weekly_payroll,
        report_weekly_low_stock: form.report_weekly_low_stock,
        report_monthly_valuation: form.report_monthly_valuation,
      });
      onSettingsUpdated(r.data);
      // Bust the worker-facing settings cache so gating toggles (Project
      // Integration, modules, etc.) take effect on the next request instead of
      // the next TTL window.
      invalidateCache('settings');
      setSaved(section);
      // If PTO was saved at 0, collapse the input back to the "+ Enable" button.
      if (section === 'pto' && (parseFloat(form.pto_annual_days) || 0) === 0) {
        setPtoEditing(false);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save settings');
    } finally {
      setSaving(null);
    }
  };

  const SectionFooter = ({ section }) => (
    <div style={styles.sectionFooter}>
      {saved === section && <span style={styles.savedMsg}>{t.ratesSettingsSaved}</span>}
      {error && saving === null && <span style={styles.errorMsg}>{error}</span>}
      <button
        style={{ ...styles.saveBtn, ...(saving === section ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
        type="button"
        disabled={saving === section}
        onClick={() => saveSection(section)}
      >
        {saving === section ? t.saving : t.ratesSaveSettings}
      </button>
    </div>
  );

  return (
    <div style={styles.form}>
      <style>{`@media (max-width: 520px) { .invoice-sig-row { flex-wrap: wrap !important; } .invoice-sig-row select { width: 100% !important; margin-top: 6px; } }`}</style>

      {/* ── Modules ── */}
      <div style={styles.section}>
        <div style={{ ...styles.sectionHeader, cursor: 'pointer' }} onClick={() => toggleCollapse('modules')} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggleCollapse('modules')}>
          <span style={styles.sectionIcon}>📦</span>
          <div style={{ flex: 1 }}>
            <div style={styles.sectionTitle}>{t.mrModulesTitle}</div>
            <div style={styles.sectionSub}>{t.mrModulesSub}</div>
          </div>
          <span style={styles.collapseChevron}>{collapsed.modules ? '▶' : '▼'}</span>
        </div>
        {!collapsed.modules && <div style={styles.sectionBody}>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.mrModuleTimeClock}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.mrModuleTimeClockDesc}</div>
            </div>
            <label style={{ ...styles.toggle, background: form.module_timeclock ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.module_timeclock} onChange={e => set('module_timeclock', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.module_timeclock ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.featField}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.featFieldDesc}</div>
            </div>
            <label style={{ ...styles.toggle, background: form.module_field ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.module_field} onChange={e => set('module_field', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.module_field ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.mrModuleProjects}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.mrModuleProjectsDesc}</div>
            </div>
            <label style={{ ...styles.toggle, background: form.module_projects ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.module_projects} onChange={e => {
                set('module_projects', e.target.checked);
                if (!e.target.checked) set('feature_project_integration', false);
              }} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.module_projects ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          {form.module_projects && (
            <>
              <div style={{ ...styles.row, paddingLeft: 16 }}>
                <div>
                  <div style={styles.label}>Show Work Orders tab</div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>Service calls & standalone jobs. Turn off if you only run projects.</div>
                </div>
                <label style={{ ...styles.toggle, background: !form.hide_work_orders_tab ? 'var(--ops-page-accent)' : '#d1d5db' }}>
                  <input type="checkbox" checked={!form.hide_work_orders_tab} onChange={e => set('hide_work_orders_tab', !e.target.checked)} style={{ display: 'none' }} />
                  <span style={{ ...styles.toggleKnob, transform: !form.hide_work_orders_tab ? 'translateX(46px)' : 'translateX(0)' }} />
                </label>
              </div>
              <div style={{ ...styles.row, paddingLeft: 16 }}>
                <div>
                  <div style={styles.label}>Show Projects tab</div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>Multi-week jobs with budgets & docs. Turn off if you only do service work.</div>
                </div>
                <label style={{ ...styles.toggle, background: !form.hide_projects_tab ? 'var(--ops-page-accent)' : '#d1d5db' }}>
                  <input type="checkbox" checked={!form.hide_projects_tab} onChange={e => set('hide_projects_tab', !e.target.checked)} style={{ display: 'none' }} />
                  <span style={{ ...styles.toggleKnob, transform: !form.hide_projects_tab ? 'translateX(46px)' : 'translateX(0)' }} />
                </label>
              </div>
            </>
          )}
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.mrModuleInventory}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.mrModuleInventoryDesc}</div>
            </div>
            <label style={{ ...styles.toggle, background: form.module_inventory ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.module_inventory} onChange={e => set('module_inventory', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.module_inventory ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.mrModuleTools}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.mrModuleToolsDesc}</div>
            </div>
            <label style={{ ...styles.toggle, background: form.module_tools ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.module_tools} onChange={e => set('module_tools', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.module_tools ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.mrModuleTeam}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.mrModuleTeamDesc}</div>
            </div>
            <label style={{ ...styles.toggle, background: form.module_team ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.module_team} onChange={e => set('module_team', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.module_team ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.mrModuleFinancialReports}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.mrModuleFinancialReportsDesc}</div>
            </div>
            <label style={{ ...styles.toggle, background: form.module_financial_reports ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.module_financial_reports} onChange={e => set('module_financial_reports', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.module_financial_reports ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
        </div>}
        {!collapsed.modules && <SectionFooter section="modules" />}
      </div>

      {/* ── Features ── */}
      <div style={styles.section}>
        <div style={{ ...styles.sectionHeader, cursor: 'pointer' }} onClick={() => toggleCollapse('features')} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggleCollapse('features')}>
          <span style={styles.sectionIcon}>🧩</span>
          <div style={{ flex: 1 }}>
            <div style={styles.sectionTitle}>{t.featuresTitle}</div>
            <div style={styles.sectionSub}>{t.featuresSubtitle}</div>
          </div>
          <span style={styles.collapseChevron}>{collapsed.features ? '▶' : '▼'}</span>
        </div>
        {!collapsed.features && <div style={styles.sectionBody}>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.mrFeatProjectIntegration}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.mrFeatProjectIntegrationDesc}</div>
            </div>
            <label style={{ ...styles.toggle, background: form.feature_project_integration ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.feature_project_integration} onChange={e => set('feature_project_integration', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.feature_project_integration ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.featScheduling}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.featSchedulingDesc}</div>
            </div>
            <label style={{ ...styles.toggle, background: form.feature_scheduling ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.feature_scheduling} onChange={e => set('feature_scheduling', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.feature_scheduling ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.featAnalytics}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.featAnalyticsDesc}</div>
            </div>
            <label style={{ ...styles.toggle, background: form.module_analytics ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.module_analytics} onChange={e => {
                set('module_analytics', e.target.checked);
                set('feature_analytics', e.target.checked);
              }} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.module_analytics ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.mrFeatPublic || 'Public'}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.mrFeatPublicDesc || 'Show the Public tab for company profile and request intake settings'}</div>
            </div>
            <label style={{ ...styles.toggle, background: form.feature_public ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.feature_public} onChange={e => set('feature_public', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.feature_public ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.featChat}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.featChatDesc}</div>
            </div>
            <label style={{ ...styles.toggle, background: form.feature_chat ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.feature_chat} onChange={e => set('feature_chat', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.feature_chat ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.featGeolocation}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.featGeolocationDesc}</div>
            </div>
            <label style={{ ...styles.toggle, background: form.feature_geolocation ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.feature_geolocation} onChange={e => set('feature_geolocation', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.feature_geolocation ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.mrFeatBroadcast}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.mrFeatBroadcastDesc}</div>
            </div>
            <label style={{ ...styles.toggle, background: form.feature_broadcast ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.feature_broadcast} onChange={e => set('feature_broadcast', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.feature_broadcast ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.mrFeatMediaGallery}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.mrFeatMediaGalleryDesc}</div>
            </div>
            <label style={{ ...styles.toggle, background: form.feature_media_gallery ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.feature_media_gallery} onChange={e => set('feature_media_gallery', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.feature_media_gallery ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.featReimbursements || 'Reimbursements'}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.featReimbursementsDesc || 'Team members submit mileage and expense reimbursements for admin approval'}</div>
            </div>
            <label style={{ ...styles.toggle, background: form.feature_reimbursements ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.feature_reimbursements} onChange={e => set('feature_reimbursements', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.feature_reimbursements ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.featPto || 'Paid Time Off'}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.featPtoDesc || 'Workers request time off, admins approve, optional PTO balance tracking'}</div>
            </div>
            <label style={{ ...styles.toggle, background: form.feature_pto ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.feature_pto} onChange={e => set('feature_pto', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.feature_pto ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.mrFeatGlobalChecklist}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.mrFeatGlobalChecklistDesc}</div>
            </div>
            <select
              style={{ ...styles.input, width: 'auto', textAlign: 'left', minWidth: 160 }}
              value={form.global_required_checklist_template_id}
              onChange={e => set('global_required_checklist_template_id', e.target.value)}
            >
              <option value="">{t.none}</option>
              {checklistTemplates.map(ct => (
                <option key={ct.id} value={String(ct.id)}>{ct.name}</option>
              ))}
            </select>
          </div>
        </div>}
        {!collapsed.features && <SectionFooter section="features" />}
      </div>

      {/* ── Experimental (UI gated by experimentalSettings.js — not built
              by default, flip ENABLED there to expose the section) ── */}
      {EXPERIMENTAL_SETTINGS_ENABLED && (
        <div style={styles.section}>
          <div style={{ ...styles.sectionHeader, cursor: 'pointer' }} onClick={() => toggleCollapse('experimental')} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggleCollapse('experimental')}>
            <span style={styles.sectionIcon}>🧪</span>
            <div style={{ flex: 1 }}>
              <div style={styles.sectionTitle}>Experimental</div>
              <div style={styles.sectionSub}>Toggles whose UX hasn't been finalized. May be removed without notice.</div>
            </div>
            <span style={styles.collapseChevron}>{collapsed.experimental ? '▶' : '▼'}</span>
          </div>
          {!collapsed.experimental && <div style={styles.sectionBody}>
            <div style={styles.row}>
              <div>
                <div style={styles.label}>Admin can edit / split worker time</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                  When OFF, admins cannot edit a worker's start/end times or split an entry across projects. Server returns 403 on those endpoints. Per-admin restrictions still go through Roles &amp; Permissions; this is a company-wide kill switch.
                </div>
              </div>
              <label style={{ ...styles.toggle, background: form.feature_admin_edit_time ? 'var(--ops-page-accent)' : '#d1d5db' }}>
                <input type="checkbox" checked={form.feature_admin_edit_time} onChange={e => set('feature_admin_edit_time', e.target.checked)} style={{ display: 'none' }} />
                <span style={{ ...styles.toggleKnob, transform: form.feature_admin_edit_time ? 'translateX(46px)' : 'translateX(0)' }} />
              </label>
            </div>
            <div style={styles.row}>
              <div>
            <div style={styles.label}>Team members can edit their own time</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
            When OFF, team members can't change a saved entry's times — they have to ask an admin to make the change. The 7-day window and pay-period locks still apply on top of this.
                </div>
              </div>
              <label style={{ ...styles.toggle, background: form.feature_worker_edit_time ? 'var(--ops-page-accent)' : '#d1d5db' }}>
                <input type="checkbox" checked={form.feature_worker_edit_time} onChange={e => set('feature_worker_edit_time', e.target.checked)} style={{ display: 'none' }} />
                <span style={{ ...styles.toggleKnob, transform: form.feature_worker_edit_time ? 'translateX(46px)' : 'translateX(0)' }} />
              </label>
            </div>
          </div>}
          {!collapsed.experimental && <SectionFooter section="experimental" />}
        </div>
      )}

      {/* ── Team Member Access ── */}
      <div style={styles.section}>
        <div style={{ ...styles.sectionHeader, cursor: 'pointer' }} onClick={() => toggleCollapse('access')} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggleCollapse('access')}>
          <span style={styles.sectionIcon}>👁️</span>
          <div style={{ flex: 1 }}>
            <div style={styles.sectionTitle}>{t.ratesWorkerAccess}</div>
            <div style={styles.sectionSub}>{t.ratesWorkerAccessDesc}</div>
          </div>
          <span style={styles.collapseChevron}>{collapsed.access ? '▶' : '▼'}</span>
        </div>
        {!collapsed.access && <div style={styles.sectionBody}>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.ratesShowWages}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.ratesShowWagesDesc}</div>
            </div>
            <label style={{ ...styles.toggle, background: form.show_worker_wages ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.show_worker_wages} onChange={e => set('show_worker_wages', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.show_worker_wages ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.mrDefaultTempPassword}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.mrDefaultTempPasswordDesc}</div>
            </div>
            <input
              style={{ ...styles.input, width: 180, textAlign: 'right' }}
              type="text"
              placeholder={t.tempPasswordPlaceholder}
              value={form.default_temp_password}
              onChange={e => set('default_temp_password', e.target.value)}
            />
          </div>
          <div className="invoice-sig-row" style={styles.row}>
            <div>
              <div style={styles.label}>{t.mrInvoiceSig}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.mrInvoiceSigDesc}</div>
            </div>
            <select
              style={{ ...styles.input, width: 'auto', textAlign: 'left' }}
              value={form.invoice_signature}
              onChange={e => set('invoice_signature', e.target.value)}
            >
              <option value="none">{t.mrInvoiceSigNone}</option>
              <option value="optional">{t.mrInvoiceSigOptional}</option>
              <option value="required">{t.mrInvoiceSigRequired}</option>
            </select>
          </div>
        </div>}
        {!collapsed.access && <SectionFooter section="access" />}
      </div>

      {/* ── Company Standards ── */}
      <div style={styles.section}>
        <div style={{ ...styles.sectionHeader, cursor: 'pointer' }} onClick={() => toggleCollapse('standards')} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggleCollapse('standards')}>
          <span style={styles.sectionIcon}>📏</span>
          <div style={{ flex: 1 }}>
            <div style={styles.sectionTitle}>{t.mrStandardsTitle}</div>
            <div style={styles.sectionSub}>{t.mrStandardsSub}</div>
          </div>
          <span style={styles.collapseChevron}>{collapsed.standards ? '▶' : '▼'}</span>
        </div>
        {!collapsed.standards && <div style={styles.sectionBody}>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.mrWeekStartsOn}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.mrWeekStartsDesc}</div>
            </div>
            <div style={styles.inputGroup}>
              <select style={{ ...styles.input, width: 'auto', textAlign: 'left' }} value={form.week_start} onChange={e => set('week_start', e.target.value)}>
                <option value="0">{t.daySunday}</option>
                <option value="1">{t.dayMonday}</option>
                <option value="2">{t.dayTuesday}</option>
                <option value="3">{t.dayWednesday}</option>
                <option value="4">{t.dayThursday}</option>
                <option value="5">{t.dayFriday}</option>
                <option value="6">{t.daySaturday}</option>
              </select>
            </div>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.mrCompanyTimezone}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.mrCompanyTimezoneDesc}</div>
            </div>
            <div style={styles.inputGroup}>
              <select style={{ ...styles.input, width: 'auto', textAlign: 'left' }} value={form.company_timezone} onChange={e => set('company_timezone', e.target.value)}>
                <option value="">{t.mrUseBrowserTimezone}</option>
                {TIMEZONES.map(tz => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
              </select>
            </div>
          </div>
          {/* Work hours window — used by inactive-worker alerts, after-hours
              clock-in alerts, and the scheduled report digests. Lives here
              (not under "Track Inactive Workers") so toggling that off
              doesn't also disable the after-hours / report timing. */}
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.mrWorkHoursWindow}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.mrWorkHoursWindowDesc}</div>
            </div>
            <label style={{ ...styles.toggle, background: form.notification_use_work_hours ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.notification_use_work_hours} onChange={e => set('notification_use_work_hours', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.notification_use_work_hours ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          {form.notification_use_work_hours && (
            <div style={styles.row}>
              <label style={styles.label}>{t.mrHoursRange}</label>
              <div style={styles.inputGroup}>
                <select style={styles.input} value={form.notification_start_hour} onChange={e => set('notification_start_hour', e.target.value)}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`}</option>
                  ))}
                </select>
                <span style={styles.suffix}>–</span>
                <select style={styles.input} value={form.notification_end_hour} onChange={e => set('notification_end_hour', e.target.value)}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`}</option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>}
        {!collapsed.standards && <SectionFooter section="standards" />}
      </div>

      {/* ── Wages ── */}
      <div style={styles.section}>
        <div style={{ ...styles.sectionHeader, cursor: 'pointer' }} onClick={() => toggleCollapse('wages')} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggleCollapse('wages')}>
          <span style={styles.sectionIcon}>💰</span>
          <div style={{ flex: 1 }}>
            <div style={styles.sectionTitle}>{t.ratesWages}</div>
            <div style={styles.sectionSub}>{t.ratesWagesDesc}</div>
          </div>
          <span style={styles.collapseChevron}>{collapsed.wages ? '▶' : '▼'}</span>
        </div>
        {!collapsed.wages && <div style={styles.sectionBody}>
          <div style={styles.row}>
            <label style={styles.label}>{t.ratesCurrency}</label>
            <div style={styles.inputGroup}>
              <select style={{ ...styles.input, width: 'auto', textAlign: 'left' }} value={form.currency} onChange={e => set('currency', e.target.value)}>
                {CURRENCIES.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </div>
          </div>
          <div style={styles.row}>
            <label style={styles.label}>{t.ratesPrevailingWage}<HelpTip text={t.ratesPrevailingWageHelp} /></label>
            {!prevailingEnabled
              ? <button style={styles.addPrevBtn} type="button" onClick={() => { setPrevailingEnabled(true); set('prevailing_wage_rate', '0'); }}>+ Add</button>
              : <div style={styles.inputGroup}>
                  <span style={styles.prefix}>{currencySymbol(form.currency)}</span>
                  <input style={styles.input} type="number" min="0" step="0.01" value={form.prevailing_wage_rate} onChange={e => set('prevailing_wage_rate', e.target.value)} required />
                  <span style={styles.suffix}>/hr</span>
                </div>
            }
          </div>
          <div style={styles.row}>
            <label style={styles.label}>{t.ratesDefaultWage}</label>
            <div style={styles.inputGroup}>
              <span style={styles.prefix}>{currencySymbol(form.currency)}</span>
              <input style={styles.input} type="number" min="0" step="0.01" value={form.default_hourly_rate} onChange={e => set('default_hourly_rate', e.target.value)} required />
              <span style={styles.suffix}>/hr</span>
            </div>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.mrAllowOvertime}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.mrAllowOvertimeDesc}</div>
            </div>
            <label style={{ ...styles.toggle, background: form.feature_overtime ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.feature_overtime} onChange={e => set('feature_overtime', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.feature_overtime ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
        </div>}
        {!collapsed.wages && <SectionFooter section="wages" />}
      </div>

      {/* ── Overtime ── */}
      {form.feature_overtime && <div style={styles.section}>
        <div style={{ ...styles.sectionHeader, cursor: 'pointer' }} onClick={() => toggleCollapse('overtime')} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggleCollapse('overtime')}>
          <span style={styles.sectionIcon}>⏱️</span>
          <div style={{ flex: 1 }}>
            <div style={styles.sectionTitle}>{t.ratesOvertime}</div>
            <div style={styles.sectionSub}>{t.ratesOvertimeDesc}</div>
          </div>
          <span style={styles.collapseChevron}>{collapsed.overtime ? '▶' : '▼'}</span>
        </div>
        {!collapsed.overtime && <div style={styles.sectionBody}>
          <div style={styles.row}>
            <label style={styles.label}>{t.ratesOTRate}</label>
            <div style={styles.inputGroup}>
              <input style={styles.input} type="number" min="1" step="0.01" value={form.overtime_multiplier} onChange={e => set('overtime_multiplier', e.target.value)} required />
              <span style={styles.suffix}>{t.ratesXRegularPay}</span>
            </div>
          </div>
          <div style={styles.row}>
            <label style={styles.label}>{t.ratesCalcMethod}<HelpTip text={t.ratesCalcMethodHelp} /></label>
            <div style={styles.inputGroup}>
              <select style={{ ...styles.input, width: 'auto', textAlign: 'left' }} value={form.overtime_rule} onChange={e => set('overtime_rule', e.target.value)}>
                <option value="daily">{t.ratesDailyMethod}</option>
                <option value="weekly">{t.ratesWeeklyMethod}</option>
              </select>
            </div>
          </div>
          <div style={styles.row}>
            <label style={styles.label}>{form.overtime_rule === 'weekly' ? t.ratesWeeklyThreshold : t.ratesDailyThreshold}</label>
            <div style={styles.inputGroup}>
              <input style={styles.input} type="number" min="1" step="0.5" value={form.overtime_threshold} onChange={e => set('overtime_threshold', e.target.value)} required />
              <span style={styles.suffix}>{t.ratesHrs}</span>
            </div>
          </div>
        </div>}
        {!collapsed.overtime && <SectionFooter section="overtime" />}
      </div>}

      {/* ── Certified Payroll (addon-gated) ── */}
      {plan.hasCertifiedPayroll && (
      <div style={styles.section}>
        <div style={{ ...styles.sectionHeader, cursor: 'pointer' }} onClick={() => toggleCollapse('certifiedPayroll')} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggleCollapse('certifiedPayroll')}>
          <span style={styles.sectionIcon}>📜</span>
          <div style={{ flex: 1 }}>
            <div style={styles.sectionTitle}>{t.mrCpTitle}</div>
            <div style={styles.sectionSub}>{t.mrCpSub}</div>
          </div>
          <span style={styles.collapseChevron}>{collapsed.certifiedPayroll ? '▶' : '▼'}</span>
        </div>
        {!collapsed.certifiedPayroll && <div style={styles.sectionBody}>
          {[
            { key: 'cp_track_classifications', label: t.mrCpTrackClass,       desc: t.mrCpTrackClassDesc },
            { key: 'cp_track_fringes',         label: t.mrCpTrackFringes,     desc: t.mrCpTrackFringesDesc },
            { key: 'cp_collect_ssn',           label: t.mrCpCollectSsn,       desc: t.mrCpCollectSsnDesc },
            { key: 'cp_require_signature',     label: t.mrCpRequireSig,       desc: t.mrCpRequireSigDesc },
            { key: 'cp_wh347_format',          label: t.mrCpWh347Format,      desc: t.mrCpWh347FormatDesc },
            { key: 'cp_compute_deductions',    label: t.mrCpComputeDeductions, desc: t.mrCpComputeDeductionsDesc, risky: true },
          ].map(f => (
            <div key={f.key} style={styles.row}>
              <div>
                <div style={styles.label}>{f.label}</div>
                <div style={{ fontSize: 12, color: f.risky ? '#b91c1c' : '#6b7280', marginTop: 2 }}>{f.desc}</div>
              </div>
              <label style={{ ...styles.toggle, background: form[f.key] ? 'var(--ops-page-accent)' : '#d1d5db' }}>
                <input type="checkbox" checked={!!form[f.key]} onChange={e => set(f.key, e.target.checked)} style={{ display: 'none' }} />
                <span style={{ ...styles.toggleKnob, transform: form[f.key] ? 'translateX(46px)' : 'translateX(0)' }} />
              </label>
            </div>
          ))}
        </div>}
        {!collapsed.certifiedPayroll && <SectionFooter section="certifiedPayroll" />}
      </div>)}

      {/* ── PTO (feature-gated) ── */}
      {form.feature_pto && (
      <div style={styles.section}>
        <div style={{ ...styles.sectionHeader, cursor: 'pointer' }} onClick={() => toggleCollapse('pto')} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggleCollapse('pto')}>
          <span style={styles.sectionIcon}>🌴</span>
          <div style={{ flex: 1 }}>
            <div style={styles.sectionTitle}>{t.ratesPto || 'Paid Time Off'}</div>
            <div style={styles.sectionSub}>{t.ratesPtoDesc || 'Annual PTO balance tracking per worker'}</div>
          </div>
          <span style={styles.collapseChevron}>{collapsed.pto ? '▶' : '▼'}</span>
        </div>
        {!collapsed.pto && <div style={styles.sectionBody}>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.ratesPtoAnnualDays || 'Annual PTO days per worker'}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.ratesPtoAnnualDaysDesc || 'Applies to every worker unless overridden. Set to 0 to disable PTO balance tracking.'}</div>
            </div>
            {((parseFloat(form.pto_annual_days) || 0) > 0 || ptoEditing) ? (
              <div style={styles.inputGroup}>
                <input
                  style={styles.input}
                  type="number" min="0" max="365" step="1"
                  value={form.pto_annual_days}
                  onChange={e => set('pto_annual_days', e.target.value)}
                  autoFocus={ptoEditing && (parseFloat(form.pto_annual_days) || 0) === 0}
                />
                <span style={styles.suffix}>{t.ratesDays || 'days'}</span>
              </div>
            ) : (
              <button
                type="button"
                style={styles.enableBtn}
                onClick={() => { setPtoEditing(true); set('pto_annual_days', '10'); }}
              >
                + {t.ratesPtoEnable || 'Enable PTO tracking'}
              </button>
            )}
          </div>
        </div>}
        {!collapsed.pto && <SectionFooter section="pto" />}
      </div>
      )}

      {/* ── Reimbursements (feature-gated) ── */}
      {form.feature_reimbursements && (
        <div style={styles.section}>
          <div style={{ ...styles.sectionHeader, cursor: 'pointer' }} onClick={() => toggleCollapse('reimbursements')} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggleCollapse('reimbursements')}>
            <span style={styles.sectionIcon}>🧾</span>
            <div style={{ flex: 1 }}>
              <div style={styles.sectionTitle}>{t.ratesReimbursements || 'Reimbursements'}</div>
              <div style={styles.sectionSub}>{t.ratesReimbursementsDesc || 'Mileage rate and other reimbursement settings'}</div>
            </div>
            <span style={styles.collapseChevron}>{collapsed.reimbursements ? '▶' : '▼'}</span>
          </div>
          {!collapsed.reimbursements && (
            <div style={styles.sectionBody}>
              <MileageRateEditor />
            </div>
          )}
        </div>
      )}

      {/* ── Inventory Count (module-gated) ── */}
      {form.module_inventory && (
        <div style={styles.section}>
          <div style={{ ...styles.sectionHeader, cursor: 'pointer' }} onClick={() => toggleCollapse('inventoryCount')} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggleCollapse('inventoryCount')}>
            <span style={styles.sectionIcon}>📦</span>
            <div style={{ flex: 1 }}>
              <div style={styles.sectionTitle}>{t.ratesInventoryCount || 'Inventory Count'}</div>
              <div style={styles.sectionSub}>{t.ratesInventoryCountDesc || 'Audit and reconciliation thresholds for full and cycle counts'}</div>
            </div>
            <span style={styles.collapseChevron}>{collapsed.inventoryCount ? '▶' : '▼'}</span>
          </div>
          {!collapsed.inventoryCount && <div style={styles.sectionBody}>
            <div style={styles.row}>
              <div>
                <div style={styles.label}>Audit %</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>Percentage of counted items randomly selected for audit (0–100)</div>
              </div>
              <input style={{ ...styles.input, width: 70 }} type="number" min="0" max="100" step="1"
                value={form.cycle_count_audit_pct}
                onChange={e => set('cycle_count_audit_pct', e.target.value)} />
            </div>
            <div style={styles.row}>
              <div>
                <div style={styles.label}>Reconcile Threshold</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>Variance that triggers reconciliation (0 = never)</div>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input style={{ ...styles.input, width: 80 }} type="number" min="0" step="any"
                  value={form.cycle_count_reconcile_threshold}
                  onChange={e => set('cycle_count_reconcile_threshold', e.target.value)} />
                <select style={{ ...styles.input, width: 90 }}
                  value={form.cycle_count_reconcile_threshold_type}
                  onChange={e => set('cycle_count_reconcile_threshold_type', e.target.value)}>
                  <option value="units">units</option>
                  <option value="pct">%</option>
                </select>
              </div>
            </div>
          </div>}
          {!collapsed.inventoryCount && <SectionFooter section="inventoryCount" />}
        </div>
      )}

      {/* ── Notifications ── */}
      <div style={styles.section}>
        <div style={{ ...styles.sectionHeader, cursor: 'pointer' }} onClick={() => toggleCollapse('notifications')} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggleCollapse('notifications')}>
          <span style={styles.sectionIcon}>🔔</span>
          <div style={{ flex: 1 }}>
            <div style={styles.sectionTitle}>{t.ratesNotifications}</div>
            <div style={styles.sectionSub}>{t.ratesNotificationsDesc}</div>
          </div>
          <span style={styles.collapseChevron}>{collapsed.notifications ? '▶' : '▼'}</span>
        </div>
        {!collapsed.notifications && <div style={styles.sectionBody}>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>Track Inactive Workers</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>Send alerts when workers haven't submitted entries</div>
            </div>
            <label style={{ ...styles.toggle, background: form.feature_inactive_alerts ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.feature_inactive_alerts} onChange={e => set('feature_inactive_alerts', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.feature_inactive_alerts ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          {form.feature_inactive_alerts && <div style={styles.row}>
            <label style={styles.label}>{t.ratesAlertInactive}</label>
            <div style={styles.inputGroup}>
              <input style={styles.input} type="number" min="1" max="30" step="1" value={form.notification_inactive_days} onChange={e => set('notification_inactive_days', e.target.value)} required />
              <span style={styles.suffix}>{t.ratesDays}</span>
            </div>
          </div>}
          <div style={styles.row}>
            <div>
              <div style={styles.label}>Overtime Alerts</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>Notify admins when a worker crosses the overtime threshold</div>
            </div>
            <label style={{ ...styles.toggle, background: form.feature_overtime_alerts ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.feature_overtime_alerts} onChange={e => set('feature_overtime_alerts', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.feature_overtime_alerts ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          {form.feature_pto && (
            <div style={styles.row}>
              <div>
                <div style={styles.label}>Time Off Request Notifications</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>Email admins when a worker submits a time off request</div>
              </div>
              <label style={{ ...styles.toggle, background: form.notify_timeoff_requests ? 'var(--ops-page-accent)' : '#d1d5db' }}>
                <input type="checkbox" checked={form.notify_timeoff_requests} onChange={e => set('notify_timeoff_requests', e.target.checked)} style={{ display: 'none' }} />
                <span style={{ ...styles.toggleKnob, transform: form.notify_timeoff_requests ? 'translateX(46px)' : 'translateX(0)' }} />
              </label>
            </div>
          )}
          <div style={styles.row}>
            <div>
              <div style={styles.label}>Budget Alert Notifications</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>Email admins when a project reaches 90% or 100% of its hour budget</div>
            </div>
            <label style={{ ...styles.toggle, background: form.notify_budget_alerts ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.notify_budget_alerts} onChange={e => set('notify_budget_alerts', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.notify_budget_alerts ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>Entry Submitted Notifications</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>Email admins each time a worker submits a time entry</div>
            </div>
            <label style={{ ...styles.toggle, background: form.notify_entry_submitted ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.notify_entry_submitted} onChange={e => set('notify_entry_submitted', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.notify_entry_submitted ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>{t.ratesShiftReminderHour}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>Hour to send tomorrow's shift push notifications</div>
            </div>
            <select style={styles.input} value={form.shift_reminder_hour} onChange={e => set('shift_reminder_hour', e.target.value)}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`}</option>
              ))}
            </select>
          </div>
          <div style={styles.row}>
            <label style={styles.label}>{t.ratesClearChat}</label>
            <div style={styles.inputGroup}>
              <input style={styles.input} type="number" min="1" max="90" step="1" value={form.chat_retention_days} onChange={e => set('chat_retention_days', e.target.value)} required />
              <span style={styles.suffix}>{t.ratesDays}</span>
            </div>
          </div>
        </div>}
        {!collapsed.notifications && <SectionFooter section="notifications" />}
      </div>

      {/* ── Scheduled Reports ── */}
      <div style={styles.section}>
        <div style={{ ...styles.sectionHeader, cursor: 'pointer' }} onClick={() => toggleCollapse('reports')} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggleCollapse('reports')}>
          <span style={styles.sectionIcon}>📧</span>
          <div style={{ flex: 1 }}>
            <div style={styles.sectionTitle}>Scheduled Email Reports</div>
            <div style={styles.sectionSub}>Automated email summaries sent to the primary admin. All off by default.</div>
          </div>
          <span style={styles.collapseChevron}>{collapsed.reports ? '▶' : '▼'}</span>
        </div>
        {!collapsed.reports && <div style={styles.sectionBody}>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>Weekly Payroll Summary</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>Every Monday — total hours and overtime per worker for the prior week</div>
            </div>
            <label style={{ ...styles.toggle, background: form.report_weekly_payroll ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.report_weekly_payroll} onChange={e => set('report_weekly_payroll', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.report_weekly_payroll ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>Weekly Low-Stock Report</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>Every Monday — items at or below their reorder point (skipped if none)</div>
            </div>
            <label style={{ ...styles.toggle, background: form.report_weekly_low_stock ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.report_weekly_low_stock} onChange={e => set('report_weekly_low_stock', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.report_weekly_low_stock ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
          <div style={styles.row}>
            <div>
              <div style={styles.label}>Monthly Inventory Valuation</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>1st of each month — full inventory value breakdown by item</div>
            </div>
            <label style={{ ...styles.toggle, background: form.report_monthly_valuation ? 'var(--ops-page-accent)' : '#d1d5db' }}>
              <input type="checkbox" checked={form.report_monthly_valuation} onChange={e => set('report_monthly_valuation', e.target.checked)} style={{ display: 'none' }} />
              <span style={{ ...styles.toggleKnob, transform: form.report_monthly_valuation ? 'translateX(46px)' : 'translateX(0)' }} />
            </label>
          </div>
        </div>}
        {!collapsed.reports && <SectionFooter section="reports" />}
      </div>

      {/* ── Storage ── */}
      {(() => {
        const used = settings?.storage_bytes_used ?? 0;
        const limit = settings?.storage_limit_bytes ?? (500 * 1024 * 1024);
        const pct = Math.min(100, Math.round((used / limit) * 100));
        const nearLimit = pct >= 80;
        const atLimit = pct >= 100;
        return (
          <div style={styles.section}>
            <div style={{ ...styles.sectionHeader, cursor: 'pointer' }} onClick={() => toggleCollapse('storage')} role="button" tabIndex={0} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggleCollapse('storage')}>
              <span style={styles.sectionIcon}>💾</span>
              <div style={{ flex: 1 }}>
                <div style={styles.sectionTitle}>Storage</div>
                <div style={styles.sectionSub}>{formatBytes(used)} of {formatBytes(limit)} used</div>
              </div>
              <span style={styles.collapseChevron}>{collapsed.storage ? '▶' : '▼'}</span>
            </div>
            {!collapsed.storage && (
              <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: atLimit ? '#ef4444' : nearLimit ? '#d97706' : '#374151', fontWeight: 600 }}>
                  <span>{formatBytes(used)} used</span>
                  <span>{formatBytes(limit)} limit</span>
                </div>
                <div style={{ height: 10, background: '#f3f4f6', borderRadius: 99, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${pct}%`, background: atLimit ? '#ef4444' : nearLimit ? '#f59e0b' : 'var(--ops-page-accent)', borderRadius: 99, transition: 'width 0.4s' }} />
                </div>
                {atLimit && (
                  <div style={{ fontSize: 13, color: '#ef4444', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 7, padding: '8px 12px' }}>
                    Storage limit reached. New photo and file uploads are blocked. Upgrade your plan to continue.
                  </div>
                )}
                {nearLimit && !atLimit && (
                  <div style={{ fontSize: 13, color: '#92400e', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 7, padding: '8px 12px' }}>
                    Approaching storage limit. Consider upgrading your plan or deleting old media.
                  </div>
                )}
                <div style={{ fontSize: 12, color: '#6b7280' }}>
                  Media includes field report photos, videos, and safety talk attachments.
                  Free plan: 500 MB · Starter: 5 GB · Business: 25 GB
                </div>
              </div>
            )}
            {!collapsed.storage && (
              <>
                <div style={styles.row}>
                  <div>
                    <div style={styles.label}>Auto-delete media after</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>Automatically delete photos and attachments older than this many days</div>
                  </div>
                  {parseFloat(form.media_retention_days) === 0 ? (
                    <button
                      type="button"
                      style={{ padding: '7px 16px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
                      onClick={() => set('media_retention_days', '30')}
                    >
                      Turn on
                    </button>
                  ) : (
                    <div style={styles.inputGroup}>
                      <input
                        style={styles.input}
                        type="number"
                        min="1"
                        step="1"
                        value={form.media_retention_days}
                        onChange={e => set('media_retention_days', e.target.value)}
                      />
                      <span style={styles.suffix}>days</span>
                    </div>
                  )}
                </div>
                <div style={styles.row}>
                  <div>
                    <div style={styles.label}>Delete media on project archive</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>When a project is archived, permanently delete all its photos and attachments</div>
                  </div>
                  <label style={{ ...styles.toggle, background: form.media_delete_on_project_archive ? 'var(--ops-page-accent)' : '#d1d5db' }}>
                    <input type="checkbox" checked={form.media_delete_on_project_archive} onChange={e => set('media_delete_on_project_archive', e.target.checked)} style={{ display: 'none' }} />
                    <span style={{ ...styles.toggleKnob, transform: form.media_delete_on_project_archive ? 'translateX(46px)' : 'translateX(0)' }} />
                  </label>
                </div>
                <SectionFooter section="storage" />
              </>
            )}
          </div>
        );
      })()}

    </div>
  );
}

const styles = {
  form: { display: 'flex', flexDirection: 'column', gap: 12 },
  section: { background: '#fff', borderRadius: 12, boxShadow: '0 1px 6px rgba(0,0,0,0.07)', overflow: 'hidden' },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px', borderBottom: '1px solid #f3f4f6', background: '#fafafa' },
  sectionIcon: { fontSize: 20, lineHeight: 1 },
  sectionTitle: { fontSize: 14, fontWeight: 700, color: '#111827' },
  sectionSub: { fontSize: 12, color: '#6b7280', marginTop: 1 },
  sectionBody: { display: 'flex', flexDirection: 'column' },
  sectionFooter: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, padding: '12px 20px', borderTop: '1px solid #f3f4f6', background: '#fafafa' },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '12px 20px', borderBottom: '1px solid #f9fafb' },
  label: { fontSize: 13, fontWeight: 500, color: '#374151' },
  inputGroup: { display: 'flex', alignItems: 'center', gap: 6 },
  prefix: { fontSize: 14, color: '#6b7280' },
  suffix: { fontSize: 13, color: '#6b7280', whiteSpace: 'nowrap' },
  toggle: { display: 'flex', alignItems: 'center', width: 70, height: 40, borderRadius: 7, border: 'none', cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0, padding: 4 },
  toggleKnob: { display: 'block', width: 16, height: 32, borderRadius: 5, background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'transform 0.2s', flexShrink: 0 },
  input: { width: 90, padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 14, textAlign: 'right' },
  savedMsg: { color: '#059669', fontSize: 13, fontWeight: 600 },
  errorMsg: { color: '#e53e3e', fontSize: 13 },
  saveBtn: { padding: '7px 18px', background: 'var(--ops-page-accent)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  addPrevBtn: { padding: '6px 14px', background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  enableBtn: { padding: '6px 14px', background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' },
  collapseChevron: { fontSize: 11, color: '#6b7280' },
};
