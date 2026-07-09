const FEATURE_KEYS = ['feature_scheduling', 'feature_analytics', 'feature_public', 'feature_chat', 'feature_prevailing_wage', 'feature_reimbursements', 'feature_pto', 'module_field', 'module_timeclock', 'module_work', 'module_inventory', 'module_tools', 'module_analytics', 'module_team', 'module_financial_reports', 'feature_project_integration', 'feature_overtime', 'feature_geolocation', 'feature_inactive_alerts', 'feature_overtime_alerts', 'feature_broadcast', 'feature_media_gallery', 'feature_admin_edit_time', 'feature_worker_edit_time', 'show_worker_wages', 'notification_use_work_hours', 'media_delete_on_project_archive', 'notify_timeoff_requests', 'notify_budget_alerts', 'notify_entry_submitted', 'report_weekly_payroll', 'report_weekly_low_stock', 'report_monthly_valuation', 'qbo_auto_push', 'qbo_auto_push_expenses', 'qbo_auto_create_customers', 'notify_qbo_disconnect', 'cp_track_classifications', 'cp_track_fringes', 'cp_collect_ssn', 'cp_require_signature', 'cp_compute_deductions', 'cp_wh347_format', 'hide_work_orders_tab', 'hide_projects_tab'];
const STRING_KEYS = ['overtime_rule', 'currency', 'company_timezone', 'invoice_signature', 'default_temp_password', 'global_required_checklist_template_id', 'cycle_count_reconcile_threshold_type', 'qbo_expense_account_id', 'qbo_bank_account_id', 'qbo_labor_item_id', 'setup_questionnaire_completed_at', 'label_work', 'label_client', 'label_worker', 'label_field', 'hours_rules'];

// Defaults available to all authenticated users
const SETTINGS_DEFAULTS = {
  prevailing_wage_rate: 45, default_hourly_rate: 30, overtime_multiplier: 1.5,
  overtime_rule: 'daily', overtime_threshold: 8,
  // feature_chat and feature_broadcast start OFF — both are optional
  // engagement features most teams don't enable on day one. Migration
  // 0095 backfilled '1' for existing companies so the flip is a no-op
  // for them.
  feature_scheduling: true, feature_analytics: true, feature_public: true, feature_chat: false, feature_prevailing_wage: true, feature_reimbursements: true, feature_pto: true,
  // Module defaults — minimal setup for new companies. Field, Inventory,
  // and Analytics start OFF; admin can flip them on from Company Settings.
  // Migration 0093 backfilled '1' rows for every existing company so this
  // default change is a no-op for them.
  module_field: false, module_timeclock: true, module_work: true, module_inventory: false, module_tools: false, module_analytics: false, module_team: true,
  // Reports module's financial tabs (P&L portfolio + WIP). New companies start
  // OFF; admins enable from Company Settings → Modules. Migration 0118
  // backfilled '1' for existing companies. (Sales and Subcontractors are NOT
  // their own modules — they're tabs of Projects / Directory and follow those.)
  module_financial_reports: false,
  // Work module: hide the Projects or Work Orders tab for shops that only do one.
  // Both default OFF (both tabs shown). The app never hides both at once.
  hide_work_orders_tab: false, hide_projects_tab: false,
  // feature_inactive_alerts starts OFF — most teams find the daily inactive
  // digest noisy out of the box. Migration 0094 backfilled '1' for existing
  // companies so this default flip is a no-op for them.
  feature_project_integration: true, feature_overtime: true, feature_geolocation: true, feature_inactive_alerts: false, feature_overtime_alerts: true, feature_broadcast: false, feature_media_gallery: false,
  // Time-edit gates — both default ON. feature_admin_edit_time controls
  // /admin/entries/:id/edit, /times, and /split. feature_worker_edit_time
  // controls a worker's PATCH /time-entries/:id. Per-admin restrictions
  // should still go through the role-permission system; these toggles are
  // a company-wide policy switch on top of that.
  feature_admin_edit_time: true, feature_worker_edit_time: true,
  show_worker_wages: false, notification_use_work_hours: true, media_delete_on_project_archive: false,
  notify_timeoff_requests: false, notify_budget_alerts: false, notify_entry_submitted: false,
  report_weekly_payroll: false, report_weekly_low_stock: false, report_monthly_valuation: false,
  qbo_auto_push: false, qbo_auto_push_expenses: false, qbo_auto_create_customers: false, notify_qbo_disconnect: false,
  // Certified Payroll sub-settings — only take effect if the addon is active.
  // Defaults: Strategy B (everything on EXCEPT deductions = the risky Strategy A path).
  cp_track_classifications: true,   // Job classification per worker + per entry
  cp_track_fringes: true,           // Per-worker fringe benefits (health, pension, …)
  cp_collect_ssn: true,             // Encrypted SSN last-4 on workers
  cp_require_signature: true,       // Weekly Statement of Compliance
  cp_wh347_format: true,            // Generate PDF matching the official WH-347 layout
  cp_compute_deductions: false,     // Strategy A — OpsFloa computes fed/state/FICA withholdings (OFF by default; payroll processor handles this)
  media_retention_days: 0,
  week_start: 1, // 0=Sunday, 1=Monday, …, 6=Saturday (OpsFloa's default pay-period start)
  currency: 'USD', invoice_signature: 'optional', default_temp_password: '', global_required_checklist_template_id: '',
  label_work: 'Project', label_client: 'Customer', label_worker: 'Team Member', label_field: 'Field Work',
  setup_questionnaire_completed_at: '',
  // Configurable work-hour / pay rules (grace/rounding, tiered OT, premiums)
  // as a JSON policy document. Empty = no policy = the engine is a pure no-op,
  // so existing companies are unaffected. See server/utils/hoursRules.js.
  hours_rules: '',
};

// Admin-only defaults (superset of SETTINGS_DEFAULTS)
const ADMIN_SETTINGS_DEFAULTS = {
  ...SETTINGS_DEFAULTS,
  notification_inactive_days: 3, notification_start_hour: 6, notification_end_hour: 20,
  notification_use_work_hours: true,
  shift_reminder_hour: 7,
  chat_retention_days: 3,
  company_timezone: '',
  pto_annual_days: 0,
  cycle_count_audit_pct: 15,
  cycle_count_reconcile_threshold: 0,
  cycle_count_reconcile_threshold_type: 'units',
  qbo_labor_item_id: '',
  qbo_bill_terms_days: 0,
};

function applySettingsRows(rows, defaults) {
  const s = { ...defaults };
  rows.forEach(r => {
    if (STRING_KEYS.includes(r.key)) s[r.key] = r.value;
    else if (FEATURE_KEYS.includes(r.key)) s[r.key] = r.value === '1';
    else s[r.key] = parseFloat(r.value);
  });
  return s;
}

module.exports = { FEATURE_KEYS, STRING_KEYS, SETTINGS_DEFAULTS, ADMIN_SETTINGS_DEFAULTS, applySettingsRows };
