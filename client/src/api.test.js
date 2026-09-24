import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isSessionFailure, clearFailedSession, responseErrorInterceptor, requestInterceptor,
  resolveTimeout, isTimeoutError, setApiToastHandler, DEFAULT_TIMEOUT_MS, LONG_TIMEOUT_MS,
} from './api';

const err401 = (error, config = {}, extra = {}) => ({
  response: { status: 401, data: { error, ...extra } },
  config,
});

describe('isSessionFailure', () => {
  test('requireAuth session errors are session failures', () => {
    for (const msg of ['Unauthorized', 'Invalid token', 'Account deactivated',
      'Session invalidated, please log in again', 'Impersonation session ended']) {
      expect(isSessionFailure(err401(msg))).toBe(true);
    }
    expect(isSessionFailure(err401('Session expired, please log in again', {}, { code: 'session_max' }))).toBe(true);
  });

  test('credential-check 401s are not session failures', () => {
    expect(isSessionFailure(err401('Current password is incorrect'))).toBe(false);
    expect(isSessionFailure(err401('Invalid code. Try again.'))).toBe(false);
    expect(isSessionFailure(err401('Incorrect password'))).toBe(false);
  });

  test('skipAuthRedirect suppresses unknown 401s but never a real session failure', () => {
    expect(isSessionFailure(err401('Something new', { skipAuthRedirect: true }))).toBe(false);
    expect(isSessionFailure(err401('Invalid token', { skipAuthRedirect: true }))).toBe(true);
  });

  test('an unknown 401 without opt-out still counts as expired', () => {
    expect(isSessionFailure(err401('Something new'))).toBe(true);
    expect(isSessionFailure({ response: { status: 401 }, config: {} })).toBe(true);
  });

  test('non-401 is never a session failure', () => {
    expect(isSessionFailure({ response: { status: 403, data: { error: 'Invalid token' } } })).toBe(false);
  });
});

describe('401 interceptor', () => {
  const originalLocation = window.location;
  beforeEach(() => {
    delete window.location;
    window.location = { pathname: '/dashboard', href: 'http://localhost/dashboard' };
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    window.location = originalLocation;
    localStorage.clear();
    sessionStorage.clear();
  });

  test('wrong current password keeps the session and does not redirect', async () => {
    localStorage.setItem('tc_token', 'real');
    await expect(responseErrorInterceptor(err401('Current password is incorrect', { skipAuthRedirect: true, _tokenSource: 'local' })))
      .rejects.toBeTruthy();
    expect(localStorage.getItem('tc_token')).toBe('real');
    expect(window.location.href).toBe('http://localhost/dashboard');
  });

  test('expired impersonation token clears only sessionStorage', async () => {
    localStorage.setItem('tc_token', 'superadmin');
    sessionStorage.setItem('tc_token', 'imp');
    sessionStorage.setItem('tc_user', '{}');
    await expect(responseErrorInterceptor(err401('Invalid token', { _tokenSource: 'session' }))).rejects.toBeTruthy();
    expect(sessionStorage.getItem('tc_token')).toBeNull();
    expect(sessionStorage.getItem('tc_user')).toBeNull();
    expect(localStorage.getItem('tc_token')).toBe('superadmin');
    expect(window.location.href).toBe('/login?session=expired');
  });

  test('expired normal token clears localStorage and redirects', async () => {
    localStorage.setItem('tc_token', 'real');
    await expect(responseErrorInterceptor(err401('Session invalidated, please log in again', { _tokenSource: 'local' }))).rejects.toBeTruthy();
    expect(localStorage.getItem('tc_token')).toBeNull();
    expect(window.location.href).toBe('/login?session=expired');
  });

  test('no redirect while already on /login', async () => {
    window.location.pathname = '/login';
    localStorage.setItem('tc_token', 'x');
    await expect(responseErrorInterceptor(err401('Invalid token', { _tokenSource: 'local' }))).rejects.toBeTruthy();
    expect(localStorage.getItem('tc_token')).toBe('x');
  });

  test('request interceptor records the token source', () => {
    localStorage.setItem('tc_token', 'l');
    expect(requestInterceptor({ headers: {} })._tokenSource).toBe('local');
    sessionStorage.setItem('tc_token', 's');
    const cfg = requestInterceptor({ headers: {} });
    expect(cfg._tokenSource).toBe('session');
    expect(cfg.headers.Authorization).toBe('Bearer s');
  });

  test('clearFailedSession with no source clears nothing', () => {
    localStorage.setItem('tc_token', 'l');
    clearFailedSession(undefined);
    expect(localStorage.getItem('tc_token')).toBe('l');
  });
});

describe('timeouts', () => {
  test('default, explicit and long timeouts', () => {
    expect(resolveTimeout({ url: '/projects' })).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeout({ url: '/projects', timeout: 5000 })).toBe(5000);
    expect(resolveTimeout({ url: '/admin/export?x=1', responseType: 'blob' })).toBe(LONG_TIMEOUT_MS);
    expect(resolveTimeout({ url: '/office/scan-contract' })).toBe(LONG_TIMEOUT_MS);
    expect(resolveTimeout({ url: '/daily-reports/suggest' })).toBe(LONG_TIMEOUT_MS);
    expect(resolveTimeout({ url: '/estimates/5/plan-pdf', data: { dataUrl: 'x'.repeat(200000) } })).toBe(LONG_TIMEOUT_MS);
  });

  test('timeout errors are detected and toasted', async () => {
    const e = { code: 'ECONNABORTED', message: 'timeout of 20000ms exceeded', config: {} };
    expect(isTimeoutError(e)).toBe(true);
    expect(isTimeoutError({ code: 'ERR_CANCELED', message: 'canceled' })).toBe(false);
    const toast = vi.fn();
    setApiToastHandler(toast);
    await expect(responseErrorInterceptor(e)).rejects.toBe(e);
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/too long/i), 'warning');
    setApiToastHandler(null);
  });
});
