/**
 * UpdatePrompt smoke — guards two failure modes:
 *  1. Banner never shows when an update truly is available (stale forever).
 *  2. Banner shows when no new worker has been downloaded — e.g. on the
 *     current version after a plain reload (the annoying false positive that
 *     showed on the latest build and never cleared).
 *
 * jsdom has no real service-worker stack, so we drive the registration /
 * worker listeners directly.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import UpdatePrompt from '../UpdatePrompt';

// UpdatePrompt uses useT → useAuth; stub the context so we don't need to
// wrap every test in AuthProvider.
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { language: 'English' } }),
}));

// A fake service-worker "worker" whose state we can advance to fire statechange.
function makeWorker(initialState = 'installing') {
  const listeners = {};
  return {
    state: initialState,
    addEventListener: (evt, cb) => { listeners[evt] = cb; },
    setState(s) { this.state = s; listeners.statechange?.(); },
  };
}

// A fake registration. `installing` / `waiting` model the two worker slots;
// `fireUpdateFound()` simulates the browser finding a new sw.js.
function makeReg({ installing = null, waiting = null } = {}) {
  const listeners = {};
  return {
    installing,
    waiting,
    addEventListener: (evt, cb) => { listeners[evt] = cb; },
    fireUpdateFound() { listeners.updatefound?.(); },
  };
}

function setupSW({ hasController = true, registration = makeReg() } = {}) {
  const sw = {
    controller: hasController ? { state: 'activated' } : null,
    addEventListener: () => {},
    removeEventListener: () => {},
    getRegistration: () => Promise.resolve(registration),
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    value: sw,
    configurable: true,
    writable: true,
  });
}

describe('<UpdatePrompt />', () => {
  beforeEach(() => {
    // eslint-disable-next-line no-proto
    delete navigator.__proto__.serviceWorker;
  });

  test('renders nothing when no update has been detected', async () => {
    setupSW({ registration: makeReg() });
    let container;
    await act(async () => { ({ container } = render(<UpdatePrompt />)); });
    expect(container.firstChild).toBeNull();
  });

  test('first-ever install (no controller) does not show the banner', async () => {
    const reg = makeReg();
    setupSW({ hasController: false, registration: reg });
    await act(async () => { render(<UpdatePrompt />); });
    const worker = makeWorker('installing');
    await act(async () => {
      reg.installing = worker;
      reg.fireUpdateFound();
      worker.setState('installed'); // installs, but nothing controls the page yet
    });
    expect(screen.queryByText(/new version/i)).not.toBeInTheDocument();
  });

  test('a new worker installing while controlled shows the prompt', async () => {
    const reg = makeReg();
    setupSW({ hasController: true, registration: reg });
    await act(async () => { render(<UpdatePrompt />); });
    const worker = makeWorker('installing');
    await act(async () => {
      reg.installing = worker;
      reg.fireUpdateFound();
      worker.setState('installed'); // controller exists → real update
    });
    expect(screen.getByText(/new version of OpsFloa is ready/i)).toBeInTheDocument();
    const link = screen.getByText(/what's new/i).closest('a');
    expect(link).toHaveAttribute('href', '/changelog');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
  });

  test('a worker already waiting at mount shows the prompt', async () => {
    setupSW({ hasController: true, registration: makeReg({ waiting: makeWorker('installed') }) });
    await act(async () => { render(<UpdatePrompt />); });
    expect(screen.getByText(/new version of OpsFloa is ready/i)).toBeInTheDocument();
  });

  test('plain reload on the current version (no new worker) does NOT show the prompt', async () => {
    // No installing/waiting worker and no updatefound — exactly the state after
    // reloading onto the latest build.
    setupSW({ hasController: true, registration: makeReg() });
    let container;
    await act(async () => { ({ container } = render(<UpdatePrompt />)); });
    expect(container.firstChild).toBeNull();
  });

  test('dismiss button hides the banner', async () => {
    const reg = makeReg();
    setupSW({ hasController: true, registration: reg });
    await act(async () => { render(<UpdatePrompt />); });
    const worker = makeWorker('installing');
    await act(async () => {
      reg.installing = worker;
      reg.fireUpdateFound();
      worker.setState('installed');
    });
    fireEvent.click(screen.getByLabelText(/dismiss/i));
    expect(screen.queryByText(/new version of OpsFloa is ready/i)).not.toBeInTheDocument();
  });
});
