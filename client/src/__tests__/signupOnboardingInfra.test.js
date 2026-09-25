import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));

import api from '../api';
import { onboardingStatus, ONBOARDING_LINKS } from '../components/OnboardingChecklist';
import { loginPathAfterConfirm } from '../pages/ConfirmEmail';
import { canonicalFor } from '../hooks/useDocumentMeta';
import { ensurePushSubscription, setPushOptOut } from '../utils/pushSubscription';

describe('onboarding checklist', () => {
  it('links point at real routes / admin tabs', () => {
    expect(ONBOARDING_LINKS).toEqual({ workers: '/team', projects: '/work', settings: '/administration#workspace' });
  });

  it('rates: done only on an explicit confirm, an admin-made rate change, or a non-default rate', () => {
    const base = { settings: { default_hourly_rate: 30 } };
    expect(onboardingStatus(base).ratesConfigured).toBe(false);
    // the sign-up row (created_by null) is not a change
    expect(onboardingStatus({ ...base, rateHistory: [{ created_by: null, rate: 30 }] }).ratesConfigured).toBe(false);
    // an admin re-saved $30 explicitly → a history row with created_by
    expect(onboardingStatus({ ...base, rateHistory: [{ created_by: null }, { created_by: 7, rate: 30 }] }).ratesConfigured).toBe(true);
    expect(onboardingStatus({ settings: { default_hourly_rate: 30, onboarding_rates_confirmed_at: '2026-09-24T00:00:00Z' } }).ratesConfigured).toBe(true);
    expect(onboardingStatus({ settings: { default_hourly_rate: 42 } }).ratesConfigured).toBe(true);
  });

  it('timezone: a pre-filled zone is NOT done until the admin confirms it', () => {
    expect(onboardingStatus({ settings: { company_timezone: 'America/Phoenix' } }).timezoneConfigured).toBe(false);
    expect(onboardingStatus({ settings: { company_timezone: 'America/Phoenix', onboarding_timezone_confirmed_at: 'x' } }).timezoneConfigured).toBe(true);
  });
});

describe('confirm email → prefilled sign-in', () => {
  it('builds /login with company + username + confirmed flag', () => {
    const path = loginPathAfterConfirm({ success: true, company: 'Acme & Sons', username: 'ann' });
    const url = new URL(path, 'https://x');
    expect(url.pathname).toBe('/login');
    expect(url.searchParams.get('company')).toBe('Acme & Sons');
    expect(url.searchParams.get('username')).toBe('ann');
    expect(url.searchParams.get('confirmed')).toBe('1');
  });
  it('older server response (no company) → null (stay on the success card)', () => {
    expect(loginPathAfterConfirm({ success: true })).toBeNull();
  });
});

describe('per-route canonical', () => {
  it('each route is its own canonical on the prod origin; /welcome is the home page', () => {
    expect(canonicalFor('/privacy')).toBe('https://opsfloa.com/privacy');
    expect(canonicalFor('/eula/')).toBe('https://opsfloa.com/eula');
    expect(canonicalFor('/companies/acme?x=1')).toBe('https://opsfloa.com/companies/acme');
    expect(canonicalFor('/welcome')).toBe('https://opsfloa.com/');
    expect(canonicalFor('/')).toBe('https://opsfloa.com/');
  });
});

describe('push re-subscribe after login', () => {
  let sub;
  let reg;
  beforeEach(() => {
    localStorage.clear();
    sub = { toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' } }) };
    reg = { pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe: vi.fn().mockResolvedValue(sub) } };
    vi.stubGlobal('Notification', { permission: 'granted' });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: vi.fn().mockResolvedValue(reg), ready: Promise.resolve(reg) } });
    window.PushManager = function PushManager() {};
    api.get.mockResolvedValue({ data: { publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' } });
    api.post.mockResolvedValue({ data: { ok: true } });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it('granted permission + no subscription → subscribes and registers it (no prompt path)', async () => {
    expect(await ensurePushSubscription()).toBe(true);
    expect(reg.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'p', auth: 'a' }, { suppressToast: true });
  });

  it('existing subscription → just re-registers it with the server', async () => {
    reg.pushManager.getSubscription.mockResolvedValue(sub);
    expect(await ensurePushSubscription()).toBe(true);
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('never prompts: permission not granted → nothing', async () => {
    vi.stubGlobal('Notification', { permission: 'default' });
    expect(await ensurePushSubscription()).toBe(false);
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('respects a per-device "turn off"', async () => {
    setPushOptOut(true);
    expect(await ensurePushSubscription()).toBe(false);
    expect(api.post).not.toHaveBeenCalled();
    setPushOptOut(false);
  });
});
