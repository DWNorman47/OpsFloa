import React, { useState } from 'react';
import api from '../api';
import { useToast } from '../contexts/ToastContext';
import ModalShell from './ModalShell';

/**
 * First-run setup questionnaire. Walks a brand-new admin through 9
 * pointed questions about how their team works, then applies the
 * matching module / feature toggles in one PATCH. The point isn't to
 * reach a "perfect" config — it's to hide the modules they don't need
 * so the app doesn't look overwhelming on day one. Everything we toggle
 * here is reachable from Company Settings → Modules later.
 *
 * The questionnaire is dismissible ("Maybe later"). On dismiss we still
 * record `setup_questionnaire_completed_at` so it doesn't pop up every
 * time the admin opens the page — they get the option once and can
 * always re-run from Settings if we expose a "Run setup again" link
 * later.
 *
 * Mounted by AdministrationPage when settings.setup_questionnaire_completed_at
 * is empty AND the current user is an admin.
 */

// One question per screen. `options` are the user's choices; the `settings`
// object on each option is merged into the eventual PATCH. An option with
// an empty `settings` ({}) means "don't change anything" — useful for
// "Not sure" answers where the default is fine.
const QUESTIONS = [
  {
    id: 'work_type',
    question: 'What does your team mostly do?',
    explanation: 'This helps us pick which modules to show. Field, mobile, or service work brings in checklists, reports, punchlists, and other closeout tools. Office-only teams usually do better with a simpler workspace.',
    options: [
      { value: 'office',  label: 'Office work',                          settings: { module_field: false } },
      { value: 'field',   label: 'Field, mobile, or service work',       settings: { module_field: true } },
      { value: 'both',    label: 'Both',                                 settings: { module_field: true } },
    ],
  },
  {
    id: 'pay_type',
    question: 'How are team members paid?',
    explanation: 'Hourly is standard - team members clock in and out and get paid for elapsed time. Daily flat-rate is common for piece-work, routes, or per-diem teams. If you have both, hourly is the default; you can mark individual team members as daily on their profile.',
    options: [
      { value: 'hourly',  label: 'Hourly',           settings: {} },
      { value: 'daily',   label: 'Daily flat rate',  settings: {} },
      { value: 'both',    label: 'Both',             settings: {} },
    ],
  },
  {
    id: 'prevailing_wage',
    question: 'Do you do prevailing-wage or certified-payroll work?',
    explanation: "If you work under public contracts or payroll reporting rules, you may need certified payroll (form WH-347). If you're not sure, leave it off for now; turning it on adds compliance fields that get noisy if you don't actually need them.",
    options: [
      { value: 'yes',      label: 'Yes',         settings: { feature_prevailing_wage: true } },
      { value: 'no',       label: 'No',          settings: { feature_prevailing_wage: false } },
      { value: 'unsure',   label: 'Not sure',    settings: {} },
    ],
  },
  {
    id: 'scheduling',
    question: 'Do you need to schedule shifts ahead of time?',
    explanation: 'Turn this on if you assign team members to specific shifts in advance. Leave it off if people just clock in when they start.',
    options: [
      { value: 'yes',  label: 'Yes',                              settings: { feature_scheduling: true } },
      { value: 'no',   label: 'No, the team just clocks in',      settings: { feature_scheduling: false } },
    ],
  },
  {
    id: 'reimbursements',
    question: 'Do you reimburse team members for expenses (gas, materials, tools)?',
    explanation: 'If yes, team members can submit expense claims with photos and you can approve or deny them. If you handle expenses outside the app, leave this off.',
    options: [
      { value: 'yes',  label: 'Yes',  settings: { feature_reimbursements: true } },
      { value: 'no',   label: 'No',   settings: { feature_reimbursements: false } },
    ],
  },
  {
    id: 'pto',
    question: 'Do you need to track time off / PTO?',
    explanation: 'Turn this on if you formally track vacation and sick days and approve them in the app. Leave it off if time off is handled informally (text, email, etc).',
    options: [
      { value: 'yes',  label: 'Yes',  settings: { feature_pto: true } },
      { value: 'no',   label: 'No',   settings: { feature_pto: false } },
    ],
  },
  {
    id: 'geolocation',
    question: 'Do you want to record where team members clock in from?',
    explanation: "Tracking captures each team member's GPS coordinates at clock-in and clock-out so admins can see them on the Live tab and on time entries. This is separate from requiring someone to be at a specific spot - that's a per-project geofence you set up later under Projects.",
    options: [
      { value: 'yes',  label: 'Yes, record their location',  settings: { feature_geolocation: true } },
      { value: 'no',   label: "No, don't track location",    settings: { feature_geolocation: false } },
    ],
  },
  {
    id: 'chat',
    question: 'Do you want a chat channel for team members and admins?',
    explanation: "In-app messaging plus the option to broadcast announcements to everyone. Useful for teams that don't already use Slack or Teams. You can always turn it on later.",
    options: [
      { value: 'yes',  label: 'Yes',       settings: { feature_chat: true,  feature_broadcast: true } },
      { value: 'no',   label: 'Not now',   settings: { feature_chat: false, feature_broadcast: false } },
    ],
  },
  {
    id: 'inventory',
    question: 'Do you track tools, materials, or inventory?',
    explanation: "If yes, you get an Inventory module for stock counts, tool checkout, and materials tracking. Leave it off if you do not need shared items, supplies, or location-based counts.",
    options: [
      { value: 'yes',  label: 'Yes',  settings: { module_inventory: true } },
      { value: 'no',   label: 'No',   settings: { module_inventory: false } },
    ],
  },
];

// Pretty-print the keys we touch on the summary screen.
const SETTING_LABELS = {
  module_field:           'Field/service module',
  module_inventory:       'Inventory module',
  feature_prevailing_wage:'Prevailing wage',
  feature_scheduling:     'Scheduling',
  feature_reimbursements: 'Expenses',
  feature_pto:            'Time off',
  feature_geolocation:    'Location tracking on clock-in',
  feature_chat:           'Company chat',
  feature_broadcast:      'Announce to all team members',
};

export default function SetupQuestionnaire({ onComplete, onDismiss }) {
  const toast = useToast();
  const [step, setStep] = useState(0);          // 0..QUESTIONS.length = summary
  const [answers, setAnswers] = useState({});   // { [questionId]: optionValue }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const total = QUESTIONS.length;
  const isSummary = step === total;
  const current = QUESTIONS[step];

  // Resolve the settings PATCH from current answers. Later questions
  // override earlier ones if they touch the same key (none currently do).
  const resolvedSettings = () => {
    const merged = {};
    for (const q of QUESTIONS) {
      const val = answers[q.id];
      if (!val) continue;
      const opt = q.options.find(o => o.value === val);
      if (opt) Object.assign(merged, opt.settings);
    }
    return merged;
  };

  const choose = (value) => {
    setAnswers(a => ({ ...a, [current.id]: value }));
    setStep(s => s + 1);
  };

  const back = () => setStep(s => Math.max(0, s - 1));

  const finish = async (markAnswered) => {
    setSaving(true); setError('');
    try {
      const payload = markAnswered ? resolvedSettings() : {};
      payload.setup_questionnaire_completed_at = new Date().toISOString();
      await api.patch('/admin/settings', payload);
      toast(markAnswered ? 'Setup complete!' : 'You can re-run setup later from the help menu.', 'success');
      onComplete?.(payload);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save. Try again.');
    } finally {
      setSaving(false);
    }
  };

  // X / Maybe later → record dismissal and close.
  const dismiss = async () => {
    await finish(false);
    onDismiss?.();
  };

  const summary = isSummary ? (() => {
    const settings = resolvedSettings();
    const enabled = [];
    const disabled = [];
    for (const [k, v] of Object.entries(settings)) {
      const label = SETTING_LABELS[k] || k;
      if (v === true) enabled.push(label);
      else if (v === false) disabled.push(label);
    }
    return { enabled, disabled };
  })() : null;

  return (
    <div style={s.overlay} onClick={e => { if (e.target === e.currentTarget) dismiss(); }}>
      <ModalShell onClose={dismiss} titleId="setup-q-title" style={s.modal}>
        <div style={s.headerRow}>
          <h2 id="setup-q-title" style={s.title}>Quick setup</h2>
          <button type="button" style={s.closeBtn} onClick={dismiss} aria-label="Close">✕</button>
        </div>
        <div style={s.body}>
        <div style={s.progress}>
          <div style={s.progressTrack}>
            <div style={{ ...s.progressFill, width: `${(step / total) * 100}%` }} />
          </div>
          <div style={s.progressLabel}>
            {isSummary ? 'Review' : `Question ${step + 1} of ${total}`}
          </div>
        </div>

        {!isSummary && current && (
          <>
            <h3 style={s.q}>{current.question}</h3>
            <p style={s.explain}>{current.explanation}</p>
            <div style={s.options}>
              {current.options.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  style={{
                    ...s.optionBtn,
                    ...(answers[current.id] === opt.value ? s.optionBtnActive : null),
                  }}
                  onClick={() => choose(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </>
        )}

        {isSummary && summary && (
          <>
            <h3 style={s.q}>Here&apos;s what we&apos;ll set up.</h3>
            <p style={s.explain}>
              You can change any of this later in Company Settings → Modules
              (or in the Features section right below it).
            </p>
            {summary.enabled.length > 0 && (
              <div style={s.summaryBlock}>
                <div style={s.summaryHeading}>Enabled</div>
                <ul style={s.summaryList}>
                  {summary.enabled.map(name => <li key={name} style={s.summaryItem}>✓ {name}</li>)}
                </ul>
              </div>
            )}
            {summary.disabled.length > 0 && (
              <div style={s.summaryBlock}>
                <div style={s.summaryHeading}>Hidden</div>
                <ul style={s.summaryList}>
                  {summary.disabled.map(name => <li key={name} style={s.summaryItem}>— {name}</li>)}
                </ul>
              </div>
            )}
            {summary.enabled.length === 0 && summary.disabled.length === 0 && (
              <p style={s.explain}>
                Your answers don&apos;t require any setting changes right now.
                We&apos;ll just mark setup as complete.
              </p>
            )}
          </>
        )}

        {error && <p style={s.error}>{error}</p>}

        <div style={s.footer}>
          {step > 0 && !saving && (
            <button type="button" style={s.backBtn} onClick={back}>
              ← Back
            </button>
          )}
          <div style={{ flex: 1 }} />
          {!isSummary && (
            <button type="button" style={s.skipLink} onClick={dismiss} disabled={saving}>
              Maybe later
            </button>
          )}
          {isSummary && (
            <button
              type="button"
              style={s.primaryBtn}
              onClick={() => finish(true)}
              disabled={saving}
            >
              {saving ? 'Saving…' : 'Finish setup'}
            </button>
          )}
        </div>
        </div>
      </ModalShell>
    </div>
  );
}

const s = {
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(15, 23, 42, 0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16,
    zIndex: 1000,
  },
  modal: {
    background: '#fff',
    borderRadius: 14,
    padding: '20px 24px 24px',
    width: '100%',
    maxWidth: 520,
    maxHeight: 'calc(100vh - 32px)',
    overflowY: 'auto',
    boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  headerRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 18, fontWeight: 700, color: '#111827', margin: 0 },
  closeBtn: {
    background: 'none', border: 'none', color: '#6b7280',
    fontSize: 16, cursor: 'pointer', padding: '4px 6px', lineHeight: 1,
  },
  body: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 4px 0' },
  progress: { display: 'flex', alignItems: 'center', gap: 12 },
  progressTrack: { flex: 1, height: 4, background: '#e5e7eb', borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: '100%', background: 'var(--ops-page-accent)', transition: 'width 0.25s ease' },
  progressLabel: { fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' },
  q: { fontSize: 18, fontWeight: 700, color: '#111827', margin: '4px 0 0' },
  explain: { fontSize: 14, color: '#4b5563', lineHeight: 1.55, margin: 0 },
  options: { display: 'flex', flexDirection: 'column', gap: 8 },
  optionBtn: {
    background: '#fff',
    border: '1px solid #d1d5db',
    borderRadius: 8,
    padding: '12px 16px',
    fontSize: 14,
    fontWeight: 500,
    color: '#111827',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'border-color 0.1s, background 0.1s',
  },
  optionBtnActive: {
    borderColor: 'var(--ops-page-accent)',
    background: '#eef2ff',
  },
  summaryBlock: { display: 'flex', flexDirection: 'column', gap: 6 },
  summaryHeading: { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' },
  summaryList: { margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 },
  summaryItem: { fontSize: 14, color: '#374151' },
  error: { fontSize: 13, color: '#dc2626', margin: 0 },
  footer: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 },
  backBtn: { background: 'none', border: 'none', color: '#6b7280', fontSize: 13, cursor: 'pointer', padding: '6px 0' },
  skipLink: { background: 'none', border: 'none', color: '#6b7280', fontSize: 13, cursor: 'pointer', padding: '6px 8px' },
  primaryBtn: {
    background: 'var(--ops-page-accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 7,
    padding: '9px 18px',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'pointer',
  },
};
