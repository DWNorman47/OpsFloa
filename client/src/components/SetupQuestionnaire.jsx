import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../api';
import { useToast } from '../contexts/ToastContext';
import { useSettings } from '../contexts/SettingsContext';
import ModalShell from './ModalShell';
import './SetupQuestionnaire.css';

const WORK_OPTIONS = [
  {
    id: 'projects',
    title: 'Projects, jobs, or work orders',
    description: 'Organize customers, budgets, documents, and progress around defined work.',
    icon: 'projects',
  },
  {
    id: 'field',
    title: 'Mobile, field, or service work',
    description: 'Give teams a place for daily notes, photos, checklists, issues, and safety.',
    icon: 'field',
  },
  {
    id: 'inventory',
    title: 'Stock, tools, or materials',
    description: 'Track items, locations, movement, counts, and value.',
    icon: 'inventory',
  },
  {
    id: 'people',
    title: 'People and time',
    description: 'Manage team records, availability, attendance, and time-related work.',
    icon: 'people',
  },
];

const TEAM_OPTIONS = [
  {
    id: 'time',
    title: 'Clock in and out',
    description: 'Record worked time, breaks, mileage, and timesheets.',
    icon: 'clock',
  },
  {
    id: 'scheduling',
    title: 'See scheduled shifts',
    description: 'Plan work ahead and keep upcoming shifts visible.',
    icon: 'calendar',
  },
  {
    id: 'pto',
    title: 'Request time off',
    description: 'Handle vacation and leave requests in the app.',
    icon: 'timeoff',
  },
  {
    id: 'expenses',
    title: 'Submit expenses',
    description: 'Collect reimbursement requests, receipts, and mileage.',
    icon: 'receipt',
  },
  {
    id: 'chat',
    title: 'Receive messages',
    description: 'Use company chat and broadcast announcements.',
    icon: 'message',
  },
  {
    id: 'location',
    title: 'Record clock-in location',
    description: 'Capture location when people start and end work.',
    icon: 'location',
  },
  {
    id: 'admin_only',
    title: 'No employee tools yet',
    description: 'Start with manager-facing records and add employee tools later.',
    icon: 'shield',
    exclusive: true,
  },
];

const MANAGER_OPTIONS = [
  {
    id: 'performance',
    title: 'Performance and labor reports',
    description: 'See trends, hours, attendance, and operational performance.',
    icon: 'chart',
  },
  {
    id: 'financial',
    title: 'Project financial reports',
    description: 'Use portfolio profit-and-loss and work-in-progress views.',
    icon: 'money',
  },
  {
    id: 'overtime',
    title: 'Overtime rules and alerts',
    description: 'Calculate overtime and surface approaching thresholds.',
    icon: 'alert',
  },
  {
    id: 'media',
    title: 'Photos and shared media',
    description: 'Keep visual records connected to daily work.',
    icon: 'camera',
  },
  {
    id: 'compliance',
    title: 'Prevailing-wage tracking',
    description: 'Show wage classification and certified-payroll controls when available.',
    icon: 'document',
  },
  {
    id: 'essentials',
    title: 'Keep management simple',
    description: 'Start with the essential team and approval tools only.',
    icon: 'spark',
    exclusive: true,
  },
];

const LABEL_CHOICES = {
  work: ['Project', 'Job', 'Work Order', 'Route'],
  client: ['Customer', 'Client', 'Account', 'Member'],
  worker: ['Team Member', 'Employee', 'Staff Member', 'Technician'],
  field: ['Field Work', 'Daily Work', 'Operations', 'Service'],
};

const STEPS = ['welcome', 'work', 'team', 'manager', 'language', 'review'];

const SUMMARY_LABELS = {
  module_timeclock: 'Time clock and timesheets',
  module_team: 'Team directory',
  module_projects: 'Projects and work records',
  module_field: 'Field work',
  module_inventory: 'Inventory',
  module_analytics: 'Performance reports',
  module_financial_reports: 'Financial reports',
  feature_scheduling: 'Scheduling',
  feature_pto: 'Time off',
  feature_reimbursements: 'Expenses and reimbursements',
  feature_chat: 'Company chat',
  feature_geolocation: 'Clock-in location',
  feature_media_gallery: 'Photos and media',
  feature_overtime: 'Overtime rules',
  feature_prevailing_wage: 'Prevailing-wage tools',
};

function selectedFromSettings(settings = {}) {
  const labels = {
    work: settings.label_work || 'Project',
    client: settings.label_client || 'Customer',
    worker: settings.label_worker || 'Team Member',
    field: settings.label_field || 'Field Work',
  };

  if (!settings.setup_questionnaire_completed_at) {
    return {
      work: ['projects', 'people'],
      team: ['time'],
      manager: ['essentials'],
      labels,
    };
  }

  const work = [];
  if (settings.module_projects !== false) work.push('projects');
  if (settings.module_field === true) work.push('field');
  if (settings.module_inventory === true) work.push('inventory');
  if (settings.module_team !== false) work.push('people');

  const team = [];
  if (settings.module_timeclock !== false) team.push('time');
  if (settings.feature_scheduling === true) team.push('scheduling');
  if (settings.feature_pto === true) team.push('pto');
  if (settings.feature_reimbursements === true) team.push('expenses');
  if (settings.feature_chat === true) team.push('chat');
  if (settings.feature_geolocation === true) team.push('location');
  if (!team.length) team.push('admin_only');

  const manager = [];
  if (settings.module_analytics === true) manager.push('performance');
  if (settings.module_financial_reports === true) manager.push('financial');
  if (settings.feature_overtime === true) manager.push('overtime');
  if (settings.feature_media_gallery === true) manager.push('media');
  if (settings.feature_prevailing_wage === true) manager.push('compliance');
  if (!manager.length) manager.push('essentials');

  return {
    work,
    team,
    manager,
    labels,
  };
}

export function buildSetupSettings(answers) {
  const work = new Set(answers.work);
  const team = new Set(answers.team);
  const manager = new Set(answers.manager);
  const projectsEnabled = work.has('projects') || work.has('field') || manager.has('financial');

  return {
    module_timeclock: team.has('time'),
    module_team: work.has('people'),
    module_projects: projectsEnabled,
    module_field: work.has('field'),
    module_inventory: work.has('inventory'),
    module_analytics: manager.has('performance'),
    module_financial_reports: manager.has('financial'),
    feature_analytics: manager.has('performance'),
    feature_project_integration: projectsEnabled && team.has('time'),
    feature_scheduling: team.has('scheduling'),
    feature_pto: team.has('pto'),
    feature_reimbursements: team.has('expenses'),
    feature_chat: team.has('chat'),
    feature_broadcast: team.has('chat'),
    feature_geolocation: team.has('location'),
    feature_media_gallery: work.has('field') && manager.has('media'),
    feature_overtime: manager.has('overtime'),
    feature_overtime_alerts: manager.has('overtime'),
    feature_prevailing_wage: manager.has('compliance'),
    label_work: answers.labels.work.trim() || 'Project',
    label_client: answers.labels.client.trim() || 'Customer',
    label_worker: answers.labels.worker.trim() || 'Team Member',
    label_field: answers.labels.field.trim() || 'Field Work',
  };
}

function WizardIcon({ name }) {
  const paths = {
    projects: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 4V2h8v2M7 9h10M7 14h7" /></>,
    field: <><path d="M4 19V8l8-5 8 5v11" /><path d="M8 19v-6h8v6M9 9h6" /></>,
    inventory: <><path d="m4 7 8-4 8 4-8 4-8-4Z" /><path d="m4 7v10l8 4 8-4V7M12 11v10" /></>,
    people: <><circle cx="9" cy="8" r="3" /><path d="M3 20c0-4 2.7-7 6-7s6 3 6 7M16 5.5a3 3 0 0 1 0 5.8M17 14c2.4.7 4 3 4 6" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18M8 14h3M14 14h2M8 18h2" /></>,
    timeoff: <><path d="M5 4h14v16H5zM8 2v4M16 2v4M5 9h14" /><path d="m9 15 2 2 4-5" /></>,
    receipt: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
    message: <><path d="M4 4h16v12H9l-5 4V4Z" /><path d="M8 9h8M8 12h5" /></>,
    location: <><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
    shield: <><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z" /><path d="m9 12 2 2 4-5" /></>,
    chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>,
    money: <><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="12" cy="12" r="3" /><path d="M7 8H6v1M17 16h1v-1" /></>,
    alert: <><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 9v5M12 17h.01" /></>,
    camera: <><path d="M4 7h4l2-3h4l2 3h4v13H4V7Z" /><circle cx="12" cy="13" r="4" /></>,
    document: <><path d="M6 2h9l4 4v16H6V2Z" /><path d="M14 2v5h5M9 12h6M9 16h6" /></>,
    spark: <><path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z" /><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15Z" /></>,
  };
  return (
    <svg className="setup-wizard-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name] || paths.spark}
    </svg>
  );
}

function ChoiceGrid({ options, selected, onToggle }) {
  return (
    <div className="setup-wizard-choice-grid">
      {options.map(option => {
        const active = selected.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            className={`setup-wizard-choice${active ? ' is-selected' : ''}`}
            aria-pressed={active}
            onClick={() => onToggle(option)}
          >
            <span className="setup-wizard-choice-icon"><WizardIcon name={option.icon} /></span>
            <span className="setup-wizard-choice-copy">
              <strong>{option.title}</strong>
              <span>{option.description}</span>
            </span>
            <span className="setup-wizard-check" aria-hidden="true">
              {active && (
                <svg viewBox="0 0 16 16">
                  <path d="m3 8 3 3 7-7" />
                </svg>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function SummaryList({ title, items, muted = false }) {
  if (!items.length) return null;
  return (
    <div className={`setup-wizard-summary-block${muted ? ' is-muted' : ''}`}>
      <h4>{title}</h4>
      <div className="setup-wizard-summary-list">
        {items.map(item => (
          <span key={item} className="setup-wizard-summary-item">{item}</span>
        ))}
      </div>
    </div>
  );
}

export default function SetupQuestionnaire({ currentSettings, onComplete, onDismiss }) {
  const toast = useToast();
  const { setSettings: setGlobalSettings } = useSettings();
  const mainRef = useRef(null);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState(() => selectedFromSettings(currentSettings));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const stepId = STEPS[step];
  const isWelcome = stepId === 'welcome';
  const isReview = stepId === 'review';
  const decisionStep = Math.max(0, step - 1);
  const decisionTotal = STEPS.length - 2;
  const settings = useMemo(() => buildSetupSettings(answers), [answers]);
  const managerOptions = answers.work.includes('field')
    ? MANAGER_OPTIONS
    : MANAGER_OPTIONS.filter(option => option.id !== 'media');

  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [step]);

  const visibleSummary = Object.entries(SUMMARY_LABELS)
    .filter(([key]) => settings[key] === true)
    .map(([, label]) => label);
  const hiddenSummary = Object.entries(SUMMARY_LABELS)
    .filter(([key]) => settings[key] === false && key !== 'module_team')
    .map(([, label]) => label);

  const toggleChoice = (group, option) => {
    setAnswers(prev => {
      const current = prev[group];
      let next;
      if (option.exclusive) {
        next = current.includes(option.id) ? [] : [option.id];
      } else {
        const exclusiveIds = (
          group === 'work' ? WORK_OPTIONS :
          group === 'team' ? TEAM_OPTIONS :
          MANAGER_OPTIONS
        ).filter(item => item.exclusive).map(item => item.id);
        const withoutExclusive = current.filter(id => !exclusiveIds.includes(id));
        next = withoutExclusive.includes(option.id)
          ? withoutExclusive.filter(id => id !== option.id)
          : [...withoutExclusive, option.id];
      }
      return { ...prev, [group]: next };
    });
  };

  const setLabel = (key, value) => {
    setAnswers(prev => ({ ...prev, labels: { ...prev.labels, [key]: value } }));
  };

  const canContinue = (
    isWelcome ||
    isReview ||
    (stepId === 'work' && answers.work.length > 0) ||
    (stepId === 'team' && answers.team.length > 0) ||
    (stepId === 'manager' && answers.manager.length > 0) ||
    (stepId === 'language' && Object.values(answers.labels).every(value => value.trim()))
  );

  const dismiss = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const { data } = await api.patch('/admin/settings', {
        setup_questionnaire_completed_at: new Date().toISOString(),
      });
      setGlobalSettings(data);
      onDismiss?.();
    } catch {
      onDismiss?.();
    } finally {
      setSaving(false);
    }
  };

  const finish = async () => {
    setSaving(true);
    setError('');
    try {
      const { data } = await api.patch('/admin/settings', {
        ...settings,
        setup_questionnaire_completed_at: new Date().toISOString(),
      });
      setGlobalSettings(data);
      toast('Your workspace is ready.', 'success');
      onComplete?.(data);
    } catch (err) {
      setError(err.response?.data?.error || 'We could not save your setup. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const next = () => {
    if (!canContinue || saving) return;
    if (isReview) finish();
    else setStep(current => Math.min(STEPS.length - 1, current + 1));
  };

  const back = () => setStep(current => Math.max(0, current - 1));

  return (
    <div className="setup-wizard-overlay">
      <ModalShell
        onClose={dismiss}
        titleId="setup-wizard-title"
        className="setup-wizard-modal"
      >
        <header className="setup-wizard-header">
          <div className="setup-wizard-brand">
            <img className="setup-wizard-brand-mark" src="/icon-96x96.png" alt="" />
            <span>
              <strong>OpsFloA</strong>
              <small>Company setup</small>
            </span>
          </div>
          {!isWelcome && (
            <div className="setup-wizard-progress" aria-label={`Setup step ${Math.min(decisionStep + 1, decisionTotal)} of ${decisionTotal}`}>
              <span>{isReview ? 'Review' : `Step ${decisionStep + 1} of ${decisionTotal}`}</span>
              <div className="setup-wizard-progress-track">
                <div style={{ width: `${Math.min(100, ((decisionStep + 1) / decisionTotal) * 100)}%` }} />
              </div>
            </div>
          )}
          <button type="button" className="setup-wizard-close" onClick={dismiss} aria-label="Finish setup later">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
          </button>
        </header>

        <main ref={mainRef} className={`setup-wizard-main is-${stepId}`}>
          {isWelcome && (
            <div className="setup-wizard-welcome">
              <div className="setup-wizard-welcome-copy">
                <span className="setup-wizard-kicker">A calmer way to run the day</span>
                <h2 id="setup-wizard-title">Set up OpsFloA around how your business actually works.</h2>
                <p className="setup-wizard-lead">
                  OpsFloA brings time, people, work, field updates, inventory, and reporting into one operating system. You choose what matters; the rest stays out of the way.
                </p>
                <div className="setup-wizard-promise-grid">
                  <div><strong>Keep daily work simple</strong><span>People see the tools they need most.</span></div>
                  <div><strong>Turn on depth when useful</strong><span>Specialized controls remain available later.</span></div>
                  <div><strong>Use your language</strong><span>Use familiar names for work, clients, and team members.</span></div>
                </div>
                <button type="button" className="setup-wizard-primary is-large" onClick={next}>
                  Start my setup
                  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12M11 5l5 5-5 5" /></svg>
                </button>
                <button type="button" className="setup-wizard-later" onClick={dismiss} disabled={saving}>
                  I will set this up later
                </button>
              </div>
              <div className="setup-wizard-welcome-image" role="img" aria-label="A team coordinating work together" />
            </div>
          )}

          {stepId === 'work' && (
            <section className="setup-wizard-step">
              <div className="setup-wizard-step-heading">
                <span className="setup-wizard-kicker">Shape the workspace</span>
                <h2 id="setup-wizard-title">How is work organized?</h2>
                <p>Choose every pattern that fits. This decides which major work areas appear in the app.</p>
              </div>
              <ChoiceGrid options={WORK_OPTIONS} selected={answers.work} onToggle={option => toggleChoice('work', option)} />
            </section>
          )}

          {stepId === 'team' && (
            <section className="setup-wizard-step">
              <div className="setup-wizard-step-heading">
                <span className="setup-wizard-kicker">The employee experience</span>
                <h2 id="setup-wizard-title">What should team members do in OpsFloA?</h2>
                <p>Select the everyday actions your team should have close at hand.</p>
              </div>
              <ChoiceGrid options={TEAM_OPTIONS} selected={answers.team} onToggle={option => toggleChoice('team', option)} />
            </section>
          )}

          {stepId === 'manager' && (
            <section className="setup-wizard-step">
              <div className="setup-wizard-step-heading">
                <span className="setup-wizard-kicker">Manager visibility</span>
                <h2 id="setup-wizard-title">What needs closer oversight?</h2>
                <p>These tools add reporting or specialist controls without crowding the team&apos;s daily view.</p>
              </div>
              <ChoiceGrid options={managerOptions} selected={answers.manager} onToggle={option => toggleChoice('manager', option)} />
              {answers.manager.includes('compliance') && (
                <p className="setup-wizard-note">Certified payroll itself may depend on your company plan or add-on. This prepares the related workspace controls.</p>
              )}
            </section>
          )}

          {stepId === 'language' && (
            <section className="setup-wizard-step">
              <div className="setup-wizard-step-heading">
                <span className="setup-wizard-kicker">Make it familiar</span>
                <h2 id="setup-wizard-title">What does your company call these things?</h2>
                <p>These labels appear throughout the app. Pick a suggestion or type your own.</p>
              </div>
              <div className="setup-wizard-labels">
                {[
                  ['work', 'A piece of work'],
                  ['client', 'The person or company you serve'],
                  ['worker', 'A person on your team'],
                  ['field', 'Work updates away from the office'],
                ].map(([key, prompt]) => (
                  <div key={key} className="setup-wizard-label-row">
                    <div className="setup-wizard-label-prompt">{prompt}</div>
                    <div className="setup-wizard-label-controls">
                      <div className="setup-wizard-label-choices">
                        {LABEL_CHOICES[key].map(label => (
                          <button
                            key={label}
                            type="button"
                            className={answers.labels[key] === label ? 'is-selected' : ''}
                            onClick={() => setLabel(key, label)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <label>
                        <span>Custom label</span>
                        <input
                          value={answers.labels[key]}
                          maxLength={32}
                          onChange={event => setLabel(key, event.target.value)}
                        />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {isReview && (
            <section className="setup-wizard-review">
              <div className="setup-wizard-review-copy">
                <span className="setup-wizard-kicker">Ready to begin</span>
                <h2 id="setup-wizard-title">Your starting workspace is focused, not limited.</h2>
                <p>
                  These choices set the starting view for your company. Nothing is permanent; every module and feature can be adjusted later in Administration.
                </p>
                <SummaryList title="Ready for your team" items={visibleSummary} />
                <SummaryList title="Hidden for now" items={hiddenSummary} muted />
                <div className="setup-wizard-language-summary">
                  <span>{settings.label_work}</span>
                  <span>{settings.label_client}</span>
                  <span>{settings.label_worker}</span>
                  <span>{settings.label_field}</span>
                </div>
                {error && <p className="setup-wizard-error" role="alert">{error}</p>}
              </div>
              <div className="setup-wizard-review-image" role="img" aria-label="An operations lead beginning an organized workday">
                <div><strong>Built for today.</strong><span>Flexible enough for what comes next.</span></div>
              </div>
            </section>
          )}
        </main>

        {!isWelcome && (
          <footer className="setup-wizard-footer">
            <button type="button" className="setup-wizard-secondary" onClick={back} disabled={saving}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 10H4M9 5l-5 5 5 5" /></svg>
              Back
            </button>
            <span className="setup-wizard-footer-note">
              {isReview ? 'You can change these choices later.' : 'Only the tools you choose will be emphasized.'}
            </span>
            <button type="button" className="setup-wizard-primary" onClick={next} disabled={!canContinue || saving}>
              {isReview ? (saving ? 'Saving setup...' : 'Use this workspace') : 'Continue'}
              {!isReview && <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12M11 5l5 5-5 5" /></svg>}
            </button>
          </footer>
        )}
      </ModalShell>
    </div>
  );
}
