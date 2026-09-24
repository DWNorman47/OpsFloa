/**
 * The Projects page must still list projects when GET /admin/projects/metrics fails
 * (e.g. a statement timeout) — metrics load separately from the page's core data.
 */
import { describe, test, expect, vi } from 'vitest';
import { act } from 'react';
import { renderWithProviders, makeUser, DEFAULT_SETTINGS } from '../__tests__/test-helpers';

vi.mock('../api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
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

describe('ProjectsPage metrics isolation', () => {
  test('projects still render when the metrics request fails', async () => {
    const api = (await import('../api')).default;
    const project = { id: 1, name: 'Harbor Lofts Retrofit', status: 'in_progress', wage_type: 'regular', active: true };
    api.get.mockImplementation((url) => {
      if (url === '/admin/projects/metrics') return Promise.reject(new Error('statement timeout'));
      if (url === '/admin/projects') return Promise.resolve({ data: [project] });
      if (url.startsWith('/settings')) return Promise.resolve({ data: DEFAULT_SETTINGS });
      if (url === '/company-info') return Promise.resolve({ data: {} });
      return Promise.resolve({ data: [] });
    });
    const { default: ProjectsPage } = await import('./ProjectsPage');
    let view;
    await act(async () => { view = renderWithProviders(<ProjectsPage />, { user: makeUser('admin') }); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect((await view.findAllByText('Harbor Lofts Retrofit')).length).toBeGreaterThan(0);
  });
});
