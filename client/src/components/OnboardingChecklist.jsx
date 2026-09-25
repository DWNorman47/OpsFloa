import React, { useEffect, useState } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { safeLocal } from '../utils/safeStorage';

const DISMISS_KEY = 'opsfloa_onboarding_dismissed';

// Real destinations (App.jsx routes / AdministrationPage tabs): team members live
// on /team, projects on /work, and the default rate, time zone and overtime rules
// in Administration → Company Settings (#workspace, ManageRates.jsx).
export const ONBOARDING_LINKS = {
  workers: '/team',
  projects: '/work',
  settings: '/administration#workspace',
};

/**
 * Which setup steps are done. Pure, for tests.
 *  - rates: the admin explicitly confirmed the default rate, OR the company
 *    default-rate history has a change an admin made (created_by set — the
 *    sign-up row has none), OR the rate is no longer the sign-up default.
 *  - timezone: the admin explicitly confirmed it. It is pre-filled from the
 *    sign-up browser, so "a value exists" never meant anyone checked it.
 */
export function onboardingStatus({ workers = [], projects = [], settings = {}, rateHistory = null } = {}) {
  const s = settings || {};
  const rateChangedByAdmin = Array.isArray(rateHistory) && rateHistory.some(r => r.created_by != null);
  const rateNotDefault = s.default_hourly_rate != null && Number(s.default_hourly_rate) !== 30;
  const overtimeEnabled = s.feature_overtime !== false;
  return {
    hasWorkers: workers.some(w => w.role === 'worker'),
    hasProjects: projects.length > 0,
    projectsEnabled: s.feature_project_integration !== false,
    ratesConfigured: !!s.onboarding_rates_confirmed_at || rateChangedByAdmin || rateNotDefault,
    timezoneConfigured: !!s.onboarding_timezone_confirmed_at,
    overtimeEnabled,
    // Overtime step is done if either the feature is off (not relevant) or
    // the admin has explicitly set an overtime rule.
    overtimeConfigured: !overtimeEnabled || !!(s.overtime_rule && s.overtime_threshold),
  };
}

export default function OnboardingChecklist({ workers, projects, settings }) {
  const t = useT();
  const [dismissed, setDismissed] = useState(() => !!safeLocal.getItem(DISMISS_KEY));
  const [confirmed, setConfirmed] = useState({}); // settings key → ISO time, confirmed this session
  const [rateHistory, setRateHistory] = useState(null);
  const [saving, setSaving] = useState(null);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    if (dismissed) return;
    let alive = true;
    api.get('/admin/company/default-rate-history', { suppressToast: true })
      .then(r => { if (alive) setRateHistory(r.data?.history || []); })
      .catch(() => {}); // no manage_settings → fall back to the explicit flag / current rate
    return () => { alive = false; };
  }, [dismissed]);

  if (dismissed) return null;

  const merged = { ...(settings || {}), ...confirmed };
  const st = onboardingStatus({ workers, projects, settings: merged, rateHistory });

  const confirmStep = async key => {
    setSaving(key);
    setSaveError('');
    const now = new Date().toISOString();
    try {
      await api.patch('/admin/settings', { [key]: now }, { suppressToast: true });
      setConfirmed(c => ({ ...c, [key]: now }));
    } catch {
      setSaveError(t.onboardingConfirmFailed);
    } finally {
      setSaving(null);
    }
  };

  const rate = settings?.default_hourly_rate;
  const tz = settings?.company_timezone;
  const steps = [
    {
      done: st.hasWorkers,
      label: t.onboardingAddWorker,
      sub: t.onboardingAddWorkerSub,
      href: ONBOARDING_LINKS.workers,
      cta: t.onboardingOpenTeamCta,
    },
    ...(st.projectsEnabled ? [{
      done: st.hasProjects,
      label: t.onboardingAddProject,
      sub: t.onboardingAddProjectSub,
      href: ONBOARDING_LINKS.projects,
      cta: t.onboardingOpenWorkCta,
    }] : []),
    {
      done: st.ratesConfigured,
      label: t.onboardingRates,
      sub: `${t.onboardingRatesSub}${rate != null ? ' ' + t.onboardingRatesCurrent.replace('{rate}', rate) : ''}`,
      href: ONBOARDING_LINKS.settings,
      cta: t.onboardingOpenSettingsCta,
      confirmKey: 'onboarding_rates_confirmed_at',
    },
    {
      done: st.timezoneConfigured,
      label: t.onboardingTimezone,
      sub: `${t.onboardingTimezoneSub} ${tz ? t.onboardingTimezoneCurrent.replace('{tz}', tz) : t.onboardingTimezoneMissing}`,
      href: ONBOARDING_LINKS.settings,
      cta: t.onboardingOpenSettingsCta,
      // Nothing to confirm until a zone is set — send them to settings instead.
      confirmKey: tz ? 'onboarding_timezone_confirmed_at' : null,
    },
    ...(st.overtimeEnabled ? [{
      done: st.overtimeConfigured,
      label: t.onboardingOvertime,
      sub: t.onboardingOvertimeSub,
      href: ONBOARDING_LINKS.settings,
      cta: t.onboardingOpenSettingsCta,
    }] : []),
  ];

  const doneCount = steps.filter(s => s.done).length;
  const allDone = doneCount === steps.length;

  const dismiss = () => {
    safeLocal.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  };

  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <div>
          <div style={styles.title}>🚀 {t.onboardingTitle}</div>
          <div style={styles.progress}>
            {doneCount} {t.onboardingOf} {steps.length} {t.onboardingStepsComplete}
            <span style={styles.progressBar}>
              <span style={{ ...styles.progressFill, width: `${(doneCount / steps.length) * 100}%` }} />
            </span>
          </div>
        </div>
        <button style={styles.closeBtn} aria-label={t.dismiss} onClick={dismiss} title={t.dismiss}>✕</button>
      </div>

      <div style={styles.steps}>
        {steps.map((step, i) => (
          <div key={i} style={{ ...styles.step, opacity: step.done ? 0.6 : 1 }}>
            <div style={{ ...styles.check, background: step.done ? '#d1fae5' : '#f3f4f6', color: '#065f46' }}>
              {step.done ? '✓' : <span style={{ color: '#6b7280' }}>{i + 1}</span>}
            </div>
            <div style={styles.stepBody}>
              <div style={{ ...styles.stepLabel, textDecoration: step.done ? 'line-through' : 'none' }}>
                {step.label}
              </div>
              {!step.done && <div style={styles.stepSub}>{step.sub}</div>}
            </div>
            {!step.done && step.confirmKey && (
              <button
                type="button"
                style={styles.confirmBtn}
                disabled={saving === step.confirmKey}
                onClick={() => confirmStep(step.confirmKey)}
              >
                {t.onboardingConfirmCta}
              </button>
            )}
            {!step.done && (
              <a href={step.href} style={styles.stepBtn}>{step.cta}</a>
            )}
          </div>
        ))}
      </div>

      {saveError && <div role="alert" style={styles.saveError}>{saveError}</div>}

      {allDone && (
        <div style={styles.allDone}>
          {t.onboardingAllDone} <button style={styles.dismissLink} onClick={dismiss}>{t.onboardingDismiss}</button>
        </div>
      )}
    </div>
  );
}

const styles = {
  wrap: {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 12,
    padding: '20px 24px',
    marginBottom: 20,
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 16,
    gap: 12,
  },
  title: { fontWeight: 800, fontSize: 16, color: '#111827', marginBottom: 6 },
  progress: { fontSize: 12, color: '#6b7280', display: 'flex', alignItems: 'center', gap: 8 },
  progressBar: {
    display: 'inline-block',
    width: 80,
    height: 6,
    background: '#e5e7eb',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    display: 'block',
    height: '100%',
    background: 'var(--ops-page-accent)',
    borderRadius: 3,
    transition: 'width 0.3s',
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    fontSize: 16,
    color: '#6b7280',
    cursor: 'pointer',
    padding: '0 4px',
    lineHeight: 1,
    flexShrink: 0,
  },
  steps: { display: 'flex', flexDirection: 'column', gap: 12 },
  step: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 12px',
    background: '#f9fafb',
    borderRadius: 8,
    transition: 'opacity 0.2s',
  },
  check: {
    width: 28,
    height: 28,
    borderRadius: '50%',
    background: '#f3f4f6',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
    fontWeight: 700,
    flexShrink: 0,
  },
  stepBody: { flex: 1, minWidth: 0 },
  stepLabel: { fontSize: 14, fontWeight: 600, color: '#111827' },
  stepSub: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  confirmBtn: {
    fontSize: 12,
    fontWeight: 700,
    background: '#fff',
    color: '#065f46',
    border: '1px solid #6ee7b7',
    padding: '5px 12px',
    borderRadius: 6,
    cursor: 'pointer',
    flexShrink: 0,
    whiteSpace: 'nowrap',
  },
  saveError: { marginTop: 10, fontSize: 12, color: '#b91c1c' },
  stepBtn: {
    fontSize: 12,
    fontWeight: 700,
    background: 'var(--ops-page-accent)',
    color: '#fff',
    padding: '6px 14px',
    borderRadius: 6,
    textDecoration: 'none',
    flexShrink: 0,
    whiteSpace: 'nowrap',
  },
  allDone: {
    marginTop: 14,
    padding: '10px 12px',
    background: '#d1fae5',
    borderRadius: 8,
    fontSize: 13,
    color: '#065f46',
    fontWeight: 600,
  },
  dismissLink: {
    background: 'none',
    border: 'none',
    color: '#065f46',
    fontWeight: 700,
    textDecoration: 'underline',
    cursor: 'pointer',
    fontSize: 13,
    padding: 0,
    marginLeft: 4,
  },
};
