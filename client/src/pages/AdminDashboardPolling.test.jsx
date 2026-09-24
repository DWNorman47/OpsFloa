/**
 * Workforce dashboard polling: the approvals badge polls the cheap GET /admin/pending-count
 * (not the full /admin/kpis), and the Live-tab chat dot uses the server's per-thread
 * `unread` count (not per-worker localStorage timestamps).
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { renderWithProviders, makeUser, DEFAULT_SETTINGS } from '../__tests__/test-helpers';
import { chatThreadsHaveUnread } from './AdminDashboard';

vi.mock('../api', () => ({
  default: { get: vi.fn(), post: vi.fn(() => Promise.resolve({ data: {} })), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  setApiToastHandler: vi.fn(),
}));
vi.mock('../offlineDb', () => ({
  getOrFetch: vi.fn((_key, fetchFn) => (fetchFn ? fetchFn() : Promise.resolve(null))),
  setCached: vi.fn(),
  getCached: vi.fn(() => Promise.resolve(null)),
  clearCache: vi.fn(() => Promise.resolve()),
  invalidateCache: vi.fn(() => Promise.resolve()),
}));
vi.mock('../errorReporter', () => ({ reportClientError: vi.fn(), silentError: () => () => {} }));

describe('chatThreadsHaveUnread', () => {
  test('true only when the server reports an unread message on some thread', () => {
    expect(chatThreadsHaveUnread([{ worker_id: 1, unread: 0 }, { worker_id: 2, unread: 3 }])).toBe(true);
    expect(chatThreadsHaveUnread([{ worker_id: 1, unread: 0, last_at: '2026-09-24T10:00:00Z' }])).toBe(false);
    expect(chatThreadsHaveUnread([])).toBe(false);
    expect(chatThreadsHaveUnread(null)).toBe(false);
  });
});

describe('WorkforcePanel pending badge', () => {
  beforeEach(() => { window.history.replaceState(null, '', '/#wf-approvals'); });

  test('polls /admin/pending-count for the approvals badge', async () => {
    const api = (await import('../api')).default;
    api.get.mockImplementation((url) => {
      if (url === '/admin/pending-count') return Promise.resolve({ data: { pending_approvals: 7 } });
      if (url.startsWith('/admin/settings') || url.startsWith('/settings')) return Promise.resolve({ data: DEFAULT_SETTINGS });
      if (url === '/company-info' || url === '/stripe/status') return Promise.resolve({ data: {} });
      return Promise.resolve({ data: [] });
    });
    const { WorkforcePanel } = await import('./AdminDashboard');
    let view;
    await act(async () => { view = renderWithProviders(<WorkforcePanel />, { user: makeUser('admin') }); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const urls = api.get.mock.calls.map(c => c[0]);
    expect(urls).toContain('/admin/pending-count');
    expect(await view.findByText('7 approvals')).toBeTruthy();
  });
});
