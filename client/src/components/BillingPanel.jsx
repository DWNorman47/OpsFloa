import React, { useState, useEffect } from 'react';
import api from '../api';
import { useT } from '../hooks/useT';
import { useAuth } from '../contexts/AuthContext';
import { SkeletonList } from './Skeleton';

import { silentError } from '../errorReporter';
function daysLeft(dateStr) {
  if (!dateStr) return 0;
  return Math.max(0, Math.ceil((new Date(dateStr) - new Date()) / 86400000));
}

function StatusBadge({ status, trialEndsAt, plan, t }) {
  if (status === 'active') {
    const label = plan === 'business' ? t.planBusiness : plan === 'starter' ? t.planStarter : t.planFree;
    return <span style={{ ...badge, background: '#d1fae5', color: '#065f46' }}>{t.billingActivePlan.replace('{plan}', label)}</span>;
  }
  if (status === 'trial') {
    const d = daysLeft(trialEndsAt);
    const color = d <= 3 ? '#fef2f2' : '#fef3c7';
    const text = d <= 3 ? '#991b1b' : '#92400e';
    return <span style={{ ...badge, background: color, color: text }}>Trial — {d} {d !== 1 ? t.daysLabel : t.dayLabel} left</span>;
  }
  if (status === 'past_due') return <span style={{ ...badge, background: '#fef2f2', color: '#991b1b' }}>{t.billingPastDue}</span>;
  if (status === 'canceled') return <span style={{ ...badge, background: '#f3f4f6', color: '#374151' }}>{t.billingCanceled}</span>;
  if (status === 'trial_expired') return <span style={{ ...badge, background: '#fef2f2', color: '#991b1b' }}>{t.billingTrialEnded}</span>;
  return null;
}

const badge = { padding: '4px 12px', borderRadius: 20, fontSize: 13, fontWeight: 700 };

function PlanCard({ name, priceEl, subline, features, color, highlight, tag, onSelect, btnLabel, disabled, current, selected, t }) {
  return (
    <div style={{
      ...s.planCard,
      borderColor: current ? '#059669' : selected ? color : highlight ? color : '#e5e7eb',
      boxShadow: selected ? `0 0 0 3px ${color}22` : highlight ? '0 4px 20px rgba(124,58,237,0.12)' : undefined,
    }}>
      {tag && !selected && <div style={{ ...s.planTag, background: color }}>{tag}</div>}
      {selected && <div style={{ ...s.selectedTag, background: color }}>{t.billingSelected}</div>}
      <div style={s.planName}>{name}</div>
      <div style={{ ...s.planPrice, color }}>{priceEl}</div>
      {subline && <div style={s.planSubline}>{subline}</div>}
      <ul style={s.featureList}>
        {features.map(f => (
          <li key={f.text} style={s.featureItem}>
            <span style={{ color: f.lock ? '#d1d5db' : '#059669', marginRight: 6 }}>{f.lock ? '🔒' : '✓'}</span>
            <span style={{ color: f.lock ? '#9ca3af' : '#374151' }}>{f.text}</span>
          </li>
        ))}
      </ul>
      <button
        style={{ ...s.planBtn, background: selected ? color : current ? '#059669' : color, opacity: disabled ? 0.6 : 1 }}
        onClick={onSelect}
        disabled={disabled}
      >
        {btnLabel}
      </button>
    </div>
  );
}

export default function BillingPanel() {
  const t = useT();
  const { updateUser } = useAuth();
  const [status, setStatus] = useState(null);
  const [plans, setPlans] = useState(null);
  const [loading, setLoading] = useState(true);
  const [redirecting, setRedirecting] = useState(null);
  const [billingError, setBillingError] = useState('');
  const [annual, setAnnual] = useState(false);
  const [workerCount, setWorkerCount] = useState(15);
  const [addQbo, setAddQbo] = useState(false);
  const [addTakeoff, setAddTakeoff] = useState(false);
  const [addPlanroom, setAddPlanroom] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState(null);
  const [workerInputMode, setWorkerInputMode] = useState('slider');
  const [workerDraft, setWorkerDraft] = useState('');

  useEffect(() => {
    Promise.all([api.get('/stripe/status'), api.get('/stripe/plans')])
      .then(([s, p]) => { setStatus(s.data); setPlans(p.data); })
      .catch(silentError('billingpanel'))
      .finally(() => setLoading(false));
  }, []);

  const checkout = async (priceId, opts = {}) => {
    if (!priceId) { setBillingError(t.stripeNotConfigured); return; }
    setBillingError('');
    setRedirecting(priceId);
    try {
      const r = await api.post('/stripe/checkout', {
        price_id: priceId,
        ...opts,
        ...(addQbo && plans?.qbo ? {
          add_qbo: true,
          qbo_price_id: annual ? plans.qbo.annual_price_id : plans.qbo.monthly_price_id,
        } : {}),
        ...(addTakeoff && plans?.takeoff ? {
          add_takeoff: true,
          takeoff_price_id: annual ? plans.takeoff.annual_price_id : plans.takeoff.monthly_price_id,
        } : {}),
        ...(addPlanroom && plans?.planroom ? {
          add_planroom: true,
          planroom_price_id: annual ? plans.planroom.annual_price_id : plans.planroom.monthly_price_id,
        } : {}),
      });
      window.location.href = r.data.url;
    } catch (err) {
      setBillingError(err.response?.data?.error || t.checkoutFailed);
      setRedirecting(null);
    }
  };

  const portal = async () => {
    setBillingError('');
    setRedirecting('portal');
    try {
      const r = await api.post('/stripe/portal');
      window.location.href = r.data.url;
    } catch (err) {
      setBillingError(err.response?.data?.error || t.portalFailed);
      setRedirecting(null);
    }
  };

  // One-click: add a paid add-on to the EXISTING subscription (prorated item),
  // then reflect it immediately in the billing status + the auth session (so
  // gated tools appear without a reload).
  const addAddon = async (addon) => {
    setBillingError('');
    setRedirecting('addon-' + addon);
    try {
      await api.post('/stripe/addon', { addon });
      const r = await api.get('/stripe/status');
      setStatus(r.data);
      if (addon === 'takeoff') updateUser?.({ addon_takeoff: true });
      if (addon === 'planroom') updateUser?.({ addon_planroom: true });
      if (addon === 'qbo') updateUser?.({ addon_qbo: true });
    } catch (err) {
      setBillingError(err.response?.data?.error || 'Could not add the add-on.');
    } finally {
      setRedirecting(null);
    }
  };

  const removeAddon = async (addon) => {
    if (!window.confirm('Remove this add-on from your subscription? Your bill is prorated and you can add it back anytime.')) return;
    setBillingError('');
    setRedirecting('rmaddon-' + addon);
    try {
      await api.post('/stripe/addon/remove', { addon });
      const r = await api.get('/stripe/status');
      setStatus(r.data);
      if (addon === 'takeoff') updateUser?.({ addon_takeoff: false });
      if (addon === 'planroom') updateUser?.({ addon_planroom: false });
      if (addon === 'qbo') updateUser?.({ addon_qbo: false });
    } catch (err) {
      setBillingError(err.response?.data?.error || 'Could not remove the add-on.');
    } finally {
      setRedirecting(null);
    }
  };

  const subscribeSelectedPlan = () => {
    if (!selectedPlan || selectedPlan === 'free') return;
    if (selectedPlan === 'starter') {
      checkout(annual ? plans?.starter.annual_price_id : plans?.starter.monthly_price_id);
    } else if (selectedPlan === 'business') {
      checkout(
        annual ? plans?.business.base_annual_price_id : plans?.business.base_monthly_price_id,
        annual
          ? { worker_price_id: plans?.business.worker_annual_price_id, worker_count: workerCount }
          : { worker_price_id: plans?.business.worker_monthly_price_id, worker_count: workerCount }
      );
    }
  };

  if (loading) return <div style={s.card}><SkeletonList count={3} rows={2} /></div>;

  const sub = status?.subscription_status;
  const currentPlan = status?.plan || 'free';
  const hasQbo = status?.addon_qbo;
  const hasTakeoff = status?.addon_takeoff;
  const hasPlanroom = status?.addon_planroom;
  const isActive = sub === 'active';
  const isTrial = sub === 'trial';
  const isTrialExpired = sub === 'trial_expired';
  const trialDays = daysLeft(status?.trial_ends_at);

  // The three à-la-carte add-ons, in one place. Used both by the active-plan
  // manage list and by the "you already have this" turn-off card shown to
  // non-active companies (so an owned add-on is never silently invisible).
  const addonMeta = [
    { key: 'planroom', title: 'Plan Room', owned: hasPlanroom, plan: plans?.planroom, desc: 'View, mark up, and measure plan sets in the browser, with a company library and live share sessions.' },
    { key: 'takeoff', title: 'Sitework Takeoff', owned: hasTakeoff, plan: plans?.takeoff, desc: 'Plan takeoffs from civil drawings into a priced, branded bid, with company-shared projects.' },
    { key: 'qbo', title: 'QuickBooks Online', owned: hasQbo, plan: plans?.qbo, desc: 'Push invoices to QuickBooks and keep their payment status in sync.' },
  ];

  const INCLUDED_WORKERS = 15;
  const businessOverage = Math.max(0, workerCount - INCLUDED_WORKERS);

  const BASE_MONTHLY = plans?.business.base_monthly ?? 35;
  const PER_WORKER_MONTHLY = plans?.business.per_worker_monthly ?? 2;
  const businessMonthly = BASE_MONTHLY + businessOverage * PER_WORKER_MONTHLY;

  const BASE_ANNUAL = plans?.business.base_annual ?? 350;
  const PER_WORKER_ANNUAL = plans?.business.per_worker_annual ?? 20;
  const businessAnnualTotal = BASE_ANNUAL + businessOverage * PER_WORKER_ANNUAL;
  const businessAnnualPerMonth = Math.round(businessAnnualTotal / 12);

  const showPlans = isTrial || isTrialExpired || sub === 'canceled' || !isActive;

  return (
    <div style={s.card}>
      <div style={s.topRow}>
        <div>
          <h3 style={s.title}>{t.billingTitle}</h3>
        </div>
        <StatusBadge status={sub} trialEndsAt={status?.trial_ends_at} plan={currentPlan} t={t} />
      </div>

      {billingError && <p style={s.billingError}>{billingError}</p>}

      {sub === 'past_due' && (
        <div style={s.alert}>
          {t.billingPaymentFailed}
          <button style={{ ...s.alertBtn, ...(redirecting === 'portal' ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={portal} disabled={redirecting === 'portal'}>
            {redirecting === 'portal' ? t.billingRedirecting : t.billingUpdatePayment}
          </button>
        </div>
      )}

      {isTrialExpired && (
        <div style={{ ...s.alert, background: '#fef2f2', borderColor: '#fecaca', color: '#991b1b' }}>
          {t.billingTrialExpiredBanner}
        </div>
      )}

      {isTrial && (
        <div style={s.trialBanner}>
          <strong>{t.billingTrialActiveFull}</strong>
          {' '}{t.billingTrialChoosePlan}
          {trialDays > 0 && (
            <span style={{ display: 'block', marginTop: 6, fontSize: 12, color: '#1e40af' }}>
              {trialDays !== 1 ? t.billingTrialDaysLeft.replace('{n}', trialDays) : t.billingTrialDayLeft}
            </span>
          )}
        </div>
      )}

      {isActive && (
        <div style={s.activeSection}>
          <p style={s.activeText}>
            {hasQbo
              ? t.billingPlanActiveWithAddon.replace('{plan}', currentPlan === 'business' ? t.planBusiness : t.planStarter).replace('{addon}', t.addonQBO)
              : t.billingPlanActiveText.replace('{plan}', currentPlan === 'business' ? t.planBusiness : t.planStarter)
            }
          </p>
          <button style={{ ...s.portalBtn, ...(redirecting === 'portal' ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={portal} disabled={redirecting === 'portal'}>
            {redirecting === 'portal' ? t.billingRedirecting : t.manageSub}
          </button>

          {addonMeta.map(a => {
            if (a.owned) {
              return (
                <div key={a.key} style={{ ...s.addonCard, marginTop: 14, marginBottom: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <span style={s.addonTitle}>{a.title} add-on <span style={{ color: '#059669', fontWeight: 700 }}>· included</span></span>
                    <button style={{ ...s.removeBtn, ...(redirecting ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={() => removeAddon(a.key)} disabled={!!redirecting}>
                      {redirecting === 'rmaddon-' + a.key ? 'Removing…' : 'Remove'}
                    </button>
                  </div>
                </div>
              );
            }
            if (!a.plan?.monthly_price_id) return null;
            return (
              <div key={a.key} style={{ ...s.addonCard, marginTop: 14, marginBottom: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <span style={s.addonTitle}>
                    Add the {a.title} add-on &nbsp;
                    <span style={{ fontSize: 18, fontWeight: 800, color: '#d97706' }}>${a.plan?.monthly ?? '—'}</span>
                    <span style={{ fontSize: 13, color: '#6b7280' }}>/mo</span>
                  </span>
                  <button
                    style={{ ...s.ctaBtn, ...(redirecting ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                    onClick={() => addAddon(a.key)}
                    disabled={!!redirecting}
                  >
                    {redirecting === 'addon-' + a.key ? 'Adding…' : 'Add to my subscription'}
                  </button>
                </div>
                <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.5, marginTop: 6 }}>
                  {a.desc} Prorated onto your current subscription — no re-checkout.
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showPlans && (
        <>
          {/* Add-ons already switched on (e.g. via superadmin, or kept from a
              prior plan) — surfaced with a Turn-off action so they're managed
              here instead of silently vanishing when there's no active plan. */}
          {addonMeta.some(a => a.owned) && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', margin: '0 0 8px' }}>Your add-ons</div>
              {addonMeta.filter(a => a.owned).map(a => (
                <div key={a.key} style={{ ...s.addonCard, marginBottom: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <span style={s.addonTitle}>{a.title} add-on <span style={{ color: '#059669', fontWeight: 700 }}>· active</span></span>
                    <button
                      style={{ ...s.removeBtn, ...(redirecting ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }}
                      onClick={() => removeAddon(a.key)}
                      disabled={!!redirecting}
                    >
                      {redirecting === 'rmaddon-' + a.key ? 'Turning off…' : 'Turn off'}
                    </button>
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.5, marginTop: 6 }}>
                    You have the {a.title} add-on. Turn it off to remove it and stop paying for it — you can add it back anytime.
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={s.toggleRow}>
            <span style={{ fontSize: 14, color: annual ? '#9ca3af' : '#111827', fontWeight: annual ? 400 : 600 }}>{t.planMonthly}</span>
            <button style={{ ...s.toggle, background: annual ? 'var(--ops-page-accent)' : '#d1d5db' }} onClick={() => setAnnual(a => !a)}>
              <span style={{ ...s.toggleKnob, transform: annual ? 'translateX(46px)' : 'translateX(0)' }} />
            </button>
            <span style={{ fontSize: 14, color: annual ? '#111827' : '#9ca3af', fontWeight: annual ? 600 : 400 }}>
              {t.planAnnual} <span style={{ background: '#d1fae5', color: '#065f46', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10 }}>{t.planSave}</span>
            </span>
          </div>

          <div style={s.plans}>
            <PlanCard
              name={t.planFree}
              priceEl={<span><span style={{ fontSize: 28, fontWeight: 800 }}>$0</span></span>}
              subline={t.billingFreeUpTo.replace('{n}', 3)}
              color="#6b7280"
              current={currentPlan === 'free' && isActive}
              selected={selectedPlan === 'free'}
              features={[
                { text: t.featClockTracking },
                { text: t.featAdminApproval },
                { text: t.featBasicAnalytics },
                { text: t.featSchedulingCurrentWeek },
                { text: t.featTimesheetLatestWeek },
                { text: t.feat90DayHistory },
                { text: t.featGPSGeofencing, lock: true },
                { text: t.featCSVPayrollExport, lock: true },
                { text: t.featFullHistory, lock: true },
              ]}
              btnLabel={currentPlan === 'free' && isActive ? t.currentPlan : isTrial ? t.billingChoosePlan.replace('{plan}', t.planFree) : t.billingContinuePlan.replace('{plan}', t.planFree)}
              disabled={currentPlan === 'free' && isActive}
              onSelect={() => isTrial ? setSelectedPlan('free') : null}
              t={t}
            />

            <PlanCard
              name={t.planStarter}
              priceEl={
                annual
                  ? <><span style={{ fontSize: 28, fontWeight: 800 }}>${plans ? Math.round(plans.starter.annual / 12) : 17}</span><span style={{ fontSize: 14, color: '#6b7280' }}>/mo</span></>
                  : <><span style={{ fontSize: 28, fontWeight: 800 }}>${plans?.starter.monthly ?? 20}</span><span style={{ fontSize: 14, color: '#6b7280' }}>/mo</span></>
              }
              subline={annual ? `$${plans?.starter.annual ?? 200}/yr — ${t.billing2MonthsFree}` : t.feat10Workers}
              color="#2563eb"
              current={currentPlan === 'starter' && isActive}
              selected={selectedPlan === 'starter'}
              features={[
                { text: t.featEverythingFree },
                { text: t.feat10Workers },
                { text: t.featGPSGeofencing },
                { text: t.featCSVPayrollExports },
                { text: t.featOvertimeReport },
                { text: t.featFullHistoryNoLimit },
                { text: t.featScheduledShifts },
                { text: t.featWorkerTimesheetPDF },
                { text: t.featBroadcastAnnouncements, lock: true },
                { text: t.featFieldSafety, lock: true },
              ]}
              btnLabel={
                currentPlan === 'starter' && isActive ? t.currentPlan
                  : isTrial ? (selectedPlan === 'starter' ? t.billingPlanSelected.replace('{plan}', t.planStarter) : t.billingChoosePlan.replace('{plan}', t.planStarter))
                  : annual ? t.billingSubscribeAnnual.replace('{price}', `$${plans?.starter.annual ?? 200}`) : t.billingSubscribeMonthly.replace('{price}', `$${plans?.starter.monthly ?? 20}`)
              }
              disabled={!!redirecting || (currentPlan === 'starter' && isActive)}
              onSelect={() => isTrial
                ? setSelectedPlan('starter')
                : checkout(annual ? plans?.starter.annual_price_id : plans?.starter.monthly_price_id)
              }
              t={t}
            />

            <PlanCard
              name={t.planBusiness}
              highlight
              tag={t.planMostPopular}
              priceEl={
                annual
                  ? <><span style={{ fontSize: 28, fontWeight: 800 }}>${businessAnnualPerMonth}</span><span style={{ fontSize: 14, color: '#6b7280' }}>/mo</span></>
                  : <><span style={{ fontSize: 28, fontWeight: 800 }}>${BASE_MONTHLY}</span><span style={{ fontSize: 14, color: '#6b7280' }}>/mo</span></>
              }
              subline={
                annual
                  ? <span>
                      ${businessAnnualTotal}/yr — {t.billing2MonthsFree}
                      {businessOverage > 0 && <> · {t.billingBusinessExtraWorkers.replace('{n}', businessOverage)}</>}
                    </span>
                  : <span>
                      {t.billingBusinessIncludes.replace('{n}', INCLUDED_WORKERS)}
                      {businessOverage > 0
                        ? <> + {businessOverage} extra = <strong style={{ color: '#8b5cf6' }}>${businessMonthly}/mo</strong></>
                        : <> · {t.billingBusinessPerWorkerAfter.replace('{price}', `$${PER_WORKER_MONTHLY}`).replace('{n}', INCLUDED_WORKERS)}</>
                      }
                    </span>
              }
              color="#8b5cf6"
              current={currentPlan === 'business' && isActive}
              selected={selectedPlan === 'business'}
              features={[
                { text: t.featEverythingStarter },
                { text: t.featWorkersIncluded.replace('{n}', INCLUDED_WORKERS).replace('{price}', `$${PER_WORKER_MONTHLY}`) },
                { text: t.featBroadcastAnnouncements },
                { text: t.featFieldDailyReports },
                { text: t.featSafetyTalks },
                { text: t.featPunchlistMgmt },
                { text: t.featAdvancedAnalytics },
                { text: t.featInactiveAlerts },
              ]}
              btnLabel={
                currentPlan === 'business' && isActive ? t.currentPlan
                  : isTrial ? (selectedPlan === 'business' ? t.billingPlanSelected.replace('{plan}', t.planBusiness) : t.billingChoosePlan.replace('{plan}', t.planBusiness))
                  : annual ? t.billingSubscribeAnnual.replace('{price}', `$${businessAnnualTotal}`) : t.billingSubscribeMonthly.replace('{price}', `$${businessMonthly}`)
              }
              disabled={!!redirecting || (currentPlan === 'business' && isActive)}
              onSelect={() => isTrial
                ? setSelectedPlan('business')
                : checkout(
                  annual ? plans?.business.base_annual_price_id : plans?.business.base_monthly_price_id,
                  annual
                    ? { worker_price_id: plans?.business.worker_annual_price_id, worker_count: workerCount }
                    : { worker_price_id: plans?.business.worker_monthly_price_id, worker_count: workerCount }
                )
              }
              t={t}
            />
          </div>

          <div style={s.sliderWrap}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label style={{ ...s.sliderLabel, marginBottom: 0 }}>
                {t.billingTeamSize.replace('{n}', workerCount)}
                {workerCount > INCLUDED_WORKERS
                  ? <span style={{ color: '#8b5cf6', marginLeft: 8 }}>
                      {annual ? `$${businessAnnualTotal}/yr` : `$${businessMonthly}/mo`}
                    </span>
                  : <span style={{ color: '#6b7280', marginLeft: 8 }}>{t.billingIncludedInBase}</span>
                }
              </label>
              <button
                className="worker-mode-btn btn-circle"
                style={s.inputModeBtn}
                title={workerInputMode === 'slider' ? t.billingEnterExactCount : t.billingUseSlider}
                onClick={() => {
                  if (workerInputMode === 'slider') {
                    setWorkerDraft(String(workerCount));
                    setWorkerInputMode('number');
                  } else {
                    setWorkerInputMode('slider');
                  }
                }}
              >
                {workerInputMode === 'slider' ? '✏️' : '↔'}
              </button>
            </div>
            {workerInputMode === 'slider' ? (
              <>
                <input type="range" min={INCLUDED_WORKERS} max={500} value={workerCount}
                  onChange={e => setWorkerCount(Number(e.target.value))}
                  style={{ width: '100%', accentColor: '#8b5cf6' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6b7280' }}>
                  <span>{t.billingIncludedCount.replace('{n}', INCLUDED_WORKERS)}</span><span>500+</span>
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="number"
                  min={1}
                  value={workerDraft}
                  onChange={e => setWorkerDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      const v = Math.max(INCLUDED_WORKERS, parseInt(workerDraft, 10) || INCLUDED_WORKERS);
                      setWorkerCount(v);
                      setWorkerDraft(String(v));
                    }
                  }}
                  style={s.workerNumInput}
                  autoFocus
                />
                <button
                  style={s.workerUpdateBtn}
                  onClick={() => {
                    const v = Math.max(INCLUDED_WORKERS, parseInt(workerDraft, 10) || INCLUDED_WORKERS);
                    setWorkerCount(v);
                    setWorkerDraft(String(v));
                  }}
                >
                  {t.billingUpdate}
                </button>
              </div>
            )}
          </div>

          {!hasQbo && (
            <div style={s.addonCard}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={addQbo} onChange={e => setAddQbo(e.target.checked)}
                  style={{ accentColor: '#d97706', width: 16, height: 16 }} />
                <span style={s.addonTitle}>
                  {t.billingQBOAddonTitle} &nbsp;
                  <span style={{ fontSize: 18, fontWeight: 800, color: '#d97706' }}>${plans?.qbo.monthly ?? 25}</span>
                  <span style={{ fontSize: 13, color: '#6b7280' }}>/mo</span>
                </span>
              </label>
              <div style={{ paddingLeft: 26, fontSize: 12, color: '#6b7280', lineHeight: 1.5, marginTop: 6 }}>
                {t.billingQBODesc}
              </div>
            </div>
          )}

          {!hasPlanroom && plans?.planroom?.monthly_price_id && (
            <div style={s.addonCard}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={addPlanroom} onChange={e => setAddPlanroom(e.target.checked)}
                  style={{ accentColor: '#d97706', width: 16, height: 16 }} />
                <span style={s.addonTitle}>
                  + Plan Room add-on &nbsp;
                  <span style={{ fontSize: 18, fontWeight: 800, color: '#d97706' }}>${plans?.planroom?.monthly ?? '—'}</span>
                  <span style={{ fontSize: 13, color: '#6b7280' }}>/mo</span>
                </span>
              </label>
              <div style={{ paddingLeft: 26, fontSize: 12, color: '#6b7280', lineHeight: 1.5, marginTop: 6 }}>
                View, mark up, and measure plan sets right in the browser — clouds, callouts, lengths, areas, counts — with a company library, live share sessions, and flattened-PDF export.
              </div>
            </div>
          )}

          {!hasTakeoff && plans?.takeoff?.monthly_price_id && (
            <div style={s.addonCard}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                <input type="checkbox" checked={addTakeoff} onChange={e => setAddTakeoff(e.target.checked)}
                  style={{ accentColor: '#d97706', width: 16, height: 16 }} />
                <span style={s.addonTitle}>
                  + Sitework Takeoff add-on &nbsp;
                  <span style={{ fontSize: 18, fontWeight: 800, color: '#d97706' }}>${plans?.takeoff?.monthly ?? '—'}</span>
                  <span style={{ fontSize: 13, color: '#6b7280' }}>/mo</span>
                </span>
              </label>
              <div style={{ paddingLeft: 26, fontSize: 12, color: '#6b7280', lineHeight: 1.5, marginTop: 6 }}>
                Plan takeoffs from civil drawings — earthwork cut/fill, paving, concrete, and utilities — into a priced, branded bid, with company-shared projects.
              </div>
            </div>
          )}

          <ClientPortalProPlaceholder />

          {isTrial && selectedPlan && selectedPlan !== 'free' && (
            <div style={s.trialCta}>
              <div style={{ fontSize: 14, color: '#111827' }}>
                {t.billingReadyToSubscribe.replace('{plan}', selectedPlan.charAt(0).toUpperCase() + selectedPlan.slice(1))}
                {selectedPlan === 'business' && (
                  <span style={{ color: '#6b7280' }}>
                    {annual
                      ? ` (${workerCount} team members = $${businessAnnualTotal}/yr)`
                      : ` (${workerCount} team members = $${businessMonthly}/mo)`}
                  </span>
                )}
              </div>
              <button style={{ ...s.ctaBtn, ...(redirecting ? { opacity: 0.55, cursor: 'not-allowed' } : {}) }} onClick={subscribeSelectedPlan} disabled={!!redirecting}>
                {redirecting
                  ? t.billingRedirecting
                  : t.billingSubscribeTo
                      .replace('{plan}', selectedPlan.charAt(0).toUpperCase() + selectedPlan.slice(1))
                      .replace('{billing}', annual ? t.planAnnual : t.planMonthly)
                }
              </button>
              <div style={{ fontSize: 11, color: '#6b7280', textAlign: 'center' }}>
                {t.billingNoChargeUntilTrial}
              </div>
            </div>
          )}

          {isTrial && !selectedPlan && (
            <p style={{ fontSize: 12, color: '#6b7280', textAlign: 'center', marginTop: 8, fontStyle: 'italic' }}>
              {t.billingSelectPlanHint}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Placeholder card for the future Customer Portal Pro add-on. Not a buy
 * button — just a "notify me" flag so we can measure demand before
 * committing build effort. Once the addon is real, this component
 * gets replaced with the real billing widget.
 */
function ClientPortalProPlaceholder() {
  const t = useT();
  const [registered, setRegistered] = useState(false);
  const [saving, setSaving] = useState(false);
  const { user, updateUser } = useAuth();
  const alreadyRegistered = !!user?.client_portal_pro_interest;

  const register = async () => {
    setSaving(true);
    try {
      await api.post('/admin/service-requests/client-portal-interest');
      setRegistered(true);
      updateUser?.({ client_portal_pro_interest: true });
    } catch { /* silent */ } finally { setSaving(false); }
  };

  const isRegistered = registered || alreadyRegistered;

  return (
    <div style={{ ...s.addonCard, borderColor: '#c7d2fe', background: '#eef2ff', opacity: isRegistered ? 0.9 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 20 }}>🏗️</span>
        <span style={{ ...s.addonTitle, color: '#3730a3' }}>
          Customer Portal Pro &nbsp;
          <span style={{ fontSize: 12, fontWeight: 700, background: '#c7d2fe', color: '#3730a3', padding: '2px 8px', borderRadius: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>{t.comingSoon}</span>
        </span>
      </div>
      <div style={{ paddingLeft: 30, fontSize: 12, color: '#4338ca', lineHeight: 1.55, marginTop: 6 }}>
        Branded customer portal with work status tracking, online invoicing and payment, scheduling, and custom logos.
        Not available yet — click below to let us know you're interested.
      </div>
      <div style={{ paddingLeft: 30, marginTop: 10 }}>
        {isRegistered ? (
          <span style={{ fontSize: 13, color: '#065f46', fontWeight: 600 }}>✓ We'll email you the moment it launches.</span>
        ) : (
          <button
            type="button"
            onClick={register}
            disabled={saving}
            style={{ padding: '7px 14px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.55 : 1 }}
          >
            {saving ? 'Saving…' : 'Notify me when available'}
          </button>
        )}
      </div>
    </div>
  );
}

const s = {
  card: { background: '#fff', borderRadius: 12, padding: 28, boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: 24 },
  topRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap', gap: 10 },
  title: { fontSize: 17, fontWeight: 700, margin: 0, marginBottom: 2 },
  sub: { fontSize: 13, color: '#6b7280', margin: 0 },
  alert: { background: '#fffbeb', border: '1px solid #fcd34d', color: '#92400e', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  alertBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer', flexShrink: 0 },
  trialBanner: { background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#1e40af', lineHeight: 1.5 },
  activeSection: { background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '16px 20px', marginBottom: 16 },
  activeText: { fontSize: 14, color: '#374151', marginBottom: 12 },
  portalBtn: { background: 'var(--ops-page-accent)', color: '#fff', border: 'none', padding: '9px 20px', borderRadius: 7, fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  toggleRow: { display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center', marginBottom: 20 },
  toggle: { display: 'flex', alignItems: 'center', width: 70, height: 40, borderRadius: 7, border: 'none', cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0, padding: 4 },
  toggleKnob: { display: 'block', width: 16, height: 32, borderRadius: 5, background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'transform 0.2s', flexShrink: 0 },
  plans: { display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 16 },
  planCard: { flex: 1, minWidth: 200, border: '2px solid #e5e7eb', borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 10, position: 'relative' },
  planTag: { position: 'absolute', top: -11, left: '50%', transform: 'translateX(-50%)', color: '#fff', fontSize: 10, fontWeight: 700, padding: '2px 12px', borderRadius: 20, whiteSpace: 'nowrap' },
  selectedTag: { position: 'absolute', top: -11, right: 12, color: '#fff', fontSize: 10, fontWeight: 700, padding: '2px 12px', borderRadius: 20, whiteSpace: 'nowrap' },
  planName: { fontSize: 16, fontWeight: 700, color: '#111827' },
  planPrice: { display: 'flex', alignItems: 'baseline', gap: 2, flexWrap: 'wrap' },
  planSubline: { fontSize: 12, color: '#6b7280', marginTop: -6 },
  featureList: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 5, flex: 1 },
  featureItem: { fontSize: 12, color: '#374151', display: 'flex', alignItems: 'flex-start' },
  planBtn: { width: '100%', color: '#fff', border: 'none', padding: '10px', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer', marginTop: 4, transition: 'opacity 0.15s' },
  sliderWrap: { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '14px 16px', marginBottom: 14 },
  sliderLabel: { fontSize: 13, color: '#374151', display: 'block', marginBottom: 8 },
  inputModeBtn: { background: '#f3f4f6', border: '1px solid #e5e7eb', color: '#6b7280', fontSize: 16, minWidth: 40, width: 40, height: 40, borderRadius: '50%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, flexGrow: 0, padding: 0, lineHeight: 1, boxSizing: 'border-box' },
  workerNumInput: { width: 90, padding: '7px 10px', border: '1px solid #c7d2fe', borderRadius: 7, fontSize: 15, fontWeight: 700, color: '#8b5cf6', textAlign: 'center' },
  workerUpdateBtn: { padding: '7px 14px', background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: 'pointer', flexShrink: 0 },
  addonCard: { border: '2px solid #fde68a', borderRadius: 10, padding: '14px 16px', background: '#fffbeb', marginBottom: 16 },
  addonTitle: { fontSize: 15, fontWeight: 700, color: '#92400e' },
  trialCta: { background: '#f0fdf4', border: '2px solid #bbf7d0', borderRadius: 10, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 },
  ctaBtn: { background: '#059669', color: '#fff', border: 'none', padding: '12px', borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: 'pointer' },
  removeBtn: { background: '#fff', color: '#b91c1c', border: '1px solid #fca5a5', padding: '8px 16px', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  billingError: { color: '#dc2626', fontSize: 13, margin: '0 0 12px' },
};
