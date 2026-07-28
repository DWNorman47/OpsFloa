import { useAuth } from '../contexts/AuthContext';

const PLAN_LEVEL = { free: 0, starter: 1, business: 2 };

// Returns helpers for checking the current company's plan and feature access.
export function usePlan() {
  const { user } = useAuth();

  const plan = user?.plan || 'free';
  const status = user?.subscription_status || 'trial';
  const qboAddon = user?.addon_qbo || false;
  // Certified payroll folded into Advanced Payroll (migration 0155). Grant on either
  // the new flag or the legacy certified one during the transition.
  const advancedPayrollAddon = user?.addon_advanced_payroll || user?.addon_certified_payroll || false;
  const takeoffAddon = user?.addon_takeoff || false;
  const isTrial = status === 'trial';
  const isExempt = status === 'exempt';
  const isTrialExpired = status === 'trial_expired';
  const isActive = status === 'active' || isTrial || isExempt;

  // Does the current plan meet or exceed minPlan?
  // Trial and exempt users always return true.
  function atLeast(minPlan) {
    if (isTrial || isExempt) return true;
    if (!isActive) return false;
    return (PLAN_LEVEL[plan] ?? 0) >= (PLAN_LEVEL[minPlan] ?? 0);
  }

  return {
    plan,
    status,
    qboAddon,
    isTrial,
    isExempt,
    isTrialExpired,
    isActive,
    isFree: plan === 'free' && !isTrial && !isExempt,
    isStarter: atLeast('starter'),
    isBusiness: atLeast('business'),
    hasQbo: qboAddon || isTrial || isExempt,
    // Advanced Payroll gates WH-347, Paycheck Rules, and the Payroll tab. Certified
    // payroll is a capability of it, so hasCertifiedPayroll aliases the same grant.
    hasAdvancedPayroll: advancedPayrollAddon || isTrial || isExempt,
    hasCertifiedPayroll: advancedPayrollAddon || isTrial || isExempt,
    hasTakeoff: takeoffAddon || isTrial || isExempt,
    atLeast,
    // History limit in days — null means no limit
    historyDays: atLeast('starter') ? null : 90,
  };
}
