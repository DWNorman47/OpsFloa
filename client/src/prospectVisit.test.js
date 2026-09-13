import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  sessionStorage.clear();
  vi.resetModules();
  vi.stubGlobal('crypto', { randomUUID: () => 'd04b1046-9b6d-47e2-8d03-d1d7702790f2' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  window.history.replaceState({}, '', '/?utm_source=google&utm_medium=cpc');
});

afterEach(() => vi.unstubAllGlobals());

describe('welcome visit', () => {
  it('records once per page load, tracks actions and removes the session on sign-in', async () => {
    const visits = await import('./prospectVisit');
    visits.recordWelcomeVisit();
    visits.recordWelcomeVisit();
    await visits.recordWelcomeAction('pricing');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      action: 'visit', landing_path: '/', utm_source: 'google', utm_medium: 'cpc', device: 'desktop',
    });
    await visits.excludeProspectVisit();
    expect(fetch.mock.calls[2][0]).toContain('/public-visits/exclude');
    expect(sessionStorage.getItem('ops_public_visit')).toBeNull();
    visits.recordWelcomeVisit();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('keeps the session id for a later exclusion retry if the request fails', async () => {
    const visits = await import('./prospectVisit');
    visits.recordWelcomeVisit();
    fetch.mockResolvedValueOnce({ ok: false });
    await visits.excludeProspectVisit();
    expect(sessionStorage.getItem('ops_public_visit')).not.toBeNull();
    await visits.excludeProspectVisit();
    expect(sessionStorage.getItem('ops_public_visit')).toBeNull();
  });
});
