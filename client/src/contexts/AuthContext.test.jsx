/**
 * updateUser must PERSIST the merged user, not just update React state.
 *
 * Regression: accepting the Terms cleared `needs_terms` in memory but not in the
 * `tc_user` cache, so an offline / /auth/me-failure bootstrap re-read the stale
 * cache (needs_terms: true) and re-showed the clickwrap gate on every reload.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('../api', () => {
  const ok = (data) => Promise.resolve({ data, status: 200 });
  return {
    default: {
      get: vi.fn(() => ok({ user: { id: 1, needs_terms: true, full_name: 'Ada' } })),
      post: vi.fn(() => ok({})), patch: vi.fn(() => ok({})),
      put: vi.fn(() => ok({})), delete: vi.fn(() => ok({})),
    },
    setApiToastHandler: vi.fn(),
  };
});
vi.mock('../offlineDb', () => ({ clearCache: vi.fn(() => Promise.resolve()) }));

import { AuthProvider, useAuth } from './AuthContext';

function Consumer() {
  const { user, updateUser } = useAuth();
  return (
    <div>
      <span data-testid="needs">{user ? String(!!user.needs_terms) : 'no-user'}</span>
      <button onClick={() => updateUser({ needs_terms: false })}>accept</button>
    </div>
  );
}

describe('AuthContext.updateUser', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  test('persists the cleared needs_terms to tc_user so a reload does not re-prompt', async () => {
    window.localStorage.setItem('tc_token', 'tok'); // a live session → bootstrap loads /auth/me

    render(<AuthProvider><Consumer /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('needs').textContent).toBe('true'));

    await act(async () => { screen.getByText('accept').click(); });

    // Cleared in React state…
    expect(screen.getByTestId('needs').textContent).toBe('false');
    // …AND written back to the cache, so an offline/cached bootstrap won't resurrect it.
    const cached = JSON.parse(window.localStorage.getItem('tc_user'));
    expect(cached.needs_terms).toBe(false);
  });
});
