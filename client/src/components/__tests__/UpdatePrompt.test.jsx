/**
 * UpdatePrompt smoke — the banner polls /version.json and compares it to the
 * running build (__APP_VERSION__). Guards:
 *  1. Shows when the deployed version differs.
 *  2. Stays hidden when it matches (no false positive on the current build).
 *  3. Stays hidden when the check fails (offline / transient).
 *  4. Dismiss hides it.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import UpdatePrompt, { activateUpdateAndReload } from '../UpdatePrompt';

// UpdatePrompt uses useT → useAuth; stub the context so we don't need a provider.
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { language: 'English' } }),
}));

function mockVersionEndpoint(version, { ok = true } = {}) {
  global.fetch = vi.fn(() => Promise.resolve({
    ok,
    json: () => Promise.resolve({ version }),
  }));
}

// The component checks on window 'focus'; drive one poll and flush its async work.
async function triggerCheck() {
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

describe('<UpdatePrompt />', () => {
  beforeEach(() => {
    globalThis.__APP_VERSION__ = '1.0.0+current';
  });
  afterEach(() => {
    delete globalThis.__APP_VERSION__;
    vi.restoreAllMocks();
  });

  test('shows when version.json reports a different version', async () => {
    mockVersionEndpoint('1.0.0+newer');
    render(<UpdatePrompt />);
    await triggerCheck();
    expect(screen.getByText(/new version of OpsFloa is ready/i)).toBeInTheDocument();
    const link = screen.getByText(/what's new/i).closest('a');
    expect(link).toHaveAttribute('href', '/changelog');
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
  });

  test('stays hidden when version.json matches the running build', async () => {
    mockVersionEndpoint('1.0.0+current');
    const { container } = render(<UpdatePrompt />);
    await triggerCheck();
    expect(container.firstChild).toBeNull();
  });

  test('stays hidden when the version check fails', async () => {
    mockVersionEndpoint('1.0.0+newer', { ok: false });
    const { container } = render(<UpdatePrompt />);
    await triggerCheck();
    expect(container.firstChild).toBeNull();
  });

  test('dismiss hides the banner', async () => {
    mockVersionEndpoint('1.0.0+newer');
    render(<UpdatePrompt />);
    await triggerCheck();
    fireEvent.click(screen.getByLabelText(/dismiss/i));
    expect(screen.queryByText(/new version of OpsFloa is ready/i)).not.toBeInTheDocument();
  });

  test('activates a waiting service worker before reloading', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    const waiting = new EventTarget();
    waiting.state = 'installed';
    waiting.postMessage = vi.fn(message => {
      expect(message).toEqual({ type: 'SKIP_WAITING' });
      waiting.state = 'activated';
      waiting.dispatchEvent(new Event('statechange'));
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: vi.fn().mockResolvedValue({ waiting }) },
    });
    const reload = vi.fn();

    await activateUpdateAndReload(reload);

    expect(waiting.postMessage).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    if (original) Object.defineProperty(navigator, 'serviceWorker', original);
    else delete navigator.serviceWorker;
  });
});
