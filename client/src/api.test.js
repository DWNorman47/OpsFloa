import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isSessionFailure, clearFailedSession, responseErrorInterceptor, requestInterceptor,
  resolveTimeout, isTimeoutError, setApiToastHandler, DEFAULT_TIMEOUT_MS, LONG_TIMEOUT_MS,
  approxBodyChars, bodyIdempotencyKey, errorCodeMessage,
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

  test('a deactivated company (403 company_inactive) signs out to a login that says why', async () => {
    localStorage.setItem('tc_token', 'real');
    const err = { response: { status: 403, data: { code: 'company_inactive', error: 'deactivated' } }, config: { _tokenSource: 'local' } };
    await expect(responseErrorInterceptor(err)).rejects.toBeTruthy();
    expect(localStorage.getItem('tc_token')).toBeNull();
    expect(window.location.href).toBe('/login?session=inactive');
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

describe('slow endpoints + large bodies', () => {
  test('QuickBooks pushes, payroll runs and the mailbox get the long timeout', () => {
    for (const url of ['/qbo/push', '/qbo/push-bills', '/qbo/push-expenses', '/qbo/push-payroll',
      '/qbo/push-bills-preview', '/qbo/invoices', '/admin/payroll-run?from=a&to=b',
      '/admin/payroll-run/finalize', '/mailbox/messages', '/mailbox/messages/12', '/mailbox/send']) {
      expect(resolveTimeout({ url })).toBe(LONG_TIMEOUT_MS);
    }
    expect(resolveTimeout({ url: '/qbo/status' })).toBe(DEFAULT_TIMEOUT_MS);
  });

  test('photos nested in an array count as a large body, and scale past the long timeout', () => {
    const photo = { url: 'data:image/jpeg;base64,' + 'x'.repeat(400000), caption: '' };
    const data = { project_id: 1, photos: Array.from({ length: 10 }, () => ({ ...photo })) };
    expect(approxBodyChars(data)).toBeGreaterThan(4000000);
    expect(resolveTimeout({ url: '/field-reports', data })).toBeGreaterThan(LONG_TIMEOUT_MS);
    expect(resolveTimeout({ url: '/field-reports', data: { photos: [{ url: 'x'.repeat(60000) }, { url: 'x'.repeat(60000) }] } }))
      .toBeGreaterThanOrEqual(LONG_TIMEOUT_MS);
    expect(resolveTimeout({ url: '/field-reports', data: { notes: 'hi', photos: [] } })).toBe(DEFAULT_TIMEOUT_MS);
  });

  test('a body client_request_id is mirrored into the Idempotency-Key header', () => {
    const cfg = requestInterceptor({ method: 'post', url: '/field-reports', headers: {}, data: { client_request_id: 'abc-123' } });
    expect(cfg.headers['Idempotency-Key']).toBe('abc-123');
    expect(requestInterceptor({ method: 'get', url: '/x', headers: {} }).headers['Idempotency-Key']).toBeUndefined();
    expect(bodyIdempotencyKey({ client_id: '7' })).toBeNull();
  });
});

describe('translated server error codes', () => {
  const err409 = (code, error = 'English server text') => ({ response: { status: 409, data: { error, code } }, config: { url: '/admin/entries/4/approve' } });

  test('period_locked / entry_approved / report_changed map to a translated message', () => {
    expect(errorCodeMessage(err409('period_locked'))).toMatch(/locked pay period/i);
    expect(errorCodeMessage(err409('entry_approved'))).toMatch(/approved/i);
    expect(errorCodeMessage(err409('report_changed'))).toMatch(/changed/i);
    expect(errorCodeMessage(err409('something_else'))).toBeNull();
  });

  test('the global 4xx toast shows the translated period_locked message, not the raw server text', async () => {
    const toast = vi.fn();
    setApiToastHandler(toast);
    await expect(responseErrorInterceptor(err409('period_locked', 'raw'))).rejects.toBeTruthy();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/locked pay period/i), 'error');
    setApiToastHandler(null);
  });
});
